'use strict';
/*
 * 维护模块：问题池（跨批次去重）、备份/恢复往返、诊断包脱敏。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { create, SEEN_LIMIT } = require('../src/maintenance');
const { unzipSync } = require('../src/zip');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardflow-maint-'));
  const dataDir = path.join(root, 'data');
  const packsDir = path.join(root, 'packs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(packsDir, { recursive: true });
  const historyFile = path.join(root, 'history', 'history.jsonl');
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  const module = create({ dataDir, packsDir, version: '9.9.9', historyFile });
  return { root, dataDir, packsDir, historyFile, module, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} } };
}

test('问题池：按学科分开、归一化去重、只增不减', () => {
  const env = fixture();
  try {
    const first = env.module.addSeen('demo', ['细胞膜的结构', '细胞膜 的结构']);
    assert.equal(first.added, 1, '只差空白与标点的算同一张卡');
    assert.equal(first.total, 1);
    const second = env.module.addSeen('demo', ['细胞膜的结构', '流动镶嵌模型']);
    assert.equal(second.added, 1, '重复的不再计');
    assert.equal(second.total, 2);
    assert.deepEqual(env.module.readSeen('demo').length, 2);
    assert.deepEqual(env.module.readSeen('chem'), [], '不同学科各存一份');
    assert.equal(env.module.addSeen('demo', ['  ', 'x']).added, 0, '太短的文本不进池');
  } finally { env.cleanup(); }
});

test('问题池：有上限，超了丢最老的', () => {
  const env = fixture();
  try {
    const many = Array.from({ length: SEEN_LIMIT + 50 }, (_, i) => `问题${i}`);
    env.module.addSeen('demo', many);
    const list = env.module.readSeen('demo');
    assert.equal(list.length, SEEN_LIMIT);
    assert.ok(list.includes(`问题${SEEN_LIMIT + 49}`), '最新的要保留');
    assert.ok(!list.includes('问题0'), '最老的要被挤出去');
  } finally { env.cleanup(); }
});

test('备份 → 恢复：学科包与历史能往返，且旧文件会先存一份', () => {
  const env = fixture();
  try {
    fs.writeFileSync(path.join(env.packsDir, 'gaokao-bio.json'), JSON.stringify({ id: 'gaokao-bio', name: '高考生物' }));
    fs.writeFileSync(env.historyFile, '{"t":1,"kind":"generate"}\n');
    const { buffer, meta } = env.module.exportBackup({ subjects: ['demo', 'chem'], settings: { batchSize: 3 }, historyText: fs.readFileSync(env.historyFile, 'utf8') });
    assert.equal(meta.includesPacks, true);
    assert.equal(meta.includesHistory, true);
    assert.equal(meta.includesSettings, true);
    const files = unzipSync(buffer);
    assert.ok(files['packs/gaokao-bio.json'], '学科包要进包');
    assert.ok(files['history.jsonl'], '历史要进包');
    assert.ok(files['settings.json'], '前端设置要进包');
    assert.deepEqual(Object.keys(JSON.parse(files['meta.json'])).includes('version'), true);

    // 改动现网文件后恢复，应该回到备份时的内容，并把旧文件挪走
    fs.writeFileSync(path.join(env.packsDir, 'gaokao-bio.json'), JSON.stringify({ id: 'gaokao-bio', name: '被改坏了' }));
    fs.writeFileSync(env.historyFile, '坏历史\n');
    const result = env.module.restoreBackup(buffer);
    assert.equal(result.packs, 1);
    assert.equal(result.history, true);
    assert.deepEqual(result.settings, { batchSize: 3 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.packsDir, 'gaokao-bio.json'), 'utf8')).name, '高考生物');
    assert.match(fs.readFileSync(env.historyFile, 'utf8'), /"kind":"generate"/);
    assert.ok(result.backupDir && fs.existsSync(path.join(result.backupDir, 'gaokao-bio.json')), '旧数据要留底');
  } finally { env.cleanup(); }
});

test('恢复：不认识的路径不落盘（防目录穿越）', () => {
  const env = fixture();
  try {
    const { zipSync } = require('../src/zip');
    const evil = zipSync([
      { name: '../evil.json', data: Buffer.from('{}') },
      { name: 'packs/../evil2.json', data: Buffer.from('{}') },
      { name: 'packs/Good-Pack.json', data: Buffer.from('{}') }
    ]);
    const result = env.module.restoreBackup(evil);
    assert.equal(result.packs, 0, '带路径穿越与非法 ID 的一律不认');
    assert.equal(fs.existsSync(path.join(env.root, 'evil.json')), false);
  } finally { env.cleanup(); }
});

test('诊断包：报开关不报密钥，带日志尾部', () => {
  const env = fixture();
  try {
    const logFile = path.join(env.root, 'server.log');
    fs.writeFileSync(logFile, ['line1', 'line2', 'line3'].join('\n'));
    const report = env.module.diagnose({
      subject: 'demo',
      config: { apiUrl: 'https://api.example.com/v1/chat', apiKey: 'SECRET-KEY', token: 'TOKEN-123', model: 'demo', tavilyKey: 'T-KEY' },
      tts: true,
      anki: { checked: true, ok: true, version: 6 },
      history: [{ kind: 'generate', ms: 12 }],
      seenCount: 7,
      logFile
    });
    const raw = JSON.stringify(report);
    assert.ok(!raw.includes('SECRET-KEY') && !raw.includes('TOKEN-123') && !raw.includes('T-KEY'), '密钥不能出现在诊断包里');
    assert.equal(report.config.apiUrlOrigin, 'https://api.example.com');
    assert.equal(report.config.hasApiKey, true);
    assert.equal(report.config.ttsAvailable, true);
    assert.match(report.log, /line3/);
    assert.equal(report.seenCount, 7);
    assert.equal(report.version, '9.9.9');
  } finally { env.cleanup(); }
});
