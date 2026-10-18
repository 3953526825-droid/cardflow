'use strict';
/*
 * 单元测试：检索结果清洗规则、偏好站点排序。
 * 直接 require server.js（不监听端口，因为 require.main !== module）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// require 之前先把配置指向临时文件，绝不读真实 config.json
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-unit-'));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ token: 'unit-test-token' }));
process.env.ANKI_CONFIG = path.join(tmp, 'config.json');

const { cleanSearchResults, rankByDomains } = require('../src/server.js');

const GOOD = '细胞膜由磷脂双分子层构成，具有流动镶嵌模型的结构特征，这是通用制卡必修一的重要内容，也是高考高频考点，需要完整掌握。'.repeat(2);
const TABLE_PREFIX = '细胞膜的结构与功能对照表，磷脂双分子层与蛋白质的分布比较说明，以及物质运输方式的差异。';

function makeItem(over = {}) {
  return { url: 'https://example.com/a', title: '标题', content: GOOD, ...over };
}

test('cleanSearchResults：正常内容保留，并按偏好站点加 ★ 与来源域名', () => {
  const { results, dropped } = cleanSearchResults([makeItem({ url: 'https://www.zhihu.com/question/1', title: '知乎回答' })]);
  assert.equal(dropped, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, '★ zhihu.com · 知乎回答');
  assert.equal(results[0].url, 'https://www.zhihu.com/question/1');
});

test('cleanSearchResults：非偏好站点不加 ★', () => {
  const { results } = cleanSearchResults([makeItem({ url: 'https://unknown-blog.example.net/x', title: '普通站' })]);
  assert.equal(results[0].title, 'unknown-blog.example.net · 普通站');
  assert.ok(!results[0].title.startsWith('★'));
});

test('cleanSearchResults：PDF 二进制被丢弃，普通正文保留', () => {
  const pdf = cleanSearchResults([makeItem({ content: '%PDF-1.4 5 0 obj 流数据 endobj xref 表格' })]);
  assert.equal(pdf.results.length, 0);
  assert.equal(pdf.dropped, 1);

  const ok = cleanSearchResults([makeItem({ content: `${GOOD}（含 PDF 这个词但正文正常）` })]);
  assert.equal(ok.results.length, 1);
});

test('cleanSearchResults：表格标记（竖线 >= 6 条）被丢弃，5 条保留', () => {
  const many = cleanSearchResults([makeItem({ content: `${TABLE_PREFIX}${'|单元格'.repeat(6)}` })]);
  assert.equal(many.results.length, 0, '竖线 6 条应被丢弃');
  assert.equal(many.dropped, 1);

  const few = cleanSearchResults([makeItem({ content: `${TABLE_PREFIX}${'|单元格'.repeat(5)}` })]);
  assert.equal(few.results.length, 1, '竖线 5 条应保留');
});

test('cleanSearchResults：符号占比过高被丢弃（不含竖线，只触发比例规则）', () => {
  const noisy = cleanSearchResults([makeItem({ content: '{}[]\\/==++**__~~`#'.repeat(3) })]);
  assert.equal(noisy.results.length, 0);
  assert.equal(noisy.dropped, 1);

  const clean = cleanSearchResults([makeItem({ content: `${TABLE_PREFIX}结构清晰，没有多余符号。` })]);
  assert.equal(clean.results.length, 1);
});

test('cleanSearchResults：导航噪声（>= 3 个）被丢弃，2 个保留', () => {
  const noisy = cleanSearchResults([makeItem({ content: `首页 登录 注册 ${GOOD}` })]);
  assert.equal(noisy.results.length, 0);

  const ok = cleanSearchResults([makeItem({ content: `首页 登录 ${GOOD}` })]);
  assert.equal(ok.results.length, 1);
});

test('cleanSearchResults：过短内容（< 40 字）被丢弃，刚满 40 字保留', () => {
  const short = cleanSearchResults([makeItem({ content: '太短了' })]);
  assert.equal(short.results.length, 0);

  const edge = cleanSearchResults([makeItem({ content: '短'.repeat(40) })]);
  assert.equal(edge.results.length, 1);

  const below = cleanSearchResults([makeItem({ content: '短'.repeat(39) })]);
  assert.equal(below.results.length, 0);
});

test('cleanSearchResults：重复 URL 只保留第一条，空 URL 丢弃', () => {
  const { results, dropped } = cleanSearchResults([
    makeItem({ url: 'https://example.com/same', title: '第一条' }),
    makeItem({ url: 'https://example.com/same', title: '第二条' }),
    makeItem({ url: '', title: '没有链接' })
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].title.endsWith('第一条'), true);
  assert.equal(dropped, 2);
});

test('cleanSearchResults：单条正文截断到 5000 字，标题截断到 120 字', () => {
  const long = '细'.repeat(6000);
  const { results } = cleanSearchResults([makeItem({ content: long, title: '题'.repeat(300) })]);
  assert.equal(results[0].content.length, 5000);
  assert.ok(results[0].title.length <= 120);
});

test('cleanSearchResults：空白与转义换行会被折叠成单空格', () => {
  const { results } = cleanSearchResults([makeItem({ content: `第一行\\n\\n第二行   ${GOOD}` })]);
  assert.ok(!results[0].content.includes('\\n'));
  assert.ok(!results[0].content.includes('  '));
});

test('cleanSearchResults：非数组/空输入不报错', () => {
  assert.deepEqual(cleanSearchResults(null), { results: [], dropped: 0 });
  assert.deepEqual(cleanSearchResults([]), { results: [], dropped: 0 });
  assert.deepEqual(cleanSearchResults(undefined), { results: [], dropped: 0 });
});

test('rankByDomains：偏好站点排在前面，且不打乱其余顺序', () => {
  const items = [
    { url: 'https://a.example.net/1' },
    { url: 'https://www.zxxk.com/2' },
    { url: 'https://b.example.net/3' },
    { url: 'https://jyeoo.com/4' }
  ];
  const ranked = rankByDomains(items, ['zxxk.com', 'jyeoo.com']);
  assert.deepEqual(ranked.map(item => item.url), [
    'https://www.zxxk.com/2',
    'https://jyeoo.com/4',
    'https://a.example.net/1',
    'https://b.example.net/3'
  ]);
});
