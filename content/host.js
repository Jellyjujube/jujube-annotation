'use strict';
/**
 * content script ↔ service worker 的通信层。
 *
 * 职责：
 *   - 启动时一次性批量拉取本页标注
 *   - 增删改经 SW 落库
 *   - 接收 SW 的增量通知（标注变化 / SPA 路由变化 / 右键菜单动作）
 *
 * 所有调用都要容忍「没有接收端」—— 受限页面（chrome://、Web Store、
 * 内置 PDF 阅读器、未勾选「允许访问文件网址」的 file://）上 SW 收不到消息，
 * 官方文档明说这种调用会 reject，不处理就是未捕获的 Promise rejection。
 */
(function (HA) {

  var handlers = {
    changed: [],
    routeChanged: [],
    action: [],
  };

  var available = true;      // SW 是否可达

  function emit(name, arg) {
    handlers[name].forEach(function (fn) {
      try { fn(arg); } catch (err) { console.warn('[HA] 处理器出错：', err); }
    });
  }

  /** 把「没有接收端」转成可判断的返回值，其余错误继续抛 */
  function tolerate(fn) {
    return fn().catch(function (err) {
      if (err && err.code === 'no-receiver') {
        available = false;
        return null;
      }
      if (err && err.code === 'protocol-mismatch') {
        available = false;
        emit('action', { type: 'protocol-mismatch' });
        return null;
      }
      throw err;
    });
  }

  HA.Host = {
    /** service worker 是否可达。不可达时应当静默停用而不是反复报错。 */
    isAvailable: function () { return available; },

    /** 启动：批量拉取本页标注 */
    load: function (urlKey) {
      return tolerate(function () {
        return HA.api.getForUrl(urlKey);
      }).then(function (list) { return list || []; });
    },

    /** 新建 */
    create: function (record) {
      return tolerate(function () {
        return HA.api.create(record);
      });
    },

    /** 局部更新 */
    update: function (id, patch) {
      return tolerate(function () {
        return HA.api.update(id, patch);
      });
    },

    /** 删除 */
    remove: function (id) {
      return tolerate(function () {
        return HA.api.remove(id);
      });
    },

    /** 自检：确认协议版本一致 */
    ping: function () {
      return tolerate(function () { return HA.api.ping(); });
    },

    /**
     * 把本页真正使用的 urlKey 告诉 service worker。
     *
     * 必要性：页面可能声明了 `<link rel=canonical>`，此时 urlKey 来自 canonical
     * 而不是地址栏 URL。SW 里没有 DOM，算不出 canonical，只能由页面报上去 ——
     * 否则工具栏徽标会用地址栏 URL 去数，恒为 0。
     *
     * 这是**尽力而为**的通知：失败最多让徽标数字不准，绝不能影响页面本身的标注功能，
     * 所以这里吞掉所有错误（tolerate 只处理「无接收端」和「协议不匹配」两种）。
     */
    reportPage: function (context) {
      if (!context || !context.urlKey) return Promise.resolve(false);
      if (!available) return Promise.resolve(false);

      return HA.sendToBackground({
        type: HA.MSG.REPORT_PAGE,
        urlKey: context.urlKey,
        siteKey: context.siteKey,
      }).then(function () {
        return true;
      }).catch(function () {
        return false;
      });
    },

    /* ---------------------------------------------------------------- *
     * 订阅 SW 的通知
     * ---------------------------------------------------------------- */

    onChanged: function (fn) { handlers.changed.push(fn); },
    onRouteChanged: function (fn) { handlers.routeChanged.push(fn); },
    onAction: function (fn) { handlers.action.push(fn); },

    /** 注册消息监听。必须在顶层同步调用。 */
    listen: function () {
      // 单向通知（SW → 本页）
      HA.registerNotifications(function (payload) {
        if (!payload || !payload.type) return;

        switch (payload.type) {
          case HA.MSG.CHANGED:
            emit('changed', payload.change || {});
            break;

          case HA.MSG.ROUTE_CHANGED:
            emit('routeChanged', { url: payload.url });
            break;

          case HA.MSG.HIGHLIGHT_SELECTION:
            emit('action', {
              type: 'highlight-selection',
              color: payload.color,
            });
            break;

          default:
            break;
        }
      });

      // 请求/响应（侧边栏 → 本页）
      //
      // 注意：只能传**纯数据**。Range / Node 都不能跨消息边界，
      // 所以这里返回的是状态摘要与字符偏移，而不是 range 本身。
      HA.registerHandler(function (payload) {
        if (!payload || !payload.type) throw new Error('消息缺少 type');

        switch (payload.type) {
          case HA.MSG.GET_STATUS:
            return HA.Host.statusSnapshot();

          case HA.MSG.SCROLL_TO:
            return HA.Renderer.scrollToAnnotation(payload.id);

          case HA.MSG.REANCHOR:
            return HA.Observer.forceReanchor().then(function () {
              return HA.Host.statusSnapshot();
            });

          default:
            // 通知类消息（CHANGED / ROUTE_CHANGED / HIGHLIGHT_SELECTION）
            // 由上面的 registerNotifications 处理。这里必须**安静地返回**，
            // 而不是抛错 —— 否则每收到一条通知都会回一个错误响应。
            return null;
        }
      });
    },

    /**
     * 汇总本页的归属信息与所有标注的锚定状态。
     *
     * 侧边栏要靠它区分「正常」「未定位」「有歧义」，按文档位置排序，
     * 并且**拿到本页真正的 urlKey** —— 页面可能声明了 `<link rel=canonical>`，
     * 那时它和地址栏 URL 不是一回事，侧边栏自己算不出来。
     *
     * @returns {{urlKey, siteKey, title, pageUrl,
     *            statuses: Array<{id, status, score, reason, offset}>}}
     */
    statusSnapshot: function () {
      var context = HA.Store.getContext();
      var index = null;

      try {
        index = HA.getTextIndex(HA.defaultRoot());
      } catch (err) {
        index = null;
      }

      var statuses = HA.Store.list().map(function (entry) {
        var offset = null;
        if (index && entry.range) {
          var offsets = HA.rangeToOffsets(index, entry.range);
          if (offsets) offset = offsets.start;
        }

        return {
          id: entry.annotation.id,
          status: entry.status,
          score: entry.score,
          reason: entry.reason || null,
          offset: offset,
        };
      });

      return {
        urlKey: context.urlKey,
        siteKey: context.siteKey,
        title: context.title || document.title || '',
        pageUrl: context.pageUrl || location.href,
        statuses: statuses,
      };
    },
  };

})(globalThis.HA || (globalThis.HA = {}));
