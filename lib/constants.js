'use strict';
/**
 * 全局常量与默认配置。
 *
 * 目录下所有 lib/ 与 content/ 的文件都是「经典脚本」（classic script），
 * 通过挂载到 globalThis.HA 共享代码。原因：MV3 的 content script 在 isolated
 * world 里以 classic script 运行，**不支持 ESM 的 import/export**（加
 * "type":"module" 也无效），见 Chromium issue 40656676。
 *
 * 因此命名空间是唯一的共享机制：
 *   - content script  → 由 manifest 的 content_scripts.js 数组按依赖顺序加载
 *   - service worker  → importScripts()
 *   - 扩展页面        → <script src> 按顺序引入
 */
(function (HA) {

  /** 与 service worker 通信的协议版本。
   *  扩展更新后，已经打开的旧标签页里跑的还是旧版 content script，
   *  靠这个字段发现版本不匹配并重新注入，否则会静默失败。 */
  HA.PROTOCOL_VERSION = 1;

  /** canonical text 的归一化规则版本。
   *  ⚠️ 规则一旦改动，所有历史标注的 TextPositionSelector 偏移全部作废。
   *  每条标注都记录创建时的版本号，否则连「作废了」都不知道。
   *  v1 规则：见 lib/text-index.js */
  HA.CANONICAL_TEXT_VERSION = 1;

  /* ------------------------------------------------------------------ *
   * 锚点算法参数
   * ------------------------------------------------------------------ */

  /** prefix/suffix 的上下文字符数。同类实现的取值多在 24–32 之间。 */
  HA.CONTEXT_LEN = 32;

  /** 「扩张到唯一」时上下文的最大长度上限：
   *  先用基础长度匹配，若匹配到非目标处就成倍向外扩张，直到与目标分岔。 */
  HA.CONTEXT_LEN_MAX = 128;

  /** 打分时若 top1 与 top2 的分差小于此值，判定为「有歧义」并显式告知用户，
   *  而不是猜一个 —— 短 quote 上的误匹配是主要的错误来源。 */
  HA.AMBIGUITY_EPSILON = 0.02;

  /** 短于这个长度的 quote 禁用模糊匹配 —— 一两个词的假阳性率过高。 */
  HA.MIN_FUZZY_QUOTE_LEN = 8;

  /** 模糊匹配允许的最大编辑错误数上限，实际取 min(此值, floor(len/3))。
   *  取 1/3 而非 1/2，更保守，减少误匹配。 */
  HA.MAX_ERRORS_CAP = 64;

  /** 选区短于此长度不触发标注（避免误触）。 */
  HA.MIN_SELECTION_LEN = 2;

  /** 消歧打分权重（归自 Hypothesis 的 match-quote 实现），归一化时除以 SCORE_TOTAL。
   *  quote 权重必须远大于 context，否则「上下文更好但正文更差」的候选会翻盘。 */
  HA.SCORE_WEIGHTS = { quote: 50, prefix: 20, suffix: 20, pos: 2 };
  HA.SCORE_TOTAL = 92;

  /* ------------------------------------------------------------------ *
   * 调色板
   * ------------------------------------------------------------------ */

  /** 每种颜色有浅色/深色两套值。颜色在「注册 Highlight 时」决定，
   *  所以切换明暗主题必须重新注册全部 highlight。
   *  深色用半透明，让页面自身的浅色文字保持可读。 */
  HA.PALETTE = [
    { id: 'yellow', label: '黄', light: '#ffe066', dark: 'rgba(255, 214, 51, .30)' },
    { id: 'green',  label: '绿', light: '#a8e6a3', dark: 'rgba(105, 219, 124, .28)' },
    { id: 'blue',   label: '蓝', light: '#a5d8ff', dark: 'rgba(77, 171, 247, .30)' },
    { id: 'pink',   label: '粉', light: '#ffb3c6', dark: 'rgba(247, 131, 172, .28)' },
    { id: 'purple', label: '紫', light: '#d0bfff', dark: 'rgba(151, 117, 250, .30)' },
    { id: 'orange', label: '橙', light: '#ffc078', dark: 'rgba(255, 146, 43, .28)' },
  ];

  HA.getColor = function (id) {
    return HA.PALETTE.find(function (c) { return c.id === id; }) || HA.PALETTE[0];
  };

  /* ------------------------------------------------------------------ *
   * 默认设置（存在 chrome.storage.local）
   * ------------------------------------------------------------------ */

  /** 触发模式：
   *  - 'instant'  按住修饰键 + 选中 → 立即用默认颜色高亮（默认，无中间步骤）
   *  - 'toolbar'  按住修饰键 + 选中 → 弹小工具条，确认后落库
   *  - 'off'      不自动触发，只能用右键菜单 / 工具栏图标 */
  HA.DEFAULT_SETTINGS = {
    triggerMode: 'instant',

    /** 修饰键：'auto' = Mac 用 Cmd、Windows/Linux 用 Ctrl；也可强制 'ctrl' / 'meta' / 'alt' / 'none'。
     *  ⚠️ 不要硬编码 Ctrl：macOS 上 Ctrl 与系统右键手势冲突，Cmd 才是习惯用法。 */
    modifier: 'auto',

    defaultColor: 'yellow',

    /** 模糊匹配 / 重锚定失败时，是否仍把标注显示在侧边栏（状态为「未定位」）。
     *  默认开着 —— 论文统计约 22% 的网页标注最终会无法附着，
     *  藏起来等于让用户以为自己的数据丢了。 */
    showOrphans: true,

    /** 除背景色外再叠加下划线 —— 纯背景色对色盲用户无效。 */
    underline: false,

    /** 界面语言：'auto' 跟随浏览器，或强制 'zh' / 'en'。
     *  只影响扩展自身的界面，不影响网页与浏览器。 */
    language: 'auto',

    /** 新标注默认归档到的目录；null 表示不自动归档。
     *  全局设置（侧边栏的「默认目录」），不是按网站设置。 */
    defaultFolderId: null,
  };

  /* ------------------------------------------------------------------ *
   * 消息类型
   * ------------------------------------------------------------------ */

  HA.MSG = {
    PING: 'ping',

    /** content script → SW：一次性批量拉取本页全部标注（避免每条一次往返） */
    GET_FOR_URL: 'getForUrl',
    CREATE: 'create',
    UPDATE: 'update',
    DELETE: 'delete',
    /** SW → content script：标注发生变化，增量通知 */
    CHANGED: 'changed',
    /** SW → content script：SPA 路由变了（webNavigation.onHistoryStateUpdated） */
    ROUTE_CHANGED: 'routeChanged',
    /** SW → content script：工具栏图标/右键菜单要求高亮当前选区 */
    HIGHLIGHT_SELECTION: 'highlightSelection',

    /** 侧边栏 → content script：取锚定状态（孤儿/模糊/歧义）与文档内位置。
     *  这些信息只存在于页面里 —— 数据库里存的是选择器，不是「能不能定位」。 */
    GET_STATUS: 'getStatus',
    /** 侧边栏 → content script：把某条标注滚进视口并闪烁 */
    SCROLL_TO: 'scrollTo',
    /** 侧边栏 → content script：清空失败计数，重试全部未定位的标注 */
    REANCHOR: 'reanchor',
    /** content script → SW：报告本页实际使用的 urlKey。
     *  页面可能声明了 <link rel=canonical>，此时它和地址栏 URL 不是一回事，
     *  SW 没有 DOM 算不出来，只能由页面自己报上来。 */
    REPORT_PAGE: 'reportPage',
    /** 扩展页面 → SW：请求向所有标签页广播一次变更。
     *  扩展页面直连 IndexedDB，绕过了 Repo，所以改完要主动喊一声。 */
    BROADCAST: 'broadcast',

    /** 管理页 / 设置页 直接读写 IndexedDB，不经 SW */
    QUERY: 'query',
    GET_STATS: 'getStats',
    CLEAR_ALL: 'clearAll',
  };

  /* ------------------------------------------------------------------ *
   * IndexedDB
   * ------------------------------------------------------------------ */

  HA.DB_NAME = 'ha-annotations';
  /** v2：移除图片标注。v3：新增网站目录（folders / siteFolders）。 */
  HA.DB_VERSION = 3;
  /** 标注主表。索引：urlKey / siteKey / createdAt / color / tags(multiEntry) */
  HA.STORE_ANNOTATIONS = 'annotations';
  /** 单条键值表，存 schemaVersion、迁移进度、数据库上次备份时间等 */
  HA.STORE_META = 'meta';
  /** 网站目录：{ id, name, createdAt } */
  HA.STORE_FOLDERS = 'folders';
  /** 网站归属：{ siteKey, folderId }。没有记录的网站直接位于「全部网站」顶层。 */
  HA.STORE_SITE_FOLDERS = 'siteFolders';

  /* ------------------------------------------------------------------ *
   * 页面内 UI（工具条 / 编辑浮层 / 提示）
   * ------------------------------------------------------------------ */

  /** 我们注入的 UI 宿主元素的 id。装在 Shadow DOM 里以避免被页面 CSS 污染，
   *  selection.js 靠这个 id 判断选区是不是落在我们自己的 UI 上。 */
  HA.UI_ROOT_ID = 'ha-ui-root';

  /* ------------------------------------------------------------------ *
   * 标注状态
   * ------------------------------------------------------------------ */

  /** 锚定结果状态。参考 W3C 2014 "Robust Anchoring" 幻灯片的
   *  anchored / half-orphan / orphan 三态，并细化了成功路径的置信度。 */
  HA.STATUS = {
    EXACT: 'exact',                 // 精确命中（RangeSelector / TextPositionSelector / 唯一的 indexOf）
    DISAMBIGUATED: 'disambiguated', // 多候选，靠上下文打分选出了明确最优
    AMBIGUOUS: 'ambiguous',         // 多候选且分差极小，显示给用户但不保证正确
    FUZZY: 'fuzzy',                 // 模糊匹配命中，原文有轻微改动
    PENDING: 'pending',             // 内容还没加载出来，等待重试
    ORPHAN: 'orphan',               // 彻底找不到，保留数据 + 展示原文 + 允许手动重定位
  };

})(globalThis.HA || (globalThis.HA = {}));
