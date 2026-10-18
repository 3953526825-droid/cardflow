'use strict';
/* 宽容解析：把 AI 返回的文本变成卡片 JSON（修 LaTeX 反斜杠、捞多个 JSON、逐卡抢救）。
   纯函数，Node（src/server.js）与安卓壳离线页共用；函数体从 src/server.js 逐字搬来。 */
(function (root) {
/** 去掉 Markdown 代码围栏与思考标签：模型很爱把 JSON 包在 ```json … ``` 里，
    或者带一段  thinking… 的思考（个别网关会把它塞进 content）。围栏直接抹掉，
    不影响后面的「找第一个 { 或 [」；正文里的反引号本来就不会出现在 JSON 里。 */
function stripWrappers(text) {
  return String(text == null ? '' : text)
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/```[a-zA-Z0-9_-]*\s*/g, '')
    .replace(/```/g, '');
}

function extractFirstJson(text) {
  const clean = stripWrappers(text);
  const objectStart = clean.indexOf('{');
  const arrayStart = clean.indexOf('[');
  // 顶层也可能是数组：学科包的提示词是用户自己写的，不一定要求 {"cards":[…] } 这层外壳，
  // 模型直接吐 [ {卡片}, {卡片} ] 时，以前只从第一个 { 开始扫，会把整份输出截成“第一张卡”
  // —— 预览就永远是 0 张（真机反馈：八张图一张卡都出不来）。数组统一包成 { cards: […] }。
  if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
    try {
      const list = extractBalanced(clean, arrayStart, '[', ']');
      if (Array.isArray(list) && list.every(item => item && typeof item === 'object' && !Array.isArray(item))) return { cards: list };
    } catch (_) { /* 数组没切出来就退回对象分支，由逐卡抢救兜底 */ }
  }
  if (objectStart < 0) throw new Error('AI 返回中没有找到 JSON 对象。');
  return extractBalanced(clean, objectStart, '{', '}');
}

/** 有些模型吐的是单引号 JSON（{'cards': …}）：JSON.parse 会在 position 1 就报
    「Expected property name or '}'」。这里把「键/值被单引号包住」这种写法修成双引号再试一次，
    只解析失败时才走这条路，不会影响正常输出。 */
function repairQuotes(raw) {
  return raw
    .replace(/([{,]\s*)'([^'\\]*)'(\s*:)/g, '$1"$2"$3')
    .replace(/:\s*'([^'\\]*)'/g, ': "$1"')
    .replace(/\\(?=["\\/bfnrtu])/g, '\\')
    .replace(/,\s*([}\]])/g, '$1');
}

/* ===== 宽容 JSON 解析器 =====
   JSON.parse 只认双引号，但模型（尤其输出中文时）经常吐：
     { “cards”: […] }              引号是全角 “ ” —— 真机那条
                                   「Expected property name or '}' in JSON at position 2」就是它
     {'cards': […] }               单引号
     {cards: […] }                 键不加引号
     {"front": "\frac{1}{2}"}       LaTeX 反斜杠没转义
     [… ,]                         尾随逗号
   这里手写一个递归下降解析器把这些都吃掉：字符串的结束符由它的开引号决定（所以卡片正文里的
   全角引号不会被误伤），不认识的转义序列原样保留（LaTeX 靠这条活下来）。
   只在 JSON.parse 失败后才走这条路，正常输出不受影响。 */
const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' };
const CLOSERS = new Set(Object.values(QUOTE_PAIRS));
function lenientParse(raw) {
  const text = String(raw == null ? '' : raw);
  let i = 0;
  const fail = why => { throw new Error(`${why}（第 ${i + 1} 个字符附近）`); };
  const skip = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const readString = () => {
    const open = text[i];
    const close = QUOTE_PAIRS[open];
    if (!close) fail('这里应该是一个字符串');
    // 全角引号 / 角括号没有转义符可用，模型把「他说：“你好”」这种嵌套原样写进来是常事：
    // 这类引号按出现次数配对（同款开引号再出现一次就 +1，闭引号 -1），到 0 才算结束。
    const smart = open !== '"' && open !== "'";
    let depth = 1;
    let out = '';
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (smart && ch === open) { depth++; out += ch; i++; continue; }
      if (ch === close) { depth--; i++; if (!depth) return out; out += ch; continue; }
      if (ch === '\\') {
        const next = text[i + 1];
        i += 2;
        if (next === 'u') {
          const hex = text.slice(i, i + 4);
          if (/^[0-9a-f]{4}$/i.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; continue; }
          out += 'u'; continue;
        }
        if (next === 'n') out += '\n';
        else if (next === '\\' || next === '"' || next === "'" || next === '/') out += next;
        // \t \r \b \f 一律当 LaTeX 用（\times / \rightarrow / \begin / \frac），而不是控制字符：
        // 卡片里真正需要这两个控制符的场合几乎没有，丢掉反斜杠反而把公式搞坏。
        else out += '\\' + (next === undefined ? '' : next);
        continue;
      }
      if (ch === close) { i++; return out; }
      out += ch;
      i++;
    }
    fail('字符串没有闭合');
  };
  const readKey = () => {
    skip();
    const ch = text[i];
    if (QUOTE_PAIRS[ch]) return readString();
    const start = i;
    while (i < text.length && !/[:：]/.test(text[i]) && !/[{}\[\],，]/.test(text[i])) i++;
    const key = text.slice(start, i).trim();
    if (!key) fail('这里应该是字段名');
    return key;
  };
  const readValue = () => {
    skip();
    const ch = text[i];
    if (ch === undefined) fail('内容突然结束');
    if (ch === '{') return readObject();
    if (ch === '[') return readArray();
    if (QUOTE_PAIRS[ch]) return readString();
    const rest = text.slice(i);
    const literal = /^(true|false|null)/.exec(rest);
    if (literal) { i += literal[0].length; return literal[0] === 'null' ? null : literal[0] === 'true'; }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) { i += number[0].length; return Number(number[0]); }
    fail('这里应该是一个值');
  };
  const readObject = () => {
    const out = {};
    i++;
    skip();
    if (text[i] === '}') { i++; return out; }
    for (;;) {
      skip();
      if (text[i] === '}') { i++; return out; }            // 尾随逗号
      const key = readKey();
      skip();
      if (!/[:：]/.test(text[i] || '')) fail('字段名后面少了冒号');
      i++;
      out[key] = readValue();
      skip();
      if (text[i] === ',' || text[i] === '，') { i++; continue; }
      if (text[i] === '}') { i++; return out; }
      fail('对象里少了逗号或右括号');
    }
  };
  const readArray = () => {
    const out = [];
    i++;
    skip();
    if (text[i] === ']') { i++; return out; }
    for (;;) {
      skip();
      if (text[i] === ']') { i++; return out; }
      out.push(readValue());
      skip();
      if (text[i] === ',' || text[i] === '，') { i++; continue; }
      if (text[i] === ']') { i++; return out; }
      fail('数组里少了逗号或右括号');
    }
  };
  const value = readValue();
  skip();
  return value;
}

/** 一次解析：先按标准 JSON，失败就依次试「单引号修复」和「宽容解析器」。 */
function parseLenient(raw) {
  try { return JSON.parse(raw); } catch (error) {
    const repaired = repairQuotes(raw);
    if (repaired !== raw) { try { return JSON.parse(repaired); } catch (_) {} }
    try { return lenientParse(raw); } catch (_) { throw error; }
  }
}

function extractBalanced(text, start, open, close) {
  const pairs = { '{': '}', '[': ']' };
  const stack = [];
  let quote = null, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (QUOTE_PAIRS[ch]) { quote = QUOTE_PAIRS[ch]; continue; }
    if (CLOSERS.has(ch)) continue;          // 落单的右引号（中文正文）不影响括号配对
    if (ch === '{' || ch === '[') { stack.push(pairs[ch]); continue; }
    if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) throw new Error('AI 返回的 JSON 括号不配对。');
      if (!stack.length) {
        const raw = text.slice(start, i + 1);
        return parseLenient(raw);
      }
    }
  }
  throw new Error('AI 返回的 JSON 不完整。');
}

function salvageCards(text) {
  const found = [];
  const stack = [];
  let quote = null, escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (QUOTE_PAIRS[ch]) { quote = QUOTE_PAIRS[ch]; continue; }
    if (ch === '{' || ch === '[') { stack.push({ ch, i }); continue; }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if (!open || (ch === '}' ? open.ch !== '{' : open.ch !== '[')) { stack.length = 0; continue; }
      if (ch !== '}') continue;
      try {
        const obj = parseLenient(text.slice(open.i, i + 1));
        if (obj && typeof obj === 'object') {
          if (obj.type) found.push(obj);
          else if (Array.isArray(obj.cards)) found.push(...obj.cards.filter(card => card && card.type));
        }
      } catch (_) { /* 这一段生成坏了，跳过它继续扫后面的 */ }
    }
  }
  const seen = new Set();
  const out = [];
  for (const card of found) {
    const key = JSON.stringify([card.type, card.front || '', card.text || '', card.back || '']);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
}

/**
 * 填空题的字段名归一：Anki 的 Cloze 只有一个字段，本程序统一放 `text`；
 * 但模型（尤其提示词里没写死字段名的自建学科包）经常按普通卡习惯写 `front`。
 * 真机反馈：一批 44 张里 12 张填空卡全被判「填空卡缺少文本」→ 整批导入失败。
 * 这里把「带 {{c1::…}} 的 front」搬进 text，两种写法都能用；已经正确的卡不动。
 */
/* LaTeX 被控制字符吃掉的还原。模型写 "\frac{1}{2}" 时，这一串在**合法 JSON** 里就是
   换页符 + rac —— JSON.parse 成功，但公式毁了（旧实现只在解析失败时才修反斜杠，根本拦不住）。
   还原规则：换页符 / 退格符一律当 LaTeX；制表符与回车只有后面紧跟字母时才当 LaTeX
   （\times / \theta / \text、\rightarrow / \rho），后面是换行或其它字符时保留原意。 */
function repairLatex(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\f/g, '\\f')
      .replace(/[\b]/g, '\\b')
      .replace(/\t(?=[A-Za-z])/g, '\\t')
      .replace(/\r(?=[A-Za-z])/g, '\\r');
  }
  if (Array.isArray(value)) return value.map(repairLatex);
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = repairLatex(value[key]);
    return value;
  }
  return value;
}

function coerceCards(cards) {
  if (!Array.isArray(cards)) return cards;
  cards.forEach(card => {
    if (!card || typeof card !== 'object') return;
    repairLatex(card);
    if (card.type !== 'cloze') return;
    const text = typeof card.text === 'string' ? card.text.trim() : '';
    if (text) return;
    const candidate = [card.front, card.back, card.question].find(value => typeof value === 'string' && /\{\{c1::/.test(value));
    if (candidate) card.text = candidate;
  });
  return cards;
}

/**
 * 统一成 { cards: […] }：
 *   - 顶层直接是数组 → 包起来；
 *   - 外壳字段名不一样（{"data":[…]} / {"notes":[…]} / {"result":{"cards":[…]}}）→ 只要那一串像卡片就认；
 *   - 认不出来的原样返回，让调用方自己判定“ 0 张”。
 * 保证不抛异常：它在预览、导入、导出几条路上都被调用。
 */
function normalizeCards(data) {
  if (Array.isArray(data)) return { cards: coerceCards(data) };
  if (!data || typeof data !== 'object') return { cards: [] };
  if (Array.isArray(data.cards)) return Object.assign(data, { cards: coerceCards(data.cards) });
  const looksLikeCard = item => Boolean(item) && typeof item === 'object' && !Array.isArray(item) && (item.type || item.front || item.text);
  const candidates = [];
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) candidates.push(value);
    else if (value && typeof value === 'object' && Array.isArray(value.cards)) candidates.push(value.cards);
  }
  const found = candidates.find(list => list.length && list.every(looksLikeCard));
  return found ? Object.assign({}, data, { cards: coerceCards(found) }) : data;
}

/** 「第 2 个字符附近是 ……」：解析失败时把人话和现场一起报出来，不再只甩一个 position。 */
function describeParseFailure(text, error) {
  const clean = stripWrappers(text);
  const position = Number((/(?:at|in) position (\d+)/i.exec(String(error && error.message)) || [])[1]);
  if (!Number.isFinite(position) || !clean) return '';
  const around = clean.slice(Math.max(0, position - 6), position + 10).replace(/\s+/g, ' ');
  const charAt = clean[position] || '';
  return `第 ${position + 1} 个字符附近是「${around}」${charAt ? `（出错字符「${charAt}」）` : ''}`;
}

function parseGeneratedJson(text) {
  let data;
  try {
    data = extractFirstJson(text);
  } catch (error) {
    const cards = salvageCards(stripWrappers(text));
    if (!cards.length) {
      const detail = describeParseFailure(text, error) || String(error.message || '').replace(/[。.]+$/, '');
      const head = stripWrappers(text).trim().slice(0, 60).replace(/\s+/g, ' ');
      const hint = /“|”|‘|’/.test(String(text)) ? '；看起来模型用了中文全角引号' : '';
      throw new Error(`模型返回的不是可用的卡片 JSON：${detail}${hint}。原始回复开头：${head || '（空）'}`);
    }
    console.log(`[salvage] 整体 JSON 解析失败，逐卡抢救出 ${cards.length} 张。`);
    return normalizeCards({ cards, salvaged: true });
  }
  return normalizeCards(data);
}

const api = { extractFirstJson, extractBalanced, salvageCards, normalizeCards, parseGeneratedJson, parseLenient, lenientParse, coerceCards, repairLatex, stripWrappers };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.CardFlowShared = Object.assign(root.CardFlowShared || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
