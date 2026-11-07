'use strict';
/**
 * 锚点核心 —— describe（选区 → 选择器）与 anchor（选择器 → 选区）。
 *
 * ## 降级链
 *
 * 顺序为「先用最便宜的方法拿到 Range，再用 `exact` 校验」，失败即退到下一级。
 * 比「quote 优先」快得多：DOM 未变时无需搜索，直接命中。
 *
 *   Step 0  RangeSelector          XPath 还原，最快最准，但最脆
 *   Step 1  TextPositionSelector   抗结构变化，不抗内容变化；失败时留下 hint
 *   Step 2  TextQuoteSelector      精确搜索；命中多处则按上下文打分消歧
 *   Step 3  TextQuoteSelector      模糊匹配（仅在 Step 2 零命中时）
 *   Step 4  放弃 → orphan          保留数据 + 展示原文 + 允许手动重定位
 *
 * 每一级返回**结构化结果**而非抛出异常。用异常控制降级同样可行，
 * 但会丢掉「为什么失败」——而失败原因正是界面需要展示给用户的信息。
 *
 * ## 为什么 orphan 不是异常情况
 *
 * 有论文统计 Hypothesis 上 20,953 条高亮：约 22% 已无法附着到原网页，
 * 仍能附着的里 53% 处于「页面一变就变孤儿」的风险中，而成为孤儿的只有
 * 约 12% 能靠网页存档救回（arXiv:1512.06195）。所以「定位失败」是常态，
 * 必须显式呈现，不能静默丢弃。
 */
(function (HA) {

  /** 从选择器数组里按类型取一个 */
  function pick(selectors, type) {
    if (!selectors) return null;
    for (var i = 0; i < selectors.length; i++) {
      if (selectors[i] && selectors[i].type === type) return selectors[i];
    }
    return null;
  }

  /* ================================================================== *
   * describe：选区 → 选择器
   * ================================================================== */

  /**
   * 生成上下文的长度：从 HA.CONTEXT_LEN 起，若「prefix + exact + suffix」
   * 在文档里不止一处命中，就成倍加长直到唯一（上限 HA.CONTEXT_LEN_MAX）。
   *
   * 恰好够用即停，避免存下一堆无用上下文让 selector 更脆
   * （Text Fragments 规范同样建议「只在有歧义时才加 context」）。
   */
  function chooseContext(text, start, end, exact) {
    var ctxLen = HA.CONTEXT_LEN;

    for (;;) {
      var prefix = text.slice(Math.max(0, start - ctxLen), start);
      var suffix = text.slice(end, end + ctxLen);
      var pattern = prefix + exact + suffix;
      var patternStart = start - prefix.length;

      var hits = HA.findExactMatches(text, pattern);
      if (hits.length <= 1
          && (hits.length === 0 || hits[0] === patternStart)) {
        return { prefix: prefix, suffix: suffix };
      }

      if (ctxLen >= HA.CONTEXT_LEN_MAX) {
        // 加到头还是无法唯一，接受现状：降级链后面的打分逻辑会消歧
        return { prefix: prefix, suffix: suffix };
      }
      ctxLen = Math.min(HA.CONTEXT_LEN_MAX, ctxLen * 2);
    }
  }

  /**
   * 描述一个选区端点，用于失败诊断。
   * 只收集**纯数据**，方便直接复制粘贴出来分析。
   */
  function describePoint(node, offset) {
    if (!node) return { nodeType: 'null' };

    var element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    var skipped = HA.skippedAncestorOf(node);

    var xpath = null;
    try {
      xpath = HA.xpathFromNode(node);
    } catch (err) {
      xpath = '(xpath 生成失败)';
    }

    return {
      nodeType: node.nodeType === Node.TEXT_NODE ? 'text'
              : node.nodeType === Node.ELEMENT_NODE ? 'element'
              : 'other(' + node.nodeType + ')',
      tagName: element ? element.tagName : null,
      offset: offset,
      length: node.nodeType === Node.TEXT_NODE
        ? node.data.length
        : node.childNodes.length,
      xpath: xpath,
      /** 命中这个的话就是「不可标注」最常见的原因 */
      insideSkippedSubtree: skipped ? skipped.tagName : null,
    };
  }

  /**
   * 构造一个结构化的失败结果。
   *
   * 之所以要这么细，是因为「这段内容没法标注」对用户和开发者都是**无信息量**的
   * —— 它既没说是哪个环节失败，也没给出可能的原因。
   * 把诊断信息输出到控制台，才有可能逐步把能支持的场景补上。
   */
  function describeFailure(reason, range, root, index) {
    var detail = {
      reason: reason,
      pageUrl: (typeof location !== 'undefined' ? location.href : null),
      rootTag: root && root.nodeType === Node.ELEMENT_NODE ? root.tagName : null,
      canonicalTextLength: index ? index.text.length : null,
      collapsed: range ? !!range.collapsed : null,
      selectedText: null,
      start: null,
      end: null,
    };

    try {
      if (range) {
        detail.selectedText = range.toString().slice(0, 120);
        detail.start = describePoint(range.startContainer, range.startOffset);
        detail.end = describePoint(range.endContainer, range.endOffset);
        detail.insideRoot = !!(root && root.contains(range.startContainer)
          && root.contains(range.endContainer));
      }
    } catch (err) {
      detail.collectError = String(err && err.message || err);
    }

    var hints = {
      'no-range': '没有拿到选区对象。可能是页面脚本清掉了选区，或者选区在我们的 UI 里。',
      'unmappable': '端点落不进文本坐标系。'
        + '最常见的原因是端点在被跳过的子树里（script / style / textarea / svg 等），'
        + '或者选区不在锚定根（document.body）之内。',
      'empty-text': '端点映射成功，但切出来的文本是空的 —— 选区可能只覆盖了不可见内容。',
    };

    detail.hint = hints[reason] || reason;

    return { ok: false, reason: reason, detail: detail };
  }

  /**
   * 把一个失败结果打到控制台。信息量要足够定位问题，且能直接复制走。
   *
   * @param {Object} failure describe() 返回的失败结果
   */
  HA.reportDescribeFailure = function (failure) {
    if (!failure || failure.ok !== false) return;

    var d = failure.detail || {};

    console.warn(
      '[HA] 无法标注这段选区 —— 原因：' + failure.reason + '\n'
      + '  hint        : ' + d.hint + '\n'
      + '  选中文本     : ' + JSON.stringify(d.selectedText) + '\n'
      + '  起点         : ' + formatPoint(d.start) + '\n'
      + '  终点         : ' + formatPoint(d.end) + '\n'
      + '  在锚定根内   : ' + d.insideRoot + '（根元素 <' + String(d.rootTag).toLowerCase() + '>）\n'
      + '  规范文本长度 : ' + d.canonicalTextLength + '\n'
      + '  页面         : ' + d.pageUrl + '\n'
      + '\n完整诊断对象：',
      d
    );
  };

  function formatPoint(point) {
    if (!point) return '(无)';
    if (point.nodeType === 'null') return '(空节点)';

    var text = point.nodeType === 'text' ? '文本节点' : '元素节点';
    var skipped = point.insideSkippedSubtree
      ? '  ⚠️ 在被跳过的 <' + String(point.insideSkippedSubtree).toLowerCase() + '> 子树内'
      : '';

    return text + ' <' + String(point.tagName).toLowerCase() + '>'
      + ' 偏移 ' + point.offset + '/' + point.length
      + '  xpath=' + point.xpath + skipped;
  }

  /**
   * 由一个 Range 生成全部选择器。
   *
   * 一次 describe 就产出三个 selector，因为它们各自在不同降级阶段有用
   * （WADM 规范原文：多个 selector 描述同一段内容，消费端「MUST pick one」——
   * 是**备选**语义，不是合取，也不是 refinedBy 递归链）。
   *
   * @param {Node} root 锚定根，通常是 document.body
   * @param {Range} range
   * @returns {{ok: true, selectors: Array, anchorMeta: Object}
   *          | {ok: false, reason: string, detail: Object}}
   *          失败时不要只看 ok=false —— detail 里有可定位问题的诊断信息
   */
  HA.describe = function (root, range) {
    if (!range) {
      return describeFailure('no-range', range, root, null);
    }

    var index = HA.getTextIndex(root);

    var offsets = HA.rangeToOffsets(index, range);
    if (!offsets) {
      return describeFailure('unmappable', range, root, index);
    }

    var exact = index.text.slice(offsets.start, offsets.end);
    if (!exact) {
      return describeFailure('empty-text', range, root, index);
    }

    var context = chooseContext(index.text, offsets.start, offsets.end, exact);

    var selectors = [
      {
        type: 'RangeSelector',
        startXPath: HA.xpathFromNode(range.startContainer),
        startOffset: range.startOffset,
        endXPath: HA.xpathFromNode(range.endContainer),
        endOffset: range.endOffset,
      },
      {
        type: 'TextPositionSelector',
        start: offsets.start,
        end: offsets.end,
      },
      {
        type: 'TextQuoteSelector',
        exact: exact,
        prefix: context.prefix,
        suffix: context.suffix,
      },
    ];

    return {
      ok: true,
      selectors: selectors,
      anchorMeta: {
        // 归一化规则版本。锚定根固定为 document.body，不做作用域限定。
        canonicalTextVersion: HA.CANONICAL_TEXT_VERSION,
      },
    };
  };

  /* ================================================================== *
   * anchor：选择器 → 选区
   * ================================================================== */

  function result(status, score, range, extra) {
    var out = { status: status, score: score, range: range || null };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key];
      }
    }
    return out;
  }

  /**
   * 从多个候选里挑最优，并判断是否有歧义。
   *
   * ⚠️ 分差小于 HA.AMBIGUITY_EPSILON 时**不要猜** —— 标为 ambiguous 交给用户判断。
   * 短 quote 上的误匹配是主要的错误来源，不确定性必须外显。
   */
  function pickBest(candidates, ctx) {
    var scored = candidates.map(function (cand) {
      return {
        start: cand.start,
        end: cand.end,
        errors: cand.errors,
        score: HA.scoreCandidate(cand, ctx),
      };
    });

    scored.sort(function (a, b) {
      return b.score - a.score || a.start - b.start;
    });

    var top = scored[0];
    var second = scored[1];
    var ambiguous = !!second
      && (top.score - second.score) < HA.AMBIGUITY_EPSILON;

    return { best: top, ambiguous: ambiguous };
  }

  /**
   * 把选择器解析回 Range。
   *
   * @param {Node} root
   * @param {Array} selectors
   * @param {{hint?: number, maskedText?: string, offsetShift?: number,
   *          skipStructural?: boolean, deterministicOnly?: boolean}} [options]
   * @returns {{status: string, score: number, range: Range|null,
   *            refreshed?: {start: number, end: number}, reason?: string}}
   */
  HA.anchor = function (root, selectors, options) {
    options = options || {};
    var index = HA.getTextIndex(root);

    var quoteSel = pick(selectors, 'TextQuoteSelector');
    var positionSel = pick(selectors, 'TextPositionSelector');
    var rangeSel = pick(selectors, 'RangeSelector');

    var exact = quoteSel && quoteSel.exact ? quoteSel.exact : null;
    if (!exact) {
      // 没有 TextQuoteSelector 的标注既无法自解释也无法校验，一律判为孤儿，
      // 但给出明确原因，便于排查。
      return result(HA.STATUS.ORPHAN, 0, null, { reason: 'missing-quote' });
    }

    var hint = typeof options.hint === 'number' ? options.hint
             : (positionSel ? positionSel.start : undefined);

    var text = options.maskedText !== undefined ? options.maskedText : index.text;
    var textShift = (options.maskedText !== undefined && options.offsetShift)
      ? options.offsetShift : 0;

    /* -------- Step 0：RangeSelector -------- */
    if (rangeSel && !options.skipStructural) {
      var range = HA.rangeFromXpath(
        rangeSel.startXPath, rangeSel.startOffset,
        rangeSel.endXPath, rangeSel.endOffset
      );
      if (range) {
        var spanned = HA.rangeToText(index, range);
        if (spanned === exact) {
          return result(HA.STATUS.EXACT, 1, range, { matchedText: exact });
        }
      }
    }

    /* -------- Step 1：TextPositionSelector -------- */
    //
    // ⚠️ 偏移量是在 canonical text 上算出来的，所以**只有归一化规则版本一致时
    // 才能信它**。规则一旦改动（比如 v2 决定给块级元素插分隔符），历史偏移会
    // 指向完全不同的文本 —— 此时它只能当搜索起点，不能参与「精确命中」判定。
    //
    // 不校验的话，`canonicalTextVersion` 这个字段就是空转的：
    // 注释说「规则一改就知道旧偏移作废」，代码却从没读过它。
    var positionIsCurrent = options.canonicalTextVersion === undefined
      || options.canonicalTextVersion === HA.CANONICAL_TEXT_VERSION;

    if (positionSel
        && typeof positionSel.start === 'number'
        && typeof positionSel.end === 'number') {
      if (positionIsCurrent) {
        var slice = index.text.slice(positionSel.start, positionSel.end);
        if (slice === exact) {
          var positioned = HA.offsetsToRange(index, positionSel.start, positionSel.end);
          if (positioned) {
            return result(HA.STATUS.EXACT, 1, positioned, { matchedText: exact });
          }
        }
      }
      // 位置对不上（或版本过期），但它是很有价值的搜索起点
      if (typeof hint !== 'number') hint = positionSel.start;
    }

    /** 收尾：统一带上「偏移已过期」的标记，让上层知道这条线索不可全信 */
    var build = function (status, score, range, extra) {
      var merged = {};
      if (extra) {
        for (var key in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, key)) merged[key] = extra[key];
        }
      }
      if (!positionIsCurrent) merged.stalePosition = true;
      return result(status, score, range, merged);
    };

    // 只做确定性定位（不搜索）—— 批量锚定的第一轮用这个模式：
    // 先让 XPath / TextPosition 这些不依赖搜索的线索占住位置，
    // 剩下的再统一走带掩码的搜索，避免「全都锚到第一个出现位置」。
    if (options.deterministicOnly) {
      return build(HA.STATUS.ORPHAN, 0, null, { reason: 'needs-search' });
    }

    /* -------- Step 2：精确搜索 -------- */
    var matches = HA.findExactMatches(text, exact).map(function (start) {
      return {
        start: start + textShift,
        end: start + textShift + exact.length,
        errors: 0,
      };
    });

    if (matches.length === 1) {
      var single = HA.offsetsToRange(index, matches[0].start, matches[0].end);
      if (single) {
        return build(HA.STATUS.EXACT, 1, single, {
          refreshed: { start: matches[0].start, end: matches[0].end },
          matchedText: exact,
        });
      }
    }

    if (matches.length > 1) {
      var picked = pickBest(matches, {
        text: index.text, exact: exact,
        prefix: quoteSel.prefix, suffix: quoteSel.suffix,
        hint: typeof hint === 'number' ? hint : undefined,
      });

      var chosen = HA.offsetsToRange(index, picked.best.start, picked.best.end);
      if (chosen) {
        return build(
          picked.ambiguous ? HA.STATUS.AMBIGUOUS : HA.STATUS.DISAMBIGUATED,
          picked.best.score, chosen,
          {
            refreshed: { start: picked.best.start, end: picked.best.end },
            candidateCount: matches.length,
            matchedText: index.text.slice(picked.best.start, picked.best.end),
          }
        );
      }
    }

    /* -------- Step 3：模糊匹配 -------- */
    if (exact.length >= HA.MIN_FUZZY_QUOTE_LEN) {
      // 用掩码文本时，模糊匹配的偏移也需相应平移
      var approximately = HA.approxMatch(text, exact, HA.maxErrorsFor(exact));
      if (approximately.length) {
        var best = pickBest(
          approximately.map(function (cand) {
            return {
              start: cand.start + textShift,
              end: cand.end + textShift,
              errors: cand.errors,
            };
          }),
          {
            text: index.text, exact: exact,
            prefix: quoteSel.prefix, suffix: quoteSel.suffix,
            hint: typeof hint === 'number' ? hint : undefined,
          }
        );

        var fuzzyRange = HA.offsetsToRange(index, best.best.start, best.best.end);
        if (fuzzyRange) {
          return build(HA.STATUS.FUZZY, best.best.score, fuzzyRange, {
            refreshed: { start: best.best.start, end: best.best.end },
            errors: best.best.errors,
            matchedText: index.text.slice(best.best.start, best.best.end),
          });
        }
      }
    }

    /* -------- Step 4：放弃 -------- */
    return build(HA.STATUS.ORPHAN, 0, null, { reason: 'not-found' });
  };

  /* ================================================================== *
   * 批量锚定
   * ================================================================== */

  /**
   * 批量锚定一组标注，并解决「同一段文字被多条标注指向」的冲突。
   *
   * 两轮：
   *   第一轮 —— 只跑确定性的 Step 0/1（XPath / TextPosition），它们不依赖搜索，
   *             先让它们占住自己的位置。
   *   第二轮 —— 剩下的走搜索（Step 2/3），并且**每成功一条就把该区间掩掉**，
   *             这样下一条自然落到别处，不会全都锚到第一个出现位置。
   *
   * 用掩码而非引入复杂匹配库，成本低得多。
   *
   * @param {Node} root
   * @param {Array<{id: string, selectors: Array}>} items
   * @returns {Map<string, Object>} id → anchor 结果
   */
  HA.anchorBatch = function (root, items) {
    var index = HA.getTextIndex(root);
    var results = new Map();
    var claimed = [];
    var pending = [];

    // 第一轮：确定性定位（不搜索）
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var deterministic = HA.anchor(root, item.selectors, {
        deterministicOnly: true,
        canonicalTextVersion: item.anchorMeta && item.anchorMeta.canonicalTextVersion,
      });

      if (deterministic.range) {
        var offs = HA.rangeToOffsets(index, deterministic.range);
        if (offs) claimed.push(offs);
        results.set(item.id, deterministic);
      } else {
        pending.push(item);
      }
    }

    // 第二轮：搜索定位，用掩码文本避免重复锚到同一处
    var maskedText = claimed.length ? HA.maskRegions(index.text, claimed) : index.text;

    for (var j = 0; j < pending.length; j++) {
      var pendingItem = pending[j];
      var outcome = HA.anchor(root, pendingItem.selectors, {
        maskedText: maskedText,
        skipStructural: true,      // 第一轮已经试过，不用重复
        canonicalTextVersion: pendingItem.anchorMeta
          && pendingItem.anchorMeta.canonicalTextVersion,
      });

      if (outcome.range) {
        var found = HA.rangeToOffsets(index, outcome.range);
        if (found) {
          maskedText = HA.maskRegions(maskedText, [found]);
        }
      }
      results.set(pendingItem.id, outcome);
    }

    return results;
  };

})(globalThis.HA || (globalThis.HA = {}));
