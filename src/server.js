const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const history = require('./history');

/** 各检索服务商的 Key：沿用 tavilyKey / zhihuKey 的老位置，新服务商读 <providerId>Key（也允许写在 config.search 里） */
function searchKeyOf(config, providerId) {
  const direct = config && config[providerId + 'Key'];
  if (direct) return String(direct).trim();
  const nested = config && config.search && config.search[providerId + 'Key'];
  return String(nested || '').trim();
}
const proCore = require('../public/core');
const mediaCards = require('./media');
const packs = require('./packs');
async function readPackJson(req) { let raw=''; for await (const part of req) { raw += part; if (raw.length > 200000) throw Error('学科包文件不得超过 200KB。'); } try { return JSON.parse(raw); } catch (_) { throw Error('学科包 JSON 格式错误。'); } }
const ANKI_URL = process.env.ANKI_URL || 'http://127.0.0.1:8765';
const JINA_BASE = process.env.ANKI_JINA_BASE || 'https://r.jina.ai/';
const ZHIHU_BASE = process.env.ANKI_ZHIHU_BASE || 'https://developer.zhihu.com';

/* ===== 学科：一份代码 + 每学科一份配置（subjects/<id>.json 与 config/<id>.config.json）===== */
const { loadPromptFile, renderTemplate } = require('./prompts');
/* ===== 纯逻辑（模板渲染 / 宽容解析 / 卡片校验与导出 / 提示词拼装）都在 src/shared/ 里：
   安卓壳的浏览器端与 Node 共用同一份实现，免得两条路径慢慢长歪。
   这里取到的还是原来那些同名函数，调用点一个都没动。 ===== */
const {
  extractFirstJson, salvageCards, parseGeneratedJson, cardIssue, validate, countCardTypes, cardTitles, escapeExportField, exportFields, exportText, deckForCard, EXPORT_TYPE_LABELS, referenceLimit, buildPrompt, generateMessages, chatRequest, parseGenerated,
  generateCards,
  retryPrompt, parseRetry, RETRY_ANGLES, cleanFetchedText, frameNoiseCount, fetchLimit,
  PREFERRED_DOMAINS, rankByDomains, cleanSearchResults, tavilySearch
} = require('./shared');
const { resolveProvider: resolveSearchProvider } = require('./shared');
const { buildApkg } = require('./apkg');
const tts = require('./tts');
const maintenance = require('./maintenance').create({
  dataDir: process.env.ANKI_DATA_DIR || path.join(ROOT, 'data'),
  packsDir: packs.DIR,
  version: (() => { try { return require('../package.json').version || '1.0.0'; } catch (_) { return '1.0.0'; } })(),
  historyFile: history.filePath()
});

const SUBJECTS_DIR = path.join(ROOT, 'subjects');
const ARGS = {};
process.argv.slice(2).forEach(arg => {
  const match = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
  if (match) ARGS[match[1]] = match[2] === undefined ? true : match[2];
});

function loadSubjects() {
  return fs.readdirSync(SUBJECTS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(SUBJECTS_DIR, name), 'utf8')))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map(subject => {
      // 测试用的逃逸开关：ANKI_CONFIG_<学科ID> 优先，其次 ANKI_CONFIG；生产环境不会设这两个变量。
      const configFile = process.env[`ANKI_CONFIG_${subject.id.toUpperCase()}`]
        || process.env.ANKI_CONFIG
        || path.join(ROOT, subject.configFile);
      subject.configFile = configFile;
      subject.config = { token: '', apiUrl: '', apiKey: '', model: '', tavilyKey: '', zhihuKey: '' };
      try {
        Object.assign(subject.config, JSON.parse(fs.readFileSync(configFile, 'utf8')));
      } catch (error) {
        console.log(`${subject.shortName}: cannot read ${subject.configFile} (${error.message})`);
      }
      subject.prompts = loadPromptFile(subject.promptFile);
      subject.postprocess = subject.postprocess === 'formula' ? require('./postprocess/formula') : null;
      return subject;
    });
}

const ALL_SUBJECTS = loadSubjects();
const BUILTIN_IDS = new Set(ALL_SUBJECTS.map(s => s.id));
for (const pack of packs.list()) {
  if (BUILTIN_IDS.has(pack.id)) throw Error('学科包 ID 与内置学科冲突：' + pack.id);
  ALL_SUBJECTS.push(packs.materialize(pack, ALL_SUBJECTS[0]));
}
const SELECTED = ARGS.subject ? ALL_SUBJECTS.find(subject => subject.id === ARGS.subject) : null;
if (ARGS.subject && !SELECTED) {
  console.log(`未知学科：${ARGS.subject}；可用学科：${ALL_SUBJECTS.map(subject => subject.id).join('、')}`);
  process.exit(1);
}
const MULTI = !SELECTED;
const SERVING = SELECTED ? [SELECTED] : ALL_SUBJECTS;
const PRIMARY = SERVING[0];
// 端口、AnkiConnect 地址、外部服务地址都支持用环境变量覆盖（只有 tests/ 会用到）。
const PORT = Number(process.env.ANKI_PORT || PRIMARY.httpPort);
// 一旦用 ANKI_PORT 改过主端口，就不再假设「标准端口」还归自己：HTTPS 默认改成随机端口，
// 免得临时起一个测试实例时把正在运行的服务的 3212/3213 抢了。
const HTTPS_PORT = Number(process.env.ANKI_HTTPS_PORT || (process.env.ANKI_PORT ? 0 : PRIMARY.httpsPort));
// 没有口令时绝不对外网卡暴露：多学科模式下必须每个学科都配了口令，才绑 0.0.0.0。
const ALL_HAVE_TOKEN = SERVING.every(subject => subject.config.token);
const HOST = process.env.ANKI_HOST || (ALL_HAVE_TOKEN ? '0.0.0.0' : '127.0.0.1');

// 自签证书：手机端需要安全上下文（Service Worker / 添加到主屏幕只在 https 或 localhost 生效）。
// cert.pfx 含私钥，只留在服务端目录；ca.crt 是公钥，可安全分发给手机安装。
const CERT_PASS = PRIMARY.config.certPass || 'anki-local';
let HTTPS_OPTIONS = null;
try {
  HTTPS_OPTIONS = { pfx: fs.readFileSync(path.join(ROOT, 'cert.pfx')), passphrase: CERT_PASS, minVersion: 'TLSv1.2' };
} catch (error) {
  console.log(`HTTPS disabled, cannot read cert.pfx (${error.message})`);
}

/* ===== 页面渲染：index.html / manifest.json 用 {{占位符}} 按学科渲染后返回 ===== */
function mountOf(subject, solo = false) { return (solo || !MULTI) ? '/' : `/${subject.id}/`; }

/** 图标文件的修改时间戳：换图后 URL 自动变化，浏览器/手机必须重新下载，不会拿旧图。 */
function iconVersion(subject) {
  try { return String(Math.floor(fs.statSync(path.join(PUBLIC, 'icon-cardflow-512.png')).mtimeMs)); }
  catch (_) { return subject.assetVersion || '1'; }
}

function computedValues(subject, solo = false, requestBase = null) {
  const base = mountOf(subject, solo);
  // 各学科的「规范地址」：主学科在主端口的挂载点（/bio/），其它学科在它们自己的独立端口根路径
  const linkTo = item => {
    if (!requestBase) return mountOf(item, false);
    const ownPort = (item === PRIMARY || !BUILTIN_IDS.has(item.id))
      ? (requestBase.ssl ? PRIMARY.httpsPort : PRIMARY.httpPort)
      : (requestBase.ssl ? item.httpsPort : item.httpPort);
    const ownPath = (item === PRIMARY || !BUILTIN_IDS.has(item.id)) ? mountOf(item, false) : '/';
    if (ownPort === requestBase.port) return ownPath;
    return `${requestBase.ssl ? 'https' : 'http'}://${requestBase.hostname}:${ownPort}${ownPath}`;
  };
  const script = {
    id: subject.id,
    pack: Boolean(subject.pack),
    base: base === '/' ? '' : base.replace(/\/$/, ''),
    assetVersion: subject.assetVersion,
    storageKey: subject.storageKey,
    tokenKey: subject.tokenKey,
    cardModeControl: subject.cardMode.controlId,
    cardModeField: subject.cardMode.field,
    defaultDeck: subject.anki.defaultDeck || '',
    previewNormalizes: Boolean(subject.previewNormalizes),
    // 单学科模式（含旧端口直供）下没有别的学科可选，切换器只会拿到自己一项（前端据此把控件隐藏）
    subjectSwitch: ALL_SUBJECTS.map(item => ({ id: item.id, name: item.name, href: linkTo(item) }))
  };
  const optionsHtml = subject.cardMode.options
    .map(option => `<option value="${option.value}"${option.value === subject.cardMode.default ? ' selected' : ''}>${option.label}</option>`)
    .join('');
  const navHtml = ALL_SUBJECTS
    .map(item => `<option value="${linkTo(item)}"${item.id === subject.id ? ' selected' : ''}>${item.name}</option>`)
    .join('');
  return {
    'subject.id': subject.pack ? 'bio' : subject.id,
    'subject.shortName': subject.shortName,
    'app.name': 'CardFlow',
    'subject.name': subject.name,
    'subject.themeColor': subject.themeColor,
    'subject.assetVersion': subject.assetVersion,
    'subject.iconVersion': iconVersion(subject),
    'subject.base': base,
    // viewport meta 永远要有（少了它手机会按 980px 桌面宽度渲染），viewport-fit 才是可选项
    'subject.viewportFit': subject.viewportFit ? ',viewport-fit=cover' : '',
    // 条件块用：真值给非空串、假值给空串（给布尔 false 的话 String(false) = 'false' 仍是真值）
    'subject.previewNormalizes': subject.previewNormalizes ? '1' : '',
    'cardMode.optionsHtml': optionsHtml,
    'cardCount.minAriaHtml': subject.cardCount.minAriaLabel ? ` aria-label="${subject.cardCount.minAriaLabel}"` : '',
    'cardCount.maxAriaHtml': subject.cardCount.maxAriaLabel ? ` aria-label="${subject.cardCount.maxAriaLabel}"` : '',
    'subjectScript': `<script>window.__SUBJECT__ = ${JSON.stringify(script).replace(/</g, '\\u003c')};</script>`,
    'navHtml': navHtml
  };
}

function lookupSubject(subject, key) {
  return key.split('.').reduce((value, part) => (value == null ? value : value[part]), subject);
}

/** 先处理 {{#key}}...{{/key}} 条件块，再替换 {{key}}；缺值一律抛错，避免页面上留半成品占位符。
 *  条件块的 key 同样必须存在——否则整块会被静默丢掉（曾经因此漏掉化学页面的 MathJax 注入）。 */
function renderSubjectTemplate(subject, template, solo = false, requestBase = null) {
  const computed = computedValues(subject, solo, requestBase);
  const valueOf = key => {
    const value = key in computed ? computed[key] : lookupSubject(subject, key);
    if (value === undefined) throw new Error(`模板里的占位符 {{${key}}} 在 subjects/${subject.id}.json 里没有对应值`);
    return value;
  };
  const withConditionals = String(template).replace(/\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, body) => {
    const value = valueOf(key);
    return String(value == null ? '' : value).trim() ? body : '';
  });
  return withConditionals.replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
    const value = valueOf(key);
    if (value === null || typeof value === 'object') {
      throw new Error(`模板里的占位符 {{${key}}} 在 subjects/${subject.id}.json 里没有对应值`);
    }
    return String(value);
  });
}

function readPage(subject, file, solo = false, requestBase = null) {
  return renderSubjectTemplate(subject, fs.readFileSync(path.join(PUBLIC, file), 'utf8'), solo, requestBase);
}

// 每个学科自己的静态资源。图标按 icon-<学科id>-192.png / icon-<学科id>-512.png 约定存放，
// 同时保留 /icon-192.png 这类通用路径（Service Worker 清单、旧快捷方式都还在用）。
function staticFile(subject, route, solo = false, requestBase = null) {
  const table = {
    '/manifest.json': ['application/manifest+json', 'manifest.json', true],
    '/cardflow.css': ['text/css', 'cardflow.css', false],
    '/sw.js': ['application/javascript', 'sw.js', false],
    '/app.js': ['application/javascript', 'app.js', false],
    '/files.js': ['application/javascript', 'files.js', false],
    '/core.js': ['application/javascript', 'core.js', false],
    '/workflow.js': ['application/javascript', 'workflow.js', false],
    '/index.html': ['text/html', 'index.html', true],
    '/icon-192.png': ['image/png', 'icon-cardflow-192.png', false],
    '/icon-512.png': ['image/png', 'icon-cardflow-512.png', false],
    '/apple-touch-icon.png': ['image/png', 'icon-cardflow-192.png', false],
    '/icon-cardflow-192.png': ['image/png', 'icon-cardflow-192.png', false],
    '/icon-cardflow-512.png': ['image/png', 'icon-cardflow-512.png', false],
    // 带学科名的文件名：换名字是为了绕开浏览器/手机按 origin 复用的图标缓存
    [`/icon-${subject.id}-192.png`]: ['image/png', 'icon-cardflow-192.png', false],
    [`/icon-${subject.id}-512.png`]: ['image/png', 'icon-cardflow-512.png', false]
  };
  const entry = table[route];
  if (!entry) return null;
  return { type: entry[0], body: entry[2] ? readPage(subject, entry[1], solo, requestBase) : fs.readFileSync(path.join(PUBLIC, entry[1])), file: entry[1] };
}


function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(body);
}
function json(res, status, value) { send(res, status, 'application/json', JSON.stringify(value)); }
function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 35 * 1024 * 1024) reject(new Error('请求图片过大')); });
    req.on('end', () => resolve(data)); req.on('error', reject);
  });
}
async function anki(action, params = {}) {
  let response;
  try {
    response = await fetch(ANKI_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, version: 6, params }) });
  } catch (error) {
    throw new Error(ankiErrorText(error));
  }
  if (!response.ok) throw new Error(`AnkiConnect HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(ankiErrorText(new Error(result.error)));
  return result.result;
}
/* AnkiConnect 的英文报错直接原样展示的话，用户根本看不出该怎么修（比如那句 collection is not available）。
   这里把几种常见的换成「中文 + 怎么做」。 */
function ankiErrorText(error) {
  const raw = (error && error.message) || String(error);
  if (/collection is not available/i.test(raw)) {
    return 'AnkiConnect 说「集合不可用」：Anki 没打开用户档案，或者你开了两个 Anki —— 第二个停在「选择用户」界面时会把 8765 端口抢走。请只留一个已打开牌组的 Anki（或完全退出 Anki 重新打开）再试。';
  }
  if (/ECONNREFUSED|fetch failed|socket hang up|ECONNRESET|ENOTFOUND/i.test(raw)) {
    return `连不上 AnkiConnect（${ANKI_URL}）：Anki 没打开，或者 AnkiConnect 插件被停用了。`;
  }
  if (/deck was not found/i.test(raw)) return 'Anki 里没有这个牌组：请点「刷新牌组」重新选一个（牌组可能被改名或删除了）。';
  if (/model was not found/i.test(raw)) return 'Anki 里没有这个笔记类型：请检查你的模板设置。';
  if (/sync: auth not configured/i.test(raw)) return '这台电脑的 Anki 还没登录 AnkiWeb：请在 Anki 里走「工具 > 偏好设置 > 同步」登录一次，回来再点同步。';
  if (/Sync status .* not one of/i.test(raw)) return 'AnkiWeb 要求全量同步（首次登录，或两端改动冲突时会遇到）。这一步只能人工做：在电脑上的 Anki 里点一次「同步」，按提示选择上传或下载。';
  if (/duplicate/i.test(raw)) return '这张卡片在 Anki 里已经存在（重复卡），已跳过。';
  return raw;
}
/* ===== 单卡重试：只重写一张，先把新版拿回来让用户对照，采纳了才覆盖 =====
   这不是一次新的「生成」：不写历史记录，也不影响其它卡片；采纳后用 /api/history/card 回写到原来那条历史里。 */
async function retryCard(subject, data) {
  const card = data.card;
  const issue = cardIssue(card);
  if (issue) throw new Error(`这张卡片本身格式有问题（${issue}），建议先修好或用「重试生成」整批重来。`);
  const guidance = String(data.guidance || '').trim();
  // 留空 = 随机挑一个方向；温度也高一点，好让新版真的有差别
  const angle = guidance || RETRY_ANGLES[Math.floor(Math.random() * RETRY_ANGLES.length)];
  const started = Date.now();
  const raw = await aiChat({ url: data.url, key: data.key, model: data.model }, [{ type: 'text', text: retryPrompt(subject, card, angle) }], guidance ? 0.4 : 0.75);
  const next = parseRetry(raw, subject.postprocess, card);
  if (!next) throw new Error('AI 没有返回可用的卡片。');
  const nextIssue = cardIssue(next);
  console.log(`[${subject.id}] card/retry ${Date.now() - started}ms 方向=「${angle}」${guidance ? '' : '（随机）'}${nextIssue ? ` 新版仍有格式问题：${nextIssue}` : ''}`);
  return { card: next, angle, random: !guidance, ms: Date.now() - started, issue: nextIssue };
}
/* ===== 本地 TTS（音频卡）：启动时探一次，/api/config 把结果告诉前端 ===== */
let TTS_AVAILABLE = false;
if (tts.enabled()) {
  tts.available().then(ok => {
    TTS_AVAILABLE = ok;
    if (ok) console.log('[tts] 本地语音可用（系统 SAPI），音频卡会在导入时自动合成。');
  }).catch(() => {});
}
/** 音频卡没有 audio 时用本地 TTS 合成（免费、离线）；合成不了就保持原样，让原来的报错提醒用户。 */
async function ensureAudio(card) {
  if (!card || card.type !== 'audio' || card.audio) return card;
  const spoken = String(card.speak || card.audioText || card.front || '').trim();
  if (!spoken) return card;
  const clip = await tts.synth(spoken);
  if (clip) card.audio = clip.dataUrl;
  return card;
}
async function generate(subject, data) {
  // 提示词、附加说明与「本次只允许哪些卡片类型」的拼装都在 src/shared/generate.js：
  // 安卓壳的离线路径用的是同一份实现，改提示词不会漏掉任何一条路径。
  // 请求体（max_tokens / 关思考 / JSON 模式 + 降级）与「解析失败自动重试一次」也在这份实现里。
  const content = generateMessages(subject, data);
  const { generated } = await generateCards({
    subject,
    data,
    content,
    send: async request => {
      const response = await fetch(request.url, request.init);
      return { status: response.status, bodyText: await response.text() };
    },
    // 宽容解析（修 LaTeX 反斜杠、捞多个 JSON）只有配置了 postprocess 的学科才走，
    // 其余学科保持原来的严格解析，行为与重构前一致。
    parse: text => parseGenerated(data, text, subject.postprocess)
  });
  return generated;
}
// 口令可从请求头 x-anki-token 或 ?token= 查询参数传入（方便手机扫码直接打开）。
function requestToken(req, url) {
  return String(req.headers['x-anki-token'] || url.searchParams.get('token') || '');
}
function authorized(subject, req, url) {
  const token = subject.config.token;
  if (!token) return false;
  const given = requestToken(req, url);
  if (given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}
function withServerDefaults(subject, data) {
  if (!data.url) data.url = subject.config.apiUrl || 'https://api.openai.com/v1';
  if (!data.key) data.key = subject.config.apiKey;
  if (!data.model) data.model = subject.config.model;
  return data;
}
// 本机可用的内网地址。要排除三类：
//   1) 回环（127.x）与链路本地（169.254.x）—— 手机连不上，AnkiConnect 也只认回环；
//   2) VPN / 代理软件的 fake-IP 段 198.18.0.0/15（迷雾通、Clash 之类会给虚拟网卡发这种地址）；
//   3) 虚拟网卡（VMware / VirtualBox / WSL / docker …）上的地址。
// 注意：Tailscale / ZeroTier **不在排除之列** —— 它们是特意用来远程访问的，手机换个网络也**真能连上**，
//       所以单独归为 remote 一组（局域网地址排在前面，扫码优先走最快的那个）。
const VIRTUAL_IFACE = /(vmnet|vEthernet|VirtualBox|VMware|Hyper-V|Loopback|docker|WSL|TAP-|utun|Clash|Mihomo|Geph)/i;
const REMOTE_IFACE = /(Tailscale|ZeroTier)/i;
function isFakeIp(address) {
  const [first, second] = String(address).split('.').map(Number);
  return first === 198 && (second === 18 || second === 19); // 198.18.0.0/15
}
/** 纯函数：把 os.networkInterfaces() 的结果分成「家里的局域网」和「远程（tailnet）」两组，方便单测。 */
function pickAddresses(nets) {
  const lan = [], remote = [];
  Object.keys(nets || {}).forEach(name => {
    const isRemote = REMOTE_IFACE.test(name);
    if (!isRemote && VIRTUAL_IFACE.test(name)) return;
    (nets[name] || []).forEach(net => {
      if (!net || net.family !== 'IPv4' || net.internal) return;
      if (String(net.address).startsWith('169.254.')) return;
      if (isFakeIp(net.address)) return;
      (isRemote ? remote : lan).push(net.address);
    });
  });
  return { lan: [...new Set(lan)], remote: [...new Set(remote)] };
}
function lanAddresses() {
  const { lan, remote } = pickAddresses(os.networkInterfaces());
  return [...lan, ...remote];
}

// 与 AI 服务商对话（/api/research 的两步定位都要用）。
async function aiChat(data, content, temperature = 0.2) {
  const response = await fetch(data.url.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${data.key}` },
    body: JSON.stringify({ model: data.model, messages: [{ role: 'user', content }], temperature }),
    signal: AbortSignal.timeout(120000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || 'AI 请求失败。');
  const text = result?.choices?.[0]?.message?.content;
  if (!text) throw new Error('AI 未返回内容。');
  return text;
}
/* ===== 检索与调研用到的纯逻辑（偏好站点、结果清洗、Tavily 请求）在 src/shared/search.js：
   安卓壳的离线页用同一份实现，只是把请求换成了原生桥。这里给它一个基于 fetch 的 transport。 ===== */
async function httpTransport(request) {
  const response = await fetch(request.url, {
    method: request.method || 'GET',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(request.timeout || 60000)
  });
  return { status: response.status, body: await response.text() };
}
/** 测试可以用 ANKI_TAVILY_URL 把检索指向本地假服务（生产环境不设这个变量）。 */
const withTavilyUrl = options => (process.env.ANKI_TAVILY_URL ? { ...options, url: process.env.ANKI_TAVILY_URL } : options);

// ===== 知乎开放平台：官方搜索走 MCP over SSE（REST 那条路认证不通，MCP 可以）=====
// 超时上限：SSE 连接 30s、单次 RPC（tools/call）60s。超时后 zhihuSearch 的 finally 会关掉连接，不泄漏。
// 两个环境变量只给测试用，默认值与上面写的一致。
const ZHIHU_CONNECT_TIMEOUT = Number(process.env.ANKI_ZHIHU_CONNECT_TIMEOUT || 30000);
const ZHIHU_RPC_TIMEOUT = Number(process.env.ANKI_ZHIHU_RPC_TIMEOUT || 60000);

class ZhihuMcp {
  constructor(key, channel) { this.key = key; this.channel = channel; this.pending = new Map(); this.nextId = 100; }
  async connect() {
    const res = await fetch(`${ZHIHU_BASE}/api/mcp/${this.channel}/v1/sse`, {
      headers: { authorization: `Bearer ${this.key}`, accept: 'text/event-stream' },
      signal: AbortSignal.timeout(ZHIHU_CONNECT_TIMEOUT)
    });
    if (!res.ok) throw new Error(`知乎 MCP 连接失败（HTTP ${res.status}）`);
    this.reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
            const line = chunk.split('\n').find(item => item.startsWith('data:'));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (payload.startsWith('/')) { this.endpoint = payload; continue; }
            try {
              const message = JSON.parse(payload);
              if (message.method) {
                // 服务端主动发来的请求（如 ping），回空结果即可，绝不能当成我们的响应——
                // 它的 id 可能与我们的请求 id 撞车
                if (message.id != null) this.post({ jsonrpc: '2.0', id: message.id, result: {} }).catch(() => {});
                continue;
              }
              if (message.id != null && this.pending.has(message.id)) { const done2 = this.pending.get(message.id); this.pending.delete(message.id); done2(message); }
            } catch (_) {}
          }
        }
      } catch (_) {}
    })();
    const deadline = Date.now() + 15000;
    while (!this.endpoint && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (!this.endpoint) throw new Error('知乎 MCP 未返回会话地址');
  }
  async post(payload) {
    const res = await fetch(ZHIHU_BASE + this.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ZHIHU_CONNECT_TIMEOUT)
    });
    if (res.status >= 400) throw new Error(`知乎 MCP 请求失败（HTTP ${res.status}）`);
  }
  rpc(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`知乎 MCP ${method} 超时`)); }, timeoutMs);
      this.pending.set(id, message => { clearTimeout(timer); resolve(message); });
      this.post({ jsonrpc: '2.0', id, method, params }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  async close() {
    // 超时或出错时也要把 SSE 连接放掉：先 cancel 读取器，再尽力 abort 底层请求
    try { if (this.reader) await this.reader.cancel(); } catch (_) {}
    this.reader = null;
  }
}
// 一次知乎检索的完整生命周期：连接 → initialize → tools/call。
// 无论成功、失败还是超时，finally 都会 cancel 掉 SSE 读取器，连接不会泄漏。
async function zhihuSearch(key, query, count, channel) {
  const client = new ZhihuMcp(key, channel);
  try {
    await client.connect();
    await client.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'anki-card-app', version: '1.0' } }, Math.min(20000, ZHIHU_RPC_TIMEOUT));
    await client.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const call = await client.rpc('tools/call', { name: channel, arguments: { query, count } }, ZHIHU_RPC_TIMEOUT);
    if (call?.error) throw new Error(`知乎搜索失败：${call.error.message || JSON.stringify(call.error).slice(0, 160)}`);
    const text = (call?.result?.content || []).map(item => item.text || '').join('');
    if (call?.result?.isError) throw new Error(`知乎搜索报错：${text.slice(0, 160)}`);
    const results = [...text.matchAll(/<search_item([^>]*)>([\s\S]*?)<\/search_item>/g)].map(match => {
      const attrs = {};
      for (const a of match[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
      return {
        title: String(attrs.title || '').trim(),
        url: String(attrs.url || '').split('?')[0],
        content: match[2].replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
      };
    });
    if (!results.length) throw new Error(`知乎 ${channel} 未返回结果（原始响应：${JSON.stringify(call).slice(0, 240)}）`);
    return results;
  } finally { await client.close(); }
}
// 统一检索入口：
//   - 配了知乎 Key 且走知乎通道时优先知乎官方通道；知乎失败（超时/协议错误/额度用尽/结构异常）
//     不能让整个调研挂掉 —— 自动回退 Tavily，并在 provider 里标出来。
//   - 两个通道各自独立：zhihu 失败不影响 global，反之亦然（每次调用各自回退）。
async function webSearch(subject, tavilyKey, query, maxResults, options = {}) {
  const channel = options.channel;
  const useZhihu = subject.config.zhihuKey && (channel === 'zhihu' || channel === 'global');
  if (useZhihu) {
    const label = channel === 'global' ? '知乎全网搜索' : '知乎站内搜索';
    try {
      const raw = await zhihuSearch(subject.config.zhihuKey, query, maxResults, channel === 'global' ? 'global_search' : 'zhihu_search');
      const cleaned = cleanSearchResults(raw, subject.search.preferredDomains);
      let results = options.domains && options.domains.length ? rankByDomains(cleaned.results, options.domains) : cleaned.results;
      if (options.keep) results = results.slice(0, options.keep);
      return { query, answer: '', results, dropped: cleaned.dropped, provider: label };
    } catch (error) {
      const reason = (error && error.message) || String(error);
      if (!tavilyKey) throw new Error(`${label}失败，而且没有配置 Tavily 兜底通道：${reason}`);
      console.log(`${label}失败，回退 Tavily：${reason}`);
      const found = await tavilySearch(httpTransport, tavilyKey, query, maxResults, withTavilyUrl(options));
      return { ...found, provider: `${label}（失败已回退 Tavily）`, degradedFrom: label, degradedReason: reason };
    }
  }
  const found = await tavilySearch(httpTransport, tavilyKey, query, maxResults, withTavilyUrl(options));
  return { ...found, provider: 'Tavily 全网' };
}


// 笔记类型的字段名由 Anki 决定，不同版本/不同模板并不一样：
//   Basic → Front / Back；Cloze → 新版是 Text / Back Extra，旧版是 Text / Extra。
// 写死字段名会让第二个字段被 AnkiConnect 静默丢掉（曾经因此丢掉填空卡的备注），所以按位置取真实字段名。
const MODEL_FIELDS = new Map();
async function modelFieldNames(modelName, fallback) {
  if (!MODEL_FIELDS.has(modelName)) {
    const names = await anki('modelFieldNames', { modelName }).catch(() => null);
    MODEL_FIELDS.set(modelName, Array.isArray(names) && names.length ? names : fallback);
  }
  return MODEL_FIELDS.get(modelName);
}
/** 按「第 1 个字段 / 第 2 个字段」构造 fields，字段名用 Anki 里真实的那个。 */
async function buildNoteFields(modelName, first, second, fallback) {
  const names = await modelFieldNames(modelName, fallback);
  return { [names[0] || fallback[0]]: first, [names[1] || fallback[1]]: second };
}

/** 文件名里的时间戳：2026-09-21-1432（本地时间） */
function logHistory(entry) {
  const parts = [new Date(entry.t).toISOString(), `[${entry.subject}]`, entry.kind];
  if (entry.kind === 'generate') parts.push(`${entry.total} 张（普通 ${entry.basic} / 填空 ${entry.cloze}）`, `模型 ${entry.model}`, `调研 ${entry.referenceChars} 字`, `${entry.ms}ms`);
  else if (entry.kind === 'import') parts.push(`牌组 ${entry.deck}`, `新增 ${entry.added} 跳过 ${entry.skipped}（共 ${entry.requested}）`, `${entry.ms}ms`);
  else if (entry.kind === 'export') parts.push(`${entry.type} ${entry.count} 张`);
  if (entry.error) parts.push(`失败：${entry.error}`);
  console.log(parts.join(' | '));
}
function record(subject, entry) {
  const full = { t: Date.now(), subject: subject.id, ...entry };
  history.append(full);
  logHistory(full);
  return full;
}
function stampNow(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/* ===== 路由：多学科模式下 /<学科>/ 挂载，单学科模式下就是根路径 ===== */
function resolveRequest(pathname) {
  if (!MULTI) return { subject: SELECTED, rest: pathname, redirect: null };
  for (const subject of ALL_SUBJECTS) {
    const mount = `/${subject.id}`;
    if (pathname === mount) return { subject, rest: '/', redirect: `${mount}/` };
    if (pathname === `${mount}/`) return { subject, rest: '/', redirect: null };
    if (pathname.startsWith(`${mount}/`)) return { subject, rest: pathname.slice(mount.length), redirect: null };
  }
  return null;
}

// 根路径的学科选择页（只有多学科模式会遇到）
function subjectPickerPage() {
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const items = ALL_SUBJECTS
    .map(subject => `<li data-id="${subject.id}" data-name="${escapeHtml(subject.name)}"><a class="packLink" href="${mountOf(subject)}"><span class="packIcon" aria-hidden="true">${subject.pack ? '学' : subject.id === 'bio' ? '生' : '化'}</span><span class="packText"><b>${escapeHtml(subject.name)}</b><span>${escapeHtml(subject.exam || '高考')} · ${escapeHtml(subject.subject || subject.name.replace(/^高中/,''))}</span></span><span class="packArrow" aria-hidden="true">›</span></a>${subject.pack ? `<div class="packTools"><button data-edit="${subject.id}">编辑</button><button data-export="${subject.id}">导出</button><button data-delete="${subject.id}">删除</button></div>` : ''}</li>`)
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CardFlow · 卡流</title><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#2269d1"><link rel="apple-touch-icon" href="/icon-cardflow-192.png"><link rel="icon" href="/icon-cardflow-192.png">
<link rel="stylesheet" href="/picker.css?v=1">

</head><body><main class="page"><header class="hero"><img class="heroMark" src="/icon-cardflow-192.png" alt="" width="72" height="72"><button id="globalSettings" type="button" class="settingsTrigger" aria-label="全局设置" title="全局设置"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 4.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2Zm0 3.6a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/><rect x="10.75" y="1.2" width="2.5" height="4.6" rx="1.2"/><rect x="10.75" y="18.2" width="2.5" height="4.6" rx="1.2"/><rect x="1.2" y="10.75" width="4.6" height="2.5" rx="1.2"/><rect x="18.2" y="10.75" width="4.6" height="2.5" rx="1.2"/><g transform="rotate(45 12 12)"><rect x="10.75" y="1.2" width="2.5" height="4.6" rx="1.2"/><rect x="10.75" y="18.2" width="2.5" height="4.6" rx="1.2"/><rect x="1.2" y="10.75" width="4.6" height="2.5" rx="1.2"/><rect x="18.2" y="10.75" width="4.6" height="2.5" rx="1.2"/></g></svg></button><div class="heroCopy"><p class="eyebrow">CARD MAKING FOR EXAMS</p><h1>CardFlow<small>卡流</small></h1><p class="tagline">拍照 → 卡片 → Anki</p></div></header><section aria-labelledby="packsHeading"><div class="sectionHead"><h2 id="packsHeading">选择学科包</h2><p>选一个科目，开始制卡</p></div><ul class="packList" id="packList">${items}</ul></section><details class="manager" id="packManager"><summary><span class="managerIcon" aria-hidden="true">＋</span><span><span class="managerTitle">导入学科包</span><span class="managerHint">从 AI 生成的 JSON 导入新考试科目</span></span><span class="managerChevron" aria-hidden="true">›</span></summary><div class="managerInner"><p class="helper">复制提示词交给 AI 生成学科包，将得到的 JSON 粘贴或选择文件。校验预览通过后再保存。</p><label class="fieldLabel" for="packToken">生物入口访问口令</label><input id="packToken" type="password" autocomplete="current-password" placeholder="已保存口令时可留空"><label class="fieldLabel" for="packText">学科包 JSON</label><textarea id="packText" rows="7" placeholder="在此粘贴生成的 JSON"></textarea><div class="fileRow"><label class="fieldLabel" for="packFile">或者选择文件</label><input id="packFile" type="file" accept=".json,application/json"></div><div class="actions"><button id="packGuide" type="button">复制 AI 生成提示词</button><button id="packPreview" type="button">校验预览</button><button id="packImport" class="primary" type="button" disabled>确认导入</button></div><pre id="packStatus" role="status" aria-live="polite"></pre></div></details><p class="footer">内置生物、化学的口令各自独立；新学科包沿用生物入口的口令。口令不会写入导出的文件。</p><script src="/core.js"></script><script src="/cardflow.js"></script><script src="/settings.js"></script></main></body></html>`;
}

/**
 * 生成请求处理器。
 * options.subject 有值时进入「单学科直供」模式（旧端口用）：路径挂在根上，页面/清单都按这个学科渲染，
 * 这样该学科在浏览器眼里就是另一个 origin，图标与缓存不会和多学科端口混在一起。
 */
function makeHandler(options = {}) {
  const soloSubject = options.subject || null;
  return async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  try {
    if (MULTI && !soloSubject && /^\/[a-z][a-z0-9-]{1,31}\/manifest\.json$/.test(pathname)) return send(res, 200, 'application/manifest+json', JSON.stringify({name:'CardFlow 卡流',short_name:'CardFlow',description:'拍照 → 卡片 → Anki',start_url:'/',scope:'/',display:'standalone',background_color:'#eef5fa',theme_color:'#2269d1',icons:[{src:'/icon-cardflow-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'/icon-cardflow-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]}));
    if (MULTI && !soloSubject && pathname === '/manifest.json') return send(res, 200, 'application/manifest+json', JSON.stringify({name:'CardFlow 卡流',short_name:'CardFlow',description:'拍照 → 卡片 → Anki',start_url:'/',scope:'/',display:'standalone',background_color:'#eef5fa',theme_color:'#2269d1',icons:[{src:'/icon-cardflow-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'/icon-cardflow-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]}));
    if (MULTI && !soloSubject && pathname === '/sw.js') return send(res, 200, 'application/javascript', fs.readFileSync(path.join(PUBLIC,'sw.js')));
    if (MULTI && !soloSubject && pathname === '/cardflow.js') return send(res, 200, 'application/javascript', fs.readFileSync(path.join(PUBLIC,'cardflow.js')));
    if (MULTI && !soloSubject && ['/settings.js','/core.js'].includes(pathname)) return send(res,200,'application/javascript',fs.readFileSync(path.join(PUBLIC,pathname.slice(1))));
    if (MULTI && !soloSubject && pathname === '/picker.css') return send(res, 200, 'text/css', fs.readFileSync(path.join(PUBLIC,'picker.css')));
    if (MULTI && !soloSubject && /^\/icon-cardflow-(?:192|512)\.png$/.test(pathname)) return send(res,200,'image/png',fs.readFileSync(path.join(PUBLIC,pathname.slice(1))));
    if (MULTI && !soloSubject && pathname === '/apple-touch-icon.png') return send(res,200,'image/png',fs.readFileSync(path.join(PUBLIC,'icon-cardflow-192.png')));
    if (MULTI && !soloSubject && pathname === '/') return send(res, 200, 'text/html', subjectPickerPage());
    // Pack management is restricted to the primary (bio) access token; never accept cookie/query credentials here.
    if (MULTI && !soloSubject && pathname.startsWith('/api/packs')) {
      const primary = ALL_SUBJECTS[0];
      if (!primary.config.token || !req.headers['x-anki-token'] || !authorized(primary, req, new URL(req.url, 'http://localhost'))) return json(res, 401, { error: '请先输入生物入口的访问口令以管理学科包。' });
      if (pathname === '/api/packs' && req.method === 'GET') return json(res, 200, { packs: ALL_SUBJECTS.map(s => ({id:s.id,name:s.name,exam:s.exam||'高考',subject:s.subject||s.name.replace(/^高中/,'') ,builtin:BUILTIN_IDS.has(s.id)})) });
      if (pathname === '/api/packs/validate' && req.method === 'POST') {
        try { const data=await readPackJson(req); packs.validate(data); if (ALL_SUBJECTS.some(s=>s.id===data.id && (!s.pack || url.searchParams.get('edit') !== data.id))) throw Error('学科包 ID 已存在，请换一个 id。');
          if (url.searchParams.get('edit') && !ALL_SUBJECTS.some(s=>s.id===data.id && s.pack)) throw Error('编辑时不能更改学科包 ID。'); return json(res,200,{ok:true,name:data.name,exam:data.exam,subject:data.subject}); }
        catch (error) { return json(res,400,{error:error.message}); }
      }
      if (pathname === '/api/packs/import' && req.method === 'POST') {
        let data;
        try { data = await readPackJson(req); packs.validate(data); packs.save(data, new Set(ALL_SUBJECTS.map(s => s.id))); }
        catch (error) { return json(res, 400, {error:error.message}); }
        ALL_SUBJECTS.push(packs.materialize(data, primary));
        return json(res, 200, { id:data.id,href:'/'+data.id+'/' });
      }
      if (pathname === '/api/packs/update' && req.method === 'POST') {
        try {
          const data = await readPackJson(req);
          packs.validate(data);
          const index = ALL_SUBJECTS.findIndex(s => s.id === data.id && s.pack);
          if (index < 0) throw Error('只有已导入的学科包可以编辑，且 ID 不可修改。');
          packs.update(data);
          ALL_SUBJECTS[index] = packs.materialize(data,primary);
          return json(res,200,{ok:true,id:data.id});
        } catch (error) { return json(res,400,{error:error.message}); }
      }
      if (pathname === '/api/packs/export' && req.method === 'GET') {
        const id = new URL(req.url,'http://localhost').searchParams.get('id');
        const found = ALL_SUBJECTS.find(s => s.id === id && s.pack);
        if (!found) return json(res, 404, {error:'只有导入的学科包可以导出。'});
        return json(res, 200, found.pack);
      }
      if (pathname === '/api/packs/delete' && req.method === 'POST') {
        let id;
        try { ({id} = await readPackJson(req)); } catch (error) { return json(res,400,{error:error.message}); }
        if (BUILTIN_IDS.has(id)) return json(res, 400, {error:'内置学科包不能删除。'});
        const index = ALL_SUBJECTS.findIndex(s => s.id === id && s.pack);
        if (index < 0) return json(res, 404, {error:'学科包不存在。'});
        try { packs.remove(id); } catch (error) { return json(res,400,{error:error.message}); }
        ALL_SUBJECTS.splice(index,1);
        return json(res, 200, {ok:true});
      }
      return json(res, 404, {error:'接口不存在。'});
    }


    const target = soloSubject ? { subject: soloSubject, rest: pathname, redirect: null } : resolveRequest(pathname);
    if (!target) return json(res, 404, { error: '接口不存在。' });
    if (target.redirect) { res.writeHead(302, { Location: target.redirect }); return res.end(); }
    const subject = target.subject;
    const route = target.rest;

    const solo = Boolean(soloSubject);
    const requestBase = { ssl: Boolean(req.socket && req.socket.encrypted), hostname: String(req.headers.host || '').split(':')[0] || '127.0.0.1', port: Number(req.socket && req.socket.localPort) || PORT };
    if (route === '/' || route === '/index.html') {
      let page = readPage(subject, 'index.html', solo, requestBase);
      if (subject.pack) page = page.replace(/让 AI 知道这部分内容在高中考试里的/g, `让 AI 知道这部分内容在${subject.exam}考试里的`)
        .replace(/建议检索词带上「高考 \/ 考点 \/ 难点 \/ 易错点」/g, `建议检索词带上「${subject.exam} / 考点 / 难点 / 易错点」`);
      return send(res, 200, 'text/html', page);
    }
    const asset = staticFile(subject, route, solo, requestBase);
    if (asset) return send(res, 200, asset.type, asset.body);
    // public/vendor/ 下的第三方静态 js（不进 package.json）。用 basename 取文件名，避免目录穿越。
    if (route.startsWith('/vendor/')) {
      const file = path.join(PUBLIC, 'vendor', path.basename(route));
      if (fs.existsSync(file)) return send(res, 200, 'application/javascript', fs.readFileSync(file));
      return json(res, 404, { error: '静态文件不存在。' });
    }
    if (route === '/ca.crt') {
      try { return send(res, 200, 'application/x-x509-ca-cert', fs.readFileSync(path.join(ROOT, 'ca.crt'))); }
      catch (_) { return json(res, 404, { error: 'CA 证书不存在。' }); }
    }
    // /api/config 与 /api/health 免口令：不带 token 一律放行（页面初次加载、体检用）。
    // 但如果带了 token 却不对，仍然返回 401——前端「输入口令」界面正是靠这一步判断口令对错，
    // 若这两个接口对任何 token 都放行，错误口令会被误判成成功。
    const publicApi = route === '/api/config' || route === '/api/health';
    if (route.startsWith('/api/')) {
      if (!publicApi && !authorized(subject, req, url)) return json(res, 401, { error: '未授权：请输入正确的访问口令。' });
      if (publicApi && subject.config.token && requestToken(req, url) && !authorized(subject, req, url)) return json(res, 401, { error: '未授权：请输入正确的访问口令。' });
    }
    const CONFIG = subject.config;
    if (route === '/api/config') return json(res, 200, { apiUrl: CONFIG.apiUrl, model: CONFIG.model, hasKey: Boolean(CONFIG.apiKey), hasSearch: Boolean(CONFIG.tavilyKey || CONFIG.zhihuKey), hasZhihu: Boolean(CONFIG.zhihuKey), tts: TTS_AVAILABLE });
    // 体检：除了版本号，再摸一下集合能不能用 —— 「两个 Anki 抢 8765」这种情况下版本号是通的，
    // 只有碰集合才会报错，不查的话首页会显示「已连接」，用户要等导入才发现不对。
    if (route === '/api/health') {
      const version = await anki('version');
      try {
        await anki('deckNames');
        return json(res, 200, { ok: true, version, collection: true });
      } catch (error) {
        return json(res, 200, { ok: true, version, collection: false, collectionError: error.message || String(error) });
      }
    }
    if (route === '/api/history') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
      // 列表只给摘要：卡片正文（cards）只在「载入这批卡片」时单条取，免得多拉几百 KB
      const records = history.read(limit).map(record => {
        const cards = Array.isArray(record.cards) ? record.cards : null;
        return {
          ...record,
          cards: undefined,
          titles: cards ? cardTitles(cards) : (Array.isArray(record.titles) ? record.titles : []),
          restorable: Boolean(cards && cards.length)
        };
      });
      return json(res, 200, { records, file: history.filePath() });
    }
    if (route === '/api/history/item') {
      const stamp = Number(url.searchParams.get('t'));
      const record = history.read(500).find(item => Number(item.t) === stamp);
      if (!record) return json(res, 404, { error: '找不到这条历史记录（可能已被新的记录挤出去了）。' });
      return json(res, 200, { record: { ...record, restorable: Array.isArray(record.cards) && record.cards.length > 0 } });
    }
    if (route === '/api/decks') return json(res, 200, { decks: await anki('deckNames') });
    if (route === '/api/deck/create' && req.method === 'POST') {
      const data = JSON.parse(await body(req));
      const name = String(data.deck || '').trim();
      if (!name) throw new Error('牌组名不能为空。');
      if (name.length > 200) throw new Error('牌组名过长（上限 200 字符）。');
      if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('牌组名包含非法控制字符。');
      if (name.split('::').some(part => !part.trim())) throw new Error(`牌组层级不能为空，例如「${subject.copy.deckLevelExample}」。`);
      return json(res, 200, { deck: name, id: await anki('createDeck', { deck: name }) });
    }
    if (route === '/api/deck/delete' && req.method === 'POST') {
      const data = JSON.parse(await body(req));
      const name = String(data.deck || '').trim();
      if (!name) throw new Error('牌组名不能为空。');
      const decks = await anki('deckNames');
      if (!decks.includes(name)) throw new Error(`牌组不存在：${name}`);
      if (name === 'Default' || name === '默认') throw new Error('Anki 默认牌组不能删除。');
      const targets = decks.filter(deck => deck === name || deck.startsWith(name + '::'));
      const raw = await anki('getDeckStats', { decks: targets });
      const list = Array.isArray(raw) ? raw : Object.values(raw || {});
      const cardCount = list.reduce((sum, item) => sum + Number(item && item.total_in_deck || 0), 0);
      if (data.dryRun) return json(res, 200, { deck: name, decks: targets, subdecks: targets.filter(deck => deck !== name), cardCount });
      // Anki 2.1.28+ 已不支持“只删牌组保留卡片”，cardsToo 必须为 true。
      await anki('deleteDecks', { decks: targets, cardsToo: true });
      return json(res, 200, { deck: name, deleted: targets, cardsToo: true, cardCount });
    }
    if (route === '/api/models' && req.method === 'POST') {
      const data = withServerDefaults(subject, JSON.parse(await body(req)));
      const response = await fetch(data.url.replace(/\/$/, '') + '/models', { headers: { authorization: `Bearer ${data.key}` } });
      const result = await response.json(); if (!response.ok) throw new Error(result?.error?.message || '无法获取模型列表。');
      return json(res, 200, { models: (result.data || []).map(x => x.id).sort() });
    }
    // 配了 postprocess 的学科才有的公式标准化接口；没配的学科保持 404
    if (route === '/api/normalize' && req.method === 'POST') {
      if (!subject.postprocess) return json(res, 404, { error: '接口不存在。' });
      return json(res, 200, subject.postprocess.normalizePayload(JSON.parse(await body(req))));
    }
    if (route === '/api/research' && req.method === 'POST') {
      const data = withServerDefaults(subject, JSON.parse(await body(req)));
      if (!data.url || !data.key || !data.model || !Array.isArray(data.images) || (!data.images.length && !String(data.sourceText || '').trim())) throw new Error('缺少 API、模型或图片。');
      if (data.sourceText && (typeof data.sourceText !== 'string' || data.sourceText.length>100000)) throw Error('资料文字不得超过 10 万字。');
      const searchProvider = resolveSearchProvider(data.searchProvider).id;
      const searchNeedsKey = resolveSearchProvider(searchProvider).provider.needsKey !== false;
      const searchKey = String(data.searchKey || searchKeyOf(CONFIG, searchProvider) || (searchProvider === 'tavily' ? CONFIG.tavilyKey : '') || '').trim();
      if (!CONFIG.zhihuKey && searchNeedsKey && !searchKey) throw new Error(`未配置联网检索 Key：请在 config.json 中填写 ${searchProvider}Key。`);

      // 第 1 步（保守策略）：只认知识主题，不猜教材版本与章节位置，避免编造
      const identify = extractFirstJson(await aiChat(data, [
        { type: 'text', text: renderTemplate(subject.prompts.identify, {}) },
        ...(data.sourceText ? [{type:'text',text:'用户提供的教材原文：\n'+data.sourceText}] : []),
        ...data.images.map(image => ({ type: 'image_url', image_url: { url: image } }))
      ], 0.1));
      const topicSeed = String(identify.topic || '').trim() || String((Array.isArray(identify.keypoints) && identify.keypoints[0]) || '').trim();
      if (!topicSeed) throw new Error('未能从图片判断出知识主题，请改用手动检索。');

      // 第 2 步：按“学科 + 主题 + 章节内容”检索该章节的教材内容
      const catalogQuery = `${subject.search.subjectPrefix} ${topicSeed} ${subject.search.catalogSuffix}`;
      const catalog = await webSearch(subject, searchKey, catalogQuery, 8, { channel: 'global' });

      // 第 3 步：用目录证据锁定精确位置，再生成考情检索词
      const evidence = catalog.results.slice(0, 5).map(item => `【${item.title}】${String(item.content || '').slice(0, 900)}`).join('\n');
      const locked = extractFirstJson(await aiChat(data, [
        { type: 'text', text: renderTemplate(subject.prompts.locate, {
          topic: topicSeed,
          keypoints: JSON.stringify(identify.keypoints || []),
          evidence: evidence || '（无）'
        }) }
      ], 0.1));

      // 第 4 步：锁定之后再搜考情（最多 2 条）
      const queries = (Array.isArray(locked.examQueries) ? locked.examQueries : []).map(item => String(item || '').trim()).filter(Boolean).slice(0, 2);
      if (!queries.length) throw new Error('未能生成考情检索词，请重试或改用手动检索。');
      // 考情检索：知乎站内（考点总结）+ 全网（一轮复习讲义，带真题出处/高频标注）两个通道合并
      const exams = [];
      const seenAcross = new Set();   // 跨检索词去重：两个检索词重复命中的内容不再重复出现
      for (const query of queries) {
        const [fromZhihu, fromGlobal] = await Promise.all([
          webSearch(subject, searchKey, query, 6, { channel: 'zhihu' }).catch(() => null),
          webSearch(subject, searchKey, query, 6, { channel: 'global' }).catch(() => null)
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
      return json(res, 200, {
        identify: { topic: identify.topic || topicSeed, keypoints: Array.isArray(identify.keypoints) ? identify.keypoints : [] },
        position: locked.position || '', topic: locked.topic || topicSeed,
        catalogQuery, catalog: catalog.results, examQueries: queries, exams
      });
    }
    // 二维码用：本机可用的内网地址与端口（**绝不返回口令**，前端自己把 token 拼上去）
    if (route === '/api/network') {
      const picked = pickAddresses(os.networkInterfaces());
      return json(res, 200, {
        addresses: [...picked.lan, ...picked.remote],
        // 远程（Tailscale/ZeroTier）单独给一份：手机出门时用这个地址
        remote: picked.remote,
        httpPort: PORT,
        httpsPort: HTTPS_OPTIONS ? HTTPS_PORT : 0,
        mount: mountOf(subject, Boolean(soloSubject))
      });
    }
    // 导出为 Anki 可导入的 txt：按类型分批，浏览器直接下载
    if (route === '/api/export' && req.method === 'POST') {
      const data = JSON.parse(await body(req));
      const type = String(data.type || '').trim();
      const label = EXPORT_TYPE_LABELS[type];
      if (!label) throw new Error('导出类型只能是 basic（普通卡）、cloze（填空卡）、occlusion（图像遮挡卡）或 audio（音频卡）。');
      const picked = (Array.isArray(data.cards) ? data.cards : []).filter(card => card && card.type === type);
      if (!picked.length) throw new Error(`没有${label}可以导出。`);
      const filename = `${subject.id}-${stampNow()}-${type}.txt`;
      record(subject, { kind: 'export', type, count: picked.length });
      res.writeHead(200, {
        'Content-Type': 'text/tab-separated-values; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store'
      });
      return res.end(exportText(picked, subject.anki.defaultTags || []));
    }
    if (route === '/api/fetch' && req.method === 'POST') {
      const data = JSON.parse(await body(req));
      const target2 = String(data.url || '').trim();
      if (!/^https?:\/\//i.test(target2)) throw new Error('无效的链接。');
      // Jina 中转可自定义（手机网络到不了 r.jina.ai 时，与 searchUrl 同一个思路）
      const jina = String(data.jinaBase || JINA_BASE).trim().replace(/\/+$/, '') + '/';
      let response;
      try {
        response = await fetch(jina + target2, { signal: AbortSignal.timeout(90000) });
      } catch (error) { throw new Error(`抓取原文失败：${error.message}`); }
      if (!response.ok) throw new Error(`抓取原文失败（HTTP ${response.status}），该站可能限制抓取或需要登录。`);
      const markdown = await response.text();
      const text = cleanFetchedText(markdown);
      const limit = fetchLimit(data.limit);
      const frameNoise = frameNoiseCount(text);
      return json(res, 200, { url: target2, length: text.length, content: text.slice(0, limit), suspicious: frameNoise >= 3 });
    }
    if (route === '/api/search' && req.method === 'POST') {
      const data = JSON.parse(await body(req));
      const query = String(data.query || '').trim();
      if (!query) throw new Error('请输入检索关键词。');
      // 服务商可选（Tavily / 博查 / Serper / Bing / Brave / Exa / 自建 SearXNG）；Key 用哪家就配哪家的
      const providerId = resolveSearchProvider(data.provider).id;
      const providerNeedsKey = resolveSearchProvider(providerId).provider.needsKey !== false;
      const key = String(data.key || searchKeyOf(CONFIG, providerId) || (providerId === 'tavily' ? CONFIG.tavilyKey : '') || '').trim();
      if (providerNeedsKey && !key && !CONFIG.zhihuKey) throw new Error(`未配置联网检索 Key：请在 config.json 中填写 ${providerId}Key。`);
      const maxResults = Math.min(Math.max(Number(data.maxResults) || 5, 1), 10);
      const found = await webSearch(subject, key, query, maxResults, { domains: subject.search.preferredDomains, channel: data.channel || 'zhihu', provider: providerId, url: String(data.searchUrl || '').trim() || undefined });
      return json(res, 200, { query: found.query, answer: found.answer, results: found.results, dropped: found.dropped, provider: found.provider });
    }
    if (route === '/api/history/card' && req.method === 'POST') {
      const data = JSON.parse(await body(req));
      const stamp = Number(data.t);
      const index = Number(data.index);
      const issue = cardIssue(data.card);
      if (issue) throw new Error(`不接受的卡片格式：${issue}`);
      if (!Number.isInteger(index) || index < 0) throw new Error('卡片序号不对。');
      let updated = null;
      const found = history.update(stamp, record => {
        const cards = Array.isArray(record.cards) ? record.cards : [];
        if (index >= cards.length) return;
        cards[index] = data.card;
        record.cards = cards;
        Object.assign(record, countCardTypes(cards));
        record.revised = (Number(record.revised) || 0) + 1;
        record.revisedAt = Date.now();
        updated = record;
      });
      if (!found || !updated) throw new Error('找不到这条历史记录（可能已被新的记录挤出去了）。');
      console.log(`[${subject.id}] history/card 第 ${index + 1} 张已改写（t=${stamp}）`);
      return json(res, 200, { ok: true, titles: cardTitles(updated.cards) });
    }
    if (route === '/api/sync' && req.method === 'POST') {
      // 让电脑上的 Anki 与 AnkiWeb 同步：手机上一点就能把新卡推上去（不用碰电脑）。
      // 注意：全量同步/未登录会直接报错，由 ankiErrorText() 翻成中文提示。
      const started = Date.now();
      await anki('sync');
      const ms = Date.now() - started;
      console.log(`[${subject.id}] sync 完成 ${ms}ms`);
      return json(res, 200, { ok: true, ms });
    }
    if (route === '/api/card/retry' && req.method === 'POST') {
      return json(res, 200, await retryCard(subject, withServerDefaults(subject, JSON.parse(await body(req)))));
    }
    if (route === '/api/generate' && req.method === 'POST') {
      const payload = withServerDefaults(subject, JSON.parse(await body(req)));
      const started = Date.now();
      try {
        const result = await generate(subject, payload);
        const entry = record(subject, {
          kind: 'generate', ms: Date.now() - started, model: payload.model,
          referenceChars: String(payload.reference || '').trim().length,
          deck: String(payload.deck || ''),
          ...countCardTypes(result && result.cards),
          // 整批卡片都存下来：历史页里能「载入这批卡片」回到主界面继续检查/修改/导入
          cards: (result && Array.isArray(result.cards)) ? result.cards : []
        });
        // historyT 只给前端记「这批卡片属于哪条历史」，前端会删掉它再写进卡片 JSON
        return json(res, 200, { ...result, historyT: entry.t });
      } catch (error) {
        record(subject, { kind: 'generate', ms: Date.now() - started, model: payload.model, error: error.message || String(error) });
        throw error;
      }
    }
    if (route === '/api/import' && req.method === 'POST') {
      const payload = JSON.parse(await body(req));
      const started = Date.now();
      try {
        // 先按勾选的卡片类型过滤，再做格式校验：没勾的类型里就算有坏卡，也不该拦住这一批
        const incoming = subject.postprocess ? subject.postprocess.normalizePayload(payload) : payload;
        const enabledTypes = new Set(Array.isArray(payload.enabledTypes) ? payload.enabledTypes : ['basic','cloze','occlusion','audio']);
        if (Array.isArray(incoming.cards)) incoming.cards = incoming.cards.filter(card => card && enabledTypes.has(card.type));
        if (Array.isArray(incoming.cards) && !incoming.cards.length) throw Error('没有启用类型对应的可导入卡片。');
        const data = validate(incoming, { allowSynth: TTS_AVAILABLE });
        const defaultTags = subject.anki.defaultTags || [];
        const notes = [];
        // ===== 自动分层导入：父牌组就是界面上选好的那个已有牌组，只往下建缺少的子牌组 =====
        const grouping = payload.autoGroup === true;
        const parentDeck = String(data.deck || '').trim();
        const deckCache = new Map();
        const subDecks = new Set();
        const groupOf = card => deckForCard(card, parentDeck, grouping, deckCache);
        for (const card of data.cards) {
          const targetDeck = groupOf(card);
          if (targetDeck !== parentDeck) subDecks.add(targetDeck);
          // 遮挡卡 / 音频卡也要跟着分层，否则它们会全部落在父牌组里；音频卡缺音频时用本地 TTS 补上
          if (card.type === 'audio') await ensureAudio(card);
          if (['occlusion','audio'].includes(card.type)) {notes.push(await mediaCards.note(card,targetDeck,defaultTags,anki,buildNoteFields));continue;}
          if (card.source||card.sourceCandidates) card.note = (card.note||'')+'\n来源：'+JSON.stringify(card.source||card.sourceCandidates);
          const fields = card.type === 'cloze'
            ? await buildNoteFields('Cloze', card.text, card.note || '', ['Text', 'Extra'])
            : await buildNoteFields('Basic', card.front, card.back + (card.note ? `<br><br><small>${card.note}</small>` : ''), ['Front', 'Back']);
          notes.push({ deckName: targetDeck || data.deck, modelName: card.type === 'cloze' ? 'Cloze' : 'Basic', fields, tags: card.tags || defaultTags });
        }
        // 只创建确实用到的子牌组（AnkiConnect 的 createDeck 会顺带补上中间层）；父牌组本身不新建
        for (const deck of subDecks) await anki('createDeck', { deck });
        const canAdd = await anki('canAddNotes', { notes });
        const permitted = notes.filter((_, i) => canAdd[i]);
        const ids = permitted.length ? await anki('addNotes', { notes: permitted }) : [];
        const added = ids.filter(Boolean).length;
        const skipped = notes.length - permitted.length;
        // 导入成功 = 这些考点已经出现过了：记进服务端问题池，供跨批次去重
        maintenance.addSeen(subject.id, data.cards.map(card => card.text || card.front || ''));
        record(subject, { kind: 'import', ms: Date.now() - started, deck: data.deck, requested: notes.length, added, skipped });
        return json(res, 200, { added, skipped });
      } catch (error) {
        record(subject, { kind: 'import', ms: Date.now() - started, deck: String(payload.deck || ''), error: error.message || String(error) });
        throw error;
      }
    }
    if (route === '/api/apkg' && req.method === 'POST') {
      // 导出 .apkg：不依赖 AnkiConnect —— 不装/不开桌面 Anki 也能拿到卡片，
      // 手机 AnkiDroid / AnkiMobile 打开这个文件就是一键导入。
      const payload = JSON.parse(await body(req));
      const started = Date.now();
      try {
        const incoming = subject.postprocess ? subject.postprocess.normalizePayload(payload) : payload;
        const enabledTypes = new Set(Array.isArray(payload.enabledTypes) ? payload.enabledTypes : ['basic', 'cloze', 'occlusion', 'audio']);
        if (Array.isArray(incoming.cards)) incoming.cards = incoming.cards.filter(card => card && enabledTypes.has(card.type));
        if (Array.isArray(incoming.cards) && !incoming.cards.length) throw Error('没有可导出的卡片。');
        const data = validate(incoming, { allowSynth: TTS_AVAILABLE });
        const defaultTags = subject.anki.defaultTags || [];
        const parentDeck = String(data.deck || '').trim();
        const deckCache = new Map();
        const media = [];
        // 媒体不进 AnkiConnect，而是收进包里（文件名是内容哈希，天然去重）
        const collectMedia = async (action, params) => {
          if (action === 'storeMediaFile' && params && params.data) {
            media.push({ filename: params.filename, data: Buffer.from(params.data, 'base64') });
            return params.filename;
          }
          return null;
        };
        const byDeck = new Map();
        for (const card of data.cards) {
          const deckName = deckForCard(card, parentDeck, payload.autoGroup === true, deckCache) || parentDeck;
          if (!byDeck.has(deckName)) byDeck.set(deckName, []);
          if (['occlusion', 'audio'].includes(card.type)) {
            if (card.type === 'audio') await ensureAudio(card);
            const note = await mediaCards.note(card, deckName, defaultTags, collectMedia, buildNoteFields);
            byDeck.get(deckName).push({ model: 'Basic', fields: Object.values(note.fields), tags: note.tags });
            continue;
          }
          const [first, second, tags] = exportFields(card, defaultTags);
          byDeck.get(deckName).push({ model: card.type === 'cloze' ? 'Cloze' : 'Basic', fields: [first, second], tags: String(tags || '').split(/\s+/).filter(Boolean) });
        }
        const buffer = buildApkg({ decks: [...byDeck].map(([name, notes]) => ({ name, notes })), media });
        maintenance.addSeen(subject.id, data.cards.map(card => card.text || card.front || ''));
        record(subject, { kind: 'apkg', ms: Date.now() - started, deck: parentDeck, requested: data.cards.length, decks: byDeck.size });
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
        const filename = `cardflow-${subject.id}-${stamp}.apkg`;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${filename}"`,
          'content-length': buffer.length,
          'cache-control': 'no-store'
        });
        res.end(buffer);
        return true;
      } catch (error) {
        record(subject, { kind: 'apkg', ms: Date.now() - started, deck: String(payload.deck || ''), error: error.message || String(error) });
        throw error;
      }
    }
    if (route === '/api/seen' && req.method === 'GET') {
      // 跨批次、跨设备的去重依据（存在服务端，换浏览器/清缓存也不丢）
      return json(res, 200, { seen: maintenance.readSeen(subject.id), limit: maintenance.SEEN_LIMIT });
    }
    if (route === '/api/backup' && req.method === 'POST') {
      // 备份 = 学科包 + 历史记录 + 前端设置（密钥不进备份，恢复后重填就行）
      const payload = JSON.parse(await body(req));
      let historyText = '';
      try { historyText = fs.readFileSync(history.filePath(), 'utf8'); } catch (_) { historyText = ''; }
      const { buffer } = maintenance.exportBackup({ subjects: SERVING.map(item => item.id), settings: payload && payload.settings, historyText });
      record(subject, { kind: 'backup', bytes: buffer.length });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="cardflow-backup-${stamp}.zip"`,
        'content-length': buffer.length,
        'cache-control': 'no-store'
      });
      res.end(buffer);
      return true;
    }
    if (route === '/api/backup/restore' && req.method === 'POST') {
      const payload = JSON.parse(await body(req));
      if (!payload || typeof payload.data !== 'string' || !payload.data) throw new Error('恢复包内容为空。');
      const result = maintenance.restoreBackup(Buffer.from(payload.data, 'base64'));
      record(subject, { kind: 'restore', packs: result.packs, history: result.history });
      return json(res, 200, { ok: true, packs: result.packs, history: result.history, settings: result.settings || null, backupDir: result.backupDir ? path.basename(result.backupDir) : null });
    }
    if (route === '/api/diagnose' && req.method === 'GET') {
      // 诊断包：环境 + 脱敏配置 + AnkiConnect 状态 + 最近历史摘要 + 日志尾部（不含任何密钥）
      const ankiState = await anki('version')
        .then(version => ({ checked: true, ok: true, version }))
        .catch(error => ({ checked: true, ok: false, error: String((error && error.message) || error) }));
      const summary = (history.read(20) || []).map(item => ({
        t: item.t, kind: item.kind, ms: item.ms, deck: item.deck, model: item.model,
        total: item.total, added: item.added, skipped: item.skipped, error: item.error
      }));
      const report = maintenance.diagnose({
        subject: subject.id,
        config: subject.config,
        tts: TTS_AVAILABLE,
        anki: ankiState,
        history: summary,
        seenCount: maintenance.readSeen(subject.id).length,
        logFile: path.join(ROOT, 'anki-card-maker.log')
      });
      record(subject, { kind: 'diagnose' });
      return json(res, 200, report);
    }
    json(res, 404, { error: '接口不存在。' });
  } catch (error) { json(res, 400, { error: error.message || String(error) }); }
  };
}

const handler = makeHandler();

// 直接运行时（node src/server.js）才监听端口；被 tests/ require 时只导出内部函数。
if (require.main === module) {
  const describe = () => SERVING.map(subject => `${subject.shortName}→${mountOf(subject)}`).join('、');
  const server = http.createServer(handler);
  server.listen(PORT, HOST, () => {
    console.log(`${describe()} on http://127.0.0.1:${PORT}${MULTI ? ' (local)' : ''}`);
    const lanPicked = pickAddresses(os.networkInterfaces());
    lanPicked.lan.forEach(ip => console.log(`${describe()} on http://${ip}:${PORT} (LAN/mobile)`));
    lanPicked.remote.forEach(ip => console.log(`${describe()} on http://${ip}:${PORT} (远程：Tailscale/ZeroTier)`));
    if (!ALL_HAVE_TOKEN) console.log('WARNING: 有学科没有配置 token；只监听 127.0.0.1。');
  });

  if (HTTPS_OPTIONS) {
    const httpsServer = https.createServer(HTTPS_OPTIONS, handler);
    httpsServer.on('error', error => console.log(`HTTPS listener error ${error.message}`));
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`${describe()} on https://127.0.0.1:${HTTPS_PORT} (local/secure)`);
      const HTTPS_PICKED = pickAddresses(os.networkInterfaces());
      HTTPS_PICKED.lan.forEach(ip => console.log(`${describe()} on https://${ip}:${HTTPS_PORT} (LAN/mobile + PWA install)`));
      HTTPS_PICKED.remote.forEach(ip => console.log(`${describe()} on https://${ip}:${HTTPS_PORT} (远程 + PWA install)`));
    });
  }

  // 其它学科原来的端口：不是做跳转，而是**直接以单学科模式提供那个学科**
  //   ── 这样它在浏览器眼里是另一个 origin，桌面图标、缓存、PWA 都与多学科端口彻底分开
  //   ── 老书签（例如化学的 http://ip:3211/）行为和合并前完全一样
  // 两个前提，缺一不可：
  //   1) 主端口必须是标准配置里第一个学科的端口（用 ANKI_PORT 改过端口时，别的端口可能是**别人**的服务，
  //      硬抢会撞上正在运行的进程）；
  //   2) ANKI_LEGACY_PORTS=0 可以显式关掉（测试用）。
  const soloPortsEnabled = MULTI
    && process.env.ANKI_LEGACY_PORTS !== '0'
    && PORT === PRIMARY.httpPort
    && HTTPS_PORT === PRIMARY.httpsPort;
  if (soloPortsEnabled) {
    const others = ALL_SUBJECTS.filter(subject => BUILTIN_IDS.has(subject.id) && subject.httpPort !== PORT);
    others.forEach(subject => {
      const soloHandler = makeHandler({ subject });
      const httpSolo = http.createServer(soloHandler);
      httpSolo.on('error', error => console.log(`独立入口 http://127.0.0.1:${subject.httpPort} 未启用：${error.message}`));
      httpSolo.listen(subject.httpPort, HOST, () => console.log(`${subject.shortName} 也可从 http://127.0.0.1:${subject.httpPort}/ 直接进（独立地址，图标不会串）`));
      if (HTTPS_OPTIONS) {
        const httpsSolo = https.createServer(HTTPS_OPTIONS, soloHandler);
        httpsSolo.on('error', error => console.log(`独立入口 https://127.0.0.1:${subject.httpsPort} 未启用：${error.message}`));
        httpsSolo.listen(subject.httpsPort, HOST, () => console.log(`${subject.shortName} 也可从 https://127.0.0.1:${subject.httpsPort}/ 直接进（独立地址）`));
      }
    });
  }
}

// 测试入口：直接运行服务时不使用这些导出。
module.exports = {
  handler, buildPrompt, generate, validate, extractFirstJson, withServerDefaults, referenceLimit,
  ankiErrorText, countCardTypes, cardTitles, history, cardIssue, retryCard,
  rankByDomains, cleanSearchResults, webSearch, zhihuSearch,
  lanAddresses, pickAddresses, isFakeIp, ZhihuMcp, renderTemplate, renderSubjectTemplate, mountOf,
  exportFields, exportText, escapeExportField, stampNow,
  ALL_SUBJECTS, SERVING, MULTI, PORT, HTTPS_PORT, ANKI_URL, JINA_BASE, ZHIHU_BASE
};
