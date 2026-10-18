'use strict';
/*
 * 逐元素差异报告：按真实页面元素（index.html 结构 + app.js 动态模板）、逐属性、逐断点，
 * 对比两份 index.html 里样式表的最终生效值。是「行为完全不变」最贴近实际的一层验证。
 *
 * 用法：node tests/tools/css-diff-report.js <旧的 index.html> <新的 index.html> [bio|chem]
 *   新文件是多学科模板（含 {{subject.id}} 之类占位符）时，必须传学 id：
 *   工具会先把占位符换成该学科的值，再解析页面结构，这样 scoped 规则才命中得到。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileCss, extractStyles, resolveDeclaration, matchingProperties } = require('../helpers/dom');
const { buildPage } = require('./page-universe');
const { breakpointWidths } = require('../helpers/css-probes');

const [, , oldPath, newPath, subjectId] = process.argv;
if (!oldPath || !newPath) {
  console.error('用法：node tests/tools/css-diff-report.js <旧的 index.html> <新的 index.html> [bio|chem]');
  process.exit(2);
}

/** 读页面；如果是多学科模板，把占位符按学科替换掉（只为了解析结构，不追求渲染完全正确）。 */
function readPage(file) {
  let html = fs.readFileSync(file, 'utf8');
  if (subjectId) {
    html = html
      .replace(/\{\{subject\.id\}\}/g, subjectId)
      .replace(/\{\{#[\w.]+\}\}/g, '')
      .replace(/\{\{\/[\w.]+\}\}/g, '')
      .replace(/\{\{[\w.]+\}\}/g, '');
  }
  return html;
}

const oldCss = compileCss(extractStyles(readPage(oldPath)));
const newCss = compileCss(extractStyles(readPage(newPath)));

const scratch = path.join(os.tmpdir(), `css-diff-${process.pid}-${Date.now()}.html`);
fs.writeFileSync(scratch, readPage(newPath));
const { elements } = buildPage(scratch);
fs.unlinkSync(scratch);

const widths = breakpointWidths([...oldCss, ...newCss]);

let checked = 0;
const diffs = [];
const palette = [];
for (const { key, el } of elements) {
  const properties = new Set([...matchingProperties(oldCss, el, 1280), ...matchingProperties(newCss, el, 1280)]);
  for (const width of widths) {
    for (const property of properties) {
      const before = resolveDeclaration(oldCss, el, property, width);
      const after = resolveDeclaration(newCss, el, property, width);
      checked++;
      if (before === after) continue;
      const line = `${key} @${width} { ${property}: ${JSON.stringify(before)} -> ${JSON.stringify(after)} }`;
      // 阶段 C 特意新增的主题调色板变量（--subject-*）不算回归，单独列出来
      if (property.startsWith('--subject-')) palette.push(line); else diffs.push(line);
    }
  }
}

console.log(`页面元素 ${elements.length} 个，逐元素 × 逐属性 × ${widths.length} 档宽度，共比对 ${checked} 项`);
console.log(`实质差异：${diffs.length} 处`);
diffs.slice(0, 60).forEach(line => console.log('  ' + line));
console.log(`（另有 ${palette.length} 处是新增的 --subject-* 主题调色板变量，属于阶段 C 的新增内容，不是回归）`);
process.exitCode = diffs.length ? 1 : 0;
