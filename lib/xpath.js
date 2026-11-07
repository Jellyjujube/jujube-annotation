'use strict';
/**
 * XPath 的生成与解析 —— 锚点降级链里的 Step 0（RangeSelector）。
 *
 * ## 两条硬性约束（都有规范/实现依据）
 *
 * 1. **绝不用 XPath 1.0 的 `id()` 函数。** 它依赖 DTD 里声明为 ID 类型的属性，
 *    而 HTML 文档通常没有 DTD，浏览器大多返回空集。要用 `//*[@id="foo"]`。
 * 2. **文本节点索引用位置谓词 `text()[n]`，不能用 `nth-of-type`** —— 后者是
 *    元素概念，对文本节点无效。
 * 3. XPath 必须**从 live DOM 生成**。W3C WADM 给实现者的 Note 明确说：
 *    HTML5 允许 parser 插入源码里没有的元素，XPath 应把这些元素也算进去，
 *    而不是按源码的元素结构构造。
 *
 * ## 为什么用「最近的带 id 祖先」做锚
 *
 * 纯位置路径（`/html[1]/body[1]/div[2]/p[1]`）前面插入任何一个兄弟节点就废了。
 * 以最近的带 id 祖先为根能大幅提升抗插入能力。
 *
 * 但 id 本身未必稳定（React 会生成 `:r0:` 这类、随机后缀、每次部署变一次），
 * 所以这里**不做「id 是否稳定」的猜测** —— RangeSelector 只是降级链的 Step 0，
 * 它的结果一定会被 exact 校验，猜错了自然降级到后面的步骤，不会有副作用。
 */
(function (HA) {

  /**
   * 把字符串转成合法的 XPath 字符串字面量。
   * 单双引号混在 id 里时用 concat() 拼接（XPath 1.0 没有转义序列，
   * 只能靠切换引号类型或 concat 来构造）。
   */
  function xpathLiteral(value) {
    if (value.indexOf("'") === -1) return "'" + value + "'";
    if (value.indexOf('"') === -1) return '"' + value + '"';
    // 两种引号都有：按单引号切分，再用 "'" 重新拼起来
    var parts = value.split("'");
    return 'concat(' + parts.map(function (p) {
      return "'" + p + "'";
    }).join(', "\'", ') + ')';
  }

  /** 元素在同一 localName 的兄弟中的序号（1 起） */
  function elementIndex(el) {
    var i = 1;
    var sib = el;
    while ((sib = sib.previousSibling)) {
      if (sib.nodeType === Node.ELEMENT_NODE && sib.localName === el.localName) i++;
    }
    return i;
  }

  /** 文本节点在兄弟文本节点中的序号（1 起） */
  function textIndex(node) {
    var i = 1;
    var sib = node;
    while ((sib = sib.previousSibling)) {
      if (sib.nodeType === Node.TEXT_NODE) i++;
    }
    return i;
  }

  /** 取一个节点可用的 id（元素节点且 id 非空、不是纯数字之类明显生成的值） */
  function usableId(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    var id = node.getAttribute && node.getAttribute('id');
    if (!id) return null;
    // 纯数字、或者形如 :r0: / :r1a: 的 React 生成 id 明显不稳定，但仍可用 ——
    // 反正校验失败会降级。这里只排除「看起来不是 id 的 id」。
    return id;
  }

  /**
   * 由节点生成 XPath。
   *
   * ⚠️ 默认根是 **document（文档节点）而不是 documentElement**。
   * 若以 documentElement 为根，循环会在把 `html[1]` 加进路径之前就退出，
   * 生成 `/body[1]/div[1]` 这种**从文档节点出发并不存在的**路径 —— 它既不是
   * 绝对路径，也无法被 document.evaluate 解析。必须一路走到文档节点。
   *
   * @param {Node} node
   * @param {Node} [root] 走到此节点即停，默认整个 document
   * @returns {string} 空串表示「就是根节点本身」
   */
  HA.xpathFromNode = function (node, root) {
    if (!node) return '';
    root = root || document;
    if (node === root) return '';

    var parts = [];
    var current = node;
    var anchor = '';

    while (current && current !== root) {
      var parent = current.parentNode;
      if (!parent) break;

      if (current.nodeType === Node.TEXT_NODE) {
        parts.unshift('text()[' + textIndex(current) + ']');
      } else if (current.nodeType === Node.ELEMENT_NODE) {
        // 遇到带 id 的祖先就用它当锚，停止向上
        var id = usableId(current);
        if (id && current !== node) {
          anchor = '//*[@id=' + xpathLiteral(id) + ']';
          current = null;
          break;
        }
        if (id && current === node) {
          // 节点自身有 id —— 直接用它做锚，路径最短
          return '//*[@id=' + xpathLiteral(id) + ']';
        }
        parts.unshift(current.localName + '[' + elementIndex(current) + ']');
      } else {
        // 注释、CDATA 等：按同类兄弟计数
        var kind = current.nodeType === Node.COMMENT_NODE ? 'comment()' : 'node()';
        var idx = 1;
        var sib = current;
        while ((sib = sib.previousSibling)) {
          if (sib.nodeType === current.nodeType) idx++;
        }
        parts.unshift(kind + '[' + idx + ']');
      }

      current = parent;
    }

    if (!parts.length) return anchor || '';
    return (anchor || '/') + (anchor ? '/' : '') + parts.join('/');
  };

  /**
   * 解析 XPath 到节点。
   *
   * @param {string} xpath
   * @param {Document} [doc]
   * @returns {Node|null} 解析失败、语法错误、或节点已脱离文档时返回 null
   */
  HA.nodeFromXpath = function (xpath, doc) {
    doc = doc || document;
    if (!xpath) return null;

    var result;
    try {
      result = doc.evaluate(
        xpath, doc, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
    } catch (e) {
      // 非法 XPath 表达式
      return null;
    }

    var node = result.singleNodeValue;
    if (!node) return null;
    // 页面重渲染后旧节点会脱离文档 —— 脱离的节点上建 Range 毫无意义
    if (node.isConnected === false) return null;
    return node;
  };

  /**
   * 由 XPath + 偏移构造 Range（锚点降级链的 Step 0）。
   *
   * @param {string} startXPath
   * @param {number} startOffset
   * @param {string} endXPath
   * @param {number} endOffset
   * @returns {Range|null}
   */
  HA.rangeFromXpath = function (startXPath, startOffset, endXPath, endOffset) {
    var startNode = HA.nodeFromXpath(startXPath);
    var endNode = HA.nodeFromXpath(endXPath);
    if (!startNode || !endNode) return null;

    // 偏移越界会让 setStart 抛 IndexSizeError，先检查
    if (startOffset > nodeLength(startNode)) return null;
    if (endOffset > nodeLength(endNode)) return null;

    var range = document.createRange();
    try {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
    } catch (e) {
      return null;
    }
    return range.collapsed ? null : range;
  };

  function nodeLength(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.data.length;
    return node.childNodes.length;
  }

})(globalThis.HA || (globalThis.HA = {}));
