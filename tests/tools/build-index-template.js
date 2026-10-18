'use strict';
/*
 * 生成 public/index.html 模板，并顺手证明「模板与原参考文件逐字一致、只差列出的那几处」。
 *
 * 输入（只读）：
 *   Bio2Anki/public/index.html     —— 模板正文的基准（除占位符外逐字保留）
 *   Chem2Anki/public/index.html    —— 用来证明「把 bio 的差异点逐条替换后与 chem 逐字相同」
 * 输出：
 *   public/index.html              —— 双学科共用模板（{{占位符}} 由 src/server.js 渲染）
 *
 * 用法：node tests/tools/build-index-template.js
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const REFERENCE = {
  bio: 'C:/Users/Administrator/Bio2Anki/public/index.html',
  chem: 'C:/Users/Administrator/Chem2Anki/public/index.html'
};

/* ---------- ① 头部（<style> 之前）逐条差异 ---------- */
/** 参考文件头部的差异项：bio 原文 -> chem 原文 -> 模板占位符。 */
const HEAD_PAIRS = [
  ['<html lang="zh-CN">', '<html lang="zh-CN">', '<html lang="zh-CN" data-subject="{{subject.id}}">'],
  ['<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '{{#subject.viewportFit}}<meta name="viewport" content="width=device-width,initial-scale=1 {{subject.viewportFit}}">{{/subject.viewportFit}}'],
  ['<title>Bio2Anki</title>', '<title>Chem2Anki</title>', '<title>{{copy.title}}</title>'],
  ['<meta name="theme-color" content="#2269d1">', '<meta name="theme-color" content="#117c9c">', '<meta name="theme-color" content="{{subject.themeColor}}">'],
  ['<meta name="apple-mobile-web-app-title" content="Bio2Anki">', '<meta name="apple-mobile-web-app-title" content="Chem2Anki">', '<meta name="apple-mobile-web-app-title" content="{{subject.shortName}}">'],
  ['<link rel="manifest" href="/manifest.json">', '<link rel="manifest" href="/manifest.json">', '<link rel="manifest" href="{{subject.base}}manifest.json">'],
  ['<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="apple-touch-icon" href="{{subject.base}}apple-touch-icon.png">'],
  ['<link rel="icon" href="/icon-192.png">', '<link rel="icon" href="/icon-192.png">', '<link rel="icon" href="{{subject.base}}icon-192.png">']
];

/* ---------- ② 正文（<body> 里）逐条差异 ---------- */
/** 参考文件正文的差异项：bio 原文 -> chem 原文 -> 模板片段。 */
/** MathJax/mhchem：chem 独有（bio 没有）。预览里的化学式/方程式靠它渲染，不是可选项。 */
const MATHJAX_HTML = '<script>window.MathJax={loader:{load:[\'[tex]/mhchem\']},tex:{packages:{\'[+]\':[\'mhchem\']},inlineMath:[[\'\\\\(\',\'\\\\)\']]},svg:{fontCache:\'global\'}};</script><script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>';
const MATHJAX_BLOCK = `{{#subject.previewNormalizes}}${MATHJAX_HTML}{{/subject.previewNormalizes}}`;

const BODY_PAIRS = [
  ['<body>', '<body>', `<body data-subject="{{subject.id}}">`],
  ['<h1>Bio2Anki</h1>', '<h1>Chem2Anki</h1>', '<h1>{{copy.title}}</h1>'],
  ['<div class="sub">生物资料制卡 · 完整覆盖优先 · 关系与过程优先填空</div>',
    '<div class="sub">化学原理制卡 · 理解、推理与表达式规范优先</div>',
    '<div class="sub">{{copy.subtitle}}</div>'],
  ['<input id="newDeckName" placeholder="新牌组名称，如 细胞">',
    '<input id="newDeckName" placeholder="新牌组名称，如 电化学">',
    '<input id="newDeckName" placeholder="{{copy.newDeckPlaceholder}}">'],
  ['<label>卡片总数</label>', '<label>卡片数量</label>', '<label>{{cardCount.label}}</label>'],
  ['<input id="minCards" type="number" min="1" max="100" value="25" aria-label="最少卡片数"><input id="maxCards" type="number" min="1" max="100" value="35" aria-label="最多卡片数">',
    '<input id="minCards" type="number" min="1" max="100" value="18"><input id="maxCards" type="number" min="1" max="100" value="28">',
    '<input id="minCards" type="number" min="1" max="100" value="{{cardCount.min}}"{{cardCount.minAriaHtml}}><input id="maxCards" type="number" min="1" max="100" value="{{cardCount.max}}"{{cardCount.maxAriaHtml}}>'],
  ['<div class="muted">左为最少、右为最多。内容较多时优先完整覆盖，可超过上限。</div>',
    '<div class="muted">左为最少、右为最多；原理复杂时允许超过上限。</div>',
    '<div class="muted">{{cardCount.hint}}</div>'],
  ['<label>填空卡优先级</label>', '<label>理解深度</label>', '<label>{{cardMode.label}}</label>'],
  ['<select id="clozeWeight"><option value="high" selected>高：优先用填空卡理解关系与过程</option><option value="very-high">很高：除纯记忆外尽量用填空卡</option><option value="balanced">均衡：普通卡与填空卡按内容选择</option></select><div class="muted">定义、名词、精确数值仍使用普通卡；过程、因果、条件和关系优先填空卡。</div>',
    '<select id="depth"><option value="understanding" selected>理解优先：原理、推理链、条件与辨析</option><option value="deep">深入：增加计算逻辑、实验误差与易错推断</option><option value="balanced">均衡：理解与必要记忆并重</option></select>',
    '<select id="{{cardMode.controlId}}">{{cardMode.optionsHtml}}</select>{{#cardMode.hint}}<div class="muted">{{cardMode.hint}}</div>{{/cardMode.hint}}'],
  ['placeholder="例如：重点生成组织液、血浆、淋巴液的比较卡；多增加图示关系的填空卡；暂不生成实验相关内容。"',
    'placeholder="例如：重点比较反应热、焓变、燃烧热；增加实验误差判断；多做由图像推断结论的卡片。"',
    'placeholder="{{copy.extraRulesPlaceholder}}"'],
  ['<div class="muted">可临时补充生成方向；自动保存，下次可继续修改或清空。</div>',
    '<div class="muted">可临时添加任意方向；会自动保存，下次可继续修改或清空。</div>',
    '<div class="muted">{{copy.extraRulesHint}}</div>'],
  // 学科切换器：新功能，插在「配置与导入牌组」面板左栏末尾（删除当前牌组按钮之后）
  ['<button id="deleteDeck" class="danger" disabled>删除当前牌组</button>',
    '<button id="deleteDeck" class="danger" disabled>删除当前牌组</button>',
    '<button id="deleteDeck" class="danger" disabled>删除当前牌组</button><label>学科</label><select id="subjectSwitch">{{navHtml}}</select>'],
  ['</div></div></div><button id="checkAnki"',
    '</div></div></div><details class="formulaHelp"><summary>化学表达式与导入格式说明</summary><div>化学式/方程式使用 <code>\\(\\ce{...}\\)</code>，数学与热化学公式使用 <code>\\(...\\)</code>。预览排版正常后再导入。</div></details><button id="checkAnki"',
    '</div></div></div>{{#copy.formatHelp}}<details class="formulaHelp">{{copy.formatHelp}}</details>{{/copy.formatHelp}}<button id="checkAnki"'],
  ['<button id="generate">生成 Anki 卡片</button>', '<button id="generate">生成化学 Anki 卡片</button>', '<button id="generate">{{copy.generateLabel}}</button>'],
  ['<input id="searchQuery" placeholder="检索词，如 细胞膜 流动镶嵌模型 高考 高频考点 易错点">',
    '<input id="searchQuery" placeholder="检索词，如 原电池 电极反应式 高考 高频考点 易错点">',
    '<input id="searchQuery" placeholder="{{copy.searchPlaceholder}}">'],
  ['<summary>检查、修改与导入</summary>', '<summary>卡片预览与导入</summary>', '<summary>{{copy.resultSummary}}</summary>'],
  ['<button id="preview" class="secondary">预览卡片</button>', '<button id="preview" class="secondary">预览（检查公式渲染）</button>', '<button id="preview" class="secondary">{{copy.previewLabel}}</button>'],
  ['<script src="/app.js?v=stable2"></script>', '<script src="/app.js?v=chem2"></script>', '{{subjectScript}}<script src="{{subject.base}}app.js?v={{subject.assetVersion}}"></script>']
];

/** 把参考文件切成 head（含 <style> 开标签与 </style> 收标签）与 tail（</style> 之后到文件末尾）。 */
function split(html) {
  const styleStart = html.indexOf('<style>');
  const styleEnd = html.indexOf('</style>') + '</style>'.length;
  return { head: html.slice(0, styleStart) + '<style>', styles: html.slice(styleStart, styleEnd), tail: html.slice(styleEnd) };
}

/** 逐条替换；每条都必须恰好命中一次。
 *  `<body>` 这类没有属性的开标签锚点用 `<body(?=[>\s])` 限定在标签名之后（不会命中 `</body>`）。 */
function applyPairs(text, pairs, label) {
  let out = text;
  for (const [from, to, replacement] of pairs) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `<body>` 用带捕获组的 `<body(>)`：不会命中 `</body>`；替换文本结尾自带 `>`，刚好接上捕获到的 `>`
    const bodyAnchor = from === '<body>';
    const pattern = new RegExp(bodyAnchor ? '<body(>)' : escaped, 'g');
    const count = (out.match(pattern) || []).length;
    if (count !== 1) throw new Error(`${label}：这条差异在基准文本里命中 ${count} 次（应为 1 次）：${JSON.stringify(from.slice(0, 60))}`);
    out = out.replace(pattern, () => replacement);
  }
  return out;
}

/** 反向校验：把模板的替换片段还原成 chem 的写法，结果必须与 chem 参考逐字相同。 */
function assertChemRoundTrip(bioTail, chemTail) {
  let out = bioTail;
  for (const [, to, replacement] of BODY_PAIRS) out = out.split(replacement).join(to);
  out = out.split(MATHJAX_BLOCK).join(MATHJAX_HTML);
  // 参考文件末尾的换行差异（bio 多一个 \n）不算内容差异
  out = out.replace(/\n$/, '');
  const want = chemTail.replace(/\n$/, '');
  if (out !== want) {
    let i = 0;
    while (i < out.length && i < chemTail.length && out[i] === chemTail[i]) i++;
    throw new Error(`正文反向校验失败：第 ${i} 个字符起不同\nbio 侧: ${JSON.stringify(out.slice(Math.max(0, i - 80), i + 160))}\nchem侧: ${JSON.stringify(chemTail.slice(Math.max(0, i - 80), i + 160))}`);
  }
  return true;
}

function main() {
  const bio = fs.readFileSync(REFERENCE.bio, 'utf8');
  const chem = fs.readFileSync(REFERENCE.chem, 'utf8');
  const bioParts = split(bio);
  const chemParts = split(chem);

  // 头部逐条校验
  for (const [from, to] of HEAD_PAIRS) {
    if (bioParts.head.split(from).length - 1 !== 1) throw new Error(`头部基准里找不到：${from}`);
    if (chemParts.head.split(to).length - 1 !== 1) throw new Error(`chem 头部基准里找不到：${to}`);
  }
  // 正文逐条校验（跳过「学科切换器」这条新功能：它两边都相同）
  for (const [from, to] of BODY_PAIRS) {
    if (from === '<button id="deleteDeck" class="danger" disabled>删除当前牌组</button>') continue;
    if (bioParts.tail.split(from).length - 1 !== 1) throw new Error(`正文基准里找不到：${from}`);
    if (from !== to && chemParts.tail.split(to).length - 1 !== 1) throw new Error(`chem 正文基准里找不到：${to}`);
  }
  // chem 独有的 MathJax 片段：chem 正文里恰好一次，bio 里一次都不出现
  if (bioParts.tail.split(MATHJAX_HTML).length - 1 !== 0) throw new Error('bio 正文里不应出现 MathJax 片段');
  if (chemParts.tail.split(MATHJAX_HTML).length - 1 !== 1) throw new Error('chem 正文里的 MathJax 片段不止一处');
  // 「删除当前牌组」在 bio 正文里恰好出现一次（切换器就插在它后面）
  if (bioParts.tail.split('<button id="deleteDeck" class="danger" disabled>删除当前牌组</button>').length - 1 !== 1) {
    throw new Error('bio 正文里「删除当前牌组」按钮不止一处');
  }

  const head = applyPairs(bioParts.head, HEAD_PAIRS, '头部');
  const tail = applyPairs(bioParts.tail, BODY_PAIRS, '正文');
  // MathJax 片段只存在于 chem，插在 <style> 之后（模板随后由 tests/tools/scope-css.js --write-template 填 styleBlock）
  if (!head.endsWith('<style>')) throw new Error('头部没有以 <style> 结尾，MathJax 插入位置不确定');
  assertChemRoundTrip(`${MATHJAX_BLOCK}${tail}`, chemParts.tail);

  const template = `${head}\n{{styleBlock}}\n</style>${MATHJAX_BLOCK}${tail}`;
  fs.writeFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), template);
  console.log('下一步：node tests/tools/scope-css.js --write-template 把合并样式表填进 {{styleBlock}}');

  // 与参考文件对比统计
  const changed = HEAD_PAIRS.length + BODY_PAIRS.length;  console.log(`public/index.html 模板已生成：${template.length} 字符`);
  console.log(`逐条替换 ${changed} 处（头部 ${HEAD_PAIRS.length} + 正文 ${BODY_PAIRS.length}，含新增的学科切换器）`);
  console.log(`反向校验通过：把模板的差异点还原成 chem 写法后，与 Chem2Anki 正文逐字相同（${chemParts.tail.length} 字符）`);
  const placeholders = [...new Set(template.match(/\{\{[#/]?[\w.]+\}\}/g) || [])].sort();
  console.log(`模板里用到的占位符（${placeholders.length}）：\n  ${placeholders.join('\n  ')}`);
}

module.exports = { HEAD_PAIRS, BODY_PAIRS, split, applyPairs, assertChemRoundTrip };

if (require.main === module) main();
