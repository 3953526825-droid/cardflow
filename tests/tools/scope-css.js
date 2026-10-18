'use strict';
/*
 * 把两个学科参考 index.html 的样式表合成一份「按学科作用域隔离」的样式表。
 *
 * 输入（只读，绝不修改参考项目）：
 *   C:\Users\Administrator\Bio2Anki\public\index.html
 *   C:\Users\Administrator\Chem2Anki\public\index.html
 *   subjects/bio.json, subjects/chem.json（theme 字段用于生成主题调色板变量）
 * 输出：
 *   stdout（默认）或 --out <文件>：合并后的 styleBlock 文本
 *
 * 作用域规则（与需求逐条对应）：
 *   *            → 两个学科里逐字相同的 `*{...}` 合并成一条不带作用域的规则，放在最前面
 *   :root        → html[data-subject="<id>"]
 *   html...      → html[data-subject="<id>"]...
 *   body...      → body[data-subject="<id>"]...
 *   其它         → [data-subject="<id>"] + 选择器
 *   逗号分隔的选择器列表逐个加前缀；@media 块内部同样处理。
 *   bio 整段在前、chem 整段在后，块与规则的先后顺序原样保留。
 *
 * 用法：
 *   node tests/tools/scope-css.js                     # 打印统计
 *   node tests/tools/scope-css.js --out tests/.tmp/styleBlock.css
 *   node tests/tools/scope-css.js --write-template     # 把 styleBlock 写进 public/index.html 的占位符
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const REFERENCE = {
  bio: 'C:/Users/Administrator/Bio2Anki/public/index.html',
  chem: 'C:/Users/Administrator/Chem2Anki/public/index.html'
};
const SUBJECT_IDS = ['bio', 'chem'];

/* ============================ 读取输入 ============================ */

/** 取出 index.html 里 <style>…</style> 的内容。 */
function extractStyles(html) {
  const match = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(html);
  if (!match) throw new Error('index.html 里找不到 <style> 块');
  return match[1];
}

function readSubject(id) {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'subjects', `${id}.json`), 'utf8'));
}

/* ============================ 轻量 CSS 解析 ============================ */

/** 按「顶层 ; { }」切分，且不切注释/引号/圆括号内部的字符。 */
function findTerminator(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      // 注释要整段跳过，否则注释里的中文引号会让引号扫描跑飞
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (depth > 0 && (ch === '"' || ch === "'")) {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && (ch === '{' || ch === '}')) return { index: i, char: ch };
  }
  return null;
}

/** 跳过一段注释与紧邻的空白，返回新的位置；没有注释时返回 -1。 */
function skipCommentAndSpace(text, from) {
  let i = from;
  if (!/\s/.test(text[i]) && !text.startsWith('/*', i)) return -1;
  let sawComment = false;
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      sawComment = true;
      continue;
    }
    if (/\s/.test(text[i])) { i++; continue; }
    break;
  }
  return sawComment ? i : -1;
}

/** 把样式表解析成 [{ type:'raw'|'rule'|'media', … }]，块与规则的先后顺序原样保留。 */
function parseStyleSheet(text) {
  const nodes = [];
  let i = 0;
  const pushRaw = raw => { if (raw) nodes.push({ type: 'raw', raw }); };

  while (i < text.length) {
    // 注释（连同它前面的空白）整段搬运成 raw 节点：注释里的中文引号不会干扰选择器扫描，
    // 也不会被误当成某条规则的选择器。
    const afterComment = skipCommentAndSpace(text, i);
    if (afterComment >= 0) {
      pushRaw(text.slice(i, afterComment));
      i = afterComment;
      continue;
    }
    const term = findTerminator(text, i);
    if (!term) { pushRaw(text.slice(i)); break; }
    const prelude = text.slice(i, term.index);
    if (term.char === '}') { pushRaw(text.slice(i, term.index + 1)); i = term.index + 1; continue; }
    if (term.char === ';') { pushRaw(text.slice(i, term.index + 1)); i = term.index + 1; continue; }

    // 找到与这个 '{' 配对的 '}'
    let depth = 0;
    let j = term.index;
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (!depth) break; }
    }
    const body = text.slice(term.index + 1, j);
    // 判断「选择器」位置到底是规则、还是媒体查询。
    // 参考样式表里两种写法都有：`@media(…){` 另起一行，以及紧跟在上一条规则的 `}` 之后
    // 同一行的 `} @media(…){`（这样解析出来的 prelude 会带上前一条规则的收尾）。
    const declared = prelude.trimStart().startsWith('@media');
    const trailing = !declared && /@media\s*\([^)]*\)\s*$/.test(prelude);
    if (declared || trailing) {
      const atRule = declared
        ? prelude.trim()
        : (prelude.match(/@media\s*\([^)]*\)\s*$/) || [''])[0].trim();
      const inner = parseStyleSheet(body);
      nodes.push({ type: 'media', atRule, inner, indent: '' });
      i = j + 1;
      if (text[i] === '\n') i++;
      continue;
    }
    if (prelude.trimStart().startsWith('@')) {
      // @font-face / @keyframes 之类整块原样搬运（本样式表里没有，保险起见）
      pushRaw(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    nodes.push({ type: 'rule', prelude, body });
    i = j + 1;
  }
  return nodes;
}

/* ============================ 选择器作用域化 ============================ */

/** 按顶层逗号切分选择器列表（不切括号/引号内部）。 */
function splitSelectorList(list) {
  const out = [];
  let depth = 0, buf = '', quote = null;
  for (const ch of list) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.filter(s => s.trim() !== '');
}

/**
 * 单个选择器加作用域前缀。
 * 关键点：`html` / `body` 开头的选择器只给「首个复合选择器」加属性，`:root` 额外保留 `:root`
 * 伪类 —— 这样优先级与原样式表一致。特别地 `:root{…}` 必须落在 html 元素上且优先级高于
 * 后面的 `html{…}`，如果写成 `html[data-subject=x]`（0,1,1）就会被 `html`（0,0,1）反超，
 * 一旦源顺序变化最终值就变了；写成 `html:root[data-subject=x]`（0,2,1）才能保持原裁决结果。
 * 选择器内部的换行/多余空白压成单空格，便于稳定输出。
 */
function scopeSelector(selector, id) {
  const trimmed = selector.trim().replace(/\s+/g, ' ');
  if (trimmed === ':root') return `html:root[data-subject="${id}"]`;
  if (trimmed.startsWith('html')) return `html[data-subject="${id}"]${trimmed.slice(4)}`;
  if (trimmed.startsWith('body')) return `body[data-subject="${id}"]${trimmed.slice(4)}`;
  return `[data-subject="${id}"] ${trimmed}`;
}

/* ============================ 输出 ============================ */

const HEADER = `/*
 * 合并样式表（Bio2Anki + Chem2Anki，单文件双学科）
 *
 * 结构：⓪ 通用规则（两学科逐字相同，不带作用域）
 *       ① 主题调色板变量（纯声明，供以后改主题用；真实生效值仍由各学科 :root 决定）
 *       ② Bio2Anki 全部规则（作用域 html/body[data-subject="bio"]）
 *       ③ Chem2Anki 全部规则（作用域 html/body[data-subject="chem"]）
 * 生成：node tests/tools/scope-css.js
 * 说明：每个选择器只加了一段作用域前缀，声明、属性、值与源码顺序逐条原样保留；
 *       两个学科的规则各自成段、先后顺序不变，因此各学科内的层叠结果与参考文件一致。
 */`;

/** 主题调色板变量：按 subjects/*.json 的 theme 字段生成。 */
function themeBlock(subject) {
  const theme = subject.theme || {};
  const decls = [
    ['--subject-accent', theme.accent],
    ['--subject-accent-soft', theme.accentSoft],
    ['--subject-ink', theme.ink],
    ['--subject-muted', theme.muted],
    ['--subject-line', theme.line],
    ['--subject-panel', theme.panel],
    ['--subject-toast-bg', theme.toastBg]
  ].filter(([, value]) => value !== undefined && value !== null);
  const lines = decls.map(([name, value]) => `  ${name}: ${value};`);
  return `html[data-subject="${subject.id}"] {\n${lines.join('\n')}\n}`;
}

/** 把规则体排版成「按目标层级重新缩进」的形式（层级由选择器所在的块决定）。 */
function renderBody(body, indent) {
  const text = body.replace(/^\n/, '').replace(/\s*$/, '');
  return text.split('\n')
    .map(line => (line.trim() === '' ? '' : `${indent}${line.trim()}`))
    .join('\n');
}

function renderNodes(nodes, scope, indent) {
  const lines = [];
  for (const node of nodes) {
    if (node.type === 'raw') {
      // 参考样式表里只有注释会被当作 raw；整段原样搬运（不加缩进以免破坏排版）
      if (node.raw.trim() !== '') lines.push(node.raw.replace(/\s*$/, ''));
      continue;
    }
    if (node.type === 'media') {
      // 参考样式表里的媒体查询都是多行块：`@media(…){` 后换行，块内选择器缩进一级、声明两级
      lines.push(`${node.atRule}{`);
      lines.push(renderNodes(node.inner, scope, `${indent}  `));
      lines.push(`${indent}}`);
      continue;
    }
    const selectors = splitSelectorList(node.prelude).map(sel => scopeSelector(sel, scope)).join(',');
    lines.push(`${indent}${selectors} {`);
    lines.push(renderBody(node.body, `${indent}  `));
    lines.push(`${indent}}`);
  }
  return lines.join('\n');
}

/** 只渲染规则与媒体块（参考样式表开头的注释由调用方自行处理）。 */
function renderRules(nodes, scope, indent) {
  return renderNodes(nodes.filter(node => node.type === 'rule' || node.type === 'media'), scope, indent);
}

function buildStyleBlock() {
  const subjects = SUBJECT_IDS.map(readSubject);
  const parsed = {};
  for (const id of SUBJECT_IDS) {
    const html = fs.readFileSync(REFERENCE[id], 'utf8');
    parsed[id] = parseStyleSheet(extractStyles(html));
  }

  // ⓪ 两学科里逐字相同的 `*` 规则
  const rules = id => parsed[id].filter(node => node.type === 'rule' || node.type === 'media');
  const sets = SUBJECT_IDS.map(id => new Set(
    rules(id).filter(node => node.type === 'rule').map(node => node.prelude.trim())
  ));
  const universalSelectors = [...sets[0]].filter(sel => sel === '*' && sets.every(set => set.has(sel)));

  const pieces = [HEADER, ''];

  if (universalSelectors.length) {
    const bodies = universalSelectors.map(sel => rules('bio').find(node => node.type === 'rule' && node.prelude.trim() === sel).body);
    const identical = bodies.every(body => body === bodies[0]);
    if (!identical) throw new Error('`*` 规则在两个学科里内容不同，无法合并成一条通用规则');
    pieces.push('/* ===== ⓪ 通用规则：两个学科逐字相同，不带作用域 ===== */');
    pieces.push(`${universalSelectors.join(',')} {`);
    pieces.push(renderBody(bodies[0], '  '));
    pieces.push('}');
    pieces.push('');
  }

  pieces.push('/* ===== ① 主题调色板变量：纯声明，供以后改主题用 ===== */');
  for (const subject of subjects) { pieces.push(themeBlock(subject)); pieces.push(''); }

  for (const id of SUBJECT_IDS) {
    const subject = subjects.find(item => item.id === id);
    pieces.push(`/* ===== ${subject.shortName} 全部规则（作用域 ${id}）===== */`);
    pieces.push(renderRules(parsed[id], id, ''));
    pieces.push('');
  }

  return pieces.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

/* ============================ 自检 ============================ */

function selfCheck(block) {
  const problems = [];
  // 1) 残留未加作用域的选择器：先去掉注释，再把每个 `{` 前的 prelude 抠出来检查
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleRe = /(^|\n)([^\n{}]*?)\s*\{/g;
  let match;
  while ((match = ruleRe.exec(withoutComments))) {
    const prelude = match[2].trim();
    if (!prelude) continue;
    if (prelude.startsWith('@')) continue;
    if (prelude.includes(':')) continue; // 声明值里的大括号（如 grid-template-columns）不是规则
    for (const sel of splitSelectorList(prelude)) {
      const text = sel.trim();
      const ok = text === '*' || text.startsWith('html[data-subject=')
        || text.startsWith('body[data-subject=') || text.startsWith('[data-subject=');
      if (!ok) problems.push(`选择器没有作用域：${text}`);
    }
  }
  // 2) 参考样式表里的每条选择器都要在结果里出现
  for (const id of SUBJECT_IDS) {
    const css = extractStyles(fs.readFileSync(REFERENCE[id], 'utf8'));
    for (const node of parseStyleSheet(css)) {
      const walk = item => {
        if (item.type === 'media') { item.inner.forEach(walk); return; }
        if (item.type !== 'rule') return;
        for (const sel of splitSelectorList(item.prelude)) {
          const scoped = scopeSelector(sel, id);
          if (!block.includes(scoped)) problems.push(`${id} 丢失选择器：${sel} -> ${scoped}`);
        }
      };
      walk(node);
    }
  }
  // 3) 花括号必须配平
  let depth = 0;
  for (const ch of block) { if (ch === '{') depth++; else if (ch === '}') depth--; if (depth < 0) break; }
  if (depth !== 0) problems.push(`花括号不配平（差 ${depth}）`);
  return problems;
}

/* ============================ 入口 ============================ */

function main() {
  const block = buildStyleBlock();
  const problems = selfCheck(block);

  const outIndex = process.argv.indexOf('--out');
  if (outIndex >= 0) {
    const target = path.resolve(process.argv[outIndex + 1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, block);
    console.log(`styleBlock -> ${target}（${block.length} 字符）`);
  }
  if (process.argv.includes('--write-template')) {
    const templatePath = path.join(PROJECT_ROOT, 'public', 'index.html');
    const html = fs.readFileSync(templatePath, 'utf8');
    const marker = '{{styleBlock}}';
    if (!html.includes(marker)) throw new Error(`public/index.html 里找不到 ${marker}`);
    fs.writeFileSync(templatePath, html.replace(marker, () => block));
    console.log(`已写入 ${templatePath}`);
  }
  if (outIndex < 0 && !process.argv.includes('--write-template')) {
    process.stdout.write(block);
  }
  if (problems.length) {
    console.error(`自检失败（${problems.length} 条）：`);
    problems.slice(0, 40).forEach(line => console.error('  ' + line));
    process.exitCode = 1;
  } else {
    console.error('自检通过：所有选择器都带作用域、参考样式表的选择器一个不少、花括号配平。');
  }
}

module.exports = { buildStyleBlock, parseStyleSheet, scopeSelector, splitSelectorList, themeBlock, selfCheck };

if (require.main === module) main();
