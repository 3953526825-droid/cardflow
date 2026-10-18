'use strict';
/*
 * 极简 DOM + 选择器引擎 + CSS 级联裁决器（零依赖，仅用于 tests/）。
 *
 * 为什么要自己写：
 *   1) 服务端与前端都保持零依赖，测试也不引入 jsdom；
 *   2) A2 要求用「级联裁决器」验证 CSS 重构前后最终生效值完全一致，
 *      浏览器以外的工具都给不了这个断言。
 *
 * 支持范围（够用即可，不追求完整 CSS 规范）：
 *   - 选择器：类型、#id、.class、[attr]、[attr=v]、[attr*=v] 等、:not(单个复合选择器)、:has()
 *   - 组合器：后代（空格）、>、+、~
 *   - 媒体查询：@media (max-width/min-width)  ，and / 逗号
 *   - 级联：媒体查询命中 → !important → 优先级 → 源码顺序
 */

const IDENT = /^[^\s.#\[:()>+~]+/;

/* ============================ 选择器解析 ============================ */

function parseCompoundList(selector) {
  const compounds = [];
  let buf = '';
  let combinator = ' ';
  let i = 0;
  const flush = () => {
    if (!buf) return;
    compounds.push({ text: buf, combinator });
    buf = '';
    combinator = ' ';
  };
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '>' || ch === '+' || ch === '~') {
      flush();
      combinator = ch;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      let j = i;
      while (j < selector.length && /\s/.test(selector[j])) j++;
      if (j < selector.length && '>+~'.includes(selector[j])) { i = j; continue; }
      flush();
      combinator = ' ';
      i = j;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return compounds;
}

const PSEUDO_ELEMENTS = ['::before', '::after', '::marker', '::placeholder', '::selection', '::first-line'];
const PSEUDO_STATES = new Set(['hover', 'active', 'focus', 'focus-visible', 'focus-within', 'disabled', 'checked', 'target', 'visited', 'link']);

function parseCompound(text) {
  const out = { tag: null, id: '', classes: [], attrs: [], pseudos: [], pseudoElement: false, specificity: [0, 0, 0] };
  let i = 0;
  const addSpec = (a, b, c) => { out.specificity[0] += a; out.specificity[1] += b; out.specificity[2] += c; };
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '*') { i++; continue; }
    if (ch === '#') {
      i++;
      const m = IDENT.exec(text.slice(i));
      if (!m) break;
      out.id = m[0];
      i += m[0].length;
      addSpec(1, 0, 0);
      continue;
    }
    if (ch === '.') {
      i++;
      const m = IDENT.exec(text.slice(i));
      if (!m) break;
      out.classes.push(m[0]);
      i += m[0].length;
      addSpec(0, 1, 0);
      continue;
    }
    if (ch === '[') {
      const end = text.indexOf(']', i);
      const body = text.slice(i + 1, end < 0 ? text.length : end);
      const m = /^([^\s~^$*|=]+)\s*(?:([~^$*|]?=)\s*(.*))?$/.exec(body.trim());
      if (m) {
        let value = (m[3] || '').trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        out.attrs.push({ name: m[1].toLowerCase(), op: m[2] || '', value });
        addSpec(0, 1, 0);
      }
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === ':') {
      if (text[i + 1] === ':') {
        const m = IDENT.exec(text.slice(i + 2));
        i += 2 + (m ? m[0].length : 0);
        out.pseudoElement = true;
        addSpec(0, 0, 1);
        continue;
      }
      i++;
      const m = IDENT.exec(text.slice(i));
      if (!m) break;
      const name = m[0].toLowerCase();
      i += m[0].length;
      let arg = null;
      if (text[i] === '(') {
        let depth = 0, j = i;
        for (; j < text.length; j++) {
          if (text[j] === '(') depth++;
          else if (text[j] === ')') { depth--; if (!depth) break; }
        }
        arg = text.slice(i + 1, j).trim();
        i = j + 1;
      }
      out.pseudos.push({ name, arg });
      if (name === 'not' || name === 'has' || name === 'is' || name === 'where') {
        const inner = arg ? parseCompoundList(arg).map(c => parseCompound(c.text)) : [];
        let best = [0, 0, 0];
        inner.forEach(c => { if (cmpSpec(c.specificity, best) > 0) best = c.specificity; });
        addSpec(best[0], best[1], best[2]);
      } else {
        addSpec(0, 1, 0);
      }
      continue;
    }
    const m = IDENT.exec(text.slice(i));
    if (!m) break;
    out.tag = m[0].toLowerCase();
    i += m[0].length;
    addSpec(0, 0, 1);
  }
  return out;
}

function cmpSpec(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function specToString(s) { return `${s[0]},${s[1]},${s[2]}`; }

/* ============================ 选择器匹配 ============================ */

function tagOf(node) { return String(node.tag || node.tagName || '').toLowerCase(); }

function attrMatches(node, attr) {
  if (!node.hasAttribute(attr.name)) return false;
  if (!attr.op) return true;
  const value = String(node.getAttribute(attr.name) == null ? '' : node.getAttribute(attr.name));
  const target = attr.value;
  switch (attr.op) {
    case '=': return value === target;
    case '*=': return value.includes(target);
    case '^=': return value.startsWith(target);
    case '$=': return value.endsWith(target);
    case '~=': return value.split(/\s+/).includes(target);
    case '|=': return value === target || value.startsWith(target + '-');
    default: return false;
  }
}

function compoundMatches(compound, node) {
  if (!node) return false;
  if (compound.tag && compound.tag !== tagOf(node)) return false;
  if (compound.id && compound.id !== node.id) return false;
  for (const cls of compound.classes) {
    const list = node.classList;
    if (!list || !list.contains(cls)) return false;
  }
  for (const attr of compound.attrs) if (!attrMatches(node, attr)) return false;
  if (compound.pseudoElement) return false;
  for (const pseudo of compound.pseudos) {
    if (pseudo.name === 'not') {
      if (!pseudo.arg) continue;
      const inner = parseCompoundList(pseudo.arg);
      if (inner.length === 1 && compoundMatches(parseCompound(inner[0].text), node)) return false;
      continue;
    }
    if (pseudo.name === 'has') {
      if (!node.querySelector) return false;
      if (!pseudo.arg || !node.querySelector(pseudo.arg)) return false;
      continue;
    }
    if (pseudo.name === 'root') { if (node.parentElement) return false; continue; }
    if (PSEUDO_STATES.has(pseudo.name)) {
      // 合成探针可以声明自己处于 :hover / :disabled 等状态，用于对比这些规则的最终值
      if (!(node._pseudoStates && node._pseudoStates.has(pseudo.name))) return false;
      continue;
    }
    return false; // 未支持的伪类（如 :has 的复杂用法）一律视为不匹配，前后对比口径一致
  }
  return true;
}

function selectorSpecificity(selector) {
  const total = [0, 0, 0];
  for (const compound of parseCompoundList(selector)) {
    const spec = parseCompound(compound.text).specificity;
    total[0] += spec[0]; total[1] += spec[1]; total[2] += spec[2];
  }
  return total;
}

/** 目标元素之前的兄弟节点，最近的在前。探针节点用 _prev 描述，真实 DOM 节点走 parentElement。 */
function previousSiblings(node) {
  if (Array.isArray(node._prev)) return [...node._prev].reverse();
  const parent = node.parentElement;
  if (!parent) return [];
  const idx = parent.children.indexOf(node);
  return idx <= 0 ? [] : parent.children.slice(0, idx).reverse();
}

function prevElementSibling(node) {
  const list = previousSiblings(node);
  return list.length ? list[0] : null;
}

/** parseCompoundList 给出的是 { text, combinator }，这里缓存解析后的复合选择器。 */
function asCompound(item) {
  if (!item.parsed) item.parsed = parseCompound(item.text);
  return item.parsed;
}

function matchFrom(compounds, idx, node) {
  if (idx < 0) return true;
  if (!compoundMatches(asCompound(compounds[idx]), node)) return false;
  if (idx === 0) return true;
  const comb = compounds[idx].combinator;
  if (comb === '>') return node.parentElement ? matchFrom(compounds, idx - 1, node.parentElement) : false;
  if (comb === ' ') {
    let parent = node.parentElement;
    while (parent) { if (matchFrom(compounds, idx - 1, parent)) return true; parent = parent.parentElement; }
    return false;
  }
  if (comb === '+') { const prev = prevElementSibling(node); return prev ? matchFrom(compounds, idx - 1, prev) : false; }
  if (comb === '~') {
    for (const prev of previousSiblings(node)) if (matchFrom(compounds, idx - 1, prev)) return true;
    return false;
  }
  return false;
}

function matchesSelector(node, selector) {
  for (const part of String(selector).split(',')) {
    const text = part.trim();
    if (!text) continue;
    const compounds = parseCompoundList(text);
    if (compounds.length && matchFrom(compounds, compounds.length - 1, node)) return true;
  }
  return false;
}

/* ============================ 极简 DOM ============================ */

const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source']);

class ClassList {
  constructor(element) { this.element = element; }
  _set() { return new Set(String(this.element.className || '').split(/\s+/).filter(Boolean)); }
  _write(set) { this.element.className = [...set].join(' '); }
  add(...names) { const s = this._set(); names.forEach(n => s.add(n)); this._write(s); }
  remove(...names) { const s = this._set(); names.forEach(n => s.delete(n)); this._write(s); }
  contains(name) { return this._set().has(name); }
  toggle(name, force) {
    const s = this._set();
    const want = force === undefined ? !s.has(name) : Boolean(force);
    if (want) s.add(name); else s.delete(name);
    this._write(s);
    return want;
  }
}

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument || null;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList(this);
    this._className = '';
    this._text = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.title = '';
    this.id = '';
    this._listeners = {};
  }
  get tag() { return this.tagName.toLowerCase(); }
  get className() { return this._className; }
  set className(value) { this._className = String(value == null ? '' : value); }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }
  set textContent(value) { this.children = []; this._text = String(value == null ? '' : value); }
  get innerHTML() { return this._innerHTML || ''; }
  set innerHTML(value) { this.children = []; this._text = ''; this._innerHTML = String(value == null ? '' : value); parseHTMLInto(this, this._innerHTML); }
  append(...nodes) { nodes.forEach(node => this._append(node)); }
  appendChild(node) { this._append(node); return node; }
  _append(node) {
    const child = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
    if (!child) return;
    child.parentElement = this;
    this.children.push(child);
  }
  _insert(node, reference, after) {
    const child = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
    child.parentElement = this;
    const idx = this.children.indexOf(reference);
    const at = idx < 0 ? this.children.length : (after ? idx + 1 : idx);
    this.children.splice(at, 0, child);
  }
  before(node) { if (this.parentElement) this.parentElement._insert(node, this, false); }
  after(node) { if (this.parentElement) this.parentElement._insert(node, this, true); }
  remove() { if (this.parentElement) { const i = this.parentElement.children.indexOf(this); if (i >= 0) this.parentElement.children.splice(i, 1); this.parentElement = null; } }
  setAttribute(name, value) { this.attributes[String(name)] = String(value); }
  getAttribute(name) {
    name = String(name);
    if (Object.prototype.hasOwnProperty.call(this.attributes, name)) return this.attributes[name];
    if (name.startsWith('data-')) {
      const key = dataKey(name);
      if (Object.prototype.hasOwnProperty.call(this.dataset, key)) return String(this.dataset[key]);
    }
    const direct = this[name];
    if (typeof direct === 'string') return direct;
    return null;
  }
  hasAttribute(name) {
    name = String(name);
    if (Object.prototype.hasOwnProperty.call(this.attributes, name)) return true;
    if (name.startsWith('data-')) return Object.prototype.hasOwnProperty.call(this.dataset, dataKey(name));
    return typeof this[name] === 'string';
  }
  querySelector(selector) { const all = this.querySelectorAll(selector); return all.length ? all[0] : null; }
  querySelectorAll(selector) {
    const list = String(selector).split(',').map(s => s.trim()).filter(Boolean);
    const found = [];
    const walk = node => {
      node.children.forEach(child => {
        if (list.some(sel => matchesSelector(child, sel))) found.push(child);
        walk(child);
      });
    };
    walk(this);
    return found;
  }
  matches(selector) { return matchesSelector(this, selector); }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { const list = this._listeners[type] || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
  dispatch(type, event = {}) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    (this._listeners[type] || []).forEach(fn => fn(ev));
    const inline = this['on' + type];
    if (typeof inline === 'function') inline(ev);
    return ev;
  }
  click() { return this.dispatch('click'); }
  focus() {}
  scrollIntoView() {}
  getContext() { return { fillRect() {}, drawImage() {}, fillStyle: '', imageSmoothingEnabled: false, imageSmoothingQuality: '' }; }
  toDataURL() { return 'data:image/jpeg;base64,AAAA'; }
}

function dataKey(name) { return name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

class TextNode {
  constructor(text) { this.nodeValue = String(text); this.children = []; this.parentElement = null; }
  get textContent() { return this.nodeValue; }
  set textContent(value) { this.nodeValue = String(value); }
}

function parseHTMLInto(root, html) {
  const TOKEN = /<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const stack = [root];
  let last = 0;
  let match;
  const pushText = text => {
    const decoded = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (decoded.trim()) stack[stack.length - 1]._append(root.ownerDocument.createTextNode(decoded));
  };
  while ((match = TOKEN.exec(html))) {
    pushText(html.slice(last, match.index));
    last = TOKEN.lastIndex;
    const tag = match[1].toLowerCase();
    if (match[0][1] === '/') {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      continue;
    }
    const element = root.ownerDocument.createElement(tag);
    const attrs = match[2] || '';
    const ATTR = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = ATTR.exec(attrs))) {
      const value = a[2] ?? a[3] ?? a[4] ?? '';
      element.setAttribute(a[1], value);
      if (a[1] === 'class') element.className = value;
      else if (a[1] === 'id') element.id = value;
      else element[a[1]] = value;
    }
    stack[stack.length - 1]._append(element);
    if (!VOID_TAGS.has(tag) && !match[0].endsWith('/>')) stack.push(element);
  }
  pushText(html.slice(last));
}

class Document {
  constructor(options = {}) {
    // cookie 罐：测试可以给两个环境传同一个对象，模拟「同域名不同端口共享 cookie」
    this._cookies = options.cookies || {};
    this._byId = new Map();
    this.body = this.createElement('body');
    this.documentElement = this.createElement('html');
    this.documentElement.append(this.body);
  }
  /** 简版 cookie：只支持 name=value 与 max-age=0（删除），够 app.js 用。 */
  get cookie() {
    return Object.entries(this._cookies).map(([name, value]) => `${name}=${value}`).join('; ');
  }
  set cookie(text) {
    const [pair, ...attrs] = String(text || '').split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attrs.some(attr => /^\s*max-age\s*=\s*0\s*$/i.test(attr));
    if (!value || expired) delete this._cookies[name];
    else this._cookies[name] = value;
  }
  createElement(tag) { return new Element(tag, this); }
  createTextNode(text) { return new TextNode(text); }
  getElementById(id) {
    if (!this._byId.has(id)) {
      const el = this.createElement('div');
      el.id = id;
      this._byId.set(id, el);
    }
    return this._byId.get(id);
  }
  querySelector(selector) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  addEventListener() {}
}

function createDocument(options = {}) { return new Document(options); }

function installById(document, id, element) { element.id = id; document._byId.set(id, element); return element; }

function createLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => { map.set(String(key), String(value)); },
    removeItem: key => { map.delete(String(key)); },
    clear: () => map.clear(),
    get length() { return map.size; },
    _map: map
  };
}

/* ============================ CSS 级联裁决器 ============================ */

function splitRules(css) {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (css.startsWith('/*', i)) { const end = css.indexOf('*/', i + 2); i = end < 0 ? css.length : end + 2; continue; }
    if (i >= css.length) break;
    const start = i;
    while (i < css.length && css[i] !== '{' && css[i] !== ';') i++;
    if (i >= css.length) break;
    if (css[i] === ';') { i++; continue; }
    const prelude = css.slice(start, i).trim();
    let j = i + 1, level = 1;
    while (j < css.length && level > 0) {
      if (css[j] === '{') level++;
      else if (css[j] === '}') level--;
      j++;
    }
    rules.push({ prelude, body: css.slice(i + 1, j - 1) });
    i = j;
  }
  return rules;
}

function parseDeclarations(body) {
  const out = [];
  for (const chunk of String(body).split(';')) {
    const text = chunk.trim();
    if (!text) continue;
    const idx = text.indexOf(':');
    if (idx < 0) continue;
    const property = text.slice(0, idx).trim().toLowerCase();
    let value = text.slice(idx + 1).trim();
    let important = false;
    if (/!\s*important$/i.test(value)) { important = true; value = value.replace(/!\s*important$/i, '').trim(); }
    out.push({ property, value, important });
  }
  return out;
}

function mediaMatches(query, width) {
  const text = String(query).replace(/^@media/i, '').trim();
  if (!text) return true;
  return text.split(',').some(part =>
    part.split(/\band\b/i).map(s => s.trim()).filter(Boolean).every(cond => {
      const m = /^\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)$/.exec(cond);
      if (m) return m[1] === 'max' ? width <= Number(m[2]) : width >= Number(m[2]);
      return true; // 其他媒体特性（prefers-* 等）按“命中”处理，前后对比口径一致
    })
  );
}

function flattenRules(rules, media, out) {
  for (const rule of rules) {
    if (rule.prelude.startsWith('@media')) {
      flattenRules(splitRules(rule.body), media.concat(rule.prelude), out);
      continue;
    }
    if (rule.prelude.startsWith('@')) continue; // @keyframes / @font-face 等不参与级联
    out.push({ selectors: rule.prelude.split(',').map(s => s.trim()).filter(Boolean), decls: parseDeclarations(rule.body), media });
  }
  return out;
}

function compileCss(cssText) {
  const flat = flattenRules(splitRules(cssText), [], []);
  return flat.map((rule, index) => ({ ...rule, index }));
}

/** 取某个声明的最终生效值（含 !important / 优先级 / 源码顺序裁决）。 */
function resolveDeclaration(compiled, node, property, width) {
  property = property.toLowerCase();
  let winner = null;
  for (const rule of compiled) {
    if (rule.media.length && !rule.media.every(q => mediaMatches(q, width))) continue;
    const compoundSelectors = rule.selectors.map(sel => ({ sel, compounds: parseCompoundList(sel) }));
    const matched = compoundSelectors.filter(item => item.compounds.length && matchFrom(item.compounds, item.compounds.length - 1, node));
    if (!matched.length) continue;
    let decl = null;
    for (const d of rule.decls) if (d.property === property) decl = d; // 同一条规则内后面的声明覆盖前面的
    if (!decl) continue;
    // 一条规则的选择器列表里，命中且优先级最高的那个决定本条规则的优先级
    let spec = [0, 0, 0];
    for (const item of matched) {
      const current = selectorSpecificity(item.sel);
      if (cmpSpec(current, spec) > 0) spec = current;
    }
    const candidate = { value: decl.value, important: decl.important, spec, order: rule.index };
    if (!winner) { winner = candidate; continue; }
    if (candidate.important !== winner.important) { if (candidate.important) winner = candidate; continue; }
    const cmp = cmpSpec(candidate.spec, winner.spec);
    if (cmp > 0 || (cmp === 0 && candidate.order >= winner.order)) winner = candidate;
  }
  return winner ? winner.value : undefined;
}

/** 只看某条规则的选择器是否命中（用于快照里列出所有相关属性）。 */
function matchingProperties(compiled, node, width) {
  const props = new Set();
  for (const rule of compiled) {
    if (rule.media.length && !rule.media.every(q => mediaMatches(q, width))) continue;
    const hit = rule.selectors.some(sel => {
      const compounds = parseCompoundList(sel);
      return compounds.length && matchFrom(compounds, compounds.length - 1, node);
    });
    if (hit) rule.decls.forEach(d => props.add(d.property));
  }
  return [...props].sort();
}

/** 解析 index.html 里的 <style> 内容（多段拼接，保持源码顺序）。 */
function extractStyles(html) {
  const out = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out.join('\n');
}

/* ============================ 探针（用于 CSS 快照） ============================ */

function makeProbeNode(descriptor) {
  const spec = typeof descriptor === 'string' ? { el: descriptor } : descriptor;
  const classes = [];
  let tag = null, id = '';
  const attrs = { ...(spec.attrs || {}) };
  const text = String(spec.el || 'div');
  const re = /([.#]?)([^\s.#\[:]+)|\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[3] !== undefined) {
      const raw = m[3].trim();
      const eq = raw.indexOf('=');
      if (eq < 0) attrs[raw] = '';
      else {
        const name = raw.slice(0, eq).trim().replace(/[~^$*|]$/, '');
        attrs[name] = raw.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      }
      continue;
    }
    if (m[1] === '#') id = m[2];
    else if (m[1] === '.') classes.push(m[2]);
    else tag = m[2].toLowerCase();
  }
  return {
    tag, id, classes, attrs,
    classList: { contains: name => classes.includes(name) },
    hasAttribute: name => Object.prototype.hasOwnProperty.call(attrs, name),
    getAttribute: name => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    _pseudoStates: new Set(spec.pseudos || []),
    _prev: (spec.prev || []).map(makeProbeNode)
  };
}

/** 把「从根到目标的描述链」转成可用于选择器匹配的节点。 */
function probeFromPath(path) {
  let node = null;
  for (const descriptor of path) {
    const current = makeProbeNode(descriptor);
    current.parentElement = node;
    // 前一个兄弟与目标同父，否则 ...+target 这类选择器无法继续向左匹配
    current._prev.forEach(prev => { prev.parentElement = node; });
    node = current;
  }
  return node;
}

module.exports = {
  ClassList, Element, Document, createDocument, installById, createLocalStorage, parseHTMLInto,
  parseCompoundList, parseCompound, selectorSpecificity, matchesSelector, compoundMatches, matchFrom,
  previousSiblings, cmpSpec, specToString,
  compileCss, resolveDeclaration, matchingProperties, splitRules, parseDeclarations, mediaMatches,
  extractStyles, makeProbeNode, probeFromPath
};
