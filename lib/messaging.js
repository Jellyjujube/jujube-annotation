'use strict';
/**
 * 消息层 —— content script 与 service worker 之间的唯一通道。
 *
 * ## 为什么必须有这一层
 *
 * content script 里的 IndexedDB 属于**宿主页面**（官方文档原文："In content scripts,
 * calling web storage APIs accesses data from the host page the content script is
 * injected on and not the extension."），所以它不能直接读写扩展的数据。
 * 所有读写都要经 chrome.runtime.sendMessage 让 service worker 代办。
 *
 * ## 四个必须处理的坑（都有官方依据）
 *
 * 1. **没有接收端时会 reject**（受限页面必然发生，如 chrome://、Web Store、
 *    内置 PDF 阅读器）→ 必须 try/catch，否则是未捕获的 Promise rejection。
 *    错误串出自 Chromium 源码：`Could not establish connection. Receiving end
 *    does not exist.`
 * 2. **异步响应必须 `return true`**。官方原文："returning a literal `true`
 *    (not just a truthy value) … will keep the message channel open"。
 *    同步 `return 值` 是无效的，必须调 sendResponse。
 * 3. **listener 必须顶层同步注册**。官方原文："Registering a listener
 *    asynchronously (for example inside a promise or callback) is not guaranteed
 *    to work in Manifest V3 … move the event listener registration to the top
 *    level of your script." 否则 SW 冷启动时首条消息会被丢弃。
 * 4. **消息只能传纯数据**（JSON/结构化克隆），不能传 Range / Node / DOM 对象。
 *    这也是锚点必须存成 WADM 纯数据选择器的又一个理由。
 *
 * 另外：**不要用 async 函数当 listener**。官方明确指出 async listener 总是返回
 * Promise，如果没有显式返回值，其 promise 会 resolve 成 undefined，
 * 于是「null 被当作响应发回去」。这里统一用同步函数 + 显式 return true。
 */
(function (HA) {

  /** 消息信封标记，用来过滤掉不是发给我们的消息 */
  var ENVELOPE = '__ha_message__';

  /** 收不到接收端时的专用错误。调用方按 `err.code === 'no-receiver'` 判断并静默降级。 */
  function NoReceiverError(detail) {
    var err = new Error('没有接收端：' + detail);
    err.name = 'HANoReceiverError';
    err.code = 'no-receiver';
    return err;
  }

  /** 扩展更新后，页面里仍在运行旧版脚本。调用方按 `err.code === 'protocol-mismatch'` 判断。 */
  function ProtocolMismatchError() {
    var err = new Error('扩展已更新，页面里运行的是旧版脚本，请刷新页面');
    err.name = 'HAProtocolMismatchError';
    err.code = 'protocol-mismatch';
    return err;
  }

  /** 从 Chromium 的错误串判断是否「没有接收端」 */
  function isNoReceiverMessage(text) {
    return /Receiving end does not exist|Could not establish connection|message channel closed/i
      .test(text || '');
  }

  function wrap(payload) {
    return { [ENVELOPE]: true, v: HA.PROTOCOL_VERSION, payload: payload };
  }

  /** 把响应解包成值，失败就抛 */
  function unwrap(response) {
    if (!response) {
      throw new Error('收到的响应是空的');
    }
    if (response.code === 'protocol-mismatch') throw ProtocolMismatchError();
    if (response.ok === false) throw new Error(response.error || '未知错误');
    return response.value;
  }

  /* ------------------------------------------------------------------ *
   * 发送
   * ------------------------------------------------------------------ */

  /** 发给 service worker。会主动把「无接收端」转成带 code 的错误。 */
  HA.sendToBackground = function (payload) {
    return chrome.runtime.sendMessage(wrap(payload)).catch(function (err) {
      if (isNoReceiverMessage(err && err.message)) {
        throw NoReceiverError('service worker 未就绪或页面不支持扩展');
      }
      throw err;
    }).then(unwrap);
  };

  /** 发给指定标签页的 content script。
   *  这是**请求/响应**语义：content script 必须回一个 {ok, value}。 */
  HA.sendToTab = function (tabId, payload) {
    return chrome.tabs.sendMessage(tabId, wrap(payload)).catch(function (err) {
      if (isNoReceiverMessage(err && err.message)) {
        throw NoReceiverError('标签页 ' + tabId + ' 里没有 content script');
      }
      throw err;
    }).then(unwrap);
  };

  /**
   * 单向通知某个标签页 —— **不等响应**，失败静默。
   *
   * 与 sendToTab 的区别：这是「顺手告诉它一声」的场景（标注变了 / 路由变了），
   * 对方不需要回值，而且对方可能压根不存在（受限页面、已关闭的标签页），
   * 那是正常情况而不是错误。
   *
   * @returns {Promise<boolean>} 是否送达
   */
  HA.notifyTab = function (tabId, payload) {
    return chrome.tabs.sendMessage(tabId, wrap(payload))
      .then(function () { return true; })
      .catch(function () { return false; });
  };

  /* ------------------------------------------------------------------ *
   * 接收
   * ------------------------------------------------------------------ */

  /**
   * 注册消息处理器。
   *
   * @param {(payload: any, sender: chrome.runtime.MessageSender)
   *          => any | Promise<any>} handler
   *        返回值会被原样送回；抛出的异常会变成发送方的 rejection。
   *        返回 Promise 时本函数会自动处理 return true。
   * @param {{ onProtocolMismatch?: () => void }} [options]
   *        收到版本不匹配的消息时回调（发送方是旧版）。仅 SW 用得上。
   */
  HA.registerHandler = function (handler, options) {
    options = options || {};

    // 同步注册 —— 这是硬要求，不能挪进 async 里
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message[ENVELOPE] !== true) {
        // 不是我们的消息，交还给别的监听器
        return undefined;
      }

      // 版本协商：老标签页里跑着旧版 content script
      if (message.v !== HA.PROTOCOL_VERSION) {
        if (options.onProtocolMismatch) {
          try { options.onProtocolMismatch(sender, message.v); } catch (e) { /* 忽略 */ }
        }
        sendResponse({ ok: false, code: 'protocol-mismatch' });
        return true;
      }

      var result;
      try {
        result = handler(message.payload, sender);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
        return true;
      }

      if (result && typeof result.then === 'function') {
        result.then(function (value) {
          sendResponse({ ok: true, value: value });
        }, function (err) {
          sendResponse({ ok: false, error: String(err && err.message || err) });
        });
        return true;      // 必须是字面量 true，保持通道打开
      }

      sendResponse({ ok: true, value: result });
      return true;
    });
  };

  /**
   * 注册**单向通知**处理器（content script / 扩展页面侧）。
   *
   * 与 registerHandler 的区别：这里不构造 {ok, value} 响应，纯粹接收。
   * 对方用 HA.notifyTab() 发送时不等待响应，所以这里也不必 sendResponse。
   *
   * @param {(payload: any, sender) => void} handler
   */
  HA.registerNotifications = function (handler) {
    chrome.runtime.onMessage.addListener(function (message, sender) {
      if (!message || message[ENVELOPE] !== true) return undefined;
      // 版本不匹配的通知直接丢弃：老页面里的旧脚本不该被新 SW 的消息驱动
      if (message.v !== HA.PROTOCOL_VERSION) return undefined;
      try {
        handler(message.payload, sender);
      } catch (err) {
        console.warn('[HA] 处理通知时出错：', err);
      }
      return undefined;      // 不保持通道，不回响应
    });
  };

  /* ------------------------------------------------------------------ *
   * 便捷封装：content script 侧常用的几个调用
   * ------------------------------------------------------------------ */

  HA.api = {
    /** 一次性拉取本页全部标注（避免每条一次往返造成闪烁） */
    getForUrl: function (urlKey) {
      return HA.sendToBackground({ type: HA.MSG.GET_FOR_URL, urlKey: urlKey });
    },

    create: function (record) {
      return HA.sendToBackground({ type: HA.MSG.CREATE, record: record });
    },

    update: function (id, patch) {
      return HA.sendToBackground({ type: HA.MSG.UPDATE, id: id, patch: patch });
    },

    remove: function (id) {
      return HA.sendToBackground({ type: HA.MSG.DELETE, id: id });
    },

    ping: function () {
      return HA.sendToBackground({ type: HA.MSG.PING });
    },
  };

})(globalThis.HA || (globalThis.HA = {}));
