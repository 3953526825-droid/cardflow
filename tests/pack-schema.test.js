'use strict';
/*
 * 学科包 schema 版本与升级框架：老包能被识别、过新的包要给出明确提示。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const packs = require('../src/packs');

const base = () => ({
  schemaVersion: 1,
  id: 'gaokao-bio',
  exam: '高考',
  subject: '生物',
  name: '高考生物',
  cardCount: { min: 10, max: 20 },
  search: { subjectPrefix: '通用制卡考点', catalogSuffix: '章节内容', preferredDomains: ['zhihu.com'] },
  prompts: {
    generate: 'G'.repeat(40),
    reference: 'R'.repeat(40),
    identify: 'I'.repeat(40),
    locate: 'L'.repeat(40)
  }
});

test('学科包：当前版本能通过校验，并原样返回规范化的对象', () => {
  const pack = packs.validate(base());
  assert.equal(pack.id, 'gaokao-bio');
  assert.equal(pack.schemaVersion, packs.CURRENT_SCHEMA);
});

test('学科包：比程序更新的版本被拒绝，提示先升级程序', () => {
  assert.throws(() => packs.validate({ ...base(), schemaVersion: packs.CURRENT_SCHEMA + 1 }), /版本过新/);
});

test('学科包：缺少或非法的 schemaVersion 直接拒绝', () => {
  assert.throws(() => packs.validate({ ...base(), schemaVersion: undefined }), /schemaVersion/);
  assert.throws(() => packs.validate({ ...base(), schemaVersion: 0 }), /schemaVersion/);
});

test('学科包：migrate 幂等——当前版本的包不会被改动', () => {
  const input = base();
  const out = packs.migrate(input);
  assert.equal(out.schemaVersion, packs.CURRENT_SCHEMA);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(input).sort());
  assert.equal(out.name, input.name);
  assert.equal(input.name, '高考生物', 'migrate 不该改调用方的对象');
});

test('学科包：chemFormulas 只接受布尔值（创建/编辑时的「化学式转换」开关）', () => {
  const on = packs.validate({ ...base(), chemFormulas: true });
  assert.equal(on.chemFormulas, true);
  assert.equal(packs.validate(base()).chemFormulas, undefined, '不写就是不转换');
  assert.throws(() => packs.validate({ ...base(), chemFormulas: 'yes' }), /chemFormulas/);
});

test('学科包：勾了公式转换时 materialize 打开 postprocess 与 previewNormalizes', () => {
  const baseSubject = { httpPort: 3210, httpsPort: 3212, tokenKey: 'cardflow.demo.token', config: {}, cardCount: { min: 1, max: 5 }, copy: {} };
  const normal = packs.materialize(packs.validate(base()), baseSubject);
  assert.equal(normal.previewNormalizes, false);
  assert.equal(normal.postprocess, null);
  const chem = packs.materialize(packs.validate({ ...base(), chemFormulas: true }), baseSubject);
  assert.equal(chem.previewNormalizes, true, '预览前要走 /api/normalize');
  assert.equal(chem.postprocess, 'formula', '生成/导入走公式后处理');
});

