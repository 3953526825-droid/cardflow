'use strict';
/* 学科包（subject pack）的 schema 与校验规则：Node（src/packs.js 的导入/保存）与安卓壳离线页
   （手机上新装学科包）共用同一份，改规则不会只改到一边。函数体从 src/packs.js 逐字搬来。 */
(function (root) {
const REQUIRED_SECTIONS = ['generate', 'reference', 'identify', 'locate'];
const CURRENT_SCHEMA = 1;
const MIGRATIONS = {};
const object = x => x && typeof x === 'object' && !Array.isArray(x);
function migrate(x) {
  let pack = object(x) ? { ...x } : x;
  let version = Number(pack && pack.schemaVersion);
  if (!Number.isInteger(version) || version < 1) throw Error('学科包缺少有效的 schemaVersion。');
  if (version > CURRENT_SCHEMA) throw Error(`学科包版本过新（${version}）：这份 CardFlow 只支持到 ${CURRENT_SCHEMA}，请先升级程序。`);
  while (version < CURRENT_SCHEMA) {
    const step = MIGRATIONS[version];
    if (!step) throw Error(`学科包版本 ${version} 没有可用的升级路径。`);
    pack = step(pack);
    const next = Number(pack && pack.schemaVersion);
    if (!Number.isInteger(next) || next <= version) throw Error(`学科包版本 ${version} 的升级没有推进版本号。`);
    version = next;
  }
  return pack;
}

function validate(raw) {
  const x = migrate(raw);
  if (x.schemaVersion !== CURRENT_SCHEMA) throw Error('学科包版本不支持：需要 schemaVersion: ' + CURRENT_SCHEMA + '。');
  const allowed = ['schemaVersion','id','exam','subject','name','description','cardCount','search','prompts','chemFormulas'];
  if (Object.keys(x).some(k => !allowed.includes(k))) throw Error('学科包包含不允许的字段（端口、密钥、文件路径和执行代码不可导入）。');
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(x.id || '')) throw Error('学科包 id 需为 2–32 位小写英文字母、数字或连字符，且以字母开头。');
  if (x.chemFormulas !== undefined && typeof x.chemFormulas !== 'boolean') throw Error('chemFormulas 只能是 true / false（是否把公式转成 Anki 的 \\ce 规范写法）。');
  for (const k of ['exam','subject','name']) if (typeof x[k] !== 'string' || !x[k].trim() || x[k].length > 80 || /[<>]/.test(x[k])) throw Error(k + ' 必须是 1–80 字的纯文本。');
  if (x.description !== undefined && (typeof x.description !== 'string' || x.description.length > 300 || /[<>]/.test(x.description))) throw Error('description 必须是不超过 300 字的纯文本。');
  if (!object(x.cardCount) || !Number.isInteger(x.cardCount.min) || !Number.isInteger(x.cardCount.max) || x.cardCount.min < 1 || x.cardCount.max > 100 || x.cardCount.min > x.cardCount.max || Object.keys(x.cardCount).some(k => !['min','max'].includes(k))) throw Error('cardCount 需要有效的 min/max（1–100）。');
  if (!object(x.search) || Object.keys(x.search).some(k => !['subjectPrefix','catalogSuffix','preferredDomains'].includes(k))) throw Error('search 字段无效。');
  for (const k of ['subjectPrefix','catalogSuffix']) if (typeof x.search[k] !== 'string' || !x.search[k].trim() || x.search[k].length > 120 || /[<>]/.test(x.search[k])) throw Error('search.' + k + ' 必须是简短纯文本。');
  if (!Array.isArray(x.search.preferredDomains) || x.search.preferredDomains.length > 20 || x.search.preferredDomains.some(d => typeof d !== 'string' || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(d))) throw Error('preferredDomains 最多 20 个有效域名。');
  if (!object(x.prompts) || Object.keys(x.prompts).some(k => !REQUIRED_SECTIONS.includes(k))) throw Error('prompts 只能包含 generate/reference/identify/locate 四段。');
  for (const k of REQUIRED_SECTIONS) if (typeof x.prompts[k] !== 'string' || x.prompts[k].trim().length < 20 || x.prompts[k].length > 30000) throw Error('prompts.' + k + ' 需为 20–30000 字。');
  return x;
}

function materialize(x, base) {
  // Only the whitelisted public values can influence runtime. Secrets/paths come from the trusted base config.
  // chemFormulas 打开时：学科包这一页也做「公式规范化」（postprocess 'formula' + 预览前先 normalize）。
  return {...base,id:x.id,name:x.name,shortName:x.name,httpPort:base.httpPort,httpsPort:base.httpsPort,
    storageKey:'cardflow.pack.'+x.id,tokenKey:base.tokenKey,assetVersion:'pack1',
    config:base.config,prompts:x.prompts,postprocess:x.chemFormulas?'formula':null,previewNormalizes:Boolean(x.chemFormulas),
    cardCount:{...base.cardCount,min:x.cardCount.min,max:x.cardCount.max,hint:PACK_COUNT_HINT},copy:packCopy(base,x),
    search:x.search,exam:x.exam,subject:x.subject,pack:x};
}

/**
 * 学科包页面的文案：基础学科（生物/化学）的副本里写死了自己的例子（「新牌组名称，如 细胞」
 * 「重点生成组织液、血浆、淋巴液…」），学科包直接沿用的话语文包也会显示生物的例子，
 * 所以这几处按包自己的考试/科目重新生成。
 */
function packCopy(base, x) {
  // 不在页面上的输入框里预设任何学科内容（真机反馈）：占位符只说“这里填什么”，
  // 不带例子、不带别的学科的词，也不带本学科的例句。
  return {
    ...base.copy,
    title: x.name,
    subtitle: x.description || (x.exam + ' · ' + x.subject),
    searchPlaceholder: '检索词（考点、难点、易错点都可以）',
    newDeckPlaceholder: '新牌组名称',
    extraRulesPlaceholder: '本次额外的生成要求（可选）'
  };
}
const PACK_COUNT_HINT = '左为最少、右为最多；总张数不会超过上限。';

/**
 * 基础页的 CSS 里写死了「资料框副标题」——[data-subject="<内置学科>"] .drop:after{content:"…"}
 * （化学是「⌬  原理 · 推理 · 方程式」）。学科包页面沿用基础学科的 data-subject（为了继承整套配色），
 * 这行文案就会跟着串到语文包上。不去动基础页样式表（那是 CSS 基线的比对对象），改用一条 !important 覆盖。
 * 基础页那条没有 !important，所以这里的优先级一定更高。
 */
function packCaptionStyle() {
  // 真机反馈：资料框里不要预设有学科味的文案 —— 学科包页面直接把这行去掉。
  // 基础学科页（生物/化学）的那句是学科配置的一部分，走另一条路，不受影响。
  return '<style>.drop:after{content:none !important;}</style>';
}

/** 把覆盖样式插到 </head> 前：打包时与手机上运行时走的是同一个函数，两边才能逐字一致。 */
function injectPackCaption(html, subject) {
  const head = html.indexOf('</head>');
  if (head < 0) throw new Error('学科包页面拼装失败：找不到 </head>');
  return html.slice(0, head) + packCaptionStyle(subject) + html.slice(head);
}

/** 离线页的 MathJax 片段（tex-svg + mhchem，走包内副本，不连远程）。
 *  勾了「化学式转换」的学科包，运行时拼出来的页面也要有它，才能在预览里正常渲染 \(\ce{...}\)；
 *  与打包时（build-shell 的 patchForOffline）产出的那一行逐字一致。 */
const OFFLINE_MATHJAX = "<script>window.MathJax={paths:{'[tex]':'/vendor/mathjax/input/tex'},loader:{load:['[tex]/mhchem']},tex:{packages:{'[+]':['mhchem']},inlineMath:[['\\\\(','\\\\)']]},svg:{fontCache:'global'}};</script><script async src=\"/vendor/mathjax/tex-svg.js\"></script>";

/**
 * 学科包页面：把「基础学科页」（打包时渲染好的生物页）改成这个包的页面。
 * 两者只差这几处：标题、学科名、副标题、学科下拉、卡片数量上下限、检索词占位符、内联 __SUBJECT__、app.js 的版本号。
 * 少一处就抛错，这样模板或者学科包字段变了会立刻暴露，而不是悄悄拼出一个怪页面。
 */
function packPageFromBase(baseHtml, baseSubject, pack, subjects) {
  const subject = materialize(pack, baseSubject);
  let out = baseHtml;
  const name = subject.name;
  const must = (from, to, label) => {
    if (!out.includes(from)) throw new Error(`学科包页面拼装失败：找不到${label}`);
    out = out.replace(from, to);
  };
  must(`<title>CardFlow · ${baseSubject.name}</title>`, `<title>CardFlow · ${name}</title>`, '标题');
  must(`<strong>${baseSubject.name}</strong>`, `<strong>${name}</strong>`, '学科名');
  must(`<span>${baseSubject.copy.subtitle}</span>`, `<span>${subject.copy.subtitle}</span>`, '副标题');
  must(`id="minCards" type="number" min="1" max="100" value="${baseSubject.cardCount.min}"`, `id="minCards" type="number" min="1" max="100" value="${subject.cardCount.min}"`, '最少卡片数');
  must(`id="maxCards" type="number" min="1" max="100" value="${baseSubject.cardCount.max}"`, `id="maxCards" type="number" min="1" max="100" value="${subject.cardCount.max}"`, '最多卡片数');
  must(`<input id="searchQuery" placeholder="${baseSubject.copy.searchPlaceholder}">`, `<input id="searchQuery" placeholder="${subject.copy.searchPlaceholder}">`, '检索词占位符');
  must(`<script src="/app.js?v=${baseSubject.assetVersion}">`, `<script src="/app.js?v=${subject.assetVersion}">`, 'app.js 版本号');
  // 这两处也是基础学科写死的文案（新牌组名示例「如 细胞」、额外规则示例「组织液、血浆、淋巴液」）
  must(`placeholder="${baseSubject.copy.newDeckPlaceholder}"`, `placeholder="${subject.copy.newDeckPlaceholder}"`, '新牌组名示例');
  must(`placeholder="${baseSubject.copy.extraRulesPlaceholder}"`, `placeholder="${subject.copy.extraRulesPlaceholder}"`, '额外规则示例');
  must(`<div class="muted">${baseSubject.cardCount.hint}</div>`, `<div class="muted">${subject.cardCount.hint}</div>`, '卡片数量提示');

  // 学科下拉：按当前已知学科重建（手机上刚导入的包也要出现在这里）。
  // item.href 用于「静态页不存在的本机导入包」：这类选项的值是 pack:<id>，由卡片页脚本调 openPack 打开。
  const optionHref = item => item.href || `index-${item.id}.html`;
  const options = (subjects || []).map(item => `<option value="${optionHref(item)}"${item.id === subject.id ? ' selected' : ''}>${item.name}</option>`).join('');
  const selectStart = out.indexOf('<select id="subjectSwitch">');
  if (selectStart < 0) throw new Error('学科包页面拼装失败：找不到学科下拉');
  const selectEnd = out.indexOf('</select>', selectStart);
  if (selectEnd < 0) throw new Error('学科包页面拼装失败：学科下拉没有正常结束');
  out = out.slice(0, selectStart) + '<select id="subjectSwitch">' + options + out.slice(selectEnd);

  // 内联学科配置（字段与服务器 computedValues 生成的完全一致）
  const script = {
    id: subject.id,
    pack: Boolean(subject.pack),
    base: '',
    assetVersion: subject.assetVersion,
    storageKey: subject.storageKey,
    tokenKey: subject.tokenKey,
    cardModeControl: subject.cardMode.controlId,
    cardModeField: subject.cardMode.field,
    defaultDeck: subject.anki.defaultDeck || '',
    previewNormalizes: Boolean(subject.previewNormalizes),
    subjectSwitch: (subjects || []).map(item => ({ id: item.id, name: item.name, href: item.href || `index-${item.id}.html` }))
  };
  const inline = 'window.__SUBJECT__ = ' + JSON.stringify(script).replace(/</g, '\\u003c') + ';';
  if (!/window\.__SUBJECT__ = \{[^<]*?\};/.test(out)) throw new Error('学科包页面拼装失败：找不到内联的学科配置');
  out = out.replace(/window\.__SUBJECT__ = \{[^<]*?\};/, inline);

  // 勾了「化学式转换」的包：基础页（生物）没有 MathJax，这里补上与打包时一致的那段（插在 theme.js 与 vendor/pdf.min.js 之间）。
  if (subject.previewNormalizes && !out.includes('window.MathJax=')) {
    const anchor = '<script src="/vendor/pdf.min.js"></script>';
    if (out.includes(anchor)) out = out.replace(anchor, OFFLINE_MATHJAX + anchor);
    else {
      const head = out.indexOf('</head>');
      if (head < 0) throw new Error('学科包页面拼装失败：找不到 </head>，无法补 MathJax');
      out = out.slice(0, head) + OFFLINE_MATHJAX + out.slice(head);
    }
  }
  return injectPackCaption(out, subject);
}

const api = { REQUIRED_SECTIONS, CURRENT_SCHEMA, MIGRATIONS, migrate, validate, materialize, packCopy, packCaptionStyle, injectPackCaption, packPageFromBase };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
// 浏览器侧单独挂在 CardFlowPacks 上：这里的 validate 是「学科包」的校验，
// 不能盖掉 CardFlowShared.validate（那是卡片格式校验，卡片页在用）。
else root.CardFlowPacks = Object.assign(root.CardFlowPacks || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
