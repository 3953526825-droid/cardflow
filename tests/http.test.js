'use strict';
/*
 * 服务端 HTTP 端到端测试：真起 src/server.js 进程（单学科模式），把所有外部依赖指向本地假服务。
 * 每个学科跑一遍同样的用例；不碰 3210/3211/3212/3213，不碰真实 Anki、AI、知乎、Tavily。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after } = require('node:test');

const { startServer } = require('./helpers/harness');
const { startFakeAnki, startFakeAi, startFakeJina, startFakeZhihu } = require('./helpers/fakes');
const { unzipSync } = require('../src/zip');
const { DatabaseSync } = require('node:sqlite');

const SUBJECTS = ['demo'];
const ZHIHU_ITEMS = [
  { title: '细胞膜的结构 考点总结', url: 'https://www.zhihu.com/question/100?utm_source=test', author: '某老师', score: 0.9, content: '细胞膜以磷脂双分子层为基本骨架，蛋白质镶嵌其中，具有流动性和选择透过性，是高考高频考点。' },
  { title: '流动镶嵌模型 易错点', url: 'https://zhuanlan.zhihu.com/p/200', author: '教研组', score: 0.8, content: '易错点：磷脂双分子层是基本骨架而不是蛋白质；糖蛋白只分布在细胞膜外侧，用于识别。' }
];

const contexts = new Map();

async function setup(subjectId) {
  const ctx = {};
  ctx.anki = await startFakeAnki(['Default', '生物::细胞膜', '生物::细胞膜::流动镶嵌模型']);
  ctx.anki.state.cardCounts.set('生物::细胞膜', 7);
  ctx.ai = await startFakeAi();
  ctx.jina = await startFakeJina((req, res) => {
    const target = decodeURIComponent(String(req.url || '').replace(/^\//, ''));
    if (target.includes('forbidden')) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('blocked');
      return res;
    }
    if (target.includes('noise')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Title: 课件预览\nMarkdown Content:\n页码 浏览：2 下载：0 作品ID 123 作者ID 456 内容目录 全屏 演示 登录 注册');
      return res;
    }
    if (target.includes('long')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Title: 长文\nMarkdown Content:\n${'细胞膜的流动镶嵌模型与物质运输方式，需要完整掌握。'.repeat(400)}`);
      return res;
    }
    return undefined;
  });
  ctx.zhihu = await startFakeZhihu({ items: ZHIHU_ITEMS });
  ctx.server = await startServer({
    subject: subjectId,
    ankiUrl: ctx.anki.url,
    jinaBase: ctx.jina.url,
    zhihuBase: ctx.zhihu.url,
    config: { zhihuKey: 'test-zhihu-key', tavilyKey: 'test-tavily-key', apiKey: 'test-api-key' }
  });
  return ctx;
}

async function contextFor(subjectId) {
  if (!contexts.has(subjectId)) contexts.set(subjectId, await setup(subjectId));
  return contexts.get(subjectId);
}

before(async () => { for (const subjectId of SUBJECTS) await contextFor(subjectId); });

after(async () => {
  for (const ctx of contexts.values()) {
    await ctx.server.stop();
    await ctx.zhihu.close();
    await ctx.jina.close();
    await ctx.ai.close();
    await ctx.anki.close();
  }
});

for (const subjectId of SUBJECTS) {
  const label = `[${subjectId}] `;

  test(`${label}鉴权：无 token → 401；错误 token → 401；正确 token → 200`, async () => {
    const ctx = await contextFor(subjectId);
    const none = await fetch(`${ctx.server.base}/api/decks`);
    const noneBody = await none.json();
    assert.equal(none.status, 401);
    assert.match(noneBody.error, /未授权/);

    const wrong = await fetch(`${ctx.server.base}/api/decks`, { headers: { 'x-anki-token': 'wrong-token-value-xx' } });
    assert.equal(wrong.status, 401);

    const ok = await ctx.server.api('/api/decks');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.decks, ['Default', '生物::细胞膜', '生物::细胞膜::流动镶嵌模型']);
  });

  test(`${label}鉴权：?token= 查询参数同样可用（手机扫码打开的场景）`, async () => {
    const ctx = await contextFor(subjectId);
    const response = await fetch(`${ctx.server.base}/api/decks?token=${encodeURIComponent(ctx.server.token)}`);
    assert.equal(response.status, 200);
  });

  test(`${label}鉴权：/api/config 与 /api/health 免 token，但带错 token 仍 401`, async () => {
    const ctx = await contextFor(subjectId);
    const config = await fetch(`${ctx.server.base}/api/config`);
    assert.equal(config.status, 200, '不带 token 应放行 /api/config');
    const health = await fetch(`${ctx.server.base}/api/health`);
    assert.equal(health.status, 200, '不带 token 应放行 /api/health');

    const wrongConfig = await fetch(`${ctx.server.base}/api/config`, { headers: { 'x-anki-token': 'wrong-token-value-xx' } });
    assert.equal(wrongConfig.status, 401, '带错 token 必须仍被拒绝，否则前端无法判断口令对错');
    const wrongHealth = await fetch(`${ctx.server.base}/api/health`, { headers: { 'x-anki-token': 'wrong-token-value-xx' } });
    assert.equal(wrongHealth.status, 401);

    const rightConfig = await fetch(`${ctx.server.base}/api/config`, { headers: { 'x-anki-token': ctx.server.token } });
    assert.equal(rightConfig.status, 200);
  });

  test(`${label}/api/config 只返回开关，不泄露任何密钥`, async () => {
    const ctx = await contextFor(subjectId);
    const result = await ctx.server.api('/api/config');
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.json).sort(), ['apiUrl', 'hasKey', 'hasSearch', 'hasZhihu', 'model', 'tts']);
    assert.equal(typeof result.json.tts, 'boolean', 'tts 只报可用性开关，不暴露语音名单');
    assert.equal(result.json.hasKey, true);
    assert.equal(result.json.hasSearch, true);
    assert.equal(result.json.hasZhihu, true);
    const raw = JSON.stringify(result.json);
    for (const secret of ['test-api-key', 'test-zhihu-key', 'test-tavily-key']) {
      assert.ok(!raw.includes(secret), `响应里不应出现密钥 ${secret}`);
    }
  });

  test(`${label}/api/health 返回 AnkiConnect 版本`, async () => {
    const ctx = await contextFor(subjectId);
    const result = await ctx.server.api('/api/health');
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true, version: 6, collection: true }, '体检要多报一项「集合能不能用」');
  });

  test(`${label}/api/deck/create：空名 400、层级非法 400、控制字符 400、正常 200`, async () => {
    const ctx = await contextFor(subjectId);
    const empty = await ctx.server.api('/api/deck/create', { method: 'POST', body: { deck: '   ' } });
    assert.equal(empty.status, 400);
    assert.match(empty.json.error, /牌组名不能为空/);

    const badLevel = await ctx.server.api('/api/deck/create', { method: 'POST', body: { deck: '生物::::细胞' } });
    assert.equal(badLevel.status, 400);
    assert.match(badLevel.json.error, /牌组层级不能为空/);

    const tailEmpty = await ctx.server.api('/api/deck/create', { method: 'POST', body: { deck: '生物::' } });
    assert.equal(tailEmpty.status, 400);

    const control = await ctx.server.api('/api/deck/create', { method: 'POST', body: { deck: '生物\u0007细胞' } });
    assert.equal(control.status, 400);
    assert.match(control.json.error, /控制字符/);

    const ok = await ctx.server.api('/api/deck/create', { method: 'POST', body: { deck: `测试牌组-${subjectId}::子牌组` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.deck, `测试牌组-${subjectId}::子牌组`);
    assert.ok(ctx.anki.state.decks.includes(`测试牌组-${subjectId}::子牌组`));
  });

  test(`${label}/api/deck/delete：dryRun 只预览不删除，确认后才真删（自建测试牌组，删干净）`, async () => {
    const ctx = await contextFor(subjectId);
    const deck = `自动化测试牌组-${subjectId}`;
    const sub = `${deck}::子牌组`;
    await ctx.server.api('/api/deck/create', { method: 'POST', body: { deck } });
    await ctx.server.api('/api/deck/create', { method: 'POST', body: { deck: sub } });
    ctx.anki.state.cardCounts.set(deck, 3);
    assert.ok(ctx.anki.state.decks.includes(deck) && ctx.anki.state.decks.includes(sub));

    const before1 = ctx.anki.callsFor('deleteDecks').length;
    const preview = await ctx.server.api('/api/deck/delete', { method: 'POST', body: { deck, dryRun: true } });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.deck, deck);
    assert.deepEqual(preview.json.decks, [deck, sub]);
    assert.deepEqual(preview.json.subdecks, [sub]);
    assert.equal(preview.json.cardCount, 3);
    assert.equal(ctx.anki.callsFor('deleteDecks').length, before1, 'dryRun 不得调用 deleteDecks');
    assert.ok(ctx.anki.state.decks.includes(deck), 'dryRun 后牌组必须还在');

    const removed = await ctx.server.api('/api/deck/delete', { method: 'POST', body: { deck } });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json.deleted, [deck, sub]);
    assert.equal(removed.json.cardsToo, true, 'Anki 2.1.28+ 必须带 cardsToo: true');
    const call = ctx.anki.callsFor('deleteDecks').pop();
    assert.equal(call.params.cardsToo, true);
    assert.ok(!ctx.anki.state.decks.includes(deck), '真删后主牌组应消失');
    assert.ok(!ctx.anki.state.decks.includes(sub), '真删后子牌组应消失');

    const again = await ctx.server.api('/api/deck/delete', { method: 'POST', body: { deck } });
    assert.equal(again.status, 400);
    assert.match(again.json.error, /牌组不存在/);
  });

  test(`${label}/api/deck/delete：Anki 默认牌组不能删`, async () => {
    const ctx = await contextFor(subjectId);
    const result = await ctx.server.api('/api/deck/delete', { method: 'POST', body: { deck: 'Default' } });
    assert.equal(result.status, 400);
    assert.match(result.json.error, /默认牌组不能删除/);
  });

  test(`${label}/api/generate：带调研内容时提示词注入约束，图片照常发出`, async () => {
    const ctx = await contextFor(subjectId);
    const result = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: {
        url: ctx.ai.url,
        key: 'client-key',
        model: 'test-model',
        images: ['data:image/png;base64,AAAA'],
        reference: '细胞膜是高考高频考点，流动镶嵌模型常考易错点。'
      }
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.cards.length, 2);

    const prompt = ctx.ai.lastPrompt();
    assert.match(prompt, /联网考情调研/);
    assert.match(prompt, /不是制卡素材/);
    assert.match(prompt, /细胞膜是高考高频考点/);
    assert.equal(ctx.ai.lastImages().length, 1, '图片必须仍然随请求发出');
    assert.equal(ctx.ai.lastImages()[0].image_url.url, 'data:image/png;base64,AAAA');
    assert.equal(ctx.ai.last().body.model, 'test-model');
    assert.equal(ctx.ai.last().headers.authorization, 'Bearer client-key');
  });

  test(`${label}/api/generate：不带调研内容时不出现调研注入文案`, async () => {
    const ctx = await contextFor(subjectId);
    const result = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'm', images: ['data:image/png;base64,BBBB'] }
    });
    assert.equal(result.status, 200);
    const prompt = ctx.ai.lastPrompt();
    assert.ok(!prompt.includes('联网考情调研'), '没有 reference 时不应出现调研块');
    assert.ok(!prompt.includes('不是制卡素材'));
  });

  test(`${label}/api/generate：超长调研内容被截断到 20000 字`, async () => {
    const ctx = await contextFor(subjectId);
    const result = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'm', images: ['data:image/png;base64,CCCC'], reference: 'A'.repeat(30000) }
    });
    assert.equal(result.status, 200);
    const prompt = ctx.ai.lastPrompt();
    assert.ok(prompt.includes('A'.repeat(20000)), '应保留前 20000 字');
    assert.ok(!prompt.includes('A'.repeat(20001)), '不得保留第 20001 字');
  });

  test(`${label}/api/generate：maxReference 可自定义（默认 20000，硬上限 60000，非法值回落默认）`, async () => {
    const ctx = await contextFor(subjectId);
    const wide = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'm', images: ['data:image/png;base64,DDDD'], reference: 'B'.repeat(50000), maxReference: 30000 }
    });
    assert.equal(wide.status, 200);
    const widePrompt = ctx.ai.lastPrompt();
    assert.ok(widePrompt.includes('B'.repeat(30000)), '应保留前 30000 字');
    assert.ok(!widePrompt.includes('B'.repeat(30001)), '不得保留第 30001 字');

    const capped = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'm', images: ['data:image/png;base64,DDDD'], reference: 'C'.repeat(70000), maxReference: 999999 }
    });
    assert.equal(capped.status, 200);
    const cappedPrompt = ctx.ai.lastPrompt();
    assert.ok(cappedPrompt.includes('C'.repeat(60000)), '硬上限是 60000 字');
    assert.ok(!cappedPrompt.includes('C'.repeat(60001)), '不得保留第 60001 字');

    const tiny = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'm', images: ['data:image/png;base64,DDDD'], reference: 'E'.repeat(900), maxReference: 1 }
    });
    assert.equal(tiny.status, 200);
    assert.ok(ctx.ai.lastPrompt().includes('E'.repeat(500)), '低于下限夹到 500 字');

    const fallback = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'm', images: ['data:image/png;base64,DDDD'], reference: 'D'.repeat(25000), maxReference: 'abc' }
    });
    assert.equal(fallback.status, 200);
    const fallbackPrompt = ctx.ai.lastPrompt();
    assert.ok(fallbackPrompt.includes('D'.repeat(20000)), '非法值回到默认 20000 字');
    assert.ok(!fallbackPrompt.includes('D'.repeat(20001)), '不得保留第 20001 字');
  });

  test(`${label}/api/generate：缺少图片/模型时 400`, async () => {
    const ctx = await contextFor(subjectId);
    const noImage = await ctx.server.api('/api/generate', { method: 'POST', body: { url: ctx.ai.url, key: 'k', model: 'm', images: [] } });
    assert.equal(noImage.status, 400);
    assert.match(noImage.json.error, /缺少 API、模型或图片/);
  });

  test(`${label}/api/history：需要口令，并把每次生成/导入的汇总记下来`, async () => {
    const ctx = await contextFor(subjectId);
    const noToken = await fetch(`${ctx.server.base}/api/history`);
    assert.equal(noToken.status, 401, '历史记录也是敏感数据，没口令不给看');

    const generated = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'demo-model', images: ['data:image/png;base64,AAAA'], reference: '细胞膜是高考高频考点' }
    });
    assert.equal(generated.status, 200);
    const cardCount = generated.json.cards.length;

    const imported = await ctx.server.api('/api/import', {
      method: 'POST',
      body: { deck: '生物::细胞膜', cards: [{ type: 'basic', front: '甲', back: '乙' }] }
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.json));

    const history = await ctx.server.api('/api/history?limit=50');
    assert.equal(history.status, 200);
    const records = history.json.records;
    const gen = records.find(record => record.kind === 'generate');
    const imp = records.find(record => record.kind === 'import');
    assert.ok(gen, `应有一条生成记录：${JSON.stringify(records)}`);
    assert.ok(imp, '应有一条导入记录');

    assert.equal(gen.subject, subjectId, '记录要带学科，历史页才能标出来');
    assert.equal(gen.model, 'demo-model');
    assert.equal(gen.total, cardCount);
    assert.equal(gen.basic + gen.cloze, cardCount);
    assert.equal(gen.referenceChars, '细胞膜是高考高频考点'.length);
    assert.equal(gen.titles.length, cardCount, '列表里每张卡给一条摘要');
    assert.equal(gen.titles[0].length <= 80, true, '摘要要截断，别把整张卡塞进列表');
    assert.ok(typeof gen.ms === 'number' && gen.ms >= 0);
    assert.equal(gen.error, undefined);
    assert.equal(gen.restorable, true, '存了卡片正文的记录才可载入');
    assert.equal(gen.cards, undefined, '列表不带卡片正文，免得一次拉几百 KB');

    // 单条取回：带完整卡片正文，能在界面上接着改/预览/导入
    const item = await ctx.server.api(`/api/history/item?t=${gen.t}`);
    assert.equal(item.status, 200);
    assert.equal(item.json.record.cards.length, cardCount, '卡片正文要原样取回来');
    assert.ok(item.json.record.cards.every(card => ['basic', 'cloze'].includes(card.type)));
    assert.equal(item.json.record.restorable, true);

    const itemNoToken = await fetch(`${ctx.server.base}/api/history/item?t=${gen.t}`);
    assert.equal(itemNoToken.status, 401, '卡片正文是学习内容，一样要口令');
    const missing = await ctx.server.api('/api/history/item?t=1');
    assert.equal(missing.status, 404);
    assert.match(missing.json.error, /找不到这条历史记录/);

    assert.equal(imp.deck, '生物::细胞膜');
    assert.equal(imp.requested, 1);
    assert.equal(imp.added, 1);
    assert.equal(imp.skipped, 0);

    assert.ok(history.json.file.endsWith('history.jsonl'), '返回记录文件路径，方便直接打开看');
  });

  test(`${label}/api/import：开启自动分层后按每张卡的 group 建子牌组并分层导入（父牌组只作父级）`, async () => {
    const anki = await startFakeAnki(['Default', '生物::细胞膜']);
    const srv = await startServer({ subject: subjectId, ankiUrl: anki.url });
    try {
      const res = await srv.api('/api/import', {
        method: 'POST',
        body: {
          deck: '生物::细胞膜',
          autoGroup: true,
          groupRule: '按教材节划分',
          cards: [
            { type: 'basic', front: '甲', back: '乙', group: '第 1 节' },
            { type: 'basic', front: '丙', back: '丁', group: '第 2 节' },
            { type: 'basic', front: '戊', back: '己' }
          ]
        }
      });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.added, 3);
      const created = anki.callsFor('createDeck').map(call => call.params.deck).sort();
      assert.deepEqual(created, ['生物::细胞膜::第 1 节', '生物::细胞膜::第 2 节'], '只建缺少的子牌组，父牌组本身不新建');
      const decks = anki.callsFor('addNotes')[0].params.notes.map(note => note.deckName).sort();
      assert.deepEqual(decks, ['生物::细胞膜', '生物::细胞膜::第 1 节', '生物::细胞膜::第 2 节'], '没给 group 的卡留在父牌组');

      // 没开自动分层时，卡片里就算带 group 也一律忽略，不建任何子牌组
      const off = await srv.api('/api/import', {
        method: 'POST',
        body: { deck: '生物::细胞膜', cards: [{ type: 'basic', front: '庚', back: '辛', group: '第 9 节' }] }
      });
      assert.equal(off.status, 200, JSON.stringify(off.json));
      assert.equal(anki.callsFor('createDeck').length, 2, '关着的时候不该建子牌组');
      assert.ok(anki.callsFor('addNotes')[1].params.notes.every(note => note.deckName === '生物::细胞膜'), '关着的时候全部进父牌组');
    } finally { await srv.stop(); await anki.close(); }
  });

  test(`${label}/api/import：没勾选的卡片类型不导入；遮挡卡也跟着分层走`, async () => {
    const anki = await startFakeAnki(['Default', '生物::细胞膜']);
    const srv = await startServer({ subject: subjectId, ankiUrl: anki.url });
    try {
      const res = await srv.api('/api/import', {
        method: 'POST',
        body: {
          deck: '生物::细胞膜',
          enabledTypes: ['basic'],
          cards: [
            { type: 'basic', front: '甲', back: '乙' },
            { type: 'cloze', text: '丙{{c1::丁}}' }
          ]
        }
      });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.added, 1, '只导入勾选的普通卡');
      const notes = anki.callsFor('addNotes')[0].params.notes;
      assert.equal(notes.length, 1);
      assert.equal(notes[0].modelName, 'Basic');

      const none = await srv.api('/api/import', {
        method: 'POST',
        body: { deck: '生物::细胞膜', enabledTypes: [], cards: [{ type: 'basic', front: '甲', back: '乙' }] }
      });
      assert.equal(none.status, 400);
      assert.match(none.json.error, /没有启用类型/);

      const media = await srv.api('/api/import', {
        method: 'POST',
        body: {
          deck: '生物::细胞膜',
          autoGroup: true,
          cards: [{ type: 'occlusion', image: 'data:image/png;base64,iVBORw0KGgo=', front: '看图', back: '答案', masks: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }], group: '第 3 节' }]
        }
      });
      assert.equal(media.status, 200, JSON.stringify(media.json));
      assert.ok(anki.callsFor('createDeck').some(call => call.params.deck === '生物::细胞膜::第 3 节'), '遮挡卡也要跟其它卡一起分层');
    } finally { await srv.stop(); await anki.close(); }
  });

  test(`${label}/api/generate：开启自动分层时提示词带分组规则，示例图作为额外参考图发出`, async () => {
    const ctx = await contextFor(subjectId);
    const res = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: {
        url: ctx.ai.url, key: 'k', model: 'demo-model', images: ['data:image/png;base64,AAAA'],
        autoGroup: true, groupRule: '按教材章 / 节划分', groupExample: 'data:image/png;base64,AAAA'
      }
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const prompt = ctx.ai.lastPrompt();
    assert.match(prompt, /自动分层导入已开启/);
    assert.match(prompt, /按教材章 \/ 节划分/);
    assert.equal(ctx.ai.lastImages().length, 2, '教材图 + 分组示例图');

    const plain = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'demo-model', images: ['data:image/png;base64,AAAA'] }
    });
    assert.equal(plain.status, 200);
    assert.doesNotMatch(ctx.ai.lastPrompt(), /自动分层导入已开启/, '没勾就不该出现分层说明');
    assert.equal(ctx.ai.lastImages().length, 1);

    // 只勾了部分类型时，提示词要直说，免得模型白产一批会被过滤掉的卡
    const limited = await ctx.server.api('/api/generate', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'demo-model', images: ['data:image/png;base64,AAAA'], enabledTypes: ['basic'] }
    });
    assert.equal(limited.status, 200);
    assert.match(ctx.ai.lastPrompt(), /本次只允许输出这些卡片 type：basic/);
    assert.doesNotMatch(ctx.ai.lastPrompt(), /本次只允许输出这些卡片 type：basic、cloze/);
  });

  test(`${label}/api/apkg：导出 .apkg（含分层子牌组与媒体），全过程不碰 AnkiConnect`, async () => {
    const ctx = await contextFor(subjectId);
    const before = ctx.anki.callsFor('addNotes').length;
    const response = await fetch(`${ctx.server.base}${ctx.server.mount}/api/apkg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-anki-token': ctx.server.token },
      body: JSON.stringify({
        deck: '生物::细胞膜',
        autoGroup: true,
        cards: [
          { type: 'basic', front: '导出甲', back: '导出乙', group: '第 1 节' },
          { type: 'cloze', text: '水是 {{c1::液体}}', note: '备注' }
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /octet-stream/);
    assert.match(response.headers.get('content-disposition') || '', /\.apkg/);
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(ctx.anki.callsFor('addNotes').length, before, '导出 .apkg 不该往 AnkiConnect 写卡');

    const files = unzipSync(buffer);
    const file = path.join(os.tmpdir(), `cardflow-apkg-route-${Date.now()}.anki2`);
    fs.writeFileSync(file, files['collection.anki2']);
    const db = new DatabaseSync(file);
    try {
      const decks = Object.values(JSON.parse(db.prepare('SELECT decks FROM col').get().decks)).map(deck => deck.name).sort();
      assert.deepEqual(decks, ['生物::细胞膜', '生物::细胞膜::第 1 节'], '开了自动分层就按子牌组导出');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n, 2);
    } finally {
      db.close();
      try { fs.rmSync(file, { force: true }); } catch (_) {}
    }
  });

  test(`${label}/api/card/retry：只重写一张、不记历史；方向留空就随机挑一个`, async () => {
    const ctx = await contextFor(subjectId);
    const before = (await ctx.server.api('/api/history?limit=200')).json.records.length;

    const withGuidance = await ctx.server.api('/api/card/retry', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'm', card: { type: 'basic', front: '甲', back: '乙', tags: ['通用制卡'] }, guidance: '更精炼一点' }
    });
    assert.equal(withGuidance.status, 200, JSON.stringify(withGuidance.json));
    assert.equal(withGuidance.json.angle, '更精炼一点', '按用户给的修改方向');
    assert.equal(withGuidance.json.random, false);
    assert.ok(withGuidance.json.card && withGuidance.json.card.type, '要返回一张可用的卡片');

    const random = await ctx.server.api('/api/card/retry', {
      method: 'POST',
      body: { url: ctx.ai.url, key: 'k', model: 'm', card: { type: 'basic', front: '甲', back: '乙' }, guidance: '   ' }
    });
    assert.equal(random.status, 200);
    assert.equal(random.json.random, true, '留空要标记为随机挑的');
    assert.ok(String(random.json.angle).length > 0, '随机也要给出方向文案');

    const after = (await ctx.server.api('/api/history?limit=200')).json.records.length;
    assert.equal(after, before, '单卡重试不算一次生成请求，不该多出历史记录');

    const broken = await ctx.server.api('/api/card/retry', {
      method: 'POST', body: { url: ctx.ai.url, key: 'k', model: 'm', card: { type: 'cloze', text: '没有 c1' } }
    });
    assert.equal(broken.status, 400);
    assert.match(broken.json.error, /格式有问题/);
  });

  test(`${label}/api/history/card：采纳新版后覆盖那条历史里的同一张`, async () => {
    const ctx = await contextFor(subjectId);
    const generated = await ctx.server.api('/api/generate', {
      method: 'POST', body: { url: ctx.ai.url, key: 'k', model: 'm', images: ['data:image/png;base64,FFFF'] }
    });
    assert.equal(generated.status, 200);
    const stamp = generated.json.historyT;
    assert.ok(Number(stamp) > 0, '生成要带回这条历史的时间戳，前端才能回写到同一条');

    const revised = { type: 'basic', front: '改写后的正面', back: '改写后的背面', tags: ['改写'] };
    const updated = await ctx.server.api('/api/history/card', { method: 'POST', body: { t: stamp, index: 0, card: revised } });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.match(updated.json.titles[0], /改写后的正面/);

    const item = await ctx.server.api(`/api/history/item?t=${stamp}`);
    assert.equal(item.json.record.cards[0].front, '改写后的正面');
    assert.equal(item.json.record.revised, 1, '要留个痕迹：这张被改过');
    const listed = (await ctx.server.api('/api/history?limit=100')).json.records.find(record => Number(record.t) === Number(stamp));
    assert.equal(listed.titles[0], item.json.record.cards[0].front.slice(0, 80), '列表摘要也要跟着变');
    assert.equal(listed.total, item.json.record.cards.length, '张数统计要重算');

    const badCard = await ctx.server.api('/api/history/card', { method: 'POST', body: { t: stamp, index: 0, card: { type: 'cloze', text: '没有 c1' } } });
    assert.equal(badCard.status, 400);
    assert.match(badCard.json.error, /不接受的卡片格式/);

    const missing = await ctx.server.api('/api/history/card', { method: 'POST', body: { t: 123, index: 0, card: revised } });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /找不到这条历史记录/);

    const noToken = await fetch(`${ctx.server.base}/api/history/card`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: stamp, index: 0, card: revised })
    });
    assert.equal(noToken.status, 401);
  });

  test(`${label}/api/sync：触发电脑上的 Anki 与 AnkiWeb 同步（未登录/全量同步给中文提示）`, async () => {
    const ctx = await contextFor(subjectId);
    const noToken = await fetch(`${ctx.server.base}/api/sync`, { method: 'POST' });
    assert.equal(noToken.status, 401, '能触发写操作，必须带口令');

    const ok = await ctx.server.api('/api/sync', { method: 'POST' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.ok, true);
    assert.ok(typeof ok.json.ms === 'number' && ok.json.ms >= 0);
    assert.ok(ctx.anki.state.syncs >= 1, '应该真的调用了 AnkiConnect 的 sync');

    const syncError = async error => {
      const anki = await startFakeAnki(['Default'], { syncError: error });
      const srv = await startServer({ subject: subjectId, ankiUrl: anki.url });
      try {
        const res = await srv.api('/api/sync', { method: 'POST' });
        assert.equal(res.status, 400);
        return res.json.error;
      } finally { await srv.stop(); await anki.close(); }
    };
    assert.match(await syncError('sync: auth not configured'), /没登录 AnkiWeb/, '要告诉用户去哪里登录');
    assert.match(await syncError('Sync status 2 not one of [1, 0] - see https://github.com/ankitects/anki'), /全量同步/, '全量同步只能人工做，要写清楚');
  });

  test(`${label}/api/history：失败也记一笔（带错误原因）`, async () => {
    const ctx = await contextFor(subjectId);
    const failed = await ctx.server.api('/api/import', {
      method: 'POST',
      body: { deck: '生物::细胞膜', cards: [{ type: 'cloze', text: '没有 c1 的填空 {{c2::甲}}' }] }
    });
    assert.equal(failed.status, 400);
    const records = (await ctx.server.api('/api/history?limit=20')).json.records;
    const entry = records.find(record => record.kind === 'import' && record.error);
    assert.ok(entry, `失败的导入也要留记录：${JSON.stringify(records)}`);
    assert.match(entry.error, /必须且只能使用 c1/);
  });

  test(`${label}：AnkiConnect 说「集合不可用」时给中文可操作提示（两个 Anki 抢 8765 的场景）`, async () => {
    const broken = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const isVersion = /"action"\s*:\s*"version"/.test(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(isVersion ? { result: 6, error: null } : { result: null, error: 'collection is not available' }));
      });
    });
    await new Promise(resolve => broken.listen(0, '127.0.0.1', resolve));
    const srv = await startServer({ subject: subjectId, ankiUrl: `http://127.0.0.1:${broken.address().port}` });
    try {
      const decks = await srv.api('/api/decks');
      assert.equal(decks.status, 400);
      assert.match(decks.json.error, /集合不可用/);
      assert.match(decks.json.error, /两个 Anki/, '要直接告诉用户怎么办，而不是甩英文原文');
      assert.ok(!/collection is not available/.test(decks.json.error), '不再把英文原文原样丢给用户');

      const health = await srv.api('/api/health');
      assert.equal(health.status, 200, '体检接口自身不能因为集合坏了而失败');
      assert.equal(health.json.ok, true);
      assert.equal(health.json.version, 6);
      assert.equal(health.json.collection, false, '版本能通不代表集合能用，体检要分开报');
      assert.match(health.json.collectionError, /集合不可用/);
    } finally {
      await srv.stop();
      await new Promise(resolve => broken.close(resolve));
    }
  });

  test(`${label}/api/fetch：非法链接 400、上游非 200 返回可读中文错误`, async () => {
    const ctx = await contextFor(subjectId);
    const bad = await ctx.server.api('/api/fetch', { method: 'POST', body: { url: 'not-a-url' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /无效的链接/);

    const forbidden = await ctx.server.api('/api/fetch', { method: 'POST', body: { url: 'https://example.com/forbidden' } });
    assert.equal(forbidden.status, 400);
    assert.match(forbidden.json.error, /抓取原文失败（HTTP 403）/);
  });

  test(`${label}/api/fetch：清洗 Markdown 噪音，suspicious 标记正确`, async () => {
    const ctx = await contextFor(subjectId);
    const ok = await ctx.server.api('/api/fetch', { method: 'POST', body: { url: 'https://example.com/normal' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.suspicious, false);
    assert.ok(ok.json.content.includes('磷脂双分子层'));
    assert.ok(!ok.json.content.includes('Title:'));
    assert.ok(!ok.json.content.includes('URL Source:'));
    assert.ok(!ok.json.content.includes('!['), '图片 Markdown 应被去掉');
    assert.ok(ok.json.content.includes('链接文字'), '链接应保留文字、去掉地址');
    assert.ok(!ok.json.content.includes('http://example.com/b'));
    assert.ok(ok.json.length >= ok.json.content.length, 'length 是清洗后的总字数，不小于返回片段');

    const noisy = await ctx.server.api('/api/fetch', { method: 'POST', body: { url: 'https://example.com/noise' } });
    assert.equal(noisy.status, 200);
    assert.equal(noisy.json.suspicious, true, '页面框架噪音达到 3 处应标记 suspicious');

    const long = await ctx.server.api('/api/fetch', { method: 'POST', body: { url: 'https://example.com/long' } });
    assert.ok(long.json.length > 9000, `长文清洗后应远超 5000 字，实际 ${long.json.length}`);
    const clamped = await ctx.server.api('/api/fetch', { method: 'POST', body: { url: 'https://example.com/long', limit: 100 } });
    assert.equal(clamped.json.content.length, 500, 'limit 下限是 500');
    const big = await ctx.server.api('/api/fetch', { method: 'POST', body: { url: 'https://example.com/long', limit: 99999 } });
    assert.equal(big.json.content.length, big.json.length, 'limit 上限 40000，长文完整返回');
  });

  test(`${label}/api/search：知乎 MCP over SSE（含 id 撞车的 ping 不被当成响应吞掉）`, async () => {
    const ctx = await contextFor(subjectId);
    const result = await ctx.server.api('/api/search', { method: 'POST', body: { query: '细胞膜 结构 考点', channel: 'zhihu', maxResults: 5 } });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.provider, '知乎站内搜索');
    assert.equal(result.json.results.length, 2);
    assert.equal(result.json.results[0].title, '★ zhihu.com · 细胞膜的结构 考点总结');
    assert.equal(result.json.results[0].url, 'https://www.zhihu.com/question/100', 'URL 上的查询串应被去掉');
    assert.match(result.json.results[1].content, /糖蛋白只分布在细胞膜外侧/);

    assert.ok(ctx.zhihu.state.connects >= 1, '应建立过 SSE 连接');
    assert.ok(ctx.zhihu.state.toolCalls >= 1, '应发过 tools/call');
    assert.ok(ctx.zhihu.state.pongs.length >= 1, '收到服务端 ping 后必须回空 result，才不会被当成响应吞掉');
    const pong = ctx.zhihu.state.pongs[0];
    assert.equal(pong.method, undefined);
    assert.deepEqual(pong.result, {});
  });

  test(`${label}/api/search：空检索词 400`, async () => {
    const ctx = await contextFor(subjectId);
    const result = await ctx.server.api('/api/search', { method: 'POST', body: { query: '   ' } });
    assert.equal(result.status, 400);
    assert.match(result.json.error, /请输入检索关键词/);
  });

  test(`${label}未知接口返回 404`, async () => {
    const ctx = await contextFor(subjectId);
    const result = await ctx.server.api('/api/does-not-exist');
    assert.equal(result.status, 404);
    assert.match(result.json.error, /接口不存在/);
  });

  // 学科特有行为：化学有 /api/normalize（公式标准化），生物保持原来的 404
  if (subjectId === 'chem') {
    test(`${label}/api/normalize：化学式被规范成 MathJax mhchem，其它学科没有这个接口`, async () => {
      const ctx = await contextFor(subjectId);
      const result = await ctx.server.api('/api/normalize', {
        method: 'POST',
        body: { cards: [{ type: 'basic', front: 'H2O 是什么', back: '\\ce{H2O}', tags: [] }] }
      });
      assert.equal(result.status, 200);
      assert.match(result.json.cards[0].back, /\\\(\\ce\{H2O\}\\\)/);

      const bio = await contextFor('demo');
      const missing = await bio.server.api('/api/normalize', { method: 'POST', body: { cards: [] } });
      assert.equal(missing.status, 404, '生物没有 /api/normalize，应与重构前一致');
      assert.match(missing.json.error, /接口不存在/);
    });
  }
}
