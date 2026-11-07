'use strict';
/**
 * Service Worker —— 扩展的中枢。
 *
 * ## 三条不可违反的纪律
 *
 * 1. **所有 listener 必须在本文件的顶层同步注册。** 官方原文："Registering a
 *    listener asynchronously (for example inside a promise or callback) is not
 *    guaranteed to work in Manifest V3 … move the event listener registration to
 *    the top level of your script." 违反这条会导致 SW 冷启动时首条消息被丢弃，
 *    症状是「有时候高亮不出来，刷新一下就好了」。
 * 2. **内存里不放「唯一真相」。** SW 空闲 **30 秒**就会被杀（Chrome 110 起
 *    任何扩展 API 调用会重置计时器）；「5 分钟」是单次请求处理的上限，
 *    硬性 5 分钟总寿命已在 Chrome 110 移除。所有状态随时能从 IndexedDB 重建。
 * 3. **这里没有 DOM，也没有 `URL.createObjectURL`。** 后者在 SW 里根本不存在
 *    （Blink IDL 的 Exposed 白名单是 `Window,DedicatedWorker,SharedWorker`，
 *    不含 `ServiceWorker`）。所以所有 DOM 操作（含高亮渲染）都在 content script，
 *    所有需要 objectURL 的操作（含导出）都在扩展页面。
 *
 * ## 加载方式
 *
 * 用 `importScripts()` 而不是 ES module —— manifest 里没有 `"type": "module"`，
 * 因此这是经典 worker，可以用 importScripts。反过来，如果声明成 module worker，
 * 就**不能**用 importScripts，而且 SW 里**动态 `import()` 也不支持**。
 * 这样 lib/ 下的经典脚本可以被 SW、content script、扩展页面三处共用。
 */

importScripts(
  '../lib/constants.js',
  '../lib/i18n.js',
  '../lib/url.js',
  '../lib/schema.js',
  '../lib/model.js',
  '../lib/db.js',
  '../lib/settings.js',
  '../lib/messaging.js',
  './repo.js',
  './menus.js'
);

(function (HA) {

  /* ================================================================== *
   * 初始化
   * ================================================================== */

  /** 让工具栏图标点击直接开侧边栏。
   *  不要去写 `action.onClicked` + `sidePanel.open()` —— 后者必须在用户手势中
   *  调用，手势窗口极短，很容易失败。setPanelBehavior 是 upsert 语义，可重复调用。 */
  function configureSidePanel() {
    if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(function (err) {
        console.warn('[HA] 设置侧边栏行为失败：', err && err.message);
      });
  }

  function configureBadge() {
    if (!chrome.action || !chrome.action.setBadgeBackgroundColor) return;
    chrome.action.setBadgeBackgroundColor({ color: '#3b4252' }).catch(function () {});
  }

  /** 申请持久化存储。
   *  配合 manifest 里的 unlimitedStorage 权限，可以同时免除配额限制与
   *  磁盘紧张时的淘汰 —— 这是「关浏览器、重启电脑都不会丢数据」的技术依据。 */
  function requestPersistentStorage() {
    if (typeof navigator === 'undefined' || !navigator.storage
        || typeof navigator.storage.persist !== 'function') return;
    navigator.storage.persist().then(function (granted) {
      if (!granted) {
        console.info('[HA] 浏览器未授予持久存储；已申请 unlimitedStorage 权限作为兜底。');
      }
    }).catch(function () {});
  }

  // 顶层同步注册 —— 见文件头纪律 1
  chrome.runtime.onInstalled.addListener(function (details) {
    HA.Menus.build();
    configureSidePanel();
    configureBadge();
    if (details.reason === 'install') requestPersistentStorage();
  });

  chrome.runtime.onStartup.addListener(function () {
    // 菜单在浏览器重启后需要重建（调色板可能改过）
    HA.Menus.build();
    configureSidePanel();
    configureBadge();
  });

  // 顶层也调一次：SW 可能在浏览器重启后被首次唤醒，而 onStartup 不一定先到
  configureSidePanel();
  configureBadge();

  /* ================================================================== *
   * 消息路由
   * ================================================================== */

  /**
   * 标签页 → 本页真正使用的 urlKey。
   *
   * 由 content script 上报，因为页面可能声明了 `<link rel=canonical>`，
   * 那时 urlKey 与地址栏 URL 不是一回事，而 SW 没有 DOM 算不出来 ——
   * 不修的话工具栏徽标会用地址栏 URL 去数，在那些页面上恒显示为空。
   *
   * 这是**短期缓存**：丢了就退回按地址栏 URL 算。不违反「内存不放唯一真相」，
   * 因为丢了只是徽标数字不准，不影响任何数据。
   */
  var tabPageKeys = new Map();

  HA.registerHandler(function (payload, sender) {
    if (!payload || !payload.type) throw new Error('消息缺少 type');

    var tabId = sender && sender.tab ? sender.tab.id : null;

    switch (payload.type) {
      case HA.MSG.PING:
        return { version: chrome.runtime.getManifest().version };

      case HA.MSG.REPORT_PAGE:
        if (tabId !== null && payload.urlKey) {
          tabPageKeys.set(tabId, payload.urlKey);
          HA.Repo.refreshBadgeForTab(tabId, payload.urlKey);
        }
        return true;

      case HA.MSG.BROADCAST:
        // 扩展页面（管理页/侧边栏/设置页）直连 IndexedDB，绕过了 Repo，
        // 所以它们改完数据要主动喊一声，让各标签页与其它扩展页面同步。
        HA.Repo.broadcastChange(payload.change || {});
        if (tabId !== null) HA.Repo.refreshBadgeForTab(tabId);
        return true;

      case HA.MSG.GET_FOR_URL:
        if (!payload.urlKey) throw new Error('缺少 urlKey');
        return HA.Repo.getForUrl(payload.urlKey);

      case HA.MSG.CREATE:
        return HA.Repo.create(payload.record).then(function (annotation) {
          if (tabId !== null) HA.Repo.refreshBadgeForTab(tabId, annotation.urlKey);
          return annotation;
        });

      case HA.MSG.UPDATE:
        return HA.Repo.update(payload.id, payload.patch).then(function (updated) {
          if (tabId !== null) HA.Repo.refreshBadgeForTab(tabId, updated.urlKey);
          return updated;
        });

      case HA.MSG.DELETE:
        return HA.Repo.remove(payload.id).then(function () {
          if (tabId !== null) {
            HA.Repo.refreshBadgeForTab(tabId, tabPageKeys.get(tabId));
          }
          return true;
        });

      default:
        throw new Error('未知消息类型：' + payload.type);
    }
  }, {
    onProtocolMismatch: function (sender, theirVersion) {
      // 老标签页里跑的还是旧版 content script（扩展刚更新过）。
      // 无法强行替换，只能提示；content script 收到 protocol-mismatch 后
      // 会自行停用并提示用户刷新。
      console.warn('[HA] 协议版本不匹配：页面里的脚本是 v' + theirVersion
        + '，当前扩展是 v' + HA.PROTOCOL_VERSION + '。请刷新页面。');
    },
  });

  /* ================================================================== *
   * 右键菜单 → 转发给 content script
   * ================================================================== */

  /**
   * 让内容脚本去执行标注动作。
   *
   * 这里只转发意图：SW 里没有 DOM，读不了选区。
   * content script 收到后自己读选区、生成选择器、再回调 Repo 落库。
   */
  function activateOnTab(tabId, options) {
    HA.notifyTab(tabId, {
      type: HA.MSG.HIGHLIGHT_SELECTION,
      color: options.color,
      // 选区文本只作提示，content script 会以自己读到的选区为准
      selectionText: options.selectionText || '',
    });
  }

  // 界面语言变了 → 菜单标题需要跟着重建
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.settings) return;
      HA.Menus.build();
    });
  }

  HA.Menus.register(function (request) {
    activateOnTab(request.tabId, {
      color: request.color,
      selectionText: request.selectionText,
    });
  });

  /* ================================================================== *
   * SPA 路由变化
   * ================================================================== */

  /**
   * ⚠️ 路由监听放在 SW 里用 webNavigation 事件，再转发给 content script。
   *
   * 不在 content script 里 monkey-patch `history.pushState`：content script
   * 运行在 isolated world，改 `window.history` 影响不到页面主世界的调用。
   * content script 侧监听 `popstate` 作为补充（DOM 事件可跨 world 收到）。
   */
  if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
      // 只关心顶层 frame
      if (details.frameId !== 0) return;

      // URL 变了 → 之前上报的 urlKey 作废，content script 重新加载后会再报一次
      tabPageKeys.delete(details.tabId);

      HA.notifyTab(details.tabId, {
        type: HA.MSG.ROUTE_CHANGED,
        url: details.url,
      });

      HA.Repo.refreshBadgeForTab(details.tabId);
    });
  }

  /* ================================================================== *
   * 徽标维护
   * ================================================================== */

  chrome.tabs.onActivated.addListener(function (activeInfo) {
    HA.Repo.refreshBadgeForTab(activeInfo.tabId, tabPageKeys.get(activeInfo.tabId));
  });

  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    // 只在「加载完成」或「URL 变了」时更新，避免高频抖动
    if (changeInfo.status === 'complete' || changeInfo.url) {
      // URL 变了，之前上报的 urlKey 就作废了
      if (changeInfo.url) tabPageKeys.delete(tabId);
      if (tab && tab.url) {
        HA.Repo.refreshBadgeForTab(tabId, tabPageKeys.get(tabId));
      }
    }
  });

  if (chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener(function (tabId) {
      tabPageKeys.delete(tabId);      // 不清理的话这张表会随浏览无限增长
    });
  }

})(globalThis.HA || (globalThis.HA = {}));
