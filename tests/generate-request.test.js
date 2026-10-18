'use strict';
/*
 * 生成请求的「保护层」回归测试（真机教训）：
 *   1) 以前请求体只有 model/messages/temperature —— 推理模型把预算全花在思考上，正文一个字都没有；
 *   2) 模型只回中文说明不吐 JSON 时，以前直接把解析错误甩给用户（JSON at position N）；
 *   3) 网关不认 thinking / response_format 时不能整批失败，要能降级。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../src/shared');

const subject = {
  id: 'wenyan',
  name: '语文',
  cardCount: { min: 5, max: 10 },
  cardMode: { field: 'depth', promptVar: 'depth', options: [{ value: 'normal', prompt: '深度：常规' }] },
  prompts: { generate: '你是文言文 Anki 制卡引擎。范围 {{min}}–{{max}} 张。{{extra}}{{depth}}', reference: '调研：{{reference}}' }
};
const data = { url: 'https://api.example.com/v1/', key: 'k', model: 'deepseek-flash', images: ['data:image/png;base64,AA'] };
const content = [{ type: 'text', text: '制卡' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }];

test('请求体带上了 max_tokens / JSON 模式 / 关思考', () => {
  const body = JSON.parse(shared.chatRequest(subject, data, content).init.body);
  assert.equal(body.max_tokens, 16384, '默认给 16384（真机 8192 会把 96 张卡截断）');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.model, 'deepseek-flash');
});

test('调用方可以显式给更小的 max_tokens', () => {
  const body = JSON.parse(shared.chatRequest(subject, { ...data, maxTokens: 2048 }, content).init.body);
  assert.equal(body.max_tokens, 2048);
});

test('降级顺序：全功能 → 输出上限降到 8192 → 只留 JSON 模式 → 最保守', () => {
  const attempts = shared.chatRequests(subject, data, content).map(item => JSON.parse(item.init.body));
  assert.equal(attempts.length, 4);
  assert.ok(attempts[0].thinking && attempts[0].response_format);
  assert.equal(attempts[0].max_tokens, 16384);
  assert.equal(attempts[1].max_tokens, 8192, '网关卡 8192 时降一级');
  assert.ok(!attempts[2].thinking && attempts[2].response_format);
  assert.ok(!attempts[3].thinking && !attempts[3].response_format);
  attempts.forEach(body => assert.ok(body.max_tokens >= 8192, 'max_tokens 一直都要带上'));
});

test('只有「不认这个参数」才降级；余额/模型名错误照原样抛', () => {
  assert.equal(shared.looksLikeUnsupported(400, '{"error":{"message":"Unknown parameter: thinking"}}'), true);
  assert.equal(shared.looksLikeUnsupported(422, 'unrecognized field response_format'), true);
  assert.equal(shared.looksLikeUnsupported(400, '{"error":{"message":"Insufficient balance"}}'), false);
  assert.equal(shared.looksLikeUnsupported(401, 'invalid api key'), false);
});

test('网关不认 thinking 时自动降级重试，最终拿到卡片', async () => {
  const seen = [];
  const send = async request => {
    const body = JSON.parse(request.init.body);
    seen.push(body);
    if (body.thinking) return { status: 400, bodyText: '{"error":{"message":"Unknown parameter: thinking"}}' };
    return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: '{"cards":[{"type":"basic","front":"A","back":"B"}]}' } }] }) };
  };
  const { generated, rounds } = await shared.generateCards({
    subject, data, content, send, parse: text => shared.parseGeneratedJson(text)
  });
  assert.equal(generated.cards.length, 1);
  assert.equal(rounds, 1);
  assert.equal(seen.length, 3, '前两次都带 thinking 被拒，第三次去掉'); 
  assert.ok(!seen[2].thinking);
});

test('网关卡 max_tokens 上限时自动降到 8192', async () => {
  const seen = [];
  const send = async request => {
    const body = JSON.parse(request.init.body);
    seen.push(body.max_tokens);
    if (body.max_tokens > 8192) return { status: 400, bodyText: '{"error":{"message":"max_tokens is too large"}}' };
    return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: '{"cards":[{"type":"basic","front":"A","back":"B"}]}' } }] }) };
  };
  const { generated } = await shared.generateCards({ subject, data, content, send, parse: text => shared.parseGeneratedJson(text) });
  assert.equal(generated.cards.length, 1);
  assert.deepEqual(seen, [16384, 8192]);
});

test('模型只给说明文字时，带纠正语重试一次（不会让用户看到 position N）', async () => {
  const bodies = [];
  const send = async request => {
    const body = JSON.parse(request.init.body);
    bodies.push(body);
    if (bodies.length === 1) return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: '好的，我这就为你梳理这些文言文的考点。' } }] }) };
    return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: '```json\n{"cards":[{"type":"basic","front":"C","back":"D"}]}\n```' } }] }) };
  };
  const { generated, rounds } = await shared.generateCards({ subject, data, content, send, parse: text => shared.parseGeneratedJson(text) });
  assert.equal(generated.cards.length, 1);
  assert.equal(rounds, 2);
  const lastText = bodies[1].messages[0].content.at(-1).text;
  assert.match(lastText, /只输出一个 JSON 对象/, '纠正语要再次强调只输出 JSON');
  assert.match(lastText, /没法解析成卡片 JSON/);
  assert.equal(bodies[1].messages[0].content.filter(item => item.type === 'image_url').length, 1, '重试仍带上原图');
});

test('两次都解析不出来时抛出人话错误', async () => {
  const send = async () => ({ status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: '说明文字' } }] }) });
  await assert.rejects(
    () => shared.generateCards({ subject, data, content, send, parse: text => shared.parseGeneratedJson(text) }),
    /不是可用的卡片 JSON/
  );
});

test('思考吃光预算时说明白（而不是「AI 未返回卡片内容」）', async () => {
  const send = async () => ({ status: 200, bodyText: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '很长很长的思考' } }] }) });
  await assert.rejects(
    () => shared.generateCards({ subject, data, content, send, parse: text => shared.parseGeneratedJson(text) }),
    /花在思考上/
  );
});

test('用户规则（全局 + 本次）合成一段最高优先级约束：放在图片之前，且不重复', () => {
  const messages = shared.generateMessages(subject, { ...data, globalRules: ['表格才用遮挡卡', '   ', '填空卡只用 c1'], extraRules: '多出比较卡' });
  const rulesAt = messages.findIndex(item => item.type === 'text' && item.text.includes('最高优先级'));
  assert.ok(rulesAt > -1, '要有最高优先级规则块');
  assert.match(messages[rulesAt].text, /1\. 表格才用遮挡卡/);
  assert.match(messages[rulesAt].text, /2\. 填空卡只用 c1/, '空白的规则条目要丢掉');
  assert.match(messages[rulesAt].text, /本次额外生成规则（最高优先级）：\n多出比较卡/);
  const imageAt = messages.findIndex(item => item.type === 'image_url');
  assert.ok(imageAt > -1 && rulesAt < imageAt, '规则要排在图片之前（消息末尾得是图片）');
  assert.equal(messages.filter(item => item.type === 'text' && item.text.includes('多出比较卡')).length, 1, '规则不能用两种写法各拼一次');
});

test('没写规则时不多塞空块', () => {
  const messages = shared.generateMessages(subject, { ...data, globalRules: ['  '], extraRules: '   ' });
  assert.ok(!messages.some(item => item.type === 'text' && item.text.includes('最高优先级')));
  assert.equal(shared.rulesBlock({ globalRules: [], extraRules: '' }), null);
});

test('深度思考：不传 thinking、上限抬到 32768；关着时仍关思考、上限 16384', () => {
  const deep = JSON.parse(shared.chatRequest(subject, { ...data, deepThinking: true }, content).init.body);
  assert.equal(deep.max_tokens, shared.DEEP_MAX_OUTPUT_TOKENS);
  assert.equal(deep.thinking, undefined, '开深度思考就不要发 thinking 字段，让模型自己推');
  const chain = shared.chatRequests(subject, { ...data, deepThinking: true }, content).map(item => JSON.parse(item.init.body));
  assert.equal(chain.length, 4);
  assert.equal(chain[0].max_tokens, shared.DEEP_MAX_OUTPUT_TOKENS);
  assert.equal(chain[0].thinking, undefined);
  const off = JSON.parse(shared.chatRequest(subject, data, content).init.body);
  assert.deepEqual(off.thinking, { type: 'disabled' });
  assert.equal(off.max_tokens, 16384);
});

test('本批页范围写进提示词（别再让模型每张都猜第 1 页）', () => {
  const messages = shared.generateMessages(subject, {
    ...data,
    sources: [{ file: 'a.pdf', page: 1 }, { file: 'a.pdf', page: 2 }, { file: 'a.pdf', page: 3 }]
  });
  const text = messages.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.match(text, /本批材料范围/);
  assert.match(text, /第 1–3 页/);
  assert.match(text, /source.page/);
});

test('无需图片：没有图片/资料，只写了「本次额外生成规则」也能组装请求（用户 task7）', () => {
  const messages = shared.generateMessages(subject, {
    url: 'https://api.example.com/v1/', key: 'k', model: 'm', images: [],
    extraRules: '生成 3 张普通卡，主题：细胞膜的结构与功能'
  });
  assert.equal(messages.filter(item => item.type === 'image_url').length, 0, '没有图片就不带 image_url');
  const text = messages.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.match(text, /本次没有上传任何图片或资料文本/, '要明确告诉模型本次无图、按额外规则来');
  assert.match(text, /本次额外生成规则（最高优先级）：\n生成 3 张普通卡/);
  // 回归：既没图、也没资料、也没规则时照旧拦下
  assert.throws(
    () => shared.generateMessages(subject, { url: 'https://api.example.com/v1/', key: 'k', model: 'm', images: [] }),
    /缺少 API、模型或图片/
  );
  // 全局规则同样能驱动
  const byGlobal = shared.generateMessages(subject, { url: 'https://api.example.com/v1/', key: 'k', model: 'm', images: [], globalRules: ['生成 5 张比较卡'] });
  assert.ok(byGlobal.some(item => item.type === 'text' && item.text.includes('本次没有上传任何图片')));
});

test('单卡重试：送给模型的卡片不带 base64 媒体，解析时再从原卡片补回（用户 task4）', () => {
  const image = 'data:image/png;base64,' + 'A'.repeat(4000);
  const audio = 'data:audio/wav;base64,' + 'B'.repeat(4000);
  const occ = { type: 'occlusion', front: '识别图中遮挡部分', back: '答案', image, masks: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }], imageIndex: 0 };
  const prompt = shared.retryPrompt(subject, occ, '更精炼一点');
  assert.ok(!prompt.includes('A'.repeat(100)), '遮挡卡图片 base64 不得进入提示词（否则模型照抄把输出撑爆）');
  assert.ok(!/"imageIndex"\s*:/.test(prompt), 'imageIndex 也要从卡片 JSON 里去掉');
  assert.match(prompt, /不要输出 image、audio、imageIndex/);
  const copy = shared.retryCardForPrompt(occ);
  assert.equal(copy.image, undefined);
  assert.equal(copy.imageIndex, undefined);
  assert.deepEqual(copy.masks, occ.masks, '遮挡框本身不是 base64，保留');

  const next = shared.parseRetry(JSON.stringify({ cards: [{ type: 'occlusion', front: '新正面', back: '新背面' }] }), null, occ);
  assert.equal(next.image, image, '重试后图片要从原卡片补回来，不能丢');
  assert.deepEqual(next.masks, occ.masks, '遮挡框也要补回来');

  const audioCard = { type: 'audio', front: '精听并默写', back: 'Line one.', speak: 'Line one.' , audio };
  assert.equal(shared.retryCardForPrompt(audioCard).audio, undefined, '音频 base64 不进提示词');
  const nextAudio = shared.parseRetry(JSON.stringify({ cards: [{ type: 'audio', front: '精听并默写', back: 'Line one.', speak: 'Line one.' }] }), null, audioCard);
  assert.equal(nextAudio.audio, audio, 'speak 没变时沿用原音频');
  const changed = shared.parseRetry(JSON.stringify({ cards: [{ type: 'audio', front: 'x', back: 'y', speak: 'Line two.' }] }), null, audioCard);
  assert.equal(changed.audio, undefined, 'speak 变了就不沿用旧音频（要用新文本重新合成）');
});

test('生成后按 enabledTypes 过滤：只勾音频卡时，模型给的普通卡会被剔掉（用户反馈）', async () => {
  const send = async () => ({ status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cards: [
    { type: 'basic', front: 'A', back: 'B' },
    { type: 'cloze', text: '{{c1::A}}' },
    { type: 'audio', front: '听音', back: 'B', speak: 'B' }
  ] }) } }] }) });
  const { generated } = await shared.generateCards({
    subject, data: { ...data, enabledTypes: ['audio'] }, content, send, parse: text => shared.parseGeneratedJson(text)
  });
  assert.deepEqual(generated.cards.map(card => card.type), ['audio'], '只留勾选的类型');
});

test('生成后过滤：勾选类型一张都没剩时，抛人话错误而不是给空批次', async () => {
  const send = async () => ({ status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: '{"cards":[{"type":"basic","front":"A","back":"B"}]}' } }] }) });
  await assert.rejects(
    () => shared.generateCards({ subject, data: { ...data, enabledTypes: ['audio'] }, content, send, parse: text => shared.parseGeneratedJson(text) }),
    /只勾选了音频卡/
  );
});

test('生成后过滤：四个类型都勾（或没给 enabledTypes）时不限制', async () => {
  const send = async () => ({ status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: '{"cards":[{"type":"basic","front":"A","back":"B"},{"type":"cloze","text":"{{c1::A}}"}]}' } }] }) });
  const { generated } = await shared.generateCards({
    subject, data: { ...data, enabledTypes: ['basic', 'cloze', 'occlusion', 'audio'] }, content, send, parse: text => shared.parseGeneratedJson(text)
  });
  assert.equal(generated.cards.length, 2);
});

/* ===== 真机反馈（2026-10-18）：min=1/max=1 一次出 4-5 张 —— 提示词之外要有硬截断 ===== */

test('maxCards 硬截断：超量时按 P1 优先留下，顺序保持原批次，并报出截了几张', async () => {
  const send = async () => ({ status: 200, bodyText: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"cards":[]}' } }] }) });
  const parse = () => ({ cards: [
    { type: 'basic', priority: 'P2', front: 'A', back: 'a' },
    { type: 'basic', priority: 'P1', front: 'B', back: 'b' },
    { type: 'cloze', priority: 'P1', text: 'C{{c1::c}}' },
    { type: 'basic', priority: 'P3', front: 'D', back: 'd' },
    { type: 'basic', priority: 'P1', front: 'E', back: 'e' }
  ] });
  const { generated } = await shared.generateCards({
    subject, data: { ...data, maxCards: 3 }, content, send, parse
  });
  assert.deepEqual(generated.cards.map(card => card.front || card.text), ['B', 'C{{c1::c}}', 'E'], '三张 P1 全保，P2/P3 落选');
  assert.equal(generated.clamped, 2, '截掉几张要告诉调用方');
  assert.equal(generated.cards[0].front, 'B', '留下的卡保持原批次顺序');
});

test('maxCards 硬截断：没超量、没给 maxCards、给 0 时不截断也不报错', async () => {
  const send = async () => ({ status: 200, bodyText: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"cards":[]}' } }] }) });
  const cards = [{ type: 'basic', priority: 'P1', front: 'A', back: 'a' }];
  const one = await shared.generateCards({ subject, data: { ...data, maxCards: 5 }, content, send, parse: () => ({ cards }) });
  assert.equal(one.generated.cards.length, 1);
  assert.equal(one.generated.clamped, undefined);
  const none = await shared.generateCards({ subject, data: { ...data }, content, send, parse: () => ({ cards }) });
  assert.equal(none.generated.cards.length, 1, '没给 maxCards 就不截断（电脑版老调用方式不受影响）');
  const zero = await shared.generateCards({ subject, data: { ...data, maxCards: 0 }, content, send, parse: () => ({ cards }) });
  assert.equal(zero.generated.cards.length, 1, 'maxCards=0 视作未设置');
});

test('单卡重试：遮挡卡允许模型微调 masks（返回了就用，垃圾数据沿用原框）', () => {
  const occ = { type: 'occlusion', front: '识别图中遮挡部分', back: '答案', image: 'data:image/png;base64,AA', masks: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }] };
  const prompt = shared.retryPrompt(subject, occ, '遮挡框偏了，往右挪一点');
  assert.match(prompt, /masks 是归一化矩形数组/, '遮挡卡的重试提示词要说明 masks 可以调');
  // 模型返回了能用的 masks：夹回 0–1 后采用
  const adjusted = shared.parseRetry(JSON.stringify({ cards: [{ type: 'occlusion', front: '新正面', masks: [{ x: 0.3, y: 0.2, w: 0.3, h: 0.4 }] }] }), null, occ);
  assert.deepEqual(adjusted.masks, [{ x: 0.3, y: 0.2, w: 0.3, h: 0.4 }], '新遮挡框要采用');
  // 模型返回垃圾 masks：沿用原框，不出坏卡
  const garbage = shared.parseRetry(JSON.stringify({ cards: [{ type: 'occlusion', front: '新正面', masks: [{ x: '偏了', y: 0.2, w: 0.3, h: 0.4 }] }] }), null, occ);
  assert.deepEqual(garbage.masks, occ.masks, '垃圾 masks 沿用原框');
  // 越界的数值要夹回 0–1
  const outOfRange = shared.parseRetry(JSON.stringify({ cards: [{ type: 'occlusion', front: '新正面', masks: [{ x: 1.1, y: -0.1, w: 0.3, h: 0.4 }] }] }), null, occ);
  assert.deepEqual(outOfRange.masks, [{ x: 1, y: 0, w: 0.3, h: 0.4 }], '轻微越界夹回 0–1');
  assert.equal(shared.masksUsable([{ x: 0, y: 0, w: 0.1, h: 0.1 }]), true);
  assert.equal(shared.masksUsable([{ x: 'a', y: 0, w: 0.1, h: 0.1 }]), false);
  assert.equal(shared.masksUsable([]), false);
});
