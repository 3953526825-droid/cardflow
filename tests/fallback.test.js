'use strict';
/*
 * D1 失败降级测试：
 *   - 知乎通道失败（HTTP 错误 / 超时 / 返回结构异常）时自动回退 Tavily，并在 provider 里标注；
 *   - 知乎站内与知乎全网两个通道各自独立降级，一个失败不影响另一个；
 *   - 知乎 MCP 超时后连接必须放掉（假 SSE 服务器的会话表要回到 0）。
 * 全程用假 Tavily / 假知乎，不花真实额度；也不碰真实 config。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const { startServer, sleep } = require('./helpers/harness');
const { startFakeAi, startFakeTavily, startFakeZhihu } = require('./helpers/fakes');

const ZHIHU_ITEMS = [
  { title: '知乎里的考点总结', url: 'https://www.zhihu.com/question/1', author: '某老师', score: 0.9, content: '这是知乎站内返回的内容，用来说明通道本身是通的，内容足够长以满足清洗规则的要求。' }
];

/** 假 AI：能分别回答「读图定主题」「锁定章节」和普通制卡请求。 */
function responder(body) {
  const content = body && body.messages && body.messages[0] && body.messages[0].content;
  const text = Array.isArray(content) ? String((content.find(part => part.type === 'text') || {}).text || '') : String(content || '');
  if (text.includes('资料分析助手')) return JSON.stringify({ topic: '细胞膜的结构与功能', keypoints: ['磷脂双分子层'] });
  if (text.includes('教材章节定位助手')) return JSON.stringify({ position: '必修1 第3章 第1节', topic: '细胞膜', examQueries: ['必修1 细胞膜 讲义', '细胞膜 选择透过性 高考 易错点'] });
  return JSON.stringify({ cards: [{ type: 'basic', priority: 'P1', tags: ['测试'], front: 'Q', back: 'A', note: '' }], image_occlusion_suggestions: [] });
}

const ctx = {};

before(async () => {
  ctx.tavily = await startFakeTavily();
  // zhihu_search 通道挂掉（HTTP 500），global_search 正常 —— 用来验证两个通道各自独立
  ctx.zhihuPartial = await startFakeZhihu({
    items: ZHIHU_ITEMS,
    failFor: channel => (channel === 'zhihu_search' ? 'http500' : null)
  });
  // 所有通道都不回 tools/call —— 用来验证超时
  ctx.zhihuHang = await startFakeZhihu({ items: ZHIHU_ITEMS, failFor: () => 'notools' });
  ctx.ai = await startFakeAi(responder);

  const common = {
    ankiUrl: 'http://127.0.0.1:1',
    jinaBase: 'http://127.0.0.1:1/',
    config: { zhihuKey: 'test-zhihu-key', tavilyKey: 'test-tavily-key', apiKey: 'test-api-key' },
    env: { ANKI_TAVILY_URL: ctx.tavily.url, ANKI_ZHIHU_RPC_TIMEOUT: '400', ANKI_ZHIHU_CONNECT_TIMEOUT: '2000' }
  };
  ctx.partial = await startServer({ subject: 'demo', zhihuBase: ctx.zhihuPartial.url, ...common });
  ctx.hang = await startServer({ subject: 'demo', zhihuBase: ctx.zhihuHang.url, ...common });
  // 没有 Tavily Key 的实例：知乎失败时应给出可读错误，而不是静默失败
  ctx.noFallback = await startServer({
    subject: 'demo',
    zhihuBase: ctx.zhihuPartial.url,
    ankiUrl: 'http://127.0.0.1:1',
    jinaBase: 'http://127.0.0.1:1/',
    config: { zhihuKey: 'test-zhihu-key', tavilyKey: '', apiKey: 'k' },
    env: { ANKI_TAVILY_URL: ctx.tavily.url, ANKI_ZHIHU_RPC_TIMEOUT: '400' }
  });
});

after(async () => {
  for (const key of ['partial', 'hang', 'noFallback']) if (ctx[key]) await ctx[key].stop();
  if (ctx.ai) await ctx.ai.close();
  if (ctx.zhihuPartial) await ctx.zhihuPartial.close();
  if (ctx.zhihuHang) await ctx.zhihuHang.close();
  if (ctx.tavily) await ctx.tavily.close();
});

test('知乎站内 HTTP 500 → 自动回退 Tavily，provider 里标注降级', async () => {
  const before = ctx.tavily.state.calls;
  const result = await ctx.partial.api('/api/search', { method: 'POST', body: { query: '细胞膜 考点', channel: 'zhihu', maxResults: 5 } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.provider, '知乎站内搜索（失败已回退 Tavily）');
  assert.ok(ctx.tavily.state.calls > before, '应当真的调用了 Tavily');
  assert.equal(result.json.results.length, 2);
  assert.match(result.json.results[0].title, /Tavily 结果/);
});

test('两个通道各自独立：知乎站内失败回退，知乎全网仍然走知乎', async () => {
  const global = await ctx.partial.api('/api/search', { method: 'POST', body: { query: '细胞膜 考点', channel: 'global', maxResults: 5 } });
  assert.equal(global.status, 200);
  assert.equal(global.json.provider, '知乎全网搜索', '全网通道没有失败，不该被站内通道拖下水');
  assert.match(global.json.results[0].title, /知乎里的考点总结/);

  const station = await ctx.partial.api('/api/search', { method: 'POST', body: { query: '细胞膜 考点', channel: 'zhihu', maxResults: 5 } });
  assert.equal(station.json.provider, '知乎站内搜索（失败已回退 Tavily）');
});

test('知乎超时 → 仍然返回 200 且结果来自 Tavily，连接不泄漏', async () => {
  const started = Date.now();
  const result = await ctx.hang.api('/api/search', { method: 'POST', body: { query: '细胞膜 考点', channel: 'zhihu', maxResults: 5 } });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.provider, '知乎站内搜索（失败已回退 Tavily）');
  assert.ok(elapsed < 10000, `超时应该在 RPC 上限附近就收场，实际 ${elapsed}ms`);
  await sleep(300);
  assert.equal(ctx.zhihuHang.state.sessions.size, 0, '超时后 SSE 会话必须被关掉，不能泄漏');
});

test('/api/research：知乎两条通道都失败时仍返回 200，provider 体现降级', async () => {
  const result = await ctx.partial.api('/api/research', { method: 'POST', body: { url: ctx.ai.url, key: 'k', model: 'm', images: ['data:image/png;base64,AAAA'] } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.ok(result.json.exams.length >= 1);
  for (const exam of result.json.exams) {
    assert.match(exam.provider, /回退 Tavily|Tavily/, `provider 应体现降级，实际：${exam.provider}`);
    assert.ok(exam.results.length > 0, '回退之后仍应有结果，而不是空手而归');
  }
});

test('纯文本文档可自动调研：无需图片即可读原文并定位考点', async () => {
  const result = await ctx.partial.api('/api/research', {method:'POST',body:{url:ctx.ai.url,key:'k',model:'m',images:[],sourceText:'教材原文：细胞膜的结构与功能，磷脂双分子层。'}});
  assert.equal(result.status,200,result.text);
  assert.equal(result.json.identify.topic,'细胞膜的结构与功能');
  assert.ok(result.json.exams.length > 0);
});

test('知乎失败且没有配 Tavily Key 时，报错要说清楚', async () => {
  const result = await ctx.noFallback.api('/api/search', { method: 'POST', body: { query: '细胞膜 考点', channel: 'zhihu', maxResults: 5 } });
  assert.equal(result.status, 400);
  assert.match(result.json.error, /没有配置 Tavily 兜底通道/);
});

test('/api/fetch：超时与非 200 都是可读中文（回归保护）', async () => {
  const bad = await ctx.partial.api('/api/fetch', { method: 'POST', body: { url: 'not-a-url' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /无效的链接/);
  const forbidden = await ctx.partial.api('/api/fetch', { method: 'POST', body: { url: 'https://example.com/nothing-listens-here' } });
  assert.equal(forbidden.status, 400);
  assert.match(forbidden.json.error, /抓取原文失败/);
});
