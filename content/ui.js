'use strict';
/**
 * 页面内 UI：颜色工具条、编辑浮层、提示条。
 *
 * ## 两个隔离措施
 *
 * 1. **全部装在 Shadow DOM 里**，避免被页面 CSS 污染（很多站点的
 *    `* { ... }` 重置会直接毁掉浮层样式）。
 * 2. 样式用 **`adoptedStyleSheets`（Constructable Stylesheets）** 而不是
 *    在 shadow root 里插 `<style>` —— 后者同样可能受页面 CSS 环境影响，
 *    而构造样式表是纯 JS 对象，不受任何文档级规则干扰。
 *
 * ## 定位
 *
 * 宿主元素是全屏 fixed + `pointer-events: none`，只有面板本身接收点击。
 * 面板用 `position: fixed` 按视口坐标定位，并做视口边界收拢。
 */
(function (HA) {

  var HOST_ID = HA.UI_ROOT_ID;
  var Z_INDEX = 2147483600;

  var host = null;
  var shadow = null;
  var sheet = null;

  var elements = {
    toolbar: null,
    editor: null,
    toast: null,
  };

  var toastTimer = null;
  var noteSaveTimer = null;

  /**
   * 工具条最近一次弹出的时间。
   *
   * ⚠️ 拖动选区后浏览器会在 mouseup 之后**再补发一次 click**。
   * 那个 click 的坐标还在普通页面上，点击路由会认为「点到空白处」并把
   * 刚弹出来的工具条关掉 —— 表现就是工具条一闪而过。所以这里记下时间，
   * 让点击路由在一个很短的窗口内忽略这次收尾 click。
   */
  var toolbarOpenedAt = 0;
  var TOOLBAR_CLICK_GRACE = 300;

  /**
   * 当前编辑浮层的会话。
   *
   * 存在的理由：关闭浮层的路径有**四条**（点「完成」、按 Esc、点页面空白、被新的
   * 浮层顶掉），其中三条走的是 hide/hideAll。如果 hide 只是把 DOM 摘掉，
   * 就会出现两个问题：
   *   1. 备注是 400ms 防抖保存的，刚打完字就按 Esc 会**静默丢掉**这段备注；
   *   2. `onClose` 不会被调用，调用方挂在它上面的 `setActive(null)` 就不会执行，
   *      高亮的「正在编辑」下划线会永久留在页面上。
   * 所以把「冲刷未保存内容」和「关闭回调」都收进这个会话对象。
   */
  var editorSession = null;

  /* ------------------------------------------------------------------ *
   * 样式
   * ------------------------------------------------------------------ */

  var CSS_TEXT = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; }',

    '.ha-layer {',
    '  position: fixed; inset: 0; pointer-events: none;',
    '  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",',
    '        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;',
    '  color: #1f2430;',
    '}',

    '.ha-panel {',
    '  position: fixed; pointer-events: auto;',
    '  background: #fff; border-radius: 10px;',
    '  box-shadow: 0 2px 8px rgba(0,0,0,.12), 0 8px 28px rgba(0,0,0,.16);',
    '  border: 1px solid rgba(0,0,0,.06);',
    '  padding: 8px; max-width: 340px;',
    '}',

    /* --- 颜色工具条 --- */
    '.ha-toolbar { display: flex; align-items: center; gap: 6px; padding: 7px 9px; }',
    '.ha-swatch {',
    '  width: 22px; height: 22px; border-radius: 50%; cursor: pointer;',
    '  border: 2px solid rgba(0,0,0,.10); padding: 0; background: none;',
    '  transition: transform .12s ease;',
    '}',
    '.ha-swatch:hover { transform: scale(1.18); }',
    '.ha-swatch:focus-visible { outline: 2px solid #4c8dff; outline-offset: 2px; }',
    '.ha-swatch[aria-pressed="true"] { border-color: #1f2430; }',
    '.ha-divider { width: 1px; height: 18px; background: rgba(0,0,0,.12); margin: 0 2px; }',
    '.ha-textbtn {',
    '  border: none; background: none; cursor: pointer; padding: 4px 7px;',
    '  border-radius: 6px; color: #4a5262; font: inherit; white-space: nowrap;',
    '}',
    '.ha-textbtn:hover { background: rgba(0,0,0,.06); }',
    '.ha-textbtn.ha-danger { color: #c0392b; }',
    '.ha-textbtn.ha-danger:hover { background: rgba(192,57,43,.10); }',

    /* --- 编辑浮层 --- */
    '.ha-editor { width: 320px; display: flex; flex-direction: column; gap: 8px; }',
    '.ha-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
    '.ha-label { font-size: 11px; color: #8a93a3; min-width: 30px; }',
    '.ha-quote {',
    '  font-size: 12px; color: #4a5262; background: #f5f6f8;',
    '  border-left: 3px solid #d8dce3; border-radius: 4px;',
    '  padding: 6px 8px; max-height: 76px; overflow: auto; white-space: pre-wrap;',
    '  word-break: break-word;',
    '}',
    '.ha-note {',
    '  width: 100%; min-height: 62px; resize: vertical;',
    '  border: 1px solid #dfe3e9; border-radius: 6px; padding: 6px 8px;',
    '  font: inherit; color: inherit; background: #fff;',
    '}',
    '.ha-note:focus { outline: none; border-color: #4c8dff; }',
    '.ha-taginput {',
    '  flex: 1; min-width: 90px; border: 1px solid #dfe3e9; border-radius: 6px;',
    '  padding: 4px 7px; font: inherit; background: #fff;',
    '}',
    '.ha-taginput:focus { outline: none; border-color: #4c8dff; }',
    '.ha-chip {',
    '  display: inline-flex; align-items: center; gap: 4px;',
    '  background: #eef1f6; border-radius: 999px; padding: 2px 8px;',
    '  font-size: 12px; color: #4a5262;',
    '}',
    '.ha-chip button {',
    '  border: none; background: none; cursor: pointer; padding: 0 1px;',
    '  color: #8a93a3; font-size: 13px; line-height: 1;',
    '}',
    '.ha-chip button:hover { color: #c0392b; }',
    '.ha-foot { display: flex; justify-content: space-between; align-items: center; }',
    '.ha-status { font-size: 11px; color: #8a93a3; }',
    '.ha-status.ha-warn { color: #b7791f; }',
    '.ha-status.ha-error { color: #c0392b; }',

    /* --- 提示条 --- */
    '.ha-toast {',
    '  position: fixed; pointer-events: auto;',
    '  left: 50%; bottom: 28px; transform: translateX(-50%);',
    '  display: flex; align-items: center; gap: 12px;',
    '  background: #1f2430; color: #fff; border-radius: 8px;',
    '  padding: 9px 14px; box-shadow: 0 4px 18px rgba(0,0,0,.28);',
    '  max-width: 78vw;',
    '}',
    '.ha-toast .ha-textbtn { color: #8fc0ff; padding: 2px 6px; }',
    '.ha-toast .ha-textbtn:hover { background: rgba(255,255,255,.14); }',

    '@media (prefers-color-scheme: dark) {',
    '  .ha-panel { background: #23272f; color: #e6e9ef; border-color: rgba(255,255,255,.08); }',
    '  .ha-quote { background: #1b1e24; color: #b9c0cc; border-left-color: #3a4048; }',
    '  .ha-note, .ha-taginput { background: #1b1e24; color: #e6e9ef; border-color: #3a4048; }',
    '  .ha-swatch { border-color: rgba(255,255,255,.18); }',
    '  .ha-swatch[aria-pressed="true"] { border-color: #e6e9ef; }',
    '  .ha-textbtn { color: #b9c0cc; }',
    '  .ha-textbtn:hover { background: rgba(255,255,255,.10); }',
    '  .ha-chip { background: #2f343d; color: #d3d8e0; }',
    '  .ha-divider { background: rgba(255,255,255,.14); }',
    '}',
  ].join('\n');

  /* ------------------------------------------------------------------ *
   * 挂载
   * ------------------------------------------------------------------ */

  function mount() {
    if (host && host.isConnected) return shadow;

    host = document.createElement('div');
    host.id = HOST_ID;
    // 宿主本身不拦截任何事件，只有面板接收
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:' + Z_INDEX
      + ';pointer-events:none;';

    shadow = host.attachShadow({ mode: 'open' });

    // 用构造样式表而不是 <style>：不受文档级 CSS 规则影响
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      shadow.adoptedStyleSheets = [sheet];
    } catch (err) {
      // 极老版本不支持构造样式表时退回 <style>
      var fallback = document.createElement('style');
      fallback.textContent = CSS_TEXT;
      shadow.appendChild(fallback);
    }

    var layer = document.createElement('div');
    layer.className = 'ha-layer';
    shadow.appendChild(layer);
    shadow.__layer = layer;

    (document.body || document.documentElement).appendChild(host);
    return shadow;
  }

  function layer() {
    mount();
    return shadow.__layer;
  }

  /* ------------------------------------------------------------------ *
   * 定位
   * ------------------------------------------------------------------ */

  /**
   * 把面板放到锚点正下方，并收拢进视口。
   * 下方放不下时翻到锚点上方。
   */
  function position(panel, anchorRect) {
    // 先放到原点才能量出尺寸
    panel.style.visibility = 'hidden';
    panel.style.left = '0px';
    panel.style.top = '0px';

    var width = panel.offsetWidth;
    var height = panel.offsetHeight;
    var margin = 8;

    var top = anchorRect.bottom + margin;
    if (top + height > window.innerHeight - margin) {
      var above = anchorRect.top - height - margin;
      if (above >= margin) top = above;
    }

    var left = Math.max(margin, Math.min(anchorRect.left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
    panel.style.visibility = '';
  }

  /* ------------------------------------------------------------------ *
   * 颜色选择行
   * ------------------------------------------------------------------ */

  function buildSwatches(currentColor, onPick) {
    var row = document.createElement('div');
    row.className = 'ha-row';

    HA.PALETTE.forEach(function (color) {
      var button = document.createElement('button');
      button.className = 'ha-swatch';
      button.type = 'button';
      button.title = color.label;
      button.setAttribute('aria-label', color.label);
      button.style.background = color.light;
      if (color.id === currentColor) button.setAttribute('aria-pressed', 'true');

      button.addEventListener('mousedown', function (event) {
        // 防止点击把页面上的选区清掉
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        onPick(color.id);
      });

      row.appendChild(button);
    });

    return row;
  }

  /* ------------------------------------------------------------------ *
   * 工具条（模式 B）
   * ------------------------------------------------------------------ */

  /**
   * @param {{anchorRect: DOMRect, color: string,
   *          onPick: (colorId) => void, onCancel: () => void}} options
   */
  function showToolbar(options) {
    hide('toolbar');
    hide('editor');

    var panel = document.createElement('div');
    panel.className = 'ha-panel ha-toolbar';

    panel.appendChild(buildSwatches(options.color, function (colorId) {
      hide('toolbar');
      options.onPick(colorId);
    }));

    var divider = document.createElement('div');
    divider.className = 'ha-divider';
    panel.appendChild(divider);

    var cancel = document.createElement('button');
    cancel.className = 'ha-textbtn';
    cancel.type = 'button';
    cancel.textContent = HA.I18n.t('common.cancel');
    cancel.addEventListener('mousedown', function (event) { event.preventDefault(); });
    cancel.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      hide('toolbar');
      if (options.onCancel) options.onCancel();
    });
    panel.appendChild(cancel);

    layer().appendChild(panel);
    elements.toolbar = panel;
    toolbarOpenedAt = Date.now();
    position(panel, options.anchorRect);

    return panel;
  }

  /** 工具条是否刚刚弹出（用于忽略拖选结束时浏览器补发的那次 click） */
  function toolbarJustOpened() {
    return Date.now() - toolbarOpenedAt < TOOLBAR_CLICK_GRACE;
  }

  /* ------------------------------------------------------------------ *
   * 编辑浮层
   * ------------------------------------------------------------------ */

  /**
   * @param {{anchorRect: DOMRect, annotation: Object,
   *          statusText?: string, statusKind?: string,
   *          onChange: (patch) => void,
   *          onDelete: () => void,
   *          onClose: () => void}} options
   */
  function showEditor(options) {
    hide('toolbar');
    hide('editor');

    var annotation = options.annotation;
    var panel = document.createElement('div');
    panel.className = 'ha-panel ha-editor';

    // 原文
    var quote = document.createElement('div');
    quote.className = 'ha-quote';
    quote.textContent = annotation.text || HA.I18n.t('content.noText');
    panel.appendChild(quote);

    // 状态提示（未定位 / 有歧义）
    if (options.statusText) {
      var status = document.createElement('div');
      status.className = 'ha-status' + (options.statusKind ? ' ha-' + options.statusKind : '');
      status.textContent = options.statusText;
      panel.appendChild(status);
    }

    // 颜色
    var colorRow = document.createElement('div');
    colorRow.className = 'ha-row';
    var colorLabel = document.createElement('span');
    colorLabel.className = 'ha-label';
    colorLabel.textContent = HA.I18n.t('content.color');
    colorRow.appendChild(colorLabel);
    colorRow.appendChild(buildSwatches(annotation.color, function (colorId) {
      options.onChange({ color: colorId });
      // 重绘选中态
      Array.prototype.forEach.call(colorRow.querySelectorAll('.ha-swatch'), function (swatch, index) {
        if (HA.PALETTE[index].id === colorId) swatch.setAttribute('aria-pressed', 'true');
        else swatch.removeAttribute('aria-pressed');
      });
    }));
    panel.appendChild(colorRow);

    // 备注
    var note = document.createElement('textarea');
    note.className = 'ha-note';
    note.placeholder = HA.I18n.t('content.notePlaceholder');
    note.value = annotation.note || '';
    note.addEventListener('input', function () {
      if (noteSaveTimer) clearTimeout(noteSaveTimer);
      noteSaveTimer = setTimeout(function () {
        options.onChange({ note: note.value });
      }, 400);
    });
    panel.appendChild(note);

    // 标签
    var tagRow = document.createElement('div');
    tagRow.className = 'ha-row';

    function renderTags(tags) {
      // ⚠️ 必须 insertBefore(chip, tagInput)：输入框是 flex:1 排在行尾的，
      // 直接 append 会让 chip 落到输入框之后，破坏行的排布。
      Array.prototype.slice.call(tagRow.querySelectorAll('.ha-chip')).forEach(function (chip) {
        chip.remove();
      });

      (tags || []).forEach(function (tag) {
        var chip = document.createElement('span');
        chip.className = 'ha-chip';
        chip.appendChild(document.createTextNode(tag));

        var remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = HA.I18n.t('content.removeTag');
        remove.addEventListener('click', function (event) {
          event.stopPropagation();
          var next = (annotation.tags || []).filter(function (t) { return t !== tag; });
          annotation.tags = next;
          options.onChange({ tags: next });
          renderTags(next);
        });

        chip.appendChild(remove);
        tagRow.insertBefore(chip, tagInput);
      });
    }

    var tagInput = document.createElement('input');
    tagInput.className = 'ha-taginput';
    tagInput.type = 'text';
    tagInput.placeholder = HA.I18n.t('content.tagPlaceholder');
    tagInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      var value = HA.normalizeTag(tagInput.value);
      if (!value) return;
      var next = (annotation.tags || []).concat([value]);
      annotation.tags = HA.normalizeTags(next);
      tagInput.value = '';
      options.onChange({ tags: annotation.tags });
      renderTags(annotation.tags);
    });
    // 标签输入框里打字不该触发页面级快捷键
    tagInput.addEventListener('keyup', function (event) { event.stopPropagation(); });
    tagRow.appendChild(tagInput);

    // 先放输入框、再渲染 chip（renderTags 会插到输入框之前）
    renderTags(annotation.tags);
    panel.appendChild(tagRow);

    // 底部按钮
    var foot = document.createElement('div');
    foot.className = 'ha-foot';

    var remove = document.createElement('button');
    remove.className = 'ha-textbtn ha-danger';
    remove.type = 'button';
    remove.textContent = HA.I18n.t('common.delete');
    remove.addEventListener('click', function (event) {
      event.stopPropagation();
      options.onDelete();
    });
    foot.appendChild(remove);

    var close = document.createElement('button');
    close.className = 'ha-textbtn';
    close.type = 'button';
    close.textContent = HA.I18n.t('common.done');
    close.addEventListener('click', function (event) {
      event.stopPropagation();
      hide('editor');
      options.onClose();
    });
    foot.appendChild(close);

    panel.appendChild(foot);

    // 点面板本体不要让页面处理
    panel.addEventListener('mousedown', function (event) { event.stopPropagation(); });
    panel.addEventListener('click', function (event) { event.stopPropagation(); });

    layer().appendChild(panel);
    elements.editor = panel;
    position(panel, options.anchorRect);

    return panel;
  }

  /* ------------------------------------------------------------------ *
   * 提示条
   * ------------------------------------------------------------------ */

  /**
   * @param {string} message
   * @param {{actionLabel?: string, onAction?: () => void, duration?: number}} [options]
   */
  function toast(message, options) {
    options = options || {};
    hide('toast');

    var bar = document.createElement('div');
    bar.className = 'ha-toast';

    var text = document.createElement('span');
    text.textContent = message;
    bar.appendChild(text);

    if (options.actionLabel && options.onAction) {
      var action = document.createElement('button');
      action.className = 'ha-textbtn';
      action.type = 'button';
      action.textContent = options.actionLabel;
      action.addEventListener('click', function (event) {
        event.stopPropagation();
        hide('toast');
        options.onAction();
      });
      bar.appendChild(action);
    }

    layer().appendChild(bar);
    elements.toast = bar;

    var duration = typeof options.duration === 'number' ? options.duration : 4000;
    if (duration > 0) {
      toastTimer = setTimeout(function () { hide('toast'); }, duration);
    }

    return bar;
  }

  /* ------------------------------------------------------------------ *
   * 光标与关闭
   * ------------------------------------------------------------------ */

  /** 悬停到高亮上时切换光标。
   *  用 documentElement 上的 class 而不是直接改 body.style.cursor —— 后者会污染页面。 */
  function setPointerCursor(on) {
    var root = document.documentElement;
    if (!root) return;
    if (on) root.classList.add('ha-hovering');
    else root.classList.remove('ha-hovering');
  }

  function hide(name) {
    var el = elements[name];

    // 关闭编辑浮层时，先把没保存的备注冲出去、再触发关闭回调 —— 顺序不能反，
    // 因为回调里可能会重新渲染并引用到已经被移除的节点
    if (name === 'editor' && editorSession) {
      var session = editorSession;
      editorSession = null;

      if (noteSaveTimer) { clearTimeout(noteSaveTimer); noteSaveTimer = null; }
      try { session.flush(); } catch (err) { console.warn('[HA] 保存备注失败：', err); }

      if (el && el.parentNode) el.parentNode.removeChild(el);
      elements[name] = null;

      if (session.onClose) {
        try { session.onClose(); } catch (err) { console.warn('[HA] 关闭回调出错：', err); }
      }
      return;
    }

    if (el && el.parentNode) el.parentNode.removeChild(el);
    elements[name] = null;

    // 提示条的计时器必须一起清掉。否则旧的计时器到点会把**新的**提示条
    // 一起关掉 —— 表现为连续操作时，第二条提示的「撤销」按钮提前消失。
    if (name === 'toast' && toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function hideAll() {
    hide('editor');
    hide('toolbar');
    hide('toast');
  }

  /** 是否有面板正开着（点击路由要靠它判断该不该放行页面点击） */
  function isOpen() {
    return !!(elements.toolbar || elements.editor);
  }

  function isInside(node) {
    if (!host) return false;
    return node === host || host.contains(node);
  }

  /**
   * 让某条标注的编辑浮层跟随滚动/resize 重新定位。
   * @param {() => DOMRect|null} getAnchorRect
   */
  function followAnchor(getAnchorRect) {
    var update = function () {
      var panel = elements.editor || elements.toolbar;
      if (!panel) {
        window.removeEventListener('scroll', update, true);
        window.removeEventListener('resize', update);
        return;
      }
      var rect = getAnchorRect();
      if (!rect) return;
      position(panel, rect);
    };

    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update);
    return function stop() {
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
    };
  }

  HA.UI = {
    mount: mount,
    showToolbar: showToolbar,
    showEditor: showEditor,
    toast: toast,
    hide: hide,
    hideAll: hideAll,
    isOpen: isOpen,
    toolbarJustOpened: toolbarJustOpened,
    isInside: isInside,
    setPointerCursor: setPointerCursor,
    followAnchor: followAnchor,
  };

})(globalThis.HA || (globalThis.HA = {}));
