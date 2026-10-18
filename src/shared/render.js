'use strict';
/* 模板渲染：{{$name}} 变量替换、`=== 段名 ===` 分段。
   纯函数，Node（src/prompts.js）与安卓壳离线页共用；函数体从 src/prompts.js 逐字搬来。 */
(function (root) {
function renderTemplate(template, vars) {
  return String(template).replace(/\{\{\$(\w+)\}\}/g, (match, key) => (vars[key] == null ? '' : String(vars[key])));
}

function parseSections(text) {
  const source = String(text);
  const marks = [...source.matchAll(/^===\s*([\w-]+)\s*===\s*$/gm)];
  const sections = {};
  marks.forEach((mark, index) => {
    const start = mark.index + mark[0].length;
    const end = index + 1 < marks.length ? marks[index + 1].index : source.length;
    sections[mark[1]] = source.slice(start, end).replace(/^\s*\n/, '').replace(/\s*\n\s*$/, '');
  });
  return sections;
}

const api = { renderTemplate, parseSections };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.CardFlowShared = Object.assign(root.CardFlowShared || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
