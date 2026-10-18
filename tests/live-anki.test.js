'use strict';
/*
 * 真实 AnkiConnect 自检（默认跳过）。
 *
 * 为什么默认跳过：这套测试会真的连 127.0.0.1:8765 建牌组、再删掉。
 * 它只碰自己刚建的空牌组，但为了避免「随手 npm test 就动了 Anki」，
 * 必须显式设置 ANKI_LIVE=1 才运行。
 *
 * 运行方式（Windows PowerShell）：
 *   $env:ANKI_LIVE='1'; npm test
 * 或只跑这一个文件：
 *   $env:ANKI_LIVE='1'; node --test tests/live-anki.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer } = require('./helpers/harness');

const LIVE = process.env.ANKI_LIVE === '1';
const ANKI_URL = process.env.ANKI_LIVE_URL || 'http://127.0.0.1:8765';

async function anki(action, params = {}) {
  const response = await fetch(ANKI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params })
  });
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result.result;
}

async function deleteIfExists(decks) {
  const existing = await anki('deckNames');
  const targets = decks.filter(deck => existing.includes(deck));
  if (targets.length) await anki('deleteDecks', { decks: targets, cardsToo: true });
}

test('真实 AnkiConnect：自建空牌组 → dryRun 预览 → 真删 → 用户原有牌组不变',
  { skip: LIVE ? false : '需要 ANKI_LIVE=1（会真实创建并删除一个空测试牌组）' },
  async () => {
    const before = await anki('deckNames');
    const name = `AnkiCardMaker-自检-${Date.now().toString(36)}`;
    const sub = `${name}::子牌组`;
    const server = await startServer({ subject: process.env.ANKI_LIVE_SUBJECT || 'demo', ankiUrl: ANKI_URL, config: { apiKey: 'x', model: 'x' } });
    try {
      const created = await server.api('/api/deck/create', { method: 'POST', body: { deck: name } });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      const createdSub = await server.api('/api/deck/create', { method: 'POST', body: { deck: sub } });
      assert.equal(createdSub.status, 200);

      const namesNow = await anki('deckNames');
      assert.ok(namesNow.includes(name) && namesNow.includes(sub), '新建的测试牌组应存在');

      const preview = await server.api('/api/deck/delete', { method: 'POST', body: { deck: name, dryRun: true } });
      assert.equal(preview.status, 200);
      assert.deepEqual(preview.json.decks, [name, sub]);
      assert.equal(preview.json.cardCount, 0, '新建的空牌组应没有卡片');
      assert.ok((await anki('deckNames')).includes(name), 'dryRun 后牌组必须还在');

      const removed = await server.api('/api/deck/delete', { method: 'POST', body: { deck: name } });
      assert.equal(removed.status, 200, JSON.stringify(removed.json));
      assert.equal(removed.json.cardsToo, true);

      const after = await anki('deckNames');
      assert.ok(!after.includes(name) && !after.includes(sub), '测试牌组应被删干净');
      assert.deepEqual([...after].sort(), [...before].sort(), '用户原有牌组必须一字不变');
    } finally {
      await deleteIfExists([sub, name]).catch(() => {});
      await server.stop();
    }
  });

test('真实 AnkiConnect：导出的 txt 按 Anki 规则解析后写进 Anki，读回来与导出内容逐字一致',
  { skip: LIVE ? false : '需要 ANKI_LIVE=1（会真实创建并删除一个测试牌组）' },
  async () => {
    const before = await anki('deckNames');
    const deck = `AnkiCardMaker-导出验收-${Date.now().toString(36)}`;
    const server = await startServer({ subject: process.env.ANKI_LIVE_SUBJECT || 'demo', ankiUrl: ANKI_URL, config: { apiKey: 'x', model: 'x' } });
    const cards = [
      { type: 'basic', tags: ['导出验收'], front: '含制表符\t的正面', back: '第一行\n第二行', note: '' },
      { type: 'cloze', tags: ['导出验收'], text: '细胞膜具有{{c1::选择透过性}}', note: '备注' }
    ];
    try {
      await anki('createDeck', { deck });
      const exported = {};
      for (const type of ['basic', 'cloze']) {
        const response = await fetch(`${server.base}/api/export`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-anki-token': server.token },
          body: JSON.stringify({ cards, type })
        });
        assert.equal(response.status, 200);
        exported[type] = await response.text();
      }

      // 按 Anki「文本文件导入」的规则解析：换行分行、制表符分列
      const parse = text => text.split('\n').slice(0, -1).map(line => line.split('\t'));
      const basicRows = parse(exported.basic);
      const clozeRows = parse(exported.cloze);
      assert.equal(basicRows.length, 1);
      assert.equal(clozeRows.length, 1);
      assert.equal(basicRows[0].length, 3, '普通卡 3 个字段');
      assert.equal(clozeRows[0].length, 3, '填空卡 3 个字段');

      // 用解析出来的字段建卡——这正是 Anki 导入 txt 时会做的事（按位置映射到笔记类型的字段）
      const basicFields = await anki('modelFieldNames', { modelName: 'Basic' });
      const clozeFields = await anki('modelFieldNames', { modelName: 'Cloze' });
      const noteIds = await anki('addNotes', {
        notes: [
          { deckName: deck, modelName: 'Basic', fields: { [basicFields[0]]: basicRows[0][0], [basicFields[1]]: basicRows[0][1] }, tags: basicRows[0][2].split(' ').filter(Boolean) },
          { deckName: deck, modelName: 'Cloze', fields: { [clozeFields[0]]: clozeRows[0][0], [clozeFields[1]]: clozeRows[0][1] }, tags: clozeRows[0][2].split(' ').filter(Boolean) }
        ]
      });
      assert.ok(noteIds.every(Boolean), '两张卡都应写进 Anki');

      const info = await anki('notesInfo', { notes: noteIds });
      const readBack = Object.fromEntries(info.map(note => [note.modelName, note.fields]));
      assert.equal(readBack.Basic.Front.value, '含制表符    的正面', '制表符按约定变成 4 个空格');
      assert.equal(readBack.Basic.Back.value, '第一行<br>第二行', '换行变成 <br>，Anki 里会渲染成换行');
      assert.equal(readBack.Cloze.Text.value, '细胞膜具有{{c1::选择透过性}}');

      // 填空卡的第二个字段：新版 Anki 里叫 "Back Extra"（旧版叫 "Extra"）。
      // 服务端会先问 Anki 这个笔记类型有哪些字段，再按位置填，所以备注能真的进去。
      const clozeFieldNames = Object.keys(readBack.Cloze);
      const secondName = clozeFieldNames.find(name => name !== 'Text');
      assert.ok(secondName, '填空卡应有第二个字段');
      assert.equal(readBack.Cloze[secondName].value, '备注', `备注应进到第二个字段（${secondName}）`);

      assert.deepEqual(info.map(note => note.tags).flat().sort(), ['导出验收', '导出验收']);
    } finally {
      await deleteIfExists([deck]).catch(() => {});
      await server.stop();
      const after = await anki('deckNames');
      assert.deepEqual([...after].sort(), [...before].sort(), '用户原有牌组必须一字不变');
    }
  });
