'use strict';
/**
 * 点击路由。
 *
 * ## 为什么必须自己分发点击
 *
 * `::highlight()` 伪元素**不生成盒子、不参与命中测试**（spec 明确规定它是纯 paint 层，
 * 不响应 pointer-events、不能 `:hover`）。所以「点击高亮 → 打开编辑浮层」这件事
 * 没有任何原生支持，只能自己在 capture 阶段拦 `click`。
 *
 * ## 三个决策
 *
 * 1. **capture 阶段**：页面自己的 `<a>` 处理器可能在冒泡阶段吃掉事件，
 *    capture 能先拿到。
 * 2. **遇到可交互元素就让路**：高亮经常跨越链接和按钮的文本。如果无脑拦截，
 *    用户会发现「点了链接没反应」。所以先检查 `composedPath()` 里有没有
 *    链接/按钮/输入框，有就完全不干预。
 * 3. **用 `preventDefault()` 而不是 `stopPropagation()`**：前者只阻止默认行为，
 *    影响面更小；后者会打断页面自己的事件流，容易引发难查的副作用。
 */
(function (HA) {

  var started = false;
  var handlers = {};

  /** 这些元素上的点击交给页面自己处理，我们不抢 */
  var INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    'label', '[role="button"]', '[role="link"]', '[role="checkbox"]',
    '[role="tab"]', '[contenteditable=""]', '[contenteditable="true"]',
    '[onclick]',
  ].join(',');

  function pathContainsInteractive(path) {
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches && node.matches(INTERACTIVE_SELECTOR)) return true;
    }
    return false;
  }

  /** 点是否落在我们自己的 UI 里 */
  function pathHitsOwnUI(path) {
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (node === document || node === window) break;
      if (node && node.nodeType === Node.ELEMENT_NODE && node.id === HA.UI_ROOT_ID) {
        return true;
      }
    }
    return false;
  }

  /** 把某个标注的第一个矩形换算成视口坐标，供浮层定位 */
  function anchorRectFor(annotationId) {
    var entry = HA.Store.get(annotationId);
    if (!entry || !entry.range) return null;

    var rects = HA.Renderer.documentRects(annotationId);
    if (!rects.length) return null;

    var offsetX = window.scrollX || window.pageXOffset || 0;
    var offsetY = window.scrollY || window.pageYOffset || 0;
    var first = rects[0];

    return {
      left: first.left - offsetX,
      top: first.top - offsetY,
      right: first.right - offsetX,
      bottom: first.bottom - offsetY,
      width: first.right - first.left,
      height: first.bottom - first.top,
    };
  }

  /* ------------------------------------------------------------------ *
   * 事件
   * ------------------------------------------------------------------ */

  function onClick(event) {
    // 只处理主键单击
    if (typeof event.button === 'number' && event.button !== 0) return;

    var path = typeof event.composedPath === 'function'
      ? event.composedPath()
      : [event.target];

    // 点在我们自己的 UI 上 —— 交给 UI 自己处理
    if (pathHitsOwnUI(path)) return;

    // 拖动选区后浏览器会在 mouseup 之后补发一次 click。
    // 那时工具条刚弹出、页面上还没有高亮，下面的逻辑会把它当成「点到空白处」关掉，
    // 表现就是工具条一闪而过。这个窗口期内直接忽略这次收尾 click。
    if (HA.UI.toolbarJustOpened && HA.UI.toolbarJustOpened()) return;

    var hitId = HA.HitTest.at(event.clientX, event.clientY);

    if (!hitId) {
      // 点到空白处：关掉浮层
      if (HA.UI.isOpen()) HA.UI.hideAll();
      return;
    }

    // 高亮跨在链接/按钮上时让路，否则用户会觉得「链接点不动」
    if (pathContainsInteractive(path)) {
      if (HA.UI.isOpen()) HA.UI.hideAll();
      return;
    }

    event.preventDefault();
    if (handlers.onEdit) {
      var rect = anchorRectFor(hitId) || {
        left: event.clientX, top: event.clientY,
        right: event.clientX, bottom: event.clientY,
        width: 0, height: 0,
      };
      handlers.onEdit(hitId, rect);
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && HA.UI.isOpen()) {
      HA.UI.hideAll();
    }
  }

  function start(options) {
    if (started) return;
    started = true;
    handlers = options || {};

    // capture 阶段，抢在页面自己的处理器之前
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function stop() {
    if (!started) return;
    started = false;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  HA.ClickRouter = {
    start: start,
    stop: stop,
    anchorRectFor: anchorRectFor,
    pathContainsInteractive: pathContainsInteractive,
  };

})(globalThis.HA || (globalThis.HA = {}));
