'use strict';
/*
 * 对比两个 app.js 的函数名集合（用词法分析而不是正则，避免被字符串/注释里的同名字样干扰）。
 * 用法：node tests/tools/compare-app-functions.js <a.js> <b.js>
 */
const fs = require('fs');
const { tokenizeOpaque } = require('./js-tokenizer');

const KEYWORDS_BEFORE_NAME = new Set(['function']);

function functionNames(file) {
  const source = fs.readFileSync(file, 'utf8');
  const tokens = tokenizeOpaque(source).filter(t => t.type !== 'linecomment' && t.type !== 'blockcomment');
  const names = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (!next) continue;
    // function name(...) / async function name(...)
    if (token.type === 'ident' && KEYWORDS_BEFORE_NAME.has(token.value) && next.type === 'ident') { names.add(next.value); continue; }
    // const|let|var name = (args) => / name = arg => / name = async (...) => / name = function
    if (token.type === 'ident' && ['const', 'let', 'var'].includes(token.value) && next.type === 'ident') {
      const assign = tokens[i + 2];
      if (!assign || assign.value !== '=') continue;
      let cursor = i + 3;
      if (tokens[cursor] && tokens[cursor].value === 'async') cursor++;
      const after = tokens[cursor];
      if (!after) continue;
      if (after.value === 'function') { names.add(next.value); continue; }
      if (after.value === '(') {
        let depth = 0;
        let j = cursor;
        for (; j < tokens.length; j++) {
          if (tokens[j].value === '(') depth++;
          else if (tokens[j].value === ')') { depth--; if (!depth) break; }
        }
        if (tokens[j + 1] && tokens[j + 1].value === '=>') names.add(next.value);
        continue;
      }
      if (after.type === 'ident' && tokens[cursor + 1] && tokens[cursor + 1].value === '=>') names.add(next.value);
    }
  }
  return names;
}

const [, , fileA, fileB] = process.argv;
if (!fileA || !fileB) {
  console.error('用法：node tests/tools/compare-app-functions.js <a.js> <b.js>');
  process.exit(2);
}

const a = functionNames(fileA);
const b = functionNames(fileB);
const onlyA = [...a].filter(name => !b.has(name)).sort();
const onlyB = [...b].filter(name => !a.has(name)).sort();

console.log(`${fileA}：${a.size} 个函数`);
console.log(`${fileB}：${b.size} 个函数`);
console.log(`仅前者有（${onlyA.length}）：${onlyA.join(', ') || '（无）'}`);
console.log(`仅后者有（${onlyB.length}）：${onlyB.join(', ') || '（无）'}`);
console.log(onlyA.length === 0 && onlyB.length === 0 ? '结论：函数名集合完全一致。' : '结论：函数名集合不一致（存在学科特有函数）。');
process.exitCode = onlyA.length || onlyB.length ? 1 : 0;
