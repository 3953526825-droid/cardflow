'use strict';
/*
 * CSS 快照：用级联裁决器算出「探针元素」上每个相关属性的最终生效值。
 * 阶段 B 整理样式表时，用它做改动前后的逐项对比（同一套探针、同一个裁决器）。
 */
const fs = require('fs');
const path = require('path');
const { compileCss, extractStyles, probeFromPath, matchingProperties, resolveDeclaration, parseCompoundList, parseCompound, makeProbeNode } = require('./dom');

// 探针：从根到目标元素的描述链；{ el, prev } 用来表达相邻兄弟（如 .grid>div+div）
const BOX = ['body', 'main', 'details.box'];
const INSIDE = [...BOX, 'div.inside'];
const SEARCH = [...INSIDE, 'div.searchResults', 'div.searchItem'];

const PROBES = {
  'html/body': ['body'],
  'main': ['body', 'main'],
  'h1': ['body', 'main', 'h1'],
  'h1 small': ['body', 'main', 'h1', 'small'],
  '.sub': ['body', 'main', 'div.sub'],
  '.topStatus': ['body', 'main', 'div.topStatus'],
  '#status': ['body', 'main', 'div#status'],
  '.box': BOX,
  '.box>summary': [...BOX, 'summary'],
  '.inside': INSIDE,
  '.inside>button': [...INSIDE, 'button'],
  'button': [...INSIDE, 'button'],
  'button:disabled': [...INSIDE, 'button'],
  '.secondary': [...INSIDE, 'button.secondary'],
  'label': [...INSIDE, 'label'],
  'input': [...INSIDE, 'input'],
  'select': [...INSIDE, 'select'],
  'textarea': [...INSIDE, 'textarea'],
  'textarea.reference': [...INSIDE, 'textarea.reference'],
  'textarea.extraRules': [...INSIDE, 'textarea.extraRules'],
  '.chosen': [...INSIDE, 'div.chosen'],
  '.tree': [...INSIDE, 'div.tree'],
  '.leaf': [...INSIDE, 'div.tree', 'button.leaf'],
  '.drop': [...INSIDE, 'div.drop'],
  '.thumbs': [...INSIDE, 'div.thumbs'],
  '.thumb img': [...INSIDE, 'div.thumbs', 'div.thumb', 'img'],
  '.cards': [...INSIDE, 'div.cards'],
  '.card': [...INSIDE, 'div.cards', 'div.card'],
  '.muted': [...INSIDE, 'div.muted'],
  '.grid': [...INSIDE, 'div.grid'],
  '.grid>div': [...INSIDE, 'div.grid', 'div'],
  '.grid>div+div': [...INSIDE, 'div.grid', { el: 'div', prev: ['div'] }],
  '.searchRow': [...INSIDE, 'div.searchRow'],
  '.searchRow>input': [...INSIDE, 'div.searchRow', 'input'],
  '.searchRow>button': [...INSIDE, 'div.searchRow', 'button'],
  '.searchResults': [...INSIDE, 'div.searchResults'],
  '.searchItem': SEARCH,
  '.searchItem .snip': [...SEARCH, 'div.snip'],
  '.snip.expanded': [...SEARCH, 'div.snip.expanded'],
  '.snipToggle': [...SEARCH, 'div.snipToggle'],
  '.searchItem a': [...SEARCH, 'a'],
  '.searchItem button': [...SEARCH, 'button'],
  '.searchItem button+button': [...SEARCH, { el: 'button', prev: ['button'] }],
  '.sectionTitle': [...INSIDE, 'div.searchResults', 'div.sectionTitle'],
  '.deckNew': [...INSIDE, 'div.deckNew'],
  '.deckNewLabel': [...INSIDE, 'div.deckNew', 'label.deckNewLabel'],
  '.deckNew .chosen': [...INSIDE, 'div.deckNew', 'div.chosen'],
  '.deckNew>details>summary': [...INSIDE, 'div.deckNew', 'details', 'summary'],
  '.deckNewRow': [...INSIDE, 'div.deckNew', 'div.deckNewRow'],
  '.deckNewRow>input': [...INSIDE, 'div.deckNew', 'div.deckNewRow', 'input'],
  '.deckNewRow>button': [...INSIDE, 'div.deckNew', 'div.deckNewRow', 'button'],
  '.deckNewPreview': [...INSIDE, 'div.deckNew', 'div.deckNewPreview'],
  '.tokenGate': ['body', 'div.tokenGate'],
  '.tokenGate .tokenCard': ['body', 'div.tokenGate', 'div.tokenCard'],
  '.tokenGate input': ['body', 'div.tokenGate', 'input'],
  '.tokenGate button': ['body', 'div.tokenGate', 'button'],
  '.tokenError': ['body', 'div.tokenGate', 'div.tokenError'],
  '.primaryAction': [...INSIDE, 'button.primaryAction'],
  '.toast': ['body', 'div.toast'],
  '.toast.show': ['body', 'div.toast.show'],
  '.toast.error': ['body', 'div.toast.error'],
  '#retry': [...INSIDE, 'button#retry'],
  '#deckDeleteInfo': [...INSIDE, 'div#deckDeleteInfo'],
  '#referenceInfo': [...INSIDE, 'span#referenceInfo']
};

function compileProject(projectRoot) {
  const html = fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf8');
  return compileCss(extractStyles(html));
}

/* ---------- 按选择器逐条对比：给每条选择器合成一个探针，再算最终生效值 ---------- */

function descriptorForCompound(compound) {
  let text = compound.tag || 'div';
  if (compound.id) text += `#${compound.id}`;
  compound.classes.forEach(cls => { text += `.${cls}`; });
  const spec = { el: text };
  if (compound.attrs.length) {
    spec.attrs = {};
    for (const attr of compound.attrs) spec.attrs[attr.name] = attr.value || 'x';
  }
  const states = compound.pseudos.filter(p => !['not', 'has', 'is', 'where', 'root'].includes(p.name)).map(p => p.name);
  if (states.length) spec.pseudos = states;
  return spec;
}

/** 按选择器结构合成一个「一定能让这条选择器命中」的元素（含祖先链与前一个兄弟）。 */
function probeFromSelector(selector) {
  const compounds = parseCompoundList(selector).map(item => ({ compound: parseCompound(item.text), combinator: item.combinator }));
  if (!compounds.length) return null;
  // 多学科版把 :root 改写成 html[data-subject="x"]，为了两边可比，:root 的探针也做成 html 元素
  compounds.forEach((item, index) => {
    if (index === 0 && !item.compound.tag && item.compound.pseudos.some(pseudo => pseudo.name === 'root')) item.compound.tag = 'html';
  });
  const make = spec => { const node = makeProbeNode(spec); node._prev = []; return node; };
  let parent = null;
  let last = null;
  const nodes = [];
  compounds.forEach((item, index) => {
    const node = make(descriptorForCompound(item.compound));
    if (index === 0) { node.parentElement = null; parent = node; }
    else if (item.combinator === '>') { node.parentElement = parent; parent = node; }
    else if (item.combinator === '+' || item.combinator === '~') { node.parentElement = last ? last.parentElement : null; node._prev = last ? [last] : []; }
    else { node.parentElement = last; parent = node; }
    last = node;
    nodes.push(node);
  });
  return nodes[nodes.length - 1];
}

/** 多学科版：给探针链补上 html/body 的 data-subject 属性，好让 scoped 规则命中。 */
function scopedPath(subject, path) {
  if (!subject) return path;
  const attr = `[data-subject="${subject}"]`;
  const [first, ...rest] = path;
  if (first === 'html') return [`html${attr}`, ...rest];
  if (first === 'body') return [`html${attr}`, `body${attr}`, ...rest.slice(1)];
  return [`html${attr}`, `body${attr}`, ...path];
}

/** 把 scoped 样式表里的 `[data-subject="x"]` 前缀去掉，得到与旧样式表同名的选择器。 */
function stripScope(selector, subject) {
  if (!subject) return selector;
  return selector.split(`[data-subject="${subject}"]`).join('').replace(/\s+/g, ' ').trim();
}

/** 归一化：:root 与 html 在真实文档里是同一个元素，统一记成 html，两边才可比。 */
function normalizeSelectorKey(selector) {
  if (!selector.includes(':root')) return selector;
  const stripped = selector.split(':root').join('').trim();
  return stripped === '' || stripped === 'html' ? 'html' : stripped;
}

/** 用真实页面结构给合成探针补一层祖先，让匹配结果更接近实际（.box 之类祖先选择器也能命中）。 */
function realisticProbe(selector, subject) {
  const node = probeFromSelector(selector);
  if (!node) return null;
  if (selector.includes(':root')) return node; // :root 不能再挂祖先
  let head = node;
  while (head.parentElement) head = head.parentElement;
  const firstTag = String(head.tag || '');
  const attr = subject ? `[data-subject="${subject}"]` : '';
  if (firstTag === 'html') return node;
  if (firstTag === 'body') { head.parentElement = makeProbeNode(`html${attr}`); return node; }
  const main = makeProbeNode('main');
  main.parentElement = makeProbeNode(`body${attr}`);
  main.parentElement.parentElement = makeProbeNode(`html${attr}`);
  head.parentElement = main;
  return node;
}

/**
 * 对样式表里出现的每一条选择器，逐属性算出最终生效值（两个断点各算一遍）。
 * 阶段 B 整理样式表时用它做「除了顺序，什么都没变」的逐条证据。
 */
function selectorSnapshot(css, widths = [390, 1280], subject = '') {
  const table = new Map();
  const scopePattern = /\[data-subject="([^"]+)"\]/;
  for (const rule of css) {
    for (const rawSelector of rule.selectors) {
      if (rawSelector.includes('::') || rawSelector.includes(':has(')) continue; // 伪元素/关系伪类不是真实元素
      const scope = scopePattern.exec(rawSelector);
      if (scope && subject && scope[1] !== subject) continue; // 别的学科的规则，不该参与本学科的比对
      const key = normalizeSelectorKey(stripScope(rawSelector, subject));
      if (!table.has(key)) table.set(key, { raw: rawSelector, properties: new Set() });
      rule.decls.forEach(decl => table.get(key).properties.add(decl.property));
    }
  }
  const out = {};
  for (const [selector, entry] of table) {
    const node = realisticProbe(entry.raw, subject);
    if (!node) continue;
    const perWidth = {};
    let matched = false;
    for (const width of widths) {
      const values = {};
      for (const property of entry.properties) {
        const value = resolveDeclaration(css, node, property, width);
        if (value !== undefined) { values[property] = value; matched = true; }
      }
      perWidth[String(width)] = values;
    }
    if (matched) out[selector] = perWidth;
  }
  return out;
}

/** 从样式表里抽出所有断点，并取每档 ±1px —— 避免「只在 800px 这类中间宽度变了」被漏掉。 */
function breakpointWidths(css) {
  const set = new Set([390, 760, 1280]);
  const text = css.map(rule => rule.media.join(' ')).join(' ');
  for (const match of text.matchAll(/(?:min|max)-width\s*:\s*([\d.]+)px/g)) {
    const base = Math.round(Number(match[1]));
    for (const width of [base - 1, base, base + 1]) if (width >= 200 && width <= 4000) set.add(width);
  }
  return [...set].sort((a, b) => a - b);
}

function snapshot(projectRoot, width, compiled, subject = '') {
  const css = compiled || compileProject(projectRoot);
  const out = {};
  for (const [name, probePath] of Object.entries(PROBES)) {
    const node = probeFromPath(scopedPath(subject, probePath));
    const values = {};
    for (const property of matchingProperties(css, node, width)) {
      values[property] = resolveDeclaration(css, node, property, width);
    }
    out[name] = values;
  }
  return out;
}

function snapshotAll(projectRoot, options = {}) {
  const compiled = compileProject(projectRoot);
  const subject = options.subject || '';
  const result = {};
  for (const width of options.viewportWidths || [390, 760, 1280]) result[`${width}px`] = snapshot(projectRoot, width, compiled, subject);
  const widths = options.selectorWidths || breakpointWidths(compiled);
  return {
    subject,
    viewportWidths: options.viewportWidths || [390, 760, 1280],
    selectorWidths: widths,
    viewport: result,
    selectors: selectorSnapshot(compiled, widths, subject)
  };
}

module.exports = { PROBES, compileProject, snapshot, snapshotAll, selectorSnapshot, probeFromSelector, realisticProbe, breakpointWidths, scopedPath, stripScope, normalizeSelectorKey };

if (require.main === module) {
  // 用法：node tests/helpers/css-probes.js <项目根目录> <输出文件> [学科id]
  // 生成某个学科的基准快照时传学科 id（会用带 data-subject 属性的探针）。
  const root = path.resolve(process.argv[2] || path.resolve(__dirname, '..', '..'));
  const subject = process.argv[4] || '';
  const json = `${JSON.stringify(snapshotAll(root, { subject }), null, 2)}\n`;
  if (process.argv[3]) {
    fs.writeFileSync(path.resolve(process.argv[3]), json);
    process.stdout.write(`css baseline -> ${path.resolve(process.argv[3])} (${json.length} bytes, subject=${subject || '(无)'})\n`);
  } else {
    process.stdout.write(json);
  }
}
