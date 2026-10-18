'use strict';
/*
 * 全局默认规则（出厂自带的两条）与「只补一次」的迁移标记。
 * core.js 直接读全局 localStorage，这里给一个最小实现再 require 它。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const STORE = 'cardflow.settings';
const SEED = 'cardflow.rulesSeed';

function useStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  globalThis.localStorage = {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    clear: () => map.clear()
  };
  return map;
}

const core = require('../public/core');

test('全局规则：新装的浏览器直接带上两条出厂规则（遮挡卡合并 + 填空卡只用 c1）', () => {
  const map = useStorage();
  const settings = core.settings();
  assert.equal(settings.rules.length, 2);
  const texts = settings.rules.map(rule => rule.text);
  assert.ok(texts.some(text => text.includes('遮挡') && text.includes('一张卡')), '遮挡卡规则要写明合并成一张卡');
  assert.ok(texts.some(text => text.includes('c1') && text.includes('c2')), '填空卡规则要写明可多次 c1、不能出现 c2');
  assert.ok(settings.rules.every(rule => rule.enabled === true), '出厂规则默认启用');
  assert.equal(map.get(SEED), '1', '补过之后要留标记，避免以后重复补');
});

test('全局规则：老配置只补一次，用户自己的规则和其它设置都不动', () => {
  const map = useStorage({
    [STORE]: JSON.stringify({ rules: [{ text: '我自己的规则', enabled: true }], batchSize: 5, showSources: false })
  });
  const settings = core.settings();
  assert.equal(settings.rules.length, 3, '用户 1 条 + 出厂 2 条');
  assert.equal(settings.rules[0].text, '我自己的规则', '用户规则排在前面');
  assert.equal(settings.batchSize, 5, '其它设置不受影响');
  assert.equal(settings.showSources, false);
  assert.equal(map.get(SEED), '1');

  // 用户随后在全局设置里删掉出厂规则：不该再被自动加回来
  const stored = JSON.parse(map.get(STORE));
  stored.rules = stored.rules.filter(rule => !rule.id);
  map.set(STORE, JSON.stringify(stored));
  const again = core.settings();
  assert.equal(again.rules.length, 1);
  assert.equal(again.rules[0].text, '我自己的规则');
});

test('全局规则：已经手写过同样内容时不会重复添加，也不会覆盖用户的启用状态', () => {
  useStorage({ [STORE]: JSON.stringify({ rules: [{ text: core.DEFAULT_RULES[0].text, enabled: false }] }) });
  const settings = core.settings();
  assert.equal(settings.rules.filter(rule => rule.text === core.DEFAULT_RULES[0].text).length, 1, '同样的文字不重复加');
  assert.equal(settings.rules.length, 2, '另外一条出厂规则照常补上');
  assert.equal(settings.rules.find(rule => rule.text === core.DEFAULT_RULES[0].text).enabled, false, '用户关掉了就尊重用户');
});
