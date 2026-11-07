'use strict';
/**
 * IndexedDB 封装 —— 扩展 origin 的唯一数据源。
 *
 * ## 为什么必须走扩展 origin
 *
 * 官方文档原文："In content scripts, calling web storage APIs accesses data from
 * the host page the content script is injected on **and not the extension**."
 * 所以 content script 里的 `indexedDB.open()` 打开的是**宿主页面**的库 ——
 * 数据会散落在成千上万个站点 origin 里，用户「清除浏览数据」会连带清掉，
 * 而且 `unlimitedStorage` 对它不生效。**绝对不行。**
 *
 * 正确做法：所有读写都发生在扩展 origin（service worker 或扩展页面），
 * content script 通过 chrome.runtime.sendMessage 间接访问。
 *
 * ## 好消息（可以当产品卖点）
 *
 * 官方文档："Extension storage is **not cleared** when a user clears browsing data.
 * This applies to any data stored using web storage APIs (such as Local Storage and
 * IndexedDB)." 配合 `unlimitedStorage` 权限还能**同时免配额、免淘汰**。
 * 所以「关浏览器、重启电脑都不会丢」是有依据的。
 *
 * ## 两条实现纪律
 *
 * 1. **`getDB()` 是懒加载的**。绝不能在 service worker 顶层 `await openDB()`
 *    之后再注册 listener —— 那会推迟 listener 注册，导致 SW 冷启动时首条消息
 *    早于 listener 而被丢弃（经典的「有时候高亮不出来，刷新一下就好」）。
 * 2. **迁移必须幂等且可重入**。SW 空闲 30 秒就可能被杀，长迁移随时可能中断。
 */
(function (HA) {

  var _dbPromise = null;

  /** IDBRequest → Promise */
  function requestToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function openDB() {
    return new Promise(function (resolve, reject) {
      var request;
      try {
        request = indexedDB.open(HA.DB_NAME, HA.DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }

      request.onupgradeneeded = function (event) {
        var db = request.result;
        var tx = request.transaction;
        var from = event.oldVersion;

        // 建表 / 建索引：必须在 upgrade 事务里**同步**完成
        if (!db.objectStoreNames.contains(HA.STORE_ANNOTATIONS)) {
          db.createObjectStore(HA.STORE_ANNOTATIONS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(HA.STORE_META)) {
          db.createObjectStore(HA.STORE_META, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(HA.STORE_FOLDERS)) {
          db.createObjectStore(HA.STORE_FOLDERS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(HA.STORE_SITE_FOLDERS)) {
          db.createObjectStore(HA.STORE_SITE_FOLDERS, { keyPath: 'siteKey' });
        }

        var store = tx.objectStore(HA.STORE_ANNOTATIONS);
        HA.ANNOTATION_INDEXES.forEach(function (spec) {
          if (!store.indexNames.contains(spec.name)) {
            store.createIndex(spec.name, spec.keyPath, spec.options);
          }
        });

        // 删掉已废弃的索引（版本降级时不会走到这里，所以只需处理正向升级）
        HA.OBSOLETE_INDEXES.forEach(function (spec) {
          if (spec.store !== HA.STORE_ANNOTATIONS) return;
          if (store.indexNames.contains(spec.name)) {
            store.deleteIndex(spec.name);
          }
        });

        // 逐版本跑迁移。注意：迁移函数必须在同一个 upgrade 事务里发出请求，
        // 只要请求是接着发的，事务就不会提前提交。
        for (var version = from + 1; version <= HA.DB_VERSION; version++) {
          var migrate = HA.MIGRATIONS[version];
          if (typeof migrate === 'function') {
            try {
              migrate(db, tx);
            } catch (err) {
              // 迁移失败要显式中止，留下完整可重试的旧数据，而不是半截新数据
              console.error('[HA] 迁移到 v' + version + ' 失败：', err);
              try { tx.abort(); } catch (e) { /* 已中止 */ }
              return;
            }
          }
        }
      };

      request.onsuccess = function () {
        var db = request.result;
        // 别的上下文（另一个扩展页面 / 新版 SW）要升级时，主动让路，避免卡住对方
        db.onversionchange = function () {
          db.close();
          _dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = function () { reject(request.error); };
      request.onblocked = function () {
        console.warn('[HA] 数据库被其他页面占用，等待其关闭。' +
          '如果长时间无响应，请关闭其他扩展页面后重试。');
      };
    });
  }

  /** 取得数据库连接（懒加载 + 失败后允许重试） */
  HA.getDB = function () {
    if (!_dbPromise) {
      _dbPromise = openDB().catch(function (err) {
        _dbPromise = null;      // 失败不缓存，下次调用重试
        throw err;
      });
    }
    return _dbPromise;
  };

  /** 关掉连接（测试与「重新加载扩展」时用） */
  HA.closeDB = function () {
    var pending = _dbPromise;
    _dbPromise = null;
    if (!pending) return Promise.resolve();
    return pending.then(function (db) { db.close(); }).catch(function () {});
  };

  /* ------------------------------------------------------------------ *
   * 读
   * ------------------------------------------------------------------ */

  /** 按 id 取一条 */
  HA.getAnnotation = function (id) {
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_ANNOTATIONS, 'readonly');
      return requestToPromise(tx.objectStore(HA.STORE_ANNOTATIONS).get(id));
    }).then(function (record) { return record || null; });
  };

  /**
   * 取某个页面（urlKey）的全部标注。
   *
   * content script 启动时**一次性批量拉取**，之后走增量通知 ——
   * 如果每条标注各往返一次消息，页面加载时上百条会造成明显延迟和闪烁。
   */
  HA.getByUrlKey = function (urlKey) {
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_ANNOTATIONS, 'readonly');
      var index = tx.objectStore(HA.STORE_ANNOTATIONS).index('urlKey');
      return requestToPromise(index.getAll(IDBKeyRange.only(urlKey)));
    }).then(function (records) { return records || []; });
  };

  /**
   * 通用查询。先用最有选择性的索引缩小范围，再在内存里做剩余过滤。
   *
   * ⚠️ 全文搜索（filter.search）无法下推到 IndexedDB，会先取出全部记录再过滤。
   * 个人使用量级（几千条）完全够用；真到几万条时需要改成分页游标 + 虚拟列表。
   *
   * @param {{siteKey?: string, urlKey?: string, color?: string,
   *          tag?: string, search?: string, since?: number, until?: number,
   *          sort?: 'newest'|'oldest'|'site'}} [filter]
   * @returns {Promise<Array>}
   */
  HA.query = function (filter) {
    filter = filter || {};

    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_ANNOTATIONS, 'readonly');
      var store = tx.objectStore(HA.STORE_ANNOTATIONS);

      var indexName = null;
      var range = null;

      // 选索引：tag 的 multiEntry 通常最有选择性，其次 urlKey / siteKey
      if (filter.tag) {
        indexName = 'tags';
        range = IDBKeyRange.only(filter.tag);
      } else if (filter.urlKey) {
        indexName = 'urlKey';
        range = IDBKeyRange.only(filter.urlKey);
      } else if (filter.siteKey) {
        indexName = 'siteKey';
        range = IDBKeyRange.only(filter.siteKey);
      }

      var source = indexName ? store.index(indexName) : store;
      return requestToPromise(range ? source.getAll(range) : source.getAll());
    }).then(function (records) {
      var list = records || [];
      return HA.applyFilters(list, filter);
    });
  };

  /** 内存过滤 + 排序（供 query 与已加载数据复用） */
  HA.applyFilters = function (list, filter) {
    filter = filter || {};
    var search = filter.search ? filter.search.trim().toLowerCase() : '';

    var out = list.filter(function (item) {
      if (!item) return false;
      if (filter.color && item.color !== filter.color) return false;
      if (filter.siteKey && item.siteKey !== filter.siteKey) return false;
      if (filter.urlKey && item.urlKey !== filter.urlKey) return false;
      if (filter.tag && (!item.tags || item.tags.indexOf(filter.tag) === -1)) return false;
      if (filter.since && item.createdAt < filter.since) return false;
      if (filter.until && item.createdAt > filter.until) return false;

      if (search) {
        var haystack = [
          item.text || '',
          item.note || '',
          item.title || '',
          item.url || '',
          (item.tags || []).join(' '),
        ].join('\n').toLowerCase();
        if (haystack.indexOf(search) === -1) return false;
      }
      return true;
    });

    return HA.sortAnnotations(out, filter.sort);
  };

  /** 排序 */
  HA.sortAnnotations = function (list, sort) {
    var copy = list.slice();
    if (sort === 'oldest') {
      copy.sort(function (a, b) { return a.createdAt - b.createdAt; });
    } else if (sort === 'site') {
      copy.sort(function (a, b) {
        return (a.siteKey || '').localeCompare(b.siteKey || '')
            || b.createdAt - a.createdAt;
      });
    } else {
      copy.sort(function (a, b) { return b.createdAt - a.createdAt; });
    }
    return copy;
  };

  /** 总数 */
  HA.countAll = function () {
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_ANNOTATIONS, 'readonly');
      return requestToPromise(tx.objectStore(HA.STORE_ANNOTATIONS).count());
    });
  };

  /** 某个页面的标注数（工具栏 badge 用） */
  HA.countByUrlKey = function (urlKey) {
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_ANNOTATIONS, 'readonly');
      var index = tx.objectStore(HA.STORE_ANNOTATIONS).index('urlKey');
      return requestToPromise(index.count(IDBKeyRange.only(urlKey)));
    });
  };

  /**
   * 按网站聚合统计：[{siteKey, count, newest}]，按数量降序。
   * 供管理页左侧的网站列表用。
   */
  HA.statsBySite = function () {
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_ANNOTATIONS, 'readonly');
      return requestToPromise(tx.objectStore(HA.STORE_ANNOTATIONS).getAll());
    }).then(function (records) {
      var map = new Map();
      (records || []).forEach(function (item) {
        var key = item.siteKey || '(未知)';
        var entry = map.get(key);
        if (!entry) {
          entry = { siteKey: key, count: 0, newest: 0 };
          map.set(key, entry);
        }
        entry.count++;
        if (item.createdAt > entry.newest) entry.newest = item.createdAt;
      });
      return Array.from(map.values()).sort(function (a, b) {
        return b.count - a.count;
      });
    });
  };

  /** 收集全部用过的标签及其出现次数 */
  HA.statsByTag = function () {
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_ANNOTATIONS, 'readonly');
      return requestToPromise(tx.objectStore(HA.STORE_ANNOTATIONS).getAll());
    }).then(function (records) {
      var counts = new Map();
      (records || []).forEach(function (item) {
        (item.tags || []).forEach(function (tag) {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        });
      });
      return Array.from(counts.entries())
        .map(function (pair) { return { tag: pair[0], count: pair[1] }; })
        .sort(function (a, b) { return b.count - a.count; });
    });
  };

  /** 估算存储占用（字节） */
  HA.estimateUsage = function () {
    if (typeof navigator === 'undefined' || !navigator.storage
        || typeof navigator.storage.estimate !== 'function') {
      return Promise.resolve(null);
    }
    return navigator.storage.estimate().then(function (estimate) {
      return { usage: estimate.usage || 0, quota: estimate.quota || 0 };
    }).catch(function () { return null; });
  };

  /* ------------------------------------------------------------------ *
   * 写
   * ------------------------------------------------------------------ */

  /**
   * 在一个 readwrite 事务里执行写入，任一条失败就**整体回滚**。
   *
   * ⚠️ 必须自己 try/catch 并 abort。`store.put()` 遇到不可结构化克隆的值
   * （函数、DOM 节点等）会**同步抛错**，异常会直接穿过这个函数 ——
   * 此时事务里已经发出的请求不会被撤销，而是照常提交，
   * 留下一个「写了一半」的库。调用方以为失败即无副作用，实际数据已经坏了。
   *
   * @param {IDBDatabase} db
   * @param {string} storeName
   * @param {(store: IDBObjectStore) => void} mutate 同步发出全部请求
   */
  function atomicWrite(db, storeName, mutate) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);

      try {
        mutate(store);
      } catch (err) {
        try { tx.abort(); } catch (abortErr) { /* 可能已经中止 */ }
        reject(err);
        return;
      }

      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('事务被中止')); };
    });
  }

  /** 新增或整体覆盖一条 */
  HA.putAnnotation = function (annotation) {
    return HA.getDB().then(function (db) {
      return atomicWrite(db, HA.STORE_ANNOTATIONS, function (store) { store.put(annotation); });
    }).then(function () { return annotation; });
  };

  /** 批量写入（同一事务，比逐条 put 快得多；失败整体回滚） */
  HA.putMany = function (annotations) {
    if (!annotations || !annotations.length) return Promise.resolve(0);
    return HA.getDB().then(function (db) {
      return atomicWrite(db, HA.STORE_ANNOTATIONS, function (store) {
        annotations.forEach(function (item) { store.put(item); });
      });
    }).then(function () { return annotations.length; });
  };

  /**
   * 局部更新一条记录。
   * @param {string} id
   * @param {Object} patch 只包含要改的字段
   * @returns {Promise<Object|null>} 更新后的记录；原记录不存在时返回 null
   */
  HA.updateAnnotation = function (id, patch) {
    return HA.getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(HA.STORE_ANNOTATIONS, 'readwrite');
        var store = tx.objectStore(HA.STORE_ANNOTATIONS);
        var updated = null;

        var getRequest = store.get(id);
        getRequest.onsuccess = function () {
          var record = getRequest.result;
          if (!record) return;

          Object.keys(patch || {}).forEach(function (key) {
            // 白名单，并且**显式排除主键**。
            // id 也在 ANNOTATION_FIELDS 里，如果放任 patch 改它，store.put 会因为
            // keyPath 变了而**插入一条新记录**，旧键那份仍然留在库里 ——
            // 一条标注凭空变成两条，而且删掉其中一条另一条还在。
            if (key === 'id') return;
            if (HA.ANNOTATION_FIELDS.indexOf(key) === -1) return;
            record[key] = patch[key];
          });
          if (Array.isArray(patch && patch.tags)) {
            record.tags = HA.normalizeTags(patch.tags);
          }
          record.updatedAt = Date.now();

          store.put(record);
          updated = record;
        };

        tx.oncomplete = function () { resolve(updated); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  };

  /** 删除一条 */
  HA.deleteAnnotation = function (id) {
    return HA.getDB().then(function (db) {
      return atomicWrite(db, HA.STORE_ANNOTATIONS, function (store) { store.delete(id); });
    });
  };

  /** 批量删除 */
  HA.deleteMany = function (ids) {
    if (!ids || !ids.length) return Promise.resolve(0);
    return HA.getDB().then(function (db) {
      return atomicWrite(db, HA.STORE_ANNOTATIONS, function (store) {
        ids.forEach(function (id) { store.delete(id); });
      });
    }).then(function () { return ids.length; });
  };

  /** 清空全部标注（保留 meta 与设置） */
  HA.clearAll = function () {
    return HA.getDB().then(function (db) {
      return atomicWrite(db, HA.STORE_ANNOTATIONS, function (store) { store.clear(); });
    });
  };

  /**
   * 原子替换：清空 + 写入放在**同一个事务**里，失败整体回滚。
   *
   * 为什么不能用 clearAll().then(putMany)：那是两个独立事务，清空一旦提交，
   * 后面写入失败（配额、记录里混入不可克隆的值、SW 恰好被杀）就只剩一个空库 ——
   * 而用户刚才点的正是「用这份备份恢复数据」。
   */
  HA.replaceAll = function (annotations) {
    var list = annotations || [];
    return HA.getDB().then(function (db) {
      return atomicWrite(db, HA.STORE_ANNOTATIONS, function (store) {
        store.clear();
        list.forEach(function (item) { store.put(item); });
      });
    }).then(function () { return list.length; });
  };


  /* ------------------------------------------------------------------ *
   * 网站目录
   * ------------------------------------------------------------------ */

  /** 取全部目录，按创建时间排序 */
  HA.getFolders = function () {
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_FOLDERS, 'readonly');
      return requestToPromise(tx.objectStore(HA.STORE_FOLDERS).getAll());
    }).then(function (rows) {
      return (rows || []).sort(function (a, b) { return a.createdAt - b.createdAt; });
    });
  };

  /** 新建或更新一个目录 */
  HA.putFolder = function (folder) {
    return HA.getDB().then(function (db) {
      return atomicWrite(db, HA.STORE_FOLDERS, function (store) { store.put(folder); });
    }).then(function () { return folder; });
  };

  /** 取单个目录；不存在返回 null */
  HA.getFolder = function (folderId) {
    if (!folderId) return Promise.resolve(null);
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_FOLDERS, 'readonly');
      return requestToPromise(tx.objectStore(HA.STORE_FOLDERS).get(folderId));
    }).then(function (row) { return row || null; });
  };

  /** 取单个网站的归属目录；没有记录返回 null（即位于顶层） */
  HA.getSiteFolder = function (siteKey) {
    if (!siteKey) return Promise.resolve(null);
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_SITE_FOLDERS, 'readonly');
      return requestToPromise(tx.objectStore(HA.STORE_SITE_FOLDERS).get(siteKey));
    }).then(function (row) { return (row && row.folderId) || null; });
  };

  /**
   * 取「网站 → 目录」归属表。
   * @returns {Promise<Map<string, string>>} siteKey → folderId
   */
  HA.getSiteFolders = function () {
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_SITE_FOLDERS, 'readonly');
      return requestToPromise(tx.objectStore(HA.STORE_SITE_FOLDERS).getAll());
    }).then(function (rows) {
      var map = new Map();
      (rows || []).forEach(function (row) {
        if (row && row.siteKey && row.folderId) map.set(row.siteKey, row.folderId);
      });
      return map;
    });
  };

  /**
   * 设置网站的归属目录。
   * @param {string} siteKey
   * @param {string|null} folderId 传 null 表示移回「全部网站」顶层
   */
  HA.setSiteFolder = function (siteKey, folderId) {
    return HA.getDB().then(function (db) {
      return atomicWrite(db, HA.STORE_SITE_FOLDERS, function (store) {
        if (folderId) store.put({ siteKey: siteKey, folderId: folderId });
        else store.delete(siteKey);
      });
    });
  };

  /**
   * 删除一个网站下的全部标注，并清掉它的目录归属。
   *
   * @param {string} siteKey
   * @returns {Promise<{annotations: number}>}
   */
  HA.deleteSite = function (siteKey) {
    if (!siteKey) return Promise.resolve({ annotations: 0 });

    return HA.getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(
          [HA.STORE_ANNOTATIONS, HA.STORE_SITE_FOLDERS],
          'readwrite'
        );
        var annotations = tx.objectStore(HA.STORE_ANNOTATIONS);
        var siteFolders = tx.objectStore(HA.STORE_SITE_FOLDERS);
        var removed = 0;

        siteFolders.delete(siteKey);

        var cursorReq = annotations.index('siteKey').openKeyCursor(IDBKeyRange.only(siteKey));
        cursorReq.onsuccess = function () {
          var cursor = cursorReq.result;
          if (!cursor) return;
          annotations.delete(cursor.primaryKey);
          removed++;
          cursor.continue();
        };

        tx.oncomplete = function () { resolve({ annotations: removed }); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('事务被中止')); };
      });
    });
  };

  /**
   * 删除一个目录，连同其下所有网站的标注。
   *
   * 三件事在**同一个事务**里完成：删目录、删归属记录、删该目录下所有网站的标注。
   * 分三个事务做的话，中途失败会留下「目录没了但标注还在」的悬空数据。
   *
   * @returns {Promise<{sites: number, annotations: number}>}
   */
  HA.deleteFolderDeep = function (folderId) {
    return HA.getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(
          [HA.STORE_FOLDERS, HA.STORE_SITE_FOLDERS, HA.STORE_ANNOTATIONS],
          'readwrite'
        );
        var folders = tx.objectStore(HA.STORE_FOLDERS);
        var siteFolders = tx.objectStore(HA.STORE_SITE_FOLDERS);
        var annotations = tx.objectStore(HA.STORE_ANNOTATIONS);

        var siteKeys = [];
        var removedAnnotations = 0;

        folders.delete(folderId);

        var cursorReq = siteFolders.openCursor();
        cursorReq.onsuccess = function () {
          var cursor = cursorReq.result;
          if (cursor) {
            if (cursor.value && cursor.value.folderId === folderId) {
              siteKeys.push(cursor.value.siteKey);
              cursor.delete();
            }
            cursor.continue();
            return;
          }

          // 归属表走完后，按 siteKey 索引清掉这些网站的全部标注
          var bySite = annotations.index('siteKey');
          siteKeys.forEach(function (key) {
            var delReq = bySite.openKeyCursor(IDBKeyRange.only(key));
            delReq.onsuccess = function () {
              var keyCursor = delReq.result;
              if (!keyCursor) return;
              annotations.delete(keyCursor.primaryKey);
              removedAnnotations++;
              keyCursor.continue();
            };
          });
        };

        tx.oncomplete = function () {
          resolve({ sites: siteKeys.length, annotations: removedAnnotations });
        };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('事务被中止')); };
      });
    });
  };

  /**
   * 恢复目录与网站归属（备份导入用）。
   *
   * - `merge`：保留现有目录，同 id 的目录按备份内容覆盖，归属按备份补齐
   * - `replace`：先清空目录与归属，再写入备份内容
   *
   * 指向不存在目录的归属记录会被丢弃 —— 否则会留下「网站属于一个看不见的目录」
   * 的悬空数据，界面上既找不到也无法解除。
   *
   * @param {Array} folders  [{id, name, createdAt}]
   * @param {Array} siteFolders  [{siteKey, folderId}]
   * @param {{mode?: 'merge'|'replace'}} [options]
   * @returns {Promise<{folders: number, sites: number}>}
   */
  HA.importFolders = function (folders, siteFolders, options) {
    options = options || {};
    var mode = options.mode || 'merge';

    var folderList = (folders || []).filter(function (row) {
      return row && typeof row.id === 'string' && row.id
        && typeof row.name === 'string' && row.name.trim();
    }).map(function (row) {
      return {
        id: row.id,
        name: row.name.trim().slice(0, 80),
        createdAt: typeof row.createdAt === 'number' && isFinite(row.createdAt)
          ? row.createdAt
          : Date.now(),
      };
    });

    var rows = (siteFolders || []).filter(function (row) {
      return row && typeof row.siteKey === 'string' && row.siteKey
        && typeof row.folderId === 'string' && row.folderId;
    });

    return HA.getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([HA.STORE_FOLDERS, HA.STORE_SITE_FOLDERS], 'readwrite');
        var folderStore = tx.objectStore(HA.STORE_FOLDERS);
        var mapStore = tx.objectStore(HA.STORE_SITE_FOLDERS);
        var applied = 0;

        if (mode === 'replace') {
          folderStore.clear();
          mapStore.clear();
        }

        // 先拿到「合并后」的目录 id 集合，才能判断归属记录是否悬空
        var keysReq = folderStore.getAllKeys();
        keysReq.onsuccess = function () {
          var alive = new Set(keysReq.result || []);

          folderList.forEach(function (folder) {
            folderStore.put(folder);
            alive.add(folder.id);
          });

          rows.forEach(function (row) {
            if (!alive.has(row.folderId)) return;
            mapStore.put({ siteKey: row.siteKey, folderId: row.folderId });
            applied++;
          });
        };

        tx.oncomplete = function () {
          resolve({ folders: folderList.length, sites: applied });
        };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('事务被中止')); };
      });
    });
  };

  /**
   * 清空全部目录与归属（「清空全部数据」用）。
   * 两个 store 必须在同一个事务里清，否则中途失败会留下「有归属没目录」的悬空数据。
   */
  HA.clearFolders = function () {
    return HA.getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([HA.STORE_FOLDERS, HA.STORE_SITE_FOLDERS], 'readwrite');
        tx.objectStore(HA.STORE_FOLDERS).clear();
        tx.objectStore(HA.STORE_SITE_FOLDERS).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('事务被中止')); };
      });
    });
  };

  /* ------------------------------------------------------------------ *
   * meta 表（schemaVersion、上次备份时间等）
   * ------------------------------------------------------------------ */

  HA.getMeta = function (key, fallback) {
    return HA.getDB().then(function (db) {
      var tx = db.transaction(HA.STORE_META, 'readonly');
      return requestToPromise(tx.objectStore(HA.STORE_META).get(key));
    }).then(function (row) {
      return row && row.value !== undefined ? row.value : fallback;
    });
  };

  HA.setMeta = function (key, value) {
    return HA.getDB().then(function (db) {
      return atomicWrite(db, HA.STORE_META, function (store) {
        store.put({ key: key, value: value });
      });
    });
  };

  /* ------------------------------------------------------------------ *
   * 导出 / 导入
   * ------------------------------------------------------------------ */

  /** 取出全部记录（导出用）。分批读取，避免一次性占满内存。 */
  HA.getAllForExport = function () {
    return HA.getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(HA.STORE_ANNOTATIONS, 'readonly');
        var store = tx.objectStore(HA.STORE_ANNOTATIONS);
        var out = [];
        var cursorRequest = store.openCursor();

        cursorRequest.onsuccess = function () {
          var cursor = cursorRequest.result;
          if (!cursor) return;
          out.push(cursor.value);
          cursor.continue();
        };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  };

  /**
   * 导入记录。
   *
   * @param {Array} records
   * @param {{mode: 'merge'|'replace'}} [options]
   *        merge   —— 同 id 覆盖，其余保留（默认）
   *        replace —— 先清空再导入
   * @returns {Promise<{imported: number, skipped: number, errors: string[]}>}
   */
  HA.importAnnotations = function (records, options) {
    options = options || {};
    var mode = options.mode === 'replace' ? 'replace' : 'merge';

    var prepared = [];
    var errors = [];
    var skipped = 0;

    (records || []).forEach(function (raw, index) {
      var normalized = HA.normalizeAnnotation(raw);
      if (normalized.errors.length) {
        errors.push('第 ' + (index + 1) + ' 条：' + normalized.errors.join('；'));
      }
      if (!normalized.annotation) {
        skipped++;
        return;
      }
      var validation = HA.validateAnnotation(normalized.annotation);
      if (validation.length) {
        errors.push('第 ' + (index + 1) + ' 条：' + validation.join('；'));
        skipped++;
        return;
      }
      prepared.push(normalized.annotation);
    });

    var chain = mode === 'replace'
      ? HA.replaceAll(prepared)
      : HA.putMany(prepared);

    return chain.then(function () {
      return { imported: prepared.length, skipped: skipped, errors: errors };
    });
  };

})(globalThis.HA || (globalThis.HA = {}));
