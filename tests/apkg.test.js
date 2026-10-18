'use strict';
/*
 * .apkg 导出：结构自检（不依赖真实 Anki）。
 * 生成一个含普通卡/填空卡/媒体/多级牌组的包，再解回 SQLite 逐项核对。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { buildApkg, plainText, fieldChecksum } = require('../src/apkg');
const { unzipSync } = require('../src/zip');

function openCollection(buffer) {
  const files = unzipSync(buffer);
  assert.ok(files['collection.anki2'], 'zip 里要有 collection.anki2');
  const file = path.join(os.tmpdir(), `cardflow-check-${Date.now()}-${Math.random().toString(16).slice(2)}.anki2`);
  fs.writeFileSync(file, files['collection.anki2']);
  const db = new DatabaseSync(file);
  return { files, db, cleanup: () => { db.close(); try { fs.rmSync(file, { force: true }); } catch (_) {} } };
}

const sample = () => buildApkg({
  decks: [
    {
      name: '生物::细胞膜',
      notes: [
        { model: 'Basic', fields: ['问题 <b>甲</b>', '答案 乙'], tags: ['测试'] },
        { model: 'Basic', fields: ['问题丙', '答案丁'] }
      ]
    },
    { name: '化学::第 1 节', notes: [{ model: 'Cloze', fields: ['水是 {{c1::液体}}，常温常压下 {{c1::无色}}', '备注'], tags: [] }] }
  ],
  media: [{ filename: 'cardflow-test.png', data: Buffer.from('PNGDATA') }]
});

test('apkg：包含 col / notes / cards，版本与牌组结构正确', () => {
  const buffer = sample();
  const { files, db, cleanup } = openCollection(buffer);
  try {
    const col = db.prepare('SELECT ver, models, decks FROM col').get();
    assert.equal(col.ver, 11, '用兼容性最好的 schema 11');
    const models = JSON.parse(col.models);
    const names = Object.values(models).map(model => model.name).sort();
    assert.deepEqual(names, ['CardFlow Basic', 'CardFlow Cloze'], '用独立模型名，不覆盖用户已有模板');
    assert.equal(models[Object.keys(models).find(id => models[id].type === 1)].req.length, 0, 'cloze 模型的 req 必须为空');

    const decks = Object.values(JSON.parse(col.decks)).map(deck => deck.name).sort();
    assert.deepEqual(decks, ['化学::第 1 节', '生物::细胞膜'], '每个导出牌组都要有对应记录');

    const notes = db.prepare('SELECT id, flds, tags, sfld, csum FROM notes ORDER BY id').all();
    assert.equal(notes.length, 3);
    assert.ok(notes.some(note => note.flds.includes('\u001f')), '字段之间用 0x1f 分隔');
    assert.ok(notes.some(note => note.tags.includes('测试')), '标签要带过去');
    const cloze = notes.find(note => note.flds.includes('{{c1::'));
    assert.ok(cloze, '填空卡原样写入');
    assert.equal(cloze.sfld, '水是 液体，常温常压下 无色', 'sfld 去掉 cloze 标记与 HTML');
    assert.ok(Number.isInteger(cloze.csum) && cloze.csum > 0, 'csum 是整数');

    const cards = db.prepare('SELECT nid, did, ord, type, queue FROM cards').all();
    assert.equal(cards.length, 3, '每张笔记一张新卡');
    assert.ok(cards.every(card => card.type === 0 && card.queue === 0), '都是新卡');
    assert.ok(cards.every(card => card.ord === 0), '多空填空仍然只生成一张卡（ord=0）');
  } finally { cleanup(); void files; }
});

test('apkg：媒体文件与 media 映射都在包里', () => {
  const { files, db, cleanup } = openCollection(sample());
  try {
    const mediaMap = JSON.parse(files.media.toString('utf8'));
    assert.equal(mediaMap['0'], 'cardflow-test.png');
    assert.equal(files['0'].toString('utf8'), 'PNGDATA', '媒体字节原样放进 zip');
  } finally { cleanup(); }
});

test('apkg：同样内容生成两次，guid 一致（Anki 靠它去重）', () => {
  const first = openCollection(sample());
  const guidsA = first.db.prepare('SELECT guid FROM notes ORDER BY guid').all().map(row => row.guid);
  first.cleanup();
  const second = openCollection(sample());
  const guidsB = second.db.prepare('SELECT guid FROM notes ORDER BY guid').all().map(row => row.guid);
  second.cleanup();
  assert.deepEqual(guidsA, guidsB);
  assert.equal(new Set(guidsA).size, guidsA.length, '不同卡片 guid 不能撞');
});

test('apkg：空牌组直接报错，不产出坏文件', () => {
  assert.throws(() => buildApkg({ decks: [] }), /缺少牌组/);
});

test('apkg：plainText 清掉 HTML、音频标记与 cloze 包裹', () => {
  assert.equal(plainText('<b>甲</b> [sound:x.mp3] {{c1::乙}}'), '甲 乙');
  assert.equal(fieldChecksum('甲'), fieldChecksum('甲'));
  assert.notEqual(fieldChecksum('甲'), fieldChecksum('乙'));
});
