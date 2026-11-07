'use strict';
/**
 * JSON 全量备份与恢复。
 *
 * 这是「卸载扩展前保住数据」的唯一手段 —— 扩展 origin 的存储在卸载时会一并消失
 * （好消息是它不会被「清除浏览数据」清掉，那是有官方文档背书的）。
 *
 * 备份文件带 format 标记与两层版本号：
 *   - `format`      防止把别的 JSON 误当备份导入
 *   - `version`     备份文件格式自身的版本
 *   - `schemaVersion` 记录结构版本，导入时据此决定要不要跑迁移
 */
(function (HA) {

  var FORMAT = 'web-highlight-annotate-backup';
  var BACKUP_VERSION = 1;

  /** 目录归属表统一序列化成数组（内存里是 Map，备份文件里要能直接看懂） */
  function siteFolderRows(siteFolders) {
    var rows = [];
    if (!siteFolders) return rows;

    if (typeof siteFolders.forEach === 'function' && typeof siteFolders.get === 'function') {
      siteFolders.forEach(function (folderId, siteKey) {
        rows.push({ siteKey: siteKey, folderId: folderId });
      });
    } else if (Array.isArray(siteFolders)) {
      siteFolders.forEach(function (row) {
        if (row && row.siteKey && row.folderId) {
          rows.push({ siteKey: row.siteKey, folderId: row.folderId });
        }
      });
    }

    return rows.sort(function (a, b) { return a.siteKey.localeCompare(b.siteKey); });
  }

  /**
   * 生成备份对象。
   *
   * @param {Array} annotations
   * @param {{settings?: Object, folders?: Array, siteFolders?: Map|Array}} [options]
   */
  HA.buildBackup = function (annotations, options) {
    options = options || {};
    var list = annotations || [];

    var backup = {
      format: FORMAT,
      version: BACKUP_VERSION,
      schemaVersion: HA.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
        ? chrome.runtime.getManifest().version
        : null,
      count: list.length,
      annotations: list,
    };

    if (options.settings) backup.settings = options.settings;

    // 只有调用方显式提供目录时才写这两个字段。
    // 旧版备份里没有它们，恢复时据此判断「这份备份根本不包含目录信息」，
    // 从而不会在 replace 模式下误清空用户现有的目录。
    if (options.folders || options.siteFolders) {
      backup.folders = options.folders || [];
      backup.siteFolders = siteFolderRows(options.siteFolders);
    }

    return backup;
  };

  /** 序列化成可写盘的字符串（缩进 2 空格，便于人工查看与 diff） */
  HA.serializeBackup = function (annotations, options) {
    return JSON.stringify(HA.buildBackup(annotations, options), null, 2);
  };

  /** 建议的文件名 */
  HA.suggestBackupFilename = function () {
    return '网页标注备份-' + HA.formatDate(Date.now()) + '.json';
  };

  /**
   * 解析备份文件。
   *
   * 容错策略：**尽量导入能导入的部分，把问题作为警告报出来**，
   * 而不是因为一条坏记录就整体失败 —— 用户手里只有这一份备份时，
   * 整体拒绝等于让他彻底丢数据。
   *
   * @param {string} text
   * @returns {{annotations: Array, settings: Object|null, folders: Array|null,
   *            siteFolders: Array|null, warnings: string[], info: Object}}
   * @throws {Error} 只有在文件根本不是 JSON、或明显不是本扩展的备份时才抛
   */
  HA.parseBackup = function (text) {
    var warnings = [];

    var raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error('不是合法的 JSON 文件：' + err.message);
    }

    var annotations;
    var info = {};

    if (Array.isArray(raw)) {
      // 接受「就是一个数组」的裸格式 —— 可能是从别处导出的
      annotations = raw;
      warnings.push('文件是裸数组格式，已按标注列表处理。');
    } else if (raw && typeof raw === 'object') {
      if (raw.format && raw.format !== FORMAT) {
        throw new Error('这不是本扩展的备份文件（format 为 ' + JSON.stringify(raw.format) + '）');
      }
      if (!raw.format) {
        warnings.push('文件缺少 format 标记，仍尝试按备份格式解析。');
      }

      info = {
        version: raw.version,
        schemaVersion: raw.schemaVersion,
        exportedAt: raw.exportedAt,
        appVersion: raw.appVersion,
        declaredCount: raw.count,
      };

      if (raw.schemaVersion && raw.schemaVersion > HA.SCHEMA_VERSION) {
        warnings.push(
          '备份来自更新的版本（schemaVersion ' + raw.schemaVersion
          + '，当前 ' + HA.SCHEMA_VERSION + '），未知字段会被忽略。'
        );
      }

      if (!Array.isArray(raw.annotations)) {
        throw new Error('备份文件里没有 annotations 数组');
      }
      annotations = raw.annotations;

      if (typeof raw.count === 'number' && raw.count !== annotations.length) {
        warnings.push(
          '文件声明的条数（' + raw.count + '）与实际条数（'
          + annotations.length + '）不一致。'
        );
      }
    } else {
      throw new Error('无法识别的备份文件结构');
    }

    var folders = null;
    var siteFolders = null;

    if (raw && !Array.isArray(raw)) {
      if (raw.folders !== undefined) {
        if (Array.isArray(raw.folders)) folders = raw.folders;
        else warnings.push('备份里的 folders 不是数组，已忽略。');
      }
      if (raw.siteFolders !== undefined) {
        if (Array.isArray(raw.siteFolders)) siteFolders = raw.siteFolders;
        else warnings.push('备份里的 siteFolders 不是数组，已忽略。');
      }
    }

    return {
      annotations: annotations,
      settings: (raw && !Array.isArray(raw) && raw.settings) || null,
      folders: folders,
      siteFolders: siteFolders,
      warnings: warnings,
      info: info,
    };
  };

})(globalThis.HA || (globalThis.HA = {}));
