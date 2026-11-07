'use strict';
/**
 * 设置读写。
 *
 * 存在 `chrome.storage.local` 而不是 `sync`：
 * sync 的配额只有 **100 KB 总量 / 单项 8 KB / 512 项 / 1800 次写入每小时**
 * （Chromium `storage.json` 实测值），连一条稍长的标注都放不下，
 * 更不可能用来同步数据。设置也放 local 保持一致。
 *
 * content script **可以直接读写 chrome.storage**（这是 host page 的 web storage
 * 与扩展 storage 的关键区别），所以设置走这条路，不必经 service worker 转发。
 */
(function (HA) {

  var SETTINGS_KEY = 'settings';

  /** 目前生效的设置缓存。content script 高频读取，避免每次都异步查 storage。 */
  var _cache = null;
  var _loading = null;
  var _listeners = [];

  /** 合并默认值 —— 缺失字段用默认值补齐，多余字段丢弃 */
  function withDefaults(stored) {
    var out = {};
    var defaults = HA.DEFAULT_SETTINGS;
    Object.keys(defaults).forEach(function (key) {
      out[key] = (stored && stored[key] !== undefined) ? stored[key] : defaults[key];
    });
    return out;
  }

  function isStorageAvailable() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  /** 读取全部设置（带缓存）。 */
  HA.getSettings = function () {
    if (_cache) return Promise.resolve(_cache);
    if (_loading) return _loading;

    if (!isStorageAvailable()) {
      _cache = withDefaults(null);
      return Promise.resolve(_cache);
    }

    _loading = chrome.storage.local.get(SETTINGS_KEY).then(function (result) {
      _cache = withDefaults(result ? result[SETTINGS_KEY] : null);
      _loading = null;
      return _cache;
    }).catch(function () {
      // 存储不可用（比如受限上下文）时退化到默认值，不要让整个扩展起不来
      _cache = withDefaults(null);
      _loading = null;
      return _cache;
    });

    return _loading;
  };

  /** 同步取缓存值（缓存未就绪时返回默认值）。快捷键路径需要同步判断时用。 */
  HA.getSettingsSync = function () {
    return _cache || withDefaults(null);
  };

  /** 重置为默认值 */
  HA.resetSettings = function () {
    return HA.updateSettings(HA.DEFAULT_SETTINGS);
  };

  function notify(settings) {
    _listeners.forEach(function (fn) {
      try { fn(settings); } catch (e) { /* 单个监听器出错不影响其他 */ }
    });
  }

  /**
   * ⚠️ 这个监听必须在**模块加载时**就注册，不能等到有人调 onSettingsChanged。
   *
   * 因为 onSettingsChanged 是「订阅」接口，只有 content script 会调它。
   * 如果监听挂在里面，那么没订阅的上下文（service worker、侧边栏、管理页）
   * 的 `_cache` 就**永远不会刷新** —— 症状是：在设置页改了默认颜色，
   * 按快捷键标注时用的还是旧颜色；侧边栏的「显示未定位标注」开关改了不生效。
   */
  function watchStorage() {
    if (!isStorageAvailable() || !chrome.storage.onChanged) return;

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      _cache = withDefaults(changes[SETTINGS_KEY].newValue);
      notify(_cache);
    });
  }

  watchStorage();

  /** 写操作的串行队列。
   *  没有它的话，「读 _cache → 合并 → 写」这套流程在快速连续改动时会丢更新：
   *  两次改动都基于同一份旧 current 计算，后写覆盖前写。 */
  var writeChain = Promise.resolve();

  /**
   * 局部更新设置。
   * @param {Object} patch
   * @returns {Promise<Object>} 更新后的完整设置
   */
  HA.updateSettings = function (patch) {
    var run = function () {
      return HA.getSettings().then(function (current) {
        var next = withDefaults(Object.assign({}, current, patch));

        if (!isStorageAvailable()) {
          _cache = next;
          return next;
        }

        var write = {};
        write[SETTINGS_KEY] = next;
        return chrome.storage.local.set(write).then(function () {
          _cache = next;
          notify(next);
          return next;
        });
      });
    };

    // 串行化：后一次改动一定在前一次落盘之后才读 current
    writeChain = writeChain.then(run, run);
    return writeChain;
  };

  /**
   * 订阅设置变化。
   *
   * 只是纯订阅 —— `chrome.storage.onChanged` 的监听已经在模块加载时注册过了
   * （见 watchStorage），所以任何上下文的改动都会更新 `_cache` 并通知这里。
   *
   * @returns {() => void} 取消订阅
   */
  HA.onSettingsChanged = function (callback) {
    _listeners.push(callback);
    return function unsubscribe() {
      var at = _listeners.indexOf(callback);
      if (at !== -1) _listeners.splice(at, 1);
    };
  };

  /**
   * 判断当前平台是不是 macOS。
   *
   * 决定「按住哪个修饰键」才算标注操作。
   *
   * ⚠️ 不要在 macOS 上硬编码 Ctrl：那边 Ctrl 与系统右键手势冲突，
   * 而且 Mac 用户的肌肉记忆本来就是 Cmd。
   */
  HA.isMac = function () {
    if (typeof navigator === 'undefined') return false;
    // userAgentData 是新的标准接口，拿不到再退回已废弃但仍在用的 platform
    if (navigator.userAgentData && navigator.userAgentData.platform) {
      return navigator.userAgentData.platform === 'macOS';
    }
    return /^Mac/i.test(navigator.platform || '');
  };

  /**
   * 根据设置解析出实际要按的修饰键。
   * @returns {'ctrl'|'meta'|'alt'|'none'}
   */
  HA.resolveModifier = function (settings) {
    settings = settings || HA.getSettingsSync();
    var mode = settings.modifier || 'auto';
    if (mode === 'auto') return HA.isMac() ? 'meta' : 'ctrl';
    return mode;
  };

})(globalThis.HA || (globalThis.HA = {}));
