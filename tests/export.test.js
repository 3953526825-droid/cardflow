'use strict';
/*
 * E1 导出测试：导出成 Anki「文本文件导入」能直接吃的制表符分隔 txt。
 *   - 字段顺序：basic → Front / Back / Tags；cloze → Text / Extra / Tags
 *   - 内容里的制表符与换行要转义，否则会错位
 *   - 关键一条：把导出结果按 Anki 的规则解析回来，必须与 /api/import 发给 AnkiConnect 的字段完全一致
 *     （也就是「导出的文件导进去 = 界面预览看到的内容」）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const { startServer } = require('./helpers/harness');
const { startFakeAnki } = require('./helpers/fakes');
const { escapeExportField } = require('../src/server.js');

const CARDS = [
  { type: 'basic', priority: 'P1', tags: ['通用制卡', '细胞'], front: '细胞膜的基本骨架是什么？', back: '磷脂双分子层', note: '' },
  { type: 'basic', priority: 'P2', tags: ['通用制卡'], front: '含制表符\t和换行\n的正面', back: '背面第一行\n背面第二行', note: '这是备注' },
  { type: 'cloze', priority: 'P1', tags: ['通用制卡'], text: '细胞膜具有{{c1::选择透过性}}', note: '备注里有\t制表符' },
  { type: 'cloze', priority: 'P2', tags: [], text: '第一行\n第二行 {{c1::答案}}', note: '' }
];

const ctx = {};

before(async () => {
  ctx.anki = await startFakeAnki(['Default', '生物::细胞膜']);
  ctx.server = await startServer({ subject: 'demo', ankiUrl: ctx.anki.url, config: { apiKey: 'k', model: 'm', tavilyKey: 't' } });
});

after(async () => {
  if (ctx.server) await ctx.server.stop();
  if (ctx.anki) await ctx.anki.close();
});

async function exportText(type) {
  const response = await fetch(`${ctx.server.base}/api/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anki-token': ctx.server.token },
    body: JSON.stringify({ cards: CARDS, type })
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

test('导出普通卡：字段顺序 Front / Back / Tags，带 Content-Disposition 文件名', async () => {
  const result = await exportText('basic');
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type'), /text\/tab-separated-values/);
  assert.match(result.headers.get('content-disposition'), /^attachment; filename="demo-\d{4}-\d{2}-\d{2}-\d{4}-basic\.txt"$/);

  const lines = result.text.split('\n');
  assert.equal(lines[lines.length - 1], '', '文件应以换行结尾');
  const rows = lines.slice(0, -1);
  assert.equal(rows.length, 2, '只有两张普通卡');

  const first = rows[0].split('\t');
  assert.equal(first.length, 3, '每条记录必须正好 3 个字段');
  assert.deepEqual(first, ['细胞膜的基本骨架是什么？', '磷脂双分子层', '通用制卡 细胞']);
});

test('字段里的制表符与换行被转义：不会多出分隔符，也不会提前断行', async () => {
  const result = await exportText('basic');
  const rows = result.text.split('\n').slice(0, -1);
  const second = rows[1].split('\t');
  assert.equal(second.length, 3, '转义后仍然只能有 2 个制表符');
  assert.equal(second[0], '含制表符    和换行<br>的正面', '制表符换 4 空格、换行换 <br>');
  assert.ok(second[1].includes('背面第一行<br>背面第二行'));
  assert.ok(second[1].includes('<br><br><small>这是备注</small>'), '备注按导入时的映射追加到背面');
  // 整份文件里除了行尾，不该再出现换行符
  assert.equal(result.text.split('\n').length, 3);
});

test('导出填空卡：字段顺序 Text / Extra / Tags，备注进 Extra', async () => {
  const result = await exportText('cloze');
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-disposition'), /-cloze\.txt"$/);
  const rows = result.text.split('\n').slice(0, -1);
  assert.equal(rows.length, 2);
  const first = rows[0].split('\t');
  assert.equal(first.length, 3);
  assert.equal(first[0], '细胞膜具有{{c1::选择透过性}}');
  assert.equal(first[1], '备注里有    制表符');
  assert.equal(first[2], '通用制卡');
  const second = rows[1].split('\t');
  assert.equal(second[0], '第一行<br>第二行 {{c1::答案}}');
  assert.equal(second[2], '', 'tags 是空数组时与导入行为一致：不加默认标签');
});

test('导出结果按 Anki 规则解析回来，与 /api/import 发给 AnkiConnect 的字段逐字段一致', async () => {
  const basic = await exportText('basic');
  const cloze = await exportText('cloze');

  // 1) 让服务端把同样的卡片走一次 /api/import，拿到它实际写给 AnkiConnect 的字段
  await ctx.server.api('/api/import', { method: 'POST', body: { deck: '生物::细胞膜', cards: CARDS } });
  const notes = ctx.anki.callsFor('addNotes').pop().params.notes;
  const importedBasic = notes.filter(note => note.modelName === 'Basic').map(note => [note.fields.Front, note.fields.Back, note.tags.join(' ')]);
  const importedCloze = notes.filter(note => note.modelName === 'Cloze').map(note => [note.fields.Text, note.fields.Extra, note.tags.join(' ')]);

  // 2) 按 Anki「文本文件导入」的规则解析导出的文件：换行分行、制表符分列
  const parse = text => text.split('\n').slice(0, -1).map(line => line.split('\t'));

  // 3) 逐字段比对：导出内容 == 导入内容，只是字段里的制表符/换行按规则转义过
  const expectEscaped = rows => rows.map(row => row.map(escapeExportField));
  assert.deepEqual(parse(basic.text), expectEscaped(importedBasic), '导出的普通卡 == 导入进去的普通卡（转义后）');
  assert.deepEqual(parse(cloze.text), expectEscaped(importedCloze), '导出的填空卡 == 导入进去的填空卡（转义后）');

  // 4) 转义对「真正的换行」是可逆的（字段里原本就写的 <br> 属于内容，保持原样）
  const unescape = value => value.replace(/<br>/g, '\n');
  const rows = parse(basic.text);
  assert.equal(unescape(rows[1][0]), '含制表符    和换行\n的正面', '换行能还原；制表符按约定换成 4 个空格');
  const back = unescape(rows[1][1]);
  assert.ok(back.startsWith('背面第一行\n背面第二行'), '真正的换行能还原');
  assert.ok(back.includes('<small>这是备注</small>'), '备注按导入的映射追加在背面');
  assert.ok(unescape(rows[1][2]) === '通用制卡');
});

test('导出：类型非法 / 没有该类型的卡片 → 400，且都要口令', async () => {
  const bad = await ctx.server.api('/api/export', { method: 'POST', body: { cards: CARDS, type: 'apkg' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /导出类型只能是/);

  const empty = await ctx.server.api('/api/export', { method: 'POST', body: { cards: [{ type: 'basic', front: 'a', back: 'b' }], type: 'cloze' } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /没有填空卡可以导出/);

  const noToken = await fetch(`${ctx.server.base}/api/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cards: CARDS, type: 'basic' })
  });
  assert.equal(noToken.status, 401);
});

test('导入时按 Anki 里真实的字段名填（新版 Cloze 第二个字段叫 Back Extra，不是 Extra）', async () => {
  // 模拟新版 Anki：Cloze 的第二个字段名是 "Back Extra"
  const modernAnki = await startFakeAnki(['Default'], { modelFields: { Cloze: ['Text', 'Back Extra'] } });
  const server = await startServer({ subject: 'demo', ankiUrl: modernAnki.url, config: { apiKey: 'k', model: 'm' } });
  try {
    const result = await server.api('/api/import', {
      method: 'POST',
      body: { deck: 'Default', cards: [{ type: 'cloze', text: '含 {{c1::答案}} 的句子', note: '这条备注必须进得去', tags: ['t'] }] }
    });
    assert.equal(result.status, 200);
    const note = modernAnki.callsFor('addNotes').pop().params.notes[0];
    assert.deepEqual(Object.keys(note.fields), ['Text', 'Back Extra'], '字段名要跟 Anki 里的真实名字一致');
    assert.equal(note.fields['Back Extra'], '这条备注必须进得去', '备注不能再被静默丢掉');
  } finally {
    await server.stop();
    await modernAnki.close();
  }
});

test('查不到字段名时退回经典命名（Extra / Front / Back）', async () => {
  const weirdAnki = await startFakeAnki(['Default'], { modelFields: { Cloze: null, Basic: null } });
  const server = await startServer({ subject: 'demo', ankiUrl: weirdAnki.url, config: { apiKey: 'k', model: 'm' } });
  try {
    await server.api('/api/import', {
      method: 'POST',
      body: { deck: 'Default', cards: [{ type: 'cloze', text: '含 {{c1::答案}} 的句子', note: '备注' }] }
    });
    const note = weirdAnki.callsFor('addNotes').pop().params.notes[0];
    assert.deepEqual(Object.keys(note.fields), ['Text', 'Extra']);
  } finally {
    await server.stop();
    await weirdAnki.close();
  }
});

test('/api/network：只返回内网地址与端口，绝不返回口令', async () => {
  const result = await ctx.server.api('/api/network');
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.json.addresses));
  assert.ok(!result.json.addresses.includes('127.0.0.1'), '回环地址不该出现');
  assert.ok(!result.json.addresses.some(ip => ip.startsWith('198.18.') || ip.startsWith('198.19.')), 'VPN 的 fake-IP 段不该出现');
  assert.equal(typeof result.json.httpPort, 'number');
  assert.equal(result.json.mount, '/');
  assert.ok(Array.isArray(result.json.remote), 'remote 必须是数组（远程地址单独给一份）');
  assert.ok(!JSON.stringify(result.json).includes(ctx.server.token), '响应里绝不能带口令');
});
