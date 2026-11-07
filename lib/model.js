'use strict';
/**
 * 标注的数据模型：构造、校验、规范化。
 *
 * 一条标注记录的完整形态见 HA.ANNOTATION_FIELDS。设计要点：
 *
 *  - **`text` 字段冗余存一份选中的原文**。侧边栏列表和 Markdown 导出都需要展示原文，
 *    如果每次都靠锚定结果反推，那么锚定失败（孤儿）时就什么都显示不出来 ——
 *    而孤儿恰恰是最需要让用户看到「原文是什么」的场景。
 *
 *  - **`selectors` 是数组，不是单值**。W3C WADM 原文说多个 selector 描述同一段内容、
 *    消费端「MUST pick one」，是**备选**语义，不是合取。降级链依次尝试它们。
 *
 *  - **`anchorMeta.canonicalTextVersion` 必须存**。归一化规则一旦改动，
 *    所有历史 `TextPositionSelector` 偏移全部作废。没有版本号连「作废了」都不知道。
 */
(function (HA) {

  /* ------------------------------------------------------------------ *
   * 身份
   * ------------------------------------------------------------------ */

  /** 生成一个够用的唯一 id（不依赖 crypto.randomUUID，扩展页面与 SW 都可用） */
  HA.makeId = function () {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // 退路：时间戳 + 随机数。单机个人使用足够。
    return Date.now().toString(36) + '-'
         + Math.random().toString(36).slice(2, 10) + '-'
         + Math.random().toString(36).slice(2, 10);
  };

  /* ------------------------------------------------------------------ *
   * 标签
   * ------------------------------------------------------------------ */

  var MAX_TAG_LENGTH = 32;
  var MAX_TAGS = 20;

  /** 规范化单个标签：去首尾空白、压缩内部空白、长度截断 */
  HA.normalizeTag = function (tag) {
    if (typeof tag !== 'string') return '';
    return tag.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
  };

  /** 规范化标签数组：逐个规范化、去重（不区分大小写）、限量 */
  HA.normalizeTags = function (tags) {
    if (!Array.isArray(tags)) return [];
    var seen = new Set();
    var out = [];
    for (var i = 0; i < tags.length && out.length < MAX_TAGS; i++) {
      var tag = HA.normalizeTag(tags[i]);
      if (!tag) continue;
      var lower = tag.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(tag);
    }
    return out;
  };

  /* ------------------------------------------------------------------ *
   * 构造
   * ------------------------------------------------------------------ */

  /**
   * 构造一条标注记录。
   *
   * @param {Object} fields
   * @returns {Object} 完整、规范化的标注记录
   */
  HA.createAnnotation = function (fields) {
    fields = fields || {};
    var now = Date.now();

    return {
      id: fields.id || HA.makeId(),

      urlKey: fields.urlKey || '',
      siteKey: fields.siteKey || '',
      url: fields.url || '',
      title: fields.title || '',

      selectors: Array.isArray(fields.selectors) ? fields.selectors : [],
      anchorMeta: fields.anchorMeta || {
        canonicalTextVersion: HA.CANONICAL_TEXT_VERSION,
      },
      text: typeof fields.text === 'string' ? fields.text : '',

      color: fields.color || 'yellow',
      note: typeof fields.note === 'string' ? fields.note : '',
      tags: HA.normalizeTags(fields.tags),

      createdAt: fields.createdAt || now,
      updatedAt: now,
    };
  };

  /**
   * 把任意来源的记录（比如用户导入的 JSON）规范成当前模式。
   * 未知字段被丢弃，缺失字段被补默认值。
   *
   * @returns {{annotation: Object|null, errors: string[]}}
   */
  HA.normalizeAnnotation = function (record) {
    var errors = [];

    if (!record || typeof record !== 'object') {
      return { annotation: null, errors: ['记录不是对象'] };
    }

    // v1 的图片标注已经不再支持，导入时直接跳过（而不是变成一个没有原文的空记录）
    if (record.kind === 'image') {
      return { annotation: null, errors: ['图片标注已不再支持，已跳过'] };
    }

    // 保留 id：导入时要能识别重复
    var picked = HA.pickKnownFields(record);

    if (!picked.id) picked.id = HA.makeId();
    if (typeof picked.id !== 'string') {
      errors.push('id 不是字符串，已重新生成');
      picked.id = HA.makeId();
    }

    if (!picked.urlKey) {
      errors.push('缺少 urlKey，无法归属到任何页面');
    }

    if (!Array.isArray(picked.selectors)) {
      errors.push('缺少 selectors');
    }

    if (!picked.text && picked.selectors) {
      // 从 TextQuoteSelector 里回填 text，方便列表展示
      for (var i = 0; i < picked.selectors.length; i++) {
        if (picked.selectors[i] && picked.selectors[i].type === 'TextQuoteSelector') {
          picked.text = picked.selectors[i].exact || '';
          break;
        }
      }
    }

    var annotation = HA.createAnnotation(picked);
    // createAnnotation 会刷新 updatedAt，这里保留原值（导入不该改动时间线）
    annotation.createdAt = picked.createdAt || annotation.createdAt;
    annotation.updatedAt = picked.updatedAt || annotation.createdAt;

    return { annotation: annotation, errors: errors };
  };

  /** 校验一条记录是否可入库。返回错误字符串数组，空数组表示通过。 */
  HA.validateAnnotation = function (annotation) {
    var errors = [];
    if (!annotation || typeof annotation !== 'object') return ['不是对象'];
    if (!annotation.id) errors.push('缺少 id');
    if (!annotation.urlKey) errors.push('缺少 urlKey');
    if (!annotation.text) errors.push('缺少原文');
    if (!Array.isArray(annotation.selectors) || !annotation.selectors.length) {
      errors.push('缺少 selectors');
    }
    return errors;
  };

  /* ------------------------------------------------------------------ *
   * 展示辅助
   * ------------------------------------------------------------------ */

  /** 列表里显示的原文摘要 */
  HA.textPreview = function (text, max) {
    max = max || 120;
    if (typeof text !== 'string') return '';
    var oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
  };

})(globalThis.HA || (globalThis.HA = {}));
