'use strict';
/*
 * 离线 API 适配器（public/local-api.js）的门槛：
 * 安卓壳里没有服务器，app.js 那些 /api/... 全靠它接管 —— 所以它的行为必须与服务端一致，
 * 而且「该报错的地方要报错」，不能装作成功（比如离线版没有 AnkiConnect，就该直说用 .apkg）。
 *
 * 测试方式：把 local-api.js 放进一个模拟浏览器沙箱，用假的「原生桥」顶替 Android 侧，
 * 假桥里的 AI 请求返回一段固定的卡片 JSON，AnkiDroid 侧（自检/上传媒体/写笔记）也可以按用例定制。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const { promptData } = require('../scripts/build-shell.js');
const shared = require('../src/shared');
const formulaPostprocess = require('../src/postprocess/formula.js');
const server = require('../src/server.js');
const PROMPTS = promptData(server.ALL_SUBJECTS.filter(subject => !subject.pack));

const CARD_JSON = JSON.stringify({ cards: [
  { type: 'basic', priority: 'P1', tags: ['通用制卡'], front: '细胞膜的基本骨架是什么？', back: '磷脂双分子层', note: '' },
  { type: 'cloze', priority: 'P1', tags: ['通用制卡'], text: '细胞膜具有{{c1::选择透过性}}', note: '备注' }
] });

/**
 * 造一个模拟浏览器：window / localStorage / document.cookie / 原生桥。
 * bridge 为 false 时模拟「在普通浏览器里打开离线页」（没有任何原生能力）。
 */
function loadOfflineApi({ id = 'demo', bridge = true, ai = null, anki = null, storage = null } = {}) {
  const memory = new Map();
  const sandbox = {
    console, atob, btoa, TextEncoder, TextDecoder, Response, Blob, URL,
    setTimeout, clearTimeout, queueMicrotask
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.localStorage = {
    getItem: key => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: key => memory.delete(key)
  };
  sandbox.navigator = { userAgent: 'CardFlowTest/1.0' };
  sandbox.document = { cookie: '', addEventListener() {}, getElementById: () => null };
  Object.entries(storage || {}).forEach(([key, value]) => memory.set(key, String(value)));
  const file = 'index-demo.html';
  sandbox.location = { href: `https://appassets.androidplatform.net/${file}`, protocol: 'https:', hostname: 'appassets.androidplatform.net', pathname: `/${file}` };
  sandbox.window.__SUBJECT__ = { id, base: '', tokenKey: `cardflow.${id}.token`, storageKey: `${id}.store` };
  sandbox.window.CardFlowPrompts = PROMPTS;
  sandbox.window.CardFlowShared = shared;
  sandbox.window.CardFlowCore = require('../public/core.js');
  sandbox.window.CardFlowZip = require('../public/backup-zip.js');
  sandbox.window.CardFlowPostprocess = formulaPostprocess;

  const seen = { httpRequest: [], buildApkg: [], tts: [], uploadMedia: [], addNotes: [], saveFile: [], decks: 0 };
  const answer = (id2, payload) => sandbox.window.CardFlowNativeOnResponse(id2, JSON.stringify(payload));
  // AnkiDroid 侧的行为（自检能不能写、上传媒体后返回的真实文件名、写笔记的结果）都按用例定制
  const plan = Object.assign({ canWrite: true, decks: ['生物::细胞', 'Default'], reason: '', renamed: null, addResult: null }, anki || {});
  if (bridge) {
    sandbox.window.CardFlowNative = {
      httpRequest(id2, json) {
        const request = JSON.parse(json);
        seen.httpRequest.push(request);
        const target = ai ? ai(request) : { status: 200, body: JSON.stringify({ choices: [{ message: { content: CARD_JSON } }] }) };
        queueMicrotask(() => answer(id2, target));
      },
      decks(id2) {
        seen.decks++;
        queueMicrotask(() => answer(id2, { ok: true, canWrite: plan.canWrite, decks: plan.decks, reason: plan.reason }));
      },
      uploadMedia(id2, json) {
        const request = JSON.parse(json);
        seen.uploadMedia.push(request);
        const files = (request.files || []).map(file => ({
          preferredName: file.preferredName,
          name: typeof plan.renamed === 'function' ? plan.renamed(file.preferredName)
            : ((plan.renamed && plan.renamed[file.preferredName]) || file.preferredName)
        }));
        queueMicrotask(() => answer(id2, { ok: true, files }));
      },
      addNotes(id2, json) {
        const request = JSON.parse(json);
        seen.addNotes.push(request);
        const result = plan.addResult ? plan.addResult(request) : { ok: true, added: request.notes.length, errors: [] };
        queueMicrotask(() => answer(id2, result));
      },
      buildApkg(id2, json) {
        seen.buildApkg.push(JSON.parse(json));
        // 假的「原生生成」：给一段可解析的字节流，好验证前端交出去的内容对不对
        queueMicrotask(() => answer(id2, { ok: true, base64: btoa('APKG-FAKE'), filename: 'x.apkg' }));
      },
      tts(id2, json) { seen.tts.push(JSON.parse(json)); queueMicrotask(() => answer(id2, { ok: true, dataUrl: 'data:audio/wav;base64,UklGRg==' })); }
    };
    // 「下载 .apkg / 直写失败回退」那条路：网页把包交给原生 saveFile 落盘（不再自动拉起 AnkiDroid）
    sandbox.window.CardFlowNative.saveFile = (filename, base64) => { seen.saveFile.push({ filename, bytes: base64.length }); };
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'local-api.js'), 'utf8'), sandbox, { filename: 'local-api.js' });
  return { win: sandbox, memory, seen, call: (url, init) => sandbox.window.fetch(url, init) };
}

test('离线版：口令门直接放行（本机不需要访问口令）', () => {
  const { win, memory } = loadOfflineApi();
  assert.equal(win.CardFlowLocal, true);
  assert.equal(win.localStorage.getItem('cardflow.demo.token'), 'local');
  assert.match(String(win.document.cookie), /ankiToken=local/);
  assert.ok(memory.size >= 1);
});

test('离线版 /api/config：不假装有服务端 Key，TTS 能力如实报告', async () => {
  const { call } = loadOfflineApi();
  const data = await (await call('/api/config')).json();
  assert.deepEqual(data, { apiUrl: '', model: '', hasKey: false, hasSearch: false, hasZhihu: false, tts: true });
  const noBridge = loadOfflineApi({ bridge: false });
  assert.equal((await (await noBridge.call('/api/config')).json()).tts, false);
});

test('离线版 /api/generate：走原生桥直连 AI，返回与服务端同形的卡片并记一笔历史', async () => {
  const { call, seen } = loadOfflineApi({ id: 'demo', ai: request => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, 'https://api.example.com/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer sk-test');
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.temperature, 0.2, '示例学科用 0.2');
    assert.match(body.messages[0].content[0].text, /你是应试 Anki 制卡引擎/);
    assert.equal(body.messages[0].content.at(-1).type, 'image_url');
    return { status: 200, body: `{"choices":[{"message":{"content":${JSON.stringify(CARD_JSON)}}}]}` };
  } });
  const response = await call('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://api.example.com/v1', key: 'sk-test', model: 'test-model', images: ['data:image/png;base64,AA'], deck: '示例::电化学' })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.cards.length, 2);
  assert.equal(data.cards[0].type, 'basic');
  assert.ok(Number(data.historyT) > 0, '要带上历史记录时间戳（前端拿它回写单卡重试）');
  assert.equal(seen.httpRequest.length, 1);

  const history = await (await call('/api/history?limit=5')).json();
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].kind, 'generate');
  assert.equal(history.records[0].total, 2);
  assert.equal(history.records[0].deck, '示例::电化学');
  assert.equal(history.records[0].restorable, true, '整批卡片要留下来，历史页才能「载入这批卡片」');
});

test('离线版：AI 报错要说清楚，不能吞掉', async () => {
  const { call } = loadOfflineApi({ ai: () => ({ status: 401, body: JSON.stringify({ error: { message: 'Invalid API key' } }) }) });
  const response = await call('/api/generate', { method: 'POST', body: JSON.stringify({ url: 'https://api.example.com/v1', key: 'bad', model: 'm', images: ['data:image/png;base64,AA'] }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Invalid API key');
  // 缺少图片/模型：与服务端一样在本地就拦下来，不发请求
  const local = loadOfflineApi();
  const missing = await local.call('/api/generate', { method: 'POST', body: JSON.stringify({ url: 'https://api.example.com/v1', key: 'k', model: 'm', images: [] }) });
  assert.equal((await missing.json()).error, '缺少 API、模型或图片。');
  assert.equal(local.seen.httpRequest.length, 0);
});

test('离线版 /api/apkg：遮挡卡的图片进媒体、字段 HTML 与服务端同一份排版', async () => {
  const { call, seen } = loadOfflineApi({ id: 'demo' });
  const response = await call('/api/apkg', { method: 'POST', body: JSON.stringify({
    deck: '生物', autoGroup: true, cards: [
      { type: 'basic', tags: ['通用制卡'], front: '细胞膜的骨架？', back: '磷脂双分子层', group: '第 3 章' },
      { type: 'occlusion', image: 'data:image/png;base64,AA', masks: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }], front: '这是哪一部分？', back: '细胞核', note: '看核膜' }
    ]
  }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /filename="cardflow-demo-\d+\.apkg"/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(Buffer.from(bytes).toString('utf8'), 'APKG-FAKE', '返回的字节就是原生生成的包');

  const payload = seen.buildApkg[0];
  assert.deepEqual(payload.decks.map(deck => deck.name), ['生物::第 3 章', '生物'], '有 group 的卡进子牌组，没 group 的留在父牌组');
  const grouped = payload.decks.find(deck => deck.name === '生物::第 3 章').notes[0];
  const plain = payload.decks.find(deck => deck.name === '生物').notes[0];
  assert.equal(grouped.model, 'Basic');
  assert.deepEqual(grouped.fields, ['细胞膜的骨架？', '磷脂双分子层']);
  assert.deepEqual(grouped.tags, ['通用制卡']);
  assert.equal(plain.model, 'Basic');
  assert.match(plain.fields[0], /<img src="cardflow-[0-9a-f]+\.png"/, '遮挡图要进媒体并写进正面');
  assert.match(plain.fields[0], /left:10%;top:20%;width:30%;height:40%/, '遮挡框坐标要按百分比写进去');
  assert.match(plain.fields[1], /<p>看核膜<\/p>/);
  assert.equal(payload.media.length, 1);
  assert.equal(payload.media[0].filename.endsWith('.png'), true);
  assert.equal(payload.media[0].base64, 'AA');
  assert.equal(seen.tts.length, 0, '这次没有音频卡，不该调 TTS');
});

test('离线版 /api/apkg：音频卡没有音频时用系统 TTS 补上（本机桥在，就允许由本机合成）', async () => {
  const { call, seen } = loadOfflineApi({ id: 'demo' });
  await call('/api/apkg', { method: 'POST', body: JSON.stringify({
    deck: '生物', cards: [{ type: 'audio', front: '细胞膜的作用是什么', back: '选择透过性', speak: '细胞膜的作用', tags: ['通用制卡'] }]
  }) });
  assert.deepEqual(seen.tts, [{ text: '细胞膜的作用' }]);
  const note = seen.buildApkg[0].decks[0].notes[0];
  assert.match(note.fields[0], /\[sound:cardflow-[0-9a-f]+\.wav\]/);
  assert.equal(seen.buildApkg[0].media[0].filename.endsWith('.wav'), true);
});

test('离线版：牌组读取优先用 AnkiDroid 里的真实牌组，没装也能新建', async () => {
  const { call, seen } = loadOfflineApi();
  const decks = await (await call('/api/decks')).json();
  assert.deepEqual(decks.decks, ['生物::细胞', 'Default']);
  assert.equal(seen.decks, 1);
  const created = await (await call('/api/deck/create', { method: 'POST', body: JSON.stringify({ deck: '生物::第三章' }) })).json();
  assert.equal(created.deck, '生物::第三章');
  assert.ok((await (await call('/api/decks')).json()).decks.includes('生物::第三章'), '新建的牌组要留在本机列表里');
  // 没有原生桥（普通浏览器里打开离线页）：至少给一个可用牌组，别让「下载 .apkg」被卡住
  const bare = loadOfflineApi({ bridge: false });
  assert.deepEqual((await (await bare.call('/api/decks')).json()).decks, ['Default']);
});

test('离线版：该拒绝的端点给出可操作的中文提示（而不是假装成功）', async () => {
  const { call } = loadOfflineApi({ id: 'demo' });
  const cases = [
    ['/api/sync', /AnkiDroid/],
    ['/api/unknown', /接口不存在/]
  ];
  for (const [pathname, pattern] of cases) {
    const response = await call(pathname, { method: 'POST', body: '{}' });
    assert.equal(response.ok, false, `${pathname} 应该失败`);
    assert.match((await response.json()).error, pattern, pathname);
  }
  // /api/normalize 只有配了 postprocess 的学科才有；示例学科没配，直接 404 —— 与服务端一致
  const notFound = await call('/api/normalize', { method: 'POST', body: JSON.stringify({ cards: [] }) });
  assert.equal(notFound.status, 404);
});

test('离线版 /api/export：txt 字节就是共享模块里那份导出文本（制表符分隔）', async () => {
  const { call } = loadOfflineApi({ id: 'demo' });
  const cards = [{ type: 'basic', tags: ['通用制卡'], front: '正面\t带制表符', back: '背面', note: '' }];
  const response = await call('/api/export', { method: 'POST', body: JSON.stringify({ type: 'basic', cards }) });
  assert.match(response.headers.get('content-disposition'), /filename="demo-\d{4}-\d{2}-\d{2}-\d{4}-basic\.txt"/);
  const text = await response.text();
  assert.equal(text, shared.exportText(cards, PROMPTS.demo.defaultTags));
  assert.ok(text.includes('\t'), '必须是制表符分隔');
  const empty = await call('/api/export', { method: 'POST', body: JSON.stringify({ type: 'cloze', cards }) });
  assert.equal((await empty.json()).error, '没有填空卡可以导出。');
});

test('离线版 history/card：单卡改写回写到那条历史里（与服务端同一套字段）', async () => {
  const { call } = loadOfflineApi({ id: 'demo' });
  const generated = await (await call('/api/generate', { method: 'POST', body: JSON.stringify({ url: 'https://api.example.com/v1', key: 'k', model: 'm', images: ['data:image/png;base64,AA'] }) })).json();
  const next = { type: 'basic', tags: ['通用制卡'], front: '改过的正面', back: '改过的背面', note: '' };
  const result = await (await call('/api/history/card', { method: 'POST', body: JSON.stringify({ t: generated.historyT, index: 0, card: next }) })).json();
  assert.equal(result.ok, true);
  assert.equal(result.titles[0], '改过的正面');
  const item = await (await call(`/api/history/item?t=${generated.historyT}`)).json();
  assert.equal(item.record.cards[0].front, '改过的正面');
  assert.equal(item.record.revised, 1);
  // 格式不对的卡片要被挑出来（与服务的卡片校验同一条规则）
  const bad = await (await call('/api/history/card', { method: 'POST', body: JSON.stringify({ t: generated.historyT, index: 0, card: { type: 'cloze', text: '出现 {{c2::第二个}}' } }) })).json();
  assert.match(bad.error, /只能使用 c1/);
});

test('离线版 /api/card/retry：只重写一张，方向与温度跟服务端同一套规则', async () => {
  const card = { type: 'basic', tags: ['通用制卡'], front: '旧的正面', back: '旧的背面', note: '' };
  const rewritten = { type: 'basic', tags: ['通用制卡'], front: '新的正面', back: '新的背面', note: '备注' };
  const { call, seen } = loadOfflineApi({ id: 'demo', ai: request => {
    const body = JSON.parse(request.body);
    assert.equal(body.temperature, 0.75, '不指定方向时用 0.75');
    assert.match(body.messages[0].content[0].text, /换一个更精炼的提问角度（考点不变）|答案保留关键细节|把最容易错的地方写进备注|换一种更贴近考试问法的表述/);
    assert.match(body.messages[0].content[0].text, /旧的正面/);
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cards: [rewritten] }) } }] }) };
  } });
  const data = await (await call('/api/card/retry', { method: 'POST', body: JSON.stringify({ url: 'https://api.example.com/v1', key: 'k', model: 'm', card }) })).json();
  assert.deepEqual(data.card, rewritten);
  assert.equal(data.random, true);
  assert.equal(typeof data.angle, 'string');
  assert.equal(data.issue, '');
  assert.equal(seen.httpRequest.length, 1);

  // 指定方向：温度低一点，角度就用用户给的
  const given = loadOfflineApi({ id: 'demo', ai: request => {
    assert.equal(JSON.parse(request.body).temperature, 0.4);
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cards: [rewritten] }) } }] }) };
  } });
  const directed = await (await given.call('/api/card/retry', { method: 'POST', body: JSON.stringify({ url: 'https://api.example.com/v1', key: 'k', model: 'm', card, guidance: '答案再短一点' }) })).json();
  assert.equal(directed.angle, '答案再短一点');
  assert.equal(directed.random, false);

  // 卡片本身格式就有问题：本地就拦下，不发请求
  const local = loadOfflineApi({ id: 'demo' });
  const bad = await (await local.call('/api/card/retry', { method: 'POST', body: JSON.stringify({ url: 'https://api.example.com/v1', key: 'k', model: 'm', card: { type: 'cloze', text: '用了 {{c2::第二个}}' } }) })).json();
  assert.match(bad.error, /只能使用 c1/);
  assert.equal(local.seen.httpRequest.length, 0);
});

test('离线版 /api/fetch：走原生桥取 Jina Reader，清洗与服务端同一套', async () => {
  const raw = 'Title: 某页面\nURL Source: https://example.com/a\n\n![图](https://x/y.png)\n请看[这篇](https://example.com/b)原文\n\n\n\n第二段\n页码 1\n页码 2\n登录\n';
  const { call, seen } = loadOfflineApi({ ai: request => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, 'https://r.jina.ai/https://example.com/a');
    return { status: 200, body: raw };
  } });
  const data = await (await call('/api/fetch', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/a' }) })).json();
  assert.equal(seen.httpRequest.length, 1);
  assert.ok(!data.content.includes('Markdown Content'), '前缀行要去掉');
  assert.ok(!data.content.includes('!['), '图片要去掉');
  assert.ok(data.content.includes('请看这篇原文'), '外链只留文字');
  assert.ok(!/\n{3,}/.test(data.content), '多余空行要压缩');
  assert.equal(data.suspicious, true, '页码/登录这类框架噪音命中 3 次以上要标记可疑');
  // 限额：最多 40000、最少 500
  const long = loadOfflineApi({ ai: () => ({ status: 200, body: 'x'.repeat(50000) }) });
  const clipped = await (await long.call('/api/fetch', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/a', limit: 999999 }) })).json();
  assert.equal(clipped.content.length, 40000);
  assert.equal(await (await long.call('/api/fetch', { method: 'POST', body: JSON.stringify({ url: 'bad' }) })).json().then(body => body.error), '无效的链接。');
});

test('离线版 /api/backup：备份包与电脑版同一套结构（电脑能读）', async () => {
  const { unzipSync } = require('../src/zip.js');
  const { call } = loadOfflineApi({ id: 'demo', storage: { 'cardflow.settings': JSON.stringify({ rules: [], batchSize: 3 }) } });
  // 先造一条历史（生成一次）
  await call('/api/generate', { method: 'POST', body: JSON.stringify({ url: 'https://api.example.com/v1', key: 'k', model: 'm', images: ['data:image/png;base64,AA'] }) });
  const response = await call('/api/backup', { method: 'POST', body: JSON.stringify({ settings: { rules: [{ id: 'a', text: '规则' }], batchSize: 4 } }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /filename="cardflow-backup-\d+\.zip"/);
  const bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  // 关键：用服务端那份 zip 实现（src/zip.js）能直接解开
  const files = unzipSync(bytes);
  assert.ok(files['meta.json'], '要有 meta.json');
  assert.ok(files['history.jsonl'], '要有 history.jsonl');
  assert.ok(files['settings.json'], '要有 settings.json');
  const meta = JSON.parse(files['meta.json'].toString('utf8'));
  assert.equal(meta.kind, 'cardflow-backup');
  assert.equal(meta.source, 'android-offline');
  assert.equal(meta.includesHistory, true);
  assert.equal(JSON.parse(files['settings.json'].toString('utf8')).batchSize, 4);
  const records = files['history.jsonl'].toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'generate');
});

test('离线版 /api/backup/restore：能还原电脑版生成的（deflate 压缩的）备份包', async () => {
  const { zipSync } = require('../src/zip.js');
  const historyText = ['{"t":111,"subject":"demo","kind":"generate","total":2,"cards":[{"type":"basic","front":"恢复的卡","back":"b"}]}', ''].join('\n');
  const archive = zipSync([
    { name: 'meta.json', data: Buffer.from('{"kind":"cardflow-backup"}') },
    { name: 'history.jsonl', data: Buffer.from(historyText) },
    { name: 'settings.json', data: Buffer.from('{"batchSize":9,"duplicateCheck":false}') }
  ]);
  assert.ok(archive.length > 200, '这个包应该是 deflate 压缩过的（还原时要能解压）');
  const { call } = loadOfflineApi({ id: 'demo' });
  const data = await (await call('/api/backup/restore', { method: 'POST', body: JSON.stringify({ data: archive.toString('base64') }) })).json();
  assert.equal(data.ok, true);
  assert.equal(data.history, true);
  assert.equal(data.settings.batchSize, 9, '设置要回传给页面（页面自己写进本机）');
  const history = await (await call('/api/history?limit=5')).json();
  // 还原本身也会记一笔（与服务端一致）：所以最新的那条是 restore，被还原的那条在它后面
  assert.equal(history.records.length, 2);
  assert.equal(history.records[0].kind, 'restore');
  const restored = history.records.find(item => Number(item.t) === 111);
  assert.ok(restored, '还原回来的那条历史要在');
  assert.equal(restored.restorable, true);
  // 空包/坏包要说清楚
  const empty = await (await call('/api/backup/restore', { method: 'POST', body: JSON.stringify({ data: '' }) })).json();
  assert.equal(empty.error, '恢复包内容为空。');
  const broken = await (await call('/api/backup/restore', { method: 'POST', body: JSON.stringify({ data: btoa('not a zip') }) })).json();
  assert.match(broken.error, /不是有效的 zip/);
});

test('离线版 /api/diagnose：报告里有环境与 AnkiDroid 状态，但不含任何密钥', async () => {
  const { call } = loadOfflineApi({
    id: 'demo',
    anki: { canWrite: false, reason: '缺少权限' },
    storage: { 'demo.store': JSON.stringify({ apiUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-x' }) }
  });
  const response = await call('/api/diagnose');
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes('sk-secret'), '诊断包里绝不能出现密钥');
  const report = JSON.parse(text);
  assert.equal(report.kind, 'cardflow-diagnose');
  assert.equal(report.subject, 'demo');
  assert.equal(report.config.apiUrlOrigin, 'https://api.example.com');
  assert.equal(report.config.hasApiKey, true);
  assert.equal(report.anki.canWrite, false);
  assert.equal(report.anki.reason, '缺少权限');
  assert.match(report.log, /状态提示/);
});

test('离线版 /api/search：走原生桥直连 Tavily，清洗/排序与电脑版同一套', async () => {
  const tavily = request => {
    assert.equal(request.method, 'POST');
    assert.match(request.headers.authorization, /^Bearer tvly-test$/);
    return { status: 200, body: JSON.stringify({ results: [
      { url: 'https://www.zhihu.com/question/1', title: '知乎回答', content: '这是一段足够长的正文内容，用来说明检索结果的清洗与排序是否按预期工作，汉字数量够多。' },
      { url: 'https://unknown-blog.example.net/x', title: '普通站', content: '另一段同样足够长的正文内容，用来验证非偏好站点不会被打上星号标记，汉字数量也够。' }
    ] }) };
  };
  const withKey = { storage: { 'cardflow.offline.searchKey': JSON.stringify('tvly-test') } };
  const { call, seen } = loadOfflineApi({ id: 'demo', ai: tavily, ...withKey });
  const data = await (await call('/api/search', { method: 'POST', body: JSON.stringify({ query: '原电池 考点', maxResults: 6, channel: 'tavily' }) })).json();
  assert.equal(seen.httpRequest.length, 1);
  const sent = JSON.parse(seen.httpRequest[0].body);
  assert.equal(sent.search_depth, 'advanced');
  assert.equal(sent.max_results, 6);
  assert.equal(sent.include_answer, undefined, '不取 Tavily 的英文摘要');
  assert.equal(sent.include_domains, undefined, '全网通道不限定域名');
  assert.equal(data.provider, 'Tavily 全网');
  assert.equal(data.results.length, 2);
  assert.match(data.results[0].title, /^★ zhihu\.com · 知乎回答$/, '偏好站点排前面并加星号');

  // 知乎站内通道：用 include_domains 限定
  const zhihu = loadOfflineApi({ id: 'demo', ai: tavily, ...withKey });
  const zhihuData = await (await zhihu.call('/api/search', { method: 'POST', body: JSON.stringify({ query: '原电池', channel: 'zhihu' }) })).json();
  assert.deepEqual(JSON.parse(zhihu.seen.httpRequest[0].body).include_domains, ['zhihu.com']);
  assert.equal(zhihuData.provider, 'Tavily（知乎站内）');

  // 没填 Key：本地就拦下，不发请求
  const noKey = loadOfflineApi({ id: 'demo' });
  const blocked = await (await noKey.call('/api/search', { method: 'POST', body: JSON.stringify({ query: 'x' }) })).json();
  assert.match(blocked.error, /未配置联网检索 Key/);
  assert.equal(noKey.seen.httpRequest.length, 0);
});

test('离线版 /api/research：四步调研（读图定主题 → 搜目录 → 定章节 → 搜考情）', async () => {
  const seenQueries = [];
  const responder = request => {
    if (request.url.includes('/chat/completions')) {
      const prompt = JSON.parse(request.body).messages[0].content[0].text;
      // 注意：化学的「定位」提示词里也出现了「知识主题」四个字，所以按定位步骤特有的字样来分
      const content = /锁定|章节位置/.test(prompt)
        ? { position: '必修第一册 第二章 第一节 原电池', topic: '原电池', examQueries: ['原电池 电极反应式 高考', '原电池 高频考点 易错点'] }
        : { topic: '原电池的工作原理', keypoints: ['电极反应', '电子流向'] };
      assert.equal(JSON.parse(request.body).temperature, 0.1, '定位两步都用 0.1 温度');
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
    }
    const body = JSON.parse(request.body);
    seenQueries.push({ query: body.query, domains: body.include_domains });
    return { status: 200, body: JSON.stringify({ results: [
      { url: 'https://www.zhihu.com/question/9', title: '知乎：原电池', content: '这是一段足够长的正文内容，用来说明调研结果能正常带回并参与提示词拼装，汉字数量足够多，不会被清洗规则丢掉。' }
    ] }) };
  };
  const { call, seen } = loadOfflineApi({ id: 'demo', ai: responder, storage: { 'cardflow.offline.searchKey': JSON.stringify('tvly-test') } });
  const data = await (await call('/api/research', { method: 'POST', body: JSON.stringify({ url: 'https://api.example.com/v1', key: 'k', model: 'm', images: ['data:image/png;base64,AA'] }) })).json();
  assert.equal(data.identify.topic, '原电池的工作原理');
  assert.deepEqual(data.identify.keypoints, ['电极反应', '电子流向']);
  assert.equal(data.position, '必修第一册 第二章 第一节 原电池');
  assert.deepEqual(data.examQueries, ['原电池 电极反应式 高考', '原电池 高频考点 易错点']);
  assert.equal(data.exams.length, 2);
  assert.match(data.exams[0].provider, /Tavily/);
  assert.ok(data.exams.every(exam => exam.results.length > 0), '每个检索词都要带回结果');
  // 目录检索用的是「学科前缀 + 主题 + 章节内容」
  assert.ok(seenQueries.some(item => item.query.includes('原电池的工作原理')), '目录检索要带上主题');
  assert.equal(seenQueries.length, 5, '目录 1 次 + 两个检索词各两个通道');
  assert.equal(seenQueries.filter(item => item.domains).length, 2, '两个检索词各有一条站内检索限定知乎');
  assert.equal(seen.httpRequest.length, 7, '2 次 AI + 5 次检索');
  // 没填 Key：提前报错
  const noKey = loadOfflineApi({ id: 'demo', ai: responder });
  const blocked = await (await noKey.call('/api/research', { method: 'POST', body: JSON.stringify({ url: 'https://api.example.com/v1', key: 'k', model: 'm', images: ['data:image/png;base64,AA'] }) })).json();
  assert.match(blocked.error, /未配置联网检索 Key/);
});

test('离线版 /api/seen：问题池记在本机，导入/导出后能跨批次去重', async () => {
  const { call } = loadOfflineApi({ id: 'demo' });
  await call('/api/apkg', { method: 'POST', body: JSON.stringify({ deck: '化学', cards: [{ type: 'basic', front: '原电池的正极是什么？', back: '正极发生还原反应', tags: ['高中化学'] }] }) });
  const seen = await (await call('/api/seen')).json();
  assert.equal(seen.limit, 4000);
  assert.equal(seen.seen.length, 1);
  assert.match(seen.seen[0], /原电池的正极是什么/);
});

/* ===== 一键导入（直写 AnkiDroid）===== */

const TWO_CARDS = {
  deck: '生物',
  cards: [
    { type: 'basic', tags: ['通用制卡'], front: '细胞膜的骨架？', back: '磷脂双分子层' },
    { type: 'cloze', tags: ['通用制卡'], text: '细胞膜具有{{c1::选择透过性}}', note: '备注' }
  ]
};

test('离线版 /api/import：直接写进 AnkiDroid（不再需要手动导入 .apkg）', async () => {
  const { call, seen } = loadOfflineApi({ id: 'demo' });
  const response = await call('/api/import', { method: 'POST', body: JSON.stringify(TWO_CARDS) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { added: 2, skipped: 0 });
  assert.equal(seen.addNotes.length, 1, '同一牌组的卡一次调用写完');
  assert.equal(seen.addNotes[0].deck, '生物');
  assert.equal(seen.addNotes[0].anyCloze, true, '有填空卡时要告诉原生侧去挑填空笔记类型');
  assert.deepEqual(seen.addNotes[0].notes[0], { model: 'Basic', fields: ['细胞膜的骨架？', '磷脂双分子层'], tags: ['通用制卡'] });
  assert.equal(seen.addNotes[0].notes[1].model, 'Cloze');
  assert.equal(seen.addNotes[0].notes[1].fields[0], '细胞膜具有{{c1::选择透过性}}');
  assert.equal(seen.uploadMedia.length, 0, '没有媒体卡就不该调媒体接口');
  assert.equal(seen.buildApkg.length, 0, '直写成功就不用打包了');
  assert.equal(seen.saveFile.length, 0);
  const history = await (await call('/api/history?limit=5')).json();
  assert.equal(history.records[0].kind, 'import');
  assert.equal(history.records[0].added, 2);
});

test('离线版 /api/import：自动分层导入按 group 拆成多个子牌组写入', async () => {
  const { call, seen } = loadOfflineApi({ id: 'demo' });
  const response = await call('/api/import', { method: 'POST', body: JSON.stringify({
    deck: '生物', autoGroup: true, cards: [
      { type: 'basic', front: 'A', back: 'B', group: '第 3 章' },
      { type: 'cloze', text: '{{c1::X}} 的句子', group: '第 3 章' },
      { type: 'basic', front: 'C', back: 'D', group: '第 4 章' },
      { type: 'basic', front: 'E', back: 'F' }
    ]
  }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { added: 4, skipped: 0 });
  // 每个子牌组一次写入；没有 group 的卡就落在所选牌组本身
  const writes = seen.addNotes.map(entry => [entry.deck, entry.notes.length]).sort();
  assert.deepEqual(writes, [['生物', 1], ['生物::第 3 章', 2], ['生物::第 4 章', 1]].sort());
});

test('离线版 /api/import：关掉自动分层时全部写进所选牌组本身', async () => {
  const { call, seen } = loadOfflineApi({ id: 'demo' });
  const response = await call('/api/import', { method: 'POST', body: JSON.stringify({
    deck: '生物::细胞', autoGroup: false, cards: [
      { type: 'basic', front: 'A', back: 'B', group: '第 3 章' },
      { type: 'basic', front: 'C', back: 'D', group: '第 4 章' }
    ]
  }) });
  assert.deepEqual(await response.json(), { added: 2, skipped: 0 });
  assert.equal(seen.addNotes.length, 1);
  assert.equal(seen.addNotes[0].deck, '生物::细胞', '关了自动分层就不能自做主张建子牌组');
});

test('离线版 /api/import：遮挡卡的图片先进 AnkiDroid 媒体库，字段里用它实际给的文件名', async () => {
  const { call, seen } = loadOfflineApi({ id: 'demo', anki: { renamed: name => name.replace(/\.png$/, '-v2.png') } });
  const response = await call('/api/import', { method: 'POST', body: JSON.stringify({
    deck: '生物', autoGroup: true, cards: [
      { type: 'occlusion', image: 'data:image/png;base64,AA', masks: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }], front: '这是哪一部分？', back: '细胞核', group: '第 3 章' }
    ]
  }) });
  assert.deepEqual(await response.json(), { added: 1, skipped: 0 });
  assert.equal(seen.uploadMedia.length, 1);
  assert.equal(seen.uploadMedia[0].files[0].base64, 'AA');
  assert.equal(seen.uploadMedia[0].files[0].preferredName.endsWith('.png'), true);
  assert.equal(seen.addNotes[0].deck, '生物::第 3 章', '开自动分层时卡片进子牌组');
  const field = seen.addNotes[0].notes[0].fields[0];
  assert.match(field, /-v2\.png/, 'AnkiDroid 改了名字，字段里就必须用改后的名字');
  assert.match(field, /left:10%;top:20%;width:30%;height:40%/);
});

test('离线版 /api/import：不能直写时自动回退 .apkg 交给 AnkiDroid，并说清楚原因', async () => {
  const reasons = [
    { canWrite: false, reason: '手机上没找到 AnkiDroid：要一键导入请先装 AnkiDroid' },
    { canWrite: false, reason: '缺少「读写 AnkiDroid 数据库」权限' }
  ];
  for (const anki of reasons) {
    const { call, seen } = loadOfflineApi({ id: 'demo', anki });
    const response = await call('/api/import', { method: 'POST', body: JSON.stringify(TWO_CARDS) });
    assert.equal(response.ok, false);
    const body = await response.json();
    assert.match(body.error, /直接写进 AnkiDroid 没成功/);
    assert.match(body.error, /已改成打包 \.apkg 存到应用下载目录/);
    assert.match(body.error, new RegExp(`共 ${TWO_CARDS.cards.length} 张`));
    assert.equal(seen.addNotes.length, 0, '自检不过就不应该写卡片');
    assert.equal(seen.buildApkg.length, 1, '回退时要真的打包');
    assert.equal(seen.buildApkg[0].decks[0].name, '生物');
    assert.deepEqual(seen.buildApkg[0].decks[0].notes[0].fields, ['细胞膜的骨架？', '磷脂双分子层']);
    assert.equal(seen.saveFile.length, 1, '包要交给原生 saveFile 落盘（不自动拉起 AnkiDroid）');
    assert.match(seen.saveFile[0].filename, /^cardflow-demo-\d+\.apkg$/);
  }
});

test('离线版 /api/import：媒体传不进去也回退 .apkg（不能把没有图的遮挡卡写进去）', async () => {
  const broken = loadOfflineApi({ id: 'demo', anki: { canWrite: true } });
  // 直接换掉桥上的方法：模拟「AnkiDroid 不接受媒体」
  broken.win.CardFlowNative.uploadMedia = (id2, json) => queueMicrotask(() => broken.win.CardFlowNativeOnResponse(id2, JSON.stringify({ ok: false, error: 'AnkiDroid 没有接受这个媒体文件' })));
  const response = await broken.call('/api/import', { method: 'POST', body: JSON.stringify({
    deck: '生物', cards: [{ type: 'occlusion', image: 'data:image/png;base64,AA', masks: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }], front: 'a', back: 'b' }]
  }) });
  assert.equal(response.ok, false);
  assert.match((await response.json()).error, /图片\/音频没能传进 AnkiDroid/);
  assert.equal(broken.seen.addNotes.length, 0, '媒体失败就不要写卡片（否则图会丢）');
  assert.equal(broken.seen.buildApkg.length, 1, '回退到 .apkg，图在包里');
  assert.equal(broken.seen.buildApkg[0].media.length, 1);
});

test('化学后处理：裸化学式补成 \\(\\ce{...}\\)，且不再把音频卡/遮挡卡丢掉', () => {
  // 裸写法（用户截图里的 CO2、H2O 这类）要被补成 MathJax mhchem
  const one = formulaPostprocess.normalizePayload({ cards: [{ type: 'basic', front: 'CO2 与 H2O', back: '都有' }] });
  assert.equal(one.cards[0].front, '\\(\\ce{CO2}\\) 与 \\(\\ce{H2O}\\)');
  // 已经写好的 \ce{} / 数学段不重复套壳
  const kept = formulaPostprocess.convertBareFormulas('\\(\\ce{H2O}\\) 与 USB、OK');
  assert.equal(kept, '\\(\\ce{H2O}\\) 与 USB、OK', '不是化学式的普通大写串不能误伤');
  // 音频卡 / 遮挡卡必须保留（以前只留 basic/cloze，等于把新类型静默丢光）
  const all = formulaPostprocess.normalizeGeneratedCards(JSON.stringify({ cards: [
    { type: 'basic', front: 'A', back: 'B' },
    { type: 'cloze', text: '含 {{c1::H2O}} 的句子' },
    { type: 'occlusion', front: '看图', back: '答案', image: 'data:image/png;base64,AA', masks: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }] },
    { type: 'audio', front: '听音', back: 'B', speak: 'B', audio: 'data:audio/wav;base64,AA' }
  ] }));
  assert.deepEqual(all.cards.map(card => card.type), ['basic', 'cloze', 'occlusion', 'audio']);
  assert.match(all.cards[1].text, /\{\{c1::\\\(\\ce\{H2O\}\\\)\}\}/, '填空里的裸化学式也要补');
});

test('离线版 /api/import：只写进去一部分时如实报告，不自动回退（避免重复写）', async () => {
  const { call, seen } = loadOfflineApi({
    id: 'demo',
    anki: { addResult: request => ({ ok: false, error: 'AnkiDroid 写卡片失败', added: 1, errors: ['第 2 张写不进去'] }) }
  });
  const response = await call('/api/import', { method: 'POST', body: JSON.stringify(TWO_CARDS) });
  assert.equal(response.ok, false);
  const body = await response.json();
  assert.match(body.error, /只写进去 1 张/);
  assert.match(body.error, /剩下 1 张没成功/);
  assert.match(body.error, /下载 \.apkg/);
  assert.equal(seen.saveFile.length, 0, '已经写进去一部分就不能再自动打包（会重复）');
  assert.equal(seen.buildApkg.length, 0);
});
