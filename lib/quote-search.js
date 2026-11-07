'use strict';
/**
 * 文本搜索与打分 —— 锚点降级链的 Step 2（精确匹配）与 Step 3（模糊匹配）。
 *
 * ## 算法来源
 *
 * 打分权重照抄 Hypothesis `src/annotator/anchoring/match-quote.ts`（quote 50 /
 * prefix 20 / suffix 20 / pos 2，归一化除以 92）。这套权重在 Hypothesis 生产环境
 * 验证过，其 PR #2779 的实测对比：同页 300+ 标注，旧方案 329 成功 / 137 孤儿，
 * 新方案 403 成功 / 63 孤儿。
 *
 * ## 两个关键的工程取舍
 *
 * 1. **精确匹配优先，且绝不因为上下文更好而翻盘。** Hypothesis 的做法是先用
 *    `text.indexOf` 扫出全部精确匹配，**只有精确匹配数为 0 时才跑近似搜索**。
 *    其源码注释指出这一步通常砍掉 90% 的近似搜索开销。我们照做。
 *
 * 2. **不引入 `approx-string-match` 依赖。** 那是 Hypothesis 在用的 Myers 位并行
 *    实现（活跃维护），但它是**纯 ESM 包**，而 MV3 的 content script 不支持
 *    ESM import（Chromium issue 40656676），要用它就必须引入打包步骤。
 *    为了保持「加载已解压的扩展即可运行、零构建」，这里自己实现：
 *    用「探针定位候选 + 窗口内半全局 Levenshtein 验证」代替位并行算法。
 *    代价是极端情况下更慢，收益是零依赖、代码可读。
 *    如果将来实测发现模糊匹配质量不够，升级路径是加 esbuild 换用
 *    `approx-string-match`。
 */
(function (HA) {

  /** 探针最短长度：短于此的子串在文档里会命中太多无关位置。 */
  var MIN_PROBE_LEN = 6;

  /** 探针最长长度。长探针更稀有（命中少、定位准），但一旦「整段被改动」就全部落空。 */
  var MAX_PROBE_LEN = 16;

  /** 最多生成多少个探针。 */
  var MAX_PROBES = 12;

  /** 单个探针最多接受多少个命中位置，防止病态情况（如 quote 全是高频词）。 */
  var MAX_PROBE_HITS = 60;

  /** 近似匹配整批候选的 DP 单元格预算，超预算就放弃剩余候选。
   *  宁可变孤儿，也不要卡死用户页面。 */
  var MAX_DP_CELLS = 4000000;

  /** 最多对几个候选做终点长度微调（见 refineLength）。 */
  var MAX_REFINE = 3;

  /* ------------------------------------------------------------------ *
   * 编辑距离
   * ------------------------------------------------------------------ */

  /**
   * 带截断的 Levenshtein 编辑距离。
   *
   * 标准 DP，但一旦整行最小值超过 maxErrors 就提前返回（Ukkonen 截断），
   * 并返回 maxErrors + 1 表示「超过阈值」。比较 prefix/suffix 这种短字符串足够了。
   *
   * ⚠️ 单位是 **UTF-16 code unit**，与 Range 偏移、String.indexOf 一致。
   * 一个 emoji 改动算 2 个错误 —— 与 approx-string-match 的行为相同。
   *
   * @returns {number} 编辑距离；超过 maxErrors 时返回 maxErrors + 1
   */
  function editDistance(a, b, maxErrors) {
    if (a === b) return 0;
    if (!a.length) return Math.min(b.length, maxErrors + 1);
    if (!b.length) return Math.min(a.length, maxErrors + 1);

    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;

    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      var rowMin = cur[0];
      var ca = a.charCodeAt(i - 1);

      for (var k = 1; k <= b.length; k++) {
        var cost = ca === b.charCodeAt(k - 1) ? 0 : 1;
        var v = Math.min(
          prev[k - 1] + cost,   // 替换 / 匹配
          prev[k] + 1,          // 删除 a 的字符
          cur[k - 1] + 1        // 插入 b 的字符
        );
        cur[k] = v;
        if (v < rowMin) rowMin = v;
      }

      if (rowMin > maxErrors) return maxErrors + 1;

      var swap = prev; prev = cur; cur = swap;
    }

    var result = prev[b.length];
    return result > maxErrors ? maxErrors + 1 : result;
  }

  /**
   * 两个字符串的相似度，归一到 [0, 1]。
   *
   * 与 Hypothesis 的 `textMatchScore` 一致：除以**被比较的模板串长度**
   * （即我们存储的 prefix/suffix），而不是文档切片长度。
   */
  function similarity(template, str) {
    if (!str) return 1;          // 没有存上下文 → 不作判断，给满分
    if (!template) return 0;
    var maxErrors = str.length;
    var errors = editDistance(template, str, maxErrors);
    return 1 - Math.min(errors, maxErrors) / maxErrors;
  }

  /* ------------------------------------------------------------------ *
   * 探针生成
   * ------------------------------------------------------------------ */

  /** 从数组里均匀采样至多 n 个元素（保序） */
  function sampleEvenly(arr, n) {
    if (arr.length <= n) return arr;
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(arr[Math.round(i * (arr.length - 1) / (n - 1))]);
    }
    return out;
  }

  /**
   * 从 quote 里挑若干段有辨识度的子串当探针，并记录每段在 quote 中的位置。
   * 用探针的命中位置反推 quote 的起点，避免对全文做 DP。
   *
   * ⚠️ 关键设计：**探针必须比 quote 短**。
   * 探针靠 `indexOf` 精确定位，所以只要编辑错误落在探针内部，这个探针就完全落空。
   * 若探针等于整段 quote（最初的设计），那么「quote 里有一个错字」就会导致
   * 候选数为 0 —— 而这恰恰是模糊匹配最该处理的场景。
   * 因此这里用**较短的、彼此重叠的滑窗**：只要有一个窗口不含错误，就能定位。
   * 对 1 个错误来说，重叠滑窗几乎必然有一个是干净的。
   */
  function buildProbes(quote) {
    var probes = [];
    var seen = new Set();

    function push(text, offset) {
      if (!text || text.length < MIN_PROBE_LEN || seen.has(text)) return;
      seen.add(text);
      probes.push({ text: text, offset: offset });
    }

    var len = quote.length;
    if (len <= MIN_PROBE_LEN) {
      push(quote, 0);
      return probes;
    }

    // 探针长度取 quote 的约一半（上限 MAX_PROBE_LEN），这样错误才可能落在探针之外
    var probeLen = Math.min(MAX_PROBE_LEN, Math.max(MIN_PROBE_LEN, Math.floor(len * 0.55)));
    probeLen = Math.min(probeLen, len);
    var stride = Math.max(1, Math.floor(probeLen / 3));
    var maxStart = len - probeLen;

    var offsets = [];
    for (var o = 0; o <= maxStart; o += stride) offsets.push(o);
    if (offsets[offsets.length - 1] !== maxStart) offsets.push(maxStart);

    sampleEvenly(offsets, MAX_PROBES).forEach(function (offset) {
      push(quote.slice(offset, offset + probeLen), offset);
    });

    // 最长的那个词 —— 长词在文档里通常最稀有，命中位置最有价值
    var words = quote.split(/\s+/).filter(function (w) { return w.length >= 8; });
    if (words.length) {
      words.sort(function (x, y) { return y.length - x.length; });
      var longest = words[0].slice(0, 24);
      push(longest, quote.indexOf(longest));
    }

    return probes;
  }

  /* ------------------------------------------------------------------ *
   * 带状编辑距离
   * ------------------------------------------------------------------ */

  /**
   * 带状 Levenshtein 距离：只计算 |i - j| <= maxErrors 的对角带内的单元格。
   *
   * 复杂度 O((m+n)·k) 而不是 O(m·n)，这是模糊匹配能跑起来的关键。
   * 允许两个字符串不等长（`|m - n| <= maxErrors` 才有解），
   * 因此可以同时用来判断「原文多/少了一个字符」。
   *
   * @returns {number} 编辑距离；超出带宽或超过 maxErrors 时返回 maxErrors + 1
   */
  function bandedEditDistance(a, b, maxErrors) {
    var m = a.length;
    var n = b.length;

    if (m === 0) return n <= maxErrors ? n : maxErrors + 1;
    if (n === 0) return m <= maxErrors ? m : maxErrors + 1;
    if (Math.abs(m - n) > maxErrors) return maxErrors + 1;

    var INF = maxErrors + 1;
    var prev = new Int32Array(n + 1);
    var cur = new Int32Array(n + 1);

    // ⚠️ 两个数组都必须先整体填成 INF。
    //
    // 每行只清理自己带内的格子（见下面 cur.fill(INF, lo-1, hi+1)），这是为了省掉
    // 整行 fill 的 O(m·n)。但第 i 行在 k = hi = i+maxErrors 处会读 prev[i+maxErrors]，
    // 而上一行只写到 i-1+maxErrors —— 也就是说**带右边缘那一格从来没有被任何一行
    // 写过**。Int32Array 初始化为 0，于是 `prev[k] + 1` 会得到 0+1=1，
    // 凭空造出一条「只差 1 个字符」的假路径，并且顺着带边缘向下传播。
    //
    // 这个错误**只会低估、不会高估**，所以症状是：正文已被改得面目全非的候选
    // 被报成 errors=1 并被当作模糊匹配采纳 —— 高亮画在完全无关的段落上，
    // 还标着「仅 1 处差异」。
    prev.fill(INF);
    cur.fill(INF);

    for (var j = 0; j <= n; j++) prev[j] = j <= maxErrors ? j : INF;

    for (var i = 1; i <= m; i++) {
      // 只清理本行要写的带状区间（含左邻一格），避免整行 fill 带来的 O(n·m)
      var lo = Math.max(1, i - maxErrors);
      var hi = Math.min(n, i + maxErrors);
      cur.fill(INF, lo - 1, hi + 1);
      cur[0] = i <= maxErrors ? i : INF;

      var rowMin = cur[0];
      var ca = a.charCodeAt(i - 1);

      for (var k = lo; k <= hi; k++) {
        var cost = ca === b.charCodeAt(k - 1) ? 0 : 1;
        var best = prev[k - 1] + cost;
        var up = prev[k] + 1;
        if (up < best) best = up;
        var left = cur[k - 1] + 1;
        if (left < best) best = left;

        cur[k] = best;
        if (best < rowMin) rowMin = best;
      }

      if (rowMin > maxErrors) return INF;

      var swap = prev; prev = cur; cur = swap;
    }

    return prev[n] > maxErrors ? INF : prev[n];
  }

  /**
   * 微调候选区间的**终点长度**。
   *
   * 主搜索用等长窗口定位起点，所以拿到的区间长度恒为 quote.length。
   * 但若页面上的原文多了一个字符（如 "dozen" → "dozzen"），正确区间会比
   * quote 长一格 —— 不修正的话高亮会在末尾差一个字符，肉眼可见。
   *
   * 只在候选附近试几个长度，取编辑距离更小的那个；同分则保持长度不变
   * （不引入无谓的偏移）。
   */
  function refineLength(text, quote, cand, maxErrors) {
    var span = Math.min(maxErrors, 12);
    var bestEnd = cand.end;
    var bestErrors = cand.errors;

    for (var d = -span; d <= span; d++) {
      if (d === 0) continue;
      var length = quote.length + d;
      if (length < 1 || cand.start + length > text.length) continue;

      var errors = bandedEditDistance(
        quote, text.substr(cand.start, length), maxErrors
      );
      if (errors < bestErrors) {
        bestErrors = errors;
        bestEnd = cand.start + length;
      }
    }

    return { start: cand.start, end: bestEnd, errors: bestErrors };
  }

  /* ------------------------------------------------------------------ *
   * 精确与近似匹配
   * ------------------------------------------------------------------ */

  /**
   * 找出 exact 在 text 里出现的全部位置（精确匹配快路径）。
   * @returns {number[]} 起点偏移数组
   */
  function findExactMatches(text, exact) {
    var starts = [];
    if (!exact) return starts;

    var from = 0;
    var at;
    while ((at = text.indexOf(exact, from)) !== -1) {
      starts.push(at);
      if (starts.length >= 500) break;   // 病态情况保护
      from = at + 1;                      // +1 而不是 +exact.length，允许重叠匹配
    }
    return starts;
  }

  /**
   * 近似匹配：找出与 quote 编辑距离不超过 maxErrors 的候选区间。
   *
   * 策略：先用若干个**短探针**在文档里定位候选起点，再在每个候选位置用带状
   * 编辑距离验证。比全文半全局 DP 快几个数量级。
   *
   * 起点为什么要采样多个：探针精确命中的位置只能反推出「quote 起点的大致位置」，
   * 若 quote 在探针之前有插入/删除，估计值会偏移，偏移量上界就是错误数。
   * 带状 DP 自身能吸收 ±maxErrors 的位移，所以按 maxErrors/2 的间隔采样即可覆盖。
   *
   * 返回的区间长度恒等于 quote.length（因为用的是等长带状比较）。
   * 这意味着「文本被删掉几个字符」的场景下，区间右端可能略微超出实际范围 ——
   * 可接受，因为锚定成功的判定只要求编辑距离在阈值内。
   *
   * @returns {Array<{start: number, end: number, errors: number}>}
   *          按 errors 升序、再按 start 升序
   */
  function approxMatch(text, quote, maxErrors) {
    var results = [];
    var probes = buildProbes(quote);
    if (!probes.length || !quote.length) return results;

    var m = quote.length;

    // 起点采样：覆盖 [-maxErrors, +maxErrors]
    var step = Math.max(1, maxErrors >> 1);
    var shifts = [];
    for (var d = -maxErrors; d <= maxErrors; d += step) shifts.push(d);
    if (shifts[shifts.length - 1] !== maxErrors) shifts.push(maxErrors);

    var best = new Map();          // start → 最小 errors
    var cellsUsed = 0;
    var budgetExhausted = false;

    for (var p = 0; p < probes.length && !budgetExhausted; p++) {
      var probe = probes[p];
      var from = 0;
      var at;
      var hits = 0;

      while ((at = text.indexOf(probe.text, from)) !== -1 && hits < MAX_PROBE_HITS) {
        hits++;
        from = at + 1;

        // 由探针位置反推 quote 的起点
        var estimate = at - probe.offset;

        for (var s = 0; s < shifts.length; s++) {
          var start = estimate + shifts[s];
          if (start < 0 || start + m > text.length) continue;

          // 预估本轮 DP 的单元格数，超预算就停手
          var cost = m * (2 * maxErrors + 1);
          if (cellsUsed + cost > MAX_DP_CELLS) {
            budgetExhausted = true;
            break;
          }
          cellsUsed += cost;

          var errors = bandedEditDistance(quote, text.substr(start, m), maxErrors);
          if (errors <= maxErrors) {
            var previous = best.get(start);
            if (previous === undefined || errors < previous) best.set(start, errors);
          }
        }

        if (budgetExhausted) break;
      }
    }

    best.forEach(function (errors, start) {
      results.push({ start: start, end: start + m, errors: errors });
    });

    results.sort(function (a, b) {
      return a.errors - b.errors || a.start - b.start;
    });

    // 只对最有希望的几个候选微调终点长度 —— 修正「原文多/少了一个字符」导致的
    // 高亮截断。全量微调会让开销乘以 (2·maxErrors)，不值得。
    var refineCount = Math.min(MAX_REFINE, results.length);
    for (var r = 0; r < refineCount; r++) {
      var refined = refineLength(text, quote, results[r], maxErrors);
      results[r] = refined;
    }

    results.sort(function (a, b) {
      return a.errors - b.errors || a.start - b.start;
    });
    return results;
  }

  /* ------------------------------------------------------------------ *
   * 打分
   * ------------------------------------------------------------------ */

  /**
   * 给一个候选区间打分，用于消歧（同一条 exact 在文档里出现多次时选哪一处）。
   *
   * @param {{start: number, end: number, errors: number}} cand
   * @param {{text: string, exact: string, prefix?: string, suffix?: string,
   *          hint?: number}} ctx
   * @returns {number} 归一到 [0, 1]
   */
  function scoreCandidate(cand, ctx) {
    var text = ctx.text;
    var w = HA.SCORE_WEIGHTS;

    var quoteScore = 1 - cand.errors / Math.max(1, ctx.exact.length);

    var prefixScore = ctx.prefix
      ? similarity(text.slice(Math.max(0, cand.start - ctx.prefix.length), cand.start), ctx.prefix)
      : 1;

    var suffixScore = ctx.suffix
      ? similarity(text.slice(cand.end, cand.end + ctx.suffix.length), ctx.suffix)
      : 1;

    var posScore = 1;
    if (typeof ctx.hint === 'number' && text.length) {
      posScore = 1 - Math.abs(cand.start - ctx.hint) / text.length;
    }

    var raw = w.quote * quoteScore
            + w.prefix * prefixScore
            + w.suffix * suffixScore
            + w.pos * posScore;

    return raw / HA.SCORE_TOTAL;
  }

  /* ------------------------------------------------------------------ *
   * 掩码（解决「同一段文字被多条标注指向」）
   * ------------------------------------------------------------------ */

  /**
   * 把已被占用的区间填成占位字符，然后重跑搜索。
   *
   * 这是 `cuspymd/text-highlighter` 的解冲突技巧：两条标注指向同一句话时，
   * 先解析成功的一方「占位」，把该区间掩掉后重新搜索，第二条自然落到别处。
   * 比引入复杂匹配库轻得多。
   *
   * 注意用 split('') 会按 UTF-16 code unit 切开 —— 这正是我们偏移量的单位，
   * 所以掩码前后长度不变，偏移依然有效。
   *
   * @param {string} text
   * @param {Array<{start: number, end: number}>} regions
   * @returns {string}
   */
  function maskRegions(text, regions) {
    if (!regions || !regions.length) return text;

    var chars = text.split('');
    for (var r = 0; r < regions.length; r++) {
      var region = regions[r];
      var end = Math.min(region.end, chars.length);
      for (var i = Math.max(0, region.start); i < end; i++) {
        chars[i] = ' ';
      }
    }
    return chars.join('');
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  HA.findExactMatches = findExactMatches;
  HA.approxMatch = approxMatch;
  HA.scoreCandidate = scoreCandidate;
  HA.maskRegions = maskRegions;
  HA.editDistance = editDistance;
  HA.bandedEditDistance = bandedEditDistance;
  HA.similarity = similarity;

  /** 模糊匹配允许的错误数：取 1/3 长度与上限的较小值。
   *  Hypothesis 用 min(256, len/2)，我们更保守，因为短 quote 假阳性是主要错误来源。 */
  HA.maxErrorsFor = function (exact) {
    return Math.min(HA.MAX_ERRORS_CAP, Math.floor(exact.length / 3));
  };

})(globalThis.HA || (globalThis.HA = {}));
