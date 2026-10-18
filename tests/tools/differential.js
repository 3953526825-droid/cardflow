'use strict';
/*
 * 重构前后差异测试：把「旧的单学科服务」与「合并后的多学科服务」放在同一批请求下对拍。
 *
 * 比较三样东西：
 *   1) HTTP 状态码与响应体（逐字）
 *   2) 发给 AI 的请求体（也就是提示词，逐字）与发给 AnkiConnect 的调用
 *   3) 发给知乎 MCP / Jina 的请求
 * 这是「行为完全不变」最直接的一层证据：同一输入，两边看到的外部行为必须一模一样。
 *
 * 用法：node tests/tools/differential.js [bio|chem]
 */
const path = require('path');
const assert = require('node:assert/strict');

const { startServer } = require('../helpers/harness');
const { startFakeAnki, startFakeAi, startFakeJina, startFakeZhihu } = require('../helpers/fakes');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OLD_ENTRIES = {
  bio: 'C:/Users/Administrator/Bio2Anki/server.js',
  chem: 'C:/Users/Administrator/Chem2Anki/server.js'
};

const ZHIHU_ITEMS = [
  { title: '细胞膜的结构 考点总结', url: 'https://www.zhihu.com/question/100?utm=1', author: '某老师', score: 0.9, content: '细胞膜以磷脂双分子层为基本骨架，蛋白质镶嵌其中，具有流动性和选择透过性，是高考高频考点。' },
  { title: '流动镶嵌模型 易错点', url: 'https://zhuanlan.zhihu.com/p/200', author: '教研组', score: 0.8, content: '易错点：磷脂双分子层是基本骨架而不是蛋白质；糖蛋白只分布在细胞膜外侧，用于识别。' }
];

/** 假 AI：按提示词内容分别返回「读图定主题」「锁定章节」或「卡片 JSON」。 */
function smartResponder(body) {
  const content = body && body.messages && body.messages[0] && body.messages[0].content;
  const text = Array.isArray(content) ? String((content.find(part => part.type === 'text') || {}).text || '') : String(content || '');
  if (text.includes('资料分析助手')) return JSON.stringify({ topic: '细胞膜的结构与功能', keypoints: ['磷脂双分子层', '选择透过性'] });
  if (text.includes('教材章节定位助手')) return JSON.stringify({ position: '必修1 第3章 第1节 细胞膜——系统的边界', topic: '细胞膜的结构', examQueries: ['必修1 细胞膜 讲义', '细胞膜 选择透过性 高考 易错点'] });
  return JSON.stringify({
    cards: [
      { type: 'basic', priority: 'P1', tags: ['测试'], front: '细胞膜的基本骨架是什么？', back: '磷脂双分子层', note: '' },
      { type: 'cloze', priority: 'P2', tags: ['测试'], text: '细胞膜具有{{c1::选择透过性}}', note: '' }
    ],
    image_occlusion_suggestions: []
  });
}

async function startStack(subject, entry, args) {
  const anki = await startFakeAnki(['Default', '生物::细胞膜']);
  const ai = await startFakeAi(smartResponder);
  const jina = await startFakeJina();
  const zhihu = await startFakeZhihu({ items: ZHIHU_ITEMS });
  const server = await startServer({
    subject: entry ? '' : subject,
    entry,
    args,
    ankiUrl: anki.url,
    jinaBase: jina.url,
    zhihuBase: zhihu.url,
    config: { zhihuKey: 'test-zhihu-key', tavilyKey: 'test-tavily-key', apiKey: 'test-api-key' }
  });
  return { anki, ai, jina, zhihu, server };
}

async function stopStack(stack) {
  await stack.server.stop();
  await stack.zhihu.close();
  await stack.jina.close();
  await stack.ai.close();
  await stack.anki.close();
}

/** 同一批场景跑一遍，收集「外部可见行为」。 */
async function collect(stack) {
  const { server, ai, anki, jina, zhihu } = stack;
  const ask = async (name, pathname, options) => {
    const response = await server.api(pathname, options);
    return { name, status: response.status, body: response.json === null ? response.text : JSON.stringify(response.json) };
  };
  const image = 'data:image/png;base64,QUFBQQ==';

  const results = [];
  results.push(await ask('config', '/api/config'));
  results.push(await ask('health', '/api/health'));
  results.push(await ask('decks', '/api/decks'));
  results.push(await ask('deck-create-bad', '/api/deck/create', { method: 'POST', body: { deck: '生物::::细胞' } }));
  results.push(await ask('deck-create', '/api/deck/create', { method: 'POST', body: { deck: '差异测试牌组::子牌组' } }));
  results.push(await ask('deck-delete-preview', '/api/deck/delete', { method: 'POST', body: { deck: '差异测试牌组', dryRun: true } }));
  results.push(await ask('deck-delete', '/api/deck/delete', { method: 'POST', body: { deck: '差异测试牌组' } }));
  results.push(await ask('models', '/api/models', { method: 'POST', body: { url: ai.url, key: 'k' } }));
  results.push(await ask('generate-plain', '/api/generate', { method: 'POST', body: { url: ai.url, key: 'k', model: 'm', images: [image] } }));
  results.push(await ask('generate-reference', '/api/generate', { method: 'POST', body: { url: ai.url, key: 'k', model: 'm', images: [image], reference: '细胞膜是高考高频考点。', minCards: 12, maxCards: 18, extraRules: '多出比较卡' } }));
  results.push(await ask('generate-long', '/api/generate', { method: 'POST', body: { url: ai.url, key: 'k', model: 'm', images: [image], reference: 'B'.repeat(21000) } }));
  results.push(await ask('research', '/api/research', { method: 'POST', body: { url: ai.url, key: 'k', model: 'm', images: [image] } }));
  results.push(await ask('search-zhihu', '/api/search', { method: 'POST', body: { query: '细胞膜 考点', channel: 'zhihu', maxResults: 4 } }));
  results.push(await ask('search-global', '/api/search', { method: 'POST', body: { query: '细胞膜 考点', channel: 'global', maxResults: 4 } }));
  results.push(await ask('fetch', '/api/fetch', { method: 'POST', body: { url: 'https://example.com/normal', limit: 800 } }));
  results.push(await ask('fetch-bad', '/api/fetch', { method: 'POST', body: { url: 'nope' } }));
  results.push(await ask('normalize', '/api/normalize', { method: 'POST', body: { cards: [{ type: 'basic', front: 'H2O', back: '\\ce{H2O}', tags: [] }] } }));
  results.push(await ask('import', '/api/import', { method: 'POST', body: { deck: '生物::细胞膜', cards: [{ type: 'basic', front: 'Q', back: 'A' }, { type: 'cloze', text: '含 {{c1::答案}} 的句子' }] } }));
  results.push(await ask('unknown', '/api/does-not-exist'));
  results.push({ name: 'unauthorized', ...(await (async () => {
    const response = await server.raw('/api/decks');
    return { status: response.status, body: response.text };
  })()) });

  return {
    results,
    aiPrompts: ai.requests.filter(item => item.body).map(item => JSON.stringify(item.body)),
    ankiCalls: anki.state.calls,
    jinaRequests: jina.requests.map(item => item.url),
    zhihuCalls: zhihu.state.posts.map(item => JSON.stringify(item)).sort() // 两个通道并发，比较时按集合看
  };
}

function compare(label, oldValue, newValue) {
  const a = JSON.stringify(oldValue, null, 1).split('\n');
  const b = JSON.stringify(newValue, null, 1).split('\n');
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) diffs.push(`  第 ${i + 1} 行\n    旧: ${a[i]}\n    新: ${b[i]}`);
  }
  if (diffs.length) {
    console.log(`✖ ${label} 有 ${diffs.length} 处不同`);
    diffs.slice(0, 8).forEach(line => console.log(line));
  } else {
    console.log(`✔ ${label} 逐字一致`);
  }
  return diffs.length;
}

(async () => {
  const subject = process.argv[2] || 'bio';
  const oldStack = await startStack(subject, OLD_ENTRIES[subject], []);
  const newStack = await startStack(subject, '', []);
  try {
    const oldSeen = await collect(oldStack);
    const newSeen = await collect(newStack);

    let failures = 0;
    const oldByName = new Map(oldSeen.results.map(item => [item.name, item]));
    for (const item of newSeen.results) {
      const before = oldByName.get(item.name);
      if (before.status !== item.status || before.body !== item.body) {
        failures++;
        console.log(`✖ HTTP ${item.name}：${before.status} vs ${item.status}`);
        if (before.body !== item.body) console.log(`    旧: ${before.body.slice(0, 300)}\n    新: ${item.body.slice(0, 300)}`);
      } else {
        console.log(`✔ HTTP ${item.name}（${item.status}）逐字一致`);
      }
    }
    failures += compare('发给 AI 的请求（提示词）', oldSeen.aiPrompts, newSeen.aiPrompts);
    failures += compare('发给 AnkiConnect 的调用', oldSeen.ankiCalls, newSeen.ankiCalls);
    failures += compare('发给 Jina 的请求', oldSeen.jinaRequests, newSeen.jinaRequests);
    failures += compare('发给知乎 MCP 的请求', oldSeen.zhihuCalls, newSeen.zhihuCalls);

    console.log('');
    console.log(failures === 0 ? `差异测试通过：${subject} 重构前后外部行为完全一致` : `差异测试失败：${failures} 处不同`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await stopStack(oldStack);
    await stopStack(newStack);
  }
})();
