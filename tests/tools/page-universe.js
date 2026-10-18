'use strict';
/*
 * 「页面元素全集」：解析 index.html 的真实结构，并补上 app.js 动态生成的模板元素。
 * 用途：
 *   1) tools/reorganize-css.js 判断两条规则是否可能命中同一个元素（精确到真实页面，
 *      而不是保守的结构猜测），从而安全地合并重复选择器；
 *   2) tools/css-diff-report.js 逐元素、逐属性、逐断点对比两份样式表的最终生效值。
 */
const fs = require('fs');
const { createDocument, parseHTMLInto, matchesSelector } = require('../helpers/dom');

function buildPage(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const body = html.slice(html.indexOf('<body') + 5, html.indexOf('</body>'));
  const document = createDocument();
  parseHTMLInto(document.body, body);
  // html / body 标签自身的属性（例如多学科版的 data-subject）必须带上，否则 scoped 规则命中不了
  applyTagAttributes(html, 'html', document.documentElement);
  applyTagAttributes(html, 'body', document.body);
  const all = () => [document.documentElement, document.body, ...document.body.querySelectorAll('*')];
  const byId = id => all().find(el => el.id === id);

  // app.js 动态生成的元素（静态 HTML 里没有，但真实页面上会出现）
  const searchResults = byId('searchResults');
  if (searchResults) {
    const item = document.createElement('div');
    item.className = 'searchItem';
    item.dataset.enhanced = '1';
    const link = document.createElement('a');
    link.setAttribute('href', 'https://example.com/a');
    const snip = document.createElement('div');
    snip.className = 'snip';
    const expanded = document.createElement('div');
    expanded.className = 'snip expanded';
    const toggle = document.createElement('div');
    toggle.className = 'snipToggle';
    const fetchButton = document.createElement('button');
    fetchButton.className = 'secondary snipFetch';
    const addButton = document.createElement('button');
    addButton.className = 'secondary';
    item.append(link, snip, expanded, toggle, fetchButton, addButton);
    const section = document.createElement('div');
    section.className = 'sectionTitle';
    searchResults.append(item, section);
  }
  const cards = byId('cards');
  if (cards) { const card = document.createElement('div'); card.className = 'card'; cards.append(card); }
  const thumbs = byId('thumbs');
  if (thumbs) {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    const button = document.createElement('button');
    thumb.append(img, button);
    thumbs.append(thumb);
  }
  ['deckTree', 'newDeckParentTree'].forEach(id => {
    const tree = byId(id);
    if (!tree) return;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const leaf = document.createElement('button');
    leaf.className = 'leaf selected';
    details.append(summary);
    tree.append(details, leaf);
  });
  const toast = byId('toast');
  if (toast && toast.parentElement) {
    const shown = document.createElement('div');
    shown.className = 'toast show error';
    toast.parentElement.append(shown);
  }
  const model = byId('model');
  if (model) { const option = document.createElement('option'); model.append(option); }

  const elements = [];
  const walk = (el, path) => {
    elements.push({ key: path, el });
    el.children.forEach((child, index) => {
      if (!child.tagName) return;
      const label = `${child.tagName.toLowerCase()}${child.id ? '#' + child.id : ''}${child.className ? '.' + String(child.className).split(/\s+/).join('.') : ''}[${index}]`;
      walk(child, `${path} > ${label}`);
    });
  };
  walk(document.documentElement, 'html');
  return { document, elements, indexOf: new Map(elements.map((entry, index) => [entry.el, index])) };
}

/** 一组选择器在真实页面上命中的元素下标集合。 */
function matchSet(page, selectors) {
  const set = new Set();
  page.elements.forEach(({ el }, index) => {
    if (selectors.some(selector => matchesSelector(el, selector))) set.add(index);
  });
  return set;
}

/** 把某个标签自身的属性写到元素上（parseHTMLInto 只解析 body 内部，标签本身的属性要单独取）。 */
function applyTagAttributes(html, tag, element) {
  const match = new RegExp(`<${tag}\\b([^>]*)>`, 'i').exec(html);
  if (!match) return;
  const ATTR = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let attr;
  while ((attr = ATTR.exec(match[1]))) {
    const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
    element.setAttribute(attr[1], value);
    if (attr[1] === 'class') element.className = value;
    else if (attr[1] === 'id') element.id = value;
  }
}

module.exports = { buildPage, matchSet };
