'use strict';
/**
 * 标注仓储 —— service worker 侧的写入口。
 *
 * 所有写入都经过这里，因为 service worker 是**唯一写入方**：
 * content script 不能直接碰扩展的 IndexedDB（那是宿主页面的库）。
 *
 * ## 广播策略：发给所有标签页，由各自的 content script 按 urlKey 过滤
 *
 * 不维护 `tabId → urlKey` 映射来精准投递：映射存在于 SW 内存，而 SW 空闲
 * 30 秒即可能被回收，映射随之丢失，会导致「管理页改了标注，已打开的网页收不到更新」。
 * 广播全量标签页则无需维护任何内存状态，任何时刻被唤醒都能正确工作；
 * 标签页数量有限，多发的几条消息可以忽略。
 */
(function (HA) {

  /** 通知所有标签页 + 所有已打开的扩展页面（侧边栏/管理页/设置页）：标注变了 */
  function broadcastChange(change) {
    if (typeof chrome === 'undefined') return Promise.resolve();

    var tasks = [];

    // content script 走 tabs.sendMessage
    if (chrome.tabs && chrome.tabs.query) {
      tasks.push(chrome.tabs.query({}).then(function (tabs) {
        (tabs || []).forEach(function (tab) {
          if (typeof tab.id !== 'number') return;
          HA.notifyTab(tab.id, { type: HA.MSG.CHANGED, change: change });
        });
      }).catch(function () { /* 拿不到标签页列表不是致命错误 */ }));
    }

    // 扩展页面走 runtime.sendMessage。
    // 注意：SW 自己不会收到这条消息，content script 也不会 ——
    // 它们各自只走上面那条路径，所以不存在重复投递。
    if (chrome.runtime && chrome.runtime.sendMessage) {
      tasks.push(
        chrome.runtime.sendMessage({
          __ha_message__: true,
          v: HA.PROTOCOL_VERSION,
          payload: { type: HA.MSG.CHANGED, change: change },
        }).catch(function () {
          // 没有扩展页面开着时会 reject，这是正常情况
        })
      );
    }

    return Promise.all(tasks);
  }

  /** 刷新某个标签页的工具栏徽标（显示该页标注数） */
  function refreshBadge(tabId, url) {
    if (typeof chrome === 'undefined' || !chrome.action) return Promise.resolve();
    if (typeof tabId !== 'number') return Promise.resolve();

    var urlKey = url ? HA.normalizeUrl(url) : null;
    if (!urlKey) {
      return chrome.action.setBadgeText({ tabId: tabId, text: '' }).catch(function () {});
    }

    return HA.countByUrlKey(urlKey).then(function (count) {
      var text = count > 99 ? '99+' : (count > 0 ? String(count) : '');
      return chrome.action.setBadgeText({ tabId: tabId, text: text });
    }).catch(function () { /* 标签页可能已关闭 */ });
  }

  /** 对某个标签页当前地址刷新徽标。
   *
   *  @param {number} tabId
   *  @param {string} [urlKeyOverride] content script 上报的 urlKey。
   *         页面声明 `<link rel=canonical>` 时，urlKey 与地址栏 URL 不同，
   *         而 SW 没有 DOM 算不出 canonical —— 只能用页面报上来的值。
   *         拿不到就退回按地址栏 URL 算，虽然可能数不准，总比不显示好。 */
  function refreshBadgeForTab(tabId, urlKeyOverride) {
    if (typeof chrome === 'undefined' || !chrome.tabs) return Promise.resolve();
    return chrome.tabs.get(tabId).then(function (tab) {
      if (!tab || !tab.url) return;
      // 只在能注入 content script 的页面上显示徽标
      if (!/^https?:/i.test(tab.url)) {
        return chrome.action.setBadgeText({ tabId: tabId, text: '' }).catch(function () {});
      }
      return refreshBadge(tabId, urlKeyOverride || tab.url);
    }).catch(function () {});
  }

  /**
   * 按全局「默认目录」归档新建标注所属的网站。
   *
   * 归档粒度是**网站**：默认目录有效时，这个网站（连同已有标注）整体放进该目录，
   * 避免同一个网站被拆到两个目录。设置为「顶层」（null）表示不自动归档。
   *
   * 归档失败不应影响标注本身 —— 组织方式可以再调，标注丢了才是真丢。
   */
  function applyDefaultFolder(annotation) {
    if (!annotation.siteKey) return Promise.resolve();

    return HA.getSettings().then(function (settings) {
      var folderId = settings && settings.defaultFolderId;
      if (!folderId) return null;

      return HA.getFolder(folderId).then(function (folder) {
        if (!folder) {
          // 目录已被删除：退回「不自动归档」，避免配置一直指向不存在的目录
          return HA.updateSettings({ defaultFolderId: null });
        }
        return HA.getSiteFolder(annotation.siteKey).then(function (current) {
          if (current === folderId) return null;
          return HA.setSiteFolder(annotation.siteKey, folderId);
        });
      });
    }).catch(function (err) {
      console.warn('[HA] 按默认目录归档失败：', err);
    });
  }

  HA.Repo = {
    refreshBadge: refreshBadge,
    refreshBadgeForTab: refreshBadgeForTab,
    broadcastChange: broadcastChange,

    /** 新建标注 */
    create: function (record) {
      var annotation = HA.createAnnotation(record);
      var errors = HA.validateAnnotation(annotation);
      if (errors.length) {
        return Promise.reject(new Error('标注不合法：' + errors.join('；')));
      }

      return HA.putAnnotation(annotation).then(function () {
        return applyDefaultFolder(annotation);
      }).then(function () {
        broadcastChange({
          kind: 'created',
          urlKey: annotation.urlKey,
          ids: [annotation.id],
          annotation: annotation,
        });
        return annotation;
      });
    },

    /** 局部更新 */
    update: function (id, patch) {
      return HA.updateAnnotation(id, patch).then(function (updated) {
        if (!updated) throw new Error('标注不存在：' + id);
        broadcastChange({
          kind: 'updated',
          urlKey: updated.urlKey,
          ids: [updated.id],
          annotation: updated,
        });
        return updated;
      });
    },

    /** 删除 */
    remove: function (id) {
      return HA.getAnnotation(id).then(function (existing) {
        return HA.deleteAnnotation(id).then(function () {
          broadcastChange({
            kind: 'deleted',
            urlKey: existing ? existing.urlKey : null,
            ids: [id],
          });
        });
      });
    },

    /** 批量删除 */
    removeMany: function (ids) {
      return HA.deleteMany(ids).then(function (count) {
        broadcastChange({ kind: 'deleted', urlKey: null, ids: ids });
        return count;
      });
    },

    /** 取某页全部标注（content script 启动时批量拉取） */
    getForUrl: function (urlKey) {
      return HA.getByUrlKey(urlKey);
    },

    /** 清空全部并广播 */
    clearAll: function () {
      return HA.clearAll().then(function () {
        broadcastChange({ kind: 'cleared', urlKey: null, ids: [] });
      });
    },

    /** 导入并广播 */
    importAnnotations: function (records, options) {
      return HA.importAnnotations(records, options).then(function (result) {
        broadcastChange({ kind: 'bulk', urlKey: null, ids: [] });
        return result;
      });
    },
  };

})(globalThis.HA || (globalThis.HA = {}));
