'use strict';
/**
 * 管理页。
 *
 * 这一页直接读写 IndexedDB —— 扩展页面与 service worker 同源，共享同一个数据库，
 * 不需要经过消息往返。（只有 content script 才必须走消息，因为它的存储属于宿主页面。）
 *
 * 全量加载而不是分页：个人使用量级（几千条）在内存里就是几 MB，
 * 换来做筛选/搜索的即时响应很划算。真到几万条时需要改成游标分页 + 虚拟列表。
 */
(function (HA) {

  /* ================================================================== *
   * 状态
   * ================================================================== */

  /** 「全部网站」节点的展开键。目录 id 都以 f_ 开头，不会撞上 */
  var ALL_FOLDER = '__all__';

  var state = {
    all: [],              // 全部标注
    sites: [],            // [{siteKey, count, newest}]
    folders: [],          // [{id, name, createdAt}]
    siteFolders: new Map(), // siteKey → folderId（没有记录就位于全部网站顶层）
    expanded: new Set([ALL_FOLDER]),
    filter: { search: '', siteKey: null, tag: null, color: null, folderId: null },
    settings: null,
    /** 已勾选的标注 id。按 id 而不是索引存，这样筛选变化后选择不会错位 */
    selected: new Set(),
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ================================================================== *
   * 小工具
   * ================================================================== */

  /* 界面小工具来自共用模块 lib/ui-kit.js（在脚本列表里先于本文件加载） */
  var el = HA.UIKit.el;
  var toast = HA.UIKit.toast;
  var openDialog = HA.UIKit.openDialog;

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  /** 目录结构变化：通知设置页/侧边栏刷新，标注本身没变 */
  function broadcastFolders() {
    broadcast({ kind: 'folders', urlKey: null, ids: [] });
  }

  /**
   * 管理页是扩展页面，直连 IndexedDB（与 SW 同源），**绕过了 Repo** ——
   * 所以改完数据必须主动喊一声，否则已经打开的网页上高亮不会消失、
   * 工具栏徽标不更新、侧边栏还显示已删的条目。
   */
  function broadcast(change) {
    return HA.sendToBackground({ type: HA.MSG.BROADCAST, change: change })
      .catch(function () { /* 广播失败不影响主流程 */ });
  }

  /* ================================================================== *
   * 加载
   * ================================================================== */

  /** 站点 / 标签统计都从已加载的标注里现算 —— 数据量级小，省两次整表扫描 */
  function computeSiteStats(list) {
    var map = new Map();
    list.forEach(function (item) {
      var key = item.siteKey || '';
      var entry = map.get(key);
      if (!entry) {
        entry = { siteKey: key, count: 0, newest: 0 };
        map.set(key, entry);
      }
      entry.count++;
      if (item.createdAt > entry.newest) entry.newest = item.createdAt;
    });
    return Array.from(map.values()).sort(function (a, b) {
      return b.count - a.count || a.siteKey.localeCompare(b.siteKey);
    });
  }

  function computeTagStats(list) {
    var counts = new Map();
    list.forEach(function (item) {
      (item.tags || []).forEach(function (tag) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      });
    });
    return Array.from(counts.entries())
      .map(function (pair) { return { tag: pair[0], count: pair[1] }; })
      .sort(function (a, b) { return b.count - a.count || a.tag.localeCompare(b.tag); });
  }

  function loadAll() {
    return Promise.all([
      HA.query({ sort: 'newest' }),
      HA.getFolders(),
      HA.getSiteFolders(),
      HA.getSettings(),
    ]).then(function (results) {
      state.all = results[0];
      state.folders = results[1];
      state.siteFolders = results[2];
      state.settings = results[3];
      state.sites = computeSiteStats(state.all);
    });
  }

  function refresh() {
    return loadAll().then(function () {
      // 选中项可能在别处被删掉了，清掉那些已经不存在的 id
      var alive = new Set(state.all.map(function (a) { return a.id; }));
      Array.from(state.selected).forEach(function (id) {
        if (!alive.has(id)) state.selected.delete(id);
      });

      // 目录被别处删掉后，当前筛选可能指向已经不存在的东西
      if (state.filter.folderId
          && !state.folders.some(function (f) { return f.id === state.filter.folderId; })) {
        state.filter.folderId = null;
      }
      if (state.filter.siteKey
          && !state.sites.some(function (s) { return s.siteKey === state.filter.siteKey; })) {
        state.filter.siteKey = null;
      }

      renderRail();
      renderContent();
      renderTotal();
      renderSelectionBar();
    });
  }

  /* ================================================================== *
   * 顶栏
   * ================================================================== */

  function renderTotal() {
    var node = $('total-count');
    var filtered = applyFilter().length;
    var total = state.all.length;

    if (!total) {
      node.textContent = '';
      return;
    }
    node.textContent = filtered === total
      ? HA.I18n.t('manager.countSuffix', { n: total })
      : filtered + ' / ' + HA.I18n.t('manager.countSuffix', { n: total });
  }

  /* ================================================================== *
   * 目录与筛选
   * ================================================================== */

  /** 网站所属目录；没有归属记录就是直接挂在「全部网站」下 */
  function folderIdOfSite(siteKey) {
    return state.siteFolders.get(siteKey) || null;
  }

  /** 没有归入任何目录的网站 */
  function unfiledSites() {
    return state.sites.filter(function (site) {
      return !state.siteFolders.has(site.siteKey);
    });
  }

  function folderLabel(folderId) {
    var found = null;
    state.folders.forEach(function (folder) {
      if (folder.id === folderId) found = folder;
    });
    return found ? found.name : HA.I18n.t('folder.topLevel');
  }

  /** 某个目录下的网站与标注数量 */
  function folderStats(folderId) {
    var sites = state.sites.filter(function (site) {
      return folderIdOfSite(site.siteKey) === folderId;
    });
    var count = sites.reduce(function (sum, site) { return sum + site.count; }, 0);
    return { sites: sites, count: count };
  }

  /**
   * 目录 + 网站的范围，不含搜索、标签、颜色。
   * 标签和颜色列表按这个范围统计 —— 它们只在当前目录内部生效。
   */
  function scopeList() {
    var folderId = state.filter.folderId || null;
    var siteKey = state.filter.siteKey;
    return state.all.filter(function (item) {
      if (folderId !== null && folderIdOfSite(item.siteKey) !== folderId) return false;
      if (siteKey && item.siteKey !== siteKey) return false;
      return true;
    });
  }

  function applyFilter() {
    var folderId = state.filter.folderId || null;
    var list = folderId === null
      ? state.all
      : state.all.filter(function (item) { return folderIdOfSite(item.siteKey) === folderId; });
    return HA.applyFilters(list, state.filter);
  }

  function hasActiveFilter() {
    var f = state.filter;
    return !!(f.search || f.siteKey || f.tag || f.color);
  }

  function describeFilter() {
    var parts = [];
    var f = state.filter;
    if (f.folderId) parts.push(HA.I18n.t('manager.filterFolder', { name: folderLabel(f.folderId) }));
    if (f.search) parts.push(HA.I18n.t('manager.searchTag', { query: f.search }));
    if (f.siteKey) parts.push(f.siteKey);
    if (f.tag) parts.push(HA.I18n.t('manager.filterTag', { tag: f.tag }));
    if (f.color) parts.push(HA.I18n.t('manager.filterColor', { color: HA.I18n.t('color.' + HA.getColor(f.color).id) }));
    return parts.join(' · ');
  }

  function clearFilter() {
    // 保留目录：清除筛选是「看这个目录的全部内容」，不是退出目录
    Object.assign(state.filter, { search: '', siteKey: null, tag: null, color: null });
    $('search').value = '';
    renderRail();
    renderContent();
    renderTotal();
  }

  function setFilter(patch) {
    Object.assign(state.filter, patch);
    renderRail();
    renderContent();
    renderTotal();
  }

  function selectFolder(folderId) {
    state.filter.folderId = folderId;
    state.filter.siteKey = null;
    // 所有目录都挂在「全部网站」下，父节点必须展开才能看到
    state.expanded.add(ALL_FOLDER);
    if (folderId !== null) state.expanded.add(folderId);
    renderRail();
    renderContent();
    renderTotal();
  }

  function toggleExpanded(key) {
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    renderFolders();
  }

  /* ================================================================== *
   * 左侧导航
   * ================================================================== */

  function renderRail() {
    renderFolders();
    renderTags();
    renderColors();
  }

  /**
   * 只有一个顶层节点「全部网站」：
   * 没有归属目录的网站直接挂在它下面，自定义目录则作为它的子目录。
   */
  function renderFolders() {
    var list = $('folder-list');
    list.textContent = '';

    var item = el('li', 'rail-node');
    var row = el('div', 'rail-row');
    var current = state.filter.folderId === null && !state.filter.siteKey;
    if (current) row.classList.add('is-current');

    var expanded = state.expanded.has(ALL_FOLDER);
    row.appendChild(railCaret(expanded, function () { toggleExpanded(ALL_FOLDER); }));

    var button = el('button', 'rail-item');
    button.type = 'button';
    button.title = HA.I18n.t('folder.all');
    button.setAttribute('aria-current', String(current));
    button.appendChild(el('span', 'rail-item-name', HA.I18n.t('folder.all')));
    // 数字表示目录里的网站数，不是标注数；顶层包含所有子目录里的网站
    button.appendChild(el('span', 'rail-item-count', String(state.sites.length)));
    button.addEventListener('click', function () { selectFolder(null); });
    row.appendChild(button);
    row.appendChild(el('span', 'rail-actions'));

    item.appendChild(row);

    if (expanded) {
      var sub = el('ul', 'rail-sublist');

      state.folders.forEach(function (folder) {
        sub.appendChild(buildFolderNode(folder));
      });

      var loose = unfiledSites();
      loose.forEach(function (site) {
        sub.appendChild(renderSiteRow(site, null));
      });

      if (!state.folders.length && !loose.length) {
        sub.appendChild(el('li', 'rail-empty', HA.I18n.t('folder.emptyAll')));
      }

      item.appendChild(sub);
    }

    list.appendChild(item);
  }

  function railCaret(expanded, onToggle) {
    var caret = el('button', 'rail-caret', expanded ? '▾' : '▸');
    caret.type = 'button';
    caret.setAttribute('aria-expanded', String(expanded));
    caret.setAttribute('aria-label',
      HA.I18n.t(expanded ? 'folder.collapse' : 'folder.expand'));
    caret.addEventListener('click', function (event) {
      event.stopPropagation();
      onToggle();
    });
    return caret;
  }

  /** 自定义目录节点：折叠箭头 + 名称 + 数量 + 改名/删除 */
  function buildFolderNode(folder) {
    var stats = folderStats(folder.id);
    var item = el('li', 'rail-node');

    var row = el('div', 'rail-row');
    var current = state.filter.folderId === folder.id && !state.filter.siteKey;
    if (current) row.classList.add('is-current');

    var expanded = state.expanded.has(folder.id);
    row.appendChild(railCaret(expanded, function () { toggleExpanded(folder.id); }));

    var button = el('button', 'rail-item');
    button.type = 'button';
    button.title = folder.name;
    button.setAttribute('aria-current', String(current));
    button.appendChild(el('span', 'rail-item-name', folder.name));
    button.appendChild(el('span', 'rail-item-count', String(stats.sites.length)));
    button.addEventListener('click', function () { selectFolder(folder.id); });
    row.appendChild(button);

    var actions = el('span', 'rail-actions');
    actions.appendChild(railAction('✎', HA.I18n.t('folder.rename'), function () {
      openRenameFolderDialog(folder);
    }));
    actions.appendChild(railAction('×', HA.I18n.t('folder.delete'), function () {
      confirmDeleteFolder(folder);
    }));
    row.appendChild(actions);

    item.appendChild(row);

    if (expanded) {
      var sub = el('ul', 'rail-sublist');
      if (!stats.sites.length) {
        sub.appendChild(el('li', 'rail-empty', HA.I18n.t('folder.empty')));
      } else {
        stats.sites.forEach(function (site) {
          sub.appendChild(renderSiteRow(site, folder.id));
        });
      }
      item.appendChild(sub);
    }

    return item;
  }

  function railAction(glyph, label, onClick) {
    var button = el('button', 'rail-action', glyph);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  /**
   * 网站行。
   * @param {string|null} parentFolderId 所属目录；null 表示直接挂在「全部网站」下
   */
  function renderSiteRow(site, parentFolderId) {
    var label = site.siteKey || HA.I18n.t('manager.unknownSite');
    var item = el('li', 'rail-node rail-node-sub');

    var row = el('div', 'rail-row');
    var current = state.filter.siteKey === site.siteKey;
    if (current) row.classList.add('is-current');

    row.appendChild(el('span', 'rail-caret-spacer'));

    var button = el('button', 'rail-item rail-item-sub');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-current', String(current));
    button.appendChild(el('span', 'rail-item-name', label));
    button.appendChild(el('span', 'rail-item-count', String(site.count)));
    button.addEventListener('click', function () {
      setFilter({
        siteKey: current ? null : site.siteKey,
        // 顶层网站属于全局范围；目录内的网站保持在该目录里，标签/颜色计数才正确
        folderId: parentFolderId,
      });
    });
    row.appendChild(button);

    var actions = el('span', 'rail-actions');
    actions.appendChild(railAction('→', HA.I18n.t('folder.moveTo'), function () {
      openMoveSiteDialog(site);
    }));
    actions.appendChild(railAction('×', HA.I18n.t('manager.deleteSiteAction'), function () {
      confirmDeleteSite(site);
    }));
    row.appendChild(actions);

    item.appendChild(row);
    return item;
  }

  function renderTags() {
    var cloud = $('tag-cloud');
    cloud.textContent = '';

    // 标签计数只统计当前目录（或当前网站）内的标注
    var tags = computeTagStats(scopeList());
    $('tag-empty').classList.toggle('hidden', tags.length > 0);

    tags.forEach(function (entry) {
      var chip = el('button', 'chip');
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(state.filter.tag === entry.tag));
      chip.appendChild(document.createTextNode(entry.tag));
      chip.appendChild(el('span', 'chip-count', String(entry.count)));
      chip.addEventListener('click', function () {
        setFilter({ tag: state.filter.tag === entry.tag ? null : entry.tag });
      });
      cloud.appendChild(chip);
    });
  }

  function renderColors() {
    var host = $('color-filter');
    host.textContent = '';

    HA.PALETTE.forEach(function (color) {
      var button = el('button', 'swatch-btn');
      button.type = 'button';
      button.title = color.label;
      button.setAttribute('aria-label', HA.I18n.t('manager.filterColor', { color: HA.I18n.t('color.' + color.id) }));
      button.setAttribute('aria-pressed', String(state.filter.color === color.id));

      var swatch = el('span', 'swatch');
      swatch.style.background = color.light;
      button.appendChild(swatch);

      button.addEventListener('click', function () {
        setFilter({ color: state.filter.color === color.id ? null : color.id });
      });
      host.appendChild(button);
    });
  }

  /* ================================================================== *
   * 目录管理
   * ================================================================== */

  function newFolderId() {
    var suffix;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      suffix = crypto.randomUUID();
    } else {
      suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    return 'f_' + suffix;
  }

  function folderNameTaken(name, exceptId) {
    var lower = name.toLowerCase();
    return state.folders.some(function (folder) {
      return folder.id !== exceptId && folder.name.toLowerCase() === lower;
    });
  }

  /**
   * 目录名称输入框 + 确认按钮。
   * 名称校验不通过时保持对话框打开，改完可以直接再提交。
   */
  function promptFolderName(config) {
    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title', config.title));

      var body = el('div', 'dialog-body');
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'input dialog-input';
      input.value = config.initial || '';
      input.maxLength = 40;
      input.placeholder = HA.I18n.t('folder.newPrompt');
      input.setAttribute('aria-label', HA.I18n.t('folder.newPrompt'));
      // 打开时直接全选旧名字，改名可以直接输入覆盖
      input.addEventListener('focus', function () { input.select(); }, { once: true });
      body.appendChild(input);
      dialog.appendChild(body);

      var actions = el('div', 'dialog-actions');
      var cancel = el('button', 'btn', HA.I18n.t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      actions.appendChild(cancel);

      var submit = el('button', 'btn btn-primary', config.submitLabel);
      submit.type = 'button';
      submit.addEventListener('click', run);
      actions.appendChild(submit);
      dialog.appendChild(actions);

      function run() {
        var name = input.value.trim();
        if (!name) {
          toast(HA.I18n.t('folder.nameRequired'), { error: true });
          input.focus();
          return;
        }
        if (folderNameTaken(name, config.exceptId)) {
          toast(HA.I18n.t('folder.nameExists'), { error: true });
          input.select();
          return;
        }
        submit.disabled = true;
        config.onSubmit(name).then(close).catch(function (err) {
          submit.disabled = false;
          toast(HA.I18n.t('folder.failed', { message: err.message }), { error: true });
        });
      }

      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          run();
        }
      });
    });
  }

  function openCreateFolderDialog() {
    promptFolderName({
      title: HA.I18n.t('folder.new'),
      submitLabel: HA.I18n.t('folder.new'),
      onSubmit: function (name) {
        var folder = { id: newFolderId(), name: name, createdAt: Date.now() };
        return HA.putFolder(folder).then(function () {
          state.expanded.add(folder.id);
          return refresh();
        }).then(function () {
          toast(HA.I18n.t('folder.created', { name: name }));
          broadcastFolders();
        });
      },
    });
  }

  function openRenameFolderDialog(folder) {
    promptFolderName({
      title: HA.I18n.t('folder.rename'),
      initial: folder.name,
      exceptId: folder.id,
      submitLabel: HA.I18n.t('common.confirm'),
      onSubmit: function (name) {
        return HA.putFolder({
          id: folder.id,
          name: name,
          createdAt: folder.createdAt,
        }).then(function () {
          return refresh();
        }).then(function () {
          toast(HA.I18n.t('folder.renamed'));
          broadcastFolders();
        });
      },
    });
  }

  /** 删除目录会连目录下的标注一起删，确认框要把数量说清楚 */
  function confirmDeleteFolder(folder) {
    var stats = folderStats(folder.id);

    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title',
        HA.I18n.t('folder.deleteTitle', { name: folder.name })));

      var body = el('div', 'dialog-body');
      body.appendChild(el('p', null, stats.count
        ? HA.I18n.t('folder.deleteWarn', { sites: stats.sites.length, n: stats.count })
        : HA.I18n.t('folder.deleteWarnEmpty')));
      if (stats.count) body.appendChild(el('p', 'muted', HA.I18n.t('common.irreversible')));
      dialog.appendChild(body);

      var actions = el('div', 'dialog-actions');
      var cancel = el('button', 'btn', HA.I18n.t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      actions.appendChild(cancel);

      var del = el('button', 'btn btn-primary', HA.I18n.t('common.delete'));
      del.type = 'button';
      del.addEventListener('click', function () {
        close();
        HA.deleteFolderDeep(folder.id).then(function () {
          if (state.filter.folderId === folder.id) {
            state.filter.folderId = null;
            state.filter.siteKey = null;
          }
          // 默认目录被删掉后，退回「不自动归档」
          if (state.settings && state.settings.defaultFolderId === folder.id) {
            HA.updateSettings({ defaultFolderId: null }).catch(function () {});
          }
          state.expanded.delete(folder.id);
          // 删掉的标注分布在多个页面，让每个标签页自己重新拉取
          broadcast({ kind: 'bulk', urlKey: null, ids: [] });
          return refresh().then(function () {
            toast(HA.I18n.t('folder.deleted', { name: folder.name }));
          });
        }).catch(function (err) {
          toast(HA.I18n.t('folder.failed', { message: err.message }), { error: true });
        });
      });
      actions.appendChild(del);
      dialog.appendChild(actions);
    });
  }

  /** 删除一个网站下的全部标注；确认框要先说清楚数量 */
  function confirmDeleteSite(site) {
    var label = site.siteKey || HA.I18n.t('manager.unknownSite');

    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title',
        HA.I18n.t('manager.deleteSiteTitle', { site: label })));

      var body = el('div', 'dialog-body');
      body.appendChild(el('p', null, HA.I18n.t('manager.deleteSiteWarn', { n: site.count })));
      body.appendChild(el('p', 'muted', HA.I18n.t('common.irreversible')));
      dialog.appendChild(body);

      var actions = el('div', 'dialog-actions');
      var cancel = el('button', 'btn', HA.I18n.t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      actions.appendChild(cancel);

      var del = el('button', 'btn btn-primary', HA.I18n.t('common.delete'));
      del.type = 'button';
      del.addEventListener('click', function () {
        close();
        HA.deleteSite(site.siteKey).then(function (result) {
          // 删掉的标注可能分布在多个页面，让每个标签页自己重新拉取
          broadcast({ kind: 'bulk', urlKey: null, ids: [] });
          return refresh().then(function () {
            toast(HA.I18n.t('manager.siteDeleted', { site: label, n: result.annotations }));
          });
        }).catch(function (err) {
          toast(HA.I18n.t('manager.deleteFailed', { message: err.message }), { error: true });
        });
      });
      actions.appendChild(del);
      dialog.appendChild(actions);
    });
  }

  function openMoveSiteDialog(site) {
    var label = site.siteKey || HA.I18n.t('manager.unknownSite');
    var current = folderIdOfSite(site.siteKey);

    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title',
        HA.I18n.t('folder.moveTitle', { site: label })));

      var chosen = { value: current };
      var choices = [{ value: null, label: HA.I18n.t('folder.topLevel') }]
        .concat(state.folders.map(function (folder) {
          return { value: folder.id, label: folder.name };
        }));

      dialog.appendChild(buildChoice(
        HA.I18n.t('folder.moveTo'),
        choices,
        current,
        function (value) { chosen.value = value; }
      ));

      var actions = el('div', 'dialog-actions');
      var cancel = el('button', 'btn', HA.I18n.t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      actions.appendChild(cancel);

      var confirm = el('button', 'btn btn-primary', HA.I18n.t('common.confirm'));
      confirm.type = 'button';
      confirm.addEventListener('click', function () {
        close();
        moveSite(site.siteKey, chosen.value);
      });
      actions.appendChild(confirm);
      dialog.appendChild(actions);
    });
  }

  function moveSite(siteKey, folderId) {
    var target = folderId || null;
    return HA.setSiteFolder(siteKey, target).then(function () {
      // 正在看的就是这个网站时，跟着它进入新目录，避免列表突然空掉
      if (state.filter.siteKey === siteKey) {
        state.filter.folderId = target;
        state.expanded.add(ALL_FOLDER);
        if (target) state.expanded.add(target);
      }
      return refresh();
    }).then(function () {
      toast(HA.I18n.t('folder.moved', { name: folderLabel(target) }));
      broadcastFolders();
    }).catch(function (err) {
      toast(HA.I18n.t('folder.failed', { message: err.message }), { error: true });
    });
  }

  /* ================================================================== *
   * 内容区
   * ================================================================== */

  function renderContent() {
    var results = $('results');
    results.textContent = '';

    var list = applyFilter();
    var bar = $('filter-bar');

    if (hasActiveFilter() && list.length) {
      bar.classList.remove('hidden');
      $('filter-summary').textContent = describeFilter() + ' · ' + HA.I18n.t('manager.countSuffix', { n: list.length });
    } else {
      bar.classList.add('hidden');
    }

    if (!list.length) {
      results.appendChild(renderEmpty());
      return;
    }

    // 按网站 → 页面 两层分组
    var bySite = new Map();
    list.forEach(function (annotation) {
      var siteKey = annotation.siteKey || HA.I18n.t('manager.unknownSite');
      if (!bySite.has(siteKey)) bySite.set(siteKey, new Map());
      var pages = bySite.get(siteKey);
      var pageKey = annotation.urlKey || '';
      if (!pages.has(pageKey)) pages.set(pageKey, []);
      pages.get(pageKey).push(annotation);
    });

    var index = 0;
    var fragment = document.createDocumentFragment();

    bySite.forEach(function (pages, siteKey) {
      var siteSection = el('section', 'site-group');

      var head = el('div', 'site-group-head');
      head.appendChild(el('h2', 'site-group-name', siteKey));
      var count = 0;
      pages.forEach(function (items) { count += items.length; });
      head.appendChild(el('span', 'site-group-count mono', HA.I18n.t('manager.siteGroupCount', { n: count })));
      siteSection.appendChild(head);

      pages.forEach(function (items, pageKey) {
        var pageSection = el('div', 'page-group');

        var pageHead = el('div', 'page-group-head');
        var first = items[0];
        var link = el('a', 'page-group-link', first.title || pageKey || HA.I18n.t('manager.noTitle'));
        link.href = first.url || pageKey;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        pageHead.appendChild(link);

        var domain = el('span', 'page-group-domain', shortenUrl(first.url || pageKey));
        pageHead.appendChild(domain);
        pageSection.appendChild(pageHead);

        var listNode = el('div', 'anno-list');
        items.forEach(function (annotation) {
          listNode.appendChild(renderCard(annotation, index++));
        });
        pageSection.appendChild(listNode);
        siteSection.appendChild(pageSection);
      });

      fragment.appendChild(siteSection);
    });

    results.appendChild(fragment);
    observeStagger();
  }

  /** 只给首屏的头几十张卡片做错落淡入 —— 长列表全做会变成噪音 */
  function observeStagger() {
    var cards = document.querySelectorAll('.anno.stagger');
    Array.prototype.forEach.call(cards, function (card, i) {
      if (i < 24) {
        card.style.animationDelay = (i * 14) + 'ms';
      } else {
        card.classList.remove('stagger');
      }
    });
  }

  function shortenUrl(url) {
    if (!url) return '';
    try {
      var parsed = new URL(url);
      var path = parsed.pathname === '/' ? '' : parsed.pathname;
      return parsed.hostname + (path.length > 42 ? path.slice(0, 40) + '…' : path);
    } catch (err) {
      return url.length > 56 ? url.slice(0, 54) + '…' : url;
    }
  }

  function renderEmpty() {
    var box = el('div', 'empty');

    if (!state.all.length) {
      box.appendChild(el('div', 'empty-mark', '▢'));
      box.appendChild(el('div', 'empty-title', HA.I18n.t('manager.emptyTitle')));
      var hint = el('p', 'empty-hint');
      hint.textContent = HA.I18n.t('manager.emptyHint');
      box.appendChild(hint);
    } else {
      box.appendChild(el('div', 'empty-mark', '⌕'));
      box.appendChild(el('div', 'empty-title', HA.I18n.t('manager.noMatchTitle')));
      box.appendChild(el('p', 'empty-hint', HA.I18n.t('manager.noMatchHint')));
    }

    return box;
  }

  function renderCard(annotation, index) {
    var card = el('article', 'anno stagger');
    card.dataset.id = annotation.id;
    card.dataset.color = annotation.color || 'yellow';
    if (state.selected.has(annotation.id)) card.classList.add('is-selected');

    // 勾选框
    var checkWrap = el('div', 'anno-check');
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(annotation.id);
    checkbox.setAttribute('aria-label', HA.I18n.t('manager.selectAnnotation'));
    checkbox.addEventListener('change', function () {
      toggleSelection(annotation.id, checkbox.checked);
    });
    checkWrap.appendChild(checkbox);
    card.appendChild(checkWrap);

    card.appendChild(el('div', 'anno-spine'));

    var body = el('div', 'anno-body');

    // 原文
    var quote = el('p', 'anno-quote');
    quote.textContent = annotation.text || HA.I18n.t('content.noText');
    body.appendChild(quote);

    // 备注
    if (annotation.note) {
      body.appendChild(el('div', 'anno-note', annotation.note));
    }

    // 元信息
    var meta = el('div', 'anno-meta');

    (annotation.tags || []).forEach(function (tag) {
      var chip = el('button', 'anno-tag', tag);
      chip.type = 'button';
      chip.title = HA.I18n.t('manager.filterTagTitle');
      chip.addEventListener('click', function () { setFilter({ tag: tag }); });
      meta.appendChild(chip);
    });

    meta.appendChild(el('span', 'mono', HA.formatDateTime(annotation.createdAt)));
    body.appendChild(meta);

    card.appendChild(body);

    // 操作
    var actions = el('div', 'anno-actions');

    var open = el('button', 'btn btn-quiet btn-sm', HA.I18n.t('common.open'));
    open.type = 'button';
    open.title = HA.I18n.t('manager.openTitle');
    open.addEventListener('click', function () {
      window.open(annotation.url || annotation.urlKey, '_blank', 'noopener');
    });
    actions.appendChild(open);

    var remove = el('button', 'btn btn-danger btn-sm', HA.I18n.t('common.delete'));
    remove.type = 'button';
    remove.addEventListener('click', function () { confirmDelete(annotation); });
    actions.appendChild(remove);

    card.appendChild(actions);
    return card;
  }

  /* ================================================================== *
   * 批量选择与删除
   * ================================================================== */

  function toggleSelection(id, on) {
    if (on) state.selected.add(id);
    else state.selected.delete(id);

    // 只更新这一张卡片，不整页重绘（否则滚动位置会跳）
    var card = document.querySelector('.anno[data-id="' + cssEscape(id) + '"]');
    if (card) card.classList.toggle('is-selected', !!on);

    renderSelectionBar();
  }

  /** id 是 UUID，只含字母数字和连字符，但稳妥起见还是转义一下 */
  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function clearSelection() {
    state.selected.clear();
    Array.prototype.forEach.call(document.querySelectorAll('.anno'), function (card) {
      card.classList.remove('is-selected');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.anno-check input'), function (box) {
      box.checked = false;
    });
    renderSelectionBar();
  }

  /** 选中当前筛选结果里的全部条目 */
  function selectAllVisible() {
    applyFilter().forEach(function (annotation) {
      state.selected.add(annotation.id);
    });
    renderContent();          // 一次性重绘，比逐个更新卡片快
    renderSelectionBar();
  }

  function renderSelectionBar() {
    var bar = $('selection-bar');
    var count = state.selected.size;

    bar.classList.toggle('hidden', count === 0);
    document.body.classList.toggle('has-selection', count > 0);

    if (count) $('selection-count').textContent = HA.I18n.t('manager.selectedCount', { n: count });
  }

  /** 批量删除。ids 为空时不做任何事。 */
  function deleteByIds(ids) {
    if (!ids.length) return Promise.resolve();

    return HA.deleteMany(ids).then(function () {
      broadcast({ kind: 'deleted', urlKey: null, ids: ids });
      ids.forEach(function (id) { state.selected.delete(id); });
      return refresh();
    });
  }

  /**
   * 批量删除前的确认框。
   * 一次删很多条是不可逆的，所以要：给出确切数量、列出几条预览、并提供「先备份」。
   */
  function confirmBatchDelete(ids, description) {
    if (!ids.length) {
      toast(HA.I18n.t('manager.noDeleteTarget'));
      return;
    }

    // 最多列三条原文，让用户在删之前看清删的是什么
    var preview = state.all.filter(function (a) {
      return ids.indexOf(a.id) !== -1;
    }).slice(0, 3);

    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title', HA.I18n.t('manager.deleteBatchTitle', { n: ids.length })));

      var body = el('div', 'dialog-body');
      if (description) {
        body.appendChild(el('p', 'muted', description));
      }
      body.appendChild(el('p', null, HA.I18n.t('common.irreversible')));

      preview.forEach(function (annotation) {
        var line = el('p', 'anno-quote');
        line.style.marginTop = '10px';
        line.style.fontSize = '13px';
        line.textContent = HA.textPreview(annotation.text, 70);
        body.appendChild(line);
      });

      if (ids.length > preview.length) {
        body.appendChild(el('p', 'muted',
          HA.I18n.t('common.andMore', { n: ids.length - preview.length })));
      }
      dialog.appendChild(body);

      var actions = el('div', 'dialog-actions');

      var backupFirst = el('button', 'btn', HA.I18n.t('common.backupFirst'));
      backupFirst.type = 'button';
      backupFirst.addEventListener('click', function () {
        close();
        backupToFile();
      });
      actions.appendChild(backupFirst);

      var cancel = el('button', 'btn', HA.I18n.t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      actions.appendChild(cancel);

      var del = el('button', 'btn btn-primary', HA.I18n.t('common.delete'));
      del.type = 'button';
      del.addEventListener('click', function () {
        close();
        deleteByIds(ids).then(function () {
          toast(HA.I18n.t('manager.deletedN', { n: ids.length }));
        }).catch(function (err) {
          toast(HA.I18n.t('manager.deleteFailed', { message: err.message }), { error: true });
        });
      });
      actions.appendChild(del);

      dialog.appendChild(actions);
    });
  }

  /* ================================================================== *
   * 删除
   * ================================================================== */

  function confirmDelete(annotation) {
    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title', HA.I18n.t('manager.deleteOneTitle')));

      var body = el('div', 'dialog-body');
      var preview = el('p', 'anno-quote');
      preview.textContent = HA.textPreview(annotation.text, 160);
      body.appendChild(preview);
      dialog.appendChild(body);

      var actions = el('div', 'dialog-actions');

      var cancel = el('button', 'btn', HA.I18n.t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      actions.appendChild(cancel);

      var del = el('button', 'btn btn-primary', HA.I18n.t('common.delete'));
      del.type = 'button';
      del.addEventListener('click', function () {
        close();
        HA.deleteAnnotation(annotation.id).then(function () {
          refresh();
          toast(HA.I18n.t('manager.deleted'));
          broadcast({
            kind: 'deleted',
            urlKey: annotation.urlKey,
            ids: [annotation.id],
          });
        });
      });
      actions.appendChild(del);

      dialog.appendChild(actions);
    });
  }

  /* ================================================================== *
   * 导出
   * ================================================================== */

  function openExportDialog() {
    var scope = applyFilter().length === state.all.length ? 'all' : 'filtered';

    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title', HA.I18n.t('manager.exportTitle')));

      var options = Object.assign({}, HA.MARKDOWN_DEFAULT_OPTIONS, {
        groupBy: 'site',
      });

      // --- 范围 ---
      dialog.appendChild(buildChoice(HA.I18n.t('manager.scope'), [
        { value: 'filtered', label: HA.I18n.t('manager.scopeFiltered', { n: applyFilter().length }),
          disabled: !hasActiveFilter() },
        { value: 'all', label: HA.I18n.t('manager.scopeAll', { n: state.all.length }) },
      ], scope, function (value) { scope = value; }));

      // --- 分组方式 ---
      dialog.appendChild(buildChoice(HA.I18n.t('manager.groupBy'), [
        { value: 'site', label: HA.I18n.t('manager.groupSite') },
        { value: 'page', label: HA.I18n.t('manager.groupPage') },
        { value: 'none', label: HA.I18n.t('manager.groupNone') },
      ], options.groupBy, function (value) { options.groupBy = value; }));

      // --- 内容开关 ---
      var toggles = el('div');
      toggles.style.marginTop = '14px';
      toggles.appendChild(buildToggle(HA.I18n.t('manager.includeNote'), options.includeNote, function (v) { options.includeNote = v; }));
      toggles.appendChild(buildToggle(HA.I18n.t('manager.includeTags'), options.includeTags, function (v) { options.includeTags = v; }));
      toggles.appendChild(buildToggle(HA.I18n.t('manager.includeDate'), options.includeDate, function (v) { options.includeDate = v; }));
      toggles.appendChild(buildToggle(HA.I18n.t('manager.includeColor'), options.includeColor, function (v) { options.includeColor = v; }));
      dialog.appendChild(toggles);

      // --- 操作 ---
      var actions = el('div', 'dialog-actions');

      var copy = el('button', 'btn', HA.I18n.t('manager.copyToClipboard'));
      copy.type = 'button';
      copy.addEventListener('click', function () {
        var annotations = scope === 'all' ? state.all : applyFilter();
        var text = HA.toMarkdown(annotations, options);
        navigator.clipboard.writeText(text).then(function () {
          close();
          toast(HA.I18n.t('manager.copiedN', { n: annotations.length }));
        }).catch(function (err) {
          toast(HA.I18n.t('manager.copyFailed', { message: err.message }), { error: true });
        });
      });
      actions.appendChild(copy);

      var save = el('button', 'btn btn-primary', HA.I18n.t('manager.chooseAndSave'));
      save.type = 'button';
      save.addEventListener('click', function () {
        var annotations = scope === 'all' ? state.all : applyFilter();
        close();
        exportMarkdown(annotations, options);
      });
      actions.appendChild(save);

      dialog.appendChild(actions);
    });
  }

  /**
   * 导出 Markdown。
   *
   * ⚠️ 时序很关键：`HA.FSSave.save` 内部**第一个 await 就是弹 picker**，
   * 数据通过 `getChunks` 回调在 picker 之后再取。
   * 因为 picker 会消费掉用户激活，而激活只有约 5 秒寿命 ——
   * 先 await 一堆数据再弹 picker 会随机关失败。
   */
  function exportMarkdown(annotations, options) {
    if (!annotations.length) {
      toast(HA.I18n.t('manager.nothingToExport'));
      return;
    }

    var filename = HA.suggestMarkdownFilename(annotations, options);

    if (!HA.FSSave.isPickerSupported()) {
      // 降级：走下载
      HA.FSSave.saveViaDownload({
        filename: filename,
        mimeType: 'text/markdown',
        text: HA.toMarkdown(annotations, options),
      }).then(function (result) {
        if (result.saved) toast(HA.I18n.t('manager.exportedToDownloads', { n: annotations.length }));
        else toast(HA.I18n.t('manager.exportFailed', { message: result.reason || HA.I18n.t('common.unknownReason') }), { error: true });
      });
      return;
    }

    HA.FSSave.save({
      suggestedName: filename,
      mimeType: 'text/markdown',
      extension: '.md',
      description: HA.I18n.t('manager.markdownFileDesc'),
      getChunks: function () { return HA.markdownChunks(annotations, options); },
    }).then(function (result) {
      if (result.cancelled) return;
      if (!result.saved) {
        toast(HA.I18n.t('manager.exportFailed', { message: result.reason || HA.I18n.t('common.unknownReason') }), { error: true });
        return;
      }
      toast(HA.I18n.t('manager.exportedN', { n: annotations.length, name: filename }));
    }).catch(function (err) {
      toast(HA.I18n.t('manager.exportFailed', { message: err.message }), { error: true });
    });
  }

  /* ================================================================== *
   * 备份与恢复
   * ================================================================== */

  function openBackupDialog() {
    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title', HA.I18n.t('manager.backupTitle')));

      var body = el('div', 'dialog-body');
      body.appendChild(el('p', null,
        HA.I18n.t('manager.backupIntro')));

      var stats = el('p', 'mono');
      stats.style.marginTop = '10px';
      stats.textContent = HA.I18n.t('manager.currentTotal', { n: state.all.length });
      body.appendChild(stats);

      HA.estimateUsage().then(function (usage) {
        if (!usage || !usage.usage) return;
        stats.textContent += ' · ' + HA.I18n.t('manager.approxUsage', { size: formatBytes(usage.usage) });
      });

      dialog.appendChild(body);

      var destination = el('div', 'destination');

      var backup = el('button', 'btn btn-primary', HA.I18n.t('manager.exportBackup'));
      backup.type = 'button';
      backup.addEventListener('click', function () {
        close();
        backupToFile();
      });
      destination.appendChild(backup);

      var restore = el('button', 'btn', HA.I18n.t('manager.restoreFromFile'));
      restore.type = 'button';
      restore.addEventListener('click', function () {
        close();
        restoreFromFile();
      });
      destination.appendChild(restore);

      dialog.appendChild(destination);

      // 危险区
      var danger = el('div');
      danger.style.marginTop = '18px';
      danger.style.paddingTop = '14px';
      danger.style.borderTop = '1px solid var(--rule)';

      var clear = el('button', 'btn btn-danger btn-sm', HA.I18n.t('manager.clearAllBtn'));
      clear.type = 'button';
      clear.addEventListener('click', function () {
        close();
        confirmClearAll();
      });
      danger.appendChild(clear);
      dialog.appendChild(danger);

      var actions = el('div', 'dialog-actions');
      var done = el('button', 'btn', HA.I18n.t('common.close'));
      done.type = 'button';
      done.addEventListener('click', close);
      actions.appendChild(done);
      dialog.appendChild(actions);
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** 备份要一起带上的目录信息；调用方在 picker 之后再取，满足用户手势限制 */
  function backupOptions() {
    return {
      settings: state.settings,
      folders: state.folders,
      siteFolders: state.siteFolders,
    };
  }

  function backupToFile() {
    var filename = HA.suggestBackupFilename();

    if (!HA.FSSave.isPickerSupported()) {
      HA.FSSave.saveViaDownload({
        filename: filename,
        mimeType: 'application/json',
        text: HA.serializeBackup(state.all, backupOptions()),
      }).then(function (result) {
        if (result.saved) {
          HA.setMeta('lastBackupAt', Date.now());
          toast(HA.I18n.t('options.backupDone'));
        } else {
          toast(HA.I18n.t('manager.backupFailed', { message: result.reason || HA.I18n.t('common.unknownReason') }), { error: true });
        }
      });
      return;
    }

    HA.FSSave.save({
      suggestedName: filename,
      mimeType: 'application/json',
      extension: '.json',
      description: HA.I18n.t('options.backupFileDesc'),
      rememberKey: 'backupFileHandle',
      // 同样：数据在 picker 之后才取
      getChunks: function () {
        return [HA.serializeBackup(state.all, backupOptions())];
      },
    }).then(function (result) {
      if (result.cancelled) return;
      if (!result.saved) {
        toast(HA.I18n.t('manager.backupFailed', { message: result.reason || HA.I18n.t('common.unknownReason') }), { error: true });
        return;
      }
      HA.setMeta('lastBackupAt', Date.now());
      toast(HA.I18n.t('manager.backedUpN', { n: state.all.length }));
    }).catch(function (err) {
      toast(HA.I18n.t('manager.backupFailed', { message: err.message }), { error: true });
    });
  }

  function restoreFromFile() {
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
          toast(HA.I18n.t('manager.cannotReadBackup', { message: err.message }), { error: true, duration: 8000 });
          return;
        }
        confirmRestore(parsed);
      });
    });
    input.click();
  }

  function confirmRestore(parsed) {
    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title', HA.I18n.t('manager.restoreTitle')));

      var body = el('div', 'dialog-body');
      var info = el('p');
      info.textContent = HA.I18n.t('manager.restoreIntro', {
        n: parsed.annotations.length,
        exported: parsed.info.exportedAt
          ? HA.I18n.t('manager.restoreExported', {
              date: HA.formatDateTime(Date.parse(parsed.info.exportedAt)),
            })
          : '',
      });
      body.appendChild(info);

      if (parsed.warnings.length) {
        var warnings = el('ul');
        warnings.style.marginTop = '10px';
        warnings.style.paddingLeft = '18px';
        parsed.warnings.forEach(function (warning) {
          warnings.appendChild(el('li', 'muted', warning));
        });
        body.appendChild(warnings);
      }
      dialog.appendChild(body);

      var mode = 'merge';
      dialog.appendChild(buildChoice(HA.I18n.t('manager.restoreMode'), [
        { value: 'merge', label: HA.I18n.t('manager.merge') },
        { value: 'replace', label: HA.I18n.t('manager.replace') },
      ], mode, function (value) { mode = value; }));

      var actions = el('div', 'dialog-actions');

      var cancel = el('button', 'btn', HA.I18n.t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      actions.appendChild(cancel);

      var confirm = el('button', 'btn btn-primary', HA.I18n.t('manager.startRestore'));
      confirm.type = 'button';
      confirm.addEventListener('click', function () {
        close();
        var withFolders = parsed.folders !== null || parsed.siteFolders !== null;
        HA.importAnnotations(parsed.annotations, { mode: mode }).then(function (result) {
          var foldersTask = withFolders
            ? HA.importFolders(parsed.folders || [], parsed.siteFolders || [], { mode: mode })
            : Promise.resolve();
          return foldersTask.then(function () {
            refresh();
            broadcast({ kind: 'bulk', urlKey: null, ids: [] });
            var message = HA.I18n.t('manager.importedN', { n: result.imported });
            if (result.skipped) message += HA.I18n.t('manager.skippedN', { n: result.skipped });
            toast(message, { duration: result.errors.length ? 8000 : 4200 });
            if (result.errors.length) {
              console.warn('[HA] 导入时的问题：', result.errors);
            }
          });
        }).catch(function (err) {
          toast(HA.I18n.t('manager.restoreFailed', { message: err.message }), { error: true });
        });
      });
      actions.appendChild(confirm);

      dialog.appendChild(actions);
    });
  }

  function confirmClearAll() {
    openDialog(function (dialog, close) {
      dialog.appendChild(el('h2', 'dialog-title', HA.I18n.t('manager.clearTitle')));

      var body = el('div', 'dialog-body');
      var warning = el('p');
      warning.textContent = HA.I18n.t('manager.clearWarn', { n: state.all.length });
      body.appendChild(warning);
      dialog.appendChild(body);

      var actions = el('div', 'dialog-actions');

      var cancel = el('button', 'btn', HA.I18n.t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      actions.appendChild(cancel);

      var backupFirst = el('button', 'btn', HA.I18n.t('manager.backupClearFirst'));
      backupFirst.type = 'button';
      backupFirst.addEventListener('click', function () {
        close();
        backupToFile();
      });
      actions.appendChild(backupFirst);

      var clear = el('button', 'btn btn-primary', HA.I18n.t('manager.confirmedClear'));
      clear.type = 'button';
      clear.addEventListener('click', function () {
        close();
        HA.clearAll().then(function () {
          refresh();
          toast(HA.I18n.t('manager.cleared'));
          broadcast({ kind: 'cleared', urlKey: null, ids: [] });
        });
      });
      actions.appendChild(clear);

      dialog.appendChild(actions);
    });
  }

  /* ================================================================== *
   * 对话框小部件
   * ================================================================== */

  function buildChoice(label, choices, initial, onChange) {
    var wrap = el('div');
    wrap.style.marginTop = '14px';

    wrap.appendChild(el('div', 'eyebrow', label));

    var row = el('div', 'row');
    row.style.marginTop = '7px';
    row.style.flexWrap = 'wrap';

    var buttons = [];

    choices.forEach(function (choice) {
      var chip = el('button', 'chip', choice.label);
      chip.type = 'button';
      chip.disabled = !!choice.disabled;
      chip.setAttribute('aria-pressed', String(choice.value === initial));
      if (choice.disabled) chip.style.opacity = '.4';

      chip.addEventListener('click', function () {
        buttons.forEach(function (other) {
          other.setAttribute('aria-pressed', String(other === chip));
        });
        onChange(choice.value);
      });

      buttons.push(chip);
      row.appendChild(chip);
    });

    wrap.appendChild(row);
    return wrap;
  }

  function buildToggle(label, initial, onChange) {
    var row = el('div', 'option-row');

    var text = el('span', 'option-label', label);
    row.appendChild(text);

    var switchLabel = el('label', 'switch');
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!initial;
    input.addEventListener('change', function () { onChange(input.checked); });

    switchLabel.appendChild(input);
    switchLabel.appendChild(el('span', 'switch-track'));
    row.appendChild(switchLabel);

    return row;
  }

  /* ================================================================== *
   * 事件绑定
   * ================================================================== */

  function bind() {
    $('btn-export').addEventListener('click', openExportDialog);
    $('btn-backup').addEventListener('click', openBackupDialog);
    $('btn-options').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
    });
    $('btn-new-folder').addEventListener('click', openCreateFolderDialog);
    $('btn-clear-filter').addEventListener('click', clearFilter);

    // 批量删除：勾选后删
    $('btn-delete-selected').addEventListener('click', function () {
      confirmBatchDelete(Array.from(state.selected));
    });
    $('btn-clear-selection').addEventListener('click', clearSelection);
    $('btn-select-all').addEventListener('click', selectAllVisible);

    var onSearch = debounce(function (value) {
      setFilter({ search: value });
    }, 160);

    $('search').addEventListener('input', function (event) {
      onSearch(event.target.value);
    });

    // 「/」聚焦搜索框（不在输入框里时）
    document.addEventListener('keydown', function (event) {
      var target = event.target;
      var typing = target && (target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable);

      if (event.key === '/' && !typing) {
        event.preventDefault();
        $('search').focus();
        $('search').select();
      }
      if (event.key === 'Escape' && typing && target === $('search')) {
        $('search').value = '';
        setFilter({ search: '' });
        $('search').blur();
        return;
      }
      // 按 Esc 清空选择（不在输入框里时）
      if (event.key === 'Escape' && !typing && state.selected.size) {
        clearSelection();
      }
    });
  }

  /* ================================================================== *
   * 启动
   * ================================================================== */

  function start() {
    bind();

    // 先确定界面语言，再渲染 —— 避免首屏闪现默认语言
    HA.getSettings().then(function (settings) {
      HA.I18n.setLocale(HA.I18n.resolve(settings.language));
      HA.I18n.apply(document);
      return refresh();
    }).catch(function (err) {
      console.error('[HA] 管理页加载失败：', err);
      toast(HA.I18n.t('manager.readFailed', { message: err.message }), { error: true, duration: 10000 });
    });

    // 在设置页切换语言后，已打开的管理页实时跟随
    HA.onSettingsChanged(function (next) {
      if (!HA.I18n.setLocale(HA.I18n.resolve(next.language))) return;
      HA.I18n.apply(document);
      renderRail();
      renderContent();
      renderTotal();
      renderSelectionBar();
    });

    // 目录或标注在别处被改动时刷新（设置页 / 侧边栏会广播）
    HA.registerNotifications(function (payload) {
      if (!payload || payload.type !== HA.MSG.CHANGED) return;
      var change = payload.change;
      if (!change) return;
      if (change.kind === 'folders' || change.kind === 'bulk' || change.kind === 'cleared') {
        refresh().catch(function () { /* 刷新失败保留当前界面 */ });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

})(globalThis.HA || (globalThis.HA = {}));
