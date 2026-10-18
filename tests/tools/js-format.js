'use strict';
/*
 * JS 解压/排版工具（零依赖）：把压缩成一行的代码整理成「2 空格缩进、一行一句、函数间空行」。
 *
 * 只做两件事：在 token 之间插入空白、在 token 之间插入换行。不重排、不改写、不删任何 token。
 * 因此「解压前后 token 流逐字相同」是可以被证明的（见 assertSameTokens 与 --check）。
 *
 * 用法：
 *   node tests/tools/js-format.js <文件>            # 打印排版结果
 *   node tests/tools/js-format.js <文件> --write     # 原地写回（先做 token 等价校验）
 *   node tests/tools/js-format.js <文件> --check     # 只校验 token 流是否等价
 */
const fs = require('fs');
const path = require('path');
const { tokenize, tokenizeOpaque, assertLossless } = require('./js-tokenizer');

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'try', 'catch', 'finally', 'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'function', 'class', 'extends', 'yield', 'await', 'async', 'const', 'let', 'var', 'export', 'import', 'from']);
const BINARY = new Set(['=', '+=', '-=', '*=', '/=', '%=', '==', '===', '!=', '!==', '<=', '>=', '<', '>', '&&', '||', '??', '=>', '+', '-', '*', '/', '%', '&', '|', '^', '**', '&=', '|=', '^=', '<<', '>>', '>>>', '?.']);
const NO_SPACE_AFTER = new Set(['(', '[', '.', '!', '~', '...', '?.']);
const NO_SPACE_BEFORE = new Set([')', ']', ',', ';', '.']);
const ATTACH_AFTER_BRACE = new Set(['else', 'catch', 'finally', 'while']);
const ATTACH_AFTER_CLOSE = new Set([';', ',', ')', ']', '.', ':', 'else', 'catch', 'finally', 'while']);

function isValueToken(token) {
  return token.type === 'ident' || token.type === 'number' || token.type === 'string'
    || token.type === 'template-literal' || token.type === 'regex';
}

function unaryContext(previous) {
  if (!previous) return true;
  if (previous.type === 'punct') return ![')', ']', '}'].includes(previous.value);
  if (previous.type === 'ident') return KEYWORDS.has(previous.value) && !['this', 'super', 'true', 'false', 'null'].includes(previous.value);
  return false;
}

function format(source) {
  const tokens = tokenizeOpaque(source);
  assertLossless(source, tokenize(source));

  const lines = [];
  let line = '';
  let indent = 0;
  let parens = 0;
  let previous = null;

  const newline = () => { lines.push(line.replace(/\s+$/, '')); line = '  '.repeat(indent); };

  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    const value = token.value;

    if (token.type === 'linecomment' || token.type === 'blockcomment') {
      if (line.trim() !== '') newline();
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      line = '  '.repeat(indent) + value;
      newline();
      previous = null;
      return;
    }

    // 顶层函数之间空一行
    if (indent === 0 && line.trim() === '' && (value === 'function' || (value === 'async' && next && next.value === 'function'))) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    }

    const closingBrace = value === '}';
    if (closingBrace) {
      indent = Math.max(0, indent - 1);
      if (line.trim() !== '') newline();
      else line = '  '.repeat(indent);
    }

    // 空格决策（行首只有缩进时不加前导空格）
    if (line.trim() !== '' && previous) {
      const prevValue = previous.value;
      let space = true;
      if (NO_SPACE_BEFORE.has(value)) space = false;
      else if (NO_SPACE_AFTER.has(prevValue)) space = false;
      else if (value === '(' || value === '[') {
        // `foo(` / `a[0]` 紧贴；`if (` / `: [` / `= [` 留空格
        if (KEYWORDS.has(prevValue)) space = true;
        else if (isValueToken(previous) || prevValue === ')' || prevValue === ']') space = false;
        else space = true;
      }
      else if (value === ':' && prevValue !== '?') space = false;
      else if ((prevValue === '+' || prevValue === '-') && BINARY.has(prevValue)) space = !unaryContext(tokens[index - 2]);
      else if (BINARY.has(value)) space = true;
      if (!space) line = line.replace(/\s+$/, '');
      if (space) line += ' ';
    }

    line += value;
    previous = token;

    if (value === '(' || value === '[') parens++;
    if (value === ')' || value === ']') parens = Math.max(0, parens - 1);

    if (value === '{') {
      if (next && next.value === '}') return; // 空块 `{}` 保持一行
      indent++;
      newline();
    } else if (value === ';' && parens === 0) {
      newline();
    } else if (closingBrace) {
      if (!(next && ATTACH_AFTER_CLOSE.has(next.value))) newline();
    }
  });

  if (line.trim() !== '') lines.push(line.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

/** 断言两份代码的 token 流完全一致（注释与空白不参与比较）。 */
function assertSameTokens(a, b) {
  const strip = src => tokenizeOpaque(src)
    .filter(token => token.type !== 'linecomment' && token.type !== 'blockcomment')
    .map(token => token.value);
  const left = strip(a);
  const right = strip(b);
  if (left.length !== right.length) throw new Error(`token 数量不同：${left.length} vs ${right.length}`);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) throw new Error(`第 ${i} 个 token 不同：${JSON.stringify(left[i])} vs ${JSON.stringify(right[i])}`);
  }
  return left.length;
}

module.exports = { format, assertSameTokens };

if (require.main === module) {
  const target = path.resolve(process.argv[2] || '');
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  const source = fs.readFileSync(target, 'utf8');
  const output = format(source);
  const count = assertSameTokens(source, output);
  if (check) {
    console.log(`${target}：token 流一致（${count} 个 token）`);
  } else if (write) {
    fs.writeFileSync(target, output);
    console.log(`${target}：已排版，token 流一致（${count} 个 token），${source.split('\n').length} 行 -> ${output.split('\n').length} 行`);
  } else {
    process.stdout.write(output);
  }
}
