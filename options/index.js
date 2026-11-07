'use strict';
/**
 * 设置页。
 *
 * 这里也直接读写 IndexedDB（与 service worker 同源）。
 * 数据管理与备份放在这一页而不是管理页，是因为「我的数据在哪、会不会丢」
 * 是设置类问题，放在这里更符合直觉。
 */
(function (HA) {

  var state = {
    settings: null,
    stats: { count: 0, sites: 0, usage: null },
    lastBackupAt: null,
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ================================================================== *
   * 小工具
   * ================================================================== */

  /* 界面小工具来自共用模块 lib/ui-kit.js（在脚本列表里先于本文件加载） */
  var el = HA.UIKit.el;
  var toast = HA.UIKit.toast;
  var openDialog = HA.UIKit.openDialog;

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function formatRelative(timestamp) {
    if (!timestamp) return HA.I18n.t('options.neverBackedUp');
    var days = Math.floor((Date.now() - timestamp) / 86400000);
    if (days <= 0) return HA.I18n.t('options.backedUpToday');
    if (days === 1) return HA.I18n.t('options.backedUpYesterday');
    if (days < 30) return HA.I18n.t('options.backedUpDays', { n: days });
    return HA.I18n.t('options.backedUpMonths', { n: Math.floor(days / 30) });
  }

  /* ================================================================== *
   * 渲染
   * ================================================================== */

  function renderTriggerMode() {
    var buttons = document.querySelectorAll('#trigger-mode .chip');
    Array.prototype.forEach.call(buttons, function (button) {
      button.setAttribute('aria-pressed',
        String(button.dataset.value === state.settings.triggerMode));
    });

    // 说明文案里直接写出实际的修饰键 —— 「按住修饰键」太抽象，用户不知道是哪个
    var resolved = HA.resolveModifier(state.settings);
    var isMac = HA.isMac();
    var keyNames = { ctrl: 'Ctrl', meta: isMac ? 'Cmd' : 'Win', alt: isMac ? 'Option' : 'Alt' };
    var key = keyNames[resolved] || '';

    var hints = {
      instant: HA.I18n.t(key ? 'options.triggerInstantHintKey' : 'options.triggerInstantHint', { key: key }),
      // 工具条模式不要求修饰键，所以这里不用带 {key} 的版本
      toolbar: HA.I18n.t('options.triggerToolbarHint'),
      off: HA.I18n.t('options.triggerOffHint'),
    };
    $('trigger-hint').textContent = hints[state.settings.triggerMode] || '';
  }

  function renderModifier() {
    var select = $('modifier');
    select.value = state.settings.modifier;

    // 修饰键只服务于「选中即高亮」。工具条模式不要求修饰键；
    // 两个都不选时更用不上，直接禁用并压暗整行。
    var active = state.settings.triggerMode === 'instant';
    select.disabled = !active;
    var row = select.closest('.setting');
    if (row) row.classList.toggle('is-disabled', !active);

    var isMac = HA.isMac();
    var resolved = HA.resolveModifier(state.settings);
    var names = {
      ctrl: 'Ctrl', meta: isMac ? 'Cmd' : 'Win', alt: 'Alt / Option',
      none: HA.I18n.t('options.modifierNoneShort'),
    };

    if (!active) {
      $('modifier-hint').textContent = HA.I18n.t('options.modifierInactiveHint');
    } else {
      var hints = {
        auto: HA.I18n.t('options.modifierAutoHint', { key: names[resolved] || resolved }),
        none: HA.I18n.t('options.modifierNoneHint'),
      };
      $('modifier-hint').textContent = hints[state.settings.modifier]
        || HA.I18n.t('options.modifierHint');
    }

    $('kbd-modifier').textContent = names[resolved] && resolved !== 'none' ? names[resolved] : HA.I18n.t('options.noKey');
  }

  function renderColors() {
    var host = $('colors');
    host.textContent = '';

    HA.PALETTE.forEach(function (color) {
      var button = el('button', 'swatch-btn');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', color.label);
      button.setAttribute('title', color.label);
      button.setAttribute('aria-pressed', String(state.settings.defaultColor === color.id));

      var swatch = el('span', 'swatch');
      swatch.style.background = color.light;
      button.appendChild(swatch);

      button.addEventListener('click', function () {
        update({ defaultColor: color.id });
      });
      host.appendChild(button);
    });
  }

  function renderStats() {
    $('stat-count').textContent = state.stats.count;
    $('stat-sites').textContent = state.stats.sites;
    $('stat-usage').textContent = state.stats.usage ? formatBytes(state.stats.usage) : '—';

    var badge = $('backup-age');
    badge.textContent = formatRelative(state.lastBackupAt);
    var stale = !state.lastBackupAt
      || (Date.now() - state.lastBackupAt) > 30 * 86400000;
    badge.classList.toggle('is-stale', stale && state.stats.count > 0);
  }

  /** 说明数据在磁盘上的实际位置。
   *  这个信息对用户判断「会不会占系统盘、备份该拷哪个目录」很实用。 */
  function renderStoragePath() {
    var extId = chrome.runtime.id;
    $('ext-id').textContent = extId;

    var platform = (navigator.userAgentData && navigator.userAgentData.platform)
      || navigator.platform || '';
    var relative = '<profile>/IndexedDB/chrome-extension_' + extId + '_0.indexeddb.leveldb';

    var prefix;
    if (/mac/i.test(platform)) {
      prefix = '~/Library/Application Support/Google/Chrome/';
    } else if (/win/i.test(platform)) {
      prefix = '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\';
    } else {
      prefix = '~/.config/google-chrome/';
    }

    $('storage-path').textContent = prefix + relative;
  }

  /* ================================================================== *
   * 更新设置
   * ================================================================== */

  function update(patch) {
    return HA.updateSettings(patch).then(function (next) {
      state.settings = next;

      // 语言可能变了 —— 立即重新应用全部静态文案
      if (HA.I18n.setLocale(HA.I18n.resolve(next.language))) {
        HA.I18n.apply(document);
      }

      renderTriggerMode();
      renderModifier();
      renderColors();
      $('underline').checked = next.underline;
      $('show-orphans').checked = next.showOrphans;
      $('language').value = next.language || 'auto';
    }).catch(function (err) {
      toast(HA.I18n.t('options.settingsSaveFailed', { message: err.message }), { error: true });
    });
  }

  /* ================================================================== *
   * 数据操作
   * ================================================================== */

  function loadStats() {
    return Promise.all([
      HA.countAll(),
      HA.statsBySite(),
      HA.estimateUsage(),
      HA.getMeta('lastBackupAt', null),
    ]).then(function (results) {
      state.stats.count = results[0];
      state.stats.sites = results[1].length;
      state.stats.usage = results[2] ? results[2].usage : null;
      state.lastBackupAt = results[3];
      renderStats();
    });
  }

  function backup() {
    return Promise.all([
      HA.getAllForExport(),
      HA.getFolders(),
      HA.getSiteFolders(),
    ]).then(function (results) {
      var annotations = results[0];
      if (!annotations.length) {
        toast(HA.I18n.t('options.noBackupData'));
        return;
      }

      var filename = HA.suggestBackupFilename();
      var getChunks = function () {
        return [HA.serializeBackup(annotations, {
          settings: state.settings,
          folders: results[1],
          siteFolders: results[2],
        })];
      };

      if (!HA.FSSave.isPickerSupported()) {
        return HA.FSSave.saveViaDownload({
          filename: filename,
          mimeType: 'application/json',
          text: getChunks()[0],
        }).then(function (result) {
          if (result.saved) {
            return HA.setMeta('lastBackupAt', Date.now()).then(function () {
              loadStats();
              toast(HA.I18n.t('options.backupDone'));
            });
          }
          toast(HA.I18n.t('options.backupFailed', { message: result.reason || HA.I18n.t('common.unknownReason') }), { error: true });
        });
      }

      return HA.FSSave.save({
        suggestedName: filename,
        mimeType: 'application/json',
        extension: '.json',
        description: HA.I18n.t('options.backupFileDesc'),
        rememberKey: 'backupFileHandle',
        getChunks: getChunks,
      }).then(function (result) {
        if (result.cancelled) return;
        if (!result.saved) {
          toast(HA.I18n.t('options.backupFailed', { message: result.reason || HA.I18n.t('common.unknownReason') }), { error: true });
          return;
        }
        return HA.setMeta('lastBackupAt', Date.now()).then(function () {
          loadStats();
          toast(HA.I18n.t('options.backupDoneN', { n: annotations.length }));
        });
      });
    }).catch(function (err) {
      toast(HA.I18n.t('options.backupFailed', { message: err.message }), { error: true });
    });
  }

  function restore() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;

      file.text().then(function (text) {
        var parsed;
        try {
          parsed = HA.parseBackup(text);
        } catch (err) {
          toast(HA.I18n.t('options.cannotReadBackup', { message: err.message }), { error: true, duration: 9000 });
          return;
        }
        confirmRestore(parsed);
      });
    });
    input.click();
  }

  function confirmRestore(parsed) {
    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title', HA.I18n.t('options.restoreTitle')));

      var body = el('div', 'dialog-body');
      body.appendChild(el('p', null,
        HA.I18n.t('options.restoreIntro', {
          n: parsed.annotations.length,
          exported: parsed.info.exportedAt
            ? HA.I18n.t('options.restoreExported', {
                date: HA.formatDateTime(Date.parse(parsed.info.exportedAt)),
              })
            : '',
        })));

      if (parsed.warnings.length) {
        var list = el('ul');
        list.style.marginTop = '10px';
        list.style.paddingLeft = '18px';
        parsed.warnings.forEach(function (warning) {
          list.appendChild(el('li', 'muted', warning));
        });
        body.appendChild(list);
      }
      dialog.appendChild(body);

      var mode = 'merge';

      var group = el('div');
      group.style.marginTop = '16px';
      group.appendChild(el('div', 'eyebrow', HA.I18n.t('options.restoreMode')));

      var row = el('div', 'row');
      row.style.marginTop = '7px';
      row.style.flexWrap = 'wrap';

      [[HA.I18n.t('options.merge'), 'merge'], [HA.I18n.t('options.replace'), 'replace']]
        .forEach(function (pair) {
          var chip = el('button', 'chip', pair[1]);
          chip.type = 'button';
          chip.setAttribute('aria-pressed', String(pair[0] === mode));
          chip.addEventListener('click', function () {
            mode = pair[0];
            Array.prototype.forEach.call(row.children, function (other) {
              other.setAttribute('aria-pressed', String(other === chip));
            });
          });
          row.appendChild(chip);
        });

      group.appendChild(row);
      dialog.appendChild(group);

      var actions = el('div', 'dialog-actions');

      var cancel = el('button', 'btn', HA.I18n.t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      actions.appendChild(cancel);

      var confirm = el('button', 'btn btn-primary', HA.I18n.t('options.startRestore'));
      confirm.type = 'button';
      confirm.addEventListener('click', function () {
        close();
        var withFolders = parsed.folders !== null || parsed.siteFolders !== null;
        HA.importAnnotations(parsed.annotations, { mode: mode }).then(function (result) {
          var foldersTask = withFolders
            ? HA.importFolders(parsed.folders || [], parsed.siteFolders || [], { mode: mode })
            : Promise.resolve();
          return foldersTask.then(function () {
            return HA.getSettings().then(function (current) {
              state.settings = current;
              return loadStats();
            }).then(function () {
              var message = HA.I18n.t('options.importedN', { n: result.imported });
              if (result.skipped) message += HA.I18n.t('options.skippedN', { n: result.skipped });
              toast(message, { duration: result.errors.length ? 9000 : 4000 });
              if (result.errors.length) console.warn('[HA] 导入时的问题：', result.errors);
            });
          });
        }).catch(function (err) {
          toast(HA.I18n.t('options.restoreFailed', { message: err.message }), { error: true });
        });
      });
      actions.appendChild(confirm);

      dialog.appendChild(actions);
    });
  }

  function clearAll() {
    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title', HA.I18n.t('options.clearTitle')));

      var body = el('div', 'dialog-body');
      body.appendChild(el('p', null,
        HA.I18n.t('options.clearWarn', { n: state.stats.count })));
      body.appendChild(el('p', 'muted',
        HA.I18n.t('options.clearWarn2')));
      dialog.appendChild(body);

      var actions = el('div', 'dialog-actions');

      var cancel = el('button', 'btn', HA.I18n.t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      actions.appendChild(cancel);

      var backupFirst = el('button', 'btn', HA.I18n.t('common.backupFirst'));
      backupFirst.type = 'button';
      backupFirst.addEventListener('click', function () {
        close();
        backup();
      });
      actions.appendChild(backupFirst);

      var confirm = el('button', 'btn btn-primary', HA.I18n.t('options.confirmClear'));
      confirm.type = 'button';
      confirm.addEventListener('click', function () {
        close();
        HA.clearAll()
          .then(function () { return HA.clearFolders(); })
          .then(function () { return HA.resetSettings(); })
          .then(function () { return HA.setMeta('lastBackupAt', null); })
          .then(function () {
            return HA.getSettings().then(function (next) {
              state.settings = next;
              state.lastBackupAt = null;
              renderTriggerMode();
              renderModifier();
              renderColors();
              $('underline').checked = next.underline;
              $('show-orphans').checked = next.showOrphans;
              return loadStats();
            });
          })
          .then(function () { toast(HA.I18n.t('options.cleared')); })
          .catch(function (err) { toast(HA.I18n.t('options.clearFailed', { message: err.message }), { error: true }); });

        // 设置页也是扩展页面，直连 IndexedDB 绕过了 Repo，
        // 所以清空后要主动喊一声让各标签页同步
        HA.sendToBackground({ type: HA.MSG.BROADCAST, change: { kind: 'cleared', urlKey: null, ids: [] } })
          .catch(function () { /* 广播失败不影响清空本身 */ });
      });
      actions.appendChild(confirm);

      dialog.appendChild(actions);
    });
  }

  /* ================================================================== *
   * 事件
   * ================================================================== */

  function bind() {
    $('trigger-mode').addEventListener('click', function (event) {
      var button = event.target.closest('.chip');
      if (!button) return;
      // 再点一次已选中的模式 = 两个都不选 → 只保留右键菜单 / 快捷键
      var value = button.dataset.value;
      update({ triggerMode: state.settings.triggerMode === value ? 'off' : value });
    });

    $('modifier').addEventListener('change', function (event) {
      update({ modifier: event.target.value });
    });

    $('underline').addEventListener('change', function (event) {
      update({ underline: event.target.checked });
    });

    $('show-orphans').addEventListener('change', function (event) {
      update({ showOrphans: event.target.checked });
    });

    $('language').addEventListener('change', function (event) {
      update({ language: event.target.value });
    });

    $('btn-backup').addEventListener('click', backup);
    $('btn-restore').addEventListener('click', restore);
    $('btn-clear').addEventListener('click', clearAll);

    $('btn-copy-path').addEventListener('click', function () {
      var text = $('storage-path').textContent;
      navigator.clipboard.writeText(text).then(function () {
        toast(HA.I18n.t('options.copyPathDone'));
      }).catch(function () {
        toast(HA.I18n.t('options.copyFailed'), { error: true });
      });
    });
  }

  /* ================================================================== *
   * 启动
   * ================================================================== */

  function start() {
    bind();

    HA.getSettings().then(function (settings) {
      state.settings = settings;

      // 先确定界面语言，再渲染任何文案
      HA.I18n.setLocale(HA.I18n.resolve(settings.language));
      HA.I18n.apply(document);

      renderStoragePath();
      renderTriggerMode();
      renderModifier();
      renderColors();
      $('underline').checked = settings.underline;
      $('show-orphans').checked = settings.showOrphans;
      $('language').value = settings.language || 'auto';

      loadStats().catch(function (err) {
        console.error('[HA] 读取统计失败：', err);
      });
    }).catch(function (err) {
      console.error('[HA] 设置页初始化失败：', err);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

})(globalThis.HA || (globalThis.HA = {}));
