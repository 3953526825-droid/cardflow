'use strict';
/* 联网检索：偏好站点排序、结果清洗，以及多家检索服务商的适配。
   Node（src/server.js）与安卓壳离线页共用 —— 请求本身由调用方注入的 transport 发
   （服务端用 fetch，手机走原生桥绕开 CORS）。

   为什么要多家：以前只有 Tavily 一个后端，用户既换不了服务商，手机上也只认 Tavily 的 Key。
   现在每个服务商只描述「怎么发请求、怎么把响应拆成 {title,url,content}」，
   上层（检索/调研）完全不关心是谁家。新增一家只需要在 SEARCH_PROVIDERS 里加一条。 */
(function (root) {
// 中国高中应试语境的站点，检索结果里这些站点的排在前面
const PREFERRED_DOMAINS = ['zhihu.com', 'baike.baidu.com', 'zxxk.com', 'jyeoo.com', 'pep.com.cn', 'wenku.baidu.com', 'eol.cn', 'tiku.baidu.com', '21cnjy.com', 'zujuan.com', 'gaokao.com', 'book118.com', 'edu.cn', 'jiajiaoban.com', 'koolearn.com', '51jiaoxi.com'];
function rankByDomains(results, domains) {
  const hit = item => {
    try {
      const host = new URL(item.url).host.replace(/^www\./, '');
      return domains.some(domain => host === domain || host.endsWith('.' + domain));
    } catch (_) { return false; }
  };
  return [...results].sort((a, b) => Number(hit(b)) - Number(hit(a)));
}
// 过滤掉明显不可用的检索片段：PDF 二进制、表格/标记符号堆、导航噪声、过短内容
function cleanSearchResults(results, preferredDomains = PREFERRED_DOMAINS) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const item of results || []) {
    const url = String(item.url || '').trim();
    const text = String(item.content || '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
    const symbols = (text.match(/[|<>{}\[\]\\\/=+*_~`#]/g) || []).length;
    const pipes = (text.match(/\|/g) || []).length;
    const navNoise = (text.match(/搜索|Search|Logo|首页|登录|注册|Menu|导航/gi) || []).length;
    const bad = !url || seen.has(url) || text.length < 40 || /%PDF|endobj|xref|\d+ \d+ obj/i.test(text) || pipes >= 6 || symbols / Math.max(text.length, 1) > 0.25 || navNoise >= 3;
    if (bad) { dropped++; continue; }
    seen.add(url);
    let host = '';
    try { host = new URL(url).host.replace(/^www\./, ''); } catch (_) { host = ''; }
    const star = host && preferredDomains.some(domain => host === domain || host.endsWith('.' + domain)) ? '★ ' : '';
    kept.push({ title: `${star}${host ? host + ' · ' : ''}${String(item.title || '').trim()}`.slice(0, 120), url, content: text.slice(0, 5000) });
  }
  return { results: kept, dropped };
}

/** 站内检索：Tavily 用 include_domains，其它服务商用 site: 算子（近似等价） */
function withSites(query, allowDomains) {
  if (!Array.isArray(allowDomains) || !allowDomains.length) return query;
  return `${query} ${allowDomains.map(domain => `site:${domain}`).join(' OR ')}`;
}
const pick = (value, fallback = '') => String(value == null ? fallback : value);

/**
 * 各服务商：只描述「请求怎么发」和「响应怎么拆成 {title,url,content}」。
 *   needsKey   没有 Key 就不能用（SearXNG 自建不需要）
 *   needsUrl   必须填接口地址（SearXNG / 自建）
 *   request    ({key, query, maxResults, url, allowDomains}) → transport 的参数
 *   items      (json) → [{title,url,content}]
 *   answer     (json) → 服务商自带的摘要（有就用，没有拉倒）
 *   error      (json) → 服务商自己的错误信息
 */
const SEARCH_PROVIDERS = {
  tavily: {
    label: 'Tavily',
    keyLabel: 'Tavily Key',
    keyHint: 'tavily.com 注册后，在控制台复制 tvly- 开头的 Key',
    needsKey: true,
    defaultUrl: 'https://api.tavily.com/search',
    request({ key, query, maxResults, url, allowDomains }) {
      const body = { query, max_results: maxResults, search_depth: 'advanced' };
      // 不取 include_answer：Tavily 的 AI 摘要对中文查询也常回英文，注进提示词反而有害
      if (Array.isArray(allowDomains) && allowDomains.length) body.include_domains = allowDomains;
      return { url: url || this.defaultUrl, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), timeout: 45000 };
    },
    items: json => json.results || [],
    answer: json => json.answer || '',
    error: json => (json.detail && json.detail.error) || json.error || ''
  },
  bocha: {
    label: '博查 Bocha',
    keyLabel: '博查 Key',
    keyHint: 'bochaai.com 注册后，在控制台复制 sk- 开头的 Key（国内可直连）',
    needsKey: true,
    defaultUrl: 'https://api.bochaai.com/v1/web-search',
    request({ key, query, maxResults, url, allowDomains }) {
      const body = { query: withSites(query, allowDomains), count: Math.min(Number(maxResults) || 10, 50), summary: true, freshness: 'noLimit' };
      return { url: url || this.defaultUrl, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), timeout: 45000 };
    },
    items(json) {
      const pages = json.data && json.data.webPages && json.data.webPages.value;
      return (pages || []).map(item => ({ title: item.name, url: item.url, content: item.summary || item.snippet || '' }));
    },
    answer: json => (json.data && json.data.webPages && json.data.webPages.value && json.data.webPages.value[0] && json.data.webPages.value[0].summary) || '',
    error: json => json.msg || json.message || ''
  },
  serper: {
    label: 'Serper（Google）',
    keyLabel: 'Serper Key',
    keyHint: 'serper.dev 注册后复制 API Key（送 2500 次）',
    needsKey: true,
    defaultUrl: 'https://google.serper.dev/search',
    request({ key, query, maxResults, url, allowDomains }) {
      const body = { q: withSites(query, allowDomains), num: Math.min(Number(maxResults) || 10, 100), gl: 'cn', hl: 'zh-cn' };
      return { url: url || this.defaultUrl, method: 'POST', headers: { 'content-type': 'application/json', 'X-API-KEY': pick(key) }, body: JSON.stringify(body), timeout: 45000 };
    },
    items: json => (json.organic || []).map(item => ({ title: item.title, url: item.link, content: item.snippet || '' })),
    error: json => json.message || ''
  },
  bing: {
    label: 'Bing（Azure）',
    keyLabel: 'Bing 订阅密钥',
    keyHint: 'Azure 里建 Bing Search 资源，复制密钥；接口地址一般不用改',
    needsKey: true,
    defaultUrl: 'https://api.bing.microsoft.com/v7.0/search',
    request({ key, query, maxResults, url, allowDomains }) {
      const base = url || this.defaultUrl;
      const params = new URLSearchParams({ q: withSites(query, allowDomains), count: String(Math.min(Number(maxResults) || 10, 50)), mkt: 'zh-CN', setlang: 'zh' });
      return { url: `${base}${base.includes('?') ? '&' : '?'}${params}`, method: 'GET', headers: { 'Ocp-Apim-Subscription-Key': pick(key), accept: 'application/json' }, timeout: 45000 };
    },
    items(json) {
      const pages = json.webPages && json.webPages.value;
      return (pages || []).map(item => ({ title: item.name, url: item.url, content: item.snippet || '' }));
    },
    error: json => (json.error && json.error.message) || ''
  },
  brave: {
    label: 'Brave',
    keyLabel: 'Brave Key',
    keyHint: 'brave.com/search/api 申请后复制订阅令牌',
    needsKey: true,
    defaultUrl: 'https://api.search.brave.com/res/v1/web/search',
    request({ key, query, maxResults, url, allowDomains }) {
      const base = url || this.defaultUrl;
      const params = new URLSearchParams({ q: withSites(query, allowDomains), count: String(Math.min(Number(maxResults) || 10, 20)), search_lang: 'zh-hans', country: 'cn' });
      return { url: `${base}${base.includes('?') ? '&' : '?'}${params}`, method: 'GET', headers: { 'X-Subscription-Token': pick(key), accept: 'application/json' }, timeout: 45000 };
    },
    items(json) {
      const pages = json.web && json.web.results;
      return (pages || []).map(item => ({ title: item.title, url: item.url, content: item.description || '' }));
    },
    error: json => (json.error && (json.error.detail || json.error.message)) || ''
  },
  exa: {
    label: 'Exa',
    keyLabel: 'Exa Key',
    keyHint: 'exa.ai 注册后复制 API Key（按次计费）',
    needsKey: true,
    defaultUrl: 'https://api.exa.ai/search',
    request({ key, query, maxResults, url, allowDomains }) {
      const body = { query: withSites(query, allowDomains), numResults: Math.min(Number(maxResults) || 10, 25), contents: { text: { maxCharacters: 2000 } } };
      return { url: url || this.defaultUrl, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': pick(key) }, body: JSON.stringify(body), timeout: 45000 };
    },
    items: json => (json.results || []).map(item => ({ title: item.title || item.url, url: item.url, content: item.text || item.summary || '' })),
    error: json => json.error || json.message || ''
  },
  searxng: {
    label: 'SearXNG（自建）',
    keyLabel: '',
    keyHint: '自己的 SearXNG 实例地址（需要开启 format=json），不用 Key',
    needsKey: false,
    needsUrl: true,
    defaultUrl: '',
    request({ key, query, maxResults, url, allowDomains }) {
      if (!url) throw new Error('SearXNG 需要填接口地址（例如 https://searx.example.com）。');
      const base = url.replace(/\/+$/, '');
      const params = new URLSearchParams({ q: withSites(query, allowDomains), format: 'json', language: 'zh-CN' });
      return { url: `${base}/search?${params}`, method: 'GET', headers: { accept: 'application/json' }, timeout: 45000 };
    },
    items: json => (json.results || []).slice(0, 50).map(item => ({ title: item.title, url: item.url, content: item.content || '' })),
    error: json => json.error || ''
  }
};

/** 给界面用：可选的检索服务商清单 */
function listSearchProviders() {
  return Object.keys(SEARCH_PROVIDERS).map(id => {
    const provider = SEARCH_PROVIDERS[id];
    return { id, label: provider.label, keyLabel: provider.keyLabel, keyHint: provider.keyHint, needsKey: provider.needsKey !== false, needsUrl: Boolean(provider.needsUrl), defaultUrl: provider.defaultUrl || '' };
  });
}
function resolveProvider(id) {
  const provider = SEARCH_PROVIDERS[id];
  if (provider) return { id, provider };
  return { id: 'tavily', provider: SEARCH_PROVIDERS.tavily };
}

/**
 * 按指定服务商检索一次，返回原始条目（未清洗）。
 * @param transport async ({url, method, headers, body, timeout}) → {status, body}
 */
async function searchWithProvider(transport, providerId, { key, query, maxResults = 10, url, allowDomains } = {}) {
  const { id, provider } = resolveProvider(providerId);
  if (provider.needsKey !== false && !String(key || '').trim()) {
    throw new Error(`未配置检索 Key：请填 ${provider.keyLabel}（${provider.keyHint}）`);
  }
  let request;
  try {
    request = provider.request({ key: String(key || '').trim(), query: String(query || ''), maxResults, url, allowDomains });
  } catch (error) { throw new Error(error.message); }
  let response;
  try {
    response = await transport(request);
  } catch (error) {
    throw new Error(`联网检索请求失败（${provider.label}）：${error.message}`);
  }
  let json = {};
  try { json = JSON.parse(response.body || '{}') || {}; } catch (_) { json = {}; }
  if (Number(response.status) >= 400) {
    throw new Error(provider.error(json) || `联网检索失败（${provider.label}，HTTP ${response.status}）。`);
  }
  return { providerId: id, provider: provider.label, answer: provider.answer ? provider.answer(json) : '', items: provider.items(json) || [] };
}

/**
 * 检索（兼容旧签名）：默认 Tavily，options.provider 可换服务商。
 * @param options.url           覆盖检索地址
 * @param options.provider      服务商 id（见 SEARCH_PROVIDERS）
 * @param options.domains       命中这些域名的结果排前面
 * @param options.allowDomains  只在这些域名里找（手机版用它做「知乎站内」）
 * @param options.keep          只保留前 N 条
 */
async function tavilySearch(transport, key, query, maxResults, options = {}) {
  const found = await searchWithProvider(transport, options.provider, { key, query, maxResults, url: options.url, allowDomains: options.allowDomains });
  const cleaned = cleanSearchResults(found.items);
  let results = cleaned.results;
  if (options.domains && options.domains.length) results = rankByDomains(results, options.domains);
  if (options.keep) results = results.slice(0, options.keep);
  return { query, answer: found.answer, results, dropped: cleaned.dropped, provider: found.provider, providerId: found.providerId };
}

const api = { PREFERRED_DOMAINS, rankByDomains, cleanSearchResults, SEARCH_PROVIDERS, listSearchProviders, resolveProvider, searchWithProvider, tavilySearch };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.CardFlowShared = Object.assign(root.CardFlowShared || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
