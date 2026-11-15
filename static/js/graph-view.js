/* ==========================================================================
   Text2KG Graph View
   零依赖 Canvas 2D 力导向知识图谱渲染器（浅色主题）。

   布局采用纯力导向 + 预迭代收敛（与参考渲染器一致）：
     · 斥力 / 边弹簧 / 向心力，初始化时同步预热，首屏即是一张稳定、松散的图；
     · 节点视觉半径不随缩放变化，缩小后文字与圆点仍然清晰；
     · 标签全部显示在节点正下方，带浅色底块，冲突时轻微位移而不是隐藏。

   数据格式（与后端保持一致，不做任何改写）：
     { nodes: [{ id: string, group: number }],
       links: [{ source: string, target: string, label: string }] }

   与父页面（工作台）通过 postMessage 通信：
     上行 graph:ready / graph:empty / graph:error / graph:nodeSelect / graph:nodeClear
     下行 graph:command { action: zoomIn|zoomOut|fit|reset|focus|clearSelect|reload }
   ========================================================================== */

(function (global) {
  'use strict';

  var TAU = Math.PI * 2;

  /* 低饱和度分类色板（浅色背景） */
  var PALETTE = [
    '#3978e8', '#25c6d6', '#20a46b', '#e9a23b', '#8b5cf6', '#ec4899',
    '#0ea5e9', '#84cc16', '#f97316', '#14b8a6', '#6366f1', '#e35d5b'
  ];

  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", ' +
    '"Microsoft YaHei", "Noto Sans SC", sans-serif';

  var GRID_STEP = 28;

  /* ---- 力导向参数（与参考渲染器对齐） ---- */
  var REPULSION = 26000;       /* 节点斥力 */
  var REST_LENGTH = 78;        /* 边的静止长度 */
  var LINK_K = 0.03;           /* 边弹簧系数 */
  var CENTER_K = 0.012;        /* 向心力，避免整图飘散 */
  var DAMPING = 0.84;          /* 速度阻尼 */
  var STEP_SCALE = 0.6;        /* 位移系数 */
  var PREHEAT = 300;           /* 预迭代步数：一次性收敛到稳定布局 */

  var DRAG_K = 0.36;           /* 拖拽跟随弹簧：轻微拖尾，产生弹性手感 */
  var PAN_FRICTION = 0.92;     /* 平移惯性阻尼 */

  var LABEL_SIZE = 11;
  var LABEL_MAX = 16;          /* 默认标签截断长度（参考实现同为 16） */
  var LABEL_MAX_ACTIVE = 40;   /* 悬停 / 选中时展开 */

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function shortLabel(value, max) {
    var s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function endpointId(value) {
    if (value && typeof value === 'object') {
      value = value.id != null ? value.id : (value.name != null ? value.name : value.label);
    }
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /* ---------------------------------------------------------------------- */

  function create(container, options) {
    options = options || {};
    var sourceUrl = options.source ||
      container.getAttribute('data-source') ||
      '/static/knowledge_graph.json';
    var isSample = !!(options.sample || container.getAttribute('data-sample') === '1');
    var parentOrigin = global.location.origin;

    var canvas = document.createElement('canvas');
    canvas.className = 'gv-canvas';
    var tooltip = document.createElement('div');
    tooltip.className = 'gv-tooltip';
    var messageEl = document.createElement('div');
    messageEl.className = 'gv-message';
    container.appendChild(canvas);
    container.appendChild(tooltip);
    container.appendChild(messageEl);

    var ctx = canvas.getContext('2d');

    var S = {
      nodes: [], links: [], byId: {},
      w: 0, h: 0, dpr: 1,
      scale: 1, ox: 0, oy: 0,
      loaded: false, hasFit: false, groupCount: 0,
      selected: null, hovered: null, neighbours: null,
      pointer: null, moved: false,
      panVx: 0, panVy: 0, inertia: false,
      sim: 0, reveal: 1, revealStart: 0,
      raf: 0, viewAnim: null, drawAlpha: 1
    };

    /* ---------- 与父页面通信 ---------- */

    function post(msg) {
      msg.source = 'text2kg-graph';
      try {
        if (global.parent && global.parent !== global) {
          global.parent.postMessage(msg, parentOrigin);
        }
      } catch (err) {
        /* 跨域或沙箱环境忽略 */
      }
    }

    function setMessage(text, visible) {
      messageEl.textContent = text || '';
      messageEl.classList.toggle('is-visible', !!visible);
    }

    /* ---------- 尺寸 ---------- */

    function resize() {
      var rect = container.getBoundingClientRect();
      var w = Math.max(1, Math.round(rect.width));
      var h = Math.max(1, Math.round(rect.height));
      var dpr = Math.min(global.devicePixelRatio || 1, 2);
      if (w === S.w && h === S.h && dpr === S.dpr) return;

      var prevW = S.w, prevH = S.h;
      S.w = w; S.h = h; S.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';

      if (prevW && prevH) {
        S.ox += (w - prevW) / 2;
        S.oy += (h - prevH) / 2;
      }
      /* 数据已就绪但此前容器没有尺寸时，补一次适配 */
      if (S.loaded && !S.hasFit) fit(false);
      requestFrame();
    }

    function sx(x) { return x * S.scale + S.ox; }
    function sy(y) { return y * S.scale + S.oy; }

    /* ---------- 视图控制 ---------- */

    /* 包围盒只按节点分布计算，标签宽度交由固定的屏幕留白处理。
       若把标签宽度折算进包围盒，窄画布下会形成「图越缩、标签占比越大」的
       正反馈，最终把整张图压成中间一小团。 */
    function bounds() {
      if (!S.nodes.length) return null;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < S.nodes.length; i++) {
        var n = S.nodes[i];
        minX = Math.min(minX, n.x - n.r);
        maxX = Math.max(maxX, n.x + n.r);
        minY = Math.min(minY, n.y - n.r);
        /* 标签排在节点下方，纵向多留一点 */
        maxY = Math.max(maxY, n.y + n.r + LABEL_SIZE + 8);
      }
      return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }

    function animateView(scale, ox, oy, duration) {
      S.viewAnim = {
        from: { s: S.scale, x: S.ox, y: S.oy },
        to: { s: scale, x: ox, y: oy },
        start: performance.now(),
        duration: duration || 280
      };
      requestFrame();
    }

    function fit(animate) {
      if (!S.nodes.length || !S.w || !S.h) return;
      var b = bounds();
      if (!b) return;
      var bw = Math.max(b.maxX - b.minX, 120);
      var bh = Math.max(b.maxY - b.minY, 100);
      /* 小画布用更小的留白，避免图谱被压得过小 */
      var pad = Math.min(56, Math.max(24, Math.min(S.w, S.h) * 0.08));
      var scale = clamp(Math.min((S.w - pad * 2) / bw, (S.h - pad * 2) / bh), 0.16, 2.2);
      var cx = (b.minX + b.maxX) / 2;
      var cy = (b.minY + b.maxY) / 2;
      var ox = S.w / 2 - cx * scale;
      var oy = S.h / 2 - cy * scale;
      S.hasFit = true;

      if (animate) {
        animateView(scale, ox, oy, 300);
      } else {
        S.viewAnim = null;
        S.scale = scale;
        S.ox = ox;
        S.oy = oy;
        requestFrame();
      }
    }

    /* ---------- 平移弹性：越界阻尼 + 松手回弹 ---------- */

    function panBounds() {
      var b = bounds();
      if (!b) return null;
      var slackX = Math.max(90, S.w * 0.32);
      var slackY = Math.max(90, S.h * 0.32);
      return {
        minOx: S.w - 56 - b.maxX * S.scale - slackX,
        maxOx: 56 - b.minX * S.scale + slackX,
        minOy: S.h - 56 - b.maxY * S.scale - slackY,
        maxOy: 56 - b.minY * S.scale + slackY
      };
    }

    function rubber(value, lo, hi) {
      if (value < lo) return lo - (lo - value) * 0.32;
      if (value > hi) return hi + (value - hi) * 0.32;
      return value;
    }

    function settlePan() {
      var p = panBounds();
      if (!p) return;
      var nx = clamp(S.ox, p.minOx, p.maxOx);
      var ny = clamp(S.oy, p.minOy, p.maxOy);
      if (Math.abs(nx - S.ox) > 1 || Math.abs(ny - S.oy) > 1) {
        animateView(S.scale, nx, ny, 320);
      }
    }

    function zoomBy(factor, ax, ay) {
      ax = ax == null ? S.w / 2 : ax;
      ay = ay == null ? S.h / 2 : ay;
      var next = clamp(S.scale * factor, 0.2, 3.2);
      var wx = (ax - S.ox) / S.scale;
      var wy = (ay - S.oy) / S.scale;
      S.scale = next;
      S.ox = ax - wx * next;
      S.oy = ay - wy * next;
      S.viewAnim = null;
      requestFrame();
    }

    function resetView() {
      select(null);
      animateView(1, S.w / 2, S.h / 2, 260);
    }

    function focusNode(id) {
      var node = S.byId[id];
      if (!node) return;
      select(id);
      var next = clamp(Math.max(S.scale, 1.1), 0.2, 3.2);
      animateView(next, S.w / 2 - node.x * next, S.h / 2 - node.y * next, 320);
    }

    /* ---------- 选中与关联高亮 ---------- */

    function select(id) {
      S.selected = id && S.byId[id] ? id : null;
      if (!S.selected) {
        S.neighbours = null;
        post({ type: 'graph:nodeClear' });
        requestFrame();
        return;
      }

      var neighbours = new Set();
      neighbours.add(S.selected);
      var relations = [];
      for (var i = 0; i < S.links.length; i++) {
        var l = S.links[i];
        var out = l.a.id === S.selected;
        var inc = l.b.id === S.selected;
        if (!out && !inc) continue;
        var other = out ? l.b : l.a;
        neighbours.add(other.id);
        relations.push({
          direction: out ? 'out' : 'in',
          label: l.label || '关联',
          other: other.id
        });
      }
      S.neighbours = neighbours;

      var node = S.byId[S.selected];
      post({
        type: 'graph:nodeSelect',
        node: {
          id: node.id, group: node.group, degree: node.degree,
          color: node.color, hub: node.hub
        },
        relations: relations
      });
      requestFrame();
    }

    /* ---------- 力导向布局 ---------- */

    /* 单步迭代：斥力 + 边弹簧 + 向心力，参考渲染器的参数与积分方式 */
    function simulate() {
      var nodes = S.nodes;
      var count = nodes.length;
      var i, j;

      for (i = 0; i < count; i++) {
        var p = nodes[i];
        for (j = i + 1; j < count; j++) {
          var q = nodes[j];
          var dx = p.x - q.x, dy = p.y - q.y;
          var d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = dx * dx + dy * dy + 0.01;
          }
          var d = Math.sqrt(d2);
          var f = REPULSION / d2;
          p.vx += (dx / d) * f; p.vy += (dy / d) * f;
          q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
        }
      }

      for (i = 0; i < S.links.length; i++) {
        var link = S.links[i];
        var ax = link.b.x - link.a.x, ay = link.b.y - link.a.y;
        var dist = Math.sqrt(ax * ax + ay * ay) || 1;
        var spring = (dist - REST_LENGTH) * LINK_K;
        link.a.vx += (ax / dist) * spring; link.a.vy += (ay / dist) * spring;
        link.b.vx -= (ax / dist) * spring; link.b.vy -= (ay / dist) * spring;
      }

      for (i = 0; i < count; i++) {
        var n = nodes[i];
        if (n.tx !== null) {
          /* 拖拽中：弹簧跟随光标，保留轻微拖尾形成弹性手感 */
          n.vx = (n.tx - n.x) * DRAG_K;
          n.vy = (n.ty - n.y) * DRAG_K;
        } else {
          n.vx -= n.x * CENTER_K;
          n.vy -= n.y * CENTER_K;
          n.vx *= DAMPING;
          n.vy *= DAMPING;
        }
        n.x += n.vx * STEP_SCALE;
        n.y += n.vy * STEP_SCALE;
      }
    }

    /* ---------- 绘制 ---------- */

    function drawGrid() {
      var step = GRID_STEP * S.scale;
      while (step < 17) step *= 2;
      while (step > 76) step /= 2;
      var startX = ((S.ox % step) + step) % step;
      var startY = ((S.oy % step) + step) % step;
      ctx.fillStyle = 'rgba(105,115,134,0.13)';
      ctx.beginPath();
      for (var x = startX; x < S.w; x += step) {
        for (var y = startY; y < S.h; y += step) {
          ctx.moveTo(x + 0.9, y);
          ctx.arc(x, y, 0.9, 0, TAU);
        }
      }
      ctx.fill();
    }

    function drawLinks() {
      var i, l, ax, ay, bx, by, connected, dim;
      var selected = S.selected;
      var alpha = S.drawAlpha;

      ctx.lineCap = 'round';
      for (i = 0; i < S.links.length; i++) {
        l = S.links[i];
        ax = sx(l.a.x); ay = sy(l.a.y);
        bx = sx(l.b.x); by = sy(l.b.y);
        if ((ax < -80 && bx < -80) || (ax > S.w + 80 && bx > S.w + 80) ||
            (ay < -80 && by < -80) || (ay > S.h + 80 && by > S.h + 80)) continue;
        connected = !!selected && (l.a.id === selected || l.b.id === selected);
        dim = !!selected && !connected;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = connected
          ? 'rgba(57,120,232,0.65)'
          : (dim ? 'rgba(23,26,33,0.06)' : 'rgba(23,26,33,0.16)');
        ctx.lineWidth = connected ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      ctx.globalAlpha = alpha;

      /* 关系标签：默认收起，仅在选中节点时显示其关联边，保持默认视图清爽 */
      if (!selected) return;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '10px ' + FONT;
      ctx.lineJoin = 'round';
      for (i = 0; i < S.links.length; i++) {
        l = S.links[i];
        if (!l.label) continue;
        if (l.a.id !== selected && l.b.id !== selected) continue;
        var mx = (sx(l.a.x) + sx(l.b.x)) / 2;
        var my = (sy(l.a.y) + sy(l.b.y)) / 2;
        if (mx < -40 || mx > S.w + 40 || my < -20 || my > S.h + 20) continue;
        var text = shortLabel(l.label, 9);
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(251,252,254,0.95)';
        ctx.strokeText(text, mx, my);
        ctx.fillStyle = '#3978e8';
        ctx.fillText(text, mx, my);
      }
    }

    function drawNodes() {
      var alpha = S.drawAlpha;
      var selected = S.selected;
      var hovered = S.hovered;
      var i, node, x, y, r, isSel, isHover, dim;

      /* 节点半径默认不随缩放变化；缩放过小时适度收缩，避免圆点糊成一团 */
      var radiusScale = S.scale >= 0.5 ? 1 : Math.max(0.55, S.scale / 0.5);

      /* 第一遍：节点本体 */
      for (i = 0; i < S.nodes.length; i++) {
        node = S.nodes[i];
        x = sx(node.x); y = sy(node.y);
        isSel = node.id === selected;
        isHover = node.id === hovered;
        r = node.r * radiusScale + (isSel ? 2.5 : (isHover ? 2 : 0));
        node._px = x; node._py = y; node._pr = r;
        node._off = (x < -70 || x > S.w + 70 || y < -70 || y > S.h + 70);
        if (node._off) continue;

        dim = !!selected && !isSel && !(S.neighbours && S.neighbours.has(node.id));
        ctx.globalAlpha = alpha * (dim ? 0.22 : 1);

        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fillStyle = node.color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = isSel || isHover ? 2.2 : 1.4;
        ctx.stroke();

        if (isSel) {
          ctx.beginPath();
          ctx.arc(x, y, r + 5, 0, TAU);
          ctx.strokeStyle = 'rgba(57,120,232,0.45)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      /* 第二遍：标签默认排在节点正下方；位置冲突时依次尝试外侧、上方、下一行，
         宁可让位也不隐藏。缩放很小或画布很窄时只保留主干节点的标签，
         否则 11px 的文字会糊成一片。 */
      var labelCap = S.scale < 0.24 ? 8
        : (S.scale < 0.36 ? 14 : (S.scale < 0.5 ? 26 : Infinity));
      var baseSize = S.w < 560 ? 10 : LABEL_SIZE;
      var drawn = 0;

      var order = S.nodes.slice().sort(function (a, b) {
        if (a.id === selected) return -1;
        if (b.id === selected) return 1;
        if (a.id === hovered) return -1;
        if (b.id === hovered) return 1;
        return b.degree - a.degree;
      });

      var boxes = [];
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      for (i = 0; i < order.length; i++) {
        node = order[i];
        if (node._off) continue;
        isSel = node.id === selected;
        isHover = node.id === hovered;
        if (!isSel && !isHover && drawn >= labelCap) continue;
        dim = !!selected && !isSel && !(S.neighbours && S.neighbours.has(node.id));

        var label = shortLabel(node.id, (isSel || isHover) ? LABEL_MAX_ACTIVE : LABEL_MAX);
        var fs = isSel ? baseSize + 1 : baseSize;
        ctx.font = (isSel ? '600 ' : '400 ') + fs + 'px ' + FONT;
        var width = ctx.measureText(label).width;
        var gap = node._pr + 5;
        var out = node.x >= 0 ? 1 : -1;
        var half = fs / 2 + 2;

        /* 候选位置：下方 → 朝布局外侧 → 上方 → 下方第二行 */
        var cands = [
          { x: node._px, y: node._py + gap + fs / 2 + 1 },
          { x: node._px + out * (gap + width / 2), y: node._py },
          { x: node._px, y: node._py - gap - fs / 2 - 1 },
          { x: node._px, y: node._py + gap + fs * 1.6 + 5 }
        ];

        /* 边缘节点的标签向画布内侧收，避免被裁切 */
        var halfW = width / 2 + 3;
        var halfH = fs / 2 + 2;
        for (var q = 0; q < cands.length; q++) {
          if (halfW * 2 < S.w) cands[q].x = clamp(cands[q].x, halfW + 2, S.w - halfW - 2);
          cands[q].y = clamp(cands[q].y, halfH + 2, S.h - halfH - 2);
        }

        var chosen = null, box = null;
        for (var c = 0; c < cands.length; c++) {
          var cand = cands[c];
          var b = {
            x1: cand.x - width / 2 - 3, y1: cand.y - half,
            x2: cand.x + width / 2 + 3, y2: cand.y + half
          };
          if (!hitsAny(b, boxes)) { chosen = cand; box = b; break; }
        }
        if (!chosen) {
          chosen = cands[0];
          box = {
            x1: chosen.x - width / 2 - 3, y1: chosen.y - half,
            x2: chosen.x + width / 2 + 3, y2: chosen.y + half
          };
        }
        boxes.push(box);
        drawn += 1;

        ctx.globalAlpha = alpha * (dim ? 0.22 : 1);
        ctx.fillStyle = 'rgba(251,252,254,0.92)';
        ctx.fillRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
        ctx.fillStyle = dim ? '#929ba9' : (isSel ? '#2868d8' : '#171a21');
        ctx.fillText(label, chosen.x, chosen.y);
      }
      ctx.globalAlpha = 1;
    }

    function hitsAny(box, boxes) {
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1) return true;
      }
      return false;
    }

    function draw() {
      ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      ctx.clearRect(0, 0, S.w, S.h);
      ctx.fillStyle = '#fbfcfe';
      ctx.fillRect(0, 0, S.w, S.h);
      drawGrid();
      if (!S.loaded || !S.nodes.length) return;
      S.drawAlpha = easeOut(S.reveal);
      drawLinks();
      drawNodes();
      ctx.globalAlpha = 1;
    }

    /* ---------- 帧循环 ---------- */

    function requestFrame() {
      if (!S.raf) S.raf = global.requestAnimationFrame(frame);
    }

    function frame(ts) {
      S.raf = 0;
      if (S.viewAnim) {
        var va = S.viewAnim;
        var t = clamp((ts - va.start) / va.duration, 0, 1);
        var e = easeOut(t);
        S.scale = va.from.s + (va.to.s - va.from.s) * e;
        S.ox = va.from.x + (va.to.x - va.from.x) * e;
        S.oy = va.from.y + (va.to.y - va.from.y) * e;
        if (t >= 1) S.viewAnim = null;
      }
      /* 平移惯性：松手后继续滑行并逐渐衰减，停止时轻微回弹归位 */
      if (S.inertia && !S.pointer) {
        S.ox += S.panVx;
        S.oy += S.panVy;
        S.panVx *= PAN_FRICTION;
        S.panVy *= PAN_FRICTION;
        if (Math.abs(S.panVx) < 0.08 && Math.abs(S.panVy) < 0.08) {
          S.inertia = false;
          S.panVx = 0; S.panVy = 0;
          settlePan();
        }
      }
      if (S.sim > 0) {
        simulate();
        S.sim *= 0.98;
        if (S.sim < 0.02) S.sim = 0;
      }
      if (S.reveal < 1) {
        if (!S.revealStart) S.revealStart = ts;
        S.reveal = clamp((ts - S.revealStart) / 340, 0, 1);
      }
      draw();
      if (S.sim > 0 || S.reveal < 1 || S.viewAnim || S.pointer || S.inertia) {
        requestFrame();
      }
    }

    /* ---------- 交互 ---------- */

    function hitTest(px, py) {
      for (var i = S.nodes.length - 1; i >= 0; i--) {
        var n = S.nodes[i];
        var dx = px - sx(n.x), dy = py - sy(n.y);
        var hit = Math.max(n.r, 9) + 6;
        if (dx * dx + dy * dy <= hit * hit) return n;
      }
      return null;
    }

    function showTooltip(node, px, py) {
      tooltip.textContent = '';
      var title = document.createElement('div');
      title.textContent = node.id;
      var meta = document.createElement('div');
      meta.className = 'gv-tooltip__meta';
      meta.textContent = '关联 ' + node.degree + ' 条关系 · 点击查看详情';
      tooltip.appendChild(title);
      tooltip.appendChild(meta);
      tooltip.style.left = clamp(px + 14, 8, Math.max(8, S.w - 240)) + 'px';
      tooltip.style.top = clamp(py + 14, 8, Math.max(8, S.h - 70)) + 'px';
      tooltip.classList.add('is-visible');
    }

    function hideTooltip() {
      tooltip.classList.remove('is-visible');
    }

    function localPoint(e) {
      var rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    canvas.addEventListener('pointerdown', function (e) {
      if (!S.loaded || !S.nodes.length) return;
      var p = localPoint(e);
      var node = hitTest(p.x, p.y);
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      S.pointer = {
        id: e.pointerId, type: node ? 'node' : 'pan', node: node,
        startX: p.x, startY: p.y, startOx: S.ox, startOy: S.oy
      };
      S.moved = false;
      S.inertia = false;
      S.panVx = 0; S.panVy = 0;
      S.viewAnim = null;
      /* 拖拽不硬绑定坐标，交给弹簧跟随，产生弹性与回弹 */
      if (node) { node.tx = node.x; node.ty = node.y; }
      canvas.classList.toggle('is-panning', !node);
      hideTooltip();
      requestFrame();
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', function (e) {
      var p = localPoint(e);
      var pointer = S.pointer;
      if (pointer && pointer.id === e.pointerId) {
        var dx = p.x - pointer.startX, dy = p.y - pointer.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) S.moved = true;
        if (pointer.type === 'pan') {
          var nextOx = pointer.startOx + dx;
          var nextOy = pointer.startOy + dy;
          var pb = panBounds();
          if (pb) {
            nextOx = rubber(nextOx, pb.minOx, pb.maxOx);
            nextOy = rubber(nextOy, pb.minOy, pb.maxOy);
          }
          /* 平滑记录平移速度，松手后作为惯性初速度 */
          S.panVx = S.panVx * 0.45 + (nextOx - S.ox) * 0.55;
          S.panVy = S.panVy * 0.45 + (nextOy - S.oy) * 0.55;
          S.ox = nextOx; S.oy = nextOy;
        } else {
          var n = pointer.node;
          n.tx = (p.x - S.ox) / S.scale;
          n.ty = (p.y - S.oy) / S.scale;
          S.sim = Math.max(S.sim, 0.6);
        }
        requestFrame();
        return;
      }
      var node = hitTest(p.x, p.y);
      var id = node ? node.id : null;
      if (id !== S.hovered) {
        S.hovered = id;
        canvas.classList.toggle('is-over-node', !!id);
        requestFrame();
      }
      if (node) showTooltip(node, p.x, p.y);
      else hideTooltip();
    });

    function endPointer(e) {
      var pointer = S.pointer;
      if (!pointer || pointer.id !== e.pointerId) return;
      canvas.classList.remove('is-panning');
      if (!S.moved) {
        select(pointer.type === 'node' ? pointer.node.id : null);
      }
      if (pointer.type === 'node') {
        /* 松开后由边弹簧与向心力带阻尼回位 */
        pointer.node.tx = null;
        pointer.node.ty = null;
        S.sim = Math.max(S.sim, 0.55);
      } else if (S.moved) {
        S.panVx = clamp(S.panVx, -26, 26);
        S.panVy = clamp(S.panVy, -26, 26);
        if (Math.abs(S.panVx) > 0.6 || Math.abs(S.panVy) > 0.6) {
          S.inertia = true;
        } else {
          S.inertia = false;
          settlePan();
        }
      }
      S.pointer = null;
      requestFrame();
    }

    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('pointerleave', function () {
      if (S.pointer) return;
      S.hovered = null;
      canvas.classList.remove('is-over-node');
      hideTooltip();
      requestFrame();
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = localPoint(e);
      var factor = clamp(Math.pow(0.999, e.deltaY), 0.85, 1.18);
      zoomBy(factor, p.x, p.y);
    }, { passive: false });

    /* ---------- 数据加载 ---------- */

    /* 初始分布用黄金角螺旋铺开，再做同步预热，避免首屏看到节点乱飞。
       只写坐标与显示属性，不改动 nodes / links 的数据结构。 */
    function prepare(nodes, links) {
      var groupIndex = {};
      var groupCount = 0;
      var i;

      nodes.forEach(function (n, idx) {
        if (groupIndex[n.group] == null) {
          groupIndex[n.group] = groupCount;
          groupCount += 1;
        }
        n.color = PALETTE[groupIndex[n.group] % PALETTE.length];
        n.degree = n.degree || 0;
        n.r = 6 + Math.min(n.degree, 8) * 0.6;
        n.hub = n.degree >= 4;

        var angle = idx * 2.399963229728653;
        var radius = 30 + Math.sqrt(idx) * 34;
        n.x = Math.cos(angle) * radius;
        n.y = Math.sin(angle) * radius;
        n.vx = 0; n.vy = 0;
        n.tx = null; n.ty = null;

        ctx.font = '400 ' + LABEL_SIZE + 'px ' + FONT;
        n.labelW = ctx.measureText(shortLabel(n.id, LABEL_MAX)).width;
      });

      S.nodes = nodes;
      S.links = links;
      S.groupCount = groupCount;

      /* 预热：一次性迭代到稳定布局；节点较多时下调步数控制首屏耗时 */
      var steps = nodes.length > 240 ? 100 : (nodes.length > 120 ? 180 : PREHEAT);
      for (i = 0; i < steps; i++) simulate();
    }

    function setData(data) {
      var rawNodes = data && Array.isArray(data.nodes) ? data.nodes : [];
      var rawLinks = data && Array.isArray(data.links) ? data.links : [];

      if (!rawNodes.length) {
        S.loaded = false;
        S.hasFit = false;
        S.nodes = []; S.links = []; S.byId = {};
        setMessage('暂无图谱数据\n请先在工作台上传文档并生成知识图谱', true);
        post({ type: 'graph:empty' });
        requestFrame();
        return;
      }

      setMessage('', false);
      var nodes = [], byId = {};
      rawNodes.forEach(function (rn) {
        var rawId = rn && (rn.id != null ? rn.id : (rn.name != null ? rn.name : rn.label));
        var id = endpointId(rawId);
        if (!id || byId[id]) return;
        var group = Number(rn && rn.group);
        if (!isFinite(group)) group = 0;
        var node = {
          id: id, group: group, x: 0, y: 0, vx: 0, vy: 0,
          tx: null, ty: null, r: 9, degree: 0, hub: false, labelW: 0,
          color: PALETTE[0]
        };
        nodes.push(node);
        byId[id] = node;
      });

      var links = [];
      rawLinks.forEach(function (rl) {
        if (!rl) return;
        var a = byId[endpointId(rl.source != null ? rl.source : rl.from)];
        var b = byId[endpointId(rl.target != null ? rl.target : rl.to)];
        if (!a || !b || a === b) return;
        var label = rl.label != null ? rl.label :
          (rl.relation != null ? rl.relation : (rl.type != null ? rl.type : ''));
        label = String(label).replace(/\s+/g, ' ').trim();
        links.push({ a: a, b: b, label: label });
        a.degree += 1;
        b.degree += 1;
      });

      S.byId = byId;
      prepare(nodes, links);

      S.selected = null; S.neighbours = null; S.hovered = null;
      S.inertia = false; S.panVx = 0; S.panVy = 0;
      S.sim = 0.2; S.reveal = 0; S.revealStart = 0;
      S.loaded = true;
      S.hasFit = false;
      fit(false);
      requestFrame();

      post({
        type: 'graph:ready',
        nodeCount: nodes.length,
        linkCount: links.length,
        groupCount: S.groupCount,
        sample: isSample,
        nodes: nodes.map(function (n) {
          return { id: n.id, group: n.group, degree: n.degree, color: n.color };
        })
      });
    }

    function load() {
      var sep = sourceUrl.indexOf('?') >= 0 ? '&' : '?';
      fetch(sourceUrl + sep + 't=' + Date.now(), { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(setData)
        .catch(function (err) {
          console.error('[Text2KG] 图谱数据加载失败:', err);
          var text = err && err.message ? err.message : '未知错误';
          setMessage('图谱数据加载失败\n' + text, true);
          post({ type: 'graph:error', message: text });
        });
    }

    /* ---------- 父页面命令 ---------- */

    var api = {
      zoomIn: function () { zoomBy(1.25); },
      zoomOut: function () { zoomBy(0.8); },
      fit: function () { fit(true); },
      reset: resetView,
      focus: focusNode,
      clearSelection: function () { select(null); },
      reload: load,
      getStats: function () {
        return {
          nodes: S.nodes.length, links: S.links.length,
          groupCount: S.groupCount, scale: S.scale
        };
      }
    };

    global.addEventListener('message', function (event) {
      var d = event.data;
      if (!d || d.type !== 'graph:command' || !d.action) return;
      switch (d.action) {
        case 'zoomIn': api.zoomIn(); break;
        case 'zoomOut': api.zoomOut(); break;
        case 'fit': api.fit(); break;
        case 'reset': api.reset(); break;
        case 'focus': if (d.id) api.focus(d.id); break;
        case 'clearSelect': api.clearSelection(); break;
        case 'reload': api.reload(); break;
        default: break;
      }
    });

    if (global.ResizeObserver) {
      new global.ResizeObserver(resize).observe(container);
    } else {
      global.addEventListener('resize', resize);
    }
    resize();
    load();

    container.__graphView = api;
    global.__graphView = api;
    return api;
  }

  global.GraphView = { create: create, palette: PALETTE.slice() };
})(window);
