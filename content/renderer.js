'use strict';
/**
 * 渲染层 —— 用 CSS Custom Highlight API 把标注画到页面上。
 *
 * ## 为什么用 Highlight API 而不是往 DOM 里插 <mark>
 *
 * 不修改页面 DOM，因此不会触发 React/Vue 的重渲染与水合不匹配，不引起布局抖动。
 * 更实际的好处是绕开了一堆补丁：往 DOM 里插元素必须额外处理
 * 「跳过纯空白文本节点」「避免插进 `<tr>` / `<ul>` 等受限容器」等情形。
 *
 * ## 三条来自源码核查的约束
 *
 * 1. **必须用 StaticRange。** 规范原文：live `Range` 的边界会「adjust in response
 *    to DOM changes」（跟着编辑**漂移**），而 StaticRange「must not adjust」。
 *    规范还明确推荐动态文档用 StaticRange（"strongly encouraged"）。
 *    漂移是危险的：高亮悄悄跑到别处，用户不知道；StaticRange 则是失效即消失，
 *    会被我们的重锚定接住，行为可预测。
 *
 * 2. **highlight 名与页面主世界共享。** `HighlightRegistry` 是每个 LocalDOMWindow
 *    一个 Supplement，隔离世界与主世界拿到的是**同一个实例**。
 *    `set()` 用已存在的名字不报错，而是 Map 语义覆盖 —— 且旧 Highlight 会被
 *    解除注册，即**页面原本的高亮直接消失**。反方向同理。
 *    所以名字必须带足够独特的前缀，且**没有任何 API 能检测冲突**，只能靠命名规避。
 *
 * 3. **`priority` 是整数**（WebIDL `long`），给小数会被截断。
 *
 * ## 颜色由 CSS 决定，不由注册决定
 *
 * 注册只决定「名字 → range 集合」的映射；颜色来自 `::highlight()` 规则。
 * 所以明暗主题切换是**纯 CSS 媒体查询**行为，不需要 JS 重新注册 ——
 * 没有中间状态，不会闪。
 */
(function (HA) {

  /** 高亮名字前缀。带上扩展身份以避免与页面自己的 highlight 撞名。 */
  var NAME_PREFIX = 'ha-';

  /** 活动标注（正在编辑/悬停的那条）用独立的高 priority highlight */
  var ACTIVE_NAME = NAME_PREFIX + 'active';
  var ACTIVE_PRIORITY = 100;

  /** styles/highlight.css 里已经内置了规则的颜色，不需要动态注入 */
  var BUILTIN_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'orange'];

  var supported = typeof CSS !== 'undefined'
    && CSS.highlights
    && typeof Highlight === 'function'
    && typeof StaticRange === 'function';

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  var byColor = new Map();            // colorId → Highlight
  var rangesById = new Map();         // annotationId → StaticRange[]
  var activeHighlight = null;
  var dynamicStyleEl = null;
  var darkQuery = null;

  /* ------------------------------------------------------------------ *
   * 颜色
   * ------------------------------------------------------------------ */

  function normalizeColorId(colorId) {
    var color = HA.getColor(colorId);
    return color ? color.id : HA.PALETTE[0].id;
  }

  function isDark() {
    return !!(darkQuery && darkQuery.matches);
  }

  /** 取颜色的实际 CSS 值（需要真实色值的场景用） */
  function colorValue(colorId) {
    var color = HA.getColor(colorId);
    return isDark() ? color.dark : color.light;
  }

  /**
   * 为内置列表之外的自定义颜色补注入 `::highlight()` 规则。
   *
   * 内置颜色写在 styles/highlight.css 里（走 manifest 注入，最稳）。
   * 只有用户自定义的额外颜色才需要动态注入。
   */
  function ensureColorStyles() {
    var custom = HA.PALETTE.filter(function (c) {
      return BUILTIN_COLORS.indexOf(c.id) === -1;
    });

    if (!custom.length) {
      if (dynamicStyleEl && dynamicStyleEl.parentNode) {
        dynamicStyleEl.parentNode.removeChild(dynamicStyleEl);
        dynamicStyleEl = null;
      }
      return;
    }

    var rules = custom.map(function (c) {
      return '::highlight(' + NAME_PREFIX + c.id + '){background-color:' + c.light + ';color:#1a1a1a;}';
    }).join('\n') + '\n@media (prefers-color-scheme: dark){\n' + custom.map(function (c) {
      return '  ::highlight(' + NAME_PREFIX + c.id + '){background-color:' + c.dark + ';color:inherit;}';
    }).join('\n') + '\n}';

    if (!dynamicStyleEl) {
      dynamicStyleEl = document.createElement('style');
      dynamicStyleEl.setAttribute('data-ha', 'dynamic-colors');
      (document.head || document.documentElement).appendChild(dynamicStyleEl);
    }
    if (dynamicStyleEl.textContent !== rules) {
      dynamicStyleEl.textContent = rules;
    }
  }

  /* ------------------------------------------------------------------ *
   * Highlight 注册表
   * ------------------------------------------------------------------ */

  function getHighlight(colorId) {
    var name = NAME_PREFIX + colorId;
    var existing = byColor.get(colorId);
    if (existing) return existing;

    var highlight = new Highlight();
    highlight.priority = 0;
    CSS.highlights.set(name, highlight);
    byColor.set(colorId, highlight);
    return highlight;
  }

  function ensureActiveHighlight() {
    if (activeHighlight) return activeHighlight;
    activeHighlight = new Highlight();
    activeHighlight.priority = ACTIVE_PRIORITY;   // 必须是整数
    CSS.highlights.set(ACTIVE_NAME, activeHighlight);
    return activeHighlight;
  }

  /* ------------------------------------------------------------------ *
   * Range 转换
   * ------------------------------------------------------------------ */

  /**
   * live Range → StaticRange。
   * StaticRange 要求容器节点仍在文档中，脱离的节点建不出来。
   */
  function toStaticRange(range) {
    if (!range) return null;
    if (!range.startContainer || !range.endContainer) return null;
    if (!range.startContainer.isConnected || !range.endContainer.isConnected) return null;

    try {
      return new StaticRange({
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
      });
    } catch (err) {
      return null;
    }
  }

  /**
   * StaticRange → 一个临时的 live Range。
   *
   * 用途：StaticRange 没有 `getClientRects()`（那是 Range / Element 的方法），
   * 所以命中测试需要的矩形必须通过临时 Range 来取。
   * 只在缓存重建时调用，不在 mousemove 里调用（见 hit-test.js）。
   */
  function toLiveRange(staticRange) {
    var range = document.createRange();
    try {
      range.setStart(staticRange.startContainer, staticRange.startOffset);
      range.setEnd(staticRange.endContainer, staticRange.endOffset);
    } catch (err) {
      return null;
    }
    return range;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  /** 重建全部高亮 */
  function renderAll() {
    if (!supported) return;

    ensureColorStyles();
    byColor.forEach(function (highlight) { highlight.clear(); });
    rangesById.clear();

    HA.Store.list().forEach(function (entry) {
      if (!entry.range) return;

      var staticRange = toStaticRange(entry.range);
      if (!staticRange) return;

      var colorId = normalizeColorId(entry.annotation.color);
      getHighlight(colorId).add(staticRange);
      rangesById.set(entry.annotation.id, [staticRange]);
    });
  }

  /** 标记某条为「活动」——用高 priority 的独立 highlight 叠加下划线 */
  function setActive(annotationId) {
    if (!supported) return;
    var highlight = ensureActiveHighlight();
    highlight.clear();

    if (!annotationId) return;
    var ranges = rangesById.get(annotationId);
    if (!ranges || !ranges.length) return;

    ranges.forEach(function (range) { highlight.add(range); });
  }

  /* ------------------------------------------------------------------ *
   * 取矩形（供命中测试）
   * ------------------------------------------------------------------ */

  /**
   * 取某条标注在**文档坐标**下的矩形列表。
   *
   * 换算成文档坐标（加 scrollX/scrollY）是关键：根滚动容器滚动时不需要失效，
   * 只在 resize / 缩放 / DOM 变化 / 内层容器滚动时才重建缓存。
   * 这比每次 mousemove 都读 layout 快得多，也不会强制 reflow。
   *
   * @returns {Array<{left:number, top:number, right:number, bottom:number}>}
   */
  function documentRects(annotationId) {
    var ranges = rangesById.get(annotationId);
    if (!ranges || !ranges.length) return [];

    var offsetX = window.scrollX || window.pageXOffset || 0;
    var offsetY = window.scrollY || window.pageYOffset || 0;
    var out = [];

    ranges.forEach(function (staticRange) {
      var live = toLiveRange(staticRange);
      if (!live || typeof live.getClientRects !== 'function') return;

      var rects = live.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var rect = rects[i];
        if (rect.width <= 0 && rect.height <= 0) continue;   // 空行产生的零尺寸矩形
        out.push({
          left: rect.left + offsetX,
          top: rect.top + offsetY,
          right: rect.right + offsetX,
          bottom: rect.bottom + offsetY,
        });
      }
    });

    return out;
  }

  /** 把某条标注滚进视口并闪一下 */
  function scrollToAnnotation(annotationId) {
    var entry = HA.Store.get(annotationId);
    if (!entry || !entry.range) return false;

    var target = entry.range.startContainer;
    if (target && target.nodeType === Node.TEXT_NODE) target = target.parentNode;
    if (!target || !target.isConnected) return false;

    try {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (err) {
      target.scrollIntoView();
    }

    // 闪一下，方便在长页面里找到
    if (target.classList) {
      target.classList.add('ha-flash-target');
      setTimeout(function () {
        target.classList.remove('ha-flash-target');
      }, 1200);
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function start() {
    if (!supported) {
      console.warn('[HA] 当前浏览器不支持 CSS Custom Highlight API，' +
        '高亮无法渲染。需要 Chrome 105 或更高版本。');
      return;
    }

    ensureActiveHighlight();

    // 主题切换由 CSS 媒体查询处理，不需要重新注册 highlight。
    // 这里只是记录一下当前的明暗状态，供 colorValue() 使用。
    if (window.matchMedia) {
      darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
      var onThemeChange = function () { /* 颜色走 CSS，这里无需动作 */ };
      if (darkQuery.addEventListener) darkQuery.addEventListener('change', onThemeChange);
      else if (darkQuery.addListener) darkQuery.addListener(onThemeChange);
    }
  }

  HA.Renderer = {
    supported: supported,
    start: start,
    renderAll: renderAll,
    setActive: setActive,
    documentRects: documentRects,
    scrollToAnnotation: scrollToAnnotation,
    colorValue: colorValue,
    normalizeColorId: normalizeColorId,
    ACTIVE_NAME: ACTIVE_NAME,
  };

})(globalThis.HA || (globalThis.HA = {}));
