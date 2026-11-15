/* ==========================================================================
   Text2KG Application Workspace
   仅负责前端交互，业务接口与数据契约完全沿用原有实现：
     POST /upload          FormData(file)  → { text, sum, file_path }
     POST /update_graph    JSON { text }   → { nodes, links }
     GET  /uploads/<name>                  打开文件
     GET  /static/knowledge_graph.json     导出图谱 JSON
     iframe /graph（真实结果）  /graph0（内置示意图谱）
   ========================================================================== */

(function () {
  'use strict';

  var MAX_FILE_MB = 20;
  var $ = function (id) { return document.getElementById(id); };
  var Icons = window.Icons;

  var textbox = $('textbox');
  var fileInput = $('file-input');
  var generateBtn = $('generate-btn');
  var dropZone = $('drop-zone');
  var frame = $('myIframe');

  var state = {
    busy: false,
    file: null,
    graphNodes: [],
    graphReady: false,
    graphLoading: false,
    isSample: false,
    hasRealGraph: false,
    readyTimer: 0,
    generating: false,
    uploading: false,
    controller: null,
    taskSeq: 0
  };

  /* ----------------------------------------------------------------------
     通用 UI
     ---------------------------------------------------------------------- */

  function showToast(type, title, text) {
    var stack = $('toast-stack');
    var iconName = type === 'success' ? 'check-circle'
      : (type === 'warning' ? 'alert-circle'
        : (type === 'error' ? 'alert-circle' : 'info'));

    var el = document.createElement('div');
    el.className = 'toast toast--' + type;
    el.innerHTML =
      '<span class="toast__icon">' + Icons.svg(iconName) + '</span>' +
      '<div class="toast__body"><div class="toast__title"></div>' +
      '<div class="toast__text"></div></div>' +
      '<button class="toast__close" type="button" aria-label="关闭">' +
      Icons.svg('x', 'icon--sm') + '</button>';
    el.querySelector('.toast__title').textContent = title;
    el.querySelector('.toast__text').textContent = text || '';

    stack.appendChild(el);
    var timer = setTimeout(dismiss, type === 'error' ? 6500 : 4200);
    function dismiss() {
      clearTimeout(timer);
      if (!el.parentNode) return;
      el.classList.add('is-leaving');
      setTimeout(function () { if (el.parentNode) el.remove(); }, 180);
    }
    el.querySelector('.toast__close').addEventListener('click', dismiss);
  }

  function showModal(message, closable) {
    $('modal-content').textContent = message;
    var processing = closable === false;
    $('modal-actions').classList.toggle('u-hidden', !processing);
    /* 确定按钮常驻：只收起遮挡层，任务继续在后台运行 */
    $('modal-confirm-wrap').classList.remove('u-hidden');
    $('modal-overlay').classList.add('is-open');
    setTimeout(function () { $('modal-confirm').focus(); }, 100);
  }

  function closeModal() {
    $('modal-overlay').classList.remove('is-open');
  }

  /* ----------------------------------------------------------------------
     处理中：两个出口
       · 弹窗「确定」/ Escape / 遮罩 → 只收起提示，任务继续后台运行
       · 主按钮（文字带「点击取消」）→ 真正取消：abort 请求并恢复界面
     图谱生成中的加载层不提供任何关闭按钮，五个小球动画一直保留，
     直到任务完成或主动取消；主按钮全过程的淡蓝样式保持一致。
     ---------------------------------------------------------------------- */

  function hasActiveTask() {
    return state.generating || state.uploading;
  }

  function currentKind() {
    return state.uploading ? 'upload' : (state.generating ? 'generate' : null);
  }

  function restoreGraphPanel() {
    if (state.graphReady) {
      showGraphState('none');
      setGraphTools(true);
    } else {
      /* 图谱尚未就绪时回到空状态，避免显示空白画布 */
      showGraphState('empty');
      setGraphTools(false);
    }
  }

  /* 只收起「正在处理」弹窗；图谱加载层与任务状态保持不变 */
  function dismissProcessing() {
    var running = hasActiveTask();
    closeModal();
    syncBusy();
    showToast('info', running ? '仍在后台运行' : '已返回工作台',
      running ? '任务继续处理，完成后会自动更新结果' : '页面已恢复，可继续操作');
  }

  function cancelCurrentTask() {
    if (!hasActiveTask()) return;
    /* token 递增，让在途请求的迟到响应静默失效 */
    state.taskSeq += 1;
    if (state.controller) {
      try { state.controller.abort(); } catch (err) { /* 忽略重复 abort */ }
    }
    state.controller = null;
    state.generating = false;
    state.uploading = false;
    state.graphLoading = false;
    clearTimeout(state.readyTimer);
    closeModal();
    restoreFileCard();
    restoreGraphPanel();
    setStatus('准备就绪', '');
    if (/^正在/.test($('workspace-status').textContent)) {
      $('workspace-status').textContent = '准备就绪';
    }
    syncBusy();
    showToast('info', '已取消', '已停止当前任务，工作台可继续操作');
  }

  function setStatus(text, kind, busy) {
    $('nav-status-text').textContent = text;
    $('nav-status-dot').className = 'dot' +
      (kind ? ' dot--' + kind : '') + (busy ? ' dot--pulse' : '');
  }

  /* 任务期间：主按钮保持可点（取消入口）、附加取消文字并统一为淡蓝色；
     上传 / 示例 / 拖拽控件始终禁用。弹窗是否收起不影响任何按钮样式。 */
  function setTaskUI(kind) {
    var active = !!kind;
    state.busy = active;
    generateBtn.disabled = false;
    generateBtn.classList.toggle('is-loading', active);
    generateBtn.classList.toggle('is-running', active);
    generateBtn.title = active ? '点击取消当前任务' : '';
    $('generate-label').textContent = !active ? '生成知识图谱'
      : (kind === 'upload' ? '正在解析文档（点击取消）'
        : '正在生成图谱（点击取消）');

    ['file-input', 'drop-zone', 'empty-upload-btn', 'sample-btn', 'replace-file-btn']
      .forEach(function (id) { $(id).disabled = active; });
  }

  /* 依据仍在运行的任务同步按钮状态 */
  function syncBusy() {
    setTaskUI(currentKind());
  }

  function setGraphTools(enabled) {
    ['zoom-out-btn', 'zoom-in-btn', 'fit-btn', 'reset-btn', 'node-search']
      .forEach(function (id) { $(id).disabled = !enabled; });
    if (!enabled) $('search-results').classList.add('u-hidden');
  }

  function setExport(enabled) {
    $('export-btn').disabled = !enabled;
  }

  /* 后端异常时可能返回 HTML，兜底避免二次崩溃（沿用原实现） */
  async function readJson(response) {
    var raw = await response.text();
    try {
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      throw new Error('服务器返回了非 JSON 响应（HTTP ' + response.status + '）');
    }
  }

  /* ----------------------------------------------------------------------
     文档内容
     ---------------------------------------------------------------------- */

  function updateEditorMeta() {
    var text = textbox.innerText;
    var count = text.replace(/\s/g, '').length;
    $('editor-counter').textContent = count.toLocaleString('zh-CN') + ' 字';
    $('editor-placeholder').classList.toggle('u-hidden', !!text.trim());
  }

  function displaySummary(summary) {
    if (!summary || !String(summary).trim()) {
      showToast('warning', '未能生成摘要', '请检查文件后重试，或直接输入文本内容');
      return;
    }
    /* 使用 textContent 防止 HTML 注入，并保留「摘要预览」语义 */
    textbox.textContent = summary;
    updateEditorMeta();
  }

  function setNavDocument(name) {
    var nav = $('nav-doc-name');
    nav.textContent = '';
    var holder = document.createElement('span');
    holder.innerHTML = Icons.svg('file-text', 'icon--sm');
    nav.appendChild(holder.firstElementChild);
    nav.appendChild(document.createTextNode(' ' + name));
    nav.title = name;
  }

  function formatOf(name) {
    var parts = String(name || '').split('.');
    return parts.length > 1 ? parts.pop().toUpperCase() : 'FILE';
  }

  function showFileCard(name, status, pending) {
    var card = $('file-info');
    if (!name) {
      card.classList.add('u-hidden');
      return;
    }
    card.classList.remove('u-hidden');
    $('file-name').textContent = name;
    $('file-name').title = name;
    $('file-format').textContent = formatOf(name);
    var badge = $('file-status');
    badge.textContent = status;
    badge.className = 'chip ' + (pending ? 'chip--warning' : 'chip--success');
    $('open-file-btn').disabled = !!pending;
    $('replace-file-btn').disabled = !!pending;
  }

  function restoreFileCard() {
    if (state.file) {
      showFileCard(state.file.name, '已解析', false);
      $('open-file-btn').onclick = function () { window.open(state.file.path, '_blank'); };
    } else {
      showFileCard(null);
      $('open-file-btn').onclick = null;
    }
  }

  /* ----------------------------------------------------------------------
     文件上传（点击 + 拖拽）
     ---------------------------------------------------------------------- */

  async function handleFile(file) {
    if (!file) return;
    if (hasActiveTask()) {
      showToast('info', '当前任务仍在运行', '请等待完成，或点击主按钮上的「点击取消」');
      return;
    }

    var filename = (file.name || '').toLowerCase();
    if (!/\.(pdf|docx|txt)$/.test(filename)) {
      showToast('warning', '不支持的文件格式', '请上传 PDF、DOCX 或 TXT 格式的文件');
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      showToast('warning', '文件过大', '最大支持 ' + MAX_FILE_MB + ' MB');
      return;
    }

    showFileCard(file.name, '解析中', true);
    state.uploading = true;
    var controller = new AbortController();
    state.controller = controller;
    var token = ++state.taskSeq;
    try {
      setStatus('正在解析文档', 'brand', true);
      showModal('正在解析文件并生成摘要，请稍候…', false);
      setTaskUI('upload');

      var formData = new FormData();
      formData.append('file', file);
      var response = await fetch('/upload', {
        method: 'POST', body: formData, signal: controller.signal
      });
      var data = await readJson(response);
      if (token !== state.taskSeq) return; /* 已取消，结果静默丢弃 */
      if (!response.ok || data.error) {
        throw new Error(data.error || ('HTTP ' + response.status));
      }

      displaySummary(data.sum);

      if (data.file_path) {
        /* 后端返回的是原始（已清理的）文件名路径，不做 decode，避免文件名中的 % 触发异常 */
        var storedName = String(data.file_path).split('/').pop();
        state.file = { name: storedName, path: data.file_path };
        showFileCard(storedName, '已解析', false);
        setNavDocument(storedName);
        $('open-file-btn').onclick = function () {
          window.open(data.file_path, '_blank');
        };
      }

      closeModal();
      setStatus('文档已就绪', 'success');
      showToast('success', '文档解析完成', '摘要已写入文档内容，可直接编辑后生成图谱');
    } catch (error) {
      if (token !== state.taskSeq) return; /* 主动取消，不提示为失败 */
      console.error('[Text2KG] 文件处理失败:', error);
      closeModal();
      restoreFileCard();
      setStatus('解析失败', 'error');
      showToast('error', '文件处理失败', error.message);
    } finally {
      if (token === state.taskSeq) {
        state.uploading = false;
        state.controller = null;
        syncBusy();
      }
    }
  }

  fileInput.addEventListener('change', function () {
    if (!this.files || this.files.length === 0) return;
    var file = this.files[0];
    this.value = ''; /* 允许重复选择同一个文件 */
    handleFile(file);
  });

  dropZone.addEventListener('click', function () { fileInput.click(); });
  $('empty-upload-btn').addEventListener('click', function () { fileInput.click(); });
  $('replace-file-btn').addEventListener('click', function () { fileInput.click(); });

  /* 拖拽：上传区与整个左侧面板都可接收 */
  ['dragenter', 'dragover'].forEach(function (type) {
    dropZone.addEventListener(type, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('is-dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    dropZone.addEventListener(type, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('is-dragging');
    });
  });
  dropZone.addEventListener('drop', function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) handleFile(files[0]);
  });

  var inputPanel = $('input-panel');
  inputPanel.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropZone.classList.add('is-dragging');
  });
  inputPanel.addEventListener('dragleave', function (e) {
    if (!inputPanel.contains(e.relatedTarget)) dropZone.classList.remove('is-dragging');
  });
  inputPanel.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('is-dragging');
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) handleFile(files[0]);
  });
  /* 避免拖到页面其它位置时浏览器直接打开文件 */
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) { e.preventDefault(); });

  /* ----------------------------------------------------------------------
     图谱状态与 iframe
     ---------------------------------------------------------------------- */

  var OVERLAYS = {
    empty: 'graph-empty',
    loading: 'graph-loading',
    error: 'graph-error'
  };

  function showGraphState(kind, message) {
    Object.keys(OVERLAYS).forEach(function (key) {
      $(OVERLAYS[key]).classList.toggle('u-hidden', key !== kind);
    });
    if (kind === 'error' && message) {
      $('graph-error-text').textContent = message;
    }
    var visible = kind === 'none';
    frame.classList.toggle('is-hidden', !visible);
    $('graph-legend').classList.toggle('u-hidden', !visible || !state.graphReady);
    $('graph-hint').classList.toggle('u-hidden', !visible);
    $('graph-sample-badge').classList.toggle(
      'u-hidden', !(visible && state.isSample)
    );
  }

  function loadGraph(url) {
    state.graphLoading = true;
    state.graphReady = false;
    setGraphTools(false);
    hideInspector();
    frame.src = url;

    clearTimeout(state.readyTimer);
    /* 兜底：若 postMessage 因异常丢失，也不让界面卡在加载态 */
    state.readyTimer = setTimeout(function () {
      if (!state.graphLoading) return;
      state.graphLoading = false;
      state.graphReady = true;
      setGraphTools(true);
      showGraphState('none');
    }, 8000);
  }

  function sendCommand(action, id) {
    var win = frame.contentWindow;
    if (!win) return;
    var message = { type: 'graph:command', action: action };
    if (id) message.id = id;
    win.postMessage(message, window.location.origin);
  }

  /* ----------------------------------------------------------------------
     生成知识图谱
     ---------------------------------------------------------------------- */

  async function generate() {
    if (hasActiveTask()) {
      showToast('info', '当前任务仍在运行', '请等待完成，或点击主按钮上的「点击取消」');
      return;
    }
    var text = textbox.innerText.trim();
    if (!text) {
      showToast('warning', '暂无可生成的文本', '请先上传文档，或在左侧输入文本内容');
      textbox.focus();
      return;
    }

    state.generating = true;
    var controller = new AbortController();
    state.controller = controller;
    var token = ++state.taskSeq;
    setStatus('正在生成图谱', 'brand', true);
    showModal('正在生成知识图谱，请稍候…', false);
    setTaskUI('generate');
    showGraphState('loading');
    $('workspace-status').textContent = '正在生成图谱';

    try {
      var response = await fetch('/update_graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text }),
        signal: controller.signal
      });
      var data = await readJson(response);
      if (token !== state.taskSeq) return; /* 已取消，结果静默丢弃 */
      if (!response.ok || data.error) {
        throw new Error(data.error || ('HTTP ' + response.status));
      }

      state.hasRealGraph = true;
      state.isSample = false;
      setExport(true);
      closeModal();
      /* 与原有逻辑一致：生成成功后刷新 iframe 加载最新图谱 */
      loadGraph('/graph?t=' + Date.now());
      setStatus('图谱已生成', 'success');
      $('workspace-status').textContent =
        (data.nodes ? data.nodes.length : 0) + ' 个节点 · ' +
        (data.links ? data.links.length : 0) + ' 条关系';
      showToast('success', '知识图谱已生成',
        (data.nodes ? data.nodes.length : 0) + ' 个节点，' +
        (data.links ? data.links.length : 0) + ' 条关系已呈现');
    } catch (error) {
      if (token !== state.taskSeq) return; /* 主动取消，不提示为失败 */
      console.error('[Text2KG] 生成知识图谱失败:', error);
      closeModal();
      state.graphLoading = false;
      clearTimeout(state.readyTimer);
      setStatus('生成失败', 'error');
      $('workspace-status').textContent = '生成失败';
      showGraphState('error', error.message);
      showToast('error', '生成失败', error.message);
    } finally {
      if (token === state.taskSeq) {
        state.generating = false;
        state.controller = null;
        syncBusy();
      }
    }
  }

  /* 主按钮：任务期间是真正的取消入口，空闲时才是生成 */
  generateBtn.addEventListener('click', function () {
    if (hasActiveTask()) {
      cancelCurrentTask();
      return;
    }
    generate();
  });
  $('retry-btn').addEventListener('click', generate);

  /* 内置示意图谱：保留 /graph0 路由，并明确标注示意数据 */
  $('sample-btn').addEventListener('click', function () {
    if (hasActiveTask()) return;
    state.isSample = true;
    state.hasRealGraph = false;
    setExport(false);
    $('workspace-status').textContent = '示例图谱（示意数据）';
    showGraphState('loading');
    loadGraph('/graph0?t=' + Date.now());
    showToast('info', '已载入示例图谱', '这是内置示意数据，非真实生成结果');
  });

  /* ----------------------------------------------------------------------
     节点详情
     ---------------------------------------------------------------------- */

  function hideInspector() {
    $('node-inspector').classList.add('u-hidden');
  }

  function showInspector(data) {
    var node = data.node || {};
    $('inspector-title').textContent = node.id || '—';
    $('inspector-dot').style.background = node.color || 'var(--brand)';
    $('inspector-degree').textContent = (node.degree || 0) + ' 条关联';
    $('inspector-group').textContent = '分类 ' + ((node.group || 0) + 1);

    var list = $('inspector-relations');
    list.textContent = '';
    var relations = (data.relations || []).slice(0, 12);
    if (!relations.length) {
      var empty = document.createElement('div');
      empty.className = 'node-inspector__item';
      empty.textContent = '暂无关联关系';
      list.appendChild(empty);
    } else {
      relations.forEach(function (rel) {
        var item = document.createElement('div');
        item.className = 'node-inspector__item';
        var iconHolder = document.createElement('span');
        iconHolder.innerHTML = Icons.svg(
          rel.direction === 'out' ? 'arrow-right' : 'arrow-left', 'icon--sm'
        );
        item.appendChild(iconHolder.firstElementChild);
        var text = document.createElement('span');
        var label = document.createElement('em');
        label.textContent = (rel.label || '关联') + ' · ';
        var target = document.createElement('b');
        target.textContent = rel.other;
        text.appendChild(label);
        text.appendChild(target);
        item.appendChild(text);
        list.appendChild(item);
      });
    }
    $('node-inspector').classList.remove('u-hidden');
  }

  $('inspector-close').addEventListener('click', function () {
    hideInspector();
    sendCommand('clearSelect');
  });

  /* ----------------------------------------------------------------------
     工具栏
     ---------------------------------------------------------------------- */

  $('zoom-in-btn').addEventListener('click', function () { sendCommand('zoomIn'); });
  $('zoom-out-btn').addEventListener('click', function () { sendCommand('zoomOut'); });
  $('fit-btn').addEventListener('click', function () { sendCommand('fit'); });
  $('reset-btn').addEventListener('click', function () { sendCommand('reset'); });

  $('export-btn').addEventListener('click', function () {
    if (!state.hasRealGraph) return;
    /* 沿用原有数据源：后端原子写入的 static/knowledge_graph.json */
    var link = document.createElement('a');
    link.href = '/static/knowledge_graph.json?t=' + Date.now();
    link.download = 'knowledge_graph.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('success', '已开始下载', '正在导出当前知识图谱 JSON 文件');
  });

  function toggleFullscreen() {
    var panel = $('graph-panel');
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (panel.requestFullscreen) {
      var result = panel.requestFullscreen();
      if (result && result.catch) {
        result.catch(function () {
          showToast('warning', '无法进入全屏', '请使用浏览器自带的全屏功能');
        });
      }
    } else {
      showToast('warning', '当前浏览器不支持全屏', '可使用浏览器自带全屏功能');
    }
  }

  $('fullscreen-btn').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', function () {
    var active = !!document.fullscreenElement;
    var btn = $('fullscreen-btn');
    btn.classList.toggle('is-active', active);
    btn.title = active ? '退出全屏' : '全屏查看';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = Icons.svg(active ? 'minimize' : 'maximize', 'icon--sm');
    if (state.graphReady) {
      setTimeout(function () { sendCommand('fit'); }, 140);
    }
  });

  /* 节点搜索：真实定位到图谱节点 */
  var searchInput = $('node-search');
  var searchResults = $('search-results');

  function chooseNode(id) {
    searchInput.value = id;
    searchResults.classList.add('u-hidden');
    sendCommand('focus', id);
  }

  function renderSearch(term) {
    searchResults.textContent = '';
    var query = term.trim().toLowerCase();
    if (!query) {
      searchResults.classList.add('u-hidden');
      return;
    }
    var matches = state.graphNodes.filter(function (node) {
      return String(node.id).toLowerCase().indexOf(query) !== -1;
    }).slice(0, 8);

    if (!matches.length) {
      var empty = document.createElement('div');
      empty.className = 'search-results__empty';
      empty.textContent = '未找到匹配的节点';
      searchResults.appendChild(empty);
    } else {
      matches.forEach(function (node) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'search-results__item';
        var dot = document.createElement('i');
        dot.className = 'search-results__dot';
        dot.style.background = node.color;
        var label = document.createElement('span');
        label.textContent = node.id;
        item.appendChild(dot);
        item.appendChild(label);
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          chooseNode(node.id);
        });
        searchResults.appendChild(item);
      });
    }
    searchResults.classList.remove('u-hidden');
  }

  searchInput.addEventListener('input', function () { renderSearch(this.value); });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var first = searchResults.querySelector('.search-results__item');
      if (first) {
        e.preventDefault();
        chooseNode(first.textContent.trim());
      }
    }
  });
  searchInput.addEventListener('blur', function () {
    setTimeout(function () { searchResults.classList.add('u-hidden'); }, 150);
  });

  /* ----------------------------------------------------------------------
     iframe → 父页面消息
     ---------------------------------------------------------------------- */

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== 'text2kg-graph') return;

    switch (data.type) {
      case 'graph:ready':
        state.graphLoading = false;
        state.graphReady = true;
        state.graphNodes = data.nodes || [];
        clearTimeout(state.readyTimer);
        setGraphTools(true);
        $('graph-count').textContent =
          data.nodeCount + ' 节点 · ' + data.linkCount + ' 关系' +
          (data.sample ? ' · 示意' : '');
        if (data.sample) {
          $('workspace-status').textContent = '示例图谱（示意数据）';
          setStatus('示意图谱', 'warning');
        } else {
          $('workspace-status').textContent =
            data.nodeCount + ' 个节点 · ' + data.linkCount + ' 条关系';
          setStatus('图谱已生成', 'success');
        }
        showGraphState('none');
        break;

      case 'graph:empty':
        state.graphLoading = false;
        state.graphReady = false;
        clearTimeout(state.readyTimer);
        setGraphTools(false);
        showGraphState('empty');
        break;

      case 'graph:error':
        state.graphLoading = false;
        state.graphReady = false;
        clearTimeout(state.readyTimer);
        setGraphTools(false);
        showGraphState('error', data.message || '图谱数据加载失败');
        showToast('error', '图谱加载失败', data.message || '图谱数据加载失败');
        break;

      case 'graph:nodeSelect':
        showInspector(data);
        break;

      case 'graph:nodeClear':
        hideInspector();
        break;

      default:
        break;
    }
  });

  /* ----------------------------------------------------------------------
     其它交互
     ---------------------------------------------------------------------- */

  /* 弹窗确定只收起弹窗，图谱生成中的五个小球动画继续 */
  $('modal-confirm').addEventListener('click', dismissProcessing);
  /* 点击遮罩空白处同样只收起弹窗 */
  $('modal-overlay').addEventListener('click', function (e) {
    if (e.target === this) dismissProcessing();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if ($('modal-overlay').classList.contains('is-open')) {
      dismissProcessing();
      return;
    }
    hideInspector();
    searchResults.classList.add('u-hidden');
    if (state.graphReady) sendCommand('clearSelect');
  });

  textbox.addEventListener('input', updateEditorMeta);

  /* ----------------------------------------------------------------------
     初始化
     ---------------------------------------------------------------------- */

  if (Icons) Icons.render(document);
  updateEditorMeta();
  setGraphTools(false);
  setExport(false);
  showGraphState('empty');
  setStatus('准备就绪', '');
})();
