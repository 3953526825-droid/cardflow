'use strict';
/*
 * 手机端的学科包：
 *   1) 校验规则只有一份（src/packs.js 与离线页共用同一个 validate/materialize）；
 *   2) 手机上「运行时拼出来的学科包页面」必须与打包时生成的静态页一模一样
 *      （差一处就说明模板或学科包字段变了，得同时改拼装逻辑）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildShell } = require('../scripts/build-shell.js');
const sharedPacks = require('../src/shared/pack-schema.js');
const nodePacks = require('../src/packs.js');
const server = require('../src/server.js');

const packSubject = server.ALL_SUBJECTS.find(subject => subject.pack) || null;

test('学科包校验规则只有一份：packs.js 与离线页共用同一个 validate / materialize', () => {
  assert.equal(nodePacks.validate, sharedPacks.validate);
  assert.equal(nodePacks.materialize, sharedPacks.materialize);
  const bad = {
    schemaVersion: 1, id: 'Bad_ID', exam: '高考', subject: '语文', name: '测试',
    cardCount: { min: 1, max: 2 }, search: { subjectPrefix: 'a', catalogSuffix: 'b', preferredDomains: [] },
    prompts: { generate: 'a', reference: 'b', identify: 'c', locate: 'd' }
  };
  let nodeError = '';
  try { nodePacks.validate(bad); } catch (error) { nodeError = error.message; }
  let sharedError = '';
  try { sharedPacks.validate(bad); } catch (error) { sharedError = error.message; }
  assert.ok(nodeError, '坏包必须被拒（id 不能有大写和连字符以外的字符）');
  assert.equal(nodeError, sharedError, '两端的报错文案要一致（离线页直接显示给用户）');
  // 缺字段的包也要说清楚
  assert.throws(() => sharedPacks.validate({ schemaVersion: 1 }), /id/);
});

test('运行时拼出来的学科包页面与打包时生成的静态页逐字一致', () => {
  if (!packSubject) {
    console.log('这台机器上没有装学科包，跳过逐字比对（生成逻辑仍由上面的用例保护）');
    return;
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cardflow-pack-'));
  try {
    buildShell({ out });
    const baseHtml = fs.readFileSync(path.join(out, 'base-page.html'), 'utf8');
    const baseSubject = JSON.parse(fs.readFileSync(path.join(out, 'subject-base.json'), 'utf8'));
    const pages = JSON.parse(fs.readFileSync(path.join(out, 'pages.json'), 'utf8'));
    assert.equal(pages.base, 'demo');
    assert.ok(pages.subjects.some(item => item.id === packSubject.id), '打包时带的学科包里应当有这个包');

    const runtime = sharedPacks.packPageFromBase(baseHtml, baseSubject, packSubject.pack, pages.subjects.map(item => ({ id: item.id, name: item.name })));
    const built = fs.readFileSync(path.join(out, `index-${packSubject.id}.html`), 'utf8');
    assert.equal(runtime, built, '运行时拼装结果必须与打包时的静态页一致');
    assert.ok(runtime.includes(`<strong>${packSubject.name}</strong>`));
    assert.ok(runtime.includes('id="minCards"'), '卡片数量上下限要跟着学科包走');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('学科下拉为「本机导入的包」生成 pack:<id> 选项，并选中当前包（真机反馈：两边不同步）', () => {
  const demo = {
    schemaVersion: 1, id: 'demo-pack', exam: '高考', subject: '语文', name: '示例包',
    cardCount: { min: 3, max: 9 }, search: { subjectPrefix: 'a', catalogSuffix: 'b', preferredDomains: [] },
    prompts: { generate: 'a', reference: 'b', identify: 'c', locate: 'd' }
  };
  const base = {
    name: '通用制卡',
    copy: { subtitle: '生物', searchPlaceholder: '检索', newDeckPlaceholder: '新牌组', extraRulesPlaceholder: '额外规则' },
    cardCount: { min: 1, max: 2, hint: '数量提示' },
    assetVersion: 'v1',
    anki: {},
    cardMode: { controlId: 'clozeWeight', field: 'clozeWeight' }
  };
  const baseHtml = '<html><head><title>CardFlow · 通用制卡</title></head><body>'
    + '<strong>通用制卡</strong><span>生物</span>'
    + '<input id="minCards" type="number" min="1" max="100" value="1">'
    + '<input id="maxCards" type="number" min="1" max="100" value="2">'
    + '<input id="searchQuery" placeholder="检索">'
    + '<input placeholder="新牌组"><input placeholder="额外规则">'
    + '<div class="muted">数量提示</div>'
    + '<select id="subjectSwitch"><option value="x">旧</option></select>'
    + '<script>window.__SUBJECT__ = {"id":"demo"};</script>'
    + '<script src="/app.js?v=v1"></script></body></html>';
  const subjects = [
    { id: 'demo', name: '通用制卡' },
    { id: 'demo-pack', name: '示例包', href: 'pack:demo-pack' }
  ];
  const html = sharedPacks.packPageFromBase(baseHtml, base, demo, subjects);
  assert.ok(html.includes('<option value="index-demo.html">通用制卡</option>'), '打包的学科仍走静态页');
  assert.ok(html.includes('<option value="pack:demo-pack" selected>示例包</option>'), '本机导入的包用 pack:<id> 并默认选中');
  assert.ok(html.includes('"href":"pack:demo-pack"'), '内联学科配置里的切换地址也要跟着走');
});

test('学科包：勾了「化学式转换」时，运行时页面补上与离线化学页一致的 MathJax', () => {
  const demo = {
    schemaVersion: 1, id: 'demo-chem', exam: '高考', subject: '化学', name: '化学示例包', chemFormulas: true,
    cardCount: { min: 3, max: 9 }, search: { subjectPrefix: 'a', catalogSuffix: 'b', preferredDomains: [] },
    prompts: { generate: 'a', reference: 'b', identify: 'c', locate: 'd' }
  };
  const baseHtml = '<html><head><title>CardFlow · 通用制卡</title>'
    + '<script src="/theme.js?v=1"></script><script src="/vendor/pdf.min.js"></script><script src="/core.js?v=1"></script>'
    + '</head><body>'
    + '<strong>通用制卡</strong><span>生物</span>'
    + '<input id="minCards" type="number" min="1" max="100" value="1">'
    + '<input id="maxCards" type="number" min="1" max="100" value="2">'
    + '<input id="searchQuery" placeholder="检索">'
    + '<input placeholder="新牌组"><input placeholder="额外规则">'
    + '<div class="muted">数量提示</div>'
    + '<select id="subjectSwitch"><option value="x">旧</option></select>'
    + '<script>window.__SUBJECT__ = {"id":"demo"};</script>'
    + '<script src="/app.js?v=v1"></script></body></html>';
  const base = { name: '通用制卡', copy: { subtitle: '生物', searchPlaceholder: '检索', newDeckPlaceholder: '新牌组', extraRulesPlaceholder: '额外规则' }, cardCount: { min: 1, max: 2, hint: '数量提示' }, assetVersion: 'v1', anki: {}, cardMode: { controlId: 'clozeWeight', field: 'clozeWeight' } };
  const chem = sharedPacks.materialize(demo, { ...base, httpPort: 3210, httpsPort: 3212, tokenKey: 'cardflow.demo.token', config: {}, cardCount: { min: 1, max: 2, hint: '数量提示' } });
  assert.equal(chem.previewNormalizes, true);
  const html = sharedPacks.packPageFromBase(baseHtml, base, demo, [{ id: 'demo', name: '通用制卡' }, { id: 'demo-chem', name: '化学示例包', href: 'pack:demo-chem' }]);
  assert.ok(html.includes('window.MathJax='), '要补上 MathJax');
  assert.ok(html.includes('<script async src="/vendor/mathjax/tex-svg.js"></script>'), '离线要走包内副本，不连远程');
  assert.ok(html.indexOf('window.MathJax=') < html.indexOf('/vendor/pdf.min.js'), '插在 theme.js 与 pdf.min.js 之间（与打包时的静态页同一位置）');
  // 不勾的包不能凭空多出 MathJax
  const plain = sharedPacks.packPageFromBase(baseHtml, base, { ...demo, id: 'demo-plain', chemFormulas: false }, [{ id: 'demo', name: '通用制卡' }, { id: 'demo-plain', name: '普通包', href: 'pack:demo-plain' }]);
  assert.ok(!plain.includes('window.MathJax='), '没勾化学式转换的包不加 MathJax');
});

test('拼装遇到对不上的模板时会报错，而不是悄悄拼出怪页面', () => {
  const pack = packSubject ? packSubject.pack : {
    schemaVersion: 1, id: 'demo-pack', exam: '高考', subject: '语文', name: '示例',
    cardCount: { min: 1, max: 2 }, search: { subjectPrefix: 'a', catalogSuffix: 'b', preferredDomains: [] },
    prompts: { generate: 'a', reference: 'b', identify: 'c', locate: 'd' }
  };
  const base = { name: '通用制卡', copy: { subtitle: 'x', searchPlaceholder: 'y' }, cardCount: { min: 1, max: 2 }, assetVersion: 'v1' };
  assert.throws(() => sharedPacks.packPageFromBase('<html></html>', base, pack, []), /学科包页面拼装失败/);
});
