'use strict';
/**
 * 页面内的标注索引 —— content script 的内存状态。
 *
 * 这里保存「标注数据 + 它在当前 DOM 里的锚定结果」。
 * content script 启动时**一次性批量拉取**本页全部标注（一次消息往返），
 * 之后增删改都走增量通知，日常操作全是内存读写 —— 避免每条标注一次往返
 * 导致页面加载时上百次消息传递造成明显延迟和闪烁。
 */
(function (HA) {

  var entries = new Map();       // id → entry
  var listeners = [];

  var context = {
    urlKey: null,
    siteKey: null,
    pageUrl: '',
    title: '',
  };

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(); } catch (err) { console.warn('[HA] 监听器出错：', err); }
    });
  }

  function makeEntry(annotation) {
    return {
      annotation: annotation,
      status: HA.STATUS.PENDING,   // 还没锚定
      score: 0,
      reason: null,
      range: null,
      /**
       * 锚定当时那个 range 实际覆盖的文本。
       *
       * 用来检测「页面就地修改了文本节点内容」—— 这种情况下 range 的容器
       * 仍然 connected，光看连接性是发现不了的，但高亮已经**静默地盖住了
       * 别的文字**。每次校验时比一下这个值就能发现。
       */
      matchedText: null,
    };
  }

  HA.Store = {
    /** 设定当前页面的归属信息 */
    setContext: function (info) {
      context.urlKey = info.urlKey;
      context.siteKey = info.siteKey;
      context.pageUrl = info.pageUrl || '';
      context.title = info.title || '';
    },

    getContext: function () { return context; },
    getUrlKey: function () { return context.urlKey; },

    /** 整批替换（启动拉取、或路由变化后重新拉取） */
    replaceAll: function (annotations) {
      var seen = new Set();
      (annotations || []).forEach(function (annotation) {
        seen.add(annotation.id);
        var existing = entries.get(annotation.id);
        if (existing) {
          existing.annotation = annotation;
        } else {
          entries.set(annotation.id, makeEntry(annotation));
        }
      });
      // 移除已经不存在的
      Array.from(entries.keys()).forEach(function (id) {
        if (!seen.has(id)) entries.delete(id);
      });
      emit();
    },

    /** 新增或更新一条 */
    upsert: function (annotation, options) {
      var entry = entries.get(annotation.id);
      if (entry) {
        entry.annotation = annotation;
        // 位置没变的话保留已有锚定结果，避免无谓重锚
        if (!options || !options.invalidate) return entry;
        entry.status = HA.STATUS.PENDING;
        entry.range = null;
      } else {
        entry = makeEntry(annotation);
        entries.set(annotation.id, entry);
      }
      emit();
      return entry;
    },

    remove: function (id) {
      var removed = entries.delete(id);
      if (removed) emit();
      return removed;
    },

    get: function (id) { return entries.get(id) || null; },

    /** 取标注数据（不含锚定结果） */
    getAnnotation: function (id) {
      var entry = entries.get(id);
      return entry ? entry.annotation : null;
    },

    /** 全部条目 */
    list: function () {
      return Array.from(entries.values());
    },

    /** 全部标注数据 */
    annotations: function () {
      return Array.from(entries.values()).map(function (e) { return e.annotation; });
    },

    /** 丢弃全部（页面不再支持标注时用） */
    clear: function () {
      entries.clear();
      emit();
    },

    /* ---------------------------------------------------------------- *
     * 锚定结果
     * ---------------------------------------------------------------- */

    setAnchorResult: function (id, result) {
      var entry = entries.get(id);
      if (!entry) return;
      entry.status = result.status;
      entry.score = result.score || 0;
      entry.reason = result.reason || null;
      entry.range = result.range || null;
      // 记住锚定当时覆盖的文本，供后续校验「是否已被就地改写」
      entry.matchedText = result.matchedText || entry.annotation.text || null;
    },

    /** 批量写入锚定结果（anchorBatch 的输出） */
    applyAnchorResults: function (results) {
      results.forEach(function (result, id) {
        HA.Store.setAnchorResult(id, result);
      });
      emit();
    },

    /* ---------------------------------------------------------------- *
     * 查询
     * ---------------------------------------------------------------- */

    /** 需要（重新）锚定的条目：还没有 range 且不是彻底放弃的状态 */
    needingAnchor: function () {
      return Array.from(entries.values()).filter(function (entry) {
        return !entry.range && entry.status !== HA.STATUS.ORPHAN;
      });
    },

    /** 已成功锚定、可供渲染的条目 */
    anchored: function () {
      return Array.from(entries.values()).filter(function (entry) {
        return !!entry.range;
      });
    },

    /** 按状态统计 */
    counts: function () {
      var out = { total: 0, anchored: 0, pending: 0, orphan: 0, fuzzy: 0, ambiguous: 0 };
      entries.forEach(function (entry) {
        out.total++;
        if (entry.range) out.anchored++;
        if (entry.status === HA.STATUS.PENDING) out.pending++;
        if (entry.status === HA.STATUS.ORPHAN) out.orphan++;
        if (entry.status === HA.STATUS.FUZZY) out.fuzzy++;
        if (entry.status === HA.STATUS.AMBIGUOUS) out.ambiguous++;
      });
      return out;
    },

    /* ---------------------------------------------------------------- *
     * 订阅
     * ---------------------------------------------------------------- */

    onChange: function (callback) {
      listeners.push(callback);
      return function unsubscribe() {
        var at = listeners.indexOf(callback);
        if (at !== -1) listeners.splice(at, 1);
      };
    },
  };

})(globalThis.HA || (globalThis.HA = {}));
