'use strict';
/*
 * 「八张图一张卡都出不来」的根因回归测试。
 *
 * 学科包的提示词是用户（AI）自己写的，不一定会要求 {"cards":[…]} 这层外壳 ——
 * 模型直接吐裸数组 [ {卡片}, {卡片} ] 时，旧实现只从第一个 { 开始扫，
 * 把整份输出截成「第一张卡」（能 parse 成功、不报错），于是预览永远是 0 张。
 * 现在：顶层是数组就包成 { cards: […] }；外壳字段名不一样也认；实在没有就别瞎编。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../src/shared');

const { parseGeneratedJson, extractFirstJson, normalizeCards } = shared;
const CARD = { type: 'basic', front: '正面', back: '背面' };

test('裸数组：顶层是 [ {卡片}, … ] 也要全部认出来', () => {
  const text = JSON.stringify([CARD, { type: 'cloze', text: '含 {{c1::空}} 的句子' }]);
  const data = parseGeneratedJson(text);
  assert.equal(data.cards.length, 2);
  assert.equal(data.cards[0].front, '正面');
});

test('裸数组：外面还裹着解释文字与代码围栏', () => {
  const text = '好的，这是卡片：\n```json\n[{"type":"basic","front":"A","back":"B"},{"type":"basic","front":"C","back":"D"}]\n```\n共两张。';
  assert.equal(parseGeneratedJson(text).cards.length, 2);
});

test('标准外壳照旧：{"cards":[…]} 与其它字段一起返回', () => {
  const text = JSON.stringify({ cards: [CARD], image_occlusion_suggestions: [{ hint: 1 }] });
  const data = parseGeneratedJson(text);
  assert.equal(data.cards.length, 1);
  assert.equal(data.image_occlusion_suggestions.length, 1);
});

test('字段名不同的外壳也能认（{"data":[…]} / {"result":{"cards":[…]}}）', () => {
  assert.equal(parseGeneratedJson(JSON.stringify({ data: [CARD] })).cards.length, 1);
  assert.equal(parseGeneratedJson(JSON.stringify({ result: { cards: [CARD] } })).cards.length, 1);
});

test('正文里的方括号不该把解析带偏（数组不像卡片列表就退回对象）', () => {
  const text = '参考 [1] 的写法：{"cards":[{"type":"basic","front":"X","back":"Y"}]}';
  assert.equal(parseGeneratedJson(text).cards.length, 1);
});

test('确实是空的时候不要瞎编卡片', () => {
  assert.deepEqual(normalizeCards({ cards: [] }).cards, []);
  assert.deepEqual(normalizeCards(null).cards, []);
  assert.equal(normalizeCards({ note: '没有卡片' }).cards, undefined);
});

test('别的对象不受影响，仍然原样返回', () => {
  assert.equal(extractFirstJson(JSON.stringify({ prompt: '标题', sections: [] })).prompt, '标题');
});

test('字符串里的括号不参与配对（答案里带 { } 也不怕）', () => {
  const text = '{"cards":[{"type":"basic","front":"用 {} 表示集合","back":"好"}]}';
  assert.equal(parseGeneratedJson(text).cards.length, 1);
  assert.equal(parseGeneratedJson(text).cards[0].front, '用 {} 表示集合');
});

/* ===== 真机那条「Expected property name or '}' in JSON at position 2」 =====
 * 模型偶尔把 JSON 的引号吐成全角 “ ”，JSON.parse 一律不认；旧实现只修 ASCII 单引号，
 * 于是整批生成直接报 position 2。现在走宽容解析器（全角引号 / 裸键 / 尾随逗号 / LaTeX 反斜杠）。 */
test('全角引号 JSON：{ “cards”: … } 要能解出来（真机 position 2 原样）', () => {
  const text = '{\n  “cards”: [\n    {“type”: “basic”, “front”: “正面”, “back”: “背面”}\n  ]\n}';
  const data = parseGeneratedJson(text);
  assert.equal(data.cards.length, 1);
  assert.equal(data.cards[0].front, '正面');
});

test('全角引号里再嵌中文引号：正文不会被截断', () => {
  const text = '{“cards”:[{“type”:“basic”,“front”:“他说：“你好””,“back”:“ok”}]}';
  assert.equal(parseGeneratedJson(text).cards[0].front, '他说：“你好”');
});

test('键不加引号 / 尾随逗号 / 全角逗号都认', () => {
  const text = '{cards: [{type: "basic", front: "A", back: "B",}],}';
  assert.equal(parseGeneratedJson(text).cards.length, 1);
});

test('LaTeX 反斜杠原样保留（\frac / \times 不能变成控制字符）', () => {
  const text = '{"cards":[{"type":"basic","front":"$\\frac{1}{2}$","back":"\\times 3"}]}';
  const card = parseGeneratedJson(text).cards[0];
  assert.equal(card.front, '$\\frac{1}{2}$');
  assert.equal(card.back, '\\times 3');
});

test('填空卡写成 front 时自动搬进 text（否则「填空卡缺少文本」整批导入失败）', () => {
  const text = JSON.stringify({ cards: [{ type: 'cloze', front: '学而{{c1::时习之}}', back: '按时温习' }] });
  const card = parseGeneratedJson(text).cards[0];
  assert.equal(card.text, '学而{{c1::时习之}}');
  assert.equal(shared.cardIssue(card), '', '归一之后应通过校验');
});

test('填空卡已经有 text 时不覆盖', () => {
  const card = { type: 'cloze', text: '正{{c1::解}}', front: '别的' };
  assert.equal(shared.coerceCards([card])[0].text, '正{{c1::解}}');
});

test('实在不是 JSON 时报人话，并带上出错位置的原文', () => {
  assert.throws(() => parseGeneratedJson('好的，我这就为你生成卡片。'), /不是可用的卡片 JSON/);
  try {
    parseGeneratedJson('{ “cards”: [ 坏掉的结构');
    assert.fail('应该抛错');
  } catch (error) {
    assert.match(error.message, /不是可用的卡片 JSON/);
    assert.match(error.message, /原始回复开头：/);
  }
});

/* ===== 分组：页码不是分组 ===== */
test('group 为空时不再用 source.page 造出「第 N 页」牌组', () => {
  const cache = new Map();
  assert.equal(shared.deckForCard({ group: '', source: { page: 3 } }, '父', true, cache), '父');
  assert.equal(shared.deckForCard({ source: { section: '第 3 页' } }, '父', true, cache), '父', '纯页码的 section 也不算分组');
  assert.equal(shared.deckForCard({ group: '第一课时' }, '父', true, cache), '父::第一课时');
});
