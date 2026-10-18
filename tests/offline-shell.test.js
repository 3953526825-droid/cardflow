'use strict';
/*
 * 安卓壳（离线资源）的契约：
 *   1) 学科选择页要有「粘贴导入 / AI 生成提示词 / 长按编辑菜单 / 设置里的学科包编辑」——这些是电脑版有、手机版一度全丢的东西；
 *   2) 学科包行里不再摆显眼的红色「删除」按钮（真机反馈：影响观感），改成按住弹菜单；
 *   3) 离线页不该再出现「电脑开服务」那套入口（扫码连接、修改访问口令、同步 AnkiWeb），
 *      检测 AnkiConnect 在手机上其实是探测 AnkiDroid，名字要跟着改；
 *   4) **只能隐藏不能删 DOM**：app.js 初始化里就有 byId('changeToken').onclick，
 *      删掉会抛异常中断初始化，后面的 hideTokenGate() 跑不到 —— 真机上就因此一开 App 卡在口令门；
 *   5) 学科包页面不能残留基础学科（生物）的文案 —— 「◌ 细胞 · 关系 · 过程」等全是真机反馈过的串味问题。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildShell } = require('../scripts/build-shell.js');
const server = require('../src/server.js');

const ROOT = path.join(__dirname, '..');
const packSubject = server.ALL_SUBJECTS.find(subject => subject.pack) || null;
const BASE_ONLY_TEXT = ['重点生成概念对比卡', '如 第一章', '内容较多时优先完整覆盖'];
const HIDDEN_ONLY_IDS = ['changeToken', 'syncAnki', 'qrBox', 'autoSync', 'tokenGate', 'checkAnki'];

let ctx = null;
function assets() {
  if (ctx) return ctx;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cardflow-shell-'));
  buildShell({ out });
  const read = name => fs.readFileSync(path.join(out, name), 'utf8');
  ctx = {
    out, read,
    picker: read('index.html'), bio: read('index-demo.html'), base: read('base-page.html'),
    pack: packSubject ? read(`index-${packSubject.id}.html`) : '',
    pages: JSON.parse(read('pages.json'))
  };
  return ctx;
}
process.on('exit', () => { if (ctx) fs.rmSync(ctx.out, { recursive: true, force: true }); });

test('学科选择页：粘贴导入、AI 提示词、长按编辑、设置里的学科包编辑都在', () => {
  const html = assets().picker;
  assert.match(html, /id="packText"/, '要有直接粘贴 JSON 的输入框（以前只能选文件）');
  assert.match(html, /id="packSave"/, '要有「导入 / 保存修改」按钮');
  assert.match(html, /id="packPrompt"/, '要有「复制让 AI 生成学科包的提示词」按钮');
  assert.match(html, /id="packFile"/, '选择文件的老入口要保留');
  assert.match(html, /id="globalSettings"/, '全局设置入口（分条规则 + 显示与功能开关）不能再丢');
  assert.match(html, /src="\/settings\.js"/, '全局设置的实现脚本要打进包');
  assert.match(html, /src="\/core\.js"/, 'settings.js 依赖 core.js');
  assert.match(html, /src="\/pack-import\.js"/);
  assert.match(html, /src="\/shared\/pack-schema\.js"/);
  assert.match(html, /长按学科行，可以编辑/, '要告诉用户长按能编辑');
  assert.doesNotMatch(html, /\{\{/, '不该残留未替换的占位符');
});

test('学科包入口：收在学科列表上方的折叠块里，收起只显示「添加学科包」', () => {
  const html = assets().picker;
  const boxAt = html.indexOf('id="packBox"');
  const listAt = html.indexOf('通用制卡');
  assert.ok(boxAt > -1 && listAt > -1 && boxAt < listAt, '学科包入口要排在学科列表（通用制卡）之前');
  assert.match(html, /<details class="cfPackBox" id="packBox">\s*<summary>添加学科包<\/summary>/, '收起时只显示「添加学科包」');
  assert.ok(!html.includes('装 / 改学科包（粘贴 JSON）'), '旧的冗长标题不再占位');
});

test('学科包行里不再摆红色「删除」按钮（改成长按菜单）', () => {
  const html = assets().picker;
  assert.ok(!html.includes('cfDrop'), '行内的删除按钮要去掉');
  assert.ok(!html.includes('data-hide'), '隐藏逻辑改由长按菜单触发');
  for (const marker of ['actionSheet', 'longPress', 'settingsSection']) {
    assert.ok(fs.readFileSync(path.join(ROOT, 'public', 'pack-import.js'), 'utf8').includes(marker), `pack-import.js 要有 ${marker}`);
  }
});

test('设置面板要能挂上「编辑学科包」区块（手机）', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'public', 'settings.js'), 'utf8');
  assert.ok(settings.includes('CardFlowPacks.settingsSection'), 'settings.js 要提供挂载钩子');
  const packs = fs.readFileSync(path.join(ROOT, 'public', 'pack-import.js'), 'utf8');
  assert.match(packs, /function settingsSection\(\)/, 'pack-import.js 要提供这个区块');
  assert.match(packs, /恢复默认/, '改过打包进来的包要能恢复默认');
  assert.match(packs, /openEditor/, '要有学科包编辑器');
});

test('卡片页也要带上学科包脚本：下拉才能列出/打开本机导入的包（两边同步）', () => {
  const html = assets().bio;
  assert.match(html, /src="\/shared\/pack-schema\.js"/, '卡片页需要 pack-schema（拼学科包页面）');
  assert.match(html, /src="\/pack-import\.js"/, '卡片页需要 pack-import（catalog / openPack / 补下拉）');
});

test('本机导入的包在下拉里用 pack:<id>；选择页按 ?pack=<id> 自动打开（静态页没有，运行时补）', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'pack-import.js'), 'utf8');
  assert.match(source, /href: `pack:\$\{item\.id\}`/, '本机导入的包用 pack:<id> 作为下拉值');
  assert.match(source, /function syncSubjectOptions\(\)/, '卡片页要能把本机导入的包补进学科下拉');
  assert.match(source, /\[\?&\]pack=\(\[\^&\]\+\)/, '选择页要认 ?pack=<id> 这个入口');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /index\.html\?pack=\$\{encodeURIComponent\(id\)\}/, '切到本机包要导航到选择页，不能原地 document.write');
});

test('离线页：电脑专属入口隐藏或改名，AnkiWeb 同步不再出现', () => {
  const html = assets().bio;
  assert.match(html, /<button id="checkAnki" class="secondary">检测 AnkiDroid<\/button>/, '手机上探测的是 AnkiDroid，不是 AnkiConnect');
  assert.ok(!html.includes('检测 AnkiConnect'), '不该再叫 AnkiConnect');
  assert.match(html, /<button id="syncAnki" class="secondary" style="display:none">/, '同步 AnkiWeb 要藏起来');
  assert.match(html, /<button id="changeToken" class="secondary" style="display:none">/, '修改访问口令在离线版没有意义');
  assert.match(html, /id="qrBox" style="display:none"/, '扫码连接整块要收起来');
  assert.match(html, /<label class="muted" style="display:none">/, '「导入后自动同步」开关跟着 AnkiWeb 一起收起来');
  assert.ok(html.includes('id="clearConfig"'), '「清除本机配置」还有用，要留着');
});

test('口令门默认就是藏着的（离线版没有服务端，不该闪出来）', () => {
  assert.match(assets().bio, /<div id="tokenGate" class="tokenGate" style="display:none">/);
});

test('app.js 引用的每一个 id 都必须在离线页里（删 DOM 会把初始化打断）', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const ids = [...new Set([...app.matchAll(/byId\(\s*'([^']+)'\s*\)/g)].map(match => match[1]))];
  assert.ok(ids.length > 50, '至少要扫到几十个 id，说明扫描本身是有效的');
  for (const file of ['index-demo.html']) {
    const html = assets().read(file);
    const missing = ids.filter(id => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `${file} 缺少 app.js 引用的元素：${missing.join('、')}`);
  }
});

test('离线页隐藏的那几个元素必须还在 DOM 里（只是 display:none）', () => {
  const html = assets().bio;
  for (const id of HIDDEN_ONLY_IDS) assert.ok(html.includes(`id="${id}"`), `${id} 必须还在 DOM 里，只是被隐藏`);
});

test('学科包页面不残留基础学科（生物）的文案', () => {
  if (!packSubject) {
    console.log('这台机器上没有装学科包，跳过（生成逻辑仍由 pack-page.test.js 的逐字比对保护）');
    return;
  }
  const html = assets().pack;
  for (const text of BASE_ONLY_TEXT) assert.ok(!html.includes(text), `学科包页面不该出现基础学科文案：${text}`);
  assert.ok(html.includes('.drop:after{content:none !important;}'), '资料框里不要任何学科文案（真机反馈：方框里不要出现文言文/细胞这类预置内容）');
  assert.ok(html.includes(packSubject.name), '学科包自己的名字该在的地方（标题）仍然在');
});

test('基础学科页自己的文案要保留（别把覆盖做过头）', () => {
  const html = assets().base;
  assert.ok(html.includes('重点生成概念对比卡'), '示例学科的额外规则文案要留着');
  assert.ok(html.includes('◌  概念 · 关系 · 过程'), '示例页的资料框副标题要留着');
  assert.ok(!html.includes('.drop:after{content:'), '基础页不该被插入学科包的覆盖样式');
});

test('卡片数量：两个输入框各有「最少 / 最多」标签，不再只靠一行小字', () => {
  const html = assets().base;
  assert.match(html, /<span class="muted" style="display:block;font-size:12px">最少<\/span><input id="minCards"/);
  assert.match(html, /<span class="muted" style="display:block;font-size:12px">最多<\/span><input id="maxCards"/);
});

test('pages.json 带上学科包的原始 JSON（手机上才能编辑打包进来的包）', () => {
  const pages = assets().pages;
  const bio = pages.subjects.find(item => item.id === 'demo');
  assert.ok(bio && !bio.json, '内置学科不是学科包，不该带 json');
  if (!packSubject) return;
  const packed = pages.subjects.find(item => item.id === packSubject.id);
  assert.ok(packed && packed.pack, '打包的学科包要在清单里');
  assert.equal(packed.json.id, packSubject.id, 'json 就是可编辑的那份学科包数据');
  assert.ok(packed.json.prompts && packed.json.prompts.generate, '提示词要带全，编辑才有意义');
});

test('手机上改过的学科包要能真的生效（local-api 的 mine() 优先读本机修改）', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'local-api.js'), 'utf8');
  assert.match(source, /cardflow\.offline\.overrides/, '要读本机修改');
  assert.match(source, /storedOverrides\(\)\[SUBJECT\.id\]\s*\|\|\s*storedPacks\(\)\[SUBJECT\.id\]/, '优先级：本机改过的 > 手机导入的');
});

test('页面引用的本地资源都要真的打进包里（少一个就是 404，整块功能直接哑掉）', () => {
  const out = assets().out;
  // /shared/pack-schema.js 就踩过这个坑：构建只拷 SHARED_ORDER 里的文件，
  // 选择页引用了它却不在包里 → 404 → 学科包导入/编辑全部报「页面脚本没加载完」。
  const pages = ['index.html', 'index-demo.html', 'guide.html', 'base-page.html'];
  if (packSubject) pages.push(`index-${packSubject.id}.html`);
  const missing = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(out, page), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
      const ref = match[1].split('?')[0].split('#')[0];
      if (ref.endsWith('/')) continue;
      if (!fs.existsSync(path.join(out, ref.slice(1)))) missing.push(`${page} -> ${ref}`);
    }
  }
  assert.deepEqual(missing, [], '这些引用在包里找不到：' + missing.join('、'));
  // 这些是脚本里 fetch 的（不在 src/href 里）
  for (const asset of ['base-page.html', 'pages.json', 'subject-base.json', 'pack-import.js', 'offline-download.js', 'settings.js', 'core.js', 'shared/pack-schema.js', 'prompt-data.js', 'postprocess.js', 'backup-zip.js', 'local-api.js']) {
    assert.ok(fs.existsSync(path.join(out, asset)), `包里缺 ${asset}`);
  }
});

test('离线版不预设检索服务商，也不再有必然失败的自动同步', () => {
  const html = assets().bio;
  assert.ok(!html.includes('Tavily Key'), '不能出现「Tavily Key」这种把服务商写死的标签');
  assert.match(html, /检索 Key/, '改成中立的「检索 Key」');
  assert.match(html, /src="\/offline-sync-off\.js"/, '自动同步要钉死为关，否则每次导入都会追一条失败提示');
  assert.ok(fs.existsSync(path.join(assets().out, 'offline-sync-off.js')));
  const source = fs.readFileSync(path.join(ROOT, 'public', 'offline-sync-off.js'), 'utf8');
  assert.match(source, /defineProperty\(box, 'checked'/, '要用实例上的 checked 取值把开关钉死');
});

test('离线页多带一个 blob 下载适配器（导出/备份/诊断在 WebView 里才有反应）', () => {
  assert.match(assets().bio, /src="\/offline-download\.js"/);
  const source = fs.readFileSync(path.join(ROOT, 'public', 'offline-download.js'), 'utf8');
  assert.match(source, /CardFlowNative/);
  assert.match(source, /saveFile/);
});
