'use strict';
/*
 * 页面模板渲染测试：index.html / manifest.json 的占位符替换规则（多学科模式下的挂载点、
 * window.__SUBJECT__ 的内容、缺 key 时报错）。前端页面必须能在这个契约下渲染出来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-render-'));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ token: 'render-test-token' }));
process.env.ANKI_CONFIG = path.join(tmp, 'config.json');

const { ALL_SUBJECTS, renderSubjectTemplate, mountOf, MULTI } = require('../src/server.js');
const demo = ALL_SUBJECTS.find(subject => subject.id === 'demo');

test('挂载点：多学科模式带学科前缀，单学科模式是根路径', () => {
  if (MULTI) assert.equal(mountOf(demo), '/demo/');
  else assert.equal(mountOf(demo), '/');
});

test('学科自己的占位符都能替换（含 copy.* 的通用取法）', () => {
  const template = [
    '<title>{{subject.shortName}}</title>',
    '<html data-subject="{{subject.id}}">',
    '<meta name="theme-color" content="{{subject.themeColor}}">',
    '<body data-subject="{{subject.id}}" data-viewport="{{subject.viewportFit}}">',
    '<h1>{{copy.title}}</h1><div class="sub">{{copy.subtitle}}</div>',
    '<select id="{{cardMode.controlId}}">{{cardMode.optionsHtml}}</select>',
    '<input value="{{cardCount.min}}"><input value="{{cardCount.max}}"{{cardCount.maxAriaHtml}}>',
    '<select id="subjectSwitch">{{navHtml}}</select>',
    '{{subjectScript}}'
  ].join('\n');
  const html = renderSubjectTemplate(demo, template);

  assert.ok(!html.includes('{{'), '渲染后不应残留占位符');
  assert.match(html, /<title>CardFlow<\/title>/);
  assert.match(html, /data-subject="demo"/);
  assert.match(html, /content="#2269d1"/);
  assert.match(html, /<h1>CardFlow<\/h1>/);
  assert.match(html, /资料制卡 · 完整覆盖优先 · 关系与过程优先填空/);
  assert.match(html, /<select id="clozeWeight">/);
  assert.match(html, /value="10"/);
  assert.match(html, /value="20"/);
  assert.match(html, /window\.__SUBJECT__ = \{/);
});

test('window.__SUBJECT__ 的内容与学科配置一致', () => {
  const html = renderSubjectTemplate(demo, '{{subjectScript}}');
  const injected = JSON.parse(/window\.__SUBJECT__ = (\{.*?\});/.exec(html)[1]);
  assert.equal(injected.id, 'demo');
  assert.equal(injected.base, MULTI ? '/demo' : '');
  assert.equal(injected.cardModeControl, 'clozeWeight');
  assert.equal(injected.cardModeField, 'clozeWeight');
  assert.equal(injected.storageKey, 'cardflow.demo.v1');
  assert.equal(injected.tokenKey, 'cardflow.demo.token');
  assert.equal(injected.assetVersion, 'demo1');
  assert.equal(injected.previewNormalizes, false);
  assert.equal(injected.defaultDeck, '');
  assert.deepEqual(injected.subjectSwitch.map(item => item.id), ALL_SUBJECTS.map(item => item.id));
});

test('aria 属性只在配置里给了的时候出现', () => {
  const template = '<input id="minCards"{{cardCount.minAriaHtml}}>';
  assert.match(renderSubjectTemplate(demo, template), /aria-label="最少卡片数"/);
});

test('条件块：值为空时整块删掉', () => {
  const template = '<details class="formulaHelp">{{#copy.formatHelp}}{{copy.formatHelp}}{{/copy.formatHelp}}</details>';
  assert.equal(renderSubjectTemplate(demo, template), '<details class="formulaHelp"></details>');
});

test('占位符没有对应值时报错（避免页面上留半成品）', () => {
  assert.throws(() => renderSubjectTemplate(demo, '{{copy.nope}}'), /没有对应值/);
});
