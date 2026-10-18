'use strict';
/*
 * 离线 API 适配器（安卓壳专用：页面资源在包里，没有服务器）。
 *
 * 做法：把 window.fetch 换成「本地优先」——
 *   1) 打到 /api/... 的请求交给本文件处理，返回一个真正的 Response；
 *   2) 其它请求照旧走原来的 fetch。
 *   app.js / workflow.js 一行都不用改：它们只知道「有 /api/xxx 可以调」。
 *
 * 需要原生桥（Android 侧 window.CardFlowNative）的三件事：
 *   - httpRequest：绕过浏览器 CORS 直连 AI 接口（网页里直接 fetch 会被 CORS 拦住）
 *   - buildApkg ：用系统自带 SQLite 生成 .apkg（网页侧没有 SQLite）
 *   - tts       ：系统语音合成（音频卡自动配音）
 * 这些调用是异步的：原生侧干完活回调 window.CardFlowNativeOnResponse(id, json)。
 */
(function () {
  const SUBJECT = window.__SUBJECT__ || {};
  const DATA = window.CardFlowPrompts || {};
  /* 手机上自己导入的学科包存在本机；内联的 prompt-data 是打包时带进来的内置学科。 */
  const STORED_PACKS = 'cardflow.offline.packs';
  const storedPacks = () => {
    try {
      const raw = localStorage.getItem(STORED_PACKS);
      const list = raw ? JSON.parse(raw) : {};
      return list && typeof list === 'object' ? list : {};
    } catch (_) { return {}; }
  };
  /* 对「打包进 APK 的学科包」的本机修改（在学科选择页里编辑后存在这里），优先于打包时内联的那份。 */
  const STORED_OVERRIDES = 'cardflow.offline.overrides';
  const storedOverrides = () => {
    try {
      const raw = localStorage.getItem(STORED_OVERRIDES);
      const list = raw ? JSON.parse(raw) : {};
      return list && typeof list === 'object' ? list : {};
    } catch (_) { return {}; }
  };
  /** 当前学科的制卡信息：本机改过的 > 手机导入的 > 内置的（提示词只在手机上），
   *  字段缺失的按内置生物补齐（与 packs.materialize 同一口径）。 */
  const mine = () => {
    const pack = storedOverrides()[SUBJECT.id] || storedPacks()[SUBJECT.id];
    const base = DATA[SUBJECT.id] || DATA.bio || {};
    if (!pack) return base;
    return {
      id: pack.id,
      name: pack.name || base.name,
      // 学科包勾了「化学式转换」就启用化学后处理（与 materialize 的 postprocess:'chem' 同一口径）
      normalize: Boolean(pack.chemFormulas),
      postprocess: Boolean(pack.chemFormulas),
      prompts: pack.prompts || base.prompts,
      cardCount: { ...(base.cardCount || {}), min: pack.cardCount.min, max: pack.cardCount.max },
      cardMode: base.cardMode,
      search: pack.search || base.search,
      defaultTags: base.defaultTags || [],
      defaultDeck: base.defaultDeck || ''
    };
  };
  const SHARED = window.CardFlowShared;
  const ZIP = window.CardFlowZip;
  if (!SHARED) { console.warn('离线适配器：shared 脚本没加载，离线功能不可用。'); return; }

  /* ===== 本机存储：口令 / 历史 / 问题池 / 牌组列表 ===== */
  const TOKEN_KEY = SUBJECT.tokenKey || 'cardflow.offline.token';
  const HISTORY_KEY = `cardflow.offline.history.${SUBJECT.id}`;
  const SEEN_KEY = `cardflow.offline.seen.${SUBJECT.id}`;
  const DECKS_KEY = `cardflow.offline.decks.${SUBJECT.id}`;
  const HISTORY_LIMIT = 300;
  const SEEN_LIMIT = 4000;

  const store = {
    read(key, fallback) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } },
    write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 写不进去就只影响本机记录 */ } }
  };

  /* 离线版没有访问口令：'local' 让 app.js 的口令门直接放行（本机不需要鉴权）。 */
  try {
    if (!localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, 'local');
    if (!/(^|;\s*)ankiToken=/.test(document.cookie || '')) document.cookie = 'ankiToken=local; path=/; max-age=31536000; SameSite=Lax';
  } catch (_) { /* 存不进去也不影响使用 */ }

  function historyAll() { const list = store.read(HISTORY_KEY, []); return Array.isArray(list) ? list : []; }
  function historyRead(limit = 100) { return historyAll().slice(-Math.max(1, limit)).reverse(); }
  function historyAppend(entry) {
    const full = { t: Date.now(), subject: SUBJECT.id, ...entry };
    const list = historyAll();
    list.push(full);
    store.write(HISTORY_KEY, list.slice(-HISTORY_LIMIT));
    return full;
  }
  function historyUpdate(stamp, mutate) {
    const list = historyAll();
    for (let i = list.length - 1; i >= 0; i--) {
      if (Number(list[i].t) !== Number(stamp)) continue;
      mutate(list[i]);
      store.write(HISTORY_KEY, list);
      return true;
    }
    return false;
  }
  /** 与服务端 maintenance 同一口径：小写、去掉空白与标点，短于 2 个字的不收 */
  const seenKeyOf = text => String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  function seenRead() { return store.read(SEEN_KEY, []).filter(text => typeof text === 'string'); }
  function seenAdd(texts) {
    const incoming = (Array.isArray(texts) ? texts : []).map(seenKeyOf).filter(text => text.length >= 2);
    if (!incoming.length) return;
    const list = seenRead();
    const known = new Set(list);
    const added = [...new Set(incoming)].filter(text => !known.has(text));
    if (added.length) store.write(SEEN_KEY, [...list, ...added].slice(-SEEN_LIMIT));
  }

  /* ===== 原生桥：统一「异步 + 回调」；不在这里的桥就当没装 App（浏览器里打开离线页） ===== */
  let seq = 0;
  const pending = {};
  window.CardFlowNativeOnResponse = function (id, payload) {
    const job = pending[String(id)];
    if (!job) return;
    delete pending[String(id)];
    let data = {};
    try { data = JSON.parse(payload || '{}') || {}; } catch (_) { data = {}; }
    if (data.ok === false) {
      const error = new Error(data.error || '本机操作失败。');
      error.payload = data;   // 部分成功时（已写入几张）调用方要看得到计数
      job.reject(error);
    } else job.resolve(data);
  };
  function nativeCall(method, payload) {
    return new Promise((resolve, reject) => {
      const bridge = window.CardFlowNative;
      if (!bridge || typeof bridge[method] !== 'function') return reject(new Error('这个操作需要安卓 App（离线版在浏览器里打开时不可用）。'));
      const id = String(++seq);
      pending[id] = { resolve, reject };
      try { bridge[method](id, JSON.stringify(payload || {})); } catch (error) { delete pending[id]; reject(new Error(`调用本机桥失败：${error.message}`)); }
    });
  }
  const hasNative = () => Boolean(window.CardFlowNative);

  /* ===== 联网检索 Key：电脑版读服务端 config.json；手机上用离线页里那个只存本机的输入框 ===== */
  const SEARCH_KEY_STORE = 'cardflow.offline.searchKey';
  function searchKey() {
    try {
      const input = document.getElementById('offlineSearchKey');
      if (input && String(input.value || '').trim()) return String(input.value).trim();
    } catch (_) { /* DOM 还没就绪就用存过的那份 */ }
    return store.read(SEARCH_KEY_STORE, '');
  }
  /* ===== 新手教程与自检（离线页独有：不碰 app.js） =====
     第一次打开 App 自动弹一次；以后从「接口设置」里的按钮进。 */
  const GUIDE_SEEN = 'cardflow.offline.guideSeen';

  function guideElement() {
    let box = document.getElementById('offlineGuideBox');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'offlineGuideBox';
    box.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(10,22,36,.55);display:flex;align-items:flex-start;justify-content:center;padding:18px 12px;overflow:auto';
    box.innerHTML = '<div style="background:#fff;color:#17263d;border-radius:14px;max-width:560px;width:100%;padding:18px 18px 14px;line-height:1.7;font-size:15px">'
      + '<h2 style="margin:0 0 10px;font-size:18px">第一次用：按这个顺序来</h2>'
      + '<ol style="padding-left:22px;margin:0 0 12px">'
      + '<li>装好 <b>AnkiDroid</b>；本 App 弹出的权限请求点「允许」（用于把卡片直接写进去）。</li>'
      + '<li>在「接口设置」里填 <b>AI 接口地址 / Key / 模型</b>；填一次就记住了。</li>'
      + '<li>拍照或选 PDF → 点「生成卡片」→ 检查卡片 → 点「导入 Anki」。</li>'
      + '<li>想用联网调研：「联网调研」里填一个检索服务的 Key，再点「自动调研」。</li>'
      + '</ol>'
      + '<div id="offlineGuideCheck" style="background:#f5f9fd;border:1px solid rgba(161,185,221,.5);border-radius:10px;padding:12px;margin:0 0 12px;font-size:14px">点下面的「开始自检」，看看四项都准备好了没有。</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:8px">'
      + '<button id="offlineGuideStart" style="padding:10px 14px;border-radius:10px;border:1px solid #2269d1;background:#2269d1;color:#fff">开始自检</button>'
      + '<button id="offlineGuideClose" style="padding:10px 14px;border-radius:10px;border:1px solid #2269d1;background:#fff;color:#2269d1">知道了，开始用</button>'
      + '<button id="offlineGuidePage2" style="padding:10px 14px;border-radius:10px;border:1px solid #2269d1;background:#fff;color:#2269d1">完整使用说明</button>'
      + '</div></div>';
    document.body.appendChild(box);
    document.getElementById('offlineGuideClose').addEventListener('click', () => { store.write(GUIDE_SEEN, true); box.remove(); });
    document.getElementById('offlineGuidePage2').addEventListener('click', () => { location.href = 'guide.html'; });
    document.getElementById('offlineGuideStart').addEventListener('click', () => runSelfCheck());
    return box;
  }

  function openGuide() { try { guideElement(); } catch (_) { /* 建不出来就算了，不影响制卡 */ } }

  /** 自检：四项能不能用，逐项写清楚（不用 emoji，也不替用户判断） */
  async function runSelfCheck() {
    const target = document.getElementById('offlineGuideCheck');
    if (!target) return;
    const valueOf = id => { const node = document.getElementById(id); return node ? String(node.value || '').trim() : ''; };
    target.textContent = '正在自检……';
    const lines = [];
    const apiUrl = valueOf('apiUrl'), apiKey = valueOf('apiKey'), model = valueOf('model');
    lines.push(apiUrl && model && apiKey
      ? `1. AI 接口：已填（${apiUrl}／模型 ${model}）—— 生成时才知道 Key 对不对`
      : '1. AI 接口：还没填全（地址、Key、模型都要）');
    const probe = await probeAnki();
    lines.push(probe.canWrite
      ? `2. 直写 AnkiDroid：可以（读到 ${(probe.decks || []).length} 个牌组）`
      : `2. 直写 AnkiDroid：不行 —— ${probe.reason || '原因未知'}；这会影响「导入 Anki」，可以先用「下载 .apkg」`);
    lines.push(hasNative() ? '3. 系统语音（音频卡配音）：可用' : '3. 系统语音：不可用（不在 App 里）');
    lines.push(searchKey() ? '4. 联网调研：已填检索 Key' : '4. 联网调研：还没填检索 Key（只在要用调研时才需要）');
    lines.push('');
    lines.push('提示：如果直写不行，先检查 AnkiDroid 里是否允许了 API，以及系统设置里是否允许本 App「读写 AnkiDroid 数据库」。');
    target.innerHTML = '';
    const list = document.createElement('div');
    list.style.whiteSpace = 'pre-line';
    list.textContent = lines.join('\n');
    target.appendChild(list);
  }

  // 存一份在本机；「说明」按钮给一段人话（不用 emoji）
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('offlineSearchKey');
    if (input) {
      input.value = store.read(SEARCH_KEY_STORE, '');
      input.addEventListener('change', () => store.write(SEARCH_KEY_STORE, String(input.value || '').trim()));
    }
    // 新手教程：第一次打开自动弹一次（用户点「知道了」之后不再自动弹）
    const guideButton = document.getElementById('offlineGuide');
    if (guideButton) guideButton.addEventListener('click', () => openGuide());
    const guideLink = document.getElementById('offlineGuidePage');
    if (guideLink) guideLink.addEventListener('click', () => { location.href = 'guide.html'; });
    if (!store.read(GUIDE_SEEN, false)) openGuide();
    const help = document.getElementById('offlineKeyHelp');
    if (help) help.addEventListener('click', () => {
      alert('联网调研要用一个检索服务的 API Key（默认 Tavily，免费额度就够用）：\n\n'
        + '1. 打开 tavily.com 注册，在控制台复制以 tvly- 开头的 Key；\n'
        + '2. 粘贴到左边这个输入框，会自动保存（只存在这台手机上，不会上传到任何服务器）；\n'
        + '3. 填好后就能用「自动调研」和「联网检索」了。\n\n'
        + '手机版的联网检索通过检索服务商完成（默认 Tavily）；电脑版还能走知乎官方通道。');
    });
  });

  /* ===== 跟服务端一致的小工具 ===== */
  const promptSubject = () => ({
    id: SUBJECT.id,
    name: mine().name || SUBJECT.id,
    prompts: mine().prompts || {},
    cardCount: mine().cardCount || { min: 1, max: 20 },
    cardMode: mine().cardMode || { field: 'depth', promptVar: 'intensity', options: [{ value: 'balanced', prompt: '均衡' }] },
    search: mine().search || null,
    anki: { defaultTags: mine().defaultTags || [], defaultDeck: mine().defaultDeck || '' }
  });
  const postprocess = () => ((mine().normalize || mine().postprocess) ? window.CardFlowPostprocess : null);
  const base64Bytes = base64 => {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  /** 文件名里用：与服务端 /api/apkg 同样的写法（年月日时分） */
  const apkgStamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const trackStamp = () => { const d = new Date(), pad = value => String(value).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; };
  const countTypes = cards => SHARED.countCardTypes(cards);
  const cardTitles = cards => SHARED.cardTitles(cards);

  /* ===== 媒体：把 base64 收进 .apkg（文件名按内容哈希去重，与服务端同思路） ===== */
  const MEDIA_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg' };
  function fnvHash(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }
  /** 单个媒体 → {base64, preferredName}：.apkg 与直写（AnkiDroid 媒体接口）都用它算文件名 */
  function mediaOf(data) {
    const match = /^data:((?:image|audio)\/[\w+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(data || '');
    if (!match) throw Error('媒体格式无效');
    const ext = MEDIA_EXT[match[1]];
    if (!ext) throw Error('媒体格式不支持');
    const bytes = base64Bytes(match[2]);
    if (bytes.length > 12 * 1024 * 1024) throw Error('单张卡媒体超过 12MB');
    return { base64: match[2], preferredName: `cardflow-${fnvHash(match[2])}${bytes.length.toString(16)}.${ext}` };
  }
  function collectMedia(item, media) {
    if (!media.some(existing => existing.filename === item.preferredName)) media.push({ filename: item.preferredName, base64: item.base64 });
    return item.preferredName;
  }
  /** 音频卡没有音频时用系统 TTS 补上（与服务端 ensureAudio 同一口径：speak / audioText / front） */
  async function ensureAudio(card) {
    if (!card || card.type !== 'audio' || card.audio) return card;
    if (!hasNative()) return card;
    const spoken = String(card.speak || card.audioText || card.front || '').trim();
    if (!spoken) return card;
    try {
      const clip = await nativeCall('tts', { text: spoken });
      if (clip && clip.dataUrl) card.audio = clip.dataUrl;
    } catch (_) { /* 合成不了就保持原样，后面报「音频卡缺音频」 */ }
    return card;
  }

  /* ===== AnkiDroid：自检与牌组 ===== */
  /** 直写前的自检：能不能写、有哪些牌组（没有原生桥就当作「不能写」） */
  async function probeAnki() {
    if (!hasNative()) return { canWrite: false, decks: [], reason: '这个操作需要安卓 App（离线版在浏览器里打开时不可用）。' };
    return nativeCall('decks', {}).catch(error => ({ canWrite: false, decks: [], reason: error.message }));
  }
  /** 牌组列表：AnkiDroid 里的真实牌组 + 本机新建过的 */
  async function deckList() {
    const local = store.read(DECKS_KEY, []);
    const probe = await probeAnki();
    const list = [...new Set([...(probe.decks || []), ...(local || []), mine().defaultDeck].filter(Boolean))];
    return list.length ? list : ['Default'];
  }

  /**
   * 把卡片整理成 [{name, notes:[{model, fields?, media?, card?, tags}]}]。
   * .apkg 与直写两条路都用它，保证「手机上直接导进去的」和「打包导出去的」内容完全一致。
   * 有媒体的卡先把媒体记下来：字段 HTML 要等拿到最终文件名后再拼（见 noteFields）。
   */
  async function layoutCards(data, payload) {
    const defaultTags = mine().defaultTags || [];
    const parentDeck = String(data.deck || '').trim();
    const deckCache = new Map();
    const groups = [];
    const byName = new Map();
    const groupOf = name => { if (!byName.has(name)) { const group = { name, notes: [] }; byName.set(name, group); groups.push(group); } return byName.get(name); };
    for (const card of data.cards) {
      const deckName = SHARED.deckForCard(card, parentDeck, payload.autoGroup === true, deckCache) || parentDeck;
      const group = groupOf(deckName);
      if (card.type === 'occlusion' || card.type === 'audio') {
        if (card.type === 'audio') await ensureAudio(card);
        group.notes.push({ model: 'Basic', media: mediaOf(card.type === 'audio' ? card.audio : card.image), card, tags: card.tags || defaultTags });
        continue;
      }
      const [first, second, tags] = SHARED.exportFields(card, defaultTags);
      group.notes.push({ model: card.type === 'cloze' ? 'Cloze' : 'Basic', fields: [first, second], tags: String(tags || '').split(/\s+/).filter(Boolean) });
    }
    return groups;
  }

  /** 媒体卡的字段 HTML；mediaName 是最终文件名（.apkg 里用哈希名，直写时用 AnkiDroid 实际给的名字） */
  function noteFields(note, mediaName) {
    if (!note.card) return note.fields;
    const html = SHARED.mediaNote(note.card, mediaName || note.media.preferredName);
    return [html.front, html.back];
  }

  /** 打包 .apkg 的入参（.apkg 导出与直写失败时的回退共用） */
  function apkgInput(groups) {
    const media = [];
    const decks = groups.map(group => ({
      name: group.name,
      notes: group.notes.map(note => {
        if (note.media) collectMedia(note.media, media);
        return { model: note.model, fields: noteFields(note), tags: note.tags };
      })
    }));
    return { decks, media };
  }

  /** 标记「这条错误已经处理过」（页面照原样显示，不加「导入失败：」前缀） */
  function handled(error) {
    error.handled = true;
    return error;
  }

  /* ===== 备份 / 恢复 / 诊断：都在本机，包结构与电脑版一致（zip 里放 meta.json / history.jsonl / settings.json） ===== */
  const backupHistoryText = () => {
    const list = historyAll();
    return list.length ? `${list.map(record => JSON.stringify(record)).join('\n')}\n` : '';
  };

  async function localBackup(provided) {
    if (!ZIP) throw Error('备份需要 zip 支持（backup-zip.js 没加载）。');
    const settings = (provided && typeof provided === 'object')
      ? provided
      : (window.CardFlowCore && window.CardFlowCore.settings ? window.CardFlowCore.settings() : null);
    const historyText = backupHistoryText();
    const meta = {
      kind: 'cardflow-backup',
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      subjects: [SUBJECT.id],
      source: 'android-offline',
      includesHistory: Boolean(historyText),
      includesPacks: false,
      includesSettings: Boolean(settings)
    };
    const entries = [{ name: 'meta.json', data: JSON.stringify(meta, null, 2) }];
    if (historyText) entries.push({ name: 'history.jsonl', data: historyText });
    if (settings) entries.push({ name: 'settings.json', data: JSON.stringify(settings, null, 2) });
    return { bytes: ZIP.zip(entries), filename: `cardflow-backup-${apkgStamp()}.zip` };
  }

  async function localRestore(base64) {
    if (!ZIP) throw Error('恢复需要 zip 支持（backup-zip.js 没加载）。');
    const files = await ZIP.unzip(base64Bytes(base64));
    if (!Object.keys(files).length) throw Error('备份包里没有任何内容。');
    let settings = null;
    let restored = 0;
    if (files['history.jsonl']) {
      const records = ZIP.textOf(files['history.jsonl']).split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
      // 覆盖前先把旧的存一份在本机（与服务端「先备份再覆盖」同一思路）
      store.write(`${HISTORY_KEY}.backup`, historyAll());
      store.write(HISTORY_KEY, records.slice(-HISTORY_LIMIT));
      restored = records.length;
    }
    if (files['settings.json']) {
      try { settings = JSON.parse(ZIP.textOf(files['settings.json'])); } catch (_) { settings = null; }
    }
    if (!restored && !settings) throw Error('备份包里既没有历史记录也没有设置。');
    return { ok: true, packs: 0, history: restored > 0, settings, backupDir: null, restored };
  }

  async function localDiagnose() {
    const probe = await probeAnki();
    const settings = window.CardFlowCore && window.CardFlowCore.settings ? window.CardFlowCore.settings() : null;
    let config = {};
    try { config = JSON.parse(localStorage.getItem(SUBJECT.storageKey) || '{}') || {}; } catch (_) { config = {}; }
    const origin = (() => {
      try { return new URL(String(config.apiUrl || '')).origin; } catch (_) { return config.apiUrl ? '（非标准 URL，已省略）' : ''; }
    })();
    const recent = historyRead(20).map(item => ({
      t: item.t, kind: item.kind, ms: item.ms, deck: item.deck, model: item.model,
      total: item.total, added: item.added, skipped: item.skipped, error: item.error
    }));
    return {
      kind: 'cardflow-diagnose',
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      runtime: { platform: 'android-offline', app: 'CardFlow APK', userAgent: String((typeof navigator !== 'undefined' && navigator.userAgent) || '') },
      subject: SUBJECT.id,
      // 与电脑版一样：只报「有没有」，绝不带出密钥本身
      config: {
        apiUrlOrigin: origin,
        model: config.model || '',
        hasApiKey: Boolean(config.apiKey),
        hasTavilyKey: Boolean(config.tavilyKey),
        hasZhihuKey: Boolean(config.zhihuKey),
        hasToken: false,
        ttsAvailable: hasNative()
      },
      anki: { checked: true, canWrite: Boolean(probe.canWrite), reason: probe.reason || '', decks: (probe.decks || []).length },
      settings: settings ? { rules: (settings.rules || []).length, batchSize: settings.batchSize, duplicateCheck: settings.duplicateCheck } : null,
      history: recent,
      seenCount: seenRead().length,
      log: '离线版没有服务端日志；出错时请看卡片页的状态提示。'
    };
  }

  /** 导入/导出前的整理：宽容解析 → 按勾选类型过滤 → 格式校验（两条路的口径必须一致） */
  function prepareCards(payload, emptyMessage) {
    const post = postprocess();
    const incoming = post ? post.normalizePayload(payload) : payload;
    // 填空卡字段归一（front/back 里带 {{c1::…}} 的搬进 text），电脑版同一份实现：
    // 模型经常按普通卡习惯填 front，不归一就会「第 N 张：填空卡缺少文本」整批导入失败。
    if (incoming && Array.isArray(incoming.cards)) SHARED.coerceCards(incoming.cards);
    const enabled = new Set(Array.isArray(payload.enabledTypes) ? payload.enabledTypes : ['basic', 'cloze', 'occlusion', 'audio']);
    if (Array.isArray(incoming.cards)) incoming.cards = incoming.cards.filter(card => card && enabled.has(card.type));
    if (Array.isArray(incoming.cards) && !incoming.cards.length) throw Error(emptyMessage);
    return SHARED.validate(incoming, hasNative() ? { allowSynth: true } : undefined);
  }

  /** 直写走不通时的退路：打包 .apkg 存到应用下载目录（不再自动拉起 AnkiDroid 导入界面，真机反馈），
   *  用户在 AnkiDroid 里自己打开这个文件导入。 */
  async function apkgFallback(groups, data, reason) {
    const built = await nativeCall('buildApkg', apkgInput(groups));
    const filename = `cardflow-${SUBJECT.id}-${apkgStamp()}.apkg`;
    const bridge = window.CardFlowNative;
    const saved = Boolean(bridge && typeof bridge.saveFile === 'function');
    if (saved) bridge.saveFile(filename, built.base64);
    seenAdd(data.cards.map(card => card.text || card.front || ''));
    historyAppend({ kind: 'apkg', deck: String(data.deck || ''), requested: data.cards.length, decks: groups.length });
    return handled(new Error(saved
      ? `直接写进 AnkiDroid 没成功（${reason}），已改成打包 .apkg 存到应用下载目录（Android/data/cn.cardflow.app/files/Download）：请在 AnkiDroid 里打开 ${filename} 导入（共 ${data.cards.length} 张）。`
      : `直接写进 AnkiDroid 没成功（${reason}），也没能把 .apkg 存下来：请点「下载 .apkg」自己导入。`));
  }

  /* ===== 各端点 ===== */
  async function route(pathname, url, method, payload) {
    switch (pathname) {
      case '/api/config': {
        // 离线版没有服务端配置：Key 只能填在页面里（存在本机），所以 hasKey 一律 false
        return { json: { apiUrl: '', model: '', hasKey: false, hasSearch: Boolean(searchKey()), hasZhihu: false, tts: hasNative() } };
      }
      case '/api/health': {
        const probe = await probeAnki();
        return { json: { ok: true, version: 'AnkiDroid 直连', collection: probe.canWrite !== false, collectionError: probe.canWrite ? undefined : (probe.reason || 'AnkiDroid 暂时不能写卡') } };
      }
      case '/api/network': {
        throw Error('离线版不需要内网地址：卡片直接在本机生成，导出的 .apkg 交给 AnkiDroid 即可。');
      }
      case '/api/decks': return { json: { decks: await deckList() } };
      case '/api/deck/create': {
        const name = String(payload.deck || '').trim();
        if (!name) throw Error('牌组名不能为空。');
        if (name.split('::').some(part => !part.trim())) throw Error('牌组层级不能为空，例如「课程::第一章」。');
        const local = store.read(DECKS_KEY, []);
        if (!local.includes(name)) store.write(DECKS_KEY, [...local, name]);
        return { json: { deck: name, id: 0 } };
      }
      case '/api/deck/delete': {
        const name = String(payload.deck || '').trim();
        if (!name) throw Error('牌组名不能为空。');
        const decks = await deckList();
        if (!decks.includes(name)) throw Error(`牌组不存在：${name}`);
        const targets = decks.filter(deck => deck === name || deck.startsWith(name + '::'));
        if (payload.dryRun) return { json: { deck: name, decks: targets, subdecks: targets.filter(deck => deck !== name), cardCount: 0 } };
        const local = store.read(DECKS_KEY, []);
        store.write(DECKS_KEY, local.filter(deck => !targets.includes(deck)));
        throw Error('离线版只从本机列表里移除了这个牌组；AnkiDroid 里的牌组请在 AnkiDroid 内删除。');
      }
      case '/api/models': {
        const url2 = `${String(payload.url || '').replace(/\/$/, '')}/models`;
        if (!payload.url || !payload.key) throw Error('缺少 API 地址或 Key。');
        const res = await nativeCall('httpRequest', { url: url2, method: 'GET', headers: { authorization: `Bearer ${payload.key}` } });
        let result = {};
        try { result = JSON.parse(res.body || '{}'); } catch (_) { result = {}; }
        if (Number(res.status) >= 400 || !result) throw Error((result.error && result.error.message) || '无法获取模型列表。');
        return { json: { models: (result.data || []).map(item => item.id).sort() } };
      }
      case '/api/normalize': {
        const post = postprocess();
        if (!post) { const error = new Error('接口不存在。'); error.status = 404; throw error; }
        return { json: post.normalizePayload(payload) };
      }
      case '/api/generate': {
        const subject = promptSubject();
        const started = Date.now();
        const content = SHARED.generateMessages(subject, payload);
        const send = async request => {
          const res = await nativeCall('httpRequest', { url: request.url, method: 'POST', headers: request.init.headers, body: request.init.body });
          return { status: Number(res.status), bodyText: String(res.body || '') };
        };
        // 请求体（max_tokens / 关思考 / JSON 模式）、参数降级与「解析失败带纠正语重试一次」
        // 都在 shared/generate.js 里，电脑版走的是同一份实现。
        const { generated, reply } = await SHARED.generateCards({
          subject, data: payload, content, send,
          parse: text => SHARED.parseGenerated(payload, text, postprocess())
        });
        const entry = historyAppend({
          kind: 'generate', ms: Date.now() - started, model: payload.model,
          referenceChars: String(payload.reference || '').trim().length,
          deck: String(payload.deck || ''), ...countTypes(generated && generated.cards),
          cards: (generated && Array.isArray(generated.cards)) ? generated.cards : []
        });
        return { json: { ...generated, historyT: entry.t, finish: reply && reply.finish } };
      }
      case '/api/card/retry': {
        const card = payload.card;
        const issue = SHARED.cardIssue(card);
        if (issue) throw Error(`这张卡片本身格式有问题（${issue}），建议先修好或用「重试生成」整批重来。`);
        const subject = promptSubject();
        const guidance = String(payload.guidance || '').trim();
        // 留空 = 随机挑一个方向；温度也高一点，好让新版真的有差别（与服务端同一套规则）
        const angle = guidance || SHARED.RETRY_ANGLES[Math.floor(Math.random() * SHARED.RETRY_ANGLES.length)];
        const started = Date.now();
        const request = SHARED.chatRequest(subject, { url: payload.url, key: payload.key, model: payload.model }, [{ type: 'text', text: SHARED.retryPrompt(subject, card, angle) }]);
        const body = JSON.parse(request.init.body);
        body.temperature = guidance ? 0.4 : 0.75;
        const res = await nativeCall('httpRequest', { url: request.url, method: 'POST', headers: request.init.headers, body: JSON.stringify(body) });
        let result = {};
        try { result = JSON.parse(res.body || '{}'); } catch (_) { throw Error('AI 返回的不是 JSON（可能被网关截断了）。'); }
        if (Number(res.status) >= 400) throw Error((result.error && result.error.message) || `AI 请求失败（HTTP ${res.status}）。`);
        const content = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
        if (!content) throw Error('AI 未返回卡片内容。');
        const next = SHARED.parseRetry(content, postprocess(), card);
        if (!next) throw Error('AI 没有返回可用的卡片。');
        return { json: { card: next, angle, random: !guidance, ms: Date.now() - started, issue: SHARED.cardIssue(next) } };
      }
      case '/api/import': {
        const started = Date.now();
        const data = prepareCards(payload, '没有启用类型对应的可导入卡片。');
        const groups = await layoutCards(data, payload);
        // 先自检：不能直写（没装 AnkiDroid / 没授权 / 没可用笔记类型）就直接走 .apkg
        const probe = await probeAnki();
        if (!probe.canWrite) throw await apkgFallback(groups, data, probe.reason || 'AnkiDroid 现在不能直写');
        // 有媒体的先把文件传进 AnkiDroid 的媒体库，拿到它实际用的文件名后再拼字段 HTML
        const files = groups.flatMap(group => group.notes).filter(note => note.media)
          .map(note => ({ base64: note.media.base64, preferredName: note.media.preferredName }));
        let actualName = new Map();
        try {
          if (files.length) {
            const uploaded = await nativeCall('uploadMedia', { files });
            actualName = new Map((uploaded.files || []).map(item => [item.preferredName, item.name]));
          }
        } catch (error) {
          throw await apkgFallback(groups, data, `图片/音频没能传进 AnkiDroid（${error.message}）`);
        }
        const anyCloze = groups.some(group => group.notes.some(note => note.model === 'Cloze'));
        let added = 0;
        let skipped = 0;
        try {
          for (const group of groups) {
            const notes = group.notes.map(note => ({
              model: note.model,
              fields: noteFields(note, actualName.get(note.media && note.media.preferredName)),
              tags: note.tags
            }));
            const result = await nativeCall('addNotes', { deck: group.name, notes, anyCloze });
            const wrote = Number(result.added) || 0;
            added += wrote;
            skipped += notes.length - wrote;
            (result.errors || []).forEach(message => console.warn('直写 AnkiDroid：', message));
          }
        } catch (error) {
          added += Number((error.payload && error.payload.added) || 0);
          // 一张都没写进去才算失败（这时回退 .apkg 不会产生重复）；写进去一部分就如实报告，不自动回退
          if (added === 0) throw await apkgFallback(groups, data, error.message);
          throw handled(new Error(`只写进去 ${added} 张，剩下 ${data.cards.length - added} 张没成功（${error.message}）。再点一次「导入 Anki」会把已成功的重复写入，这批建议改用「下载 .apkg」。`));
        }
        seenAdd(data.cards.map(card => card.text || card.front || ''));
        historyAppend({ kind: 'import', ms: Date.now() - started, deck: String(data.deck || ''), requested: data.cards.length, added, skipped });
        return { json: { added, skipped } };
      }
      case '/api/apkg': {
        const data = prepareCards(payload, '没有可导出的卡片。');
        const groups = await layoutCards(data, payload);
        const built = await nativeCall('buildApkg', apkgInput(groups));
        seenAdd(data.cards.map(card => card.text || card.front || ''));
        historyAppend({ kind: 'apkg', ms: 0, deck: String(data.deck || ''), requested: data.cards.length, decks: groups.length });
        return { bytes: base64Bytes(built.base64), filename: `cardflow-${SUBJECT.id}-${apkgStamp()}.apkg`, type: 'application/octet-stream' };
      }
      case '/api/export': {
        const type = String(payload.type || '').trim();
        const label = SHARED.EXPORT_TYPE_LABELS[type];
        if (!label) throw Error('导出类型只能是 basic（普通卡）、cloze（填空卡）、occlusion（图像遮挡卡）或 audio（音频卡）。');
        const picked = (Array.isArray(payload.cards) ? payload.cards : []).filter(card => card && card.type === type);
        if (!picked.length) throw Error(`没有${label}可以导出。`);
        historyAppend({ kind: 'export', type, count: picked.length });
        return { bytes: new TextEncoder().encode(SHARED.exportText(picked, mine().defaultTags || [])), filename: `${SUBJECT.id}-${trackStamp()}-${type}.txt`, type: 'text/tab-separated-values; charset=utf-8' };
      }
      case '/api/history': {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
        const records = historyRead(limit).map(record => {
          const cards = Array.isArray(record.cards) ? record.cards : null;
          return { ...record, cards: undefined, titles: cards ? cardTitles(cards) : (Array.isArray(record.titles) ? record.titles : []), restorable: Boolean(cards && cards.length) };
        });
        return { json: { records, file: '本机（离线版存在手机浏览器存储里）' } };
      }
      case '/api/history/item': {
        const stamp = Number(url.searchParams.get('t'));
        const record = historyRead(500).find(item => Number(item.t) === stamp);
        if (!record) throw Error('找不到这条历史记录（可能已被新的记录挤出去了）。');
        return { json: { record: { ...record, restorable: Array.isArray(record.cards) && record.cards.length > 0 } } };
      }
      case '/api/history/card': {
        const stamp = Number(payload.t);
        const index = Number(payload.index);
        const issue = SHARED.cardIssue(payload.card);
        if (issue) throw Error(`不接受的卡片格式：${issue}`);
        if (!Number.isInteger(index) || index < 0) throw Error('卡片序号不对。');
        let titles = null;
        const found = historyUpdate(stamp, record => {
          const cards = Array.isArray(record.cards) ? record.cards : [];
          if (index >= cards.length) return;
          cards[index] = payload.card;
          record.cards = cards;
          Object.assign(record, countTypes(cards));
          record.revised = (Number(record.revised) || 0) + 1;
          record.revisedAt = Date.now();
          titles = cardTitles(cards);
        });
        if (!found || !titles) throw Error('找不到这条历史记录（可能已被新的记录挤出去了）。');
        return { json: { ok: true, titles } };
      }
      case '/api/seen': {
        return { json: { seen: seenRead(), limit: SEEN_LIMIT } };
      }
      /* 以下端点依赖服务器或联网检索，离线版明确拒绝（给出可操作的中文提示，而不是装作成功） */
      case '/api/sync': throw Error('离线版不用在这里同步：卡片已经直接进 AnkiDroid，同步由 AnkiDroid 自己完成。');
      case '/api/research': {
        const result = await SHARED.runResearch({
          transport: request => nativeCall('httpRequest', request),
          subject: promptSubject(),
          data: payload,
          searchKey: searchKey(),
          searchProvider: payload.searchProvider,
          searchUrl: String(payload.searchUrl || '').trim() || undefined
        });
        return { json: result };
      }
      case '/api/search': {
        const query = String(payload.query || '').trim();
        if (!query) throw Error('请输入检索关键词。');
        const key = searchKey();
        const provider = SHARED.resolveProvider(payload.searchProvider).id;
        const chosen = SHARED.resolveProvider(provider).provider;
        if (chosen.needsKey !== false && !key) throw Error(`未配置联网检索 Key：请在「联网调研」里填 ${chosen.keyLabel}（只保存在本机）。`);
        const result = await SHARED.searchOnce({
          transport: request => nativeCall('httpRequest', request),
          subject: promptSubject(),
          key,
          query,
          maxResults: payload.maxResults,
          channel: payload.channel,
          provider,
          url: String(payload.searchUrl || '').trim() || undefined
        });
        return { json: result };
      }      case '/api/fetch': {
        const target = String(payload.url || '').trim();
        if (!/^https?:\/\//i.test(target)) throw Error('无效的链接。');
        // Jina 中转可自定义（真机反馈：手机网络到不了 r.jina.ai，与 searchUrl 同一个思路）
        const jina = String(payload.jinaBase || SHARED.JINA_DEFAULT).trim().replace(/\/+$/, '') + '/';
        const hint = `若手机网络到不了 ${jina.replace(/\/$/, '')}，可在「联网调研」里填「Jina 中转地址」后重试，或直接点标题打开原链接。`;
        let response;
        try {
          response = await nativeCall('httpRequest', { url: jina + target, method: 'GET', headers: {} });
        } catch (error) {
          throw Error(`抓取原文失败：${error.message}。${hint}`);
        }
        if (Number(response.status) >= 400) throw Error(`抓取原文失败（HTTP ${response.status}），该站可能限制抓取或需要登录。${hint}`);
        const text = SHARED.cleanFetchedText(response.body);
        return { json: { url: target, length: text.length, content: text.slice(0, SHARED.fetchLimit(payload.limit)), suspicious: SHARED.frameNoiseCount(text) >= 3 } };
      }
      case '/api/backup': {
        const built = await localBackup(payload && payload.settings);
        historyAppend({ kind: 'backup', bytes: built.bytes.length });
        return { bytes: built.bytes, filename: built.filename, type: 'application/zip' };
      }
      case '/api/backup/restore': {
        if (!payload || typeof payload.data !== 'string' || !payload.data) throw Error('恢复包内容为空。');
        const result = await localRestore(payload.data);
        historyAppend({ kind: 'restore', packs: 0, history: result.history });
        return { json: result };
      }
      case '/api/diagnose': {
        const report = await localDiagnose();
        return { bytes: new TextEncoder().encode(JSON.stringify(report, null, 2)), filename: `cardflow-diagnose-${apkgStamp()}.json`, type: 'application/json' };
      }
      default: { const error = new Error('接口不存在。'); error.status = 404; throw error; }
    }
  }

  /* ===== fetch 接管 ===== */
  function makeResponse(body, status, headers) {
    if (typeof Response === 'function') return new Response(body, { status, headers });
    // 极旧的 WebView 里没有 Response：给一个够用的替身（app.js 只用 json/text/blob/status/ok/headers.get）
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: name => headers[String(name).toLowerCase()] || null },
      json: async () => JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)),
      text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
      blob: async () => new Blob([body], { type: headers['content-type'] || 'application/octet-stream' })
    };
  }

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    const raw = typeof input === 'string' ? input : (input && input.url) || '';
    let parsed = null;
    try { parsed = new URL(raw, location.href); } catch (_) { parsed = null; }
    if (!parsed || !parsed.pathname.startsWith('/api/')) {
      if (originalFetch) return originalFetch(input, init);
      return Promise.reject(new Error('离线版没有网络请求能力。'));
    }
    const pathname = parsed.pathname;
    const method = String((init && init.method) || 'GET').toUpperCase();
    let payload = {};
    if (init && init.body) {
      try { payload = JSON.parse(init.body); } catch (_) { payload = {}; }
    }
    return route(pathname, parsed, method, payload).then(result => {
      if (result.bytes) {
        const headers = { 'content-type': result.type || 'application/octet-stream', 'content-disposition': `attachment; filename="${result.filename}"` };
        return makeResponse(result.bytes, 200, headers);
      }
      return makeResponse(JSON.stringify(result.json === undefined ? {} : result.json), 200, { 'content-type': 'application/json' });
    }).catch(error => {
      const status = error.status || 400;
      return makeResponse(JSON.stringify({ error: error.message || String(error) }), status, { 'content-type': 'application/json' });
    });
  };

  window.CardFlowLocal = true;                       // app.js / 页面据此知道自己在离线壳里
  window.CardFlowLocalApi = { route, nativeCall, hasNative, historyRead, seenRead };
})();
