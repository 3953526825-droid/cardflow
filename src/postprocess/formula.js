'use strict';
/*
 * 公式学科专用的后处理层（从 Formula2Anki/server.js 逐行搬来，逻辑与文案逐字未改）：
 *   - 宽容解析 AI 返回：修复 LaTeX 反斜杠造成的非法 JSON、从围栏/多对象里捞出卡片
 *   - 公式式规范化：把 \\ce{...} / \\Delta H 统一成 Anki 的 MathJax mhformula 写法
 * 只有 subjects/<学科>.json 里 postprocess === 'formula' 的学科会加载并使用本文件（示例：公式规范化）。
 */

function normalizePayload(data) {
  if (Array.isArray(data)) data = { cards: data };
  if (data && (data.type === 'basic' || data.type === 'cloze')) data = { cards: [data] };
  if (data && Array.isArray(data.cards)) data.cards = data.cards.map(normalizeCard);
  return data;
}

// Provider-agnostic tolerant output layer. AI may return a full deck, one card,
// an array of cards, JSONL / several objects, fenced JSON, or LaTeX with invalid JSON escapes.
function repairJsonText(raw) {
  // Work only inside JSON strings. A single slash before LaTeX (\ce, \Delta,
  // \(, etc.) is invalid JSON; an already-valid double slash must stay untouched.
  let out = '', quote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!quote) { if (ch === '"') quote = true; out += ch; continue; }
    if (ch === '"') { quote = false; out += ch; continue; }
    if (ch === '\\') {
      let j = i; while (raw[j] === '\\') j++;
      const run = raw.slice(i, j), next = raw[j] || '';
      // Legal JSON escapes after an odd run are quote, slash, b/f/n/r/t/u.
      // Otherwise this is unescaped LaTeX: add exactly one slash.
      const legal = /["\\\\/bfnrtu]/.test(next);
      out += run + (run.length % 2 === 1 && !legal ? '\\' : '');
      i = j - 1; continue;
    }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}
function parseModelJson(raw) { return JSON.parse(repairJsonText(raw)); }
function extractJsonValues(text) {
  // Repair before scanning: otherwise an unescaped LaTeX slash can confuse quote detection.
  const source = repairJsonText(String(text).replace(/```(?:json)?/gi, '').replace(/```/g, ''));
  const values = [];
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{' && source[start] !== '[') continue;
    const stack = [], expected = { '{': '}', '[': ']' };
    let quote = false, escape = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (quote) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') quote = false; continue; }
      if (ch === '"') { quote = true; continue; }
      if (ch === '{' || ch === '[') { stack.push(expected[ch]); continue; }
      if ((ch === '}' || ch === ']') && stack.length && ch === stack[stack.length - 1]) {
        stack.pop();
        if (!stack.length) { try { values.push(JSON.parse(source.slice(start, i + 1))); start = i; break; } catch (_) { /* keep looking */ } }
      }
    }
  }
  return values;
}
// Canonical Anki formulaistry format. Do not trust an LLM to obey delimiters.
// Canonical examples: \\(\\ce{H2O(l)}\\), \\(\\Delta H = -57.3\\ \\mathrm{kJ\\,mol^{-1}}\\).
function canonicalFormula(text) {
  if (typeof text !== 'string') return text;
  const bs = String.fromCharCode(92), open = bs + '(', close = bs + ')';
  // Protect existing MathJax segments. Only normalize text outside them.
  const parts = text.split(new RegExp('(' + bs.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '\\([\\s\\S]*?' + bs.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '\\))', 'g'));
  return parts.map((part, index) => {
    if (index % 2) return part;
    let p = part;
    // Parse literal backslash commands without regex ambiguity.
    const ce = bs + 'ce';
    let at = p.indexOf(ce);
    while (at !== -1) {
      let end = at + ce.length;
      while (/\s/.test(p[end] || '')) end++;
      let formula = '';
      if (p[end] === '{') {
        const stop = p.indexOf('}', end + 1);
        if (stop !== -1) { formula = p.slice(end + 1, stop).trim(); end = stop + 1; }
      } else {
        const match = p.slice(end).match(/^[A-Z][A-Za-z0-9()^+\-]*/);
        if (match) { formula = match[0]; end += formula.length; }
      }
      if (!formula) { at = p.indexOf(ce, at + ce.length); continue; }
      p = p.slice(0, at) + open + ce + '{' + formula.replace(/\s+/g, '') + '}' + close + p.slice(end);
      at = p.indexOf(ce, at + open.length + ce.length + formula.length + 3);
    }
    // Thermoformulaistry/math fragments outside MathJax.
    p = p.replace(new RegExp(bs.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + 'Delta\\s*H', 'g'), open + bs + 'Delta H' + close);
    p = p.replace(/ΔH/g, open + bs + 'Delta H' + close);
    return p;
  }).join('');
}
/* ===== 裸公式式 → Anki mhformula：AI 常把 H2O/CO2/NaOH 直接写成纯文本，这里在预览/导入/生成时统一补成 \(\ce{...}\)。
   只在「会做公式规范化」的学科/学科包里启用（公式内置学科；学科包勾了「公式式转换」）。
   规则保守：只认「全部由合法元素符号组成」的串，且必须有数字，或命中常见无数字公式式白名单，避免误伤 USB、OK 这类普通大写串。 ===== */
const ELEMENTS = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr').split(' '));
const NO_DIGIT_FORMULAS = new Set(['HCl', 'HBr', 'HF', 'HI', 'HCN', 'NaOH', 'KOH', 'NaCl', 'KCl', 'CaO', 'MgO', 'NaF', 'CO', 'NO', 'OH', 'NH']);
const BACKSLASH = String.fromCharCode(92);
function wrapFormula(token) {
  const charge = /(\^\d*[+-]|[+-])$/.exec(token);
  const suffix = charge ? charge[1] : '';
  const core = token.slice(0, token.length - suffix.length);
  const groups = [];
  let i = 0;
  while (i < core.length) {
    const m = /^[A-Z][a-z]?/.exec(core.slice(i));
    if (!m || !ELEMENTS.has(m[0])) return null;
    i += m[0].length;
    const digits = /^\d+/.exec(core.slice(i));
    if (digits) i += digits[0].length;
    groups.push(m[0]);
  }
  if (!groups.length) return null;
  const hasDigit = /\d/.test(core);
  if (groups.length < 2 && !hasDigit) return null;                    // 单个元素符号（Mg、H）不动
  if (!hasDigit && !NO_DIGIT_FORMULAS.has(token)) return null;        // 无数字的多元素串必须白名单命中
  return BACKSLASH + '(' + BACKSLASH + 'ce{' + token + '}' + BACKSLASH + ')';
}
function convertBareFormulas(text) {
  if (typeof text !== 'string' || !text) return text;
  // 保护已经写好的 MathJax 段（\(...\)、\[...\]）与行内代码，避免在公式里重复套 \ce{}。
  const protect = /(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|`[^`]*`)/g;
  return text.split(protect).map((part, index) => {
    if (index % 2) return part;
    return part.replace(/(?<![A-Za-z0-9])((?:[A-Z][a-z]?\d*)+\^?\d*[+-]?)(?![A-Za-z0-9])/g, token => wrapFormula(token) || token);
  }).join('');
}
function normalizeCard(card) {
  if (!card || typeof card !== 'object') return card;
  const c = { ...card };
  for (const field of ['front', 'back', 'text', 'note']) c[field] = convertBareFormulas(canonicalFormula(c[field]));
  return c;
}
function normalizeGeneratedCards(text) {
  const values = extractJsonValues(text);
  if (!values.length) throw new Error('AI 返回中没有可识别的 JSON 卡片。');
  const cards = [], suggestions = [];
  for (const value of values) {
    if (Array.isArray(value)) cards.push(...value);
    else if (value && Array.isArray(value.cards)) { cards.push(...value.cards); if (Array.isArray(value.image_occlusion_suggestions)) suggestions.push(...value.image_occlusion_suggestions); }
    else if (value && (value.type === 'basic' || value.type === 'cloze')) cards.push(value);
  }
  const usable = cards.filter(c => c && ['basic', 'cloze', 'occlusion', 'audio'].includes(c.type)).map(normalizeCard);
  if (!usable.length) throw new Error('AI 返回了 JSON，但未找到 basic/cloze/occlusion/audio 卡片。');
  return { cards: usable, image_occlusion_suggestions: suggestions };
}

module.exports = { normalizePayload, repairJsonText, parseModelJson, extractJsonValues, canonicalFormula, convertBareFormulas, normalizeCard, normalizeGeneratedCards };
