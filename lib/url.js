'use strict';
/**
 * URL 规范化。
 *
 * 目的：同一篇文章常有多个 URL（带追踪参数、带锚点、带分页参数），
 * 必须归一到同一个 key，否则标注会分散在多个页面下。
 *
 * 追踪参数按常见清单剔除，覆盖主流平台的点击 ID 与营销参数。
 */
(function (HA) {

  /** 一次性/tracking 参数，规范化时删除。 */
  var EPHEMERAL_PARAMS = new Set([
    // 时间戳类
    't', 'start', 'time_continue',
    // 广告/营销追踪
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_name', 'utm_reader', 'utm_referrer', 'utm_social', 'utm_social-type',
    // 平台来源标记
    'ref', 'ref_', 'source', 'src', 'referer', 'referrer',
    // 各平台的点击 ID
    'fbclid', 'gclid', 'dclid', 'msclkid', 'twclid', 'yclid', 'igshid',
    'mc_cid', 'mc_eid', '_ga', '_gl', 'si', 'spm', 'scm',
    // 分享/会话
    'share', 'shared', 'sharer', 'shared_from', 'from',
    'sp', 'socialshare', 'share_source', 'share_medium',
  ]);

  /** 从 www 前缀和无意义子域中提取站点标识，用于「按网站分组」。
   *  bilibili.com / www.bilibili.com / m.bilibili.com → bilibili.com */
  var STRIP_SUBDOMAINS = new Set([
    'www', 'm', 'mobile', 'amp', 'web', 'wap',
  ]);

  /** 二级后缀标签。用来区分 `en.wikipedia.org`（可剥）与 `example.co.uk`（不可剥）——
   *  两者都是 3 段、都以 2 位字母开头，只有靠这个名单才能分辨。
   *  完整的判断需要公共后缀列表（PSL），这里用一个够用的小名单。 */
  var SECOND_LEVEL = new Set([
    'co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'mil', 'sch', 'asn',
    'or', 'ne', 'go', 'in', 'id', 'gen', 'firm', 'store', 'web', 'arts',
  ]);

  /** 形如 en / zh / en-gb / zh-hans 的语言子域 */
  var LANG_SUBDOMAIN = /^[a-z]{2}(-[a-z]{2,4})?$/;

  /**
   * 规范化 URL。
   * 删除 hash（同一页面的锚点跳转视为同一文档）、删除追踪参数、参数排序。
   *
   * @param {string} url
   * @returns {string} 规范化后的 URL；输入不是合法 URL 时原样返回
   */
  HA.normalizeUrl = function (url) {
    if (typeof url !== 'string' || !url) return '';

    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      // data: / about: / blob: / javascript: 等无法解析或不该解析的
      return url;
    }

    // 非 http(s) 协议不做参数处理，原样返回（去掉 hash 即可）
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      parsed.hash = '';
      return parsed.href;
    }

    parsed.hash = '';

    // 删除追踪参数；同时删掉空值参数（?a= 这种）
    var kept = [];
    parsed.searchParams.forEach(function (value, key) {
      var lower = key.toLowerCase();
      if (EPHEMERAL_PARAMS.has(lower)) return;
      if (value === '') return;
      kept.push([key, value]);
    });

    // 排序，让 ?a=1&b=2 与 ?b=2&a=1 归一为同一个 key
    kept.sort(function (x, y) {
      return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0;
    });

    var search = new URLSearchParams();
    kept.forEach(function (pair) { search.append(pair[0], pair[1]); });
    parsed.search = search.toString();

    return parsed.href;
  };

  /**
   * 站点标识，用于管理页「按网站分组」。
   * @param {string} url
   * @returns {string} 形如 example.com 的 hostname；解析失败返回空串
   */
  HA.siteKey = function (url) {
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return '';
    }

    var host = parsed.hostname.toLowerCase();
    if (!host) return '';

    // IP 地址不做子域剥离
    if (/^[\d.]+$/.test(host) || host.indexOf(':') !== -1) return host;

    var parts = host.split('.');
    // 至少保留两段（example.com）
    while (parts.length > 2) {
      var head = parts[0];

      if (STRIP_SUBDOMAINS.has(head)) {
        parts.shift();
        continue;
      }

      // 语言子域。判断依据是「剥掉之后会不会只剩一个二级后缀 + 顶级域」——
      // 那种情况说明 head 本身就是注册域的一部分（en.co.uk 里的 en）。
      //
      // ⚠️ 不能用 `parts[parts.length - 2]` 来判断：对 zh.example.co.uk 这种
      // 「语言子域 + 四段主机」，倒数第二段恒为 co，守卫会永远命中、语言子域
      // 永远剥不掉，于是同一个站被拆成 zh.example.co.uk 和 example.co.uk 两行。
      if (LANG_SUBDOMAIN.test(head)) {
        var remaining = parts.length - 1;
        var wouldBeBareSecondLevel = remaining === 2 && SECOND_LEVEL.has(parts[1]);
        if (!wouldBeBareSecondLevel) {
          parts.shift();
          continue;
        }
      }

      break;
    }

    return parts.join('.');
  };

  /**
   * 采集页面上声明的规范 URL（<link rel="canonical"> 或 og:url）。
   * 作为 urlKey 的 fallback：同一篇文章在多个 URL 下时，优先用站点自己声明的规范地址。
   *
   * @param {Document} doc
   * @returns {string|null}
   */
  HA.canonicalUrlFromDocument = function (doc) {
    doc = doc || document;

    var link = doc.querySelector('link[rel="canonical"][href]');
    if (link) {
      var href = link.getAttribute('href');
      if (href) {
        try {
          return new URL(href, doc.baseURI).href;
        } catch (e) { /* 忽略非法 href */ }
      }
    }

    var og = doc.querySelector('meta[property="og:url"][content]');
    if (og) {
      var content = og.getAttribute('content');
      if (content) {
        try {
          return new URL(content, doc.baseURI).href;
        } catch (e) { /* 忽略 */ }
      }
    }

    return null;
  };

  /**
   * 计算一条标注应归属的存储键。
   *
   * 注意：这里**不做哈希**。IndexedDB 的索引键可以直接用完整 URL 字符串，
   * 没有 chrome.storage 那种键长限制（网上很多教程之所以哈希 URL，
   * 是因为它们用的是 chrome.storage，键名有 8KB 限制）。
   *
   * @param {string} url 当前文档 URL
   * @param {Document} [doc] 用于采集 canonical
   * @returns {{urlKey: string, siteKey: string, canonical: string|null}}
   */
  HA.makeUrlKeys = function (url, doc) {
    var canonical = doc ? HA.canonicalUrlFromDocument(doc) : null;
    var urlKey = HA.normalizeUrl(canonical || url);
    return {
      urlKey: urlKey,
      siteKey: HA.siteKey(urlKey) || HA.siteKey(url),
      canonical: canonical,
    };
  };

})(globalThis.HA || (globalThis.HA = {}));
