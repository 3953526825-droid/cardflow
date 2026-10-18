'use strict';
/*
 * 多家检索服务商的适配：每家只看两件事 —— 请求怎么发、响应怎么拆成 {title,url,content}。
 * 这里用假 transport 把 7 家的请求形状和解析都钉住，换服务商不用真联网。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../src/shared');

const { searchWithProvider, listSearchProviders, tavilySearch } = shared;

function fake(response) {
  const seen = [];
  const transport = async request => { seen.push(request); return { status: 200, body: JSON.stringify(response) }; };
  return { transport, seen };
}

test('服务商清单：常用几家都在，且都带 label / keyLabel / keyHint', () => {
  const list = listSearchProviders();
  const ids = list.map(item => item.id);
  for (const id of ['tavily', 'bocha', 'serper', 'bing', 'brave', 'exa', 'searxng']) assert.ok(ids.includes(id), `缺 ${id}`);
  for (const item of list) {
    assert.ok(item.label, `${item.id} 缺 label`);
    assert.equal(typeof item.needsKey, 'boolean');
    if (item.needsKey) assert.ok(item.keyLabel, `${item.id} 需要 Key 却没有 keyLabel`);
  }
  assert.equal(list.find(item => item.id === 'searxng').needsKey, false, 'SearXNG 自建不用 Key');
});

test('Tavily：Bearer 头 + results', async () => {
  const { transport, seen } = fake({ answer: '摘要', results: [{ title: 'A', url: 'https://a.com', content: 'x' }] });
  const found = await searchWithProvider(transport, 'tavily', { key: 'tvly-1', query: '高中生 细胞' });
  assert.equal(seen[0].url, 'https://api.tavily.com/search');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers.authorization, 'Bearer tvly-1');
  assert.equal(JSON.parse(seen[0].body).query, '高中生 细胞');
  assert.equal(found.provider, 'Tavily');
  assert.equal(found.items.length, 1);
});

test('博查：Bearer 头 + data.webPages.value', async () => {
  const { transport, seen } = fake({ code: 200, data: { webPages: { value: [{ name: '标题', url: 'https://b.com', snippet: '片段', summary: '摘要' }] } } });
  const found = await searchWithProvider(transport, 'bocha', { key: 'sk-1', query: '文言文' });
  assert.equal(seen[0].url, 'https://api.bochaai.com/v1/web-search');
  assert.equal(seen[0].headers.authorization, 'Bearer sk-1');
  assert.equal(JSON.parse(seen[0].body).count, 10);
  assert.deepEqual(found.items[0], { title: '标题', url: 'https://b.com', content: '摘要' });
});

test('Serper：X-API-KEY 头 + organic', async () => {
  const { transport, seen } = fake({ organic: [{ title: 'T', link: 'https://c.com', snippet: 'S' }] });
  const found = await searchWithProvider(transport, 'serper', { key: 'k', query: 'q' });
  assert.equal(seen[0].url, 'https://google.serper.dev/search');
  assert.equal(seen[0].headers['X-API-KEY'], 'k');
  assert.equal(JSON.parse(seen[0].body).gl, 'cn');
  assert.deepEqual(found.items[0], { title: 'T', url: 'https://c.com', content: 'S' });
});

test('Bing：GET 查询串 + webPages.value', async () => {
  const { transport, seen } = fake({ webPages: { value: [{ name: 'N', url: 'https://d.com', snippet: 'S' }] } });
  const found = await searchWithProvider(transport, 'bing', { key: 'bk', query: '虚实词' });
  assert.equal(seen[0].method, 'GET');
  assert.ok(seen[0].url.includes('api.bing.microsoft.com'));
  assert.ok(seen[0].url.includes('count='));
  assert.equal(seen[0].headers['Ocp-Apim-Subscription-Key'], 'bk');
  assert.equal(found.items[0].title, 'N');
});

test('Brave：X-Subscription-Token + web.results', async () => {
  const { transport, seen } = fake({ web: { results: [{ title: 'BT', url: 'https://e.com', description: 'D' }] } });
  const found = await searchWithProvider(transport, 'brave', { key: 'br', query: 'q' });
  assert.ok(seen[0].url.includes('api.search.brave.com'));
  assert.equal(seen[0].headers['X-Subscription-Token'], 'br');
  assert.equal(found.items[0].content, 'D');
});

test('Exa：x-api-key + results[].text', async () => {
  const { transport, seen } = fake({ results: [{ title: 'ET', url: 'https://f.com', text: '正文' }] });
  const found = await searchWithProvider(transport, 'exa', { key: 'ex', query: 'q' });
  assert.equal(seen[0].headers['x-api-key'], 'ex');
  assert.equal(JSON.parse(seen[0].body).numResults, 10);
  assert.equal(found.items[0].content, '正文');
});

test('SearXNG：不要 Key，但要填地址；/search?format=json', async () => {
  const { transport, seen } = fake({ results: [{ title: 'ST', url: 'https://g.com', content: 'C' }] });
  const found = await searchWithProvider(transport, 'searxng', { query: 'q', url: 'https://searx.example.com/' });
  assert.ok(seen[0].url.startsWith('https://searx.example.com/search?'));
  assert.ok(seen[0].url.includes('format=json'));
  assert.equal(found.items[0].title, 'ST');
  await assert.rejects(() => searchWithProvider(transport, 'searxng', { query: 'q' }), /需要填接口地址/);
});

test('没配 Key 时按服务商名字报错，而不是笼统提 Tavily', async () => {
  const { transport } = fake({});
  await assert.rejects(() => searchWithProvider(transport, 'bocha', { key: '', query: 'q' }), /博查 Key/);
});

test('知乎站内：Tavily 用 include_domains，其它服务商退化成 site: 算子', async () => {
  const a = fake({ results: [] });
  await searchWithProvider(a.transport, 'tavily', { key: 'k', query: 'q', allowDomains: ['zhihu.com'] });
  assert.deepEqual(JSON.parse(a.seen[0].body).include_domains, ['zhihu.com']);
  const b = fake({ organic: [] });
  await searchWithProvider(b.transport, 'serper', { key: 'k', query: 'q', allowDomains: ['zhihu.com'] });
  assert.ok(JSON.parse(b.seen[0].body).q.includes('site:zhihu.com'));
});

test('HTTP 错误要把服务商自己的报错带出来', async () => {
  const transport = async () => ({ status: 401, body: JSON.stringify({ message: 'Invalid API key' }) });
  await assert.rejects(() => searchWithProvider(transport, 'serper', { key: 'k', query: 'q' }), /Invalid API key/);
});

test('tavilySearch 的来源标签跟着服务商走', async () => {
  const { transport } = fake({ organic: [{ title: 'X', link: 'https://h.com/a', snippet: '这是一段足够长的正文内容，用来通过检索结果清洗里四十个字符的下限检查，顺便确认清洗之后仍然只保留一条。' }] });
  const found = await tavilySearch(transport, 'k', 'q', 5, { provider: 'serper' });
  assert.equal(found.provider, 'Serper（Google）');
  assert.equal(found.results.length, 1);
});
