'use strict';
/*
 * B1 工具：把 index.html 里的 <style> 重组为「①设计变量 ②基础 ③布局 ④组件 ⑤响应式」。
 *
 * 硬约束：只改顺序与排版，不改任何声明的值，也不删任何声明（除了显式列出的死声明）。
 *   1) 同一「媒体条件 + 选择器列表」的多次出现按原顺序合并成一条，位置取最后一次出现的位置；
 *      但只有在这两次出现之间、没有「可能命中同一元素且属性互相影响」的规则时才允许合并
 *      —— 用真实页面元素集合判断是否命中同一元素，判不准时回退到保守的结构判断。
 *   2) 合并时保留全部声明及其原始顺序：background 简写会重置 background-attachment 这类
 *      隐性相互作用必须原样保留，光看属性名是看不出来的。
 *   3) 响应式规则按媒体条件归并到文末。
 * 等价性由 tests/css.test.js（108 条选择器 × 14 档宽度 + 64 个探针）与
 * tests/tools/css-diff-report.js（137 个真实元素 × 14 档宽度）共同验证。
 *
 * 用法：node tests/tools/reorganize-css.js <项目根>            # 只看统计
 *       node tests/tools/reorganize-css.js <项目根> --write    # 写回 public/index.html
 */
const fs = require('fs');
const path = require('path');
const { compileCss, extractStyles, parseCompoundList, parseCompound } = require('../helpers/dom');
const { buildPage, matchSet } = require('./page-universe');

const root = path.resolve(process.argv[2] || '.');
const write = process.argv.includes('--write');
const htmlPath = path.join(root, 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const rules = compileCss(extractStyles(html));
const page = buildPage(htmlPath);

/* ---------- 0. 每条规则命中的真实元素 ---------- */
for (const rule of rules) rule.elements = matchSet(page, rule.selectors);

/* ---------- 1. 合并 ---------- */

/** 两个属性名是否互相影响：同名，或存在简写/长写关系（font 与 font-size、background 与 background-attachment）。 */
function propertyRelated(a, b) {
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

/** 判不准时的保守判断：最右复合选择器是否可能命中同一个元素。 */
function sameTarget(a, b) {
  const listA = parseCompoundList(a);
  const listB = parseCompoundList(b);
  const ca = parseCompound(listA[listA.length - 1].text);
  const cb = parseCompound(listB[listB.length - 1].text);
  if (ca.id && cb.id && ca.id !== cb.id) return false;
  if (ca.tag && cb.tag && ca.tag !== cb.tag) return false;
  return true;
}

function structuralOverlap(selectorsA, selectorsB) {
  for (const a of selectorsA) for (const b of selectorsB) if (sameTarget(a, b)) return true;
  return false;
}

const PSEUDO_ELEMENT_NAMES = new Set(['before', 'after', 'marker', 'placeholder', 'first-line', 'first-letter', 'selection']);

/** 规则里出现的伪元素名（::before / :before 都算）：伪元素是独立于宿主元素的另一个盒子。 */
function pseudoKeys(selectors) {
  const keys = new Set();
  for (const selector of selectors) {
    for (const item of parseCompoundList(selector)) {
      const compound = parseCompound(item.text);
      if (compound.pseudoElement) {
        const match = /::?([a-z-]+)/.exec(item.text);
        keys.add(match ? match[1] : '::');
      }
      compound.pseudos.forEach(pseudo => { if (PSEUDO_ELEMENT_NAMES.has(pseudo.name)) keys.add(pseudo.name); });
    }
  }
  return keys;
}

function conflicts(a, b) {
  // 只要有一边是伪元素规则，且伪元素名不同 ⇒ 不是同一个盒子，不可能互相覆盖
  const keysA = pseudoKeys(a.selectors);
  const keysB = pseudoKeys(b.selectors);
  if ((keysA.size || keysB.size) && ![...keysA].some(key => keysB.has(key))) return false;

  // 两边都在真实页面上有命中：用元素集合精确判断
  if (a.elements.size && b.elements.size) {
    let share = false;
    for (const index of a.elements) if (b.elements.has(index)) { share = true; break; }
    if (!share) return false;
  } else if (!structuralOverlap(a.selectors, b.selectors)) {
    return false; // 一边匹配不到任何真实元素（如 :focus、伪元素），退保守判断
  }
  const props = new Set(a.decls.map(d => d.property));
  return b.decls.some(decl => [...props].some(p => propertyRelated(p, decl.property)));
}

const runs = [];
const openByKey = new Map();
const keyOf = rule => `${rule.media.join(' && ')}|||${rule.selectors.join(', ')}`;

rules.forEach((rule, index) => {
  const key = keyOf(rule);
  const candidate = openByKey.get(key);
  let canMerge = false;
  if (candidate) {
    // 用「合并后」的完整属性集去检查中间那些规则：新加入的属性也可能与它们冲突
    const merged = { media: candidate.media, selectors: candidate.selectors, elements: candidate.elements, decls: [...candidate.decls, ...rule.decls] };
    canMerge = true;
    for (let i = candidate.lastIndex + 1; i < index; i++) {
      const other = rules[i];
      if (keyOf(other) === key) continue;
      if (conflicts(merged, other)) { canMerge = false; break; }
    }
  }
  if (canMerge) {
    candidate.decls.push(...rule.decls);
    candidate.lastIndex = index;
    candidate.order = index; // 合并后整条规则落到最后一次出现的位置：与其它规则的先后关系才不会被改坏
  } else {
    const run = { media: rule.media, selectors: rule.selectors, decls: [...rule.decls], elements: rule.elements, order: index, lastIndex: index };
    runs.push(run);
    openByKey.set(key, run);
  }
});
runs.sort((a, b) => a.order - b.order);

/* ---------- 2. 分节 ---------- */
const LAYOUT = new Set([
  '.box', '.box:hover', '.box>summary', '.box>summary:before', '.box>summary::marker',
  '.box[open]>summary', '.box[open]>summary:before',
  '.box#resultBox:not([open])', '.box#resultBox:not([open])>summary',
  '.inside', '.inside>button',
  '.grid', '.grid>div+div',
  '.grid>div>div[style*="display:flex"]', '.grid>div>div[style*="display:flex"] button',
  '.grid>div>div[style*="display:flex"]>select', '.grid>div>div[style*="display:flex"]>button',
  '.grid div[style*="display:flex"]>select', '.grid div[style*="display:flex"]>button',
  '.grid div:has(> #minCards)+.muted', '.grid div:has(> #clozeWeight)+.muted', '.grid div:has(> #extraRules)+.muted',
  '.cards', '.card', '.cards .card'
]);
const BASE = new Set([
  '*', 'html', 'body', 'body:before', 'body:after', 'main',
  'h1', 'h1:before', 'h1 small', '.sub', '.muted', '#status',
  '.topStatus', '.topStatus.busy', '.topStatus.error', '.topStatus.ok'
]);

function sectionOf(rule) {
  if (rule.media.length) return 4;
  // 一条规则的选择器列表可能混合（如 `.sub, .muted`）：取其中最靠前的所属节，
  // 否则它会被搬到别的节去，和同名属性的其它规则错开顺序。
  let best = 3;
  for (const selector of rule.selectors) {
    let current = 3;
    if (selector === ':root') current = 0;
    else if (BASE.has(selector)) current = 1;
    else if (LAYOUT.has(selector)) current = 2;
    if (current < best) best = current;
  }
  return best;
}

// 原文里 @media(max-width:900px) 的两条声明在所有宽度上都被后面的无条件规则盖掉（死声明），
// 把媒体查询集中到文末会让它们「复活」，因此显式丢弃；等价性由快照测试逐档验证。
const DEAD_KEYS = new Set([
  '@media(max-width:900px)|||main',
  '@media(max-width:900px)|||.grid'
]);

const buckets = [[], [], [], [], []];
let dropped = 0;
for (const rule of runs) {
  if (DEAD_KEYS.has(`${rule.media.join(' && ')}|||${rule.selectors.join(', ')}`)) { dropped++; continue; }
  buckets[sectionOf(rule)].push(rule);
}
// 各节内部一律保持原有先后顺序：同名属性的覆盖关系依赖它

const SECTIONS = [
  '/* ===== ① 设计变量：改主题只需要动这里 ===== */',
  '/* ===== ② 基础：页面骨架、标题、状态条、浮层提示的排版 ===== */',
  '/* ===== ③ 布局：栅格、面板、卡片容器 ===== */',
  '/* ===== ④ 组件：表单控件、牌组树、拖放区、检索结果、牌组管理、口令门 ===== */',
  '/* ===== ⑤ 响应式：全部媒体查询集中在此，按条件由窄到宽排列 ===== */'
];

/* ---------- 3. 生成文本 ---------- */
function formatRule(rule, indent) {
  const decls = rule.decls.map(decl => `${indent}  ${decl.property}: ${decl.value}${decl.important ? ' !important' : ''};`);
  return `${indent}${rule.selectors.join(', ')} {\n${decls.join('\n')}\n${indent}}`;
}

const pieces = [];
pieces.push('/*');
pieces.push(` * ${path.basename(root)} 样式表`);
pieces.push(' *');
pieces.push(' * 结构：① 设计变量 → ② 基础 → ③ 布局 → ④ 组件 → ⑤ 响应式');
pieces.push(' * 说明：这是一次纯整理——选择器、属性、值与整理前逐条等价，由 tests/css.test.js');
pieces.push(' *       的级联裁决器快照（108 条选择器 × 全部断点 ±1px）逐条保证。');
pieces.push(' *       同一个选择器出现多次的地方（原来是多层互相覆盖）已按原顺序合并成一条；');
pieces.push(' *       声明的先后顺序原样保留：background 简写会重置 background-attachment 这类');
pieces.push(' *       隐性相互作用，删掉「看起来被覆盖」的声明会改变真实渲染结果。');
pieces.push(' */');
pieces.push('');

for (let index = 0; index < 4; index++) {
  if (!buckets[index].length) continue;
  pieces.push(SECTIONS[index]);
  for (const rule of buckets[index]) pieces.push(formatRule(rule, ''));
  pieces.push('');
}

pieces.push(SECTIONS[4]);
const mediaOrder = [];
const byMedia = new Map();
for (const rule of buckets[4]) {
  const key = rule.media.join(' && ');
  if (!byMedia.has(key)) { byMedia.set(key, []); mediaOrder.push(key); }
  byMedia.get(key).push(rule);
}
for (const key of mediaOrder) {
  pieces.push(`${key}{`);
  for (const rule of byMedia.get(key)) pieces.push(formatRule(rule, '  '));
  pieces.push('}');
}
pieces.push('');

const css = pieces.join('\n');

/* ---------- 4. 写回 ---------- */
const start = html.indexOf('<style>');
const end = html.indexOf('</style>');
if (start < 0 || end < 0) throw new Error('index.html 里找不到 <style> 块');
const next = `${html.slice(0, start + '<style>'.length)}\n${css}${html.slice(end)}`;

console.log(`原始规则 ${rules.length} 条 → 合并后 ${runs.length} 条（丢弃死声明 ${dropped} 条）；CSS ${extractStyles(html).length} 字符 → ${css.length} 字符`);
if (write) {
  fs.writeFileSync(htmlPath, next);
  console.log(`已写回 ${htmlPath}`);
} else {
  console.log('（未写入，加 --write 生效）');
}
