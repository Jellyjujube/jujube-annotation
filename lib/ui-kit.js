'use strict';
/**
 * 扩展页面共用的界面小工具。
 *
 * 管理页 / 侧边栏 / 设置页都需要「造元素、弹提示、弹对话框」这三件事，
 * 放在这里共用，避免三份各自演化。
 *
 * 依赖页面上两个固定容器：
 *   `#toasts`       提示条宿主（三个页面都有）
 *   `#dialog-host`  对话框宿主（侧边栏不用对话框，缺失时会按需创建）
 */
(function (HA) {

  /** 造一个元素 */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function toastHost() {
    var host = document.getElementById('toasts');
    if (!host) {
      // 页面上没有宿主时按需创建一个，避免调用方直接崩掉
      host = el('div', 'toast-host');
      host.id = 'toasts';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  /**
   * 弹一条提示。
   *
   * @param {string} message
   * @param {{error?: boolean, actionLabel?: string,
   *          onAction?: () => void, duration?: number}} [options]
   */
  function toast(message, options) {
    options = options || {};

    var bar = el('div', 'toast' + (options.error ? ' toast-error' : ''));
    bar.appendChild(el('span', null, message));

    if (options.actionLabel && options.onAction) {
      var action = el('button', 'toast-action', options.actionLabel);
      action.type = 'button';
      action.addEventListener('click', function () {
        bar.remove();
        options.onAction();
      });
      bar.appendChild(action);
    }

    toastHost().appendChild(bar);
    setTimeout(function () { bar.remove(); }, options.duration || 4000);

    return bar;
  }

  /**
   * 弹一个对话框。由调用方负责填充内容。
   *
   * 点击遮罩或按 Esc 都会关闭。
   *
   * @param {(dialog: HTMLElement, close: () => void) => void} build
   * @returns {() => void} 关闭函数
   */
  function openDialog(build) {
    var host = document.getElementById('dialog-host');
    if (!host) {
      host = el('div');
      host.id = 'dialog-host';
      document.body.appendChild(host);
    }

    var backdrop = el('div', 'dialog-backdrop');
    var dialog = el('div', 'dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    backdrop.appendChild(dialog);

    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    }

    function close() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
    }

    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey, true);

    build(dialog, close);
    host.appendChild(backdrop);

    var focusable = dialog.querySelector('input, button, select, textarea');
    if (focusable) focusable.focus();

    return close;
  }

  HA.UIKit = {
    el: el,
    toast: toast,
    openDialog: openDialog,
  };

})(globalThis.HA || (globalThis.HA = {}));
