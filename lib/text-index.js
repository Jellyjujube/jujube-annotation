'use strict';
/**
 * canonical text —— 全文档文本的唯一定义，以及 字符偏移 ↔ (文本节点, 偏移) 的双向映射。
 *
 * ## 为什么需要它
 *
 * 高亮的位置必须持久化成「字符偏移」才能存储，但 DOM 只给你 (node, offset)。
 * 往返转换需要一个**确定的**文本坐标系，而浏览器提供的那些都不合适：
 *
 *   range.toString()  对 <p>foo</p><p>bar</p> 全选返回 "foobar"（不插分隔符）
 *   innerText         返回 "foo\nbar"，但**依赖 layout** —— 离屏元素、display:none、
 *                     尚未加载的内容读到的都不一样，而且读写会强制 reflow
 *   textContent       含 display:none 的内容，但便宜、稳定、无 layout 依赖
 *
 * ## v1 规则（写入 HA.CANONICAL_TEXT_VERSION）
 *
 *   文本节点        → 原样追加 node.data（**不做空白折叠**）
 *   <br>            → 追加一个 '\n'
 *   其他元素        → 不加任何分隔符（保持 "abc" 的连续语义）
 *   被跳过的元素    → 整个子树不计入（脚本、样式、SVG 等，见 SKIP_TAGS）
 *
 * ⚠️ 只把 `<br>` 替换成 `'\n'`，不给块级元素插分隔符 ——
 * 前者解决跨行选择被拼成 "foobar" 的问题，后者会改变文本坐标系、
 * 作废全部历史偏移，需要配合版本号升级再做。
 *
 * ## 使用纪律（非常重要）
 *
 * **永远不要拿 range.toString() 和存的 exact 比较** —— 一定要用它：
 *
 *     var picked = HA.rangeToText(index, range);   // 而不是 range.toString()
 *
 * 因为 canonical text 里 <br> 被替换成了 '\n'，而 range.toString() 不会。
 * 两者混用会让「跨 <br> 的标注」永远锚定失败。
 */
(function (HA) {

  /** 这些元素的子树完全不参与文本索引。
   *  要么内容不可见，要么内容不是「可标注的正文」。 */
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1,
    TITLE: 1, HEAD: 1, META: 1, LINK: 1, BASE: 1,
    SVG: 1,                      // SVG 内文本无法正常选中，跳过以免污染偏移
    TEXTAREA: 1, SELECT: 1,      // 表单控件的值不属于文档正文
    IFRAME: 1, OBJECT: 1, EMBED: 1, CANVAS: 1,
  };

  /**
   * 判断标签名是否属于「不参与文本索引」的那一类。
   *
   * ⚠️ 必须**大小写无关**：HTML 元素的 `tagName` 是大写的（`BODY`、`TEXTAREA`），
   * SVG 元素则是小写的（`svg`）。按大写键查表会漏掉 SVG 子树，
   * 使其文字混入文本坐标系。
   */
  function isSkippedTag(tagName) {
    return !!SKIP_TAGS[String(tagName || '').toUpperCase()];
  }

  /** 是不是 <br>（同样要大小写无关） */
  function isBr(node) {
    return String(node.tagName || '').toUpperCase() === 'BR';
  }

  /**
   * 构建文本索引。
   *
   * @param {Node} root 索引的根节点，通常是 document.body
   * @returns {{root: Node, version: number, text: string,
   *            segments: Array<{node: Text, start: number, end: number}>,
   *            nodeMap: Map<Text, {start: number, end: number}>}}
   */
  HA.buildTextIndex = function (root) {
    var parts = [];
    var segments = [];
    var nodeMap = new Map();
    var cursor = 0;

    var walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            return isSkippedTag(node.tagName) ? NodeFilter.FILTER_REJECT
                                              : NodeFilter.FILTER_ACCEPT;
          }
          // 跳过空文本节点：很多框架会插入它们，计入会让索引无谓变大
          return node.data.length ? NodeFilter.FILTER_ACCEPT
                                  : NodeFilter.FILTER_REJECT;
        },
      }
    );

    // 根节点自身若是 <br> 之类，TreeWalker 的第一个节点是它的第一个子节点，
    // 所以单独处理根元素。
    if (root.nodeType === Node.ELEMENT_NODE && isBr(root)) {
      parts.push('\n');
      cursor += 1;
    }

    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (isBr(node)) {
          parts.push('\n');
          cursor += 1;
        }
        continue;
      }

      var data = node.data;
      var seg = { node: node, start: cursor, end: cursor + data.length };
      segments.push(seg);
      nodeMap.set(node, seg);
      parts.push(data);
      cursor += data.length;
    }

    return {
      root: root,
      version: HA.CANONICAL_TEXT_VERSION,
      text: parts.join(''),
      segments: segments,
      nodeMap: nodeMap,
    };
  };

  /* ------------------------------------------------------------------ *
   * 缓存
   * ------------------------------------------------------------------ */

  var _cache = null;

  /** 取得（必要时构建）根节点的文本索引。
   *  一次锚定批次只构建一次，整批复用 —— 每条标注各遍历一次 DOM 会导致 O(n·m) 爆炸。 */
  HA.getTextIndex = function (root) {
    root = root || HA.defaultRoot();
    if (_cache && _cache.root === root) return _cache;
    _cache = HA.buildTextIndex(root);
    return _cache;
  };

  /** DOM 变化后必须调用。渲染高亮本身不改变 DOM，所以只有页面自己的改动作数。 */
  HA.invalidateTextIndex = function () {
    _cache = null;
  };

  /** 默认锚定根。用 body 而不是 documentElement，避开 <head> 里的文本。 */
  HA.defaultRoot = function () {
    return document.body || document.documentElement;
  };

  /**
   * 找出节点所在的「被索引跳过的子树」的根元素。
   *
   * 选区端点落在这类子树里（`<script>` / `<style>` / `<textarea>` / `<svg>` 等），
   * 是「这段内容没法标注」**最常见**的原因：它们不计入文本坐标系，
   * 没有任何偏移量能描述它们。
   *
   * @returns {Element|null} 命中的那个元素；没有则返回 null
   */
  HA.skippedAncestorOf = function (node) {
    var element = node && (node.nodeType === Node.ELEMENT_NODE
      ? node
      : node.parentElement);

    while (element) {
      if (isSkippedTag(element.tagName)) return element;
      element = element.parentElement;
    }
    return null;
  };

  /* ------------------------------------------------------------------ *
   * 元素端点规范化
   * ------------------------------------------------------------------ */

  /**
   * 遍历子树里的文本节点。
   *
   * ⚠️ 必须**跳过被排除的子树**（`<script>` / `<style>` / `<svg>` …），
   * 否则会返回不在文本索引里的节点，其偏移无法被解析。
   * 用 FILTER_REJECT：对 TreeWalker 而言它会连同子树一起剪掉。
   */
  function eachTextNode(root, visit) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (root.data.length) visit(root);
      return;
    }

    // ⚠️ 必须单独检查**根节点自己**：TreeWalker 从根的后代开始访问，
    // 不会把根本身交给过滤器，因此 `firstTextNode(某个 <script>)` 会走进其子树。
    if (root.nodeType === Node.ELEMENT_NODE && isSkippedTag(root.tagName)) return;

    var walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (n) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            return isSkippedTag(n.tagName) ? NodeFilter.FILTER_REJECT
                                           : NodeFilter.FILTER_ACCEPT;
          }
          return n.data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      }
    );

    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) visit(node);
    }
  }

  /**
   * 在 root 子树里找第一个非空文本节点。
   * @returns {Text|null}
   */
  function firstTextNode(root) {
    var found = null;
    eachTextNode(root, function (node) {
      if (!found) found = node;
    });
    return found;
  }

  /** 在 root 子树里找最后一个非空文本节点。 */
  function lastTextNode(root) {
    var found = null;
    eachTextNode(root, function (node) { found = node; });
    return found;
  }

  /**
   * 子树里完全没有文本时，向祖先的兄弟方向找最近的文本位置。
   *
   * 这类结构在真实页面上非常常见：
   *
   *     <a>地图<span><div></div></span></a>
   *
   * 链接末尾挂一个空 div 当图标占位。用户拖选到那里时，选区端点就落在那个
   * 空 div 上 —— 它自己没有任何文本，但在文档里**是有位置的**，
   * 应该收拢到最近的可标注文本，而不是直接判定「这段内容没法标注」。
   *
   * @param {Node} start 起点（一个子树里没有文本的元素）
   * @param {'forward'|'backward'} prefer 优先朝哪个方向找
   * @returns {{node: Text, offset: number}|null}
   */
  function searchOutward(start, prefer) {
    var boundary = HA.defaultRoot();

    var directions = prefer === 'forward'
      ? ['forward', 'backward']
      : ['backward', 'forward'];

    for (var d = 0; d < directions.length; d++) {
      var direction = directions[d];
      var node = start;

      while (node && node !== boundary) {
        var sibling = direction === 'forward' ? node.nextSibling : node.previousSibling;

        while (sibling) {
          var found = direction === 'forward'
            ? firstTextNode(sibling)
            : lastTextNode(sibling);

          if (found) {
            return direction === 'forward'
              ? { node: found, offset: 0 }
              : { node: found, offset: found.data.length };
          }
          sibling = direction === 'forward' ? sibling.nextSibling : sibling.previousSibling;
        }

        node = node.parentNode;
      }
    }

    return null;
  }

  /**
   * 把 (node, offset) 规范化成 (文本节点, 字符偏移)。
   *
   * 选区的端点**经常是元素节点**（点在段落开头、点在空 div 上等），
   * Range 不会自动帮你规范化 —— 它原样保留元素节点。必须自己处理。
   *
   * @param {Node} node
   * @param {number} offset
   * @param {'forward'|'backward'} [prefer]
   *        子树里完全没有文本时朝哪个方向向外找。
   *        **起点应该传 `forward`、终点应该传 `backward`** —— 这样选区
   *        会收拢到用户真正看到的那段文字，而不是向反方向扩张。
   * @returns {{node: Text, offset: number}|null} 整棵文档都没有文本时返回 null
   */
  HA.normalizePoint = function (node, offset, prefer) {
    if (!node) return null;
    prefer = prefer === 'forward' ? 'forward' : 'backward';

    if (node.nodeType === Node.TEXT_NODE) {
      // 空文本节点：往前/往后找一个邻居，否则这个端点无法表达
      if (node.data.length === 0) {
        return searchOutward(node, prefer)
          || HA.normalizePoint(node.parentNode, 0, prefer);
      }
      return { node: node, offset: Math.min(offset, node.data.length) };
    }

    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) {
      return null;
    }

    var kids = node.childNodes;

    // 端点落在整个子树之后 → 取子树里最后一个文本节点的末尾
    if (offset >= kids.length) {
      var last = lastTextNode(node);
      if (last) return { node: last, offset: last.data.length };
      // 子树里一个文本都没有 → 向外收拢
      return searchOutward(node, 'backward');
    }

    // 向后：childNodes[offset] 及其后续兄弟中的第一个文本节点
    for (var i = offset; i < kids.length; i++) {
      var fwd = firstTextNode(kids[i]);
      if (fwd) return { node: fwd, offset: 0 };
    }

    // 向前：前面兄弟中的最后一个文本节点的末尾
    for (var j = offset - 1; j >= 0; j--) {
      var back = lastTextNode(kids[j]);
      if (back) return { node: back, offset: back.data.length };
    }

    // 子树里一个文本节点都没有（比如图片链接末尾的空 div）——
    // 向外扩散到最近的可标注文本，**不要**直接放弃
    return searchOutward(node, prefer);
  };

  /* ------------------------------------------------------------------ *
   * 偏移 ↔ 点
   * ------------------------------------------------------------------ */

  /**
   * 字符偏移 → (文本节点, 偏移)。
   *
   * 偏移可能落在「插入的分隔符」上（<br> 产生的 '\n'），这种位置不对应任何
   * 文本节点，此时收拢到前一个段的末尾。
   *
   * @returns {{node: Text, offset: number}|null}
   */
  HA.offsetToPoint = function (index, offset) {
    var segs = index.segments;
    if (!segs.length) return null;

    if (offset <= segs[0].start) {
      return { node: segs[0].node, offset: 0 };
    }

    var last = segs[segs.length - 1];
    if (offset >= last.end) {
      return { node: last.node, offset: last.node.data.length };
    }

    // 二分查找最后一个 start <= offset 的段
    var lo = 0, hi = segs.length - 1, found = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (segs[mid].start <= offset) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    var seg = segs[found];
    if (offset < seg.end) {
      return { node: seg.node, offset: offset - seg.start };
    }
    // 落在段之间的空隙（插入的分隔符）→ 收拢到该段末尾
    return { node: seg.node, offset: seg.node.data.length };
  };

  /**
   * (节点, 偏移) → 字符偏移。
   * @returns {number|null}
   */
  HA.pointToOffset = function (index, node, offset, prefer) {
    if (!node) return null;

    if (node.nodeType === Node.TEXT_NODE) {
      var seg = index.nodeMap.get(node);
      if (seg) return seg.start + Math.min(offset, node.data.length);
      // 不在索引里（空文本节点，或位于被跳过的子树内）→ 规范化后再试
      var norm = HA.normalizePoint(node, offset, prefer);
      if (norm && norm.node !== node) {
        return HA.pointToOffset(index, norm.node, norm.offset, prefer);
      }
      return null;
    }

    var point = HA.normalizePoint(node, offset, prefer);
    if (!point) return null;
    return HA.pointToOffset(index, point.node, point.offset, prefer);
  };

  /* ------------------------------------------------------------------ *
   * Range ↔ 偏移
   * ------------------------------------------------------------------ */

  /**
   * Range → canonical text 上的 {start, end}。
   * @returns {{start: number, end: number}|null}
   */
  HA.rangeToOffsets = function (index, range) {
    // ⚠️ 两个端点的**向外查找方向是相反的**：起点优先向后、终点优先向前。
    // 这样当端点落在「没有文本的元素」上时（比如链接末尾的空 div 占位），
    // 选区会收拢到用户真正看到的那段文字，而不是朝反方向把选区拉长。
    var start = HA.pointToOffset(index,
      range.startContainer, range.startOffset, 'forward');
    var end = HA.pointToOffset(index,
      range.endContainer, range.endOffset, 'backward');
    if (start === null || end === null) return null;
    if (start > end) return { start: end, end: start };
    return { start: start, end: end };
  };

  /**
   * canonical text 上的 {start, end} → Range。
   * @returns {Range|null} 无法定位或结果为空时返回 null
   */
  HA.offsetsToRange = function (index, start, end) {
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    if (start > end) { var t = start; start = end; end = t; }
    if (start < 0 || end > index.text.length) return null;

    var p1 = HA.offsetToPoint(index, start);
    var p2 = HA.offsetToPoint(index, end);
    if (!p1 || !p2) return null;

    // 同一文本节点内的坐标要保证有序，否则 setStart/setEnd 会抛 IndexSizeError
    if (p1.node === p2.node && p1.offset > p2.offset) {
      var tmp = p1.offset; p1.offset = p2.offset; p2.offset = tmp;
    }

    var range = document.createRange();
    try {
      range.setStart(p1.node, p1.offset);
      range.setEnd(p2.node, p2.offset);
    } catch (e) {
      return null;
    }
    return range.collapsed ? null : range;
  };

  /**
   * 取一个 Range 覆盖的 canonical text。
   *
   * **这是替代 range.toString() 的正确写法**，务必用它做 exact 校验 —— 详见文件头说明。
   * @returns {string|null}
   */
  HA.rangeToText = function (index, range) {
    var offs = HA.rangeToOffsets(index, range);
    if (!offs) return null;
    return index.text.slice(offs.start, offs.end);
  };

  /** 检查一个 Range 是否还挂在文档上（页面重渲染后旧 Range 会失效） */
  HA.isRangeConnected = function (range) {
    if (!range) return false;
    var sc = range.startContainer;
    var ec = range.endContainer;
    return !!(sc && ec && sc.isConnected && ec.isConnected);
  };

})(globalThis.HA || (globalThis.HA = {}));
