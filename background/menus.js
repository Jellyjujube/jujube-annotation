'use strict';
/**
 * 右键菜单。
 *
 * 这是**跨平台最稳的入口**。原因：macOS 上 Ctrl+点击 = 右键菜单，click 事件
 * 根本不触发；Windows/Linux 上 Ctrl+点击链接又是「在新标签打开」。
 * 右键菜单没有这些冲突，而且 `selectionText` 直接给到了我们需要的值。
 *
 * ## 几个 API 事实（来自 Chromium schema 核查）
 *
 * - `contextMenus.create()` **没有 Promise 版本**，只能用 callback，
 *   并且必须读一次 `runtime.lastError` 否则会出现未检出的错误。
 *   （`update` / `remove` / `removeAll` 从 Chrome 123 起才有 Promise。）
 * - `OnClickData` **有**：`selectionText`（仅在有选区时出现）、`pageUrl`、`frameId`。
 * - `OnClickData` **没有**：`documentUrl` / `documentId` / `modifiers` —— 别写进代码。
 */
(function (HA) {

  var TEXT_PARENT = 'ha-menu-text';
  var TEXT_PREFIX = 'ha-text-';

  /** 建菜单项的小助手：吞掉「ID 已存在」，但把其他错误报出来 */
  function create(props) {
    chrome.contextMenus.create(props, function () {
      var err = chrome.runtime.lastError;
      if (err && !/duplicate id|already exists/i.test(err.message || '')) {
        console.warn('[HA] 创建右键菜单失败：', err.message);
      }
    });
  }

  function buildYes() {
    chrome.contextMenus.removeAll(function () {
      // ---- 文字标注：每个颜色一个子项 ----
      create({
        id: TEXT_PARENT,
        title: HA.I18n.t('menu.annotateSelection'),
        contexts: ['selection'],
      });

      HA.PALETTE.forEach(function (color) {
        create({
          id: TEXT_PREFIX + color.id,
          parentId: TEXT_PARENT,
          title: HA.I18n.t('color.' + color.id),
          contexts: ['selection'],
        });
      });
    });
  }

  /**
   * 重建全部菜单项。
   * 菜单标题要跟随界面语言，所以先取设置再建 —— SW 冷启动时设置可能还没加载。
   */
  function build() {
    if (typeof chrome === 'undefined' || !chrome.contextMenus) return Promise.resolve();

    return HA.getSettings().then(function (settings) {
      HA.I18n.setLocale(HA.I18n.resolve(settings.language));
      buildYes();
    }).catch(function (err) {
      console.warn('[HA] 重建右键菜单失败：', err);
    });
  }

  /**
   * 解析点击的是哪个菜单项。
   * @returns {{color: string}|null}
   */
  function parseMenuItem(menuItemId) {
    var id = String(menuItemId || '');
    if (id.indexOf(TEXT_PREFIX) !== 0) return null;

    var color = id.slice(TEXT_PREFIX.length);
    return HA.getColor(color).id === color ? { color: color } : null;
  }

  /**
   * 注册点击处理器。
   *
   * 注意：service worker 里拿不到 DOM，所以这里**只负责把意图转发给 content script**，
   * 由它去读选区、生成锚点选择器，再回调 Repo 落库。
   * （`contextMenus.create` 的 `onclick` 属性在 SW 里不可用，必须用这个事件。）
   */
  function register(onActivate) {
    chrome.contextMenus.onClicked.addListener(function (info, tab) {
      var action = parseMenuItem(info.menuItemId);
      if (!action || !tab || typeof tab.id !== 'number') return;

      // 只支持顶层 frame —— 我们的 content script 也是 all_frames: false
      if (typeof info.frameId === 'number' && info.frameId !== 0) return;

      onActivate({
        tabId: tab.id,
        color: action.color,
        selectionText: info.selectionText || '',
      });
    });
  }

  HA.Menus = { build: build, register: register, parseMenuItem: parseMenuItem };

})(globalThis.HA || (globalThis.HA = {}));
