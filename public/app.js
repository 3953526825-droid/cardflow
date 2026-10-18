const byId = id => document.getElementById(id);
/* ===== 学科配置（服务器注入 window.__SUBJECT__；缺省值让脚本单独加载时也能跑）===== */
const SUBJECT = window.__SUBJECT__ || {};
const subjectName = (key, fallback) => (SUBJECT[key] === undefined || SUBJECT[key] === null ? fallback : SUBJECT[key]);
/** API 前缀：多学科模式下是 /<学科id>，单学科模式下是空串。 */
const api = p => String(subjectName('base', '')) + p;
/** 模式控件的 DOM id / 提交给服务端的字段名（由 subjects/<id>.json 的 cardMode 决定）。 */
const cardModeControl = () => subjectName('cardModeControl', 'clozeWeight');
const cardModeField = () => subjectName('cardModeField', 'clozeWeight');
/** 预览按钮：previewNormalizes 为 true 的学科先按 Anki MathJax/mhchem 规则标准化公式。 */
const previewNormalizes = () => Boolean(subjectName('previewNormalizes', false));
/** 学科切换器的选择记在这里（页面加载时只回填、不自动跳转）。 */
const SUBJECT_STORE = 'ankiCardMaker.subject';
/* 已保存的口令与配置必须和原来用同一批键名，换键会让用户重输口令、丢配置。 */
let STORE = subjectName('storageKey', 'cardflow.demo.v1');
let TOKEN_KEY = subjectName('tokenKey', 'cardflow.demo.token');
/* 下面这几个常量必须声明在文件顶部：启动代码（startApp → getToken）会用到它们，
   写在文件中部会踩「Cannot access before initialization」（函数声明会提升，const 不会）。 */
const TOKEN_COOKIE = 'ankiToken';

let savedApiUrl = '', savedModel = '';
let serverModel = '';   // 服务端 config 里配的模型（自动拉模型列表时优先选它）
const state = { images: [], documents: [], readingFiles: false, decks: [], selectedDeck: '', historyStamp: 0, groupExample: null };
let busy = false, hasResult = false, importedOnce = false;
/* generatedOnce：这一批是本页生成出来的（真机反馈：生成完成后「生成卡片」按钮还亮着，用户会再点一次白花钱）。
   生成成功置 true（按钮置灰，只剩「重试这张 / 重试生成」），导入成功或刷新页面才恢复。 */
let generatedOnce = false;
function syncActionButtons() { const gen = byId('generate'), retry = byId('retry'), imp = byId('import'); if (gen) gen.disabled = busy || generatedOnce; if (retry) retry.disabled = busy || !hasResult; if (imp) imp.disabled = busy || importedOnce; syncDeckDeleteButton(); }
function markJsonEdited() { importedOnce = false; hasResult = !!byId('json').value.trim(); syncActionButtons(); }
function setStatus(text, kind = 'ok') { byId('status').textContent = text; const top = byId('topStatus'); top.textContent = text; top.className = `topStatus ${kind}`; showToast(text, kind); }
function showResults() { byId('resultBox').open = true; byId('resultBox').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
/** 卡片已经写进 Anki 之后把结果面板折起来：一屏几十张 DOM 卡片 + 图片位图很占内存，手机滑动就发涩。
    折起来不丢任何东西（JSON 和卡片都还在），点标题栏就能一键展开 —— <details> 自带这个开关，不用另加按钮。 */
function collapseResultBox() {
  const box = byId('resultBox');
  if (!box) return false;
  box.open = false;
  return true;
}
/* ===== 卡片类型勾选 / 自动分层导入：这三个取值函数是「唯一入口」，
   saveConfig / generateBody / importCards 都从这里拿，避免三处各写一遍、口径不一致。 ===== */
/** 已勾选的卡片类型；页面上没有这组控件时返回 null（= 不限制类型，服务端按全部类型处理）。 */
function enabledCardTypes() {
  const nodes = [...document.querySelectorAll('.cardType')];
  if (!nodes.length) return null;
  return new Set(nodes.filter(node => node.checked === true).map(node => node.value));
}
/** 是否开启「按内容自动创建子牌组并分层导入」（页面没这个控件时视作关闭）。 */
function autoGroupEnabled() { const box = byId('autoGroup'); return Boolean(box && box.checked === true); }
/** 分组规则文本（给 AI 的说明，服务端不解析它，只写进提示词）。 */
function groupRuleText() { const input = byId('groupRule'); return input ? String(input.value || '').trim() : ''; }
/** 「本次额外生成规则」文本：非空时允许零图片/零文档直接生成（用户 task7）。 */
function extraRulesText() { const box = byId('extraRules'); return box ? String(box.value || '').trim() : ''; }
/** 是否有图片/资料，或写了「本次额外生成规则」——任一满足即可生成。 */
function canGenerateWithoutMaterial() { return state.images.length > 0 || state.documents.length > 0 || Boolean(extraRulesText()); }
/** 预览是否切到「分组视图」：必须先勾「自动分层导入」，再看这个开关。 */
function groupPreviewEnabled() { const box = byId('groupPreview'); return autoGroupEnabled() && Boolean(box && box.checked === true); }
/** 只有开了「自动分层」才显示「按分组预览」开关；关掉自动分层时顺手把分组视图关掉。 */
function syncGroupPreviewRow() {
  const row = byId('groupPreviewRow'), box = byId('groupPreview');
  if (!row) return;
  const on = autoGroupEnabled();
  row.hidden = !on;
  if (!on && box) box.checked = false;
}
function saveConfig() {
  // 先读回已有的键：老模板 / 无控件环境下没读过来的字段（如 enabledTypes）不能被整块覆盖掉
  let previous = {};
  try { previous = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (_) { previous = {}; }
  const types = enabledCardTypes();
  const modeControl = byId(cardModeControl());
  const payload = { ...previous, apiUrl: byId('apiUrl').value, apiKey: byId('apiKey').value, model: byId('model').value, selectedDeck: state.selectedDeck, minCards: byId('minCards').value, maxCards: byId('maxCards').value, imgQuality: byId('imgQuality').value, autoSync: autoSyncEnabled(), extraRules: byId('extraRules').value, autoGroup: autoGroupEnabled(), groupRule: groupRuleText(), deepThinking: byId('deepThinking') ? byId('deepThinking').checked : false };
  if (types) payload.enabledTypes = [...types];
  if (modeControl) payload[cardModeField()] = modeControl.value;
  localStorage.setItem(STORE, JSON.stringify(payload));
}
function addModel(id) { const select = byId('model'); if (![...select.options].some(x => x.value === id)) { const option = document.createElement('option'); option.value = id; option.textContent = id; select.append(option); } select.value = id; }
function restoreConfig() { try { const data = JSON.parse(localStorage.getItem(STORE) || '{}'); savedApiUrl = data.apiUrl || ''; savedModel = data.model || ''; if (data.apiUrl) byId('apiUrl').value = data.apiUrl; if (data.model) addModel(data.model); if (data.apiKey) byId('apiKey').value = data.apiKey; if (data.minCards) byId('minCards').value = data.minCards; if (data.maxCards) byId('maxCards').value = data.maxCards; if (data[cardModeField()] && byId(cardModeControl())) byId(cardModeControl()).value = data[cardModeField()]; if (Array.isArray(data.enabledTypes)) document.querySelectorAll('.cardType').forEach(x=>{x.checked=data.enabledTypes.includes(x.value);}); if (byId('autoGroup')) byId('autoGroup').checked=data.autoGroup===true; if (byId('groupRule')) byId('groupRule').value=data.groupRule||''; if (data.extraRules) byId('extraRules').value = data.extraRules; if (byId('deepThinking')) byId('deepThinking').checked = data.deepThinking === true; if (data.imgQuality && IMG_PRESETS[data.imgQuality]) byId('imgQuality').value = data.imgQuality; byId('autoSync').checked = data.autoSync !== false; if (data.selectedDeck) chooseDeck(data.selectedDeck, false); } catch (_) { /* 本地没记录就留空，等服务端配置回来再填 */ } }
async function request(url, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  const token = getToken();
  if (token) opts.headers['x-anki-token'] = token;
  const response = await fetch(url, opts);
  const data = await response.json().catch(() => ({}));
  // 把状态码挂在错误上：调用方要区分「口令错(401)」和「服务/网络出问题」时得看得到（submitToken 就靠它）。
  if (response.status === 401) { showTokenGate('口令不正确，请重新输入。'); throw Object.assign(new Error(data.error || '未授权'), { status: 401 }); }
  if (!response.ok || data.error) throw Object.assign(new Error(data.error || '请求失败'), { status: response.status });
  return data;
}
async function checkAnki() {
  try {
    const data = await request(api('/api/health'));
    // 手机版根本没有 AnkiConnect，走的是 AnkiDroid 的 ContentProvider 直连；
    // 以前一律报「AnkiConnect 已连接，版本：AnkiDroid 直连」，真机上很误导。
    const version = String(data.version || '');
    const viaAnkiDroid = Boolean(window.CardFlowLocal) || /AnkiDroid/i.test(version);
    // 版本号能通不代表集合能用（两个 Anki 抢 8765 时就是这样），服务端体检会一并回报
    if (data.collection === false) return setStatus(`${viaAnkiDroid ? 'AnkiDroid' : 'AnkiConnect'} 已连接（版本 ${version}），但集合用不了：${data.collectionError || '请检查 Anki 是否只开了一个'}`, 'error');
    setStatus(viaAnkiDroid ? `AnkiDroid 直连正常${version && !/AnkiDroid/i.test(version) ? `（${version}）` : ''}` : `AnkiConnect 已连接，版本：${version}`);
  } catch (error) { setStatus(`${window.CardFlowLocal ? 'AnkiDroid' : 'AnkiConnect'} 未连接：${error.message}`, 'error'); }
}
function treeFromDecks(decks) { const root = {}; decks.forEach(deck => { let node = root, full = ''; deck.split('::').forEach(part => { full = full ? `${full}::${part}` : part; node[part] ||= { full, children: {} }; node = node[part].children; }); }); return root; }
function renderTreeNode(node) { const box = document.createElement('div'); Object.entries(node).sort(([a],[b]) => a.localeCompare(b, 'zh-CN')).forEach(([name, entry]) => { const childCount = Object.keys(entry.children).length; if (childCount) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = name; summary.title = `${entry.full}（双击选择此父级牌组）`; summary.ondblclick = event => { event.preventDefault(); chooseDeck(entry.full); }; details.append(summary, renderTreeNode(entry.children)); box.append(details); } else { const button = document.createElement('button'); button.className = `leaf ${entry.full === state.selectedDeck ? 'selected' : ''}`; button.textContent = name; button.title = entry.full; button.onclick = () => chooseDeck(entry.full); box.append(button); } }); return box; }
function renderDeckTree() { const query = byId('deckFilter').value.trim().toLowerCase(); const decks = query ? state.decks.filter(deck => deck.toLowerCase().includes(query)) : state.decks; const tree = byId('deckTree'); tree.innerHTML = ''; if (!decks.length) { tree.textContent = '没有匹配的牌组'; return; } tree.append(renderTreeNode(treeFromDecks(decks))); }
function chooseDeck(deck, close = true) { state.selectedDeck = deck; byId('selectedDeck').textContent = deck || '尚未选择'; if (close) byId('deckBox').open = false; saveConfig(); renderDeckTree(); syncDeckDeleteButton(); }
async function loadDecks() { try { const data = await request(api('/api/decks')); state.decks = data.decks || []; renderDeckTree(); renderDeckParents(); setStatus(`已读取 ${state.decks.length} 个牌组。叶子牌组单击选择；父级牌组双击选择。`); } catch (error) { setStatus(`无法读取 Anki 牌组：${error.message}`); } }
async function loadModels(options = {}) {
  // silent：首次进页面自动拉一次真实模型列表，不打扰用户、也不刷状态栏
  const silent = Boolean(options && options.silent === true);
  const apiUrl = byId('apiUrl').value.trim(), apiKey = byId('apiKey').value.trim();
  const prefer = serverModel || byId('model').value;
  try {
    if (!silent) setStatus('正在获取模型列表……', 'busy');
    const data = await request(api('/api/models'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: apiUrl, key: apiKey || undefined }) });
    const models = Array.isArray(data.models) ? data.models : [];
    if (!models.length) throw new Error('没有拿到模型列表');
    byId('model').innerHTML = '';
    models.forEach(addModel);
    if (prefer && models.includes(prefer)) byId('model').value = prefer;
    saveConfig();
    if (!silent) setStatus(`已读取 ${models.length} 个模型。`);
  } catch (error) {
    if (!silent) setStatus(`无法获取模型：${error.message}。可保留或手动填写模型。`, 'error');
  }
}
/* ===== 图片预处理：仅在必要时降采样，尽量保住小字 =====
   默认档位就是原来的参数（长边 2400px / JPEG 0.92 / 原图小于 1.2MB 且不超长边就不重压），
   其它档位只是给「省流量」和「更清晰」用的；选完存在本机浏览器里。
   注：这段必须放在文件靠前的位置，顶层代码（syncImagePresetSelect）会在加载时读 IMG_PRESETS。 */
const IMG_MAX_EDGE = 2400;
const IMG_QUALITY = 0.92;
const IMG_SKIP_BYTES = 1200 * 1024;
/* 只有这一套压缩档位（以前还有文档队列里的「文档压缩」和设置里的「文档图像清晰度」，
   两套都没人读或只影响 PDF，真机上是「调了没变化」的依据）。图片和 PDF 页面现在共用它。 */
const IMG_PRESETS = {
  tiny: { label: '省流最小（长边 1024px · 质量 0.60）', maxEdge: 1024, quality: 0.60, skipBytes: 400 * 1024 },
  small: { label: '小图（长边 1600px · 质量 0.70）', maxEdge: 1600, quality: 0.70, skipBytes: 700 * 1024 },
  medium: { label: '偏小（长边 2400px · 质量 0.80）', maxEdge: 2400, quality: 0.80, skipBytes: 1000 * 1024 },
  sharp: { label: '偏清晰（长边 2400px · 质量 0.85）', maxEdge: 2400, quality: 0.85, skipBytes: 1100 * 1024 },
  standard: { label: `标准（长边 ${IMG_MAX_EDGE}px · 质量 ${IMG_QUALITY}）`, maxEdge: IMG_MAX_EDGE, quality: IMG_QUALITY, skipBytes: IMG_SKIP_BYTES },
  large: { label: '更清晰（长边 3200px · 质量 0.92）', maxEdge: 3200, quality: 0.92, skipBytes: 2 * 1024 * 1024 },
  raw: { label: '不压缩（原图上传，更慢更贵）', maxEdge: 0, quality: 1, skipBytes: Infinity }
};
function imagePresetKey() {
  const select = byId('imgQuality');
  const value = select ? String(select.value || '') : '';
  return IMG_PRESETS[value] ? value : 'standard';
}
function imagePreset() { return IMG_PRESETS[imagePresetKey()]; }
/** 把档位下拉框填上（文案只在 IMG_PRESETS 里写一份）。 */
function syncImagePresetSelect() {
  const select = byId('imgQuality');
  if (!select) return;
  select.innerHTML = '';
  Object.entries(IMG_PRESETS).forEach(([key, preset]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = preset.label;
    select.append(option);
  });
  select.value = imagePresetKey();
}
/** 已经压过的直接复用，避免生成时白压一次。 */
async function ensureCompressed(image) {
  if (!image.prepared) image.prepared = await compressImage(image.file);
  return image.prepared;
}
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
}
function loadImage(src) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
}
async function compressImage(file) {
  const preset = imagePreset();
  const original = await readAsDataUrl(file);
  if (typeof original !== 'string' || !original.startsWith('data:image/')) return { data: original, saved: 0 };
  if (!preset.maxEdge) return { data: original, saved: 0 };
  let img;
  try { img = await loadImage(original); } catch (_) { return { data: original, saved: 0 }; }
  const width = img.naturalWidth || img.width, height = img.naturalHeight || img.height;
  const longEdge = Math.max(width, height);
  if (!longEdge) return { data: original, saved: 0 };
  if (longEdge <= preset.maxEdge && file.size <= preset.skipBytes) return { data: original, saved: 0, longEdge };
  const scale = longEdge > preset.maxEdge ? preset.maxEdge / longEdge : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const output = canvas.toDataURL('image/jpeg', preset.quality);
  if (!output || output.length >= original.length) return { data: original, saved: 0, longEdge, before: file.size, after: file.size, skipped: true };
  const after = dataUrlBytes(output);
  return { data: output, saved: original.length - output.length, longEdge: Math.round(longEdge * scale), before: file.size, after, longEdgeBefore: longEdge };
}

/* ===== 选完图就把「压缩后的效果」摆出来：缩略图直接换成实际要上传的那一张 ===== */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
/** base64 长度 → 字节数（只用于展示，取近似值就够） */
function dataUrlBytes(data) {
  const text = String(data || '');
  const comma = text.indexOf(',');
  return Math.round((comma >= 0 ? text.length - comma - 1 : text.length) * 3 / 4);
}
function thumbChipText(image) {
  if (image.compressError) return '读取失败';
  if (image.summary) return image.summary;
  if (!image.prepared) return '压缩中……';
  const before = Number(image.file && image.file.size) || 0;
  const after = dataUrlBytes(image.prepared.data);
  const edge = image.prepared.longEdge ? ` · 长边 ${image.prepared.longEdge}px` : '';
  if (!Number(image.prepared.saved)) return `无需压缩 · ${formatBytes(after)}${edge}`;
  const percent = before ? Math.round((1 - after / before) * 100) : 0;
  return `省 ${percent}% · ${formatBytes(after)}${edge}`;
}
/** 缩略图显示压缩后的那张；还没算完先用原图顶着，避免空白。 */
function thumbSrc(image) { return image.thumb || (image.prepared && image.prepared.data) || image.url; }
/** 上移 / 下移一张图：直接改 state.images 的顺序（这就是发给 AI 的顺序），带序号角标。 */
function moveImage(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.images.length) return;
  const [image] = state.images.splice(index, 1);
  state.images.splice(target, 0, image);
  redrawImages();
  updateImageSummary();
}
function redrawImages() {
  const area = byId('thumbs');
  area.innerHTML = '';
  state.images.forEach((image, index) => {
    const item = document.createElement('div');
    item.className = 'thumb';
    // 序号角标：一眼看清发给 AI 的顺序
    const order = document.createElement('div');
    order.className = 'thumbOrder';
    order.textContent = String(index + 1);
    order.style.cssText = 'position:absolute;left:3px;top:3px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#2269d1;color:#fff;font-size:11px;line-height:16px;text-align:center;font-weight:700;pointer-events:none';
    const img = document.createElement('img');
    img.src = thumbSrc(image);
    img.alt = `教材图片 ${index + 1}`;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.title = '点击查看压缩后的效果';
    img.onclick = () => openImagePreview(index);
    const chip = document.createElement('div');
    chip.textContent = thumbChipText(image);
    chip.style.cssText = 'position:absolute;left:3px;right:3px;bottom:3px;padding:1px 4px;border-radius:6px;background:rgba(10,26,42,.74);color:#fff;font-size:10px;line-height:1.35;text-align:center;pointer-events:none';
    const remove = document.createElement('button');
    remove.title = '移除';
    remove.textContent = '×';
    remove.onclick = () => { URL.revokeObjectURL(image.url); state.images.splice(index, 1); redrawImages(); updateImageSummary(); };
    item.append(img, order, remove, chip);
    if (state.images.length > 1) {
      const bar = document.createElement('div');
      bar.className = 'thumbMove';
      bar.style.cssText = 'position:absolute;right:3px;top:3px;display:flex;flex-direction:column;gap:2px';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'thumbUp';
      up.title = '上移（缩小序号＝排在前面）';
      up.textContent = '▲';
      up.style.cssText = 'width:22px;height:20px;min-width:0;min-height:0;padding:0;font-size:10px;line-height:1;border-radius:6px';
      up.disabled = index === 0;
      up.onclick = () => moveImage(index, -1);
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'thumbDown';
      down.title = '下移（放大序号＝排在后面）';
      down.textContent = '▼';
      down.style.cssText = 'width:22px;height:20px;min-width:0;min-height:0;padding:0;font-size:10px;line-height:1;border-radius:6px';
      down.disabled = index === state.images.length - 1;
      down.onclick = () => moveImage(index, 1);
      bar.append(up, down);
      item.append(bar);
    }
    area.append(item);
  });
}
/** 状态栏总结：每张图的「原 → 压后，省多少 · 长边多少」都摆出来（不再只给一个合计）。 */
function updateImageSummary() {
  if (!state.images.length) return;
  const done = state.images.filter(image => image.prepared);
  if (done.length < state.images.length) return setStatus(`已添加 ${state.images.length} 张图片，正在按「${imagePreset().label}」生成压缩预览……`, 'busy');
  const failed = state.images.filter(image => image.compressError).length;
  const detail = image => {
    const before = Number(image.file && image.file.size) || 0;
    const after = dataUrlBytes(image.prepared.data);
    const edge = image.prepared.longEdge ? `，长边 ${image.prepared.longEdge}px` : '';
    const edgeChip = image.prepared.longEdge ? ` · 长边 ${image.prepared.longEdge}px` : '';
    if (!Number(image.prepared.saved)) {
      image.summary = `无需压缩 · ${formatBytes(after)}${edgeChip}`;
      return `${formatBytes(after)} 未重压${edge}`;
    }
    const percent = before ? Math.round((1 - after / before) * 100) : 0;
    image.summary = `省 ${percent}% · ${formatBytes(after)}${edgeChip}`;
    return `${formatBytes(before)} → ${formatBytes(after)}（省 ${percent}%${edge}）`;
  };
  const shown = done.slice(0, 2).map(detail).join('；');
  const more = done.length > 2 ? `；另 ${done.length - 2} 张同档位` : '';
  const before = done.reduce((sum, image) => sum + (Number(image.file && image.file.size) || 0), 0);
  const after = done.reduce((sum, image) => sum + dataUrlBytes(image.prepared.data), 0);
  if (!before) return setStatus(`共 ${state.images.length} 张图片${failed ? `，${failed} 张读取失败` : ''}。`, failed ? 'warn' : 'ok');
  const total = before > after ? `合计 ${formatBytes(before)} → ${formatBytes(after)}（省 ${Math.round((before - after) / before * 100)}%）` : `合计 ${formatBytes(after)}`;
  return setStatus(`共 ${state.images.length} 张图片：${shown}${more}。${total}${failed ? `，${failed} 张读取失败` : ''}。`, failed ? 'warn' : 'ok');
}
/** 缩略图用的小图（长边 360px）：直接拿 2400px 的压缩图当缩略图，浏览器要为每张解出十几 MB 的位图，
    手机上内存一紧就会卡。大图预览仍然用完整的那张。 */
async function makeThumb(dataUrl, maxEdge = 360) {
  try {
    const img = await loadImage(dataUrl);
    const width = img.naturalWidth || img.width, height = img.naturalHeight || img.height;
    const long = Math.max(width, height);
    if (!long) return '';
    // 本来就不大（比如原图才 400px）就不用再画一张，直接拿压缩后那张当缩略图
    if (long <= maxEdge * 1.5) return '';
    const scale = long > maxEdge ? maxEdge / long : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch (_) { return ''; }
}
/** 选图后立刻按当前档位压一遍：既是为了预览，也让生成时不用再压第二次。 */
async function prepareImagePreview(image) {
  try {
    image.summary = '';            // 换档位重压时旧标签作废，否则缩略图还挂着上一次的大小
    image.prepared = await compressImage(image.file);
    image.compressError = false;
    image.thumb = await makeThumb(image.prepared && image.prepared.data);
    // 缩略图与大图预览都不再需要原始 blob：释放掉省一份内存
    if (image.url) { try { URL.revokeObjectURL(image.url); } catch (_) {} image.url = ''; }
  } catch (_) {
    image.prepared = null;
    image.compressError = true;
  }
  redrawImages();
  updateImageSummary();
}
/** 换档位后把已选的图重新算一遍（预览跟着变）。 */
function recompressAllImages() {
  state.images.forEach(image => { image.prepared = null; image.summary = ''; image.compressError = false; });
  redrawImages();
  updateImageSummary();
  return Promise.all(state.images.map(prepareImagePreview));
}

function sourceText(){return state.documents.map(d=>'【资料：'+d.name+'】\n'+d.text).join('\n\n');}
function renderSourceFiles(){const box=byId('sourceFiles');if(!box)return;box.replaceChildren();state.documents.forEach((d,i)=>{const row=document.createElement('div');row.className='sourceFile';const label=document.createElement('span');label.textContent=d.name+' · '+d.text.length+' 字';const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='移除';remove.onclick=()=>{state.documents.splice(i,1);renderSourceFiles();};row.append(label,remove);box.append(row);});}
async function addFiles(files){
 if(state.readingFiles||busy)return setStatus('正在处理文件或生成，请稍候。','busy');
 state.readingFiles=true;const errors=[];
 try{for(const file of [...files]){if(!file)continue;if(file.type.startsWith('image/')){addImages([file]);continue;}
  try{setStatus('正在解析 '+file.name+'……','busy');const r=await window.CardFlowFiles.parse(file);if(sourceText().length+r.text.length>100000)throw Error('累计资料超过 10 万字，请移除部分文件。');if(r.text.trim())state.documents.push({name:file.name,text:r.text});if(r.images.length)addImages(r.images);renderSourceFiles();}catch(e){errors.push(file.name+'：'+e.message);}
 }setStatus(errors.length?errors.join('；'):'文件处理完成：'+state.images.length+' 张图片，'+state.documents.length+' 份文字资料。',errors.length?'error':'ok');}
 finally{state.readingFiles=false;}
}

function addImages(files) {
  const added = [...files]
    .filter(file => file && file.type.startsWith('image/'))
    .map(file => ({ file, url: URL.createObjectURL(file), prepared: null, compressError: false }));
  state.images.push(...added);
  redrawImages();
  if (!added.length) return setStatus('没有可用的图片（只接受图片文件）。', 'error');
  setStatus(`已添加 ${state.images.length} 张图片，正在按「${imagePreset().label}」生成压缩预览……`, 'busy');
  added.forEach(prepareImagePreview);
}
/* ===== 大图预览：看的就是压缩后的那张（点图可切换 适应屏幕 / 100%） ===== */
let imagePreviewZoomed = false;
/** 导入成功后把「完整压缩图」从内存里放掉：页面只留 360px 缩略图与原图句柄。
    需要再生成 / 再看大图时按需重压（几百毫秒），但内存能省下好几 MB/张 —— 真机上的卡顿主要就来自这里。 */
function releaseCompressedData() {
  state.images.forEach(image => {
    if (!image.prepared) return;
    image.summary = thumbChipText(image); // 先缓存大小标签文字，释放后缩略图标签不变
    image.prepared = null;
  });
}
async function openImagePreview(index) {
  const image = state.images[index];
  const box = byId('imagePreview');
  if (!image || !box) return;
  imagePreviewZoomed = false;
  const img = byId('imagePreviewImg');
  // 大图先用小缩略图顶着，完整那张按需重压（内存里不再长期占着）
  if (img) { img.src = image.thumb || image.url || ''; img.style.maxWidth = '100%'; }
  const before = Number(image.file && image.file.size) || 0;
  const after = dataUrlBytes(image.prepared && image.prepared.data);
  const parts = [`第 ${index + 1} / ${state.images.length} 张`, `档位：${imagePreset().label}`];
  if (image.prepared && image.prepared.longEdge) parts.push(`长边 ${image.prepared.longEdge}px`);
  parts.push(before ? `原图 ${formatBytes(before)} → 上传 ${formatBytes(after)}` : `上传 ${formatBytes(after)}`);
  const info = byId('imagePreviewInfo');
  if (info) info.textContent = parts.join(' · ');
  box.hidden = false;
  try {
    const full = await ensureCompressed(image);
    if (img && full && full.data) img.src = full.data;
  } catch (_) { /* 压不出来就继续用缩略图顶着 */ }
}
function closeImagePreview() {
  const box = byId('imagePreview');
  if (box) box.hidden = true;
  const img = byId('imagePreviewImg');
  if (img) img.src = ''; // 放掉那张大图占的位图内存
}
function toggleImagePreviewZoom() {
  const img = byId('imagePreviewImg');
  if (!img) return;
  imagePreviewZoomed = !imagePreviewZoomed;
  img.style.maxWidth = imagePreviewZoomed ? 'none' : '100%';
}
/* ===== 同步到 AnkiWeb：手机上点一下，电脑上的 Anki 就把新卡推上去（不用碰电脑） ===== */
function autoSyncEnabled() { const box = byId('autoSync'); return !!(box && box.checked); }
let lastSyncAt = 0;
/** silent=true：不自己写状态栏，把结果交给调用方拼进更长的消息里。 */
async function syncAnki(options = {}) {
  const silent = options.silent === true;
  const button = byId('syncAnki');
  const label = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '同步中…'; }
  try {
    if (!silent) setStatus('正在让电脑上的 Anki 与 AnkiWeb 同步……', 'busy');
    const data = await request(api('/api/sync'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    lastSyncAt = Date.now();
    const message = `同步完成（${(Number(data.ms || 0) / 1000).toFixed(1)} 秒）：电脑已推到 AnkiWeb，手机上打开 Anki 同步一下就能看到新卡。`;
    if (!silent) setStatus(message, 'ok');
    return { ok: true, message };
  } catch (error) {
    const message = `同步失败：${error.message}`;
    if (!silent) setStatus(message, 'error');
    return { ok: false, message };
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
  }
}
function toDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }
const SEARCH_PROVIDER_KEY = 'cardflow.searchProvider';
/** Jina 中转地址记在本机（与检索服务商同一套思路，刷新/重开 App 都不丢）。 */
const JINA_URL_KEY = 'cardflow.jinaUrl';
/** 检索服务商：下拉里选了就用它，没选就按记在本机的来 */
function searchProviderValue() { const select = byId('searchProvider'); return select && select.value ? select.value : (localStorage.getItem(SEARCH_PROVIDER_KEY) || undefined); }
/** 自建实例 / 自建中转的接口地址（可留空） */
function searchUrlValue() { const input = byId('searchUrl'); return input && input.value.trim() ? input.value.trim() : undefined; }
/** Jina 中转地址（可留空）：手机网络到不了 r.jina.ai 时，在「联网调研」里填一个能到的中转。
    输入框里没填就用本机记下的；两处都空 = 用默认 r.jina.ai。 */
function jinaUrlValue() {
  const input = byId('jinaUrl');
  const typed = input && input.value.trim();
  if (typed) return typed;
  try { return localStorage.getItem(JINA_URL_KEY) || undefined; } catch (_) { return undefined; }
}
function cleanJson(value) { const text = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''); const obj = text.indexOf('{'), arr = text.indexOf('['); const useArray = arr >= 0 && (obj < 0 || arr < obj); const a = useArray ? arr : obj, b = useArray ? text.lastIndexOf(']') : text.lastIndexOf('}'); return a >= 0 && b >= a ? text.slice(a, b + 1) : text; }
function parsedCards() { const data = JSON.parse(cleanJson(byId('json').value)); if (Array.isArray(data)) return { cards: data }; const shared = window.CardFlowShared; return shared && shared.normalizeCards ? shared.normalizeCards(data) : data; }
/* ===== 调研补充的卡片：预览里直接标出来，不用你自己去翻标签核对 =====
   提示词要求「补充了图片之外内容」的卡片必须额外带“补充”标签（见 prompts/*.md），
   这里就按这个标记给左上角换琥珀色边框 + 盖一个「调研补充」徽章；不是靠标签显示，而是把它变成一眼能看见的东西。 */
const SUPPLEMENT_TAGS = ['补充', '调研补充'];
const SUPPLEMENT_BORDER = '4px solid #d9822b';
const SUPPLEMENT_BADGE_STYLE = 'display:inline-block;margin-left:6px;padding:1px 7px;border-radius:10px;background:#fff4e0;border:1px solid #d9822b;color:#8a4b00;font-size:11px;font-weight:700;vertical-align:1px';
function isSupplemented(card) {
  const tags = card && Array.isArray(card.tags) ? card.tags : [];
  return tags.some(tag => SUPPLEMENT_TAGS.includes(String(tag == null ? '' : tag).trim()));
}
function supplementBadgeNode() {
  const badge = document.createElement('span');
  badge.textContent = '调研补充';
  badge.style.cssText = SUPPLEMENT_BADGE_STYLE;
  return badge;
}
/** 状态栏里的“（其中 N 张为调研补充）”，没有补充就不多说。 */
function supplementNote(cards) {
  const count = (Array.isArray(cards) ? cards : []).filter(isSupplemented).length;
  return count ? `（其中 ${count} 张为调研补充）` : '';
}


/** 预览前的常见公式格式提示（普通卡/填空卡都可能踩到）。
 *  「裸公式」只有会做公式转换的学科（配了 postprocess / 勾了公式转换的学科包）才有意义：
 *  其它学科里 CO2、H2O 是普通文字，不该误报。 */
function formulaWarnings(cards) {
  // 直接从卡片文本拼，别用 JSON.stringify：JSON 会把 \( 转义成 \\(，公式检查正则就再也匹配不上。
  const list = Array.isArray(cards) ? cards : [];
  const raw = list.map(card => card ? [card.front, card.back, card.text, card.note].filter(Boolean).join('\n') : '').join('\n');
  const a = [];
  if (/\{\{c(?!1::)/.test(raw)) a.push('发现 c2/c3 等非 c1 填空。');
  if (previewNormalizes() && /\b(?:H2O|CO2|O2|H2|NaOH|HCl|SO4|OH)\b/.test(raw) && !/\\\(\\ce\{/.test(raw)) a.push('疑似有裸公式，建议检查。');
  return a;
}
/** 预览按行拼 DOM（不用 innerHTML），方便 MathJax 逐块排版。
 *  两个学科共用这一份：以前 app.js 里生物、化学各有一份同名 preview()，后者会把前者覆盖掉（生物那份成了死代码）。
 *  现在只有这一份，标题用 .cardTitle（两个学科都加粗）、备注用 .note。 */
function textLine(parent, text) {
  const n = document.createElement('div');
  n.textContent = text || '';
  parent.append(n);
  return n;
}

/* ===== 部分导入：每张卡单独勾选；格式有问题的自动不勾，不让一张坏卡拖累整批 =====
   校验规则与 src/server.js 的 cardIssue() 保持一致（改的时候两边一起改）。 */
function cardIssue(card) {
  if (!card || typeof card !== 'object') return '卡片不是对象';
  if (['audio','occlusion'].includes(card.type)) return window.CardFlowCore ? CardFlowCore.issue(card, { allowSynth: window.__TTS__ === true }) : '请刷新以载入新卡片类型';
  if (!['basic', 'cloze'].includes(card.type)) return '类型必须是 basic 或 cloze';
  if (card.type === 'basic' && (!(card.front || '').trim() || !(card.back || '').trim())) return '普通卡缺少正面或背面';
  if (card.type === 'cloze') {
    if (!(card.text || '').trim()) return '填空卡缺少文本';
    if (!/\{\{c1::.+?\}\}/.test(card.text) || /\{\{c(?!1::)/.test(card.text)) return '填空卡必须且只能使用 c1';
  }
  return '';
}
/** 手动取消勾选的序号（重画预览时保留选择）。 */
let excludedCards = new Set();
/** 单卡重试的待决结果：序号 → { previous, next, angle, random }；没采纳就不会覆盖。 */
const pendingRetries = new Map();
function cardSelected(index, card) { return !cardIssue(card) && !excludedCards.has(index); }
function selectedCount(cards) { return (Array.isArray(cards) ? cards : []).filter((card, index) => cardSelected(index, card)).length; }
/** 只换那一行汇总，不重建整份预览（勾选时手不会抖）。 */
function updateImportHint(cards) {
  const box = byId('cards');
  const line = box && box.querySelector ? box.querySelector('.pickSummary') : null;
  if (!line) return;
  const total = (Array.isArray(cards) ? cards : []).length;
  const picked = selectedCount(cards);
  line.textContent = `已勾选 ${picked} / ${total} 张会导入${picked < total ? '（没勾的不会发出去）' : ''}`;
}
/** 预览里的类型标签：与 shared/cards.js 的 CARD_TYPE_LABELS 同一份口径（shared 未加载时给兜底）。 */
const CARD_TYPE_LABELS = (window.CardFlowShared && window.CardFlowShared.CARD_TYPE_LABELS)
  || { basic: '普通卡', cloze: '填空卡', occlusion: '图像遮挡卡', audio: '音频卡' };
function pickRow(index, card, cards) {
  const row = document.createElement('div');
  row.className = 'cardTitle';
  row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'cardPick';
  pick.checked = cardSelected(index, card);
  pick.title = '取消勾选就跳过这张，不导入';
  pick.onchange = () => { if (pick.checked) excludedCards.delete(index); else excludedCards.add(index); updateImportHint(cards); };
  const title = document.createElement('span');
  // 类型标签查表：audio / occlusion 不再被标成「普通卡」（真机反馈）
  title.textContent = `${index + 1}. ${CARD_TYPE_LABELS[card.type] || '普通卡'} ${card.priority || ''}`;
  row.append(pick, title);
  return row;
}
function cardTools(index, card) {
  const row = document.createElement('div');
  row.className = 'cardTools';
  row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0 6px';
  const hint = document.createElement('input');
  hint.className = 'retryHint';
  hint.placeholder = '这张的修改方向（留空＝随机角度）';
  hint.style.cssText = 'flex:1;min-width:0;max-width:420px;font-size:12px;padding:4px 8px';
  const retry = document.createElement('button');
  retry.className = 'secondary cardRetry';
  retry.textContent = '重试这张';
  // 遮挡卡：重试也会按方向微调遮挡框（真机反馈「重试对遮挡不生效」——以前 masks 是固定回填的）
  retry.title = card.type === 'occlusion'
    ? '让 AI 只重写这一张（遮挡框也会按方向微调；也可以点「调整遮挡框」手动改）；新版会先和原版对照，采纳了才覆盖'
    : '让 AI 只重写这一张；新版会先和原版对照，采纳了才覆盖';
  retry.onclick = () => retryOneCard(index, hint.value, retry);
  row.append(hint, retry);
  return row;
}
function cardText(card) {
  if (!card) return '';
  const lines = [];
  if (card.type === 'cloze') { lines.push(`题干：${card.text || ''}`); if (card.note) lines.push(`备注：${card.note}`); }
  else { lines.push(`正面：${card.front || ''}`); lines.push(`背面：${card.back || ''}`); if (card.note) lines.push(`备注：${card.note}`); }
  return lines.join('\n');
}
/** 新旧对照 + 「采纳 / 保留」——覆盖前先让用户在两个版本之间权衡。 */
function compareBlock(index, pending) {
  const box = document.createElement('div');
  box.className = 'cardCompare';
  box.style.cssText = 'border:1px dashed #b9c6d4;border-radius:8px;padding:8px;margin:0 0 8px;background:rgba(251,253,255,.9)';
  const head = document.createElement('div');
  head.className = 'muted';
  head.textContent = `重试方向：${pending.angle}${pending.random ? '（你没填，这是随机挑的）' : ''}`;
  // 遮挡卡：遮挡框被重试改动时要说出来（文字对照里看不出框的变化）
  const masksBefore = Array.isArray(pending.previous && pending.previous.masks) ? pending.previous.masks.length : 0;
  const masksAfter = Array.isArray(pending.next && pending.next.masks) ? pending.next.masks.length : 0;
  const sameMasks = JSON.stringify((pending.previous && pending.previous.masks) || null) === JSON.stringify((pending.next && pending.next.masks) || null);
  if (pending.previous && pending.previous.type === 'occlusion' && !sameMasks) {
    head.textContent += `；遮挡框已调整：${masksBefore} → ${masksAfter} 个（采纳后可在预览里再手动微调）`;
  }
  const oldText = document.createElement('div');
  oldText.className = 'cardQuestion';
  oldText.textContent = `【原版】\n${cardText(pending.previous)}`;
  const newText = document.createElement('div');
  newText.className = 'cardAnswer';
  newText.textContent = `【新版】\n${cardText(pending.next)}`;
  box.append(head, oldText, newText);
  if (pending.issue) {
    const warn = document.createElement('div');
    warn.className = 'cardIssue';
    warn.style.cssText = 'color:#a33333;font-size:11px;font-weight:700;margin-top:4px';
    warn.textContent = `新版仍有格式问题：${pending.issue} —— 建议「保留原版」或换个方向再重试。`;
    box.append(warn);
  }
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px';
  const take = document.createElement('button');
  take.className = 'cardTake';
  take.textContent = '采纳新版（覆盖这张）';
  take.onclick = () => acceptRetry(index);
  const keep = document.createElement('button');
  keep.className = 'secondary cardKeep';
  keep.textContent = '保留原版';
  keep.onclick = () => { pendingRetries.delete(index); preview(); setStatus(`已保留第 ${index + 1} 张的原版，什么都没改。`); };
  actions.append(take, keep);
  box.append(actions);
  return box;
}
/** 重试单张：不记历史、不动其它卡片，先把新版拿回来给你比。 */
async function retryOneCard(index, guidance, button) {
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  let card;
  try { card = parsedCards().cards[index]; } catch (error) { return setStatus(`JSON 格式错误：${error.message}`, 'error'); }
  const issue = cardIssue(card);
  if (issue) return setStatus(`这张卡片格式有问题（${issue}）：先改好 JSON，或用「重试生成」整批重来。`, 'error');
  const label = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '重试中…'; }
  try {
    setStatus('正在让 AI 重写这一张（不记进历史、也不动其它卡片）……', 'busy');
    const data = await request(api('/api/card/retry'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: byId('apiUrl').value.trim(), key: byId('apiKey').value.trim() || undefined, model: byId('model').value, card, guidance: String(guidance || '').trim() })
    });
    pendingRetries.set(index, { previous: card, next: data.card, angle: data.angle, random: Boolean(data.random), issue: data.issue || '' });
    preview();
    setStatus(`第 ${index + 1} 张已重写（方向：${data.angle}${data.random ? '，随机挑的' : ''}）。新旧对照在卡片下方，采纳了才会覆盖。`, 'warn');
  } catch (error) {
    setStatus(`重试这一张失败：${error.message}`, 'error');
    if (button) { button.disabled = false; button.textContent = label; }
  }
}
/** 采纳新版：换掉当前 JSON 里这张，并把那条历史记录里的同一张一并覆盖。 */
async function acceptRetry(index) {
  const pending = pendingRetries.get(index);
  if (!pending) return;
  let data;
  try { data = parsedCards(); } catch (error) { return setStatus(`JSON 格式错误：${error.message}`, 'error'); }
  const cards = Array.isArray(data.cards) ? data.cards : [];
  if (index >= cards.length) return setStatus('卡片序号变了（JSON 好像被改过），请重新点「预览」。', 'error');
  cards[index] = pending.next;
  byId('json').value = JSON.stringify(data, null, 2);
  markJsonEdited();
  pendingRetries.delete(index);
  preview();
  const stamp = Number(state.historyStamp) || 0;
  if (!stamp) return setStatus(`第 ${index + 1} 张已换成新版（这批卡片没有对应的历史记录，只改了当前 JSON）。`, 'warn');
  try {
    await request(api('/api/history/card'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: stamp, index, card: pending.next }) });
    setStatus(`第 ${index + 1} 张已用新版覆盖：当前 JSON 和那条历史记录都更新了。`, 'ok');
  } catch (error) {
    setStatus(`第 ${index + 1} 张已覆盖当前 JSON，但历史记录更新失败：${error.message}`, 'warn');
  }
}
function preview() {
  try {
    const d = parsedCards(), cs = d.cards || [], out = byId('cards');
    out.replaceChildren();
    const summary = document.createElement('div');
    summary.className = 'muted pickSummary';
    summary.textContent = `已勾选 ${selectedCount(cs)} / ${cs.length} 张会导入`;
    out.append(summary);
    const checks = window.CardFlowCore ? CardFlowCore.quality(cs, CardFlowCore.settings(), seenQuestions()) : cs.map(()=>[]);
    const cardBlock = (i, c) => {
      const b = document.createElement('div'); b.className = 'card';
      const issue = cardIssue(c), supplemented = isSupplemented(c);
      if (supplemented) b.style.borderLeft = SUPPLEMENT_BORDER;
      if (issue) b.style.background = '#fff6f6';
      const head = pickRow(i, c, cs);
      if (supplemented) head.append(supplementBadgeNode());
      if (issue) {
        const warn = document.createElement('span');
        warn.className = 'cardIssue';
        warn.style.cssText = 'color:#a33333;font-size:11px;font-weight:700';
        warn.textContent = `格式有问题：${issue}（不会导入）`;
        head.append(warn);
      }
      b.append(head, cardTools(i, c));
      const pending = pendingRetries.get(i);
      if (pending) b.append(compareBlock(i, pending));
      const q = textLine(b, c.text || c.front || (c.type==='occlusion'?'识别图中遮挡部分':'')); q.className = 'cardQuestion';
      const hr = document.createElement('hr'); b.append(hr);
      // 遮挡卡不放文字答案（真机反馈：正反面都出现文字，全局规则也管不住）——背面就是下面那个
      // 「图片 + 可显示/隐藏遮挡」的框，与导入 Anki 后的模板（shared/media-note.js）同一口径。
      if (c.type !== 'occlusion') { const ans = textLine(b, c.type === 'cloze' ? (c.note || '') : (c.back || '')); ans.className = 'cardAnswer'; }
      if (c.note && c.type !== 'cloze') { const note = textLine(b, c.note); note.className = 'note'; }
      if (checks[i]?.length) { const w=textLine(b,checks[i].join('；'));w.className='qualityWarning'; }
      if (window.CardFlowCore && CardFlowCore.settings().showSources && (c.source || c.sourceCandidates)) { const src=textLine(b,'来源：'+JSON.stringify(c.source||c.sourceCandidates)+(c.source?'（AI 定位，需核对）':'（本批候选范围，未精确定位）'));src.className='sourceEvidence'; }
      if (c.type==='audio' && !cardIssue(c)) { if (c.audio) { const audio=document.createElement('audio');audio.controls=true;audio.src=c.audio;b.append(audio); } else { const hint=textLine(b,'语音会在导入时用本机语音自动合成（不需要模型提供音频）。'); hint.className='note'; } }
      if (c.type==='occlusion' && !cardIssue(c)) { const frame=document.createElement('div');frame.className='occlusionFrame';const img=document.createElement('img');img.src=c.image;frame.append(img);occlusionMaskNodes(frame,Array.isArray(c.masks)?c.masks:[]);const reveal=document.createElement('button');reveal.type='button';reveal.textContent='显示／隐藏答案';reveal.onclick=()=>frame.classList.toggle('revealed');const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='调整遮挡框';edit.onclick=()=>openMaskEditor(frame,c,i);b.append(frame,reveal,edit); }
      return b;
    };
    // 分组视图：勾了「自动分层」且打开「按分组预览」时，用与服务端导入同一套 SHARED.deckForCard
    // 算出每张卡的完整子牌组，按分组归类显示，并在组头上标出分组名与张数。
    if (groupPreviewEnabled()) {
      const shared = window.CardFlowShared;
      const cache = new Map();
      const parent = state.selectedDeck || '';
      const groups = new Map();
      cs.forEach((c, i) => {
        const deck = (shared && shared.deckForCard && parent) ? shared.deckForCard(c, parent, true, cache) : (parent || '（尚未选择父牌组）');
        if (!groups.has(deck)) groups.set(deck, []);
        groups.get(deck).push(i);
      });
      [...groups.entries()].forEach(([deck, indexes]) => {
        const h = document.createElement('div');
        h.className = 'groupHeader';
        h.style.cssText = 'margin:14px 0 4px;padding:7px 10px;border-radius:8px;background:rgba(34,105,209,.12);color:#2269d1;font-weight:700;font-size:13px';
        const childOnly = parent && deck.startsWith(parent + '::') ? deck.slice(parent.length + 2) : '';
        h.textContent = `${childOnly || '（不分组，直接进父牌组）'} · ${indexes.length} 张`;
        h.title = deck;
        out.append(h);
        indexes.forEach(i => out.append(cardBlock(i, cs[i])));
      });
    } else {
      cs.forEach((c, i) => out.append(cardBlock(i, c)));
    }
    const w = formulaWarnings(cs), extra = supplementNote(cs), bad = cs.filter(card => cardIssue(card)).length;
    const unchecked = selectedCount(cs) < cs.length - bad ? `，已取消勾选 ${cs.length - bad - selectedCount(cs)} 张` : '';
    const tail = `${bad ? `，${bad} 张格式有问题` : ''}${unchecked}`;
    // 0 张的时候要说清楚为什么：多半是模型把顶层写成了裸数组，或者外壳字段名不对
    const emptyHint = cs.length ? '' : '（上面这段 JSON 里没找到 cards 数组：顶层是数组、或者卡片列表换了字段名都行，只要改成一个数组就认）';
    if (w.length) setStatus(`预览完成：${cs.length} 张${extra}${tail}。⚠ ${w.join(' ')}`);
    else if (previewNormalizes()) setStatus(`预览完成：${cs.length} 张${extra}${tail}${emptyHint}；未发现常见公式格式问题。`);
    else setStatus(`预览完成：${cs.length} 张${extra}${tail}${emptyHint}。`);
    if (window.MathJax && MathJax.typesetClear) MathJax.typesetClear([out]);
    if (window.MathJax && MathJax.typesetPromise) MathJax.typesetPromise([out]);
  } catch (e) {
    setStatus(`JSON 格式错误：${e.message}`, 'error');
    showResults();
  }
}

/** 配了 postprocess 的学科：#preview 按钮先调 /api/normalize 标准化公式，再预览。 */
async function normalizeThenPreview() {
  try {
    setStatus('正在按 Anki MathJax/mhchem 规则标准化公式……', 'busy');
    const raw = parsedCards();
    const d = await request(api('/api/normalize'), {
      method: 'POST', headers: {
        'content-type': 'application/json'
      }, body: JSON.stringify(raw)
    });
    byId('json').value = JSON.stringify(d, null, 2);
    preview();
  } catch (e) {
    setStatus(`公式标准化失败：${e.message}`, 'error');
    showResults();
  }
}

/* ===== 预览：按学科配置分派（配了 postprocess 的先标准化公式）===== */
function runPreview() {
  return previewNormalizes() ? normalizeThenPreview() : preview();
}
/* ===== 分组示例图（可选）：只用来告诉 AI「按这张图的层级分」，不参与制卡 ===== */
async function setGroupExample(file) {
  const row = byId('groupExampleRow');
  const thumb = byId('groupExampleThumb');
  const info = byId('groupExampleInfo');
  if (!file) {
    state.groupExample = null;
    if (row) row.hidden = true;
    if (thumb) thumb.src = '';
    if (info) info.textContent = '';
    return;
  }
  if (!String(file.type || '').startsWith('image/')) {
    state.groupExample = null;
    if (row) row.hidden = true;
    setStatus('示例图必须是图片文件（png / jpg / webp）。', 'error');
    return;
  }
  setStatus('正在读取分组示例图……', 'busy');
  try {
    const prepared = await compressImage(file);
    state.groupExample = { name: String(file.name || '分组示例图'), data: prepared.data };
    if (thumb && prepared.data) thumb.src = prepared.data;
    if (info) info.textContent = `${state.groupExample.name} · ${formatBytes(dataUrlBytes(prepared.data))}`;
    if (row) row.hidden = false;
    setStatus('分组示例图已备好，会随下次生成一起发给 AI。');
  } catch (error) {
    state.groupExample = null;
    if (row) row.hidden = true;
    setStatus(`示例图读取失败：${error.message}`, 'error');
  }
}
function generateBody(images) {
  const body = {
    url: byId('apiUrl').value.trim(),
    key: byId('apiKey').value.trim() || undefined,
    model: byId('model').value,
    images,
    sourceText: sourceText(),
    sources: state.batchSources || state.documents.map(d=>({file:d.name})),
    globalRules: window.CardFlowCore ? CardFlowCore.settings().rules.filter(r=>r.enabled).map(r=>r.text) : [],
    minCards: byId('minCards').value,
    maxCards: byId('maxCards').value,
    extraRules: byId('extraRules').value,
    deepThinking: byId('deepThinking') ? byId('deepThinking').checked : false,
    reference: byId('reference').value,
    deck: state.selectedDeck || '',
    maxReference: limits().total
  };
  const types = enabledCardTypes();
  if (types) body.enabledTypes = [...types];
  const modeControl = byId(cardModeControl());
  if (modeControl) body[cardModeField()] = modeControl.value;
  // 分层导入：把规则和示例图一起送过去，AI 才会在每张卡上填 group
  if (autoGroupEnabled()) {
    body.autoGroup = true;
    body.groupRule = groupRuleText();
    if (state.groupExample && state.groupExample.data) body.groupExample = state.groupExample.data;
  }
  return body;
}
async function generate() {
  if (busy) return setStatus('上一次生成还在进行中，请稍候。', 'busy');
  const apiUrl = byId('apiUrl').value.trim(), apiKey = byId('apiKey').value.trim(), model = byId('model').value;
  if (state.readingFiles) return setStatus('文件正在解析，请稍候。', 'busy');
  if (!canGenerateWithoutMaterial()) return setStatus('请先粘贴、拖入或选择教材图片；也可以不选图片，在「本次额外生成规则」里写清要生成的卡片主题。');
  if (!model) return setStatus('请先选择模型。');
  busy = true; syncActionButtons();
  try {
    setStatus('正在上传图片并请求 AI，请稍候……', 'busy');
    saveConfig();
    const prepared = await Promise.all(state.images.map(ensureCompressed));
    const images = prepared.map(item => item.data);
    const savedBytes = prepared.reduce((sum, item) => sum + (item.saved || 0), 0);
    if (savedBytes > 0) setStatus(`正在上传图片并请求 AI（图片已按长边 ${IMG_MAX_EDGE}px 优化，省下约 ${(savedBytes / 1048576).toFixed(1)} MB）……`, 'busy');
    const data = await request(api('/api/generate'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(generateBody(images)) });
    // 服务端会把这次写进历史的记录时间戳一并返回（用来回写「重试这张」的覆盖），但不该污染卡片 JSON
    state.historyStamp = Number(data.historyT) || 0;
    delete data.historyT;
    // finish / salvaged / clamped 是诊断信息，不写进卡片 JSON
    const finish = data.finish;
    const salvaged = data.salvaged === true;
    const clamped = Number(data.clamped) || 0;
    delete data.finish;
    delete data.salvaged;
    delete data.clamped;
    excludedCards = new Set();
    pendingRetries.clear();
    byId('json').value = JSON.stringify(data, null, 2);
    byId('cards').innerHTML = '';
    hasResult = true; importedOnce = false; generatedOnce = true;
    preview();
    const count = (data.cards || []).length;
    // 模型超量被硬截断时要说清楚（shared.generateCards 按 maxCards 截的，这里只负责转述）
    const clippedNote = clamped > 0 ? `已按「最多 ${byId('maxCards').value} 张」截断 ${clamped} 张。` : '';
    if (finish === 'length') setStatus(`生成完成，但模型输出被截断了（已拿回 ${count} 张，最后一张可能不全）。把每批页数调小，或把卡片数上限/深度调低，再生成一次。`, 'warn');
    else if (salvaged) setStatus(`生成完成：从不太规整的回复里抢救出 ${count} 张。请逐张检查后再导入。${clippedNote}`, 'warn');
    else setStatus(`生成完成，请检查卡片后再导入。不满意可点「重试生成」——新结果会替换这一次，不会叠加。${clippedNote}`);
    showResults();
  } catch (error) { setStatus(`生成失败：${error.message}`, 'error'); }
  finally { busy = false; syncActionButtons(); }
}
async function retryGenerate() {
  if (busy) return setStatus('上一次生成还在进行中，请稍候。', 'busy');
  if (!canGenerateWithoutMaterial()) return setStatus('请先选择或拍摄教材图片，或在「本次额外生成规则」里写清主题，再重试生成。', 'error');
  byId('json').value = ''; byId('cards').innerHTML = ''; importedOnce = false;
  setStatus('正在重新生成：本次结果会替换上一次的卡片。', 'busy');
  return generate();
}
async function importCards() {
  if (busy) return setStatus('正在生成中，请稍候再导入。', 'busy');
  if (importedOnce) return setStatus('这批卡片已经导入过了：如需再次导入，请先点「重试生成」或修改上方 JSON。', 'warn');
  busy = true; syncActionButtons();
  try {
    if (!state.selectedDeck) throw new Error('请先选择导入牌组。');
    const data = parsedCards();
    data.deck = state.selectedDeck;
    // 部分导入：只发勾选且格式没问题的那些，一张坏卡不再拖累整批
    const all = Array.isArray(data.cards) ? data.cards : [];
    const enabled = exportGateTypes();
    const picked = all.filter((card, index) => (!enabled || enabled.has(card.type)) && cardSelected(index, card));
    // 分层导入的设置跟着这一批一起发给服务端（服务端负责在该组下创建缺少的子牌组）
    if (autoGroupEnabled()) { data.autoGroup = true; data.groupRule = groupRuleText(); }
    if (!picked.length) throw new Error('一张都没勾选（或全部格式有问题）：请在弹层里勾上要导入的类型、至少勾上一张卡，或用「重试生成」整批重来。');
    const skippedByPick = all.length - picked.length;
    data.cards = picked;
    const result = await request(api('/api/import'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    if (result.added > 0 && window.CardFlowCore) { try { const key='cardflow.seen.'+SUBJECT.id;const seen=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify([...seen,...picked.map(c=>c.text||c.front||'')].slice(-3000))); } catch (_) {} }
    if (result.added > 0) {
      // 卡片已经进 Anki 了：把页面里那几 MB 的完整压缩图放掉（手机上直接表现为滑动变顺）
      releaseCompressedData();
      redrawImages();
    }
    const pickNote = skippedByPick ? `本次只导入你勾选的 ${picked.length} / ${all.length} 张。` : '';
    // 只有真的写进去卡片才锁定导入按钮：新增 0 张（全部重复/不兼容）时锁定毫无意义，只会卡住用户
    importedOnce = result.added > 0;
    // 真写进去了才解锁「生成卡片」按钮（下一批）；新增 0 张时保持置灰，只能重试生成
    if (result.added > 0) generatedOnce = false;
    // 只有真写进去卡片才收起：新增 0 张时用户多半还要改牌组或修 JSON，收起反而碍事
    const collapseNote = result.added > 0 && collapseResultBox() ? '卡片预览已收起（点上面标题栏一键展开）。' : '';
    const base = result.added > 0
      ? `导入完成：新增 ${result.added} 张；跳过 ${result.skipped} 张重复或不兼容卡片。${pickNote}导入按钮已锁定以防重复叠加，需要再导入请先重试生成或修改 JSON。`
      : `导入完成，但新增 0 张（${result.skipped} 张全部重复或不兼容，一张也没写进去）。${pickNote}导入按钮没有锁定 —— 改牌组或修 JSON 后可以再点一次。`;
    // 手机端主力场景：点一次「导入」就把同步也做掉，不用再回电脑
    if (result.added > 0 && autoSyncEnabled()) {
      const sync = await syncAnki({ silent: true });
      return setStatus(`${base}${sync.ok ? '已自动同步到 AnkiWeb：手机上打开 Anki 拉取即可。' : `（自动同步没成功：${sync.message}）`}${collapseNote}`, sync.ok ? 'ok' : 'warn');
    }
    setStatus(`${base}${collapseNote}`, result.added > 0 ? 'ok' : 'warn');
    // 手机端遗留：导入成功后 #deleteDeck 因 busy 残留 disabled，这里显式复位一次
    syncDeckDeleteButton();
    // 安卓壳（离线版）在「直写 AnkiDroid 不行、已自动改成 .apkg」时会把 error.handled 置位：
    // 那种情况不是「导入失败」，而是一条要照原样显示的提示（卡片已经在路上，只是要用户点一次确认）。
  } catch (error) { setStatus(error.handled ? error.message : `导入失败：${error.message}`, error.handled ? 'warn' : 'error'); }
  finally { busy = false; syncActionButtons(); }
}
/* ===== 导入 / 下载 .apkg 前的确认弹层：类型勾选只在弹层里出现，平时不占页面空间（真机反馈） =====
   弹层里的 .exportType 是「导入 / .apkg 包含哪些类型」的唯一入口；卡片级的 .cardPick 是另一层
   （按张勾选），两者不冲突：类型过滤先筛掉整类，剩下再看每张卡的勾选。 */
/** 弹层里勾选的类型；页面上没有这组控件时返回 null（= 不限制类型）。 */
function exportGateTypes() {
  const nodes = document.querySelectorAll ? [...document.querySelectorAll('.exportType')] : [];
  if (!nodes.length) return null;
  return new Set(nodes.filter(node => node.checked === true).map(node => node.value));
}
/** 打开确认弹层：action = 'import'（导入 Anki）或 'apkg'（下载 .apkg），确认后才真正执行。 */
let exportGateAction = null;
function openExportGate(action) {
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  if (!byId('json').value.trim()) return setStatus(action === 'import' ? '还没有可导入的卡片：请先生成。' : '还没有可导出的卡片：请先生成。', 'error');
  exportGateAction = action;
  const importing = action === 'import';
  byId('exportGateTitle').textContent = importing ? '确认导入 Anki' : '确认导出 .apkg';
  byId('exportGateOk').textContent = importing ? '确认导入' : '确认导出';
  byId('exportGate').hidden = false;
}
function closeExportGate() { byId('exportGate').hidden = true; exportGateAction = null; }
/** 文件名优先用服务端 Content-Disposition 里的 filename="..."，取不到再退回 <类型>.txt。 */
/* ===== 遮挡框手动微调：模型给的矩形经常偏，这里可以拖 / 缩 / 新建 / 删除 ===== */
function occlusionMaskNodes(frame, masks, onDelete) {
  frame.querySelectorAll('.occlusionMask').forEach(node => node.remove());
  const editing = frame.classList.contains('editing');
  masks.forEach((mask, i) => {
    const node = document.createElement('span');
    node.className = 'occlusionMask';
    node.style.cssText = `left:${mask.x * 100}%;top:${mask.y * 100}%;width:${mask.w * 100}%;height:${mask.h * 100}%`;
    if (editing) {
      node.dataset.index = String(i);
      // 手机 WebView 里双击不灵（真机反馈）：每个框带一个「×」点按删除，双击保留给桌面
      node.title = '拖动移动；点 × 删除';
      const handle = document.createElement('i');
      handle.className = 'occlusionHandle';
      node.append(handle);
      if (typeof onDelete === 'function') {
        const del = document.createElement('i');
        del.className = 'occlusionDelete';
        del.textContent = '×';
        del.title = '删除这个遮挡框';
        // 点 × 不能触发外层的拖动（pointerdown 会先于 click 到达遮挡框）
        del.addEventListener('pointerdown', event => event.stopPropagation());
        del.addEventListener('click', event => { event.stopPropagation(); onDelete(i); });
        node.append(del);
      }
    }
    frame.append(node);
  });
}
/** 打开编辑态：拖动移动、右下角缩放、空白处拖出新框、双击删除；保存写回 JSON 并重画预览。 */
function openMaskEditor(frame, card, index) {
  const coreApi = window.CardFlowCore && window.CardFlowCore.clampMask ? window.CardFlowCore : null;
  const api = coreApi || {
    moveMask: (mask, dx, dy) => ({ ...mask, x: mask.x + dx, y: mask.y + dy }),
    resizeMask: (mask, dx, dy) => ({ ...mask, w: mask.w + dx, h: mask.h + dy }),
    maskFromDrag: (x1, y1, x2, y2) => ({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) })
  };
  let masks = (Array.isArray(card.masks) ? card.masks : []).map(mask => ({ ...mask }));
  frame.classList.add('editing');
  frame.classList.remove('revealed');
  const bar = document.createElement('div');
  bar.className = 'maskBar';
  const hint = document.createElement('span');
  hint.textContent = '拖动移动 · 右下角缩放 · 空白处拖出新框 · 点框上的 × 删除';
  const saveButton = document.createElement('button');
  saveButton.type = 'button'; saveButton.textContent = '保存遮挡框';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button'; cancelButton.className = 'secondary'; cancelButton.textContent = '取消';
  bar.append(hint, saveButton, cancelButton);
  if (frame.parentElement) frame.parentElement.insertBefore(bar, frame);
  const paint = () => occlusionMaskNodes(frame, masks, i => { masks.splice(i, 1); paint(); });
  const pointOf = event => {
    const rect = frame.getBoundingClientRect ? frame.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    const width = rect.width || 1, height = rect.height || 1;
    return {
      x: Math.min(Math.max((event.clientX - rect.left) / width, 0), 1),
      y: Math.min(Math.max((event.clientY - rect.top) / height, 0), 1)
    };
  };
  const track = handler => {
    const onMove = event => handler(event);
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  frame.onpointerdown = event => {
    const target = event.target;
    const tag = String(target && target.tagName || '').toLowerCase();
    if (target === frame || tag === 'img') {
      const start = pointOf(event);
      masks.push(api.maskFromDrag(start.x, start.y, start.x, start.y));
      const created = masks[masks.length - 1];
      track(moveEvent => {
        const now = pointOf(moveEvent);
        Object.assign(created, api.maskFromDrag(start.x, start.y, now.x, now.y));
        paint();
      });
      paint();
      return;
    }
    const node = target && target.closest ? target.closest('.occlusionMask') : null;
    if (!node || !node.dataset) return;
    const i = Number(node.dataset.index);
    if (!masks[i]) return;
    const start = pointOf(event);
    const origin = { ...masks[i] };
    const isHandle = String(target.className || '').includes('occlusionHandle');
    track(moveEvent => {
      const now = pointOf(moveEvent);
      masks[i] = isHandle
        ? api.resizeMask(origin, now.x - start.x, now.y - start.y)
        : api.moveMask(origin, now.x - start.x, now.y - start.y);
      paint();
    });
  };
  frame.ondblclick = event => {
    const node = event.target && event.target.closest ? event.target.closest('.occlusionMask') : null;
    if (!node || !node.dataset) return;
    masks.splice(Number(node.dataset.index), 1);
    paint();
  };
  const finish = keep => {
    frame.classList.remove('editing');
    frame.onpointerdown = null;
    frame.ondblclick = null;
    if (bar.parentElement) bar.parentElement.removeChild(bar);
    if (keep) applyMasks(index, masks);
    else runPreview();
  };
  saveButton.onclick = () => finish(true);
  cancelButton.onclick = () => finish(false);
  paint();
}
/** 把某张卡的 masks 写回 JSON（其它字段不动），然后重新预览。 */
function applyMasks(index, masks) {
  try {
    const data = JSON.parse(byId('json').value);
    if (data && Array.isArray(data.cards) && data.cards[index]) {
      data.cards[index].masks = masks;
      byId('json').value = JSON.stringify(data, null, 2);
      importedOnce = false;
      syncActionButtons();
      setStatus(`已更新第 ${index + 1} 张的遮挡框（共 ${masks.length} 个区域）。`);
    }
  } catch (_) { setStatus('JSON 解析失败，遮挡框没有写回。', 'error'); }
  runPreview();
}
function exportFilename(response, type) {
  const header = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-disposition') : '';
  const match = /filename="([^"]+)"/i.exec(String(header || ''));
  return match ? match[1] : `${type}.txt`;
}
/* ===== 下载 .apkg：不经过 AnkiConnect 的导入方式，手机 AnkiDroid / AnkiMobile 打开即导入 ===== */
async function downloadApkg() {
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  let data;
  try { data = parsedCards(); }
  catch (error) { setStatus(`JSON 格式错误：${error.message}`, 'error'); showResults(); return; }
  if (!state.selectedDeck) return setStatus('请先选择导入牌组（它就是包里的父牌组）。', 'error');
  const all = Array.isArray(data.cards) ? data.cards : [];
  const enabled = exportGateTypes();
  const picked = all.filter((card, index) => (!enabled || enabled.has(card.type)) && cardSelected(index, card));
  if (!picked.length) return setStatus('一张都没勾选（或全部格式有问题）：请在弹层里勾上要导出的类型、至少勾上一张卡，或用「重试生成」整批重来。', 'error');
  busy = true; syncActionButtons();
  try {
    const payload = { ...data, deck: state.selectedDeck, cards: picked };
    if (autoGroupEnabled()) { payload.autoGroup = true; payload.groupRule = groupRuleText(); }
    const response = await fetch(api('/api/apkg'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-anki-token': getToken() },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) showTokenGate('口令不正确，请重新输入。');
      throw new Error(body.error || `导出失败（HTTP ${response.status}）。`);
    }
    const blob = await response.blob();
    const filename = exportFilename(response, 'cardflow').replace(/\.txt$/i, '.apkg');
    // 安卓壳（android/ 目录）：不再自动拉起 AnkiDroid 导入界面（真机反馈），改成存进应用下载目录，
    // 用户在 AnkiDroid 里自己打开这个文件导入（原生侧会 Toast 完整路径）。
    const bridge = window.CardFlowNative;
    if (bridge && typeof bridge.saveFile === 'function') {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        bridge.saveFile(filename, btoa(binary));
        setStatus(`已保存 ${filename}（共 ${picked.length} 张）到应用下载目录（Android/data/cn.cardflow.app/files/Download），在 AnkiDroid 里打开它即可导入。`);
        return;
      } catch (error) {
        setStatus(`保存文件失败，改走普通下载：${error.message}`, 'warn');
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    setStatus(`已导出 ${picked.length} 张卡片：${link.download}。手机上用 AnkiDroid / AnkiMobile 打开这个文件就能导入（不需要电脑上的 Anki）；电脑上也可以直接拖进 Anki。`);
  } catch (error) {
    setStatus(`导出 .apkg 失败：${error.message}`, 'error');
  } finally { busy = false; syncActionButtons(); }
}
/** 去重依据 = 服务端问题池（跨设备/换浏览器都在）+ 本机记录（离线也能用） */
function seenQuestions() {
  let local = [];
  try { local = JSON.parse(localStorage.getItem('cardflow.seen.' + SUBJECT.id) || '[]'); } catch (_) { local = []; }
  const remote = Array.isArray(window.__SEEN__) ? window.__SEEN__ : [];
  return [...remote, ...(Array.isArray(local) ? local : [])];
}
/** 浏览器里存一份下载（备份 / 诊断包共用）。
 *  安卓壳里走系统「另存为」（SAF：用户自己选保存位置，真机反馈过「固定写到应用私有目录找不到」）；
 *  没有原生桥（电脑浏览器）时退回普通下载。用户在系统对话框里点取消 = 不保存。 */
async function saveBlob(blob, filename) {
  const localApi = window.CardFlowLocalApi;
  if (localApi && typeof localApi.nativeCall === 'function') {
    try {
      const dataUrl = await toDataUrl(blob);
      const result = await localApi.nativeCall('saveFileAs', { name: filename, mime: blob.type || 'application/octet-stream', data: String(dataUrl).slice(String(dataUrl).indexOf(',') + 1) });
      if (result && result.path) return result.path;
    } catch (_) { /* 取消 / 打不开对话框：不落盘也不弹下载，原生侧会 Toast 说明 */ }
    return filename;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return filename;
}
async function backupAll() {
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  busy = true; syncActionButtons();
  try {
    const settings = window.CardFlowCore ? CardFlowCore.settings() : null;
    const response = await fetch(api('/api/backup'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-anki-token': getToken() }, body: JSON.stringify({ settings }) });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `备份失败（HTTP ${response.status}）。`); }
    const name = exportFilename(response, 'cardflow-backup').replace(/\.txt$/i, '.zip');
    const saved = await saveBlob(await response.blob(), name);
    setStatus(`已导出备份：${saved}（学科包 + 历史记录 + 本机设置；密钥不在里面，恢复后重填即可）。`);
  } catch (error) { setStatus(`备份失败：${error.message}`, 'error'); }
  finally { busy = false; syncActionButtons(); }
}
async function restoreFromBackup(file) {
  if (!file) return;
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  if (!confirm('恢复会用备份包覆盖当前的学科包与历史记录（恢复前会自动把旧的存一份到 backups/）。继续？')) return;
  busy = true; syncActionButtons();
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const data = btoa(binary);
    const result = await request(api('/api/backup/restore'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }) });
    if (result && result.settings && window.CardFlowCore) {
      try { localStorage.setItem('cardflow.settings', JSON.stringify(result.settings)); } catch (_) { /* 写不进去就只恢复服务端部分 */ }
    }
    setStatus(`恢复完成：学科包 ${result.packs} 个${result.history ? '、历史记录已还原' : ''}${result.backupDir ? `，旧数据已备份到 backups/${result.backupDir}` : ''}。刷新页面后生效。`);
  } catch (error) { setStatus(`恢复失败：${error.message}`, 'error'); }
  finally { busy = false; syncActionButtons(); }
}
async function downloadDiagnose() {
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  busy = true; syncActionButtons();
  try {
    const response = await fetch(api('/api/diagnose'), { headers: { 'x-anki-token': getToken() } });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `诊断失败（HTTP ${response.status}）。`); }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const name = `cardflow-diagnose-${stamp}.json`;
    const saved = await saveBlob(await response.blob(), name);
    setStatus(`已导出诊断包：${saved}（环境 / 脱敏配置 / AnkiConnect 状态 / 最近历史 / 日志尾部，不含密钥）。`);
  } catch (error) { setStatus(`诊断失败：${error.message}`, 'error'); }
  finally { busy = false; syncActionButtons(); }
}
function setupDrop() { const drop = byId('drop'); drop.onpaste = event => { const images = [...event.clipboardData.items].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()); if (images.length) { event.preventDefault(); addImages(images); } }; drop.ondragover = event => { event.preventDefault(); drop.classList.add('active'); }; drop.ondragleave = () => drop.classList.remove('active'); drop.ondrop = event => { event.preventDefault(); drop.classList.remove('active'); addFiles(event.dataTransfer.files); }; drop.onclick = () => drop.focus(); }
byId('chooseFiles').onclick = () => byId('fileInput').click(); byId('fileInput').onchange = event => { addFiles(event.target.files); event.target.value = ''; }; byId('takePhoto').onclick = () => byId('cameraInput').click(); byId('cameraInput').onchange = event => { addImages(event.target.files); event.target.value = ''; }; byId('loadModels').onclick = () => loadModels(); byId('loadDecks').onclick = loadDecks; byId('checkAnki').onclick = checkAnki; byId('generate').onclick = generate; byId('preview').onclick = runPreview; byId('import').onclick = () => openExportGate('import'); byId('retry').onclick = retryGenerate;
if (byId('downloadApkg')) byId('downloadApkg').onclick = () => openExportGate('apkg');
if (byId('exportGateOk')) byId('exportGateOk').onclick = () => { const action = exportGateAction; closeExportGate(); if (action === 'import') importCards(); else if (action === 'apkg') downloadApkg(); };
if (byId('exportGateCancel')) byId('exportGateCancel').onclick = closeExportGate;
if (byId('backupAll')) byId('backupAll').onclick = backupAll;
if (byId('downloadDiagnose')) byId('downloadDiagnose').onclick = downloadDiagnose;
if (byId('restoreFile')) byId('restoreFile').onchange = event => { const file = event.target.files && event.target.files[0]; event.target.value = ''; restoreFromBackup(file); }; byId('json').oninput = markJsonEdited; byId('deckFilter').oninput = renderDeckTree; byId('clearConfig').onclick = () => { localStorage.removeItem(STORE); byId('apiKey').value = ''; state.selectedDeck = ''; byId('selectedDeck').textContent = '尚未选择'; setStatus('已清除本机保存的配置。'); };
byId('changeToken').onclick = () => { setToken(''); byId('tokenInput').value = ''; showTokenGate('请输入新的访问口令。'); };
if (byId('refreshQr')) byId('refreshQr').onclick = refreshQr;
if (byId('copyQrLink')) byId('copyQrLink').onclick = copyQrLink;
if (byId('copyRemoteLink')) byId('copyRemoteLink').onclick = copyRemoteLink;
initSubjectSwitch();
/* 本机语音（本地 TTS）能不能用：决定音频卡能不能「音频留空、导入时自动合成」 */
window.__TTS__ = false;
window.__SEEN__ = [];
request(api('/api/config')).then(data => { window.__TTS__ = Boolean(data && data.tts); }).catch(() => {});
/* 服务端问题池：跨批次、跨设备的去重依据 */
request(api('/api/seen')).then(data => { window.__SEEN__ = Array.isArray(data && data.seen) ? data.seen : []; }).catch(() => {});
byId('tokenSave').onclick = submitToken;
byId('tokenInput').onkeydown = event => { if (event.key === 'Enter') submitToken(); };
['apiUrl', 'apiKey', 'model', 'minCards', 'maxCards', 'extraRules', 'autoGroup', 'groupRule', 'deepThinking'].forEach(id => { const node = byId(id); if (node) node.onchange = saveConfig; });
/* 自动分层：开关状态决定「按分组预览」是否可见 */
if (byId('autoGroup')) byId('autoGroup').addEventListener('change', () => { syncGroupPreviewRow(); if (byId('json').value.trim()) preview(); });
if (byId('groupPreview')) byId('groupPreview').addEventListener('change', () => { if (byId('json').value.trim()) preview(); });
syncGroupPreviewRow();
if (byId(cardModeControl())) byId(cardModeControl()).onchange = saveConfig;
document.querySelectorAll('.cardType').forEach(node => node.onchange = () => { saveConfig(); if (hasResult) runPreview(); });
if (byId('groupExample')) byId('groupExample').onchange = event => setGroupExample(event.target.files && event.target.files[0]);
if (byId('groupExampleClear')) byId('groupExampleClear').onclick = event => { event.preventDefault(); setGroupExample(null); byId('groupExample').value = ''; };
syncImagePresetSelect();
if (byId('imgQuality')) byId('imgQuality').onchange = () => { saveConfig(); recompressAllImages(); };
/* Jina 中转地址：填一次记在本机（刷新/重开 App 自动回填；清空输入框就把记录删掉） */
if (byId('jinaUrl')) {
  try { byId('jinaUrl').value = localStorage.getItem(JINA_URL_KEY) || ''; } catch (_) { /* 读不到本机存储就留空 */ }
  byId('jinaUrl').onchange = () => {
    try {
      const value = byId('jinaUrl').value.trim();
      if (value) localStorage.setItem(JINA_URL_KEY, value); else localStorage.removeItem(JINA_URL_KEY);
    } catch (_) { /* 隐私模式下写不进去也不影响本次使用 */ }
  };
}
byId('imagePreviewClose').onclick = closeImagePreview;
byId('imagePreviewImg').onclick = toggleImagePreviewZoom;
if (byId('syncAnki')) byId('syncAnki').onclick = () => syncAnki();
if (byId('autoSync')) byId('autoSync').onchange = saveConfig;

restoreConfig(); syncGroupPreviewRow(); setupDrop(); tuneMobileHints(); registerServiceWorker(); syncActionButtons(); startApp();


/* ===== 学科切换器：切换会丢失当前页面进度，先确认再跳转 ===== */
/** 把地址里的「路径」抠出来（完整 URL / 绝对路径 / 相对路径都行），不用依赖浏览器的 URL 对象。 */
function optionPath(value) {
  let text = String(value || '').trim();
  const scheme = text.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i);
  if (scheme) text = text.slice(scheme[0].length) || '/';
  text = text.split('#')[0].split('?')[0];
  return text.replace(/\/+$/, '') || '/';
}
/** 相对路径 → 绝对地址（浏览器自己也会解析，这里只是保证不会越拼越长，比如 /chem/chem/chem/…）。 */
function absoluteUrl(href) {
  const text = String(href || '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  const loc = location || {};
  const origin = `${loc.protocol || 'http:'}//${loc.host || loc.hostname || 'local'}`;
  if (text.startsWith('/')) return origin + text;
  const dir = String(loc.pathname || '/').replace(/[^/]*$/, '');
  return origin + dir + text;
}
/** 当前页面对应的那个选项：靠「选项地址与当前地址一致」判断。
    不能靠 localStorage —— 不同端口是不同 origin（不同学科可能在不同端口），存不到一起，
    以前就因此出现过「人已经在 B 学科页面，下拉却还勾着 A 学科」。 */
function subjectOptionForPage(select) {
  const options = [...(select && select.options ? select.options : [])];
  // 本机导入的学科包：静态页不存在，页面上不会按地址认出来，只能靠内联的 __SUBJECT__.id 认。
  const subjectId = String((SUBJECT && SUBJECT.id) || '');
  const ownPack = subjectId ? options.find(option => option.value === `pack:${subjectId}`) : null;
  if (ownPack) return ownPack;
  const current = optionPath(String((location && location.pathname) || '/'));
  return options.find(option => optionPath(option.value) === current)
    || options.find(option => option.selected)
    || options[0] || null;
}
/** 本机记下的「被隐藏的学科」id（与 settings.js / pack-import.js 共用同一份记录）。 */
function hiddenSubjectIds() {
  try {
    const list = JSON.parse(localStorage.getItem('cardflow.offline.hidden') || '[]');
    return Array.isArray(list) ? list.filter(item => typeof item === 'string') : [];
  } catch (_) { return []; }
}
/** 学科下拉里的值 → 学科 id：兼容 /demo/、index-demo.html、pack:demo 与完整 URL。 */
function optionSubjectId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('pack:')) return text.slice(5);
  const file = /(?:^|\/)index-([a-z0-9-]+)\.html(?:[?#].*)?$/i.exec(text);
  if (file) return file[1];
  const path = optionPath(text).replace(/^\/+|\/+$/g, '');
  return /^[a-z][a-z0-9-]*$/i.test(path) ? path : '';
}
function initSubjectSwitch() {
  const select = byId('subjectSwitch');
  if (!select) return;
  // 被隐藏的学科包不出现在下拉里（选择页长按隐藏，设置里可恢复）
  const hidden = hiddenSubjectIds();
  if (hidden.length) [...select.options].forEach(option => { if (hidden.includes(optionSubjectId(option.value))) option.remove(); });
  // 单学科模式（只有一个选项）时整个控件都不显示
  const options = [...select.options];
  if (options.length <= 1) {
    if (select.previousElementSibling) select.previousElementSibling.hidden = true;
    select.hidden = true;
    return;
  }
  // 先按页面地址认当前学科（最可靠），再退回 localStorage 里记的那项
  const current = subjectOptionForPage(select);
  let selected = current ? current.value : '';
  try {
    const saved = localStorage.getItem(SUBJECT_STORE);
    if (!current && saved && options.some(option => option.value === saved)) selected = saved;
  } catch (_) {
  }
  if (selected) select.value = selected;

  select.onchange = () => {
    const href = select.value;
    if (!href) return;
    const before = selected;
    if (typeof confirm === 'function' && !confirm('切换学科包会丢失当前页面进度（已上传的图片与已生成的卡片），是否继续？')) {
      // 取消：回到**切换前**那一项（以前会错回第一个选项，也就是生物）
      select.value = before || (current ? current.value : select.options[0].value);
      return;
    }
    try {
      localStorage.setItem(SUBJECT_STORE, href);
    } catch (_) {
    }
    selected = href;
    // 本机导入的包没有静态页：回选择页并带上要打开的包，整页刷新一次再拼。
    // 不能在原地 document.write —— 那样会在同一个全局里二次执行 app.js，
    // 顶层 const 重复声明会让整页脚本失效（真机实测：切过去后页面不动、按钮全哑）。
    if (href.startsWith('pack:')) {
      const id = href.slice('pack:'.length);
      location.href = absoluteUrl(`index.html?pack=${encodeURIComponent(id)}`);
      return;
    }
    // 用绝对地址跳转（即使选项里是相对路径，也不会越拼越长）
    location.href = absoluteUrl(href);
  };
}
initSubjectSwitch();

/* ===== 手机端支持：访问口令 / 服务端配置 / 拍照 / PWA ===== */
/* 口令额外存一份 cookie（TOKEN_COOKIE 在文件顶部声明）：cookie 不按端口隔离，
   不同学科换页面就不用重输；服务端仍然只认 x-anki-token 请求头。 */
function readTokenCookie() {
  let raw = '';
  try { raw = String(document.cookie || ''); } catch (_) { raw = ''; }
  for (const part of raw.split(';')) {
    const item = part.trim();
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    if (item.slice(0, eq) === TOKEN_COOKIE) {
      const value = item.slice(eq + 1);
      try { return decodeURIComponent(value); } catch (_) { return value; }
    }
  }
  return '';
}
function writeTokenCookie(value) {
  try {
    document.cookie = value
      ? `${TOKEN_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`
      : `${TOKEN_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  } catch (_) { /* 不允许写 cookie 的环境就退回 localStorage */ }
}
function getToken() {
  // 导入包与生物共用访问口令；从旧化学端口切过来时，cookie 可能还是化学口令。
  if (SUBJECT.pack) { try { const own = localStorage.getItem(TOKEN_KEY); if (own) return own; } catch (_) {} }
  const fromCookie = readTokenCookie();
  if (fromCookie) return fromCookie;
  try {
    const legacy = localStorage.getItem(TOKEN_KEY) || '';
    if (legacy) writeTokenCookie(legacy); // 老版本只存在 localStorage：顺手迁到 cookie
    return legacy;
  } catch (_) { return ''; }
}
function setToken(value) {
  try { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  writeTokenCookie(value || '');
}

function showTokenGate(message = '') { byId('tokenGate').hidden = false; byId('tokenError').textContent = message; try { byId('tokenInput').focus(); } catch (_) {} }
function hideTokenGate() { byId('tokenGate').hidden = true; byId('tokenError').textContent = ''; }
function applyUrlToken() {
  try {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    if (!token) return;
    setToken(token.trim());
    params.delete('token');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  } catch (_) {}
}
async function submitToken() {
  const value = byId('tokenInput').value.trim();
  if (!value) return showTokenGate('口令不能为空。');
  setToken(value);
  try {
    // 校验口令用 /api/config：它是「免口令」接口，但**带了错口令仍返回 401**，正好当判据。
    // 以前这里打的是 /api/health，而那个接口要去碰 AnkiConnect 的集合 —— 电脑上 Anki 没开时它会报错，
    // 于是正确的口令也被当成「口令不正确」（半夜关着 Anki 输口令就进不去，这个坑踩过）。
    await request(api('/api/config'));
  } catch (error) {
    if (error && error.status === 401) { setToken(''); return showTokenGate('口令不正确，请重新输入。'); }
    // 不是 401 就不是口令的问题（服务没起来、局域网地址变了、临时断网）。口令先留着，别让人白输一遍。
    return showTokenGate(`连不上这台电脑上的服务：${error.message}。口令已经记下，网络或服务恢复后点「进入」即可。`);
  }
  byId('tokenInput').value = '';
  hideTokenGate();
  startApp();
}
async function loadServerConfig() {
  try {
    const data = await request(api('/api/config'));
    if (!savedApiUrl && data.apiUrl) byId('apiUrl').value = data.apiUrl;
    if (data.model) serverModel = data.model;
    if (!savedModel && data.model) { byId('model').innerHTML = ''; addModel(data.model); }
    byId('apiKey').placeholder = data.hasKey ? '留空即用已配置的 Key' : '填一次就记住（只保存在本机）';
    byId('keyHint').textContent = data.hasKey ? '已配置好 Key：此处留空即可。' : '还没配置 Key：在这里填一次，只保存在本机。';
    if (!data.hasSearch) byId('searchHint').textContent = '⚠ 还没配置检索 Key（联网调研要用），填上就能用。';
    if (byId('searchChannel')) {
      // 不替用户预设检索通道（真机反馈）：只把后端用不了的那个禁掉，默认选项就按页面里写的来。
      const channel = byId('searchChannel');
      for (const option of channel.options) if (option.value === 'zhihu') option.disabled = !data.hasZhihu;
      if (channel.selectedOptions[0] && channel.selectedOptions[0].disabled) {
        const usable = [...channel.options].find(option => !option.disabled);
        if (usable) channel.value = usable.value;
      }
    }
    // 检索服务商下拉：清单来自服务端（/api/config）或共享层；选过的记在本机
    if (byId('searchProvider')) {
      const providers = (data.searchProviders && data.searchProviders.length) ? data.searchProviders
        : (window.CardFlowShared && window.CardFlowShared.listSearchProviders ? window.CardFlowShared.listSearchProviders() : []);
      const select = byId('searchProvider');
      if (providers.length) {
        select.textContent = '';
        providers.forEach(provider => {
          const option = document.createElement('option');
          option.value = provider.id;
          option.textContent = provider.label;
          select.append(option);
        });
      }
      const saved = localStorage.getItem(SEARCH_PROVIDER_KEY);
      if (saved && [...select.options].some(option => option.value === saved)) select.value = saved;
      const sync = () => {
        const provider = providers.find(item => item.id === select.value) || {};
        const hint = byId('searchProviderHint');
        if (hint) hint.textContent = provider.needsKey === false ? '这个服务不用 Key，填好接口地址就能用。' : (provider.keyHint || '选哪家就用哪家的 Key');
        if (byId('searchUrl') && provider.needsUrl) byId('searchUrl').placeholder = '这个服务必须填接口地址';
        try { localStorage.setItem(SEARCH_PROVIDER_KEY, select.value); } catch (_) {}
      };
      select.addEventListener('change', sync);
      sync();
    }
  } catch (_) {}
}
function tuneMobileHints() {
  const coarse = window.matchMedia && matchMedia('(pointer:coarse)').matches;
  if (!coarse && window.innerWidth > 760) return;
  document.body.classList.add('mobile');
  byId('dropHint').textContent = '点这里拍照或从相册选图';
  byId('dropSub').textContent = '手机端不支持 Ctrl+V，直接点按即可';
  byId('drop').onclick = () => byId('cameraInput').click();
  byId('takePhoto').classList.add('primaryAction');
}
function registerServiceWorker() {
  try {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
    navigator.serviceWorker.register(api('/sw.js')).catch(() => {});
  } catch (_) {}
}

/* ===== 扫码连接（E2）：把内网地址与口令拼成链接，手机扫码即进，免手输 ===== */
/** 当前页面本身就是从内网 IP 打开时优先用它（手机上一定连得通），否则用服务端探测到的第一个地址。 */
function qrHost(addresses) {
  const host = String(location.hostname || '');
  const loopback = !host || host === 'localhost' || host === '::1' || /^127\./.test(host);
  return loopback ? String((addresses || [])[0] || '') : host;
}
/** 单学科模式 base 是空串、多学科是 /bio，末尾斜杠要去掉，避免拼出 //。 */
function qrUrl(host, port, protocol) {
  const base = String(subjectName('base', '') || '').replace(/\/+$/, '');
  return `${protocol || 'http:'}//${host}:${port}${base}/?token=${encodeURIComponent(getToken())}`;
}
/** 链接用哪个协议/端口：页面是 https 就必须用 httpsPort（3210 只跑 http，拼成 https://…:3210 会直接打不开）。 */
function qrTarget(data) {
  const ssl = String((location && location.protocol) || '').toLowerCase() === 'https:';
  const httpsPort = Number(data && data.httpsPort) || 0;
  if (ssl && httpsPort) return { protocol: 'https:', port: httpsPort };
  return { protocol: 'http:', port: Number(data && data.httpPort) || 0 };
}
function qrNotice(text) {
  const box = byId('qrImage');
  if (!box) return;
  box.innerHTML = '';
  box.textContent = text;
}
function renderQrLink(url) {
  const box = byId('qrLink');
  if (!box) return;
  box.innerHTML = '';
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('href', url);
  link.textContent = url;
  box.append(link);
}
/** 远程地址（Tailscale/ZeroTier）：在家扫二维码就行，出门就拿这一条。 */
function renderQrRemote(remote, data) {
  const box = byId('qrRemote');
  if (!box) return;
  box.innerHTML = '';
  const host = String((remote || [])[0] || '');
  if (!host) return;
  const target = qrTarget(data);
  const url = qrUrl(host, target.port, target.protocol);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('href', url);
  link.textContent = `出门用（Tailscale）：${url}`;
  box.append(link);
}
async function refreshQr() {
  if (!getToken()) return; // 没通过口令门：不请求，也不拼链接
  const box = byId('qrImage');
  if (!box) return;
  try {
    const data = await request(api('/api/network'));
    const host = qrHost(data.addresses);
    if (!host) return qrNotice('没有找到可用的内网地址：请确认电脑已连上 Wi-Fi 或热点，再点「刷新地址」。');
    const target = qrTarget(data);
    const url = qrUrl(host, target.port, target.protocol);
    renderQrLink(url);
    renderQrRemote(data.remote, data);
    if (typeof qrcode !== 'function') return qrNotice('二维码库未加载（vendor/qrcode-generator-1.4.4.js），可复制下面的链接在手机上打开。');
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8 });
    } catch (error) {
      qrNotice(`二维码生成失败（${error.message}），可复制下面的链接在手机上打开。`);
    }
  } catch (error) {
    qrNotice(`无法读取内网地址：${error.message}`);
  }
}
async function copyLinkFrom(boxId, okText) {
  const box = byId(boxId);
  const link = box && box.querySelector ? box.querySelector('a') : null;
  const url = link ? (link.getAttribute('href') || '') : '';
  if (!url) return setStatus('还没有可用链接：请先点「刷新地址」。', 'error');
  try {
    await navigator.clipboard.writeText(url);
    setStatus(okText);
  } catch (_) {
    setStatus('复制失败，请长按链接手动复制。', 'error');
  }
}
async function copyQrLink() {
  return copyLinkFrom('qrLink', '链接已复制：用手机相机扫码，或把链接粘贴到手机浏览器。');
}
async function copyRemoteLink() {
  return copyLinkFrom('qrRemote', '远程链接已复制：出门时用这条（手机需开着 Tailscale）。');
}
async function startApp() {
  applyUrlToken();
  if (!getToken()) return showTokenGate();
  hideTokenGate();
  await loadServerConfig();
  // 本地没存过模型就不让用户手动点：直接拉一次 provider 的真实模型列表
  if (!savedModel && serverModel) loadModels({ silent: true });
  checkAnki();
  loadDecks();
  refreshQr();
}

/* ===== 新建牌组（手机端可用） ===== */
async function createDeck() {
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  const full = newDeckFullName();
  if (!full) return setStatus('请输入新牌组名称。', 'error');
  busy = true; syncActionButtons();
  try {
    setStatus(`正在新建牌组 ${full} ……`, 'busy');
    const data = await request(api('/api/deck/create'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deck: full }) });
    byId('newDeckName').value = '';
    await loadDecks();
    chooseDeck(data.deck);
    setStatus(`牌组已就绪：${data.deck}（已自动选中，可直接导入）`);
  } catch (error) { setStatus(`新建牌组失败：${error.message}`, 'error'); }
  finally { busy = false; syncActionButtons(); }
}
/* ===== 新建位置：树形选择父级，样式与「选择牌组」一致 ===== */
let newDeckParent = '';
function buildDeckTree(node, selected, onPick) {
  const box = document.createElement('div');
  Object.entries(node).sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).forEach(([name, entry]) => {
    if (Object.keys(entry.children).length) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = name;
      summary.title = `${entry.full}（双击选为新建位置）`;
      if (entry.full === selected) summary.style.background = 'rgba(220,236,248,.85)';
      summary.ondblclick = event => { event.preventDefault(); onPick(entry.full); };
      details.append(summary, buildDeckTree(entry.children, selected, onPick));
      box.append(details);
    } else {
      const button = document.createElement('button');
      button.className = `leaf ${entry.full === selected ? 'selected' : ''}`;
      button.textContent = name;
      button.title = entry.full;
      button.onclick = () => onPick(entry.full);
      box.append(button);
    }
  });
  return box;
}
function renderParentTree() {
  const tree = byId('newDeckParentTree');
  if (!tree) return;
  const query = byId('newDeckParentFilter').value.trim().toLowerCase();
  const decks = query ? state.decks.filter(deck => deck.toLowerCase().includes(query)) : state.decks;
  tree.innerHTML = '';
  const top = document.createElement('button');
  top.className = `leaf ${newDeckParent ? '' : 'selected'}`;
  top.textContent = '（顶层，不嵌套）';
  top.title = '直接建在最外层';
  top.onclick = () => pickNewDeckParent('');
  tree.append(top);
  if (!decks.length) {
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = query ? '没有匹配的牌组' : '还没有其他牌组';
    tree.append(note);
    return;
  }
  tree.append(buildDeckTree(treeFromDecks(decks), newDeckParent, pickNewDeckParent));
}
function pickNewDeckParent(path) {
  newDeckParent = path || '';
  byId('newDeckParentLabel').textContent = newDeckParent || '顶层（不嵌套）';
  byId('newDeckParentBox').open = false;
  renderParentTree();
  updateNewDeckPreview();
}
function renderDeckParents() {
  if (newDeckParent && !state.decks.includes(newDeckParent)) newDeckParent = '';
  byId('newDeckParentLabel').textContent = newDeckParent || '顶层（不嵌套）';
  renderParentTree();
  updateNewDeckPreview();
}
function newDeckFullName() {
  const raw = byId('newDeckName').value.trim();
  if (!raw) return '';
  if (raw.includes('::')) return raw;
  return newDeckParent ? `${newDeckParent}::${raw}` : raw;
}
function updateNewDeckPreview() {
  const full = newDeckFullName();
  byId('newDeckPreview').textContent = full ? `将创建：${full}` : '';
}
byId('newDeckParentFilter').oninput = renderParentTree;
byId('newDeckName').oninput = updateNewDeckPreview;
byId('newDeckName').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); createDeck(); } };
byId('createDeck').onclick = createDeck;

/* ===== 删除牌组（不可逆：先预览影响范围，再选择删法） ===== */
let pendingDeleteDeck = '';
function syncDeckDeleteButton() {
  const button = byId('deleteDeck');
  if (button) button.disabled = busy || !state.selectedDeck;
}
async function openDeckDelete() {
  if (!state.selectedDeck) return setStatus('请先选择要删除的牌组。', 'error');
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  busy = true; syncActionButtons(); syncDeckDeleteButton();
  try {
    const data = await request(api('/api/deck/delete'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deck: state.selectedDeck, dryRun: true }) });
    pendingDeleteDeck = data.deck;
    const subdecks = data.subdecks || [];
    const lines = [
      `牌组：${data.deck}`,
      subdecks.length ? `含 ${subdecks.length} 个子牌组，将一并删除：\n${subdecks.slice(0, 8).join('\n')}${subdecks.length > 8 ? `\n… 等共 ${subdecks.length} 个` : ''}` : '没有子牌组',
      `涉及卡片：约 ${data.cardCount} 张`,
      '注意：Anki 不允许只删牌组而保留卡片，因此卡片会一并删除，且无法撤销。'
    ];
    byId('deckDeleteInfo').textContent = lines.join('\n\n');
    byId('deckDeleteGate').hidden = false;
  } catch (error) { setStatus(`无法读取牌组信息：${error.message}`, 'error'); }
  finally { busy = false; syncActionButtons(); syncDeckDeleteButton(); }
}
function closeDeckDelete() { byId('deckDeleteGate').hidden = true; pendingDeleteDeck = ''; }
async function confirmDeckDelete() {
  if (!pendingDeleteDeck) return closeDeckDelete();
  const deck = pendingDeleteDeck;
  byId('deckDeleteGate').hidden = true;
  busy = true; syncActionButtons(); syncDeckDeleteButton();
  try {
    setStatus(`正在删除牌组 ${deck} ……`, 'busy');
    const data = await request(api('/api/deck/delete'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deck }) });
    pendingDeleteDeck = '';
    const selected = state.selectedDeck || '';
    if (selected === deck || selected.startsWith(deck + '::')) { state.selectedDeck = ''; byId('selectedDeck').textContent = '尚未选择'; saveConfig(); }
    await loadDecks();
    setStatus(`已删除 ${data.deleted.length} 个牌组（${deck}），其中的卡片已一并删除。`);
  } catch (error) { setStatus(`删除牌组失败：${error.message}`, 'error'); }
  finally { busy = false; syncActionButtons(); syncDeckDeleteButton(); }
}
byId('deleteDeck').onclick = openDeckDelete;
byId('deckDeleteConfirm').onclick = confirmDeckDelete;
byId('deckDeleteCancel').onclick = closeDeckDelete;
syncDeckDeleteButton();

/* ===== 调研内容字数上限（单条 / 总计，保存在本机浏览器，刷新后仍在） ===== */
const LIMITS_KEY = 'ankiCardMaker.referenceLimits';
const LIMIT_DEFAULTS = { single: 5000, total: 20000 };
const LIMIT_BOUNDS = { single: [500, 20000], total: [500, 60000] };
function clampLimit(kind, value) {
  const [min, max] = LIMIT_BOUNDS[kind];
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num <= 0) return LIMIT_DEFAULTS[kind];
  return Math.min(Math.max(num, min), max);
}
function limits() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LIMITS_KEY) || '{}') || {}; } catch (_) { saved = {}; }
  return {
    single: clampLimit('single', saved.single === undefined ? LIMIT_DEFAULTS.single : saved.single),
    total: clampLimit('total', saved.total === undefined ? LIMIT_DEFAULTS.total : saved.total)
  };
}
function syncLimitInputs() {
  const now = limits();
  if (byId('limitSingle')) byId('limitSingle').value = now.single;
  if (byId('limitTotal')) byId('limitTotal').value = now.total;
}
function saveLimits() {
  const now = {
    single: clampLimit('single', byId('limitSingle') ? byId('limitSingle').value : LIMIT_DEFAULTS.single),
    total: clampLimit('total', byId('limitTotal') ? byId('limitTotal').value : LIMIT_DEFAULTS.total)
  };
  try { localStorage.setItem(LIMITS_KEY, JSON.stringify(now)); } catch (_) { /* 隐私模式下写不进去就算了，本次会话仍生效 */ }
  syncLimitInputs();
  updateReferenceInfo();
  setStatus(`字数上限已保存：单条 ${now.single} 字，总计 ${now.total} 字。`);
}
function resetLimits() {
  try { localStorage.removeItem(LIMITS_KEY); } catch (_) {}
  syncLimitInputs();
  updateReferenceInfo();
  setStatus(`字数上限已恢复默认：单条 ${LIMIT_DEFAULTS.single} 字，总计 ${LIMIT_DEFAULTS.total} 字。`);
}
/* ===== 联网检索补充资料（Tavily，Key 只在服务端） ===== */
function updateReferenceInfo() {
  const info = byId('referenceInfo');
  if (!info) return;
  const total = limits().total;
  const length = byId('reference').value.trim().length;
  info.textContent = !length ? '' : (length > total
    ? `调研内容 ${length} 字 · 超出 ${total} 字上限，超出部分不会生效`
    : `调研内容 ${length} 字（上限 ${total} 字，越长每次生成越贵）`);
}
function makeAddButton(label, text) {
  const button = document.createElement('button');
  button.className = 'secondary';
  button.textContent = '加入调研';
  button.onclick = () => {
    const area = byId('reference');
    const card = button.parentElement;
    const snipEl = card && card.querySelector ? card.querySelector('.snip') : null;
    const full = String((snipEl && snipEl.textContent) || text || '').trim();
    if (!full) return setStatus('这条结果没有可用的内容。', 'error');
    const limit = limits().single;
    const addition = full.slice(0, limit);
    area.value = area.value.trim() ? `${area.value.trim()}\n\n${addition}` : addition;
    updateReferenceInfo();
    setStatus(`已加入考情调研：${label}（${addition.length} 字${full.length > addition.length ? `，已按 ${limit} 字上限截断` : ''}）`);
  };
  return button;
}
/* 取「同一条结果正文里」当前划选的文字：不在这个卡片内的选区一律不算，避免误加入别处的文字 */
function selectedTextIn(element) {
  try {
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
    const range = selection.getRangeAt(0);
    const node = range && range.commonAncestorContainer;
    const host = node && node.nodeType === 1 ? node : (node && node.parentElement ? node.parentElement : null);
    if (element.contains && host && !element.contains(host)) return '';
    return String(selection.toString() || '').trim();
  } catch (_) { return ''; }
}
/* 「加入选中」：只把划选的那一段追加进调研，用来精挑细选、避开夸夸其谈的废话 */
function addSelectionToReference(snip) {
  const area = byId('reference');
  const picked = selectedTextIn(snip);
  if (!picked) return setStatus('先在这条结果的正文里用鼠标划选一段文字，再点「加入选中」。', 'error');
  const limit = limits().single;
  const addition = picked.slice(0, limit);
  area.value = area.value.trim() ? `${area.value.trim()}\n\n${addition}` : addition;
  updateReferenceInfo();
  setStatus(`已加入选取片段（${addition.length} 字）${picked.length > addition.length ? `，已按 ${limit} 字上限截断` : ''}`);
}
function bindSelectionButton(card, snip) {
  if (!card.querySelector || card.querySelector('.addSelection')) return;
  const addButton = card.querySelector('button.secondary:not(.snipFetch)');
  if (!addButton) return;
  const button = document.createElement('button');
  button.className = 'secondary addSelection';
  button.textContent = '加入选中';
  button.title = '先在正文里用鼠标划选一段文字，再点这里：只把选中的部分加入调研';
  button.onclick = () => addSelectionToReference(snip);
  addButton.after(button);
}
function renderSearchResults(data) {
  const box = byId('searchResults');
  box.innerHTML = '';
  const answer = String(data.answer || '').trim();
  if (!answer && !(data.results || []).length) {
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = '没有找到结果，换个关键词试试。';
    box.append(note);
    return;
  }
  if (answer) {
    const card = document.createElement('div');
    card.className = 'searchItem';
    const head = document.createElement('div');
    head.innerHTML = '<b>检索摘要</b>（AI 汇总，仅供参考）';
    const text = document.createElement('div');
    text.className = 'snip';
    text.textContent = answer;
    card.append(head, text, makeAddButton('检索摘要', answer));
    box.append(card);
  }
  (data.results || []).forEach(item => {
    const card = document.createElement('div');
    card.className = 'searchItem';
    const link = document.createElement('a');
    link.href = item.url || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = item.title || item.url || '(无标题)';
    const snip = document.createElement('div');
    snip.className = 'snip';
    snip.textContent = item.content || '（无摘要）';
    card.append(link, snip, makeAddButton(item.title || item.url || '网页', `【${item.title || ''}】${item.url || ''}\n${item.content || ''}`));
    box.append(card);
  });
}
/* ===== 自动调研：先搜教材目录锁定位置，再搜该知识点的考情 ===== */
function renderResearch(data) {
  const box = byId('searchResults');
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'searchItem';
  const title = document.createElement('div');
  title.innerHTML = '<b>教材定位（先搜目录锁定，再搜考情）</b>';
  const info = document.createElement('div');
  info.className = 'snip';
  const keypoints = (data.identify && data.identify.keypoints) || [];
  const lines = [
    `位置：${data.position || '（未能锁定，建议改用手动检索）'}`,
    `核心知识点：${data.topic || '—'}`,
    keypoints.length ? `图片要点：${keypoints.join('；')}` : '',
    `目录检索词：${data.catalogQuery || '—'}`,
    `考情检索词：${(data.examQueries || []).join(' / ') || '—'}`
  ].filter(Boolean);
  info.textContent = lines.join('\n');
  head.append(title, info, makeAddButton('教材定位', lines.join('\n')));
  box.append(head);

  // 目录/章节检索结果：之前只用它锁定位置、没有展示，但它其实最贴近这一节
  const catalog = data.catalog || [];
  if (catalog.length) {
    box.append(sectionTitle(`目录/章节检索结果（最贴近这一节，共 ${catalog.length} 条）`));
    catalog.forEach(item => appendResultCard(box, item));
  }

  (data.exams || []).forEach(exam => {
    if (exam.answer) {
      const card = document.createElement('div');
      card.className = 'searchItem';
      const label = document.createElement('div');
      label.innerHTML = '<b>考情摘要</b>';
      const query = document.createElement('div');
      query.className = 'muted';
      query.textContent = `检索词：${exam.query}`;
      const text = document.createElement('div');
      text.className = 'snip';
      text.textContent = exam.answer;
      card.append(label, query, text, makeAddButton('考情摘要', exam.answer));
      box.append(card);
    }
    if ((exam.results || []).length) box.append(sectionTitle(`考情检索：${exam.query}（${exam.provider || '未知来源'}）`));
    (exam.results || []).forEach(item => {
      const card = document.createElement('div');
      card.className = 'searchItem';
      const link = document.createElement('a');
      link.href = item.url || '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = item.title || item.url || '(无标题)';
      const snip = document.createElement('div');
      snip.className = 'snip';
      snip.textContent = item.content || '（无摘要）';
      card.append(link, snip, makeAddButton(item.title || item.url || '网页', `【${item.title || ''}】${item.url || ''}\n${item.content || ''}`));
      box.append(card);
    });
  });
}
async function autoResearch() {
  if (state.readingFiles) return setStatus('文件正在解析，请稍候。', 'busy');
  if (!state.images.length && !state.documents.length) return setStatus('请先添加教材图片，再自动调研。', 'error');
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  const apiUrl = byId('apiUrl').value.trim(), apiKey = byId('apiKey').value.trim(), model = byId('model').value;
  if (!model) return setStatus('请先选择模型。', 'error');
  busy = true; syncActionButtons(); syncDeckDeleteButton();
  try {
    setStatus('自动调研中：读图 → 搜教材目录 → 锁定章节 → 搜考点（约需半分钟）……', 'busy');
    const prepared = await Promise.all(state.images.map(ensureCompressed));
    const data = await request(api('/api/research'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: apiUrl, key: apiKey || undefined, model, sourceText: sourceText(), images: prepared.map(item => item.data), searchProvider: searchProviderValue(), searchUrl: searchUrlValue() }) });
    renderResearch(data);
    byId('webBox').open = true;
    const count = (data.exams || []).reduce((sum, exam) => sum + (exam.results || []).length, 0);
    const dropped = (data.exams || []).reduce((sum, exam) => sum + (exam.dropped || 0), 0);
    const provider = [...new Set((data.exams || []).map(exam => exam.provider).filter(Boolean))].join('、');
    setStatus(`调研完成（考情来源：${provider || '未知'}）：已锁定「${data.position || data.topic || '未知位置'}」，取到 ${count} 条考情结果${dropped ? `（已过滤 ${dropped} 条无效片段）` : ''}。点「加入调研」带上需要的部分，再回上面生成卡片。`);
  } catch (error) { setStatus(`自动调研失败：${error.message}`, 'error'); }
  finally { busy = false; syncActionButtons(); syncDeckDeleteButton(); }
}
byId('autoResearch').onclick = autoResearch;
async function searchWeb() {
  const query = byId('searchQuery').value.trim();
  if (!query) return setStatus('请输入检索关键词。', 'error');
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  busy = true; syncActionButtons(); syncDeckDeleteButton();
  try {
    setStatus('正在联网检索……', 'busy');
    const data = await request(api('/api/search'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, maxResults: 6, channel: byId('searchChannel') ? byId('searchChannel').value : undefined, provider: searchProviderValue(), searchUrl: searchUrlValue() }) });
    renderSearchResults(data);
    byId('webBox').open = true;
    setStatus(`检索完成（${data.provider || '未知来源'}）：${(data.results || []).length} 条结果${data.dropped ? `（已过滤 ${data.dropped} 条无效片段）` : ''}。点「加入调研」把有用的部分带上，再回上面生成卡片。`);
  } catch (error) { setStatus(`联网检索失败：${error.message}`, 'error'); }
  finally { busy = false; syncActionButtons(); syncDeckDeleteButton(); }
}
byId('searchWeb').onclick = searchWeb;
byId('searchQuery').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); searchWeb(); } };
byId('clearReference').onclick = () => { byId('reference').value = ''; updateReferenceInfo(); setStatus('已清空考情调研。'); };
byId('reference').oninput = updateReferenceInfo;
/* 字数上限控件：用 onchange（输入过程中不夹紧），改完立即存本机浏览器 */
if (byId('limitSingle')) byId('limitSingle').onchange = saveLimits;
if (byId('limitTotal')) byId('limitTotal').onchange = saveLimits;
if (byId('resetLimits')) byId('resetLimits').onclick = resetLimits;
syncLimitInputs();
updateReferenceInfo();

/* ===== 底部浮层反馈：顶部状态栏在长页面上看不到（body 的 overflow-x 会破坏 sticky） ===== */
let toastTimer = null;
function hideToast() {
  const el = byId('toast');
  if (el) el.className = 'toast';
}
function showToast(text, kind) {
  const el = byId('toast');
  if (!el) return;
  el.textContent = text;
  el.className = `toast show ${kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : kind === 'busy' ? 'busy' : 'ok'}`;
  clearTimeout(toastTimer);
  if (kind === 'busy') return;
  toastTimer = setTimeout(hideToast, kind === 'error' ? 8000 : kind === 'warn' ? 7000 : 4500);
}
byId('toast').onclick = hideToast;

/* ===== 历史记录：右下角纯图标按钮 → 全屏展开；一次生成 / 一次导入 / 一次导出 = 一条 ===== */
function subjectLabel(id) {
  const list = subjectName('subjectSwitch', []);
  const found = Array.isArray(list) ? list.find(item => item && item.id === id) : null;
  return (found && found.name) || String(id || '');
}
function two(value) { return String(value).padStart(2, '0'); }
function historyTime(ms) {
  const date = new Date(Number(ms) || Date.now());
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
function historyKind(record) {
  if (record.kind === 'generate') return '生成卡片';
  if (record.kind === 'import') return '导入 Anki';
  if (record.kind === 'export') return '导出文件';
  return String(record.kind || '记录');
}
function historyDetails(record) {
  const seconds = record.ms ? `${(record.ms / 1000).toFixed(1)} 秒` : '';
  if (record.kind === 'generate') {
    // 四种类型都数出来（真机反馈：全勾音频卡时显示「普通卡 0 · 填空卡 0 · 共 5 张」，看不出卡去哪了）
    const counts = [`普通卡 ${record.basic || 0}`, `填空卡 ${record.cloze || 0}`];
    if (record.occlusion) counts.push(`遮挡卡 ${record.occlusion}`);
    if (record.audio) counts.push(`音频卡 ${record.audio}`);
    counts.push(`共 ${record.total || 0} 张`);
    return [counts.join(' · '),
      record.model ? `模型 ${record.model}` : '',
      record.referenceChars ? `调研内容 ${record.referenceChars} 字` : '',
      seconds].filter(Boolean);
  }
  if (record.kind === 'import') {
    return [`牌组 ${record.deck || '（未知）'}`,
      `新增 ${record.added || 0} 张 · 跳过 ${record.skipped || 0} 张（共 ${record.requested || 0} 张）`,
      seconds].filter(Boolean);
  }
  if (record.kind === 'export') return [`${record.type === 'cloze' ? '填空卡' : '普通卡'} ${record.count || 0} 张`];
  return [];
}
function renderHistory(payload) {
  const list = byId('historyList');
  const info = byId('historyInfo');
  const fileInfo = byId('historyFile');
  if (!list) return;
  list.innerHTML = '';
  const records = (payload && payload.records) || [];
  if (info) info.textContent = records.length ? `最近 ${records.length} 条（新的在上）` : '';
  if (fileInfo) fileInfo.textContent = payload && payload.file ? `记录文件：${payload.file}` : '';
  if (!records.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '还没有记录：生成或导入一次后就会出现在这里。';
    list.append(empty);
    return;
  }
  records.forEach(record => {
    const card = document.createElement('div');
    card.className = 'searchItem';
    const head = document.createElement('div');
    head.innerHTML = `<b>${historyKind(record)}</b> <span class="muted">${historyTime(record.t)} · ${subjectLabel(record.subject)}</span>`;
    card.append(head);
    const lines = historyDetails(record);
    if (lines.length) {
      const detail = document.createElement('div');
      detail.className = 'muted';
      detail.textContent = lines.join(' · ');
      card.append(detail);
    }
    const titles = Array.isArray(record.titles) ? record.titles : [];
    if (titles.length) {
      const snip = document.createElement('div');
      snip.className = 'snip expanded';
      titles.forEach(title => {
        const line = document.createElement('div');
        line.textContent = `· ${title}`;
        snip.append(line);
      });
      if (record.total > titles.length) {
        const more = document.createElement('div');
        more.className = 'muted';
        more.textContent = `… 还有 ${record.total - titles.length} 张未列出`;
        snip.append(more);
      }
      card.append(snip);
    }
    if (record.error) {
      const fail = document.createElement('div');
      fail.style.color = '#a33333';
      fail.textContent = `失败：${record.error}`;
      card.append(fail);
    }
    if (record.kind === 'generate') {
      const actions = document.createElement('div');
      actions.className = 'searchRow historyActions';
      if (record.restorable) {
        const load = document.createElement('button');
        load.className = 'secondary historyLoad';
        load.textContent = '载入这批卡片';
        load.title = '把这批卡片放回下方「生成结果」里：可以检查、手改 JSON、预览、导出、导入 Anki';
        load.onclick = () => restoreHistoryItem(record, load);
        actions.append(load);
      } else {
        const note = document.createElement('div');
        note.className = 'muted';
        note.textContent = '这条记录较早，只存了摘要，不能载入。';
        actions.append(note);
      }
      card.append(actions);
    }
    list.append(card);
  });
}
/** 把某次历史生成重新放回主界面：写入 #json → 预览 → 关掉历史页并滚到结果区，之后就是原来那套操作。 */
async function restoreHistoryItem(record, button) {
  const label = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '载入中…'; }
  try {
    const data = await request(api(`/api/history/item?t=${encodeURIComponent(record.t)}`));
    const captured = (data && data.record) || {};
    const cards = Array.isArray(captured.cards) ? captured.cards : [];
    if (!cards.length) throw new Error('这条记录里没有卡片正文。');
    state.historyStamp = Number(record.t) || 0;
    excludedCards = new Set();
    pendingRetries.clear();
    byId('json').value = JSON.stringify({ cards }, null, 2);
    markJsonEdited();
    const deck = captured.deck || record.deck;
    if (deck && Array.isArray(state.decks) && state.decks.includes(deck)) chooseDeck(deck, false);
    preview();
    closeHistory();
    showResults();
    setStatus(`已载入 ${historyTime(record.t)} 那次的 ${cards.length} 张卡片：可以检查、手改 JSON、预览、导出或导入。`);
  } catch (error) {
    setStatus(`载入历史卡片失败：${error.message}`, 'error');
    if (button) { button.disabled = false; button.textContent = label; }
  }
}
async function loadHistory() {
  const info = byId('historyInfo');
  try {
    if (info) info.textContent = '正在读取……';
    renderHistory(await request(api('/api/history?limit=200')));
  } catch (error) {
    if (info) info.textContent = `读取历史失败：${error.message}`;
  }
}
function openHistory() {
  const box = byId('historyBox');
  if (!box) return;
  box.hidden = false;
  if (document.body && document.body.style) document.body.style.overflow = 'hidden';
  loadHistory();
}
function closeHistory() {
  const box = byId('historyBox');
  if (!box) return;
  box.hidden = true;
  if (document.body && document.body.style) document.body.style.overflow = '';
}
if (byId('historyOpen')) byId('historyOpen').onclick = openHistory;
if (byId('historyClose')) byId('historyClose').onclick = closeHistory;
if (byId('historyRefresh')) byId('historyRefresh').onclick = loadHistory;
if (typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeHistory(); closeImagePreview(); } });
}

/* ===== 检索结果增强：摘要可展开 + 按需抓全文（Jina Reader） ===== */
function snipToggleLabel(snip) { return `展开全文（共 ${(snip.textContent || '').length} 字）`; }
function bindSnipToggle(card, snip) {
  let toggle = card.querySelector('.snipToggle');
  if (!toggle) {
    toggle = document.createElement('div');
    toggle.className = 'snipToggle';
    toggle.onclick = () => { toggle.textContent = snip.classList.toggle('expanded') ? '收起' : snipToggleLabel(snip); };
    snip.after(toggle);
  }
  toggle.textContent = snip.classList.contains('expanded') ? '收起' : snipToggleLabel(snip);
}
async function fetchFullText(card, snip, url, button) {
  if (busy) return setStatus('正在处理中，请稍候。', 'busy');
  busy = true; syncActionButtons();
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '抓取中…';
  try {
    setStatus('正在抓取原文，通常几秒，慢的站可能要十几秒……', 'busy');
    const data = await request(api('/api/fetch'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, limit: 12000, jinaBase: jinaUrlValue() }) });
    snip.textContent = data.content;
    snip.classList.add('expanded');
    bindSnipToggle(card, snip);
    button.textContent = `已抓全文（${data.length} 字）`;
    button.disabled = false;
    setStatus(data.suspicious
      ? `抓回 ${data.length} 字，但看起来是页面框架（正文多半是图片，常见于课件/试卷预览页）。建议直接点标题打开原链接确认。`
      : `已抓取原文 ${data.length} 字，已展开。点「加入调研」仍按 ${limits().single} 字上限截断，可先在下方参考资料里删减。`,
      data.suspicious ? 'warn' : 'ok');
  } catch (error) {
    button.textContent = label;
    button.disabled = false;
    setStatus(`抓全文失败：${error.message}`, 'error');
  } finally { busy = false; syncActionButtons(); }
}
function enhanceResultSnips() {
  const box = byId('searchResults');
  if (!box) return;
  box.querySelectorAll('.searchItem:not([data-enhanced])').forEach(card => {
    card.dataset.enhanced = '1';
    const snip = card.querySelector('.snip');
    if (!snip) return;
    if ((snip.textContent || '').length >= 120) bindSnipToggle(card, snip);
    bindSelectionButton(card, snip);
    const link = card.querySelector('a[href]');
    const url = link ? link.getAttribute('href') : '';
    if (!/^https?:\/\//i.test(url)) return;
    const fetchButton = document.createElement('button');
    fetchButton.className = 'secondary snipFetch';
    fetchButton.textContent = '抓全文';
    fetchButton.onclick = () => fetchFullText(card, snip, url, fetchButton);
    const addButton = card.querySelector('button.secondary:not(.snipFetch)');
    if (addButton) addButton.before(fetchButton); else card.append(fetchButton);
  });
}
if (byId('searchResults') && typeof MutationObserver !== 'undefined') {
  new MutationObserver(enhanceResultSnips).observe(byId('searchResults'), { childList: true });
}

/* ===== 调研结果的分组标题与结果卡片 ===== */
function sectionTitle(text) {
  const el = document.createElement('div');
  el.className = 'sectionTitle';
  el.textContent = text;
  return el;
}
function appendResultCard(box, item) {
  const card = document.createElement('div');
  card.className = 'searchItem';
  const link = document.createElement('a');
  link.href = item.url || '#';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = item.title || item.url || '(无标题)';
  const snip = document.createElement('div');
  snip.className = 'snip';
  snip.textContent = item.content || '（无摘要）';
  card.append(link, snip, makeAddButton(item.title || item.url || '网页', `【${item.title || ''}】${item.url || ''}\n${item.content || ''}`));
  box.append(card);
  return card;
}

/* 图片预处理与压缩档位定义已上移到文件上方（顶层代码要用到 IMG_PRESETS，必须靠前定义） */
