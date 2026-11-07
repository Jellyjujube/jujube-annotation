'use strict';
/**
 * 命中测试 —— 判断鼠标底下是哪条标注。
 *
 * ## 为什么不用 CSS.highlights.highlightsFromPoint()
 *
 * 那个 API 确实存在（Chrome 140+），但 Blink 实现里有一行是决定性的：
 *
 *     if (!hit_node->IsTextNode()) return {};
 *
 * 后果是：因为只认文本节点，**点在行与行之间的空隙会返回 `[]`** ——
 * 而我们的高亮是背景色色带，用户恰恰会点在那些空隙上。
 * 另外点进未通过 shadowRoots 传入的 shadow tree 会**整体返回 `[]`**。
 *
 * ## 改用缓存矩形
 *
 * 把每条标注的矩形算一次、换算成**文档坐标**（加 scrollX/scrollY），之后命中测试
 * 就是纯内存的矩形比较：
 *
 *   - 换算成文档坐标后，**滚动不需要失效缓存**（这是关键）
 *   - 只在 resize / 缩放 / DOM 变化时重建
 *   - pointermove 里**不做任何 layout 读取**，因此不会强制 reflow
 *
 * 这比 highlightsFromPoint 更快，而且能覆盖行间空隙（用户常常点在那里）。
 *
 * PAD 的垂直外扩是为了覆盖行间空隙：不加外扩，点在两行之间就点不中。
 */
(function (HA) {

  /** 矩形上下外扩的像素。行高通常 ≥20px，4px 不会让相邻高亮的热点重叠。 */
  var PAD_Y = 4;

  /** 水平方向也稍微外扩，方便点中行首行尾 */
  var PAD_X = 2;

  var cache = [];          // [{id, kind, rects: [{left,top,right,bottom}]}]
  var dirty = true;        // 缓存是否失效
  var rebuilding = false;

  /** 标记缓存失效。DOM 变化、resize、缩放后都应调用。 */
  function invalidate() {
    dirty = true;
  }

  /** 重建缓存（按需、惰性） */
  function ensureCache() {
    if (!dirty || rebuilding) return;
    rebuilding = true;

    var next = [];
    HA.Store.list().forEach(function (entry) {
      if (!entry.range) return;
      var rects = HA.Renderer.documentRects(entry.annotation.id);
      if (rects && rects.length) {
        next.push({ id: entry.annotation.id, rects: rects });
      }
    });

    cache = next;
    dirty = false;
    rebuilding = false;
  }

  /**
   * 查某个客户端坐标下是哪条标注。
   *
   * @param {number} clientX
   * @param {number} clientY
   * @returns {string|null} annotationId；没有命中返回 null
   */
  function at(clientX, clientY) {
    ensureCache();

    var x = clientX + (window.scrollX || window.pageXOffset || 0);
    var y = clientY + (window.scrollY || window.pageYOffset || 0);

    var best = null;
    var bestArea = Infinity;

    for (var i = 0; i < cache.length; i++) {
      var item = cache[i];
      for (var j = 0; j < item.rects.length; j++) {
        var rect = item.rects[j];
        if (x < rect.left - PAD_X || x > rect.right + PAD_X) continue;
        if (y < rect.top - PAD_Y || y > rect.bottom + PAD_Y) continue;

        // 命中多个时取**面积最小**的那个 —— 重叠场景下短词比整段更具体，
        // 用户的意图更可能是它
        var area = (rect.right - rect.left) * (rect.bottom - rect.top);
        if (area < bestArea) {
          bestArea = area;
          best = item.id;
        }
        break;
      }
    }

    return best;
  }

  /** 当前缓存里的条目数（调试用） */
  function size() {
    ensureCache();
    return cache.length;
  }

  /* ------------------------------------------------------------------ *
   * 悬停监听
   * ------------------------------------------------------------------ */

  var rafPending = false;
  var lastHovered = null;
  var hoverCallback = null;
  var pointerBound = false;

  function onPointerMove(event) {
    // rAF 节流：同一帧内只处理一次，避免高频 mousemove 反复命中测试
    if (rafPending) return;
    rafPending = true;

    var x = event.clientX;
    var y = event.clientY;

    requestAnimationFrame(function () {
      rafPending = false;
      var hit = at(x, y);
      if (hit === lastHovered) return;
      lastHovered = hit;
      if (hoverCallback) hoverCallback(hit);
    });
  }

  /** 开始监听悬停。onHover(hitId|null) 在命中的标注发生变化时调用。 */
  function startHover(onHover) {
    hoverCallback = onHover;
    if (pointerBound) return;

    document.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
    pointerBound = true;
  }

  function stopHover() {
    if (!pointerBound) return;
    document.removeEventListener('pointermove', onPointerMove, { capture: true });
    pointerBound = false;
    lastHovered = null;
  }

  /** 取当前悬停命中的标注 id */
  function hovered() {
    return lastHovered;
  }

  HA.HitTest = {
    invalidate: invalidate,
    at: at,
    size: size,
    startHover: startHover,
    stopHover: stopHover,
    hovered: hovered,
  };

})(globalThis.HA || (globalThis.HA = {}));
