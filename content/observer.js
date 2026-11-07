'use strict';
/**
 * DOM 变化观察与重锚定调度。
 *
 * ## 为什么必须做重锚定
 *
 * Highlight 内部用的是 StaticRange，规范要求 UA **不得**因 DOM 变化调整边界，
 * 且明确要求使用者自己「observe and react to DOM changes, by discarding stale
 * ranges … and recreating new ones」。所以页面一变，高亮**不是漂移而是消失**，
 * 必须由我们重建。**重锚定不是可选功能，是核心功能。**
 *
 * ## 观察配置的取舍
 *
 *     { childList: true, subtree: true, characterData: false, attributes: false }
 *
 * `characterData` **刻意关掉**：字符级变化（打字、计时器、直播弹幕）频率极高，
 * 开着会让回调被淹没。代价是纯文字替换检测不到 —— 但那类变化
 * 通常伴随 childList 变化，或者会在下次导航时被兜住。
 *
 * `attributes` 也关掉：属性变化（class 切换、样式更新）频率高且几乎不影响文本，
 * 开着只会产生大量无意义的回调。
 *
 * ## 三条性能纪律
 *
 * 1. **回调里不读 layout**（`getBoundingClientRect` / `offsetHeight` 会强制 reflow）。
 * 2. **debounce 后再干活**，且**只对失效的标注重跑**，不是全量。
 * 3. **分片执行**，每片之间让出主线程，避免长任务掉帧。
 */
(function (HA) {

  /** 观察回调的 debounce 时间 */
  var DEBOUNCE_MS = 350;

  /** 每片处理的标注条数 */
  var CHUNK_SIZE = 12;

  /** 同一批内容的连续重锚定次数上限，超过就暂时放弃（等有新内容或手动重试） */
  var MAX_RETRIES = 3;

  var observer = null;
  var debounceTimer = null;
  var started = false;
  var onRendered = null;
  var onRouteChanged = null;
  var retryCounts = new Map();
  var running = false;
  var queued = false;

  /** 上一轮看到的正文长度。用来判断「页面是否加载了新内容」 */
  var lastTextLength = -1;

  /* ------------------------------------------------------------------ *
   * 重锚定
   * ------------------------------------------------------------------ */

  /**
   * 判断一个条目是否需要（重新）锚定。
   *
   * 两道检查，缺一不可：
   *
   * 1. **容器是否还挂在文档上。** StaticRange 的容器一旦脱离文档，
   *    Blink 就不再绘制该高亮（节点被移出 DOM 时高亮消失，插回来又会出现）。
   * 2. **覆盖的文本是否还是原来那段。** 这一条容易被忽略：页面**就地修改
   *    `textNode.data`**（计数器、直播、就地更新）时，容器始终 connected，
   *    光看连接性发现不了 —— 但 StaticRange 指向的是「节点 + 偏移」，
   *    节点内容一变，高亮就**静默地盖住了别的文字**，而且不会报任何错。
   *
   * 所以锚定时会记下当时覆盖的文本（`entry.matchedText`），这里比一下。
   */
  function needsAnchor(entry) {
    if (!entry.range) return true;
    if (!HA.isRangeConnected(entry.range)) return true;

    var expected = entry.matchedText || entry.annotation.text;
    if (!expected) return false;

    var index = HA.getTextIndex(HA.defaultRoot());
    var current = HA.rangeToText(index, entry.range);
    return current !== expected;
  }

  /** 分片执行：每片之间让出主线程，避免长任务卡住页面 */
  function runChunked(items, handleChunk, done) {
    var index = 0;

    function step() {
      var deadline = performance.now() + 8;   // 单片预算 8ms

      while (index < items.length && performance.now() < deadline) {
        var end = Math.min(index + CHUNK_SIZE, items.length);
        handleChunk(items.slice(index, end));
        index = end;
      }

      if (index < items.length) {
        // 用 rAF 让出主线程，保持页面响应
        requestAnimationFrame(step);
      } else {
        done();
      }
    }

    step();
  }

  /**
   * 跑一轮重锚定。
   * 只处理「没锚定」或「锚定已失效」的条目 —— 全量重跑在几百条标注
   * 加上频繁 DOM 变化时会直接把页面卡死。
   *
   * @returns {Promise<Object>} 完成后 resolve 出统计信息。
   *          分片是异步的（每片让出主线程），所以必须返回 Promise 而不是同步完成。
   */
  function reanchor() {
    if (running) return running;

    var resolveDone;
    var donePromise = new Promise(function (resolve) { resolveDone = resolve; });
    running = donePromise;

    HA.invalidateTextIndex();

    var root = HA.defaultRoot();
    if (!root) {
      running = false;
      resolveDone(HA.Store.counts());
      return donePromise;
    }

    // 正文长度变了就说明页面加载了新内容 —— 之前那些「定位失败」的标注
    // 是因为内容还没到，不该继续背着失败次数。
    //
    // ⚠️ 必须保留：客户端渲染的页面在正文到达前会因无关的 DOM 变化
    // 消耗掉全部重试额度，正文出现后便不再重试。正文长度变化即清零计数。
    var index = HA.getTextIndex(root);
    if (index.text.length !== lastTextLength) {
      lastTextLength = index.text.length;
      retryCounts.clear();
    }

    var entries = HA.Store.list();

    // 清掉已删除标注留下的重试记录，否则这张表会随会话无限增长
    if (retryCounts.size) {
      var alive = new Set(entries.map(function (entry) { return entry.annotation.id; }));
      Array.from(retryCounts.keys()).forEach(function (id) {
        if (!alive.has(id)) retryCounts.delete(id);
      });
    }

    var candidates = entries.filter(function (entry) {
      if (!needsAnchor(entry)) return false;
      // 反复失败的内容暂时不再试，等有新内容（长度变化）或手动重试
      var retries = retryCounts.get(entry.annotation.id) || 0;
      return retries < MAX_RETRIES;
    });

    function finish() {
      HA.Renderer.renderAll();
      HA.HitTest.invalidate();
      running = false;
      var counts = HA.Store.counts();
      if (onRendered) onRendered(counts);
      resolveDone(counts);
      // 本轮进行中有新的变化进来 → 补跑一轮
      if (queued) {
        queued = false;
        schedule();
      }
    }

    if (!candidates.length) {
      finish();
      return donePromise;
    }

    var items = candidates.map(function (entry) {
      return {
        id: entry.annotation.id,
        selectors: entry.annotation.selectors,
        // 带上归一化规则版本 —— 版本不一致时 TextPositionSelector 的偏移
        // 已经作废，降级链会把它降级为「仅作搜索起点」，不再当作精确命中
        anchorMeta: entry.annotation.anchorMeta,
      };
    });

    // 文本索引在上面已经建好并缓存，整批复用 ——
    // 每条标注各遍历一次 DOM 会 O(n·m) 爆炸
    runChunked(
      items,
      function (chunk) {
        var results = HA.anchorBatch(root, chunk);
        results.forEach(function (result, id) {
          HA.Store.setAnchorResult(id, result);
          if (result.status === HA.STATUS.ORPHAN) {
            retryCounts.set(id, (retryCounts.get(id) || 0) + 1);
          } else {
            retryCounts.delete(id);
          }
        });
      },
      finish
    );

    return donePromise;
  }

  /** 防抖调度。
   *  如果一轮重锚定还在跑，就记个标记，等它结束后再补跑一轮 ——
   *  否则跑到一半时发生的新变化会被丢掉。 */
  function schedule() {
    if (!started) return;
    if (running) { queued = true; return; }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      reanchor();
    }, DEBOUNCE_MS);
  }

  /* ------------------------------------------------------------------ *
   * MutationObserver
   * ------------------------------------------------------------------ */

  function onMutations(mutations) {
    // 回调里只做最轻的判断：有没有真正影响文本的改动。
    // 不在这里读 layout，也不做锚定。
    for (var i = 0; i < mutations.length; i++) {
      var mutation = mutations[i];

      if (mutation.type === 'childList') {
        if (hasRelevantNodes(mutation.addedNodes) || hasRelevantNodes(mutation.removedNodes)) {
          schedule();
          return;
        }
      }
    }
  }

  /** 新增/移除的节点里有没有非空文本 */
  function hasRelevantNodes(nodeList) {
    if (!nodeList || !nodeList.length) return false;

    for (var i = 0; i < nodeList.length; i++) {
      var node = nodeList[i];
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.data && node.data.trim()) return true;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      // 有非空文本内容就算相关
      if (node.textContent && node.textContent.trim()) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 尺寸变化
   * ------------------------------------------------------------------ */

  var resizeTimer = null;

  function onResize() {
    // 布局变了 → 命中测试的矩形缓存必须失效
    HA.HitTest.invalidate();
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      // 缩放可能改变像素对齐，重新取一次矩形
      HA.Renderer.renderAll();
      HA.HitTest.invalidate();
    }, 200);
  }

  /**
   * 滚动时是否要让命中测试的缓存失效。
   *
   * 命中测试把矩形换算成了**文档坐标**，所以根滚动容器（documentElement）
   * 滚动时坐标不变，不需要失效 —— 这正是当初省开销的设计。
   *
   * 但那只对根滚动容器成立。app-shell 布局的站点（`html,body{height:100%;
   * overflow:hidden}` + 内层 `#app{overflow:auto}`，如 Gmail、各种桌面式 Web App）
   * 滚动时 `window.scrollY` 恒为 0，而内容的视口位置在变 —— 此时不失效就会
   * 「点不中高亮」甚至「点到滚动前那个位置上的另一条标注」。
   *
   * 所以按**事件目标**区分：根容器滚动跳过，内层容器滚动才失效。
   * 失效只是把 dirty 置位，重建仍然是惰性的（下次真有 pointermove 才做），
   * 所以代价很小。
   */
  function onScroll(event) {
    var target = event.target;
    if (target === document || target === document.documentElement
        || target === document.body) {
      return;
    }
    HA.HitTest.invalidate();
  }

  /* ------------------------------------------------------------------ *
   * SPA 路由
   * ------------------------------------------------------------------ */

  /**
   * ⚠️ **不能** monkey-patch `history.pushState` —— content script 运行在
   * isolated world，改 `window.history` 影响不到页面主世界的调用。
   *
   * 主路径是 service worker 的 `webNavigation.onHistoryStateUpdated` 转发过来的通知；
   * 这里监听 `popstate` 作为补充 —— DOM 事件可以跨 world 收到。
   */
  function onPopState() {
    HA.Observer.notifyRouteChanged(location.href);
  }

  function onHashChange() {
    HA.Observer.notifyRouteChanged(location.href);
  }

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  function start(options) {
    if (started) return;
    started = true;
    onRendered = options && options.onRendered;

    var root = HA.defaultRoot();
    if (root && window.MutationObserver) {
      observer = new MutationObserver(onMutations);
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: false,   // 刻意关闭，见文件头说明
        attributes: false,      // 刻意关闭，属性变化频繁且几乎不影响文本
      });
    }

    window.addEventListener('resize', onResize);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onHashChange);
    // capture 阶段才能收到内层滚动容器的 scroll（scroll 事件不冒泡）
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });

    // ⚠️ 保留这条：图片懒加载完成会撑开布局，使高亮文字的矩形缓存失效。
    document.addEventListener('load', function (event) {
      if (event.target && event.target.tagName === 'IMG') {
        HA.HitTest.invalidate();
      }
    }, true);
  }

  function stop() {
    if (!started) return;
    started = false;

    if (observer) { observer.disconnect(); observer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }

    window.removeEventListener('resize', onResize);
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('hashchange', onHashChange);
    document.removeEventListener('scroll', onScroll, { capture: true });
  }

  /** 路由变了：清空重试计数、重新拉取本页标注 */
  function notifyRouteChanged(url) {
    retryCounts.clear();
    schedule();
    if (onRouteChanged) onRouteChanged(url);
  }

  HA.Observer = {
    start: start,
    stop: stop,
    schedule: schedule,
    reanchor: reanchor,
    notifyRouteChanged: notifyRouteChanged,
    /** 注册路由变化回调（由 bootstrap 设定，用于重新拉取标注） */
    setRouteHandler: function (fn) { onRouteChanged = fn; },
    clearRetries: function () { retryCounts.clear(); },

    /**
     * 强制重试全部未定位的标注（清空失败计数）。
     * 侧边栏里「未定位」条目上的「重新定位」按钮走这条。
     */
    forceReanchor: function () {
      retryCounts.clear();
      lastTextLength = -1;
      return reanchor();
    },
  };

})(globalThis.HA || (globalThis.HA = {}));
