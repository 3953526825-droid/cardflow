'use strict';
/*
 * 测试用的本地假服务：AnkiConnect / AI 服务商 / Jina Reader / 知乎 MCP over SSE。
 * 全部零依赖，只监听 127.0.0.1 的随机端口，绝不接触真实外部 API。
 */
const http = require('http');

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => { try { server.close(() => resolve()); } catch (_) { resolve(); } });
}

/* ------------------------- 假 AnkiConnect ------------------------- */
async function startFakeAnki(initialDecks = [], options = {}) {
  const state = { decks: [...initialDecks], calls: [], cardCounts: new Map() };
  // 笔记类型的字段名可以按测试需要定制（真实 Anki 里 Cloze 的第二个字段新版叫 Back Extra）
  const modelFields = {
    Basic: ['Front', 'Back'],
    Cloze: ['Text', 'Extra'],
    ...(options.modelFields || {})
  };
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let payload = {};
    try { payload = JSON.parse(raw); } catch (_) {}
    const { action, params = {} } = payload;
    state.calls.push({ action, params });
    const reply = result => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result, error: null }));
    };
    try {
      switch (action) {
        case 'version': return reply(6);
        case 'deckNames': return reply([...state.decks]);
        case 'createDeck': {
          const deck = String(params.deck || '');
          if (deck && !state.decks.includes(deck)) state.decks.push(deck);
          return reply(state.decks.indexOf(deck) + 1);
        }
        case 'getDeckStats': {
          const out = {};
          (params.decks || []).forEach(deck => { out[String(deck)] = { deck, total_in_deck: state.cardCounts.get(deck) || 0 }; });
          return reply(out);
        }
        case 'deleteDecks': {
          const targets = params.decks || [];
          targets.forEach(deck => {
            state.decks = state.decks.filter(item => item !== deck && !item.startsWith(deck + '::'));
          });
          return reply(null);
        }
        case 'canAddNotes': return reply((params.notes || []).map(() => true));
        case 'sync': {
          // 模拟 AnkiWeb 同步：options.syncError 可以造出「未登录」或「要求全量同步」的报错
          if (options.syncError) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ result: null, error: options.syncError }));
          }
          state.syncs = (state.syncs || 0) + 1;
          return reply(null);
        }
        case 'modelFieldNames': return reply(modelFields[String(params.modelName)] || null);
        case 'storeMediaFile': {
          const filename = String(params.filename || 'media' + ((state.media || []).length + 1));
          state.media = state.media || [];
          state.media.push({ filename, data: params.data });
          return reply(filename);
        }
        case 'addNotes': return reply((params.notes || []).map((_, i) => 5000 + i));
        default:
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ result: null, error: `unsupported action ${action}` }));
      }
    } catch (error) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: null, error: error.message }));
    }
  });
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    callsFor: action => state.calls.filter(call => call.action === action),
    close: () => close(server)
  };
}

/* ------------------------- 假 AI 服务商 ------------------------- */
const DEFAULT_CARDS = JSON.stringify({
  cards: [
    { type: 'basic', priority: 'P1', tags: ['测试'], front: '测试问题', back: '测试答案', note: '' },
    { type: 'cloze', priority: 'P2', tags: ['测试'], text: '测试{{c1::填空}}句子', note: '' }
  ],
  image_occlusion_suggestions: []
});

async function startFakeAi(responder) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = null;
    try { body = JSON.parse(raw); } catch (_) {}
    const reply = value => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (/\/models$/.test(req.url || '')) {
      requests.push({ url: req.url, body });
      return reply({ data: [{ id: 'fake-model-b' }, { id: 'fake-model-a' }] });
    }
    requests.push({ url: req.url, headers: req.headers, body, raw });
    const content = typeof responder === 'function' ? responder(body, req) : (responder || DEFAULT_CARDS);
    if (content === null) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: '假 AI 故意失败' } })); }
    return reply({ choices: [{ message: { content } }] });
  });
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    last: () => requests[requests.length - 1],
    /** 取出最后一次请求里发给模型的提示词（content[0].text） */
    lastPrompt: () => {
      const last = requests[requests.length - 1];
      const content = last && last.body && last.body.messages && last.body.messages[0] && last.body.messages[0].content;
      if (Array.isArray(content)) return String((content.find(part => part.type === 'text') || {}).text || '');
      return String(content || '');
    },
    lastImages: () => {
      const last = requests[requests.length - 1];
      const content = last && last.body && last.body.messages && last.body.messages[0] && last.body.messages[0].content;
      return Array.isArray(content) ? content.filter(part => part.type === 'image_url') : [];
    },
    close: () => close(server)
  };
}

/* ------------------------- 假 Jina Reader ------------------------- */
async function startFakeJina(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ url: req.url, method: req.method });
    if (typeof handler === 'function') {
      const custom = handler(req, res, requests);
      if (custom !== undefined) return custom;
    }
    const text = [
      'Title: 测试课件页',
      'URL Source: http://example.com/page',
      'Published Time: 2026-01-01',
      'Markdown Content:',
      '这是正文内容。细胞膜由磷脂双分子层构成，具有流动镶嵌模型的结构特征。',
      '![示意图](http://example.com/a.png)',
      '参考 [链接文字](http://example.com/b) 了解更多。'
    ].join('\n');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
  });
  const port = await listen(server);
  return { port, url: `http://127.0.0.1:${port}/`, requests, close: () => close(server) };
}

/* ------------------------- 假 Tavily ------------------------- */
async function startFakeTavily(options = {}) {
  const results = options.results || [
    { title: '细胞膜的结构（Tavily 结果）', url: 'https://www.zxxk.com/doc/1', content: '磷脂双分子层构成细胞膜的基本骨架，蛋白质镶嵌其中，具有选择透过性，是高考高频考点。' },
    { title: '流动镶嵌模型（Tavily 结果）', url: 'https://jyeoo.com/doc/2', content: '流动镶嵌模型强调膜的流动性与蛋白质分布的不对称性，常考的易错点包括糖蛋白的位置。' }
  ];
  const state = { queries: [], calls: 0 };
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let payload = {};
    try { payload = JSON.parse(raw); } catch (_) {}
    state.calls++;
    state.queries.push(payload.query);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answer: '', results }));
  });
  const port = await listen(server);
  return { port, url: `http://127.0.0.1:${port}/search`, state, close: () => close(server) };
}

/* ------------------------- 假知乎 MCP over SSE ------------------------- */
function renderSearchItems(items) {
  return items.map(item =>
    `<search_item title="${item.title}" url="${item.url}" author_name="${item.author || ''}" ranking_score="${item.score == null ? 1 : item.score}">${item.content}</search_item>`
  ).join('\n');
}

async function startFakeZhihu(options = {}) {
  const { items = [], pingCollision = true, failFor = null } = options;
  const state = { sessions: new Map(), posts: [], pongs: [], connects: 0, toolCalls: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const channel = (url.pathname.match(/\/api\/mcp\/([^/]+)\//) || [])[1] || 'zhihu_search';
    const failure = typeof failFor === 'function' ? failFor(channel) : null;

    if (req.method === 'GET' && url.pathname.endsWith('/sse')) {
      if (failure === 'http500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"boom"}');
        return;
      }
      const sessionId = `sess-${Math.random().toString(16).slice(2, 10)}`;
      state.connects++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: endpoint\ndata: /api/mcp/${channel}/v1/message?sessionId=${sessionId}\n\n`);
      state.sessions.set(sessionId, res);
      req.on('close', () => state.sessions.delete(sessionId));
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/message')) {
      const raw = await readBody(req);
      let message = {};
      try { message = JSON.parse(raw); } catch (_) {}
      state.posts.push(message);
      const sse = state.sessions.get(url.searchParams.get('sessionId'));
      const send = value => { if (sse) sse.write(`data: ${JSON.stringify(value)}\n\n`); };
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{}');

      if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-zhihu', version: '1' } } });
        return;
      }
      if (message.method === 'notifications/initialized') return;
      if (message.method === 'tools/call') {
        state.toolCalls++;
        // notools：连接保持开着但永远不回结果，用来验证客户端超时后能自己收场
        if (failure === 'notools') return;
        // 真实服务端会主动发 ping 请求，且 id 可能与我们的请求 id 撞车。
        // 这里刻意让 ping 用同一个 id 且先到，验证它不会被当成 tools/call 的响应吞掉。
        if (pingCollision) send({ jsonrpc: '2.0', id: message.id, method: 'ping' });
        setTimeout(() => {
          send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: renderSearchItems(items) }] } });
        }, 60);
        return;
      }
      if (message.result !== undefined || message.error !== undefined) { state.pongs.push(message); return; }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    close: async () => { state.sessions.forEach(res => { try { res.end(); } catch (_) {} }); await close(server); }
  };
}

module.exports = { startFakeAnki, startFakeAi, startFakeJina, startFakeZhihu, startFakeTavily, renderSearchItems, DEFAULT_CARDS, readBody, listen, close };
