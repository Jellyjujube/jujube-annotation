'use strict';
/**
 * content script 入口。
 *
 * 职责：环境检测 → 拉取标注 → 锚定 → 渲染 → 接上交互。
 *
 * ## 幂等
 *
 * 扩展更新后 service worker 可能重新注入本脚本，所以要防止跑两遍
 * （两遍会产生两份 highlight 注册与两套事件监听）。
 */
(function (HA) {

  if (HA.__booted) return;
  HA.__booted = true;

  var context = null;
  var settings = null;
  var lastCreatedId = null;
  var undo = null;
  var editStopFollow = null;

  /** 统一取错误信息文案 */
  function messageOf(err) {
    return err && err.message ? err.message : HA.I18n.t('common.unknown');
  }

  /* ------------------------------------------------------------------ *
   * 环境检测
   * ------------------------------------------------------------------ */

  /**
   * 这个页面能不能标注。
   *
   * 受限页面（chrome://、其他扩展页、Chrome Web Store、内置 PDF 阅读器、
   * 未勾选「允许访问文件网址」的 file://）上扩展根本注入不进来，
   * 但万一注入了也要优雅退出，而不是抛一堆错。
   */
  function canAnnotate() {
    if (!document.body) return false;
    var protocol = location.protocol;
    return protocol === 'http:' || protocol === 'https:';
  }

  /* ------------------------------------------------------------------ *
   * 外观
   * ------------------------------------------------------------------ */

  function applyAppearance(next) {
    settings = next;
    HA.I18n.setLocale(HA.I18n.resolve(next.language));

    var root = document.documentElement;
    if (!root) return;
    if (next.underline) root.classList.add('ha-underline');
    else root.classList.remove('ha-underline');
  }

  /* ------------------------------------------------------------------ *
   * 创建标注
   * ------------------------------------------------------------------ */

  function buildBaseRecord() {
    return {
      urlKey: context.urlKey,
      siteKey: context.siteKey,
      url: context.pageUrl,
      title: context.title,
    };
  }

  /**
   * 把一段选区变成标注。
   *
   * 注意：这里**不需要重新锚定** —— 我们手上就是活的 Range，
   * 直接用它作为锚定结果，连 describe 产出的选择器都只是为将来准备的。
   */
  function commitText(range, color) {
    var root = HA.defaultRoot();
    var described = HA.describe(root, range);

    if (!described.ok) {
      // 提示语只说明结果，诊断信息打到控制台：
      // 失败环节、原因、相关节点的 XPath，以及可复制走的结构化对象。
      HA.reportDescribeFailure(described);
      HA.UI.toast(HA.I18n.t('content.cannotAnnotate'), { duration: 6000 });
      return null;
    }

    var quoteSelector = described.selectors.filter(function (s) {
      return s.type === 'TextQuoteSelector';
    })[0];

    var record = Object.assign(buildBaseRecord(), {
      selectors: described.selectors,
      anchorMeta: described.anchorMeta,
      text: quoteSelector ? quoteSelector.exact : '',
      color: color || (settings && settings.defaultColor) || 'yellow',
      tags: [],
      note: '',
    });

    return HA.Host.create(record).then(function (annotation) {
      if (!annotation) {
        HA.UI.toast(HA.I18n.t('content.saveNotReady'));
        return null;
      }

      HA.Store.upsert(annotation, { invalidate: true });
      // 手上就是活 Range，直接标注为精确命中
      HA.Store.setAnchorResult(annotation.id, {
        status: HA.STATUS.EXACT,
        score: 1,
        range: range,
      });

      HA.Renderer.renderAll();
      HA.HitTest.invalidate();

      lastCreatedId = annotation.id;
      showUndoToast(annotation);
      return annotation;
    }).catch(function (err) {
      console.warn('[HA] 创建标注失败：', err);
      HA.UI.toast(HA.I18n.t('content.saveFailed', { message: messageOf(err) }));
      return null;
    });
  }

  /* ------------------------------------------------------------------ *
   * 撤销
   * ------------------------------------------------------------------ */

  function showUndoToast(annotation) {
    HA.UI.toast(HA.I18n.t('content.highlighted'), {
      actionLabel: HA.I18n.t('content.undo'),
      duration: 5000,
      onAction: function () {
        if (undo) undo();
      },
    });

    undo = function () {
      if (lastCreatedId !== annotation.id) return;
      lastCreatedId = null;
      HA.Host.remove(annotation.id).then(function () {
        HA.Store.remove(annotation.id);
        HA.Renderer.renderAll();
        HA.HitTest.invalidate();
      });
    };
  }

  /* ------------------------------------------------------------------ *
   * 编辑浮层
   * ------------------------------------------------------------------ */

  function openEditor(annotationId, anchorRect) {
    var entry = HA.Store.get(annotationId);
    if (!entry) return;

    if (editStopFollow) { editStopFollow(); editStopFollow = null; }
    HA.Renderer.setActive(annotationId);

    var statusText = null;
    var statusKind = null;
    if (entry.status === HA.STATUS.ORPHAN) {
      statusText = HA.I18n.t('content.statusOrphan');
      statusKind = 'warn';
    } else if (entry.status === HA.STATUS.AMBIGUOUS) {
      statusText = HA.I18n.t('content.statusAmbiguous');
      statusKind = 'warn';
    } else if (entry.status === HA.STATUS.FUZZY) {
      statusText = HA.I18n.t('content.statusFuzzy');
      statusKind = 'warn';
    }

    HA.UI.showEditor({
      anchorRect: anchorRect,
      annotation: entry.annotation,
      statusText: statusText,
      statusKind: statusKind,

      onChange: function (patch) {
        HA.Host.update(annotationId, patch).then(function (updated) {
          if (!updated) {
            // 标注在别处被删掉了（比如管理页），这条消息已经不存在
            HA.UI.toast(HA.I18n.t('content.annotationGone'));
            HA.Store.remove(annotationId);
            HA.Renderer.renderAll();
            HA.HitTest.invalidate();
            return;
          }
          HA.Store.upsert(updated, { invalidate: false });
          // 颜色可能变了 → 重新注册高亮；位置没变所以不必重锚
          HA.Renderer.renderAll();
          HA.Renderer.setActive(annotationId);
          HA.HitTest.invalidate();
        }).catch(function (err) {
          console.warn('[HA] 保存标注失败：', err);
          HA.UI.toast(HA.I18n.t('content.saveFailed', { message: messageOf(err) }));
        });
      },

      onDelete: function () {
        HA.UI.hideAll();
        HA.Renderer.setActive(null);
        HA.Host.remove(annotationId).then(function () {
          HA.Store.remove(annotationId);
          HA.Renderer.renderAll();
          HA.HitTest.invalidate();
          HA.UI.toast(HA.I18n.t('content.deleted'));
        }).catch(function (err) {
          console.warn('[HA] 删除标注失败：', err);
          HA.UI.toast(HA.I18n.t('content.deleteFailed', { message: messageOf(err) }));
        });
      },

      onClose: function () {
        HA.Renderer.setActive(null);
        if (editStopFollow) { editStopFollow(); editStopFollow = null; }
      },
    });

    editStopFollow = HA.UI.followAnchor(function () {
      return HA.ClickRouter.anchorRectFor(annotationId);
    });
  }

  /* ------------------------------------------------------------------ *
   * SW 通知
   * ------------------------------------------------------------------ */

  function handleChange(change) {
    if (!change) return;

    // 广播是全量的，各页面自行过滤
    if (change.urlKey && change.urlKey !== context.urlKey) return;

    if (change.kind === 'cleared') {
      HA.Store.clear();
      HA.Renderer.renderAll();
      HA.HitTest.invalidate();
      return;
    }

    if (change.kind === 'bulk') {
      reload();
      return;
    }

    if (change.kind === 'deleted') {
      (change.ids || []).forEach(function (id) {
        HA.Store.remove(id);
      });
      HA.Renderer.renderAll();
      HA.HitTest.invalidate();
      return;
    }

    // created / updated：如果是从别的上下文（管理页）改的，就整条替换
    var annotation = change.annotation;
    if (!annotation) return;

    var existing = HA.Store.get(annotation.id);
    if (existing) {
      // 位置相关的字段变了才需要重锚
      var needsReanchor = JSON.stringify(existing.annotation.selectors)
        !== JSON.stringify(annotation.selectors);
      HA.Store.upsert(annotation, { invalidate: needsReanchor });
      if (needsReanchor) HA.Observer.schedule();
      else {
        HA.Renderer.renderAll();
        HA.HitTest.invalidate();
      }
    } else {
      HA.Store.upsert(annotation, { invalidate: true });
      HA.Observer.schedule();
    }
  }

  function handleAction(action) {
    if (!action) return;

    if (action.type === 'protocol-mismatch') {
      HA.UI.toast(HA.I18n.t('content.extensionUpdated'), { duration: 8000 });
      return;
    }

    if (action.type !== 'highlight-selection') return;

    // 右键菜单 / 快捷键进来
    var range = HA.Selection.currentRange();
    if (!range) {
      HA.UI.toast(HA.I18n.t('content.selectFirst'));
      return;
    }
    commitText(range, action.color);
  }

  /* ------------------------------------------------------------------ *
   * 装载
   * ------------------------------------------------------------------ */

  function reload() {
    // 先把本页真正的 urlKey 报给 SW（它算不出 canonical，徽标计数要用）
    HA.Host.reportPage(context);

    return HA.Host.load(context.urlKey).then(function (list) {
      HA.Store.replaceAll(list);
      HA.Observer.clearRetries();
      HA.Observer.reanchor();
    });
  }

  function refreshContext() {
    var keys = HA.makeUrlKeys(location.href, document);
    context = {
      urlKey: keys.urlKey,
      siteKey: keys.siteKey,
      pageUrl: location.href,
      title: document.title || '',
    };
    HA.Store.setContext(context);
  }

  function boot() {
    if (!canAnnotate()) return;

    if (!HA.Renderer.supported) {
      console.warn('[HA] 当前浏览器不支持 CSS Custom Highlight API（需要 Chrome 105+），扩展已停用。');
      return;
    }

    refreshContext();
    HA.Renderer.start();
    HA.Host.listen();
    HA.UI.mount();

    HA.getSettings().then(applyAppearance);
    HA.onSettingsChanged(applyAppearance);

    // 与 SW 握手，尽早发现「扩展刚更新、页面里是旧脚本」的情况
    HA.Host.ping().then(function (info) {
      if (!info) {
        // SW 不可达：受限页面或扩展被禁用
        console.info('[HA] 无法连接扩展后台，本页停用标注功能。');
      }
    });

    // 选区 → 标注
    HA.Selection.start({
      onInstant: function (range) {
        var color = (settings && settings.defaultColor) || 'yellow';
        // 已经高亮过的同一段就不再重复创建
        if (isAlreadyHighlighted(range)) return;
        commitText(range, color);
      },
      onToolbar: function (range) {
        if (isAlreadyHighlighted(range)) return;
        var rect = range.getBoundingClientRect();
        HA.UI.showToolbar({
          anchorRect: rect,
          color: (settings && settings.defaultColor) || 'yellow',
          onPick: function (colorId) { commitText(range, colorId); },
          onCancel: function () {},
        });
      },
    });

    // 点击路由
    HA.ClickRouter.start({ onEdit: openEditor });

    // 悬停高亮时切换光标（::highlight 不参与命中测试，只能自己判断）
    HA.HitTest.startHover(function (hitId) {
      HA.UI.setPointerCursor(!!hitId);
    });

    // 观察 DOM 变化并调度重锚定
    HA.Observer.setRouteHandler(function () {
      refreshContext();
      reload();
    });
    HA.Observer.start({
      onRendered: function () { /* 可接侧边栏同步，v1 不需要 */ },
    });

    // SW 通知
    HA.Host.onChanged(handleChange);
    HA.Host.onAction(handleAction);
    HA.Host.onRouteChanged(function () {
      refreshContext();
      reload();
    });

    // 首屏
    reload();
  }

  /** 选区是否与已有标注完全重合（避免重复创建） */
  function isAlreadyHighlighted(range) {
    var root = HA.defaultRoot();
    var index = HA.getTextIndex(root);
    var offsets = HA.rangeToOffsets(index, range);
    if (!offsets) return false;

    return HA.Store.list().some(function (entry) {
      if (!entry.range) return false;
      var existing = HA.rangeToOffsets(index, entry.range);
      if (!existing) return false;
      return existing.start === offsets.start && existing.end === offsets.end;
    });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

})(globalThis.HA || (globalThis.HA = {}));
