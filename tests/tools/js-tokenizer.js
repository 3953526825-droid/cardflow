'use strict';
/*
 * 极简 JS 词法器（零依赖）：只用于「解压压缩代码」与「证明解压前后 token 流完全一致」。
 * 支持：行/块注释、单双引号字符串、模板字符串（含 ${} 嵌套）、正则字面量、数字、标识符、运算符。
 *
 * 自检：每个 token 记录首尾偏移，相邻 token 之间的空隙必须全是空白字符；
 *       只要词法判断错了一处（例如把正则当成除号），空隙里就会残留非空白字符，立刻报错。
 */

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const OPERATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '**', '<<', '>>', '::',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.'
];

function isIdentStart(ch) { return IDENT_START.test(ch) || ch.charCodeAt(0) > 127; }
function isIdentPart(ch) { return IDENT_PART.test(ch) || ch.charCodeAt(0) > 127; }

/** 正则能否出现在这里：前一个有效 token 不是标识符/数字/字符串/`)`/`]` 时，`/` 才可能是正则。 */
function regexAllowed(previous) {
  if (!previous) return true;
  if (previous.type === 'ident') return ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'case', 'yield', 'await'].includes(previous.value);
  if (previous.type === 'number' || previous.type === 'string' || previous.type === 'template' || previous.type === 'regex') return false;
  if (previous.type === 'punct') return ![')', ']', '}'].includes(previous.value);
  return true;
}

function tokenize(source) {
  const tokens = [];
  const stack = [{ kind: 'code', braces: 0 }];
  let i = 0;
  let previous = null;

  const push = (type, start, end) => {
    const token = { type, value: source.slice(start, end), start, end };
    tokens.push(token);
    if (type !== 'linecomment' && type !== 'blockcomment') previous = token;
    return token;
  };

  while (i < source.length) {
    const state = stack[stack.length - 1];
    const ch = source[i];

    if (state.kind === 'template') {
      const start = state.start != null ? state.start : i;
      state.start = null;
      let j = i;
      let closed = false;
      let interpolation = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '`') { j += 1; closed = true; break; }
        if (c === '$' && source[j + 1] === '{') { j += 2; interpolation = true; break; }
        j++;
      }
      push('template', start, j);
      i = j;
      if (interpolation) { stack.push({ kind: 'code', braces: 0, fromTemplate: true }); previous = null; }
      else stack.pop();
      continue;
    }

    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      push('linecomment', i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      push('blockcomment', i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) { if (source[j] === '\\') j++; j++; }
      j = Math.min(j + 1, source.length);
      push('string', i, j);
      i = j;
      continue;
    }
    if (ch === '`') { stack.push({ kind: 'template', start: i }); i++; continue; }
    if (ch === '/' && regexAllowed(previous)) {
      let j = i + 1, inClass = false, ok = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (inClass) { if (c === ']') inClass = false; }
        else if (c === '[') inClass = true;
        else if (c === '/') { ok = true; j++; break; }
        j++;
      }
      if (ok) {
        while (j < source.length && /[a-z]/.test(source[j])) j++;
        push('regex', i, j);
        i = j;
        continue;
      }
    }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < source.length && isIdentPart(source[j])) j++;
      push('ident', i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      let j = i;
      if (source[j] === '0' && /[xXoObB]/.test(source[j + 1] || '')) {
        j += 2;
        while (j < source.length && /[0-9a-fA-F_]/.test(source[j])) j++;
      } else {
        while (j < source.length && /[0-9_]/.test(source[j])) j++;
        if (source[j] === '.') { j++; while (j < source.length && /[0-9_]/.test(source[j])) j++; }
        if (/[eE]/.test(source[j] || '')) {
          let k = j + 1;
          if (/[+-]/.test(source[k] || '')) k++;
          if (/[0-9]/.test(source[k] || '')) { j = k; while (j < source.length && /[0-9_]/.test(source[j])) j++; }
        }
      }
      while (j < source.length && /[a-zA-Z]/.test(source[j])) j++;
      push('number', i, j);
      i = j;
      continue;
    }

    const operator = OPERATORS.find(op => source.startsWith(op, i));
    if (!operator) throw new Error(`无法识别的字符 ${JSON.stringify(ch)} @${i}`);
    if (operator === '{') state.braces++;
    if (operator === '}') {
      if (state.fromTemplate && state.braces === 0) {
        push('punct', i, i + 1); // 先把插值的收尾 } 记下来，再回到模板状态
        tokens[tokens.length - 1].interpolationEnd = true;
        stack.pop();
        i += 1;
        previous = null;
        continue;
      }
      state.braces = Math.max(0, state.braces - 1);
    }    push('punct', i, i + operator.length);
    i += operator.length;
  }
  if (stack.length !== 1) throw new Error('模板字符串没有正确闭合');
  return tokens;
}

/** 词法自检：token 之间的空隙必须全是空白。 */
function assertLossless(source, tokens = tokenize(source)) {
  let cursor = 0;
  for (const token of tokens) {
    const gap = source.slice(cursor, token.start);
    if (/\S/.test(gap)) throw new Error(`token 之间存在未识别的字符：${JSON.stringify(gap)} @${cursor}`);
    if (token.end <= token.start) throw new Error(`空 token @${token.start}`);
    cursor = token.end;
  }
  const tail = source.slice(cursor);
  if (/\S/.test(tail)) throw new Error(`文件尾部存在未识别的字符：${JSON.stringify(tail.slice(0, 40))}`);
  return true;
}

/** 把模板字符串（含 ${} 插值，可能嵌套）合并成单个不可分割的 token，排版时整段原样输出。 */
function mergeTemplateLiterals(tokens, source) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'template') { out.push(token); continue; }
    if (token.value.endsWith('`')) { // 没有插值的完整模板
      out.push({ type: 'template-literal', value: token.value, start: token.start, end: token.end });
      continue;
    }
    // 用「模板层级 + 未闭合插值数」精确跳过嵌套模板，直到最外层合上
    let levels = 1;
    let interpolations = 1;
    let j = i;
    while (j + 1 < tokens.length && levels > 0) {
      j++;
      const next = tokens[j];
      if (next.type === 'punct' && next.interpolationEnd) { interpolations = Math.max(0, interpolations - 1); continue; }
      if (next.type !== 'template') continue;
      if (next.value.length > 1 && next.value.startsWith('`') && next.value.endsWith('`')) continue; // 自成一体的嵌套模板
      if (next.value.endsWith('`')) {
        levels--;
        if (levels === 0) break;
        continue;
      }
      if (next.value.endsWith('${')) {
        if (next.value.startsWith('`')) levels++;
        interpolations++;
      }
    }
    const last = tokens[j];
    out.push({ type: 'template-literal', value: source.slice(token.start, last.end), start: token.start, end: last.end });
    i = j;
  }
  return out;
}

/** 排版与等价比较都用这个：模板字符串是一个整体，中间不能插空白。 */
function tokenizeOpaque(source) {
  return mergeTemplateLiterals(tokenize(source), source);
}

module.exports = { tokenize, tokenizeOpaque, mergeTemplateLiterals, assertLossless, regexAllowed };
