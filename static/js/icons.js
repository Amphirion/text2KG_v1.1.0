/* ==========================================================================
   Text2KG Icon Set
   统一 Lucide 风格线性图标：24×24 网格、1.75 描边、圆角端点。
   零依赖，内联渲染，避免外部图标库/CDN。
   用法：<span data-icon="upload"></span>  →  Icons.render(document)
        Icons.svg('upload', 'icon--sm')   →  返回 SVG 字符串
   ========================================================================== */

(function (global) {
  'use strict';

  var PATHS = {
    /* 品牌标记：三节点知识网络 */
    'logo': '<circle cx="12" cy="5.5" r="2.2"/><circle cx="5" cy="17.5" r="2.2"/><circle cx="19" cy="17.5" r="2.2"/><path d="M10.5 7.4 6.4 15.6M13.5 7.4l4.1 8.2M7.2 17.5h9.6"/>',

    'arrow-right': '<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>',
    'arrow-left': '<path d="M20 12H5"/><path d="m11 6-6 6 6 6"/>',
    'arrow-up-right': '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'x': '<path d="M18 6 6 18M6 6l12 12"/>',
    'check': '<path d="m5 12 4.5 4.5L19 7"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16 9.5"/>',
    'alert-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.2"/><path d="M12 16.4h.01"/>',
    'info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.8h.01"/>',

    /* 文件与上传 */
    'file': '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/>',
    'file-text': '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/><path d="M8.5 12.5h7M8.5 16.5h5"/>',
    'file-check': '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/><path d="m8.5 15 2 2 4-4"/>',
    'upload': '<path d="M20.5 15.5v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3"/><path d="m7.5 8 4.5-4.5 4.5 4.5"/><path d="M12 3.5v11.5"/>',
    'upload-cloud': '<path d="M6.5 17.5a4.5 4.5 0 0 1-.4-9 6 6 0 0 1 11.6 1.4 3.8 3.8 0 0 1 .3 7.6"/><path d="m9.5 12.5 2.5-2.5 2.5 2.5"/><path d="M12 10v8"/>',
    'download': '<path d="M20.5 15.5v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3"/><path d="m7.5 11.5 4.5 4.5 4.5-4.5"/><path d="M12 16V4.5"/>',
    'external-link': '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18 14v4.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    'replace': '<path d="M20 11a8 8 0 0 0-13.7-5.3L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 13.7 5.3L20 16"/><path d="M20 20v-4h-4"/>',

    /* 图谱与功能 */
    'network': '<circle cx="12" cy="5" r="2.3"/><circle cx="5" cy="18" r="2.3"/><circle cx="19" cy="18" r="2.3"/><path d="M10.6 7.1 6.3 15.8M13.4 7.1l4.3 8.7M7.3 18h9.4"/>',
    'scan-text': '<path d="M3.5 8V6a2 2 0 0 1 2-2h2"/><path d="M16.5 4h2a2 2 0 0 1 2 2v2"/><path d="M20.5 16v2a2 2 0 0 1-2 2h-2"/><path d="M7.5 20h-2a2 2 0 0 1-2-2v-2"/><path d="M7.5 9h9M7.5 12.5h9M7.5 16h5.5"/>',
    'focus': '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
    'git-branch': '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9a6 6 0 0 1-6 6H6"/>',
    'layers': '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    'sparkles': '<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="m18.5 15 .7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z"/>',
    'book-open': '<path d="M12 6.5C9.5 5 6.5 4.5 3 5v14c3.5-.5 6.5 0 9 1.5 2.5-1.5 5.5-2 9-1.5V5c-3.5-.5-6.5 0-9 1.5Z"/><path d="M12 6.5v14"/>',
    'grid': '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',

    /* 图谱工具栏 */
    'zoom-in': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/><path d="M10.5 7.8v5.4M7.8 10.5h5.4"/>',
    'zoom-out': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/><path d="M7.8 10.5h5.4"/>',
    'maximize': '<path d="M8.5 3.5h-4a1 1 0 0 0-1 1v4"/><path d="M15.5 3.5h4a1 1 0 0 1 1 1v4"/><path d="M20.5 15.5v4a1 1 0 0 1-1 1h-4"/><path d="M3.5 15.5v4a1 1 0 0 0 1 1h4"/>',
    'minimize': '<path d="M3.5 8.5h4a1 1 0 0 0 1-1v-4"/><path d="M20.5 8.5h-4a1 1 0 0 1-1-1v-4"/><path d="M3.5 15.5h4a1 1 0 0 1 1 1v4"/><path d="M20.5 15.5h-4a1 1 0 0 0-1 1v4"/>',
    'fit': '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 9.5h6v5H9z"/>',
    'refresh-cw': '<path d="M20 11a8 8 0 0 0-13.7-5.3L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 13.7 5.3L20 16"/><path d="M20 20v-4h-4"/>',
    'search': '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4.5 4.5"/>',
    'crosshair': '<circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
    'mouse-pointer': '<path d="m5 3 6.5 17 2.4-6.8 7-2.4L5 3Z"/>',
    'move': '<path d="M12 2v20M2 12h20"/><path d="m9 5 3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/>',

    /* 导航与状态 */
    'home': '<path d="m3.5 10.5 8.5-7 8.5 7"/><path d="M5.5 9.5v10h13v-10"/><path d="M10 19.5v-6h4v6"/>',
    'settings': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1-2.4 2.4-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2h-3.4v-.2a1.6 1.6 0 0 0-2.7-1.1l-.1.1-2.4-2.4.1-.1a1.6 1.6 0 0 0-1.1-2.7H4.8v-3.4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1 2.4-2.4.1.1a1.6 1.6 0 0 0 2.7-1.1V4.4h3.4v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1 2.4 2.4-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2v3.4h-.2a1.6 1.6 0 0 0-1.4 1Z"/>',
    'help-circle': '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 1c0 1.8-2.5 2.2-2.5 3.8"/><path d="M12 17.2h.01"/>',
    'clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.3l3.3 2"/>',
    'panel-left': '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9.5 4v16"/>'
  };

  var SVG_OPEN =
    '<svg class="iconCLASS" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" ' +
    'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" focusable="false">';

  function svg(name, extraClass) {
    var body = PATHS[name];
    if (!body) {
      body = PATHS['info'];
    }
    var cls = 'icon' + (extraClass ? ' ' + extraClass : '');
    return SVG_OPEN.replace('iconCLASS', cls) + body + '</svg>';
  }

  function render(root) {
    var scope = root || document;
    var placeholders = scope.querySelectorAll('[data-icon]');
    for (var i = 0; i < placeholders.length; i++) {
      var el = placeholders[i];
      var name = el.getAttribute('data-icon');
      var size = el.getAttribute('data-icon-size');
      var extra = el.getAttribute('data-icon-class') || '';
      if (size) {
        extra = (extra ? extra + ' ' : '') + 'icon--' + size;
      }
      var holder = document.createElement('span');
      holder.innerHTML = svg(name, extra);
      var node = holder.firstElementChild;
      if (el.className) {
        node.classList.add.apply(node.classList, el.className.split(/\s+/).filter(Boolean));
      }
      el.parentNode.replaceChild(node, el);
    }
  }

  global.Icons = { svg: svg, render: render, paths: PATHS };
})(window);
