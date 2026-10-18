'use strict';
/*
 * 前端测试：在极简 fake DOM 里加载 public/app.js（vm 沙箱），
 * 验证检索结果增强（展开全文 / 抓全文按钮）与「加入调研」按钮的行为。
 * 不依赖浏览器，也不引入 jsdom。
 *
 * 多学科版：app.js 的所有学科差异都来自服务器注入的 window.__SUBJECT__，
 * 因此这里对 demo / formula 各跑一遍 —— 同一个 app.js，两种配置都要成立。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { createDocument, createLocalStorage, Element } = require('./helpers/dom');

/**
 * fake DOM 的两处补丁（不改 tests/helpers/，只在这个测试文件里补上浏览器本来就有的行为）：
 *   1) replaceChildren：formula 版 preview() 用它清空预览容器；
 *   2) getElementById 每次返回时把 hidden 复位 —— fake DOM 的 getElementById 是「按需造元素」，
 *      而 true DOM 里 #subjectSwitch 一开始并没有 hidden 属性。
 */
Element.prototype.replaceChildren = function replaceChildren(...nodes) {
  this.children = [];
  this._text = '';
  this.append(...nodes);
};
function freshDocument(options = {}) {
  const document = createDocument({ cookies: options.cookies });
  const original = document.getElementById.bind(document);
  document.getElementById = id => {
    const element = original(id);
    element.hidden = false;
    return element;
  };
  return document;
}

const APP_PATH = path.resolve(__dirname, '..', 'public', 'app.js');

test('app.js：不允许出现重名的顶层函数声明（上次重构就是被这个坑掉的：生物预览被公式版静默覆盖）', () => {
  const source = fs.readFileSync(APP_PATH, 'utf8');
  const counts = new Map();
  source.replace(/^function\s+([A-Za-z_$][\w$]*)/gm, (all, name) => { counts.set(name, (counts.get(name) || 0) + 1); return all; });
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([name, count]) => `${name}×${count}`);
  assert.deepEqual(duplicates, [], `同名函数声明会互相覆盖，必须改名或删掉死代码：${duplicates.join('、')}`);
  assert.ok(counts.has('preview'), 'preview 必须存在（本测试同时在防止正则匹配失效）');
});
const EXPORTED = ['byId', 'enhanceResultSnips', 'makeAddButton', 'renderSearchResults', 'renderResearch',
  'bindSnipToggle', 'snipToggleLabel', 'setStatus', 'showToast', 'state', 'sectionTitle', 'appendResultCard',
  'preview', 'normalizeThenPreview', 'runPreview', 'formulaWarnings', 'textLine', 'initSubjectSwitch',
  'saveConfig', 'restoreConfig', 'STORE', 'enabledCardTypes', 'autoGroupEnabled', 'groupRuleText', 'setGroupExample',
  'extraRulesText', 'canGenerateWithoutMaterial', 'groupPreviewEnabled', 'syncGroupPreviewRow', 'moveImage', 'generate',
  'bindSelectionButton', 'addSelectionToReference', 'selectedTextIn', 'generateBody',
  'limits', 'saveLimits', 'resetLimits', 'syncLimitInputs', 'LIMITS_KEY', 'LIMIT_DEFAULTS',
  'importCards', 'openHistory', 'closeHistory', 'loadHistory', 'renderHistory', 'historyDetails', 'historyKind',
  'restoreHistoryItem', 'isSupplemented', 'supplementNote',
  'cardIssue', 'cardSelected', 'selectedCount', 'retryOneCard', 'acceptRetry', 'cardText',
  'syncAnki', 'autoSyncEnabled',
  'addImages', 'redrawImages', 'prepareImagePreview', 'recompressAllImages', 'ensureCompressed', 'compressImage',
  'imagePreset', 'imagePresetKey', 'syncImagePresetSelect', 'thumbChipText', 'thumbSrc', 'updateImageSummary',
  'formatBytes', 'dataUrlBytes', 'openImagePreview', 'closeImagePreview', 'toggleImagePreviewZoom', 'IMG_PRESETS',
  'exportFilename', 'downloadApkg', 'openExportGate', 'closeExportGate', 'exportGateTypes', 'jinaUrlValue', 'JINA_URL_KEY',
  'refreshQr', 'copyQrLink', 'qrHost', 'qrUrl', 'qrTarget', 'getToken', 'setToken', 'submitToken', 'readTokenCookie', 'renderQrRemote', 'copyRemoteLink', 'subjectOptionForPage', 'optionPath', 'absoluteUrl',
  'makeThumb', 'releaseCompressedData'];

/** 服务器 src/server.js 的 computedValues() 里给每个学科注入的字段（这里逐字照抄两份）。 */
const SUBJECT_SCRIPTS = {
  demo: {
    id: 'demo',
    base: '',
    assetVersion: 'demo1',
    storageKey: 'cardflow.demo.v1',
    tokenKey: 'cardflow.demo.token',
    cardModeControl: 'clozeWeight',
    cardModeField: 'clozeWeight',
    defaultDeck: '',
    previewNormalizes: false,
    subjectSwitch: [{ id: 'demo', name: '通用制卡', href: '/' }]
  },
  formula: {
    id: 'formula',
    base: '',
    assetVersion: 'formula1',
    storageKey: 'cardflow.formula.v1',
    tokenKey: 'cardflow.formula.token',
    cardModeControl: 'depth',
    cardModeField: 'depth',
    defaultDeck: '',
    previewNormalizes: true,
    subjectSwitch: [{ id: 'formula', name: '公式示例', href: '/' }]
  },
  ielts: {
    id: 'ielts-listening-replay-anki',
    base: '',
    assetVersion: 'pack1',
    storageKey: 'cardflow.pack.ielts-listening-replay-anki',
    tokenKey: 'cardflow.demo.token',
    cardModeControl: 'clozeWeight',
    cardModeField: 'clozeWeight',
    defaultDeck: '',
    previewNormalizes: false,
    subjectSwitch: [
      { id: 'demo', name: '通用制卡', href: 'index-demo.html' },
      { id: 'wenyan-xhs-anki-cards', name: '高考语文', href: 'index-wenyan-xhs-anki-cards.html' },
      { id: 'ielts-listening-replay-anki', name: '雅思英语听力重听备考 Anki 学科包', href: 'pack:ielts-listening-replay-anki' }
    ]
  }
};

/** 二维码库（public/vendor/qrcode-generator-1.4.4.js）的桩：真实库只在浏览器里用，测试不依赖它。 */
const FAKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128"/></svg>';
function makeQrcodeStub() {
  const stub = (typeNumber, errorCorrection) => {
    const instance = {
      typeNumber, errorCorrection,
      addData(text) { instance.data = text; },
      make() { instance.made = true; },
      createSvgTag(options) { instance.svgOptions = options; return FAKE_SVG; }
    };
    stub.calls.push(instance);
    return instance;
  };
  stub.calls = [];
  return stub;
}

function loadApp(subjectId = 'demo', options = {}) {
  const document = freshDocument(options);
  const localStorage = createLocalStorage();
  const timers = [];
  const confirmCalls = [];
  // 有口令时页面加载就会走 startApp()（会真的发请求），所以口令必须在 app.js 执行前就写好。
  if (options.token) localStorage.setItem(SUBJECT_SCRIPTS[subjectId].tokenKey, options.token);
  if (options.storage) Object.entries(options.storage).forEach(([key, value]) => localStorage.setItem(key, value));
  const windowObject = {
    matchMedia: () => ({ matches: Boolean(options.mobile) }),
    innerWidth: 1280,
    addEventListener() {},
    __SUBJECT__: JSON.parse(JSON.stringify(SUBJECT_SCRIPTS[subjectId]))
  };
  windowObject.window = windowObject;
  // 划选文字：真浏览器里是 window.getSelection()，这里给测试一个可控的桩
  if (options.selection !== undefined) windowObject.getSelection = () => options.selection;

  const context = {
    document,
    window: windowObject,
    localStorage,
    location: { search: '', pathname: '/', hash: '', hostname: '127.0.0.1', protocol: 'http:' },
    history: { replaceState() {} },
    navigator: {},
    fetch: options.fetch || (async () => ({ status: 200, ok: true, json: async () => ({}) })),
    console,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    // instantTimers：立刻执行回调（导出两种类型之间有 300ms 间隔，真等会拖慢测试），同时照旧记进 timers 供断言。
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); if (options.instantTimers) fn(); return timers.length; },
    clearTimeout: () => {},
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} },
    FileReader: class { readAsDataURL() {} },
    Image: class {},
    matchMedia: () => ({ matches: false }),
    confirm: message => { confirmCalls.push(message); return context.confirmResult !== false; },
    confirmCalls
  };
  context.confirmResult = true;
  context.globalThis = context;
  context.self = context;
  if (options.loadQrcode !== false) context.qrcode = makeQrcodeStub();
  vm.createContext(context);
  const source = fs.readFileSync(APP_PATH, 'utf8') + `\n;globalThis.__app = { ${EXPORTED.join(', ')} };\n`;
  vm.runInContext(source, context, { filename: 'app.js' });
  return { document, context, app: context.__app, timers, localStorage, confirmCalls };
}

/* ===== 公共测试数据与小工具 ===== */

const LONG = '细'.repeat(150);

function searchData(over = {}) {
  return {
    answer: '',
    results: [{ title: '结果标题', url: 'https://example.com/a', content: LONG, ...over }]
  };
}

function toggleOf(card) { return card.querySelector('.snipToggle'); }
function snipOf(card) { return card.querySelector('.snip'); }
function addButtonOf(card) {
  return card.querySelectorAll('button').find(button => button.textContent === '加入调研') || null;
}
function fetchButtonOf(card) {
  return card.querySelectorAll('button').find(button => button.textContent === '抓全文') || null;
}
function selectionButtonOf(card) {
  return card.querySelectorAll('button').find(button => button.textContent === '加入选中') || null;
}
/**
 * 请求夹具：先在「没有口令」的状态下加载（app.js 启动时就不会真的发请求），
 * 再补上口令、换成能按 URL 匹配返回的 fetch，并记录每一次调用。
 */
function stubEnv(subjectId, routes, over = {}) {
  const env = loadApp(subjectId, { instantTimers: true, ...over });
  env.localStorage.setItem(SUBJECT_SCRIPTS[subjectId].tokenKey, 'tok-1');
  env.seen = [];
  env.context.fetch = async (url, init = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    env.seen.push({ url: target, init, headers: init.headers || {}, body });
    const match = routes.find(route => target.includes(route.match));
    const payload = match ? (typeof match.json === 'function' ? match.json({ url: target, body }) : match.json) : {};
    return { status: (match && match.status) || 200, ok: true, json: async () => payload, text: async () => JSON.stringify(payload), blob: async () => ({ size: 2048, type: 'application/octet-stream' }) };
  };
  return env;
}
/**
 * 图片压缩的假环境：
 *   FileReader 立刻回一个 data URL（长度跟着 file.size 走）。
 *   Image 一设 src 就 onload，并报固定的自然尺寸。
 *   canvas 的 toDataURL 直接吐一段 JPEG data URL，并记下画布尺寸/质量（断言压缩参数就靠它）。
 */
function fakeImageEnv(env, options = {}) {
  const calls = { read: 0, canvas: [] };
  const dimensions = options.dimensions || { width: 4000, height: 3000 };
  env.context.FileReader = class {
    readAsDataURL(file) {
      calls.read += 1;
      this.result = `data:image/png;base64,${'A'.repeat(Math.max(64, Number(file && file.size) || 0))}`;
      if (this.onload) this.onload();
    }
  };
  env.context.Image = class {
    set src(value) { this._src = value; this.naturalWidth = dimensions.width; this.naturalHeight = dimensions.height; if (this.onload) this.onload(); }
    get src() { return this._src; }
  };
  const original = env.document.createElement.bind(env.document);
  env.document.createElement = tag => {
    const element = original(tag);
    if (String(tag).toLowerCase() === 'canvas') {
      element.getContext = () => ({ fillRect() {}, drawImage() {} });
      element.toDataURL = (type, quality) => {
        calls.canvas.push({ width: element.width, height: element.height, type, quality });
        return `data:image/jpeg;base64,${'B'.repeat(Math.max(32, Math.round(element.width * element.height / 1000)))}`;
      };
    }
    return element;
  };
  return calls;
}
/** 划选桩：不传 commonAncestorContainer 时代表「选区就在这段文本里」。 */
function selectionStub(text, container) {
  return {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({ commonAncestorContainer: container === undefined ? null : container }),
    toString: () => text
  };
}

/* ===== 多学科：同一个 app.js，两种 __SUBJECT__ 配置各跑一遍原有断言 ===== */

for (const subjectId of ['demo', 'formula']) {
  const subject = SUBJECT_SCRIPTS[subjectId];
  const title = name => `[${subjectId}] ${name}`;

  test(title('app.js 按 window.__SUBJECT__ 取学科配置（存储键、模式控件）'), () => {
    const { app, localStorage } = loadApp(subjectId);
    assert.equal(app.STORE, subject.storageKey, 'STORE 必须来自 subject.storageKey');
    app.saveConfig();
    assert.ok(localStorage.getItem(subject.storageKey), `配置应写在 ${subject.storageKey} 下`);
    const other = subjectId === 'demo' ? 'cardflow.formula.v1' : 'cardflow.demo.v1';
    assert.equal(localStorage.getItem(other), null, `不能写到另一个学科的键（${other}）上`);
  });

  test(title('makeAddButton：读取卡片内 .snip 的当前文本（抓全文后加入的是全文）'), () => {
    const { app } = loadApp(subjectId);
    app.renderSearchResults(searchData());
    app.enhanceResultSnips();
    const card = app.byId('searchResults').querySelector('.searchItem');
    const snip = snipOf(card);

    snip.textContent = '这是抓全文之后的新正文。';
    addButtonOf(card).click();

    assert.equal(app.byId('reference').value, '这是抓全文之后的新正文。');
    assert.match(app.byId('status').textContent, /已加入考情调研/);
  });

  test(title('makeAddButton：追加到已有调研内容后面（空行分隔）'), () => {
    const { app } = loadApp(subjectId);
    app.renderSearchResults(searchData());
    app.enhanceResultSnips();
    const card = app.byId('searchResults').querySelector('.searchItem');
    snipOf(card).textContent = '第二条内容';
    addButtonOf(card).click();
    snipOf(card).textContent = '第三条内容';
    addButtonOf(card).click();
    assert.equal(app.byId('reference').value, '第二条内容\n\n第三条内容');
  });

  test(title('makeAddButton：超过 5000 字按 5000 截断，并在状态提示里说明'), () => {
    const { app } = loadApp(subjectId);
    app.renderSearchResults(searchData());
    app.enhanceResultSnips();
    const card = app.byId('searchResults').querySelector('.searchItem');
    snipOf(card).textContent = 'Y'.repeat(6000);
    addButtonOf(card).click();
    const value = app.byId('reference').value;
    assert.equal(value.length, 5000);
    assert.equal(value, 'Y'.repeat(5000));
    assert.match(app.byId('status').textContent, /已按 5000 字上限截断/);
  });

  test(title('makeAddButton：正文为空时提示且不写入'), () => {
    const { app } = loadApp(subjectId);
    app.renderSearchResults(searchData());
    app.enhanceResultSnips();
    const card = app.byId('searchResults').querySelector('.searchItem');
    snipOf(card).textContent = '   ';
    addButtonOf(card).click();
    assert.equal(app.byId('reference').value, '');
    assert.match(app.byId('status').textContent, /没有可用的内容/);
  });

  test(title('字数上限：默认 5000/20000，改完存在本机浏览器、重新加载仍生效'), () => {
    const { app, localStorage } = loadApp(subjectId);
    assert.deepEqual({ ...app.limits() }, { single: 5000, total: 20000 }, '默认值必须和重构前一致');
    assert.equal(String(app.byId('limitSingle').value), '5000', '加载时把当前上限回填进输入框');
    assert.equal(String(app.byId('limitTotal').value), '20000');

    app.byId('limitSingle').value = '8000';
    app.byId('limitTotal').value = '36000';
    app.saveLimits();
    assert.deepEqual(JSON.parse(localStorage.getItem(app.LIMITS_KEY)), { single: 8000, total: 36000 });
    assert.deepEqual({ ...app.limits() }, { single: 8000, total: 36000 });
    assert.match(app.byId('status').textContent, /字数上限已保存/);

    const again = loadApp(subjectId, { storage: { [app.LIMITS_KEY]: localStorage.getItem(app.LIMITS_KEY) } });
    assert.deepEqual({ ...again.app.limits() }, { single: 8000, total: 36000 }, '刷新后仍是改过的值');
    assert.equal(String(again.app.byId('limitTotal').value), '36000');
  });

  test(title('字数上限：越界夹回、非法输入回落默认、恢复默认清掉记录'), () => {
    const { app, localStorage } = loadApp(subjectId);
    app.byId('limitSingle').value = '10';
    app.byId('limitTotal').value = '999999';
    app.saveLimits();
    assert.deepEqual({ ...app.limits() }, { single: 500, total: 60000 }, '下限 500、上限 60000');

    app.byId('limitSingle').value = 'abc';
    app.byId('limitTotal').value = '';
    app.saveLimits();
    assert.deepEqual({ ...app.limits() }, { single: 5000, total: 20000 }, '填不出数字就回落默认值');

    app.resetLimits();
    assert.equal(localStorage.getItem(app.LIMITS_KEY), null, '恢复默认 = 清掉本地记录');
    assert.deepEqual({ ...app.limits() }, { single: 5000, total: 20000 });
    assert.equal(String(app.byId('limitSingle').value), '5000');
    assert.match(app.byId('status').textContent, /已恢复默认/);
  });

  test(title('加入调研：按自定义的单条上限截断，提示里报新上限'), () => {
    const { app } = loadApp(subjectId);
    app.renderSearchResults(searchData());
    app.enhanceResultSnips();
    const card = app.byId('searchResults').querySelector('.searchItem');
    snipOf(card).textContent = 'Y'.repeat(9000);
    app.byId('limitSingle').value = '8000';
    app.saveLimits();
    addButtonOf(card).click();
    assert.equal(app.byId('reference').value.length, 8000);
    assert.equal(app.byId('reference').value, 'Y'.repeat(8000));
    assert.match(app.byId('status').textContent, /已按 8000 字上限截断/);

    // 上限调小后，超出部分同样生效（每次点击都按当前设置算）
    app.byId('clearReference').onclick();
    app.byId('limitSingle').value = '2000';
    app.saveLimits();
    addButtonOf(card).click();
    assert.equal(app.byId('reference').value.length, 2000);
  });

  test(title('加入选中：只把划选的那一段追加进调研（前后空白去掉）'), () => {
    const { app } = loadApp(subjectId, { selection: selectionStub('  只保留这一小段考点就行  ') });
    app.renderSearchResults(searchData());
    app.enhanceResultSnips();
    const card = app.byId('searchResults').querySelector('.searchItem');
    const button = selectionButtonOf(card);
    assert.ok(button, '每条结果都要有「加入选中」按钮');
    button.click();
    assert.equal(app.byId('reference').value, '只保留这一小段考点就行');
    assert.match(app.byId('status').textContent, /已加入选取片段/);

    // 再点一次：空行分隔追加，不和「加入调研」的全文互相覆盖
    button.click();
    assert.equal(app.byId('reference').value, '只保留这一小段考点就行\n\n只保留这一小段考点就行');
  });

  test(title('加入选中：没划选时提示、不写入；选区在别处时也不算'), () => {
    const empty = loadApp(subjectId, { selection: selectionStub('') });
    empty.app.renderSearchResults(searchData());
    empty.app.enhanceResultSnips();
    const cardA = empty.app.byId('searchResults').querySelector('.searchItem');
    selectionButtonOf(cardA).click();
    assert.equal(empty.app.byId('reference').value, '');
    assert.match(empty.app.byId('status').textContent, /先在这条结果的正文里用鼠标划选/);

    // 选区落在别的地方（contains 为假）时不认，避免误把页面别处的文字加进调研
    const outside = { contains: () => false };
    const other = loadApp(subjectId, { selection: selectionStub('页面别处的文字', { nodeType: 1 }) });
    assert.equal(other.app.selectedTextIn(outside), '');
    const inside = { contains: () => true };
    assert.equal(other.app.selectedTextIn(inside), '页面别处的文字');
  });

  test(title('加入选中：按当前的单条上限截断'), () => {
    const { app } = loadApp(subjectId, { selection: selectionStub('Z'.repeat(9000)) });
    app.renderSearchResults(searchData());
    app.enhanceResultSnips();
    const card = app.byId('searchResults').querySelector('.searchItem');
    app.byId('limitSingle').value = '3000';
    app.saveLimits();
    selectionButtonOf(card).click();
    assert.equal(app.byId('reference').value.length, 3000);
    assert.match(app.byId('status').textContent, /已按 3000 字上限截断/);
  });

  test(title('历史记录：图标按钮展开全屏页，拉到记录就渲染，关闭后收起'), async () => {
    const env = stubEnv(subjectId, [{
      match: '/api/history',
      json: {
        file: 'C:/Users/x/anki-card-maker/history/history.jsonl',
        records: [
          { t: 1758600600000, subject: subjectId, kind: 'import', deck: '生物::细胞膜', requested: 2, added: 2, skipped: 0, ms: 320 },
          { t: 1758600000000, subject: subjectId, kind: 'generate', model: 'gpt-x', total: 2, basic: 1, cloze: 1, referenceChars: 120, ms: 1500, titles: ['细胞膜是什么？', '公式平衡的五大特征'] },
          { t: 1758599000000, subject: subjectId, kind: 'generate', model: 'gpt-x', ms: 900, error: 'AI 请求失败。' }
        ]
      }
    }]);

    // fake DOM 每次 getElementById 都会把 hidden 复位，所以先抓住同一个元素再断言
    const box = env.app.byId('historyBox');
    env.app.byId('historyOpen').click();
    assert.equal(box.hidden, false, '点图标后全屏展开');
    await settle();

    assert.ok(env.seen.some(call => call.url.includes('/api/history')), '展开时要拉一次历史');
    const historyCall = env.seen.find(call => call.url.includes('/api/history'));
    assert.equal(historyCall.headers['x-anki-token'], 'tok-1', '历史接口也要带口令');
    const cards = env.app.byId('historyList').querySelectorAll('.searchItem');
    assert.equal(cards.length, 3, '一次调用一条记录');
    const text = env.app.byId('historyList').textContent;
    assert.match(text, /导入 Anki/);
    assert.match(text, /新增 2 张/);
    assert.match(text, /生成卡片/);
    assert.match(text, /普通卡 1 · 填空卡 1 · 共 2 张/);
    assert.match(text, /细胞膜是什么？/, '生成记录里要能看到卡片摘要');
    assert.match(text, /失败：AI 请求失败。/);
    assert.match(env.app.byId('historyFile').textContent, /history\.jsonl/, '把记录文件路径告诉用户，方便直接打开看');

    env.app.byId('historyClose').click();
    assert.equal(box.hidden, true, '关闭后收起');
  });

  test(title('历史记录：能把某次生成的卡片载回主界面，接着检查/修改/导入'), async () => {
    const cards = [{ type: 'basic', front: '细胞膜是什么？', back: '磷脂双分子层为骨架', priority: 'P1', tags: ['通用制卡'] }];
    const env = stubEnv(subjectId, [
      { match: '/api/history/item', json: { record: { t: 1758600000000, subject: subjectId, kind: 'generate', deck: '生物::细胞膜', cards } } },
      { match: '/api/history', json: { file: '/x/history.jsonl', records: [
        { t: 1758600000000, subject: subjectId, kind: 'generate', model: 'gpt-x', total: 1, basic: 1, cloze: 0, ms: 900, titles: ['细胞膜是什么？'], restorable: true }
      ] } }
    ]);
    env.app.state.decks = ['生物::细胞膜', 'Default'];
    const box = env.app.byId('historyBox');
    env.app.openHistory();
    await settle();

    const button = env.app.byId('historyList').querySelectorAll('button').find(item => item.textContent === '载入这批卡片');
    assert.ok(button, '生成记录上要有「载入这批卡片」按钮');
    button.click();
    await settle();

    const json = JSON.parse(env.app.byId('json').value);
    assert.equal(json.cards.length, 1);
    assert.equal(json.cards[0].front, '细胞膜是什么？', '卡片要原样回到结果框');
    assert.equal(env.app.byId('cards').querySelectorAll('.card').length, 1, '载入后直接出预览');
    assert.match(env.app.byId('status').textContent, /已载入/);
    assert.equal(env.app.state.selectedDeck, '生物::细胞膜', '当时选的牌组也一并恢复；牌组不存在则不动');
    assert.equal(env.app.byId('import').disabled, false, '载入后就能导入');
    assert.equal(box.hidden, true, '载入后自动收起历史页，回到主界面');
    const itemCall = env.seen.find(call => call.url.includes('/api/history/item'));
    assert.equal(itemCall.headers['x-anki-token'], 'tok-1');
  });

  test(title('历史记录：老记录没有卡片正文时只给提示，不给载入按钮'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/history', json: { file: '/x/history.jsonl', records: [
      { t: 1, subject: subjectId, kind: 'generate', model: 'gpt-x', total: 2, basic: 2, cloze: 0, ms: 100, titles: ['甲', '乙'], restorable: false }
    ] } }]);
    env.app.openHistory();
    await settle();
    const list = env.app.byId('historyList');
    assert.equal(list.querySelectorAll('button').filter(item => item.textContent === '载入这批卡片').length, 0);
    assert.match(list.textContent, /只存了摘要，不能载入/);
    assert.match(list.textContent, /甲/, '摘要仍然要显示');
  });

  test(title('历史记录：没有记录时给一句空提示，不报错'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/history', json: { records: [], file: '/x/history.jsonl' } }]);
    env.app.openHistory();
    await settle();
    assert.equal(env.app.byId('historyList').querySelectorAll('.searchItem').length, 0);
    assert.match(env.app.byId('historyList').textContent, /还没有记录/);
  });

  test(title('导入：新增 0 张时不锁定按钮，真写进去了才锁定'), async () => {
    const zero = stubEnv(subjectId, [{ match: '/api/import', json: { added: 0, skipped: 2 } }]);
    writeJson(zero.document, [{ type: 'basic', front: '甲', back: '乙' }, { type: 'cloze', text: '{{c1::甲}}' }]);
    zero.app.state.selectedDeck = '生物::细胞膜';
    await zero.app.importCards();
    assert.equal(zero.app.byId('import').disabled, false, '一张都没写进去，不该锁住按钮');
    assert.match(zero.app.byId('status').textContent, /新增 0 张/);
    assert.match(zero.app.byId('status').textContent, /没有锁定/);

    const some = stubEnv(subjectId, [{ match: '/api/import', json: { added: 2, skipped: 0 } }]);
    writeJson(some.document, [{ type: 'basic', front: '甲', back: '乙' }]);
    some.app.state.selectedDeck = '生物::细胞膜';
    await some.app.importCards();
    assert.equal(some.app.byId('import').disabled, true, '真的写进去了才锁定，防重复叠加');
    assert.match(some.app.byId('status').textContent, /已锁定/);
  });

  test(title('导入：写进 Anki 后自动收起卡片预览（点标题栏可再展开），新增 0 张时不收起'), async () => {
    const env = stubEnv(subjectId, [
      { match: '/api/import', json: { added: 1, skipped: 0 } },
      { match: '/api/sync', json: { ok: true, ms: 900 } }
    ]);
    writeJson(env.document, [{ type: 'basic', front: '甲', back: '乙', tags: [] }]);
    env.app.state.selectedDeck = '生物::细胞膜';
    env.app.byId('resultBox').open = true;   // 生成后本来就是摊开的
    await env.app.importCards();
    assert.equal(env.app.byId('resultBox').open, false, '导入成功后要折起来（一屏卡片很吃内存，手机滑动才顺）');
    assert.match(env.app.byId('status').textContent, /卡片预览已收起（点上面标题栏一键展开）/);
    assert.equal(env.app.byId('json').value.length > 0, true, '收起只是折叠，JSON 和卡片都还在');

    const zero = stubEnv(subjectId, [{ match: '/api/import', json: { added: 0, skipped: 1 } }]);
    writeJson(zero.document, [{ type: 'basic', front: '甲', back: '乙', tags: [] }]);
    zero.app.state.selectedDeck = '生物::细胞膜';
    zero.app.byId('resultBox').open = true;
    await zero.app.importCards();
    assert.equal(zero.app.byId('resultBox').open, true, '一张都没写进去就别收起：用户还要改牌组或修 JSON');
    assert.doesNotMatch(zero.app.byId('status').textContent, /已收起/);
  });

  test(title('口令校验：打的是 /api/config 而不是 /api/health —— 电脑上 Anki 没开时也能进得去'), async () => {
    const env = stubEnv(subjectId, [
      { match: '/api/config', json: { apiUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' } },
      { match: '/api/health', status: 400, json: { error: '连不上 AnkiConnect（http://127.0.0.1:8765）：Anki 没打开，或者 AnkiConnect 插件被停用了。' } },
      { match: '/api/decks', json: { decks: [] } },
      { match: '/api/network', json: { addresses: ['192.168.0.13'], remote: [] } }
    ]);
    const gate = env.app.byId('tokenGate');
    env.app.byId('tokenInput').value = 'the-right-token';
    await env.app.submitToken();
    await settle();

    assert.equal(env.seen[0].url.includes('/api/config'), true, '校验口令必须打 /api/config（不碰 AnkiConnect）');
    assert.equal(gate.hidden, true, 'Anki 没开时也不该被挡在口令页（以前 /api/health 400 就被当成口令错）');
    assert.equal(env.app.byId('tokenError').textContent, '');
    assert.equal(env.localStorage.getItem(SUBJECT_SCRIPTS[subjectId].tokenKey), 'the-right-token');
    // Anki 的状态照旧由 checkAnki() / loadDecks() 报到状态栏，只是不再拿它当口令判据
    assert.equal(env.seen.some(call => call.url.includes('/api/health')), true, '进页面后还是要体检 AnkiConnect');
    assert.equal(env.seen.some(call => call.url.includes('/api/decks')), true, '口令过了就继续走正常启动流程');
  });

  test(title('口令校验：只有 401 才叫「口令不正确」，服务出问题时不冤枉用户的口令'), async () => {
    const wrong = stubEnv(subjectId, [{ match: '/api/config', status: 401, json: { error: '未授权：请输入正确的访问口令。' } }]);
    wrong.app.byId('tokenInput').value = 'not-the-token';
    await wrong.app.submitToken();
    assert.equal(wrong.app.byId('tokenError').textContent, '口令不正确，请重新输入。');
    assert.equal(wrong.app.getToken(), '', '口令确实错了，就把本地存的那份清掉');

    const down = stubEnv(subjectId, [{ match: '/api/config', status: 503, json: { error: '服务器开小差了' } }]);
    down.app.byId('tokenInput').value = 'the-right-token';
    await down.app.submitToken();
    const message = down.app.byId('tokenError').textContent;
    assert.doesNotMatch(message, /口令不正确/, '不是 401 就不能说成口令错');
    assert.match(message, /连不上这台电脑上的服务/);
    assert.equal(down.app.getToken(), 'the-right-token', '口令先留着，服务恢复后直接点「进入」');
  });

  test(title('预览：调研补充的卡片被直接标出来（不用自己翻标签）'), () => {
    const { app, document } = loadApp(subjectId);
    document.getElementById('json').value = JSON.stringify({ cards: [
      { type: 'basic', front: '图片里的知识点', back: '答案', priority: 'P0', tags: ['通用制卡'] },
      { type: 'cloze', text: '调研补的{{c1::内容}}', note: '备注', priority: 'P1', tags: ['通用制卡', '补充'] },
      { type: 'basic', front: '也带补充标签的写法', back: '答案', tags: ['调研补充'] },
      { type: 'basic', front: '普通卡', back: '答案', tags: [' 补充x'] }
    ] });
    app.preview();

    const blocks = app.byId('cards').querySelectorAll('.card');
    assert.equal(blocks.length, 4);
    const textOf = node => `${node.innerHTML || ''}${node.textContent || ''}`;
    assert.equal(/调研补充/.test(textOf(blocks[0])), false, '图片里的卡片不加标记');
    assert.match(textOf(blocks[1]), /调研补充/, '补充卡要带上徒章');
    assert.equal(blocks[1].style.borderLeft, '4px solid #d9822b', '补充卡左边框换成琥珀色');
    assert.equal(blocks[0].style.borderLeft, undefined, '普通卡不改样式');
    assert.match(textOf(blocks[2]), /调研补充/, '“调研补充”也认得');
    assert.equal(/调研补充/.test(textOf(blocks[3])), false, '只是包含“补充”两字的其它标签不算');
    assert.match(app.byId('status').textContent, /其中 2 张为调研补充/);

    assert.equal(app.isSupplemented({ tags: ['补充'] }), true);
    assert.equal(app.isSupplemented({ tags: [] }), false);
    assert.equal(app.isSupplemented({}), false);
    assert.equal(app.supplementNote([]), '');
  });

  test(title('预览：标题加粗、备注也一并显示（生物以前看不到备注）'), () => {
    const { app, document } = loadApp(subjectId);
    document.getElementById('json').value = JSON.stringify({ cards: [
      { type: 'basic', front: '正面', back: '背面', note: '这条备注以前生物预览看不到', priority: 'P1', tags: [] },
      { type: 'cloze', text: '题干{{c1::空}}', note: '填空卡的备注', tags: [] }
    ] });
    app.preview();
    const blocks = app.byId('cards').querySelectorAll('.card');
    assert.ok(blocks[0].querySelector('.cardTitle'), '标题要有 cardTitle 类（CSS 里加粗）');
    assert.match(blocks[0].querySelector('.cardTitle').textContent, /1\. 普通卡 P1/);
    assert.equal(blocks[0].querySelector('.cardQuestion').textContent, '正面');
    assert.equal(blocks[0].querySelector('.cardAnswer').textContent, '背面');
    assert.equal(blocks[0].querySelector('.note').textContent, '这条备注以前生物预览看不到');
    assert.equal(blocks[0].querySelector('hr') !== null, true, '题目与答案之间要有分隔线');
    assert.match(blocks[1].querySelector('.cardTitle').textContent, /2\. 填空卡/);
  });

  test(title('相册选图：可排序（上移/下移改 state.images 顺序，带序号角标）'), () => {
    const env = loadApp(subjectId);
    const { app } = env;
    ['a', 'b', 'c'].forEach(name => app.state.images.push({ url: `blob:${name}`, file: { name }, prepared: null }));
    app.redrawImages();
    const thumbs = app.byId('thumbs').querySelectorAll('.thumb');
    assert.equal(thumbs.length, 3, '三张图都要有缩略图');
    assert.equal(thumbs[0].querySelector('.thumbOrder').textContent, '1', '第一张角标是 1');
    assert.equal(thumbs[2].querySelector('.thumbOrder').textContent, '3', '第三张角标是 3');
    assert.equal(thumbs[0].querySelector('.thumbUp').disabled, true, '第一张不能再上移');
    assert.equal(thumbs[2].querySelector('.thumbDown').disabled, true, '最后一张不能再下移');

    thumbs[0].querySelector('.thumbDown').click();
    assert.equal(app.state.images.map(image => image.url).join(','), 'blob:b,blob:a,blob:c', '下移第一张后顺序变成 b a c');
    const after = app.byId('thumbs').querySelectorAll('.thumb');
    assert.equal(after[0].querySelector('.thumbOrder').textContent, '1', '重画后角标跟着新顺序走');
    assert.equal(after[1].querySelector('.thumbOrder').textContent, '2');
  });

  test(title('无需图片：写了「本次额外生成规则」就允许生成，并真的发出请求'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/generate', json: { cards: [] } }]);
    const { app } = env;
    assert.equal(app.canGenerateWithoutMaterial(), false, '没图没资料也没规则时不允许');
    app.byId('extraRules').value = '生成 3 张普通卡，主题：细胞膜的结构与功能';
    assert.equal(app.canGenerateWithoutMaterial(), true, '写了额外规则就允许');
    app.byId('model').value = 'm';
    await app.generate();
    const call = env.seen.find(entry => entry.url.includes('/api/generate'));
    assert.ok(call, '要发出生成请求');
    assert.equal(JSON.parse(call.init.body).images.length, 0, '不带任何图片');
    assert.doesNotMatch(app.byId('status').textContent, /请先粘贴/, '不再拦「请先选图片」');
  });

  test(title('预览：开自动分层后可切「分组视图」，按子牌组归类并显示张数'), () => {
    const env = loadApp(subjectId);
    const { app, document } = env;
    env.context.window.CardFlowShared = require('../src/shared/cards.js');
    app.byId('autoGroup').checked = true;
    app.syncGroupPreviewRow();
    assert.equal(app.groupPreviewEnabled(), false, '没勾分组预览时还是内容视图');
    app.byId('groupPreview').checked = true;
    assert.equal(app.groupPreviewEnabled(), true);

    app.state.selectedDeck = '生物';
    document.getElementById('json').value = JSON.stringify({ cards: [
      { type: 'basic', front: 'A', back: 'a', tags: [], group: '第 1 章' },
      { type: 'basic', front: 'B', back: 'b', tags: [], group: '第 2 章' },
      { type: 'basic', front: 'C', back: 'c', tags: [], group: '第 1 章' }
    ] });
    app.preview();
    const headers = app.byId('cards').querySelectorAll('.groupHeader');
    assert.equal(headers.length, 2, '两个分组各一个组头');
    assert.match(headers[0].textContent, /第 1 章 · 2 张/, '组头显示子牌组名与张数');
    assert.equal(app.byId('cards').querySelectorAll('.card').length, 3, '卡还是一张不少');

    app.byId('groupPreview').checked = false;
    app.preview();
    assert.equal(app.byId('cards').querySelectorAll('.groupHeader').length, 0, '切回内容视图就没有组头');
  });

  test(title('选图后立刻显示「压缩后」的预览：缩略图换成压缩图 + 大小标签'), async () => {
    const env = loadApp(subjectId);
    const calls = fakeImageEnv(env, { dimensions: { width: 4000, height: 3000 } });
    env.app.addImages([{ type: 'image/png', size: 4 * 1024 * 1024, name: 'a.png' }]);
    await settle();

    assert.equal(calls.canvas.filter(call => call.width > 400).length, 1, '应该压过一次');
    assert.equal(calls.canvas[0].width, 2400, '默认档位长边压到 2400px');
    assert.equal(calls.canvas[0].height, 1800);
    assert.equal(calls.canvas[0].quality, 0.92, '默认质量就是原来的 0.92');
    assert.equal(calls.canvas[0].type, 'image/jpeg');

    const item = env.app.byId('thumbs').querySelector('.thumb');
    assert.match(item.querySelector('img').src, /^data:image\/jpeg/, '缩略图显示的是压缩后那张（不是原始 blob）');
    assert.match(item.textContent, /省 \d+%/, '标签上要写省了多少');
    assert.match(env.app.byId('status').textContent, /张图片/);

    const small = loadApp(subjectId);
    const smallCalls = fakeImageEnv(small, { dimensions: { width: 1200, height: 900 } });
    small.app.addImages([{ type: 'image/png', size: 300 * 1024 }]);
    await settle();
    assert.equal(smallCalls.canvas.filter(call => call.width > 400).length, 0, '不超长边且小于 1.2MB 的原图不该重压');
    assert.match(small.app.byId('thumbs').querySelector('.thumb').textContent, /无需压缩/);
    assert.match(small.app.state.images[0].prepared.data, /^data:image\/png/, '上传给 AI 的仍是原图，没被动过');
    assert.match(small.app.byId('thumbs').querySelector('.thumb img').src, /^data:image\/jpeg/, '缩略图只是显示用的小图');
  });

  test(title('压缩档位：默认就是现在的参数，换档位后已选的图按新档位重算并存下来'), async () => {
    const env = loadApp(subjectId);
    const calls = fakeImageEnv(env, { dimensions: { width: 4000, height: 3000 } });
    assert.equal(env.app.imagePresetKey(), 'standard');
    assert.match(env.app.imagePreset().label, /2400px · 质量 0\.92/, '默认档位文案要写清当前参数');
    assert.equal(String(env.app.byId('imgQuality').value), 'standard');
    assert.ok(env.app.byId('imgQuality').querySelectorAll('option').length >= 4, '档位选项要填上');

    env.app.addImages([{ type: 'image/png', size: 4 * 1024 * 1024 }]);
    await settle();

    env.app.byId('imgQuality').value = 'small';
    env.app.byId('imgQuality').onchange();
    await settle();
    const last = calls.canvas.filter(call => call.width > 400).pop();
    assert.equal(last.width, 1600, '小图档：长边 1600px');
    assert.equal(last.quality, 0.70, '小图档的质量下探到 0.70');
    assert.equal(JSON.parse(env.localStorage.getItem(env.app.STORE)).imgQuality, 'small', '档位要存在本机浏览器');

    env.app.byId('imgQuality').value = 'raw';
    env.app.byId('imgQuality').onchange();
    await settle();
    assert.equal(calls.canvas.filter(call => call.width > 400).length, 2, '不压缩档不该再走画布（只剩缩略图那一次小画布）');
    const item = env.app.byId('thumbs').querySelector('.thumb');
    assert.match(item.querySelector('img').src, /^data:image\/jpeg/, '缩略图显示的是压缩后派生的小图');
    assert.match(env.app.state.images[0].prepared.data, /^data:image\/png/, '不压缩档：上传用的就是原图');
    assert.match(item.textContent, /无需压缩/);

    const again = loadApp(subjectId, { storage: { [env.app.STORE]: env.localStorage.getItem(env.app.STORE) } });
    assert.equal(String(again.app.byId('imgQuality').value), 'raw', '刷新后档位还在');
    assert.equal(again.app.imagePresetKey(), 'raw');
  });

  test(title('点缩略图放大看压缩后的那张：可切 100%、可关闭'), async () => {
    const env = loadApp(subjectId);
    fakeImageEnv(env, { dimensions: { width: 4000, height: 3000 } });
    env.app.addImages([{ type: 'image/png', size: 4 * 1024 * 1024 }]);
    await settle();

    const box = env.app.byId('imagePreview');
    const img = env.app.byId('imagePreviewImg');
    env.app.byId('thumbs').querySelector('.thumb img').click();
    assert.equal(box.hidden, false, '点缩略图打开大图预览');
    assert.match(img.src, /^data:image\/jpeg/, '大图看的就是压缩后的那张');
    assert.equal(img.style.maxWidth, '100%');
    const info = env.app.byId('imagePreviewInfo').textContent;
    assert.match(info, /长边 2400px/, '要写清压缩后的长边');
    assert.match(info, /原图/, '要写清原图多大');

    img.click();
    assert.equal(img.style.maxWidth, 'none', '点图切到 100%');
    img.click();
    assert.equal(img.style.maxWidth, '100%', '再点回适应屏幕');

    env.app.byId('imagePreviewClose').click();
    assert.equal(box.hidden, true, '关闭要收起');
  });

  test(title('生成时复用已经压好的图，不会压第二遍'), async () => {
    const env = loadApp(subjectId);
    const calls = fakeImageEnv(env, { dimensions: { width: 4000, height: 3000 } });
    env.app.addImages([{ type: 'image/png', size: 4 * 1024 * 1024 }]);
    await settle();
    assert.equal(calls.read, 1, '选图后读文件压过一次');

    const first = await env.app.ensureCompressed(env.app.state.images[0]);
    await env.app.ensureCompressed(env.app.state.images[0]);
    assert.equal(calls.read, 1, 'ensureCompressed 应直接用缓存，不再读文件');
    assert.match(first.data, /^data:image\/jpeg/);
  });

  test(title('部分导入：坏卡自动不勾、可手动取消勾选，导入只发勾选的'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/import', json: { added: 1, skipped: 0 } }]);
    writeJson(env.document, [
      { type: 'basic', front: '好卡正面', back: '好卡背面', tags: [] },
      { type: 'cloze', text: '坏卡用了 c2 {{c2::甲}}', tags: [] },
      { type: 'basic', front: '另一张好卡', back: '答案', tags: [] }
    ]);
    env.app.preview();
    const cards = env.app.byId('cards').querySelectorAll('.card');
    assert.equal(cards.length, 3);
    assert.equal(cards[0].querySelector('.cardPick').checked, true, '格式没问题的默认勾选');
    assert.equal(cards[1].querySelector('.cardPick').checked, false, '格式有问题的自动不勾');
    assert.match(cards[1].textContent, /格式有问题：填空卡必须且只能使用 c1（不会导入）/);
    assert.match(env.app.byId('cards').querySelector('.pickSummary').textContent, /已勾选 2 \/ 3 张/);

    const first = cards[0].querySelector('.cardPick');
    first.checked = false;
    first.onchange();
    assert.match(env.app.byId('cards').querySelector('.pickSummary').textContent, /已勾选 1 \/ 3 张/);

    env.app.state.selectedDeck = '生物::细胞膜';
    await env.app.importCards();
    const sent = JSON.parse(env.seen.find(call => call.url.includes('/api/import')).init.body);
    assert.equal(sent.cards.length, 1, '只发勾选且格式没问题的那张');
    assert.equal(sent.cards[0].front, '另一张好卡');
    assert.match(env.app.byId('status').textContent, /只导入你勾选的 1 \/ 3 张/);
  });

  test(title('部分导入：一张都没勾时清楚报错，不发请求'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/import', json: { added: 0, skipped: 0 } }]);
    writeJson(env.document, [{ type: 'basic', front: '', back: '', tags: [] }]);
    env.app.preview();
    env.app.state.selectedDeck = '生物::细胞膜';
    await env.app.importCards();
    assert.equal(env.seen.filter(call => call.url.includes('/api/import')).length, 0, '不该发请求');
    assert.match(env.app.byId('status').textContent, /一张都没勾选（或全部格式有问题）/);
  });

  test(title('单卡重试：先新旧对照，采纳才覆盖（并且回写历史记录）'), async () => {
    const env = stubEnv(subjectId, [
      { match: '/api/card/retry', json: { card: { type: 'basic', front: '新版正面', back: '新版背面', tags: [], priority: 'P1' }, angle: '更精炼一点', random: false } },
      { match: '/api/history/card', json: { ok: true, titles: ['新版正面'] } }
    ]);
    writeJson(env.document, [{ type: 'basic', front: '原正面', back: '原背面', tags: [] }]);
    env.app.state.historyStamp = 1758600000000;
    env.app.preview();

    const card = env.app.byId('cards').querySelectorAll('.card')[0];
    card.querySelector('.retryHint').value = '更精炼一点';
    card.querySelector('.cardRetry').click();
    await settle();

    assert.match(env.app.byId('cards').textContent, /【原版】[\s\S]*【新版】/, '要有新旧对照');
    assert.match(env.app.byId('cards').textContent, /重试方向：更精炼一点/);
    const retryCall = env.seen.find(call => call.url.includes('/api/card/retry'));
    assert.equal(JSON.parse(retryCall.init.body).guidance, '更精炼一点');
    assert.equal(JSON.parse(retryCall.init.body).card.front, '原正面', '要把原卡片发给服务端');
    assert.equal(JSON.parse(env.app.byId('json').value).cards[0].front, '原正面', '没采纳前不动 JSON');
    assert.equal(env.seen.filter(call => call.url.includes('/api/history/card')).length, 0, '没采纳前不碰历史');

    env.app.byId('cards').querySelector('.cardTake').click();
    await settle();
    assert.equal(JSON.parse(env.app.byId('json').value).cards[0].front, '新版正面', '采纳后覆盖当前 JSON');
    const historyCall = env.seen.find(call => call.url.includes('/api/history/card'));
    const payload = JSON.parse(historyCall.init.body);
    assert.equal(payload.t, 1758600000000, '要写到原来那条历史记录上');
    assert.equal(payload.index, 0);
    assert.equal(payload.card.front, '新版正面');
    assert.match(env.app.byId('status').textContent, /历史记录都更新了/);
  });

  test(title('单卡重试：可以「保留原版」，两边都不变'), async () => {
    const env = stubEnv(subjectId, [
      { match: '/api/card/retry', json: { card: { type: 'basic', front: '新版正面', back: '新版背面', tags: [] }, angle: '随机角度', random: true } }
    ]);
    writeJson(env.document, [{ type: 'basic', front: '原正面', back: '原背面', tags: [] }]);
    env.app.preview();
    env.app.byId('cards').querySelector('.cardRetry').click();
    await settle();
    assert.match(env.app.byId('cards').textContent, /（你没填，这是随机挑的）/, '要告诉用户方向是随机挑的');

    env.app.byId('cards').querySelector('.cardKeep').click();
    await settle();
    assert.equal(JSON.parse(env.app.byId('json').value).cards[0].front, '原正面');
    assert.equal(env.app.byId('cards').textContent.includes('【新版】'), false, '保留后对照块收起');
    assert.match(env.app.byId('status').textContent, /保留第 1 张的原版/);
    assert.equal(env.seen.some(call => call.url.includes('/api/history/card')), false, '保留就不碰历史');
  });

  test(title('单卡重试：新版仍有格式问题时明确警告，别盲目采纳'), async () => {
    const env = stubEnv(subjectId, [
      { match: '/api/card/retry', json: { card: { type: 'cloze', text: '又忘了 c1', tags: [] }, angle: '换种问法', random: false, issue: '填空卡必须且只能使用 c1。' } }
    ]);
    writeJson(env.document, [{ type: 'basic', front: '原正面', back: '原背面', tags: [] }]);
    env.app.preview();
    env.app.byId('cards').querySelector('.cardRetry').click();
    await settle();
    assert.match(env.app.byId('cards').textContent, /新版仍有格式问题：填空卡必须且只能使用 c1/);
    assert.match(env.app.byId('cards').textContent, /建议「保留原版」/);
  });

  test(title('保存配置：卡片类型勾选与分层规则存下来，下次打开能恢复'), () => {
    const subject = SUBJECT_SCRIPTS[subjectId];
    const env = loadApp(subjectId);
    cardTypeInput(env, 'basic', true);
    cardTypeInput(env, 'cloze', false);
    env.app.byId('autoGroup').checked = true;
    env.app.byId('groupRule').value = '按教材节划分';
    env.app.saveConfig();
    const saved = JSON.parse(env.localStorage.getItem(subject.storageKey));
    assert.deepEqual(saved.enabledTypes, ['basic'], '只存勾上的类型');
    assert.equal(saved.autoGroup, true);
    assert.equal(saved.groupRule, '按教材节划分');

    const again = loadApp(subjectId, { storage: { [subject.storageKey]: JSON.stringify(saved) } });
    assert.equal(again.app.autoGroupEnabled(), true, '重新打开要恢复开关');
    assert.equal(again.app.groupRuleText(), '按教材节划分', '重新打开要恢复规则');
  });

  test(title('保存配置：页面没有勾选组时不写 enabledTypes，也不把类型限制当成空集'), () => {
    const subject = SUBJECT_SCRIPTS[subjectId];
    const env = loadApp(subjectId, { storage: { [subject.storageKey]: JSON.stringify({ enabledTypes: ['audio'] }) } });
    assert.equal(env.app.enabledCardTypes(), null, '没有勾选组 = 不限制类型');
    env.app.saveConfig();
    const saved = JSON.parse(env.localStorage.getItem(subject.storageKey));
    assert.deepEqual(saved.enabledTypes, ['audio'], '没有勾选组就不该把已存值覆盖掉');
  });

  test(title('生成请求：按勾选发 enabledTypes；勾了自动分层才发规则与示例图'), async () => {
    const env = loadApp(subjectId);
    cardTypeInput(env, 'basic', true);
    cardTypeInput(env, 'cloze', false);
    assert.equal(JSON.stringify(env.app.generateBody(['x']).enabledTypes), '["basic"]', '只把勾上的类型发出去');
    assert.equal(env.app.generateBody(['x']).autoGroup, undefined, '没勾分层就不发这个字段');

    env.app.byId('autoGroup').checked = true;
    env.app.byId('groupRule').value = '按章';
    const body = env.app.generateBody(['x']);
    assert.equal(body.autoGroup, true);
    assert.equal(body.groupRule, '按章');

    fakeImageEnv(env, { dimensions: { width: 4000, height: 3000 } });
    await env.app.setGroupExample({ type: 'image/png', size: 4 * 1024 * 1024, name: '示例.png' });
    assert.match(env.app.generateBody(['x']).groupExample, /^data:image\/jpeg/, '示例图压缩后一起发出去');
    await env.app.setGroupExample(null);
    assert.equal(env.app.generateBody(['x']).groupExample, undefined, '移除后不再带上');
  });

  test(title('导入：没勾选的类型不发出去；开了自动分层就把开关和规则一起发'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/import', json: { added: 1, skipped: 0 } }]);
    gateTypeInput(env, 'basic', true);
    gateTypeInput(env, 'cloze', false);
    writeJson(env.document, [
      { type: 'basic', front: '甲', back: '乙', tags: [] },
      { type: 'cloze', text: '丙{{c1::丁}}', tags: [] }
    ]);
    env.app.preview();
    env.app.byId('autoGroup').checked = true;
    env.app.byId('groupRule').value = '按教材节';
    env.app.state.selectedDeck = '生物::细胞膜';
    await env.app.importCards();
    const sent = JSON.parse(env.seen.find(call => call.url.includes('/api/import')).init.body);
    assert.equal(sent.cards.length, 1, '没勾的填空卡不发');
    assert.equal(sent.cards[0].type, 'basic');
    assert.equal(sent.autoGroup, true, '分层开关要跟着这一批走');
    assert.equal(sent.groupRule, '按教材节');
  });

  test(title('导入：全部类型都没勾时清楚报错，不发请求'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/import', json: { added: 1, skipped: 0 } }]);
    gateTypeInput(env, 'basic', false);
    writeJson(env.document, [{ type: 'basic', front: '甲', back: '乙', tags: [] }]);
    env.app.preview();
    env.app.state.selectedDeck = '生物::细胞膜';
    await env.app.importCards();
    assert.equal(env.seen.filter(call => call.url.includes('/api/import')).length, 0, '不该发请求');
    assert.match(env.app.byId('status').textContent, /一张都没勾选/);
  });

  test(title('保存配置：卡片模式的键名按学科走（以前公式写的是生物的键，永远恢复不了）'), () => {
    const subject = SUBJECT_SCRIPTS[subjectId];
    const { app, localStorage } = loadApp(subjectId);
    app.byId(subject.cardModeControl).value = '试试这个值';
    app.saveConfig();
    const saved = JSON.parse(localStorage.getItem(subject.storageKey));
    assert.ok(subject.cardModeField in saved, `必须存在 ${subject.cardModeField} 下`);
    assert.equal(saved[subject.cardModeField], '试试这个值');
    if (subject.cardModeField !== 'clozeWeight') assert.ok(!('clozeWeight' in saved), '不能把公式的模式值写到生物的键上');

    saved[subject.cardModeField] = '恢复用值';
    const again = loadApp(subjectId, { storage: { [subject.storageKey]: JSON.stringify(saved) } });
    assert.equal(String(again.app.byId(subject.cardModeControl).value), '恢复用值', '重新打开要能恢复');
  });

  test(title('同步：点按钮让电脑上的 Anki 与 AnkiWeb 同步'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/sync', json: { ok: true, ms: 2500 } }]);
    env.app.byId('syncAnki').click();
    await settle();
    const call = env.seen.find(item => item.url.includes('/api/sync'));
    assert.ok(call, '要发 /api/sync');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.headers['x-anki-token'], 'tok-1');
    assert.match(env.app.byId('status').textContent, /同步完成（2\.5 秒）/);
    assert.match(env.app.byId('status').textContent, /手机上打开 Anki/);
  });

  test(title('同步：失败时给出中文提示，不影响其它操作'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/sync', json: { error: 'sync: auth not configured' }, status: 400 }]);
    env.app.byId('syncAnki').click();
    await settle();
    assert.match(env.app.byId('status').textContent, /同步失败：sync: auth not configured/);
  });

  test(title('导入成功后自动同步（默认开，开关存在本机浏览器）'), async () => {
    const env = stubEnv(subjectId, [
      { match: '/api/import', json: { added: 2, skipped: 0 } },
      { match: '/api/sync', json: { ok: true, ms: 1200 } }
    ]);
    assert.equal(env.app.autoSyncEnabled(), true, '默认开启');
    writeJson(env.document, [{ type: 'basic', front: '甲', back: '乙', tags: [] }]);
    env.app.state.selectedDeck = '生物::细胞膜';
    await env.app.importCards();
    assert.ok(env.seen.some(call => call.url.includes('/api/sync')), '导入成功后要自动同步');
    const status = env.app.byId('status').textContent;
    assert.match(status, /导入完成：新增 2 张/);
    assert.match(status, /已自动同步到 AnkiWeb/);

    // 取消勾选 → 存起来 → 重新打开页面后仍然是关的，且不再自动同步
    env.app.byId('autoSync').checked = false;
    env.app.byId('autoSync').onchange();
    assert.equal(JSON.parse(env.localStorage.getItem(env.app.STORE)).autoSync, false);
    const stored = env.localStorage.getItem(env.app.STORE);
    const off = stubEnv(subjectId, [
      { match: '/api/import', json: { added: 1, skipped: 0 } },
      { match: '/api/sync', json: { ok: true, ms: 1000 } }
    ], { storage: { [env.app.STORE]: stored } });
    assert.equal(off.app.autoSyncEnabled(), false, '刷新后开关还是关的');
    writeJson(off.document, [{ type: 'basic', front: '甲', back: '乙', tags: [] }]);
    off.app.state.selectedDeck = '生物::细胞膜';
    await off.app.importCards();
    assert.equal(off.seen.some(call => call.url.includes('/api/sync')), false, '关掉后不自动同步');
  });

  test(title('图片：缩略图用 360px 小图（不是 2400px 原图），并释放原始 blob'), async () => {
    const env = loadApp(subjectId);
    const calls = fakeImageEnv(env, { dimensions: { width: 4000, height: 3000 } });
    const revoked = [];
    env.context.URL = { createObjectURL: () => 'blob:教材图', revokeObjectURL: url => revoked.push(url) };
    env.app.addImages([{ type: 'image/png', size: 4 * 1024 * 1024 }]);
    await settle();

    const thumbCalls = calls.canvas.filter(call => call.width <= 400);
    assert.equal(thumbCalls.length, 1, '要额外画一张小图当缩略图');
    assert.equal(thumbCalls[0].width, 360, '缩略图长边 360px');
    assert.equal(env.app.state.images[0].thumb.startsWith('data:image/jpeg'), true);

    const img = env.app.byId('thumbs').querySelector('.thumb img');
    assert.equal(img.src, env.app.state.images[0].thumb, '缩略图用的是小图');
    assert.equal(img.loading, 'lazy');
    assert.equal(img.decoding, 'async');
    assert.deepEqual(revoked, ['blob:教材图'], '压好后要释放原始 blob，省内存');

    img.click();
    await settle();
    assert.equal(env.app.byId('imagePreviewImg').src, env.app.state.images[0].prepared.data, '大图预览仍然用完整那张');
  });

  test(title('图片内存：导入成功后放掉完整压缩图（标签不变），大图按需重压'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/import', json: { added: 1, skipped: 0 } }]);
    const calls = fakeImageEnv(env, { dimensions: { width: 4000, height: 3000 } });
    writeJson(env.document, [{ type: 'basic', front: '甲', back: '乙', tags: [] }]);
    env.app.state.selectedDeck = '生物::细胞膜';
    env.app.addImages([{ type: 'image/png', size: 4 * 1024 * 1024 }]);
    await settle();
    assert.ok(env.app.state.images[0].prepared, '选图后应该是压好的');

    await env.app.importCards();
    assert.equal(env.app.state.images[0].prepared, null, '导入成功后要放掉几 MB 的完整压缩图');
    assert.match(env.app.byId('thumbs').querySelector('.thumb').textContent, /省 \d+%/, '标签文字得缓存住，不能变回「压缩中」');
    assert.match(env.app.state.images[0].thumb, /^data:image\/jpeg/, '缩略图还在');

    const compressBefore = calls.canvas.filter(call => call.width > 400).length;
    env.app.byId('thumbs').querySelector('.thumb img').click();
    await settle();
    assert.equal(calls.canvas.filter(call => call.width > 400).length, compressBefore + 1, '看大图时按需重压一次');
    assert.match(env.app.byId('imagePreviewImg').src, /^data:image\/jpeg/);

    env.app.closeImagePreview();
    assert.equal(env.app.byId('imagePreviewImg').src, '', '关闭时放掉大图位图');
  });

  test(title('学科页不再显示轻量模式；静态背景由 CardFlow 样式统一负责'), () => {
    const env = loadApp(subjectId, { mobile: true });
    assert.equal(typeof env.app.applyLiteMode, 'undefined');
    assert.equal(env.localStorage.getItem('ankiCardMaker.lite'), null);
  });

  test(title('口令共享：额外存进 cookie，换学科（不同端口）就不用重输'), () => {
    const jar = {};
    const first = loadApp(subjectId, { cookies: jar });
    first.app.setToken('tok-shared');
    assert.equal(first.app.getToken(), 'tok-shared');
    assert.match(String(first.document.cookie), /ankiToken=tok-shared/);

    const otherId = subjectId === 'demo' ? 'formula' : 'demo';
    const second = loadApp(otherId, { cookies: jar }); // 同一个 cookie，不同 origin
    assert.equal(second.app.getToken(), 'tok-shared', '另一个学科直接拿到口令');
    assert.equal(second.localStorage.getItem(SUBJECT_SCRIPTS[otherId].tokenKey), null, '那边 localStorage 里本来什么都没有');
  });

  test(title('生成请求体：把「总计上限」作为 maxReference 发给服务端'), () => {
    const { app } = loadApp(subjectId);
    const images = ['data:image/png;base64,AAAA'];
    assert.equal(app.generateBody(images).maxReference, 20000, '默认跟服务端一致');
    assert.equal(app.generateBody(images).reference, '');

    app.byId('limitTotal').value = '36000';
    app.saveLimits();
    assert.equal(app.generateBody(images).maxReference, 36000, '改过的上限要带上');

    app.byId('reference').value = '细胞膜是高频考点';
    const body = app.generateBody(images);
    assert.equal(body.reference, '细胞膜是高频考点');
    assert.equal(body.images.length, 1);
  });

  test(title('renderResearch：分组标题与结果卡片可用，且自动增强出抓全文按钮'), () => {
    const { app } = loadApp(subjectId);
    app.renderResearch({
      identify: { topic: '细胞膜', keypoints: ['结构', '功能'] },
      position: '必修1 第3章 第1节',
      catalogQuery: '通用制卡 细胞膜 章节内容',
      examQueries: ['细胞膜 讲义', '细胞膜 高考 易错点'],
      catalog: [{ title: '目录结果', url: 'https://example.com/c', content: LONG }],
      exams: [
        { query: '细胞膜 高考 易错点', provider: '知乎站内搜索', results: [{ title: '考情结果', url: 'https://example.com/e', content: LONG }], dropped: 2 }
      ]
    });
    app.enhanceResultSnips();
    const box = app.byId('searchResults');
    const titles = box.querySelectorAll('.sectionTitle').map(el => el.textContent);
    assert.equal(titles.length, 2);
    assert.match(titles[0], /目录\/章节检索结果/);
    assert.match(titles[1], /考情检索：细胞膜 高考 易错点（知乎站内搜索）/);
    assert.equal(box.querySelectorAll('.searchItem').length, 3, '定位卡片 + 目录结果 + 考情结果');
    assert.ok(fetchButtonOf(box.querySelectorAll('.searchItem')[1]), '目录结果卡也应能抓全文');
  });

  test(title('下载 .apkg：把勾选的卡片发到 /api/apkg（带分层设置），文件名以 .apkg 结尾'), async () => {
    const env = exportEnv(subjectId);
    env.context.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : {};
      env.seen.push({ url, init, headers: init.headers || {}, body });
      return {
        status: 200,
        ok: true,
        headers: { get: name => (String(name).toLowerCase() === 'content-disposition' ? 'attachment; filename="cardflow-demo-20261017.apkg"' : null) },
        blob: async () => ({ type: 'application/octet-stream', size: 4096 }),
        json: async () => ({})
      };
    };
    writeJson(env.document, EXPORT_CARDS);
    env.app.byId('autoGroup').checked = true;
    env.app.byId('groupRule').value = '按教材节';
    env.app.state.selectedDeck = '生物::细胞膜';
    await env.app.downloadApkg();

    const call = env.seen.find(item => item.url.endsWith('/api/apkg'));
    assert.ok(call, '要发 /api/apkg');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.headers['x-anki-token'], 'tok-1');
    assert.equal(call.body.deck, '生物::细胞膜');
    assert.equal(call.body.cards.length, EXPORT_CARDS.length);
    assert.equal(call.body.autoGroup, true);
    assert.equal(call.body.groupRule, '按教材节');
    assert.deepEqual(env.downloads.map(link => link.download), ['cardflow-demo-20261017.apkg']);
    assert.deepEqual(env.revoked, ['blob:x']);
    assert.match(env.app.byId('status').textContent, /AnkiDroid|AnkiMobile/);
  });

  test(title('扫码：refreshQr 用 addresses[0] 拼链接、生成 SVG，链接带 token 与 httpPort'), async () => {
    const env = qrEnv(subjectId, NETWORK);
    await env.app.refreshQr();

    const box = env.app.byId('qrImage');
    assert.ok(box.querySelector('svg'), `#qrImage 里应有二维码 SVG，实际：${box.innerHTML}`);
    const link = env.app.byId('qrLink').querySelector('a');
    assert.ok(link, '#qrLink 里要有一个可点的 <a>');
    assert.equal(link.getAttribute('href'), 'http://192.168.0.13:3210/?token=tok-1');
    assert.match(env.app.byId('qrLink').textContent, /token=tok-1/);
    assert.match(env.app.byId('qrLink').textContent, /3210/);

    const calls = env.context.qrcode.calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data, 'http://192.168.0.13:3210/?token=tok-1', '二维码内容就是链接本身');
    // 跨 vm 上下文的对象与测试里的字面量原型不同，所以逐字段比而不是 deepStrictEqual
    assert.equal(calls[0].svgOptions.cellSize, 4);
    assert.equal(calls[0].svgOptions.margin, 8);
    assert.equal(calls[0].made, true);
  });

  /* ===== 真机反馈（2026-10-18）：类型标签、按钮锁定、确认弹层、遮挡预览 ===== */

  test(title('预览：音频卡/遮挡卡的类型标签不再显示成「普通卡」'), () => {
    const { app, document } = loadApp(subjectId);
    document.getElementById('json').value = JSON.stringify({ cards: [
      { type: 'basic', priority: 'P1', front: '甲', back: '乙', tags: [] },
      { type: 'cloze', priority: 'P1', text: '{{c1::甲}}', tags: [] },
      { type: 'audio', priority: 'P1', front: '听音', back: '乙', speak: '乙', audio: 'data:audio/wav;base64,AA', tags: [] },
      { type: 'occlusion', priority: 'P1', front: '看图', back: '乙', image: 'data:image/png;base64,AA', masks: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.2 }], tags: [] }
    ] });
    app.preview();
    const titles = app.byId('cards').querySelectorAll('.cardTitle').map(el => el.textContent);
    assert.match(titles[0], /1\. 普通卡/);
    assert.match(titles[1], /2\. 填空卡/);
    assert.match(titles[2], /3\. 音频卡/, '音频卡不再标成普通卡');
    assert.match(titles[3], /4\. 图像遮挡卡/, '遮挡卡不再标成普通卡');
  });

  test(title('预览：遮挡卡不放文字答案（背面就是图片+可显隐遮挡，与导入模板同一口径）'), () => {
    const env = loadApp(subjectId);
    const { app, document } = env;
    // vm 沙箱里 window 不是全局：裸标识符 CardFlowCore 与 window.CardFlowCore 两处都要给
    env.context.CardFlowCore = require('../public/core.js');
    env.context.window.CardFlowCore = env.context.CardFlowCore;
    document.getElementById('json').value = JSON.stringify({ cards: [
      { type: 'occlusion', priority: 'P1', front: '看图', back: '不该出现的文字答案', image: 'data:image/png;base64,AA', masks: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.2 }], tags: [] }
    ] });
    app.preview();
    const block = app.byId('cards').querySelectorAll('.card')[0];
    assert.equal(block.querySelector('.cardAnswer'), null, '遮挡卡不再渲染背面文字答案');
    assert.match(block.querySelector('.cardQuestion').textContent, /看图/, '正面题面保留');
    assert.ok(block.querySelector('.occlusionFrame'), '遮挡框还在');
    assert.ok([...block.querySelectorAll('button')].some(b => b.textContent === '显示／隐藏答案'), '可显隐遮挡的按钮还在');
  });

  test(title('生成后「生成卡片」按钮置灰；导入成功或重试生成后才恢复'), async () => {
    const env = stubEnv(subjectId, [
      { match: '/api/generate', json: { cards: [{ type: 'basic', front: '甲', back: '乙', tags: [] }] } },
      { match: '/api/import', json: { added: 1, skipped: 0 } }
    ]);
    const { app } = env;
    app.byId('model').value = 'm';
    app.byId('extraRules').value = '生成 1 张普通卡';
    app.state.selectedDeck = '生物::细胞膜';
    assert.equal(app.byId('generate').disabled, false, '初始可用');
    await app.generate();
    assert.equal(app.byId('generate').disabled, true, '生成完成后置灰（防止再点一次白花钱）');
    assert.equal(app.byId('retry').disabled, false, '重试生成仍可用');
    await app.importCards();
    assert.equal(app.byId('generate').disabled, false, '导入成功后恢复（可以生成下一批）');
    assert.equal(app.byId('import').disabled, true, '导入按钮锁定');
  });

  test(title('导入：新增 0 张时「生成卡片」按钮保持置灰（只能重试生成）'), async () => {
    const env = stubEnv(subjectId, [
      { match: '/api/generate', json: { cards: [{ type: 'basic', front: '甲', back: '乙', tags: [] }] } },
      { match: '/api/import', json: { added: 0, skipped: 1 } }
    ]);
    const { app } = env;
    app.byId('model').value = 'm';
    app.byId('extraRules').value = '生成 1 张普通卡';
    await app.generate();
    await app.importCards();
    assert.equal(app.byId('generate').disabled, true, '没写进去就别解锁生成按钮');
    assert.equal(app.byId('retry').disabled, false, '重试生成仍可用');
  });

  test(title('导入/.apkg：先弹确认弹层勾类型，确认才执行，取消不发请求'), async () => {
    const env = stubEnv(subjectId, [
      { match: '/api/import', json: { added: 1, skipped: 0 } },
      { match: '/api/apkg', json: {} }
    ]);
    const { app } = env;
    const gate = app.byId('exportGate');   // fake DOM 的 getElementById 每次会把 hidden 复位，先抓引用
    writeJson(env.document, [{ type: 'basic', front: '甲', back: '乙', tags: [] }]);
    env.app.state.selectedDeck = '生物::细胞膜';
    app.byId('import').click();
    assert.equal(gate.hidden, false, '点「导入 Anki」先弹层');
    assert.equal(env.seen.filter(call => call.url.includes('/api/import')).length, 0, '确认前不发请求');
    gateTypeInput(env, 'basic', true);
    app.byId('exportGateOk').click();
    await settle();
    assert.equal(gate.hidden, true, '确认后弹层收起');
    assert.equal(env.seen.filter(call => call.url.includes('/api/import')).length, 1, '确认后才导入');

    app.byId('downloadApkg').click();
    assert.equal(gate.hidden, false, '点「下载 .apkg」也弹层');
    assert.match(app.byId('exportGateOk').textContent, /确认导出/);
    app.byId('exportGateCancel').click();
    assert.equal(gate.hidden, true, '取消就收起');
    assert.equal(env.seen.filter(call => call.url.includes('/api/apkg')).length, 0, '取消不发请求');
  });

  test(title('导入：弹层里没勾任何类型时清楚报错，不发请求'), async () => {
    const env = stubEnv(subjectId, [{ match: '/api/import', json: { added: 1, skipped: 0 } }]);
    const { app } = env;
    writeJson(env.document, [{ type: 'basic', front: '甲', back: '乙', tags: [] }]);
    env.app.state.selectedDeck = '生物::细胞膜';
    app.byId('import').click();
    gateTypeInput(env, 'basic', false);
    app.byId('exportGateOk').click();
    await settle();
    assert.equal(env.seen.filter(call => call.url.includes('/api/import')).length, 0, '不该发请求');
    assert.match(app.byId('status').textContent, /一张都没勾选/);
  });

  test(title('Jina 中转地址：填一次记在本机，重新打开自动回填；清空则删掉记录'), () => {
    const first = loadApp(subjectId);
    first.app.byId('jinaUrl').value = 'https://example.com/jina/';
    first.app.byId('jinaUrl').onchange();
    assert.equal(first.localStorage.getItem(first.app.JINA_URL_KEY), 'https://example.com/jina/', '填了就存本机');
    assert.equal(first.app.jinaUrlValue(), 'https://example.com/jina/');
    // 清掉输入框内容后仍能用本机记录（只是输入框为空，不代表取消设置）
    first.app.byId('jinaUrl').value = '   ';
    assert.equal(first.app.jinaUrlValue(), 'https://example.com/jina/', '空输入框回落到本机记录');

    const second = loadApp(subjectId, { storage: { 'cardflow.jinaUrl': 'https://example.com/jina/' } });
    assert.equal(second.app.byId('jinaUrl').value, 'https://example.com/jina/', '重新打开自动回填');
    second.app.byId('jinaUrl').value = '';
    second.app.byId('jinaUrl').onchange();
    assert.equal(second.localStorage.getItem('cardflow.jinaUrl'), null, '清空输入框就删掉记录');
  });

  test(title('历史记录：音频卡/遮挡卡也要数出来（以前显示「普通卡 0 · 填空卡 0 · 共 5 张」）'), () => {
    const { app } = loadApp(subjectId);
    const lines = app.historyDetails({ kind: 'generate', basic: 0, cloze: 0, occlusion: 2, audio: 3, total: 5 });
    assert.match(lines[0], /普通卡 0/);
    assert.match(lines[0], /填空卡 0/);
    assert.match(lines[0], /遮挡卡 2/);
    assert.match(lines[0], /音频卡 3/);
    assert.match(lines[0], /共 5 张/);
    const onlyBasic = app.historyDetails({ kind: 'generate', basic: 2, cloze: 1, total: 3 });
    assert.doesNotMatch(onlyBasic[0], /遮挡卡/, '没有的卡型不多说');
    assert.doesNotMatch(onlyBasic[0], /音频卡/);
  });
}

/* ===== 检索结果增强（与学科无关，跑一遍即可）===== */

test('enhanceResultSnips：长摘要（>= 120 字）生成「展开全文（共 N 字）」，点击可展开/收起', () => {
  const { app } = loadApp();
  app.renderSearchResults(searchData());
  app.enhanceResultSnips();

  const box = app.byId('searchResults');
  const card = box.querySelector('.searchItem');
  const snip = snipOf(card);
  const toggle = toggleOf(card);
  assert.ok(toggle, '长摘要应生成展开开关');
  assert.equal(toggle.textContent, `展开全文（共 ${LONG.length} 字）`);
  assert.equal(snip.classList.contains('expanded'), false);

  toggle.click();
  assert.equal(snip.classList.contains('expanded'), true);
  assert.equal(toggle.textContent, '收起');

  toggle.click();
  assert.equal(snip.classList.contains('expanded'), false);
  assert.equal(toggle.textContent, `展开全文（共 ${LONG.length} 字）`);
});

test('enhanceResultSnips：短摘要（< 120 字）不生成展开开关', () => {
  const { app } = loadApp();
  app.renderSearchResults(searchData({ content: '很短的一条摘要。' }));
  app.enhanceResultSnips();
  const card = app.byId('searchResults').querySelector('.searchItem');
  assert.equal(toggleOf(card), null);
});

test('enhanceResultSnips：http 链接生成「抓全文」按钮，并排在「加入调研」前面', () => {
  const { app } = loadApp();
  app.renderSearchResults(searchData());
  app.enhanceResultSnips();
  const card = app.byId('searchResults').querySelector('.searchItem');
  const fetchButton = fetchButtonOf(card);
  const addButton = addButtonOf(card);
  assert.ok(fetchButton, '应生成抓全文按钮');
  assert.ok(addButton, '应保留加入调研按钮');
  const buttons = card.querySelectorAll('button');
  assert.ok(buttons.indexOf(fetchButton) < buttons.indexOf(addButton), '抓全文应排在加入调研之前');
});

test('enhanceResultSnips：非 http 链接不生成「抓全文」按钮', () => {
  const { app } = loadApp();
  app.renderSearchResults(searchData({ url: '#' }));
  app.enhanceResultSnips();
  const card = app.byId('searchResults').querySelector('.searchItem');
  assert.equal(fetchButtonOf(card), null);
  assert.ok(addButtonOf(card), '加入调研按钮仍应在');
});

test('enhanceResultSnips：重复执行不重复插入（data-enhanced 生效）', () => {
  const { app } = loadApp();
  app.renderSearchResults(searchData());
  app.enhanceResultSnips();
  app.enhanceResultSnips();
  app.enhanceResultSnips();
  const box = app.byId('searchResults');
  const card = box.querySelector('.searchItem');
  assert.equal(card.dataset.enhanced, '1');
  assert.equal(card.querySelectorAll('.snipToggle').length, 1);
  assert.equal(card.querySelectorAll('button').filter(button => button.textContent === '抓全文').length, 1);
  assert.equal(card.querySelectorAll('button').filter(button => button.textContent === '加入调研').length, 1);
});

test('enhanceResultSnips：多条结果各自处理', () => {
  const { app } = loadApp();
  app.renderSearchResults({
    answer: '摘要内容'.repeat(30),
    results: [
      { title: 'A', url: 'https://example.com/a', content: LONG },
      { title: 'B', url: 'https://example.com/b', content: '短' }
    ]
  });
  app.enhanceResultSnips();
  const cards = app.byId('searchResults').querySelectorAll('.searchItem');
  assert.equal(cards.length, 3, '摘要 + 2 条结果');
  assert.ok(toggleOf(cards[0]), '检索摘要也应可展开');
  assert.ok(toggleOf(cards[1]));
  assert.equal(toggleOf(cards[2]), null);
});

/* ===== 学科差异：预览分派与模式控件 ===== */

test('[bio] previewNormalizes=false：#preview 直接走 preview()，不出公式告警', () => {
  const { app, document } = loadApp('demo');
  document.getElementById('json').value = JSON.stringify({ cards: [{ type: 'basic', front: 'H2O', back: '水' }] });
  app.runPreview();
  assert.match(app.byId('status').textContent, /预览完成/);
  assert.equal(/公式/.test(app.byId('status').textContent), false, 'bio 不应该出现公式相关提示');
  assert.equal(app.byId('cards').querySelectorAll('.card').length, 1);
});

test('[formula] previewNormalizes=true：preview() 逐行拼 DOM 并给出公式告警', () => {
  const { app, document } = loadApp('formula');
  document.getElementById('json').value = JSON.stringify({ cards: [{ type: 'basic', front: 'H2O', back: '水' }] });
  app.preview();
  const status = app.byId('status').textContent;
  assert.match(status, /预览完成/);
  assert.match(status, /疑似有裸公式/);
  const card = app.byId('cards').querySelectorAll('.card')[0];
  assert.ok(card, '应渲染出卡片');
  assert.ok(card.querySelector('.cardQuestion'), 'formula 预览用 textLine 拼出 .cardQuestion');
  assert.ok(card.querySelector('.cardAnswer'), 'formula 预览用 textLine 拼出 .cardAnswer');
});

test('[formula] formulaWarnings：c1 以外的填空与非 c1 编号会被指出', () => {
  const { app } = loadApp('formula');
  assert.equal(app.formulaWarnings([{ type: 'cloze', text: '{{c1::甲}}' }]).length, 0, '只有 c1 时不应有告警');
  const warnings = app.formulaWarnings([{ type: 'cloze', text: '{{c2::甲}}' }, { type: 'basic', front: 'CO2' }]);
  assert.ok(warnings.includes('发现 c2/c3 等非 c1 填空。'));
  assert.ok(warnings.includes('疑似有裸公式，建议检查。'));
});

test('[formula] 公式告警看的是未转义的卡片文本：规范化后的 \\(\\ce{...}\\) 不再误报裸公式', () => {
  const { app } = loadApp('formula');
  assert.equal(app.formulaWarnings([{ type: 'basic', front: '水是 \\(\\ce{H2O}\\)，CO2 是气体' }]).length, 0, '已经有 \\(\\ce{}\\) 就不该再报裸公式');
  assert.ok(app.formulaWarnings([{ type: 'basic', front: '水是 H2O' }]).includes('疑似有裸公式，建议检查。'));
  // 生物（不做公式转换）里 CO2 是普通文字，不该弹公式提示
  const bio = loadApp('demo');
  assert.equal(bio.app.formulaWarnings([{ type: 'basic', front: '血液中 CO2 升高' }]).length, 0);
});

test('[formula] normalizeThenPreview：先请求 /api/normalize，再预览', async () => {
  const { app, context, document } = loadApp('formula');
  const seen = [];
  context.fetch = async (url, options) => {
    seen.push({ url, body: options && options.body });
    return { status: 200, ok: true, json: async () => ({ cards: [{ type: 'basic', front: 'F', back: 'B' }] }) };
  };
  document.getElementById('json').value = JSON.stringify({ cards: [{ type: 'basic', front: 'F', back: 'B' }] });
  await app.normalizeThenPreview();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/normalize', '单学科模式下 base 为空串');
  assert.match(app.byId('status').textContent, /预览完成/);
  assert.match(document.getElementById('json').value, /"front": "F"/);
});

test('[formula] base 前缀：多学科模式下所有 /api/ 都带 /chem 前缀', async () => {
  const { app, context, document } = loadApp('formula');
  context.window.__SUBJECT__.base = '/formula';
  const seen = [];
  context.fetch = async url => {
    seen.push(url);
    return { status: 200, ok: true, json: async () => ({ cards: [] }) };
  };
  document.getElementById('json').value = JSON.stringify({ cards: [] });
  await app.normalizeThenPreview();
  assert.deepEqual(seen, ['/formula/api/normalize']);
});

/* ===== 学科切换器 ===== */

test('学科切换器：单学科模式（只有一个选项）隐藏整个控件，不绑定跳转', () => {
  const { app, document, confirmCalls } = loadApp('demo');
  const select = document.getElementById('subjectSwitch');
  // 单学科模式下模板只渲染出一个 option
  const option = document.createElement('option');
  option.value = '/';
  option.textContent = '通用制卡';
  select.append(option);
  app.initSubjectSwitch();
  assert.equal(select.hidden, true);
  assert.equal(select.onchange, undefined);
  assert.equal(confirmCalls.length, 0);
});

test('学科切换器：多学科模式确认后跳转，并把选择记进 localStorage', () => {
  const { app, document, localStorage, confirmCalls } = loadApp('demo');
  const select = document.getElementById('subjectSwitch');
  for (const [value, text] of [['/demo/', '通用制卡'], ['/formula/', '公式示例']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = '/demo/';
  select.options[0].selected = true;
  app.initSubjectSwitch();
  assert.equal(select.hidden, false);

  select.value = '/formula/';
  select.onchange();
  assert.equal(confirmCalls.length, 1);
  assert.match(confirmCalls[0], /切换学科包会丢失当前页面进度/);
  assert.equal(localStorage.getItem('ankiCardMaker.subject'), '/formula/');
  assert.equal(document.location, undefined); // 跳转由 location.href 触发，fake DOM 里不校验
});

test('学科切换器：被隐藏的学科不出现在下拉里（设置里恢复后回来）', () => {
  const { app, document } = loadApp('demo', { storage: { 'cardflow.offline.hidden': JSON.stringify(['formula']) } });
  const select = document.getElementById('subjectSwitch');
  for (const [value, text] of [['/demo/', '通用制卡'], ['/formula/', '公式示例']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = '/demo/';
  select.options[0].selected = true;
  app.initSubjectSwitch();
  assert.deepEqual(select.options.map(option => option.value), ['/demo/'], '隐藏的学科要从下拉里移除');
  assert.equal(select.hidden, true, '只剩一个可见科目时整个下拉收起（没得选）');

  // 恢复：记录清掉后重新初始化，隐藏项回来
  const restored = loadApp('demo', { storage: { 'cardflow.offline.hidden': '[]' } });
  const again = restored.document.getElementById('subjectSwitch');
  for (const [value, text] of [['/demo/', '通用制卡'], ['/formula/', '公式示例']]) {
    const option = restored.document.createElement('option');
    option.value = value;
    option.textContent = text;
    again.append(option);
  }
  restored.app.initSubjectSwitch();
  assert.deepEqual(again.options.map(option => option.value), ['/demo/', '/formula/'], '恢复后隐藏项回来');
});

test('学科切换器：取消时还原选中项、不跳转也不记录', () => {
  const { app, document, localStorage, context, confirmCalls } = loadApp('demo');
  const select = document.getElementById('subjectSwitch');
  for (const [value, text] of [['/demo/', '通用制卡'], ['/formula/', '公式示例']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = '/demo/';
  select.options[0].selected = true;
  app.initSubjectSwitch();

  context.confirmResult = false;
  select.value = '/formula/';
  select.options[0].selected = false;
  select.options[1].selected = true;
  select.onchange();

  assert.equal(confirmCalls.length, 1, '取消也要走一次确认');
  assert.equal(localStorage.getItem('ankiCardMaker.subject'), null, '取消时不应写入 localStorage');
  assert.equal(select.value, '/demo/', '取消后选中项要还原');
});

test('学科切换器：进来时按当前页面地址认学科（人在公式页面上，不许还勾着生物）', () => {
  const { app, document, context } = loadApp('demo');
  const select = document.getElementById('subjectSwitch');
  for (const [value, text] of [['/demo/', '通用制卡'], ['/formula/', '公式示例']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  // 当前站在公式页面；第一个选项故意标成 selected，复现旧实现的错
  context.location.pathname = '/formula/';
  select.options[0].selected = true;
  select.value = '/demo/';
  app.initSubjectSwitch();
  assert.equal(select.value, '/formula/', '当前学科必须是公式');

  // 跨端口的完整 URL 选项也要认得出来
  const full = document.createElement('option');
  full.value = 'http://192.168.0.13:3213/';
  full.textContent = '高中公式（独立端口）';
  select.append(full);
  context.location.pathname = '/';
  assert.equal(app.subjectOptionForPage(select).value, 'http://192.168.0.13:3213/', '完整 URL 指向根路径时也要认得出');
});

test('学科切换器：本机导入的学科包也要在下拉里，并正确选中（与学科包列表同步）', () => {
  const { app, document, context } = loadApp('ielts');
  const select = document.getElementById('subjectSwitch');
  for (const [value, text] of [
    ['index-demo.html', '通用制卡'],
    ['index-wenyan-xhs-anki-cards.html', '高考语文'],
    ['pack:ielts-listening-replay-anki', '雅思英语听力重听备考 Anki 学科包']
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  // 本机导入的包用 document.write 原地重画，地址栏还是 index.html —— 只看地址会认错成生物
  context.location.pathname = '/index.html';
  app.initSubjectSwitch();
  assert.equal(select.value, 'pack:ielts-listening-replay-anki', '当前是导入的包，下拉要选中它而不是第一个（生物）');
});

test('学科切换器：切到本机导入的包会导航回选择页（带 ?pack=<id>），不再原地 document.write', () => {
  const { app, document, context } = loadApp('demo');
  const select = document.getElementById('subjectSwitch');
  for (const [value, text] of [['index-demo.html', '通用制卡'], ['pack:ielts-listening-replay-anki', '雅思英语听力重听备考 Anki 学科包']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  context.location.pathname = '/index-demo.html';
  app.initSubjectSwitch();

  select.value = 'pack:ielts-listening-replay-anki';
  select.onchange();
  assert.match(String(context.location.href), /index\.html\?pack=ielts-listening-replay-anki$/, '要整页回到选择页并带上要打开的包');
});

test('学科切换器：取消切换时回到切换前那项，而不是第一个选项（旧实现在这儿跳回生物）', () => {
  const { app, document, context, confirmCalls } = loadApp('demo');
  const select = document.getElementById('subjectSwitch');
  for (const [value, text] of [['/demo/', '通用制卡'], ['/formula/', '公式示例']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  context.location.pathname = '/formula/';
  app.initSubjectSwitch();
  assert.equal(select.value, '/formula/');

  context.confirmResult = false;
  select.value = '/demo/';
  select.onchange();
  assert.equal(confirmCalls.length, 1);
  assert.equal(select.value, '/formula/', '取消后要回到公式（当前学科）');
});

test('学科切换器：用绝对地址跳转，不会把路径越拼越长（旧 bug：/formula/formula/formula/…）', () => {
  const { app, document, context } = loadApp('formula');
  const select = document.getElementById('subjectSwitch');
  for (const [value, text] of [['formula/', '公式示例'], ['/demo/', '通用制卡']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  context.location.pathname = '/';
  context.confirmResult = true;
  app.initSubjectSwitch();
  select.value = 'formula/';
  select.onchange();
  assert.equal(context.location.href, 'http://127.0.0.1/formula/', '相对路径要解析成绝对地址');
});

test('扫码：https 页面上用 httpsPort 拼链接（3210 只跑 http，拼成 https://…:3210 打不开）', async () => {
  const env = qrEnv('demo', { addresses: ['192.168.0.13'], remote: ['100.124.20.74'], httpPort: 3210, httpsPort: 3212, mount: '/demo/' });
  env.context.location.protocol = 'https:';
  await env.app.refreshQr();
  assert.equal(env.app.byId('qrLink').querySelector('a').getAttribute('href'), 'https://192.168.0.13:3212/?token=tok-1');
  assert.equal(env.app.byId('qrRemote').querySelector('a').getAttribute('href'), 'https://100.124.20.74:3212/?token=tok-1');
  const calls = env.context.qrcode.calls;
  assert.equal(calls[calls.length - 1].data, 'https://192.168.0.13:3212/?token=tok-1');
});

/* ===== E1 导出为文件 / E2 扫码连接：公共夹具 ===== */

const EXPORT_CARDS = [
  { type: 'basic', priority: 'P1', tags: ['通用制卡'], front: '细胞膜的基本骨架是什么？', back: '磷脂双层', note: '' },
  { type: 'cloze', priority: 'P1', tags: ['通用制卡'], text: '细胞膜具有{{c1::选择透过性}}', note: '' }
];

/** 服务端 /api/network 的响应（addresses 已过滤回环 / 169.254 / VPN fake-IP）。 */
const NETWORK = { addresses: ['192.168.0.13'], httpPort: 3210, httpsPort: 3212, mount: '/demo/' };

/** 真实 Node 定时器（app.js 里的 setTimeout 被 fake DOM 换掉了，等它得靠这个）。 */
async function settle(times = 8) {
  for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve));
}

/** 造一个卡片类型勾选框并挂进文档（fake DOM 的 getElementById 不会把元素挂上去，querySelectorAll 就找不到）。 */
function cardTypeInput(env, value, checked) {
  const input = env.document.createElement('input');
  input.className = 'cardType';
  input.setAttribute('class', 'cardType');
  input.value = value;
  input.checked = checked === true;
  env.document.body.append(input);
  return input;
}
/** 造一个确认弹层里的类型勾选框（.exportType，可多选）并挂进文档，供 exportGateTypes() 读取。 */
function gateTypeInput(env, value, checked) {
  const existing = env.document.querySelectorAll('.exportType').find(box => box.value === value);
  if (existing) { existing.checked = checked === true; return existing; }
  const input = env.document.createElement('input');
  input.className = 'exportType';
  input.setAttribute('class', 'exportType');
  input.value = value;
  input.checked = checked === true;
  env.document.body.append(input);
  return input;
}
/** fake DOM 里 <a>.click() 不会跳转，所以抓住 createElement('a') 就能检查下载地址与文件名。 */
function trackDownloads(document) {
  const downloads = [];
  const original = document.createElement.bind(document);
  document.createElement = tag => {
    const element = original(tag);
    if (String(tag).toLowerCase() === 'a') downloads.push(element);
    return element;
  };
  return downloads;
}

function writeJson(document, cards, raw) {
  document.getElementById('json').value = raw === undefined ? JSON.stringify({ cards }) : raw;
}

/** 导出夹具：口令要在 app.js 跑完之后才写（否则 startApp() 会先发一串请求污染 seen）。 */
function exportEnv(subjectId = 'demo', over = {}) {
  const env = loadApp(subjectId, { instantTimers: true, ...over });
  env.localStorage.setItem(SUBJECT_SCRIPTS[subjectId].tokenKey, 'tok-1');
  env.downloads = trackDownloads(env.document);
  env.revoked = [];
  env.context.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: url => env.revoked.push(url) };
  env.seen = [];
  env.context.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    env.seen.push({ url, init, headers: init.headers || {}, body });
    return {
      status: 200,
      ok: true,
      headers: { get: name => (String(name).toLowerCase() === 'content-disposition' ? `attachment; filename="bio-2026-09-21-1432-${body.type}.txt"` : null) },
      blob: async () => ({ type: 'text/tab-separated-values', size: 8 }),
      json: async () => ({})
    };
  };
  return env;
}

/** 扫码夹具：同样在 app.js 跑完之后才写口令，再接管 fetch。 */
function qrEnv(subjectId = 'demo', payload = NETWORK, over = {}) {
  const env = loadApp(subjectId, over);
  env.localStorage.setItem(SUBJECT_SCRIPTS[subjectId].tokenKey, 'tok-1');
  env.seen = [];
  env.context.fetch = async url => { env.seen.push(url); return { status: 200, ok: true, json: async () => payload }; };
  return env;
}

/* ===== E2 扫码：地址来源、base 前缀、降级提示、复制链接 ===== */

test('扫码：当前页面就是从内网 IP 打开时优先用 location.hostname', async () => {
  const env = qrEnv('demo', NETWORK);
  env.context.location.hostname = '192.168.1.77';
  await env.app.refreshQr();

  const href = env.app.byId('qrLink').querySelector('a').getAttribute('href');
  assert.equal(href, 'http://192.168.1.77:3210/?token=tok-1');
  assert.equal(env.context.qrcode.calls[0].data, href);
});

test('扫码：单学科 base 是空串、多学科是 /chem，链接里都不出现 //', async () => {
  const single = qrEnv('demo', NETWORK);
  await single.app.refreshQr();
  assert.equal(single.app.byId('qrLink').querySelector('a').getAttribute('href'), 'http://192.168.0.13:3210/?token=tok-1');

  const multi = qrEnv('formula', { ...NETWORK, mount: '/formula/' });
  multi.context.window.__SUBJECT__.base = '/formula';
  await multi.app.refreshQr();
  const href = multi.app.byId('qrLink').querySelector('a').getAttribute('href');
  assert.equal(href, 'http://192.168.0.13:3210/formula/?token=tok-1');
  assert.equal(href.slice('http://'.length).includes('//'), false, '路径里不能拼出 //');
});

test('扫码：SUBJECT.base 末尾带斜杠时也不会拼出 //', async () => {
  const env = qrEnv('demo', NETWORK);
  env.context.window.__SUBJECT__.base = '/demo/';
  await env.app.refreshQr();
  assert.equal(env.app.byId('qrLink').querySelector('a').getAttribute('href'), 'http://192.168.0.13:3210/demo/?token=tok-1');
});

test('扫码：没有 addresses → #qrImage 里给中文提示，不抛错', async () => {
  const env = qrEnv('demo', { addresses: [], httpPort: 3210, httpsPort: 0, mount: '/' });
  await env.app.refreshQr();

  assert.match(env.app.byId('qrImage').textContent, /没有找到可用的内网地址/);
  assert.equal(env.context.qrcode.calls.length, 0);
});

test('扫码：qrcode 未加载 → 给中文提示，链接照旧可用', async () => {
  const env = qrEnv('demo', NETWORK, { loadQrcode: false });
  await env.app.refreshQr();

  assert.match(env.app.byId('qrImage').textContent, /二维码库未加载/);
  assert.match(env.app.byId('qrLink').textContent, /token=tok-1/);
});

test('扫码：没有口令时不请求 /api/network，也不生成二维码', async () => {
  const env = loadApp('demo');
  env.seen = [];
  env.context.fetch = async url => { env.seen.push(url); return { status: 200, ok: true, json: async () => NETWORK }; };
  await env.app.refreshQr();

  assert.deepEqual(env.seen, []);
  assert.equal(env.context.qrcode.calls.length, 0);
});

test('扫码：通过口令门后 startApp() 自动请求一次 /api/network 并渲染链接', async () => {
  const calls = [];
  const env = loadApp('demo', {
    token: 'tok-1',
    fetch: async url => {
      calls.push(url);
      return { status: 200, ok: true, json: async () => (url === '/api/network' ? NETWORK : {}) };
    }
  });
  await settle();

  assert.ok(calls.includes('/api/network'), `startApp() 应自动请求 /api/network，实际请求：${calls.join(', ')}`);
  assert.match(env.app.byId('qrLink').textContent, /token=tok-1/);
  assert.ok(env.app.byId('qrImage').querySelector('svg'));
});

test('扫码：有远程地址时多给一条「出门用」链路（Tailscale）', async () => {
  const env = qrEnv('demo', { addresses: ['192.168.0.13', '100.124.20.74'], remote: ['100.124.20.74'], httpPort: 3210, httpsPort: 3212, mount: '/demo/' });
  await env.app.refreshQr();

  const remoteBox = env.app.byId('qrRemote');
  const link = remoteBox.querySelector('a');
  assert.ok(link, '#qrRemote 里要有一条远程链接');
  assert.equal(link.getAttribute('href'), 'http://100.124.20.74:3210/?token=tok-1');
  assert.match(remoteBox.textContent, /出门用（Tailscale）/);
  // 二维码本身还是家里那条局域网地址（在家扫码最快）
  const calls = env.context.qrcode.calls;
  assert.equal(calls[calls.length - 1].data, 'http://192.168.0.13:3210/?token=tok-1');

  const copied = [];
  env.context.navigator.clipboard = { writeText: async text => { copied.push(text); } };
  await env.app.copyRemoteLink();
  assert.deepEqual(copied, ['http://100.124.20.74:3210/?token=tok-1']);
  assert.match(env.app.byId('status').textContent, /远程链接已复制/);
});

test('扫码：没有远程地址时不显示那一行，也不报错', async () => {
  const env = qrEnv('demo', NETWORK);
  await env.app.refreshQr();
  assert.equal(env.app.byId('qrRemote').textContent, '');
  assert.equal(env.app.byId('qrRemote').querySelector('a'), null);
});

test('复制链接：成功后给出中文反馈，复制的就是 #qrLink 里的链接', async () => {
  const env = qrEnv('demo', NETWORK);
  await env.app.refreshQr();
  const copied = [];
  env.context.navigator.clipboard = { writeText: async text => { copied.push(text); } };

  await env.app.copyQrLink();
  assert.deepEqual(copied, ['http://192.168.0.13:3210/?token=tok-1']);
  assert.match(env.app.byId('status').textContent, /链接已复制/);
});

test('复制链接：clipboard 不可用时提示手动复制，不抛异常', async () => {
  const env = qrEnv('demo', NETWORK);
  await env.app.refreshQr();
  await env.app.copyQrLink(); // navigator 是空对象，没有 clipboard
  assert.match(env.app.byId('status').textContent, /复制失败，请长按链接手动复制/);

  const empty = qrEnv('demo', NETWORK);
  await empty.app.copyQrLink();
  assert.match(empty.app.byId('status').textContent, /还没有可用链接/);
});

test('扫码：多学科模式下请求走 SUBJECT.base 前缀', async () => {
  const env = qrEnv('formula', NETWORK);
  env.context.window.__SUBJECT__.base = '/formula';
  await env.app.refreshQr();
  assert.deepEqual(env.seen, ['/formula/api/network']);
});

test('扫码：network 接口 401 时给出提示而不是抛错', async () => {
  const env = loadApp('demo');
  env.localStorage.setItem('cardflow.demo.token', 'tok-1');
  env.context.fetch = async () => ({ status: 401, ok: false, json: async () => ({ error: '未授权：请输入正确的访问口令。' }) });
  await env.app.refreshQr();
  assert.match(env.app.byId('qrImage').textContent, /无法读取内网地址/);
});


/* ===== 模型下拉：首次进入不该让用户手动点「获取模型」 ===== */

function modelFetch(calls, overrides = {}) {
  return async url => {
    const target = String(url);
    calls.push(target);
    const body = target.includes('/api/config')
      ? { apiUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', hasKey: true, hasSearch: true, hasZhihu: true }
      : target.includes('/api/models')
        ? (overrides.models || { models: ['deepseek-chat', 'deepseek-flash', 'deepseek-reasoner'] })
        : target.includes('/api/decks')
          ? { decks: ['Default'] }
          : target.includes('/api/network')
            ? { addresses: ['192.168.1.5'], httpPort: 3210, httpsPort: 3212, mount: '/demo/' }
            : {};
    const status = target.includes('/api/models') && overrides.models && overrides.models.__fail ? 400 : 200;
    return { status, ok: status === 200, json: async () => body, blob: async () => ({}), headers: { get: () => null } };
  };
}

test('首次进入（有口令、本地没记录）：自动拉取真实模型列表，并选中服务端配的模型', async () => {
  const calls = [];
  const env = loadApp('demo', { token: 'tok-model-1', fetch: modelFetch(calls) });
  await settle(20);

  const select = env.app.byId('model');
  assert.deepEqual(select.options.map(option => option.value), ['deepseek-chat', 'deepseek-flash', 'deepseek-reasoner'], '下拉里应是 provider 的真实模型');
  assert.equal(select.value, 'deepseek-flash', '应选中服务端 config 里配的模型，而不是列表最后一个');
  assert.ok(calls.some(url => url.endsWith('/api/models')), '应自动请求过模型列表');
  assert.ok(!select.options.some(option => option.value === 'gpt-4.1-mini'), '不该再出现 gpt-4.1-mini 这种占位模型');
});

test('本地已经存过模型：不重复请求模型列表，保留用户自己的选择', async () => {
  const calls = [];
  const env = loadApp('demo', {
    token: 'tok-model-2',
    fetch: modelFetch(calls),
    storage: { 'cardflow.demo.v1': JSON.stringify({ model: 'deepseek-chat' }) }
  });
  await settle(20);

  const select = env.app.byId('model');
  assert.equal(select.value, 'deepseek-chat');
  assert.ok(!calls.some(url => url.endsWith('/api/models')), '本地有记录就不该再自动请求');
});

test('模型列表拿不到时：不清空下拉、不弹错误打扰（静默降级）', async () => {
  const calls = [];
  const env = loadApp('demo', { token: 'tok-model-3', fetch: modelFetch(calls, { models: { __fail: true } }) });
  await settle(20);

  const select = env.app.byId('model');
  assert.deepEqual(select.options.map(option => option.value), ['deepseek-flash'], '失败时应保留服务端配的那个模型');
  assert.equal(select.value, 'deepseek-flash');
  assert.ok(!/无法获取模型/.test(env.app.byId('status').textContent), '自动拉取失败不该刷错误状态');
});

test('手动点「获取模型」：传的是选项对象而不是点击事件（silent 不能被误判）', async () => {
  const calls = [];
  const env = loadApp('demo', { token: 'tok-model-4', fetch: modelFetch(calls) });
  await settle(20);
  const before = calls.filter(url => url.endsWith('/api/models')).length;
  env.app.byId('loadModels').click();
  await settle(20);
  assert.equal(calls.filter(url => url.endsWith('/api/models')).length, before + 1, '点一次应只多发一次请求');
  assert.match(env.app.byId('status').textContent, /已读取 3 个模型/, '手动点要有状态反馈');
});
