'use strict';
/*
 * 手机端学科包存储（public/pack-import.js）的门槛：
 * 真机反馈过的 bug —— 新导入的学科包被当成「改内置包」塞进 overrides，
 * 结果选择页列表根本刷不出来（list 只列 packs）。这里把「存哪份」这条规则钉住：
 *   手机自己导入的包 → cardflow.offline.packs（列表才看得到）
 *   与打包进 App 的学科同 id 的修改 → cardflow.offline.overrides（保留「恢复默认」）
 *
 * 不引 jsdom：复用 tests/helpers/dom.js 的极简 DOM，用 vm 跑 pack-import.js。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, createLocalStorage, installById } = require('./helpers/dom.js');

const ROOT = path.resolve(__dirname, '..');
const PACK_SCHEMA = require('../src/shared/pack-schema.js');

const PAGES = {
  base: 'demo',
  subjects: [
    { id: 'demo', name: '通用制卡', page: 'index-demo.html', pack: false },
    { id: 'chem', name: '高中化学', page: 'index-chem.html', pack: false },
    {
      id: 'wenyan-xhs-anki-cards', name: '高考语文', page: 'index-wenyan-xhs-anki-cards.html', pack: true,
      json: {
        schemaVersion: 1, id: 'wenyan-xhs-anki-cards', exam: '高考', subject: '语文', name: '高考语文',
        cardCount: { min: 5, max: 20 },
        search: { subjectPrefix: '文言文', catalogSuffix: '考点', preferredDomains: [] },
        prompts: { generate: 'g', reference: 'r', identify: 'i', locate: 'l' }
      }
    }
  ]
};

function loadPackImport(storage = {}) {
  const localStorage = createLocalStorage(storage);
  const document = createDocument();
  const sandbox = {
    console, setTimeout, clearTimeout, queueMicrotask,
    localStorage,
    document,
    navigator: {},
    fetch: async url => {
      const body = url === '/pages.json' ? JSON.stringify(PAGES)
        : url === '/subject-base.json' ? '{}'
        : url === '/base-page.html' ? '<html></html>' : null;
      if (body == null) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => body };
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.CardFlowPacks = PACK_SCHEMA;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'pack-import.js'), 'utf8'), sandbox, { filename: 'pack-import.js' });
  return { api: sandbox.window.CardFlowPacks, localStorage, document };
}

function pack(overrides = {}) {
  return {
    schemaVersion: 1, id: 'cf-temp-test', exam: '高考', subject: '测试', name: '临时测试包',
    cardCount: { min: 5, max: 20 },
    search: { subjectPrefix: '测试', catalogSuffix: '考点', preferredDomains: [] },
    prompts: {
      generate: '你是测试制卡引擎。范围 {{min}}–{{max}} 张，按资料出卡。',
      reference: '调研内容如下：{{reference}}；只用于判断重点。',
      identify: '识别本页属于哪一章哪一节，范围 {{min}}–{{max}}。',
      locate: '定位引用：{{topic}} {{keypoints}} {{evidence}}。'
    },
    ...overrides
  };
}

const read = (localStorage, key) => JSON.parse(localStorage.getItem(key) || 'null');

test('新导入的学科包存进 packs，并出现在可选列表里（真机 bug 的回归）', async () => {
  const { api, localStorage } = loadPackImport();
  await api.savePack(JSON.stringify(pack()), null);

  assert.deepEqual(Object.keys(read(localStorage, 'cardflow.offline.packs')), ['cf-temp-test']);
  assert.equal(localStorage.getItem('cardflow.offline.overrides'), null, '新包不该落到 overrides');

  const item = (await api.catalog()).find(entry => entry.id === 'cf-temp-test');
  assert.ok(item, '导入后要能在 catalog 里找到');
  assert.equal(item.local, true);
  assert.equal(item.modified, false);
});

test('与打包进 App 的学科同 id：修改存进 overrides（保留恢复默认）', async () => {
  const { api, localStorage } = loadPackImport();
  await api.savePack(JSON.stringify(pack({ id: 'wenyan-xhs-anki-cards', name: '改过的语文' })), null);

  assert.deepEqual(Object.keys(read(localStorage, 'cardflow.offline.overrides')), ['wenyan-xhs-anki-cards']);
  assert.equal(localStorage.getItem('cardflow.offline.packs'), null, '内置包的修改不该落到 packs');

  const item = (await api.catalog()).find(entry => entry.id === 'wenyan-xhs-anki-cards');
  assert.equal(item.modified, true);
  assert.equal(item.name, '改过的语文');
});

test('改本机已有的包：仍留在 packs，不重复写 overrides', async () => {
  const { api, localStorage } = loadPackImport();
  await api.savePack(JSON.stringify(pack()), null);
  await api.savePack(JSON.stringify(pack({ name: '改过的临时包' })), 'cf-temp-test');

  assert.deepEqual(Object.keys(read(localStorage, 'cardflow.offline.packs')), ['cf-temp-test']);
  assert.equal(read(localStorage, 'cardflow.offline.packs')['cf-temp-test'].name, '改过的临时包');
  assert.equal(localStorage.getItem('cardflow.offline.overrides'), null);
});

test('学科下拉清单包含本机导入的包（值用 pack:<id>），与学科包列表同步（真机反馈）', async () => {
  const { api } = loadPackImport();
  await api.savePack(JSON.stringify(pack()), null);

  const list = await api.subjectList();
  assert.deepEqual([...list.map(item => item.id)], ['demo', 'chem', 'wenyan-xhs-anki-cards', 'cf-temp-test']);

  const local = list.find(item => item.id === 'cf-temp-test');
  assert.equal(local.href, 'pack:cf-temp-test', '本机导入的包没有静态页，值用 pack:<id> 交给 openPack');
  const packaged = list.find(item => item.id === 'wenyan-xhs-anki-cards');
  assert.equal(packaged.href, undefined, '打包的学科走静态页，不用额外 href');
});

test('卡片页的学科下拉会补上本机导入的包，并同步改过的名字（静态页与列表同步）', async () => {
  const { api, document } = loadPackImport();
  await api.savePack(JSON.stringify(pack()), null);

  const select = document.createElement('select');
  for (const [value, text] of [['index-demo.html', '通用制卡'], ['index-wenyan-xhs-anki-cards.html', '旧名字']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  installById(document, 'subjectSwitch', select);

  await api.syncSubjectOptions();
  assert.deepEqual([...select.options].map(option => option.value),
    ['index-demo.html', 'index-wenyan-xhs-anki-cards.html', 'pack:cf-temp-test']);
  assert.equal(select.options[1].textContent, '高考语文', '打包的学科名字要跟着本机修改走');
  assert.equal(select.options[2].textContent, '临时测试包', '本机导入的包要出现在下拉里');
});

test('非法学科包直接报错，且不写任何存储', async () => {
  const { api, localStorage } = loadPackImport();
  await assert.rejects(() => api.savePack(JSON.stringify(pack({ id: 'Bad_ID' })), null), /id/);
  assert.equal(localStorage.getItem('cardflow.offline.packs'), null);
  assert.equal(localStorage.getItem('cardflow.offline.overrides'), null);
});

test('复制给 AI 的学科包提示词里不再有裸 {"cards" 例子（真机导入失败的根因）', () => {
  const { api } = loadPackImport();
  assert.equal(typeof api.PACK_PROMPT, 'string');
  assert.ok(api.PACK_PROMPT.length > 50);
  assert.ok(!api.PACK_PROMPT.includes('{"cards"'), '提示词正文里不能出现带英文双引号的例子，否则 AI 照抄会截断 JSON');
  assert.match(api.PACK_PROMPT, /不要出现英文双引号/, '要明确要求提示词文本里用单引号');
});
