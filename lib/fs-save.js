'use strict';
/**
 * 保存文件到用户指定的位置。
 *
 * ## 时序约束（这条不遵守就会随机失败）
 *
 * `showSaveFilePicker()` 需要**瞬时用户激活**（transient activation），
 * 而 2025 年起 Chromium 让 picker **消费**掉这次激活
 * （`ChooseEntries()` 里 `UpdateUserActivationState(kConsumeTransientActivation)`，
 * crbug 40059071）。加上激活本身只有约 5 秒寿命
 * （`kActivationLifespan = base::Seconds(5)`）。
 *
 * 实务后果：
 *   - **一次手势基本只能成功弹一次 picker**
 *   - picker 之后再调 `requestPermission()` 也**不再持有激活**
 *
 * 所以正确写法是：**点击处理器里第一件事就弹 picker，拿到 handle 之后才去取数据**。
 * 本模块的 `save()` 用「传一个 getChunks 函数而不是传现成的数据」来强制这个顺序 ——
 * 调用方没法先 await 一堆数据再进来。
 *
 * ## 为什么放在扩展页面而不是 service worker
 *
 * 两点：
 *   1. SW 里**不能**调 `requestPermission()`（无法消费用户激活）。
 *   2. SW 里**没有** `URL.createObjectURL`（Blink IDL 的 Exposed 白名单是
 *      `Window,DedicatedWorker,SharedWorker`，不含 `ServiceWorker`），
 *      而降级路径需要它。
 *
 * ## 好消息
 *
 * 扩展上下文（popup / side panel / 扩展页面）的 picker 权限会被浏览器**自动授予**，
 * 不弹二次确认框。Chromium 源码注释原文：
 * "Since the user already explicitly selected a file/folder via the file picker dialog
 * (which is a strong user gesture), we can auto-grant the permission for extensions".
 */
(function (HA) {

  /** 记住的 handle 存在 meta 表里的键名 */
  var HANDLE_KEY = 'backupFileHandle';

  function isPickerSupported() {
    return typeof window !== 'undefined'
      && typeof window.showSaveFilePicker === 'function';
  }

  /* ------------------------------------------------------------------ *
   * 选择文件
   * ------------------------------------------------------------------ */

  /**
   * 弹出「另存为」对话框。
   *
   * ⚠️ **必须在用户手势中同步调用**（即在点击处理器的第一个 await 位置）。
   *
   * @param {{suggestedName?: string, mimeType?: string, description?: string}} options
   * @returns {Promise<FileSystemFileHandle|null>} 用户取消时返回 null
   */
  HA.FSSave = {

    isPickerSupported: isPickerSupported,

    pickSaveFile: function (options) {
      options = options || {};
      if (!isPickerSupported()) return Promise.resolve(null);

      var pickerOptions = {};
      if (options.suggestedName) pickerOptions.suggestedName = options.suggestedName;

      // types 里的 accept 必须是「MIME → 扩展名数组」，空数组是非法的，
      // 所以只有拿到扩展名时才声明 types
      if (options.mimeType && options.extension) {
        var accept = {};
        accept[options.mimeType] = [options.extension];
        pickerOptions.types = [{
          description: options.description || '文件',
          accept: accept,
        }];
      }

      return window.showSaveFilePicker(pickerOptions).catch(function (err) {
        // 用户点了取消 —— 这是正常路径，不是错误
        if (err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''))) {
          return null;
        }
        throw err;
      });
    },

    /* ---------------------------------------------------------------- *
     * 写入
     * ---------------------------------------------------------------- */

    /**
     * 把分块内容流式写入 handle。
     *
     * 用流式写而不是先拼成一个大字符串再写：几千条标注的 Markdown
     * 可能有几十 MB，全量驻留内存没必要。
     * 注意「写入内容在 close 之前不会真正落盘」（写的是临时文件，close 时替换）。
     *
     * @param {FileSystemFileHandle} handle
     * @param {Iterable<string>} chunks
     * @returns {Promise<{bytes: number}>}
     */
    writeChunks: function (handle, chunks) {
      var encoder = new TextEncoder();
      var bytes = 0;

      return handle.createWritable().then(function (writable) {
        var iterator = chunks[Symbol.iterator]
          ? chunks[Symbol.iterator]()
          : chunks;

        function writeNext() {
          var step = iterator.next();
          if (step.done) return Promise.resolve();

          var chunk = step.value;
          if (chunk === undefined || chunk === null) return writeNext();

          var encoded = encoder.encode(chunk);
          bytes += encoded.byteLength;
          return writable.write(encoded).then(writeNext);
        }

        return writeNext().then(function () {
          return writable.close();
        }).catch(function (err) {
          // 出错要中止，避免留下半截文件
          return writable.abort().catch(function () {}).then(function () {
            throw err;
          });
        });
      }).then(function () {
        return { bytes: bytes };
      });
    },

    /**
     * 完整的「另存为」流程。
     *
     * @param {{suggestedName: string, mimeType?: string, extension?: string,
     *          description?: string, rememberKey?: string,
     *          getChunks: () => Iterable<string>}} options
     *        `getChunks` 是**函数**而不是现成的数据 —— 这样能保证数据是在
     *        picker 之后才去取的（否则容易跨过激活窗口）。
     * @returns {Promise<{saved: boolean, cancelled?: boolean, bytes?: number,
     *                    method?: string, reason?: string}>}
     */
    save: function (options) {
      options = options || {};

      // ★ 第一个 await 必须是 picker
      return HA.FSSave.pickSaveFile({
        suggestedName: options.suggestedName,
        mimeType: options.mimeType,
        extension: options.extension,
        description: options.description,
      }).then(function (handle) {
        if (!handle) return { saved: false, cancelled: true };

        // 到这里才去准备数据
        var chunks = options.getChunks();
        return HA.FSSave.writeChunks(handle, chunks).then(function (result) {
          if (options.rememberKey) {
            HA.FSSave.rememberHandle(options.rememberKey, handle);
          }
          return { saved: true, bytes: result.bytes, method: 'picker' };
        });
      });
    },

    /* ---------------------------------------------------------------- *
     * 记住 handle（用于「之后自动增量备份」）
     * ---------------------------------------------------------------- */

    /**
     * `FileSystemFileHandle` 是**可结构化克隆的**，所以能直接存进 IndexedDB
     * （官方原文："File handles and directory handles are serializable, which means
     * that you can save a file or directory handle to IndexedDB"）。
     * 存下来之后，下次会话只要权限还在就能直接写，不必再弹 picker。
     */
    rememberHandle: function (key, handle) {
      return HA.setMeta(key || HANDLE_KEY, handle).catch(function (err) {
        console.warn('[HA] 记住文件句柄失败：', err);
      });
    },

    getRememberedHandle: function (key) {
      return HA.getMeta(key || HANDLE_KEY, null).catch(function () { return null; });
    },

    clearRememberedHandle: function (key) {
      return HA.setMeta(key || HANDLE_KEY, null).catch(function () {});
    },

    /**
     * 检查已记住的 handle 现在能不能直接写。
     *
     * 权限状态可能是 granted / prompt / denied：
     *   - `granted`  → 直接写，无需交互
     *   - `prompt`   → **必须在用户手势里**调 requestPermission()
     *   - `denied`   → 让用户重新选文件
     *
     * 注：Chrome 122+ 的持久权限生效时，`queryPermission()` 会直接返回 'granted'
     * （Chromium 的 `PermissionGrantImpl::GetStatus()` 会先把持久授权的 ASK 抬成
     * GRANTED），所以根本不会走到要弹框的那一步。
     *
     * @returns {Promise<'granted'|'prompt'|'denied'|'missing'>}
     */
    checkPermission: function (handle) {
      if (!handle || typeof handle.queryPermission !== 'function') {
        return Promise.resolve('missing');
      }
      return handle.queryPermission({ mode: 'readwrite' }).catch(function () {
        return 'missing';
      });
    },

    /**
     * 在用户手势里请求权限。
     * ⚠️ 这个调用**会消费用户激活**，所以它自己就得是手势里的第一个动作。
     */
    requestPermission: function (handle) {
      if (!handle || typeof handle.requestPermission !== 'function') {
        return Promise.resolve('missing');
      }
      return handle.requestPermission({ mode: 'readwrite' }).catch(function () {
        return 'denied';
      });
    },

    /* ---------------------------------------------------------------- *
     * 降级：chrome.downloads
     * ---------------------------------------------------------------- */

    /**
     * 用下载 API 兜底（浏览器不支持 picker 时）。
     *
     * ⚠️ 这条路径只能在**扩展页面**里用：
     *   - `URL.createObjectURL` 在 SW 里不存在
     *   - `chrome.downloads.download` 的 data: URL 上限是 2 MB
     *     （`kMaxURLChars = 2097152`），超限会被**静默替换为空 URL** 从而失败，
     *     所以这里只能走 blob URL
     *
     * `downloads` 是可选权限，需要在这里申请。
     */
    saveViaDownload: function (options) {
      options = options || {};

      if (typeof chrome === 'undefined' || !chrome.downloads) {
        return Promise.resolve({ saved: false, reason: 'downloads-unavailable' });
      }

      var ensurePermission = chrome.permissions && chrome.permissions.contains
        ? chrome.permissions.contains({ permissions: ['downloads'] }).then(function (granted) {
            if (granted) return true;
            // 权限申请必须在用户手势里 —— 调用方需要保证这一点
            return chrome.permissions.request({ permissions: ['downloads'] });
          })
        : Promise.resolve(true);

      return ensurePermission.then(function (granted) {
        if (!granted) return { saved: false, reason: 'permission-denied' };

        var text = typeof options.text === 'string'
          ? options.text
          : Array.from(options.chunks || []).join('');

        var blob = new Blob([text], {
          type: options.mimeType || 'application/octet-stream',
        });
        var url = URL.createObjectURL(blob);

        return chrome.downloads.download({
          url: url,
          filename: options.filename || 'download.txt',
          saveAs: options.saveAs !== false,   // 让用户能选位置
          conflictAction: 'uniquify',
        }).then(function () {
          // 给浏览器一点时间把 blob 读走再释放
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
          return { saved: true, method: 'download', bytes: blob.size };
        }).catch(function (err) {
          URL.revokeObjectURL(url);
          return { saved: false, reason: String(err && err.message || err) };
        });
      });
    },

    /** 是否具备降级所需的 API */
    hasDownloadFallback: function () {
      return typeof chrome !== 'undefined'
        && !!chrome.downloads
        && typeof URL !== 'undefined'
        && typeof URL.createObjectURL === 'function';
    },
  };

})(globalThis.HA || (globalThis.HA = {}));
