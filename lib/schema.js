'use strict';
/**
 * 数据模式：版本、迁移、字段清单。
 *
 * 迁移设计遵循一条硬要求：**必须幂等且可重入**。
 * MV3 的 service worker 空闲 30 秒就可能被杀死，长迁移随时可能在事务中间被打断。
 * 所以每个迁移步骤都拆成独立的小事务，并把进度写进 meta 表，
 * 下次启动接着跑，而不是从头再来或者留下半截数据。
 */
(function (HA) {

  /** 当前数据模式版本。改动记录结构时递增，并在 MIGRATIONS 里补一个迁移函数。 */
  HA.SCHEMA_VERSION = 2;

  /**
   * 标注记录的字段清单（用于校验与导入时的字段白名单）。
   *
   * v2 起只有文字标注一种类型，所以不再有 `kind` 与 `image` 字段。
   */
  HA.ANNOTATION_FIELDS = [
    // 身份
    'id',

    // 归属
    'urlKey', 'siteKey', 'url', 'title',

    // 锚点（W3C WADM 风格的多个选择器并列 = 备选）
    'selectors', 'anchorMeta',

    /** 冗余存一份选中的原文。
     *  侧边栏列表和 Markdown 导出都要展示它 —— 如果靠锚定结果反推，
     *  那么锚定失败（孤儿）时就什么都显示不出来，
     *  而孤儿恰恰是最需要让用户看到「原文是什么」的场景。 */
    'text',

    // 用户数据
    'color', 'note', 'tags',

    // 时间
    'createdAt', 'updatedAt',
  ];

  /** 需要建索引的字段。改动这里必须同时改 HA.DB_VERSION 并在迁移里同步重构索引。 */
  HA.ANNOTATION_INDEXES = [
    { name: 'urlKey',    keyPath: 'urlKey',    options: {} },
    { name: 'siteKey',   keyPath: 'siteKey',   options: {} },
    { name: 'createdAt', keyPath: 'createdAt', options: {} },
    { name: 'updatedAt', keyPath: 'updatedAt', options: {} },
    { name: 'color',     keyPath: 'color',     options: {} },
    // multiEntry：一条标注有多个标签，让每个标签都能作为索引键
    { name: 'tags',      keyPath: 'tags',      options: { multiEntry: true } },
  ];

  /** 已废弃、需要从旧库里删掉的索引（v1 有 kind，v2 起没有了） */
  HA.OBSOLETE_INDEXES = [
    { store: 'annotations', name: 'kind' },
  ];

  /**
   * 迁移表：`{ [目标版本]: function(db, transaction, HA) }`
   *
   * 约定：
   *  - 每个函数只负责「从 上一版本 → 本版本」这一步
   *  - 必须可以安全地重复执行（幂等）
   *  - 必须在传入的 upgrade 事务里**同步发出**请求，事务才不会提前提交
   */
  HA.MIGRATIONS = {
    /**
     * v1 → v2：移除图片标注。
     *
     * 图片标注整条删掉（该功能已移除，且这些记录本来就没法用）；
     * 其余记录剥掉 `kind` / `image` 两个废字段。
     */
    2: function (db, tx) {
      var store = tx.objectStore(HA.STORE_ANNOTATIONS);
      var cursorRequest = store.openCursor();
      var removed = 0;

      cursorRequest.onsuccess = function () {
        var cursor = cursorRequest.result;
        if (!cursor) {
          // 删除用户的旧数据不能悄悄做掉
          if (removed) {
            console.info('[HA] 数据迁移 v2：移除了 ' + removed
              + ' 条旧的图片标注（该功能已下线）');
          }
          return;
        }

        var record = cursor.value;

        if (record && record.kind === 'image') {
          cursor.delete();          // 图片标注整条移除
          removed++;
          cursor.continue();
          return;
        }

        // 文字标注：只删字段，不重写整条记录（避免丢掉未来版本可能新增的字段）
        if (record && (record.kind !== undefined || record.image !== undefined)) {
          delete record.kind;
          delete record.image;
          cursor.update(record);
        }
        cursor.continue();
      };
    },
  };

  /** 从旧记录里挑出当前版本认识的字段，丢掉未知字段。
   *  用于导入外部 JSON 时兜底，避免把垃圾字段写进库。 */
  HA.pickKnownFields = function (record) {
    var out = {};
    for (var i = 0; i < HA.ANNOTATION_FIELDS.length; i++) {
      var field = HA.ANNOTATION_FIELDS[i];
      if (record[field] !== undefined) out[field] = record[field];
    }
    return out;
  };

})(globalThis.HA || (globalThis.HA = {}));
