'use strict';
/**
 * 选区监听 —— 判断「用户刚刚选中了一段文字」，并按触发模式分派。
 * 选中即高亮要求按住修饰键；工具条模式不要求，选中即弹出色板。
 *
 * ## 三个必须处理的现实问题
 *
 * ### 1. 幽灵选区
 * 页面自己的脚本会创建选区：「复制此段」按钮、编辑器初始化、锚点跳转、`select()`。
 * 而 **`selectionchange` 事件没有 `isTrusted`** —— 它始终是 `false`，
 * 无法用它区分「用户选的」和「脚本选的」。
 *
 * 对策：只有**紧跟一次可信手势**（trusted `mouseup` / `keydown` / `keyup`）
 * 且在手势之后 500ms 内的 `selectionchange` 才算数。
 *
 * ### 2. 修饰键的时序
 * 用户完全可能**先松开 Ctrl、再松开鼠标**。所以不能读事件的 `ctrlKey`
 * —— 那一刻它已经变成 false 了。
 *
 * 对策：用 keydown/keyup 维护一个实时的按键状态机，并额外记住
 * 「手势开始时修饰键是否按着」。判定条件是「现在按着 **或** 开始时按着」，
 * 两种松键顺序都能正确识别。
 *
 * ### 3. 必须在可编辑区域里禁用
 * 否则在输入框里打字会不断触发幽灵高亮，而且锚点会随编辑立刻崩坏。
 */
(function (HA) {

  /** selectionchange 必须落在可信手势之后多少毫秒内才算「用户选的」 */
  var GESTURE_WINDOW = 500;

  /**
   * 事件可信度判定。
   *
   * ⚠️ **这是给测试留的接缝。**
   * 幽灵选区过滤依赖 `event.isTrusted` —— 只有真实用户操作产生的事件才为 true。
   * 但 jsdom 里 `dispatchEvent` 造出的事件 `isTrusted` 恒为 false，
   * 无法覆盖「正常路径」。所以把它抽成一个可替换的函数，
   * 让集成测试能替换掉，从而验证「选中 → 高亮 → 渲染」这条主链路。
   * 生产代码不会调用 setTrustCheck。
   */
  var trustCheck = function (event) { return !!event.isTrusted; };

  var keys = { ctrl: false, meta: false, alt: false };

  var lastTrustedGesture = 0;
  var modifierAtGestureStart = false;
  var started = false;
  var handlers = { onInstant: null, onToolbar: null };
  var settings = null;

  /**
   * 本次手势期间**是否真的发生过选区变化**。
   *
   * ⚠️ 这个标志不能省。`keyup` 是无差别触发的 —— 只要修饰键按着、页面上有选区，
   * 松开**任意一个键**都会走一遍判定。于是「鼠标选中一段文字 → 按 Ctrl+C 复制」
   * 会在 Ctrl+C 的 keyup 时被误判成标注操作（那一刻 ctrlKey 仍为 true），
   * 凭空多出一条标注。Ctrl+X / Ctrl+V / Ctrl+S / Ctrl+F 同理。
   *
   * 加上这个闸门后：只有真正改变过选区的操作（拖选、Shift+方向键、Ctrl+A）
   * 才会通过；Ctrl+C 这类不碰选区的组合键会被挡掉。
   */
  var selectionChanged = false;

  /**
   * 上一次判定过的选区（用 canonical text 上的偏移量表示）。
   *
   * 光有 selectionChanged 还不够，因为**浏览器派发 selectionchange 是异步的** ——
   * 它可能在 mouseup 之后才到，于是判定刚做完、标志又被置位。此时用户按 Ctrl+C，
   * 就会拿那段**早就处理过**的选区再触发一次。
   *
   * 所以再记一个「这段选区我处理过了」：同一段选区只判定一次。
   * 选区被清空（点空白处）时重置，这样重新选中同一段文字仍然有效。
   */
  var lastEvaluatedSignature = null;

  /** 选区的身份标识：canonical text 上的 [start, end)。取不到时返回 null。 */
  function selectionSignature(range) {
    try {
      var index = HA.getTextIndex(HA.defaultRoot());
      var offsets = HA.rangeToOffsets(index, range);
      if (!offsets) return null;
      return offsets.start + '-' + offsets.end;
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 修饰键状态机
   * ------------------------------------------------------------------ */

  function syncKeys(event) {
    keys.ctrl = !!event.ctrlKey;
    keys.meta = !!event.metaKey;
    keys.alt = !!event.altKey;
  }

  function resetKeys() {
    keys.ctrl = keys.meta = keys.alt = false;
  }

  /** 当前修饰键是否按着（用维护的状态，不用事件上的标志位） */
  function modifierHeld() {
    var modifier = HA.resolveModifier(settings);
    switch (modifier) {
      case 'ctrl': return keys.ctrl;
      case 'meta': return keys.meta;
      case 'alt':  return keys.alt;
      case 'none': return true;
      default:     return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 选区有效性
   * ------------------------------------------------------------------ */

  /**
   * 事件目标是否在可编辑区域内（此时不该标注）。
   *
   * 注意循环条件不能写成 `element !== document.body` —— 那样会漏掉
   * **body 自身**就是可编辑的情况。有些笔记/阅读/编辑器类站点用
   * `document.designMode = 'on'` 或把整个 body 设成 contenteditable，
   * 在那类页面上划选会不断触发高亮，而且锚点会随编辑立刻崩坏。
   */
  function isEditableTarget(node) {
    if (!node) return false;

    if (document.designMode === 'on') return true;

    var element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (element) {
      var tag = element.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (element.isContentEditable) return true;
      element = element.parentElement;
    }
    return false;
  }

  /** 选区是否落在我们自己的 UI 里（Shadow DOM 内的浮层） */
  function isOwnUI(node) {
    var element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    while (element) {
      if (element.id === HA.UI_ROOT_ID) return true;
      var root = element.getRootNode && element.getRootNode();
      if (root && root.host && root.host.id === HA.UI_ROOT_ID) return true;
      element = element.parentElement || (element.getRootNode && element.getRootNode().host);
    }
    return false;
  }

  /**
   * 取当前有效的选区 Range。
   * @returns {Range|null} 折叠的、太短的、在可编辑区内的、在我们 UI 里的都返回 null
   */
  function currentRange() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

    var range = selection.getRangeAt(0);
    if (range.collapsed) return null;

    if (isEditableTarget(range.startContainer)) return null;
    if (isOwnUI(range.startContainer)) return null;

    // 必须落在锚定根之内，否则我们没有坐标系来描述它
    var root = HA.defaultRoot();
    if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      return null;
    }

    // 长度阈值：太短的选区多半是误触
    if (range.toString().trim().length < HA.MIN_SELECTION_LEN) return null;

    return range;
  }

  /* ------------------------------------------------------------------ *
   * 事件
   * ------------------------------------------------------------------ */

  function onTrustedGesture(event) {
    if (trustCheck(event)) lastTrustedGesture = Date.now();
  }

  function onMouseDown(event) {
    if (event.button !== 0) return;
    syncKeys(event);
    // ⚠️ 必须在这里登记可信手势，不能只在 mouseup 登记。
    //
    // 拖选过程中浏览器派发的 selectionchange **全部发生在 mousedown 与 mouseup
    // 之间** —— 如果 mousedown 不登记时间戳，这些事件会因为「前面没有可信手势」
    // 被幽灵选区过滤全部挡掉，标志位始终是 false，于是鼠标拖选永远不触发高亮。
    // （只有那次迟到的、在 mouseup 之后到达的异步 selectionchange 能通过，
    //  而它反而会给随后的 Ctrl+C 误开后门。）
    onTrustedGesture(event);
    modifierAtGestureStart = modifierHeld();
  }

  function onMouseUp(event) {
    syncKeys(event);
    if (trustCheck(event)) lastTrustedGesture = Date.now();
    // 松键顺序可能是「先松 Ctrl 再松鼠标」，所以要看整个手势期间是否有按下过
    evaluate(modifierHeld() || modifierAtGestureStart);
    modifierAtGestureStart = false;
  }

  function onKeyDown(event) {
    syncKeys(event);
    onTrustedGesture(event);
  }

  function onKeyUp(event) {
    syncKeys(event);
    onTrustedGesture(event);
    // 键盘选择（Shift+方向键 / Ctrl+A）结束时鼠标没有事件，在这里补一次判断
    evaluate(modifierHeld());
  }

  function onSelectionChange() {
    var selection = window.getSelection();

    // 选区被清空（点了空白处）→ 允许之后重新标注同一段文字
    if (!selection || selection.isCollapsed) {
      lastEvaluatedSignature = null;
      return;
    }

    // 幽灵选区过滤：必须紧跟一次可信手势
    if (Date.now() - lastTrustedGesture > GESTURE_WINDOW) return;

    // 记下「这次手势真的动过选区」，等 mouseup / keyup 再统一判定 ——
    // 拖选过程中会连续触发，不适合在这里直接动作
    selectionChanged = true;
  }

  /**
   * 统一判定入口。
   * @param {boolean} modifierWasHeld
   */
  function evaluate(modifierWasHeld) {
    // 这次手势没有动过选区 → 不是标注操作
    // （挡掉 Ctrl+C / Ctrl+V 这类只按键、不改选区的组合键）
    if (!selectionChanged) return;
    selectionChanged = false;

    var range = currentRange();
    if (!range) return;

    // 同一段选区只处理一次。
    //
    // 这一道是必需的：浏览器派发 selectionchange 是**异步的**，它可能在 mouseup
    // 之后才到，把 selectionChanged 又置回 true。没有这道校验的话，
    // 「选中文字 → 按 Ctrl+C」里那次迟到的 selectionchange 会让 Ctrl+C 的 keyup
    // 误判成标注操作。
    //
    // 注意签名要在「是否有修饰键」判断**之前**记录：不带修饰键的那次选中也要
    // 记下来，否则用户先普通选中、再按住 Ctrl+C 时会拿旧选区触发。
    var signature = selectionSignature(range);
    if (signature !== null && signature === lastEvaluatedSignature) return;
    lastEvaluatedSignature = signature;

    if (!settings) return;
    var mode = settings.triggerMode;
    if (mode === 'off') return;

    // 工具条模式不要求修饰键：选中文字就直接弹色板，由用户点颜色才落库。
    // 选中即高亮会立刻产生高亮，才需要修饰键来避免误触。
    if (mode === 'toolbar') {
      if (handlers.onToolbar) handlers.onToolbar(range);
      return;
    }

    if (!modifierWasHeld) return;
    if (handlers.onInstant) handlers.onInstant(range);
  }

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  function start(options) {
    if (started) return;
    started = true;

    handlers.onInstant = options.onInstant || null;
    handlers.onToolbar = options.onToolbar || null;

    HA.getSettings().then(function (loaded) {
      settings = loaded;
      HA.onSettingsChanged(function (next) { settings = next; });
    });

    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('selectionchange', onSelectionChange, true);

    // 切走标签页/窗口时按键状态会失真，重置掉
    window.addEventListener('blur', resetKeys, true);
  }

  function stop() {
    if (!started) return;
    started = false;
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener('selectionchange', onSelectionChange, true);
    window.removeEventListener('blur', resetKeys, true);
  }

  /** 手动触发一次（工具栏图标 / 快捷键 / 右键菜单走这条） */
  function trigger(range, mode) {
    if (mode === 'toolbar' && handlers.onToolbar) handlers.onToolbar(range);
    else if (handlers.onInstant) handlers.onInstant(range);
  }

  HA.Selection = {
    start: start,
    stop: stop,
    currentRange: currentRange,
    modifierHeld: modifierHeld,
    trigger: trigger,
    isEditableTarget: isEditableTarget,
    /** 仅供测试替换事件可信度判定，见 trustCheck 的注释 */
    setTrustCheck: function (fn) { trustCheck = fn; },
  };

})(globalThis.HA || (globalThis.HA = {}));
