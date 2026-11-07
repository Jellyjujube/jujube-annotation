'use strict';
/**
 * Markdown 导出。
 *
 * ## 只用原生 Markdown，不用表情符号
 *
 * 每条标注就是三块，全是标准语法：
 *
 *     > 引文（blockquote，语义上确实「引自原文」）
 *
 *     **备注：** 自己写的话
 *
 *     `标签` · 颜色 · 日期
 *
 * 不用 emoji 做标记 —— 那些是私有约定，换个渲染器就可能变成乱码，
 * 而且以后加新字段时还得不断挑新符号。
 *
 * ## 抓来的内容必须当**不可信输入**转义
 *
 * 引文是从任意网页上抓的，原样塞进 Markdown 会真的坏掉：
 *
 *   · 里面出现 `<div>` / `<style>` → 渲染器当 HTML 处理，**文字直接消失**
 *   · 出现三个反引号 → 开启代码块，把它之后的内容**全部吞掉**
 *   · 行首的 `#` / `-` / `1.` → 变成标题和列表，污染大纲
 *
 * 所以引文一律走 `escapeLiteral()`。
 *
 * **备注不转义** —— 那是用户自己写的内容，让 Markdown 生效是特性而不是风险。
 * 信任边界就是「谁写的」。
 *
 * ## 分块生成
 *
 * 设计成生成器而不是拼一个大字符串：几千条标注的导出文件可能有几十 MB，
 * 配合 `FileSystemWritableFileStream.write(chunk)` 可以流式写盘。
 */
(function (HA) {

  var DEFAULT_OPTIONS = {
    /** 'site' 按网站分组 | 'page' 按页面分组 | 'none' 不分组 */
    groupBy: 'site',
    includeNote: true,
    includeTags: true,
    includeDate: true,
    includeColor: true,
    /** 自定义标题，为空则用默认值 */
    title: '',
  };

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /** 本地时间戳 → 2026-10-15 14:30 */
  HA.formatDateTime = function (timestamp) {
    if (!timestamp) return '';
    var d = new Date(timestamp);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };

  HA.formatDate = function (timestamp) {
    return HA.formatDateTime(timestamp).split(' ')[0] || '';
  };

  /* ------------------------------------------------------------------ *
   * 转义
   * ------------------------------------------------------------------ */

  /**
   * 会**改变结构或让文字消失**的字符 —— 必须转义。
   *
   *   `\`  转义符本身
   *   `` ` `` 反引号：会开启行内代码或代码块
   *   `<`  会被渲染器当 HTML 标签，**文字直接不显示**
   *   `&`  会被当 HTML 实体（`&amp;` 渲染成 `&`，与原文不符）
   *   `[`  `]`  会构成链接；而 `[1]` 这种引用标记在文章里很常见
   *
   * 刻意**不转义** `>` `*` `_` `~`：
   *   · `>` 只在**行首**才有结构意义，由行首规则处理；行内的 `a > b` 无害
   *   · `*` `_` 只影响那一段的样式，文字仍完整可读
   * 转义它们只会让原始文件变得难读，而收益是零。
   */
  var INLINE_ESCAPE = /[\\`<&\[\]]/g;

  /** 整行只有 - * _ （可含空格）→ 会被当成水平分隔线 */
  var THEMATIC_BREAK = /^([ \t]*)([-*_])(?:[ \t]*\2){2,}[ \t]*$/;

  /** 行首的标题 / 引用 / 列表 / 有序列表标记 */
  var LINE_START_MARKER = /^([ \t]*)(#{1,6}|[-+*>]|\d+[.)])(?=[ \t]|$)/;

  /**
   * 转义行首的结构性标记。
   *
   * ⚠️ 有序列表（`1.`）要单独处理：反斜杠必须加在**标点**前面（`1\.`），
   * 写成 `\1.` 不但起不到转义作用，还会让渲染结果里多出一个反斜杠。
   */
  function escapeLineStart(line) {
    var thematic = line.match(THEMATIC_BREAK);
    if (thematic) {
      // 只转义第一个字符就足以让它不再是分隔线
      return thematic[1] + '\\' + line.slice(thematic[1].length);
    }

    var match = line.match(LINE_START_MARKER);
    if (!match) return line;

    var indent = match[1];
    var token = match[2];
    var rest = line.slice(indent.length + token.length);

    if (/^\d+[.)]$/.test(token)) {
      return indent + token.slice(0, -1) + '\\' + token.slice(-1) + rest;
    }
    return indent + '\\' + token + rest;
  }

  /**
   * 把一段文本转义成「按原样显示」。
   *
   * @param {string} text
   * @returns {string}
   */
  function escapeLiteral(text) {
    return String(text === undefined || text === null ? '' : text)
      .split('\n')
      .map(function (line) {
        return escapeLineStart(line.replace(INLINE_ESCAPE, '\\$&'));
      })
      .join('\n');
  }

  /**
   * 把一个 URL 放进 Markdown 的 `(...)` 里。
   *
   * 地址里含括号或空格时必须用尖括号包起来，否则解析器会在第一个 `)`
   * 处截断 —— 例如维基百科的 `.../wiki/Foo_(bar)`。
   */
  function formatUrl(url) {
    var text = String(url || '');
    if (/[()\s]/.test(text)) return '<' + text.replace(/>/g, '%3E') + '>';
    return text;
  }

  /** 把一段文本变成 blockquote，逐行加 "> " */
  function blockquote(text) {
    if (!text) return '>';
    return String(text).split('\n').map(function (line) {
      return line ? '> ' + line : '>';
    }).join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 分组
   * ------------------------------------------------------------------ */

  /** 按分组键把标注组织成有序的两层结构 */
  function groupAnnotations(annotations, groupBy) {
    if (groupBy === 'none') {
      return [{ key: '', pages: [{ key: '', title: '', url: '', items: annotations }] }];
    }

    var groups = new Map();

    annotations.forEach(function (annotation) {
      var groupKey = groupBy === 'page'
        ? (annotation.urlKey || '')
        : (annotation.siteKey || '(未知)');

      if (!groups.has(groupKey)) groups.set(groupKey, new Map());
      var pages = groups.get(groupKey);

      var pageKey = annotation.urlKey || '';
      if (!pages.has(pageKey)) {
        pages.set(pageKey, {
          key: pageKey,
          title: annotation.title || '',
          url: annotation.url || pageKey,
          items: [],
        });
      }
      pages.get(pageKey).items.push(annotation);
    });

    return Array.from(groups.entries()).map(function (pair) {
      return { key: pair[0], pages: Array.from(pair[1].values()) };
    });
  }

  /* ------------------------------------------------------------------ *
   * 单条
   * ------------------------------------------------------------------ */

  /**
   * 渲染一条标注。
   *
   * 输出形态（备注、标签、颜色、日期都可以按选项省略）：
   *
   *     > 引文原文
   *     > 可能有多行
   *
   *     **备注：** 自己写的话
   *
   *     `标签一` `标签二` · 黄 · 2026-10-15
   */
  function renderAnnotation(annotation, options) {
    var blocks = [];

    // 1) 引文 —— blockquote
    var quoteText = escapeLiteral(annotation.text || '');
    blocks.push(blockquote(quoteText || '（无原文）'));

    // 2) 备注 —— 独立段落，用粗体标签和引文区分开。
    //    不转义：这是用户自己写的，让 Markdown 生效是特性。
    if (options.includeNote && annotation.note) {
      blocks.push('**备注：** ' + annotation.note.trim());
    }

    // 3) 元信息 —— 标签用行内代码（视觉上自然区分），其余用纯文本
    var meta = [];

    if (options.includeTags && annotation.tags && annotation.tags.length) {
      // 标签作为**一个整体**用空格分开（它们是一组），组之间才用 `·` 分隔
      var tagText = annotation.tags.map(function (tag) {
        // 标签以行内代码呈现，所以要把反引号剔除，否则会截断代码段
        return '`' + String(tag).replace(/`/g, '') + '`';
      }).join(' ');
      meta.push(tagText);
    }

    if (options.includeColor && annotation.color) {
      var color = HA.getColor(annotation.color);
      if (color && color.label) meta.push(color.label);
    }

    if (options.includeDate && annotation.createdAt) {
      meta.push(HA.formatDate(annotation.createdAt));
    }

    if (meta.length) blocks.push(meta.join(' · '));

    return blocks.join('\n\n');
  }

  /* ------------------------------------------------------------------ *
   * 主体
   * ------------------------------------------------------------------ */

  /**
   * 逐块生成 Markdown。
   *
   * ⚠️ 生成器里**只能用 `for...of` 循环，不能用 `forEach`** ——
   * `yield` 不能出现在嵌套的普通函数里。
   *
   * @param {Array} annotations
   * @param {Object} [options]
   * @returns {Generator<string>} 每次产出一个文本块
   */
  HA.markdownChunks = function* (annotations, options) {
    options = Object.assign({}, DEFAULT_OPTIONS, options || {});
    var list = annotations || [];

    var siteCount = new Set(list.map(function (a) { return a.siteKey; })).size;

    yield '# ' + escapeLiteral(options.title || '网页标注') + '\n\n';
    yield '> 共 ' + list.length + ' 条标注'
      + (options.groupBy === 'site' && siteCount ? '，来自 ' + siteCount + ' 个网站' : '')
      + '。导出时间 ' + HA.formatDateTime(Date.now()) + '。\n';

    if (!list.length) {
      yield '\n（没有标注）\n';
      return;
    }

    var groups = groupAnnotations(list, options.groupBy);

    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];

      if (options.groupBy !== 'none' && group.key) {
        yield '\n## ' + escapeLiteral(group.key) + '\n';
      }

      for (var p = 0; p < group.pages.length; p++) {
        var page = group.pages[p];

        if (options.groupBy !== 'none') {
          var pageTitle = page.title || page.url || '(无标题)';
          if (page.url) {
            yield '\n### [' + escapeLiteral(pageTitle) + '](' + formatUrl(page.url) + ')\n';
          } else {
            yield '\n### ' + escapeLiteral(pageTitle) + '\n';
          }
        }

        for (var i = 0; i < page.items.length; i++) {
          yield '\n' + renderAnnotation(page.items[i], options) + '\n';
        }
      }
    }
  };

  /** 一次性拼成完整字符串（预览、测试、小数据量场景） */
  HA.toMarkdown = function (annotations, options) {
    var parts = [];
    var iterator = HA.markdownChunks(annotations, options);
    var step = iterator.next();
    while (!step.done) {
      parts.push(step.value);
      step = iterator.next();
    }
    return parts.join('');
  };

  /** 生成建议的文件名 */
  HA.suggestMarkdownFilename = function (annotations, options) {
    options = Object.assign({}, DEFAULT_OPTIONS, options || {});
    var today = HA.formatDate(Date.now());
    var list = annotations || [];

    if (options.groupBy === 'page' && list.length) {
      return (list[0].siteKey || 'page') + '-' + today + '.md';
    }
    if (options.groupBy === 'site' && list.length) {
      var sites = new Set(list.map(function (a) { return a.siteKey; }));
      if (sites.size === 1) return list[0].siteKey + '-' + today + '.md';
    }
    return '网页标注-' + today + '.md';
  };

  HA.MARKDOWN_DEFAULT_OPTIONS = DEFAULT_OPTIONS;

})(globalThis.HA || (globalThis.HA = {}));
