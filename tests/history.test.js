'use strict';
/*
 * 调用历史（src/history.js）的单元测试。
 * 只写临时文件：ANKI_HISTORY_FILE 指到系统临时目录，绝不碰用户真正的 history/history.jsonl。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const history = require(path.join(ROOT, 'src', 'history.js'));

/** 每个用例一个干净的文件；路径是惰性解析的，所以设完环境变量再写就读得到。 */
function freshFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-history-'));
  const file = path.join(dir, 'history.jsonl');
  process.env.ANKI_HISTORY_FILE = file;
  return file;
}

test('历史：写进去的能按「新的在前」读回来，字段原样保留', () => {
  const file = freshFile();
  history.append({ t: 1, subject: 'demo', kind: 'generate', total: 3, titles: ['甲', '乙', '丙'] });
  history.append({ t: 2, subject: 'chem', kind: 'import', deck: '化学::平衡', added: 2, skipped: 1 });

  const records = history.read(10);
  assert.equal(records.length, 2);
  assert.equal(records[0].t, 2, '最新的排最前面');
  assert.equal(records[0].kind, 'import');
  assert.equal(records[0].deck, '化学::平衡');
  assert.equal(records[1].subject, 'demo');
  assert.deepEqual(records[1].titles, ['甲', '乙', '丙']);
  assert.equal(history.filePath(), file, '环境变量指向哪个文件就用哪个');
});

test('历史：limit 只取最近的 N 条，目录不存在会自动建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-history-'));
  process.env.ANKI_HISTORY_FILE = path.join(dir, 'nested', 'deep', 'history.jsonl');
  for (let i = 1; i <= 5; i++) history.append({ t: i, subject: 'demo', kind: 'generate', total: i });

  assert.ok(fs.existsSync(process.env.ANKI_HISTORY_FILE), '嵌套目录应被自动创建');
  assert.deepEqual(history.read(2).map(r => r.total), [5, 4]);
  assert.equal(history.read(0).length, 1, 'limit 至少 1 条');
  assert.equal(history.read(99).length, 5);
});

test('历史：损坏的行被跳过，不影响其它记录', () => {
  const file = freshFile();
  history.append({ t: 1, subject: 'demo', kind: 'generate', total: 1 });
  fs.appendFileSync(file, '{这不是 JSON\n');
  history.append({ t: 2, subject: 'demo', kind: 'import', added: 0 });

  const records = history.read(10);
  assert.equal(records.length, 2, '坏行被丢掉，好行都还在');
  assert.deepEqual(records.map(r => r.t), [2, 1]);
});

test('历史：卡片正文能原样存取（「载入这批卡片」靠它）', () => {
  freshFile();
  const cards = [{ type: 'basic', front: '甲', back: '乙', priority: 'P1', tags: ['通用制卡'] }, { type: 'cloze', text: '{{c1::丙}}丁', note: '备注' }];
  history.append({ t: 1, subject: 'demo', kind: 'generate', total: 2, cards });
  assert.deepEqual(history.read(1)[0].cards, cards, '整批卡片要一字不改地存下来');
});

test('历史：默认上限足够装下几百次生成（上限太小，载入卡片很快就没得载了）', () => {
  delete process.env.ANKI_HISTORY_MAX_BYTES;
  delete process.env.ANKI_HISTORY_KEEP_LINES;
  assert.ok(history.maxBytes() >= 1024 * 1024, `默认上限至少 1MB，实际 ${history.maxBytes()}`);
  assert.ok(history.keepLines() >= 100, `默认至少留 100 条，实际 ${history.keepLines()}`);
});

test('历史：文件超过上限时只保留最近若干条（上限可调小，方便快速验证）', () => {
  const file = freshFile();
  process.env.ANKI_HISTORY_MAX_BYTES = '4000';
  process.env.ANKI_HISTORY_KEEP_LINES = '3';
  const filler = '细'.repeat(200); // 每条约 300 字节
  for (let i = 1; i <= 60; i++) history.append({ t: i, subject: 'demo', kind: 'generate', total: i, titles: [filler] });

  const size = fs.statSync(file).size;
  const records = history.read(999);
  assert.ok(size <= history.maxBytes() * 2, `截断后不该远超上限，实际 ${size} 字节`);
  assert.ok(records.length < 60, `确实被截断过，实际只剩 ${records.length} 条`);
  assert.ok(records.length >= history.keepLines(), '至少要留下配置的条数');
  assert.equal(records[0].t, 60, '保留的是最新的');
  assert.ok(!records.some(record => record.t === 1), '最早的记录已被丢掉');
  delete process.env.ANKI_HISTORY_MAX_BYTES;
  delete process.env.ANKI_HISTORY_KEEP_LINES;
});

test('历史：没有文件时读出空数组，不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-history-'));
  process.env.ANKI_HISTORY_FILE = path.join(dir, 'never-written.jsonl');
  assert.deepEqual(history.read(10), []);
});
