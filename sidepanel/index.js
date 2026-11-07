'use strict';
/**
 * 侧边栏。
 *
 * ⚠️ 关键事实：**side panel 是跨标签页共享的单个实例**，不是每个标签页一份。
 * 官方文档说得很明确 —— 即使 per-tab 面板与全局面板设了相同的 path，
 * 它们也是**不同实例**；而同一个全局面板在切换标签页时不会自动重建。
 * 所以必须自己监听 `tabs.onActivated` / `tabs.onUpdated` 来切换显示的数据，
 * 否则会出现「侧边栏显示的是上一个标签页的标注」。
 *
 * 数据来源有两个：
 *   · IndexedDB —— 标注本体（选择器、原文、备注、标签）
 *   · content script —— 锚定状态（能不能定位、在文档里的位置）
 * 后者只存在于页面里，必须靠消息去问。
 */
(function (HA) {

  var state = {
    tabId: null,
    urlKey: null,
    siteKey: null,
    pageUrl: '',
    title: '',
    annotations: [],
    folders: [],
    statuses: new Map(),     // id → {status, score, reason, offset}
    live: false,             // content script 是否可达
    activeId: null,
    settings: HA.DEFAULT_SETTINGS,
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ================================================================== *
   * 小工具
   * ================================================================== */

  /* 界面小工具来自共用模块 lib/ui-kit.js（在脚本列表里先于本文件加载） */
  var el = HA.UIKit.el;
  var toast = HA.UIKit.toast;

  /* ================================================================== *
   * 数据
   * ================================================================== */

  /** 取当前活动标签页 */
  function getActiveTab() {
    return chrome.tabs.query({ active: true, lastFocusedWindow: true })
      .then(function (tabs) {
        return (tabs && tabs[0]) || null;
      })
      .catch(function () { return null; });
  }

  function canAnnotateUrl(url) {
    return typeof url === 'string' && /^https?:/i.test(url);
  }

  /**
   * 装载当前标签页的数据。
   *
   * 顺序有讲究：**先问页面、再读库**。
   * 因为页面可能声明了 `<link rel=canonical>`，此时标注是按 canonical 存的，
   * 而侧边栏只有地址栏 URL —— 自己算出来的 urlKey 会查不到任何数据（显示 0 条）。
   * 页面里的 content script 知道真相，所以先问它要 urlKey。
   */
  function load() {
    // 默认目录是全局设置，与当前标签页无关，先读出来并渲染
    return Promise.all([HA.getSettings(), HA.getFolders()]).then(function (results) {
      state.settings = results[0];
      state.folders = results[1];
      renderSiteFolder();

      return getActiveTab();
    }).then(function (tab) {
      if (!tab) {
        state.siteKey = null;
        renderNotice('none', HA.I18n.t('sidepanel.noTab'), '');
        return;
      }

      state.tabId = tab.id;

      if (!canAnnotateUrl(tab.url)) {
        state.annotations = [];
        state.statuses = new Map();
        state.live = false;
        state.urlKey = null;
        state.siteKey = null;
        renderHeader(tab.title || '', '', 0);
        renderNotice(
          'restricted',
          HA.I18n.t('sidepanel.unsupportedTitle'),
          HA.I18n.t('sidepanel.unsupportedHint')
        );
        return;
      }

      return fetchSnapshot().then(function (snapshot) {
        // 页面答不上来（脚本没注入 / 扩展刚更新过）就退回按地址栏 URL 算
        var fallback = HA.makeUrlKeys(tab.url);
        var urlKey = (snapshot && snapshot.urlKey) || fallback.urlKey;

        state.urlKey = urlKey;
        state.siteKey = (snapshot && snapshot.siteKey) || fallback.siteKey;
        state.pageUrl = (snapshot && snapshot.pageUrl) || tab.url;
        state.title = (snapshot && snapshot.title) || tab.title || '';

        return HA.getByUrlKey(urlKey).then(function (annotations) {
          state.annotations = annotations;
          render();
        });
      }).catch(function (err) {
        console.error('[HA] 侧边栏加载失败：', err);
        state.siteKey = null;
        renderNotice('error', HA.I18n.t('sidepanel.readFailed'), err.message);
      });
    });
  }

  /**
   * 向 content script 要本页的归属信息与锚定状态。
   *
   * 页面是受限页面、或扩展刚更新过而页面里是旧脚本时都会失败 ——
   * 那不是错误，只是拿不到，照常按地址栏 URL 显示数据即可。
   *
   * @returns {Promise<Object|null>}
   */
  function fetchSnapshot() {
    if (typeof state.tabId !== 'number') {
      state.statuses = new Map();
      return Promise.resolve(null);
    }

    return HA.sendToTab(state.tabId, { type: HA.MSG.GET_STATUS })
      .then(function (snapshot) {
        state.live = true;
        applySnapshot(snapshot);
        return snapshot;
      })
      .catch(function () {
        state.live = false;
        state.statuses = new Map();
        return null;
      });
  }

  function applySnapshot(snapshot) {
    state.statuses = new Map();
    if (!snapshot || !Array.isArray(snapshot.statuses)) return;
    snapshot.statuses.forEach(function (item) {
      state.statuses.set(item.id, item);
    });
  }

  /* ================================================================== *
   * 渲染
   * ================================================================== */

  function renderHeader(title, site, count) {
    $('page-title').textContent = title || HA.I18n.t('sidepanel.pageTitle');
    $('page-title').title = title || '';
    $('page-site').textContent = site || '';
    $('page-count').textContent = count ? HA.I18n.t('unit.annotations', { n: count }) : '—';
  }

  /* ================================================================== *
   * 本站默认目录
   * ================================================================== */

  function folderLabel(folderId) {
    if (!folderId) return HA.I18n.t('folder.topLevel');
    var found = null;
    state.folders.forEach(function (folder) {
      if (folder.id === folderId) found = folder;
    });
    return found ? found.name : HA.I18n.t('folder.topLevel');
  }

  function makeOption(value, label) {
    var option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }

  function renderSiteFolder() {
    var select = $('site-folder');
    var assigned = (state.settings && state.settings.defaultFolderId) || '';
    var exists = state.folders.some(function (folder) { return folder.id === assigned; });

    select.textContent = '';
    select.appendChild(makeOption('', HA.I18n.t('folder.topLevel')));
    state.folders.forEach(function (folder) {
      select.appendChild(makeOption(folder.id, folder.name));
    });
    // 目录被删掉后配置会失效；不存在时一律显示顶层
    select.value = exists ? assigned : '';
    select.disabled = false;
    $('site-folder-bar').classList.remove('hidden');
  }

  /**
   * 修改全局默认目录。
   *
   * 这不是按网站设置 —— 选定后一直生效，之后在任何网站上新加的标注，
   * 都会把这个网站整体归档到所选目录；选「顶层」表示不自动归档。
   */
  function onSiteFolderChange() {
    var select = $('site-folder');
    var folderId = select.value || null;

    select.disabled = true;

    HA.updateSettings({ defaultFolderId: folderId }).then(function (next) {
      state.settings = next;
      renderSiteFolder();
      toast(folderId
        ? HA.I18n.t('folder.defaultSet', { name: folderLabel(folderId) })
        : HA.I18n.t('folder.defaultCleared'));
    }).catch(function (err) {
      select.disabled = false;
      toast(HA.I18n.t('folder.failed', { message: err.message }), { error: true });
    });
  }

  function renderNotice(kind, title, text) {
    var list = $('list');
    list.textContent = '';

    var box = el('div', 'notice');
    var marks = { restricted: '⌀', none: '▢', error: '⚠', empty: '▢', offline: '⌀' };
    box.appendChild(el('div', 'notice-mark', marks[kind] || '▢'));
    box.appendChild(el('div', 'notice-title', title));
    if (text) box.appendChild(el('p', 'notice-text', text));
    list.appendChild(box);

    $('foot-hint').textContent = '';
  }

  /**
   * 排序：能定位的按文档位置排，定位不了的沉到末尾。
   * 这样侧边栏的顺序和你在页面上从上往下读到的顺序一致。
   */
  function orderedAnnotations() {
    return state.annotations.slice().sort(function (a, b) {
      var sa = state.statuses.get(a.id);
      var sb = state.statuses.get(b.id);

      var oa = sa && typeof sa.offset === 'number' ? sa.offset : null;
      var ob = sb && typeof sb.offset === 'number' ? sb.offset : null;

      if (oa !== null && ob !== null) return oa - ob;
      if (oa !== null) return -1;
      if (ob !== null) return 1;
      return b.createdAt - a.createdAt;
    });
  }

  function statusOf(annotation) {
    var entry = state.statuses.get(annotation.id);
    return entry ? entry.status : null;   // 拿不到页面状态时返回 null
  }

  function render() {
    var list = $('list');
    list.textContent = '';

    renderHeader(state.title, state.siteKey, state.annotations.length);

    if (!state.annotations.length) {
      renderNotice(
        'empty',
        HA.I18n.t('sidepanel.emptyTitle'),
        HA.I18n.t('sidepanel.emptyHint')
      );
      return;
    }

    if (!state.live) {
      $('foot-hint').textContent = HA.I18n.t('sidepanel.notConnected');
      $('foot-hint').title = HA.I18n.t('sidepanel.notConnectedTitle');
    } else {
      $('foot-hint').textContent = HA.I18n.t('unit.annotations', { n: state.annotations.length });
    }

    var ordered = orderedAnnotations();
    var hiddenOrphans = 0;

    // 设置里可以关掉「显示未定位的标注」，但要在页脚如实说明隐藏了几条 ——
    // 静默隐藏会让用户以为数据丢了
    if (!state.settings.showOrphans) {
      ordered = ordered.filter(function (annotation) {
        var isOrphan = statusOf(annotation) === HA.STATUS.ORPHAN;
        if (isOrphan) hiddenOrphans++;
        return !isOrphan;
      });
    }

    if (hiddenOrphans) {
      $('foot-hint').textContent = HA.I18n.t('sidepanel.hiddenOrphans', { n: hiddenOrphans });
    }

    if (!ordered.length) {
      renderNotice('empty', HA.I18n.t('sidepanel.noDisplayTitle'),
        HA.I18n.t('sidepanel.noDisplayHint'));
      return;
    }

    var ul = el('ul', 'note-list');
    ordered.forEach(function (annotation) {
      ul.appendChild(renderNote(annotation));
    });
    list.appendChild(ul);
  }

  function renderNote(annotation) {
    var status = statusOf(annotation);
    var li = el('li', 'note');
    li.dataset.color = annotation.color || 'yellow';
    li.dataset.id = annotation.id;
    if (status === HA.STATUS.ORPHAN) li.classList.add('is-orphan');
    if (state.activeId === annotation.id) li.classList.add('is-active');

    li.appendChild(el('div', 'note-spine'));

    var main = el('div', 'note-main');

    var quote = el('p', 'note-quote');
    quote.textContent = annotation.text || HA.I18n.t('content.noText');
    main.appendChild(quote);

    if (annotation.note) {
      main.appendChild(el('div', 'note-note', annotation.note));
    }

    var meta = el('div', 'note-meta');

    if (status === HA.STATUS.ORPHAN) {
      meta.appendChild(el('span', 'note-flag is-orphan', HA.I18n.t('sidepanel.orphan')));
    } else if (status === HA.STATUS.AMBIGUOUS) {
      meta.appendChild(el('span', 'note-flag is-ambiguous', HA.I18n.t('sidepanel.ambiguous')));
    } else if (status === HA.STATUS.FUZZY) {
      meta.appendChild(el('span', 'note-flag is-fuzzy', HA.I18n.t('sidepanel.fuzzy')));
    } else if (status === HA.STATUS.PENDING) {
      meta.appendChild(el('span', 'note-flag is-pending', HA.I18n.t('sidepanel.pending')));
    }

    (annotation.tags || []).forEach(function (tag) {
      meta.appendChild(el('span', 'note-tag', tag));
    });

    if (meta.childNodes.length) main.appendChild(meta);

    // 点击条目 → 让页面滚过去
    main.addEventListener('click', function () {
      locate(annotation.id);
    });

    li.appendChild(main);

    // 操作
    var actions = el('div', 'note-actions');

    // 未定位的条目给一个手动重试入口 —— 页面内容可能是在我们放弃之后才加载完的
    if (status === HA.STATUS.ORPHAN) {
      var retry = el('button', 'btn btn-quiet btn-sm', HA.I18n.t('sidepanel.retry'));
      retry.type = 'button';
      retry.title = HA.I18n.t('sidepanel.retryTitle');
      retry.addEventListener('click', function (event) {
        event.stopPropagation();
        reanchorAll();
      });
      actions.appendChild(retry);
    }

    var open = el('button', 'btn btn-quiet btn-sm', HA.I18n.t('sidepanel.openPage'));
    open.type = 'button';
    open.title = HA.I18n.t('sidepanel.openPageTitle');
    open.addEventListener('click', function (event) {
      event.stopPropagation();
      chrome.tabs.create({ url: annotation.url || annotation.urlKey });
    });
    actions.appendChild(open);

    var remove = el('button', 'btn btn-danger btn-sm', HA.I18n.t('common.delete'));
    remove.type = 'button';
    remove.addEventListener('click', function (event) {
      event.stopPropagation();
      removeAnnotation(annotation.id);
    });
    actions.appendChild(remove);

    li.appendChild(actions);
    return li;
  }

  /* ================================================================== *
   * 操作
   * ================================================================== */

  function locate(id) {
    if (!state.live) {
      toast(HA.I18n.t('sidepanel.locateNoPage'));
      return;
    }

    state.activeId = id;
    refreshActiveHighlight();

    HA.sendToTab(state.tabId, { type: HA.MSG.SCROLL_TO, id: id })
      .then(function (found) {
        if (!found) toast(HA.I18n.t('sidepanel.locateFailed'));
      })
      .catch(function () {
        toast(HA.I18n.t('sidepanel.locateError'));
      });
  }

  function refreshActiveHighlight() {
    var items = document.querySelectorAll('.note');
    Array.prototype.forEach.call(items, function (item) {
      item.classList.toggle('is-active', item.dataset.id === state.activeId);
    });
  }

  function removeAnnotation(id) {
    var annotation = state.annotations.filter(function (a) { return a.id === id; })[0];

    HA.deleteAnnotation(id).then(function () {
      state.annotations = state.annotations.filter(function (a) { return a.id !== id; });
      state.statuses.delete(id);
      render();
      toast(HA.I18n.t('sidepanel.deleted'));

      // 侧边栏是扩展页面，直连 IndexedDB（与 SW 同源），绕过了 Repo ——
      // 所以必须主动喊一声，否则页面上的高亮不会消失，工具栏徽标也不会更新。
      HA.sendToBackground({
        type: HA.MSG.BROADCAST,
        change: {
          kind: 'deleted',
          urlKey: annotation ? annotation.urlKey : null,
          ids: [id],
        },
      }).catch(function () { /* 广播失败不影响删除本身 */ });
    }).catch(function (err) {
      toast(HA.I18n.t('sidepanel.deleteFailed', { message: err.message }), { error: true });
    });
  }

  /** 让页面清空失败计数、重新尝试定位全部未定位的标注 */
  function reanchorAll() {
    if (!state.live) {
      toast(HA.I18n.t('sidepanel.reanchorNoPage'));
      return;
    }

    HA.sendToTab(state.tabId, { type: HA.MSG.REANCHOR })
      .then(function (snapshot) {
        applySnapshot(snapshot);
        render();
        var remaining = 0;
        state.statuses.forEach(function (item) {
          if (item.status === HA.STATUS.ORPHAN) remaining++;
        });
        toast(remaining ? HA.I18n.t('sidepanel.reanchorStill', { n: remaining }) : HA.I18n.t('sidepanel.reanchorAllDone'));
      })
      .catch(function () {
        toast(HA.I18n.t('sidepanel.reanchorFailed'), { error: true });
      });
  }

  /* ================================================================== *
   * 事件
   * ================================================================== */

  function bind() {
    $('btn-manage').addEventListener('click', function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('manager/index.html') });
    });

    $('btn-settings').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
    });

    $('site-folder').addEventListener('change', onSiteFolderChange);

    // ⚠️ 侧边栏是跨标签页共享的单个实例，必须自己跟着活动标签页切换。
    // load() 每次都会重新问页面要 urlKey，所以不需要额外的缓存失效逻辑。
    if (chrome.tabs && chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(function () {
        load();
      });
    }

    if (chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
        if (!tab || !tab.active) return;
        if (tabId !== state.tabId) return;
        if (changeInfo.status === 'complete' || changeInfo.url) {
          load();
        }
      });
    }

    // 标注在别处被改动时刷新（SW 会向扩展页面广播）
    HA.registerNotifications(function (payload) {
      if (!payload || payload.type !== HA.MSG.CHANGED) return;
      var change = payload.change;
      if (change && change.urlKey && change.urlKey !== state.urlKey) return;
      load();
    });
  }

  /* ================================================================== *
   * 启动
   * ================================================================== */

  function start() {
    bind();

    // 先按设置确定界面语言，再渲染 —— 否则首屏会闪现默认语言
    HA.getSettings().then(function (settings) {
      state.settings = settings;
      HA.I18n.setLocale(HA.I18n.resolve(settings.language));
      HA.I18n.apply(document);
      load();
    }).catch(function () {
      HA.I18n.apply(document);
      load();
    });

    // 语言切换后重新渲染
    HA.onSettingsChanged(function (next) {
      if (!HA.I18n.setLocale(HA.I18n.resolve(next.language))) return;
      HA.I18n.apply(document);
      load();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

})(globalThis.HA || (globalThis.HA = {}));
