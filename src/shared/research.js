'use strict';
/*
 * 联网调研（对应服务端的 /api/research 与 /api/search）。
 *
 * 服务端保留自己的那份：它还能走知乎官方 MCP（SSE 长连接）。手机版这份两个通道都走 Tavily ——
 * 站内那条用 include_domains 限定知乎，所以「搜教材目录 → 定章节 → 搜考情」的流程与提示词保持一致。
 * 请求由注入的 transport 发（服务端 fetch / 手机原生桥），所以这里只放与技术无关的逻辑。
 */
(function (root) {
const shared = (typeof module !== 'undefined' && module.exports)
  ? { ...require('./search'), ...require('./render'), ...require('./parse') }
  : root.CardFlowShared;
const { tavilySearch, rankByDomains, renderTemplate, extractFirstJson } = shared;

/** 与 AI 服务商对话（读图定主题 / 锁定章节都要用），文案与服务端 aiChat 一致。 */
async function aiChat(transport, target, content, temperature = 0.2) {
  const response = await transport({
    url: String(target.url).replace(/\/$/, '') + '/chat/completions',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${target.key}` },
    body: JSON.stringify({ model: target.model, messages: [{ role: 'user', content }], temperature }),
    timeout: 120000
  });
  let result = {};
  try { result = JSON.parse(response.body || '{}') || {}; } catch (_) { result = {}; }
  if (Number(response.status) >= 400) throw new Error((result.error && result.error.message) || 'AI 请求失败。');
  const text = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
  if (!text) throw new Error('AI 未返回内容。');
  return text;
}

/** 一条检索：channel 'zhihu' → Tavily 限定知乎站内；其余 → 全网。provider 里标出来源。 */
async function webSearch({ transport, subject, key, query, maxResults, options = {} }) {
  const zhihuOnly = options.channel === 'zhihu';
  const found = await tavilySearch(transport, key, query, maxResults, zhihuOnly ? { ...options, allowDomains: ['zhihu.com'] } : options);
  return { ...found, provider: `${found.provider || '联网检索'}${zhihuOnly ? '（知乎站内）' : ' 全网'}` };
}

/** 手动检索（对应 /api/search）。 */
async function searchOnce({ transport, subject, key, query, maxResults, channel, provider, url }) {
  const max = Math.min(Math.max(Number(maxResults) || 5, 1), 10);
  const found = await webSearch({
    transport, subject, key, query, maxResults: max,
    options: { domains: subject.search && subject.search.preferredDomains, channel: channel || 'tavily', provider, url }
  });
  return { query: found.query, answer: found.answer, results: found.results, dropped: found.dropped, provider: found.provider };
}

/** 四步调研：读图定主题 → 搜教材目录 → 锁定章节 → 搜考情（返回结构与服务端一致）。 */
async function runResearch({ transport, subject, data, searchKey, searchProvider, searchUrl }) {
  // 服务商可换（Tavily / 博查 / Serper / Bing / Brave / Exa / 自建 SearXNG），Key 是哪个服务商的就得配哪个
  const chosen = shared.resolveProvider(searchProvider || (data && data.searchProvider));
  const searchOptions = { provider: chosen.id, url: searchUrl || (data && String(data.searchUrl || '').trim()) || undefined };
  if (!data.url || !data.key || !data.model || !Array.isArray(data.images) || (!data.images.length && !String(data.sourceText || '').trim())) throw new Error('缺少 API、模型或图片。');
  if (data.sourceText && (typeof data.sourceText !== 'string' || data.sourceText.length > 100000)) throw Error('资料文字不得超过 10 万字。');
  if (chosen.provider.needsKey !== false && !String(searchKey || '').trim()) throw new Error(`未配置联网检索 Key：请在「联网调研」里填 ${chosen.provider.keyLabel}（只保存在本机）。`);

  // 第 1 步（保守策略）：只认知识主题，不猜教材版本与章节位置，避免编造
  const identify = extractFirstJson(await aiChat(transport, data, [
    { type: 'text', text: renderTemplate(subject.prompts.identify, {}) },
    ...(data.sourceText ? [{ type: 'text', text: '用户提供的教材原文：\n' + data.sourceText }] : []),
    ...data.images.map(image => ({ type: 'image_url', image_url: { url: image } }))
  ], 0.1));
  const topicSeed = String(identify.topic || '').trim() || String((Array.isArray(identify.keypoints) && identify.keypoints[0]) || '').trim();
  if (!topicSeed) throw new Error('未能从图片判断出知识主题，请改用手动检索。');

  // 第 2 步：按「学科 + 主题 + 章节内容」检索该章节的教材内容
  const catalogQuery = `${subject.search.subjectPrefix} ${topicSeed} ${subject.search.catalogSuffix}`;
  const catalog = await webSearch({ transport, subject, key: searchKey, query: catalogQuery, maxResults: 8, options: { channel: 'global', ...searchOptions } });

  // 第 3 步：用目录证据锁定精确位置，再生成考情检索词
  const evidence = catalog.results.slice(0, 5).map(item => `【${item.title}】${String(item.content || '').slice(0, 900)}`).join('\n');
  const locked = extractFirstJson(await aiChat(transport, data, [
    { type: 'text', text: renderTemplate(subject.prompts.locate, {
      topic: topicSeed,
      keypoints: JSON.stringify(identify.keypoints || []),
      evidence: evidence || '（无）'
    }) }
  ], 0.1));

  // 第 4 步：锁定之后再搜考情（最多 2 条）
  const queries = (Array.isArray(locked.examQueries) ? locked.examQueries : []).map(item => String(item || '').trim()).filter(Boolean).slice(0, 2);
  if (!queries.length) throw new Error('未能生成考情检索词，请重试或改用手动检索。');
  const exams = [];
  const seenAcross = new Set();   // 跨检索词去重：两个检索词重复命中的内容不再重复出现
  for (const query of queries) {
    const [fromZhihu, fromGlobal] = await Promise.all([
      webSearch({ transport, subject, key: searchKey, query, maxResults: 6, options: { channel: 'zhihu', ...searchOptions } }).catch(() => null),
      webSearch({ transport, subject, key: searchKey, query, maxResults: 6, options: { channel: 'global', ...searchOptions } }).catch(() => null)
    ]);
    if (!fromZhihu && !fromGlobal) throw new Error(`考情检索失败：${query}`);
    // 两个通道各取前 3 条，避免知乎结果把教辅站结果全部挤掉
    const rankedZhihu = rankByDomains((fromZhihu && fromZhihu.results) || [], subject.search.preferredDomains);
    const rankedGlobal = rankByDomains((fromGlobal && fromGlobal.results) || [], subject.search.preferredDomains);
    const balanced = rankedZhihu.slice(0, 3).concat(rankedGlobal.slice(0, 3), rankedZhihu.slice(3), rankedGlobal.slice(3));
    const unique = [];
    const seenLocal = new Set();
    for (const item of balanced) {
      if (unique.length >= 6) break;
      if (seenLocal.has(item.url)) continue;
      seenLocal.add(item.url);
      unique.push(item);
    }
    const fresh = [];
    const repeated = [];
    unique.forEach(item => {
      if (seenAcross.has(item.url)) repeated.push(item);
      else { seenAcross.add(item.url); fresh.push(item); }
    });
    exams.push({
      query,
      answer: '',
      results: fresh.concat(repeated).slice(0, 6),
      dropped: ((fromZhihu && fromZhihu.dropped) || 0) + ((fromGlobal && fromGlobal.dropped) || 0),
      provider: [fromZhihu && fromZhihu.provider, fromGlobal && fromGlobal.provider].filter(Boolean).join(' + ') || '未知'
    });
  }
  return {
    identify: { topic: identify.topic || topicSeed, keypoints: Array.isArray(identify.keypoints) ? identify.keypoints : [] },
    position: locked.position || '', topic: locked.topic || topicSeed,
    catalogQuery, catalog: catalog.results, examQueries: queries, exams
  };
}

const api = { aiChat, webSearch, searchOnce, runResearch };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.CardFlowShared = Object.assign(root.CardFlowShared || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
