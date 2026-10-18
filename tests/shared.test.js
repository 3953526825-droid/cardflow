'use strict';
/*
 * src/shared/ 的质量门槛（安卓壳的离线页与 Node 服务端共用这一份实现）：
 *   1) 服务端导出的必须是 shared 里的同一个函数对象 —— 一旦有人「顺手复制一份」，这条会立刻红；
 *   2) 浏览器侧（没有 module / require 的环境）按离线页的 <script> 顺序能正常挂到 window.CardFlowShared；
 *   3) 几个容易被改坏的行为：宽容解析抢救、卡片校验、导出转义、提示词变量与附加说明。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const shared = require('../src/shared');
const server = require('../src/server.js');

/** 离线页的引入顺序（见 scripts/build-shell.js 的 SHARED_ORDER） */
const SHARED_ORDER = ['render.js', 'parse.js', 'cards.js', 'prompt.js', 'generate.js', 'media-note.js', 'webfetch.js', 'search.js', 'research.js'];

/** 在一个「没有 module、没有 require」的沙箱里按顺序执行 shared 文件，模拟安卓壳的离线页 */
function loadInBrowser() {
  const sandbox = { console, window: {}, URL, TextEncoder, TextDecoder };
  // 离线页里 public/core.js 先于 shared/*.js 加载：遮挡卡与音频卡的细节校验要用它
  sandbox.window.CardFlowCore = require('../public/core.js');
  const context = vm.createContext(sandbox);
  SHARED_ORDER.forEach(file => vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'src', 'shared', file), 'utf8'), context, { filename: file }));
  return sandbox.window;
}

const EXPORTS = [
  'renderTemplate', 'parseSections',
  'extractFirstJson', 'extractBalanced', 'salvageCards', 'normalizeCards', 'parseGeneratedJson',
  'cardIssue', 'validate', 'countCardTypes', 'cardTitles', 'escapeExportField', 'exportFields', 'exportText', 'deckForCard',
  'referenceLimit', 'buildPrompt',
  'generateMessages', 'chatRequest', 'parseGenerated', 'retryPrompt', 'parseRetry',
  'cleanFetchedText', 'frameNoiseCount', 'fetchLimit',
  'rankByDomains', 'cleanSearchResults', 'tavilySearch', 'aiChat', 'webSearch', 'searchOnce', 'runResearch'
];

test('服务端用的是 shared 里的同一份实现（不是各自一份拷贝）', () => {
  assert.equal(server.buildPrompt, shared.buildPrompt);
  assert.equal(server.validate, shared.validate);
  assert.equal(server.extractFirstJson, shared.extractFirstJson);
  assert.equal(server.exportText, shared.exportText);
  assert.equal(server.renderTemplate, shared.renderTemplate);
});

test('离线页：按 <script> 顺序加载后，所有纯逻辑都挂在 window.CardFlowShared 上', () => {
  const win = loadInBrowser();
  assert.ok(win.CardFlowShared, 'window.CardFlowShared 没挂上');
  EXPORTS.forEach(name => assert.equal(typeof win.CardFlowShared[name], 'function', `${name} 缺失`));
  assert.ok(Array.isArray(win.CardFlowShared.RETRY_ANGLES) && win.CardFlowShared.RETRY_ANGLES.length > 0, '重试方向清单要在');
});

test('离线页与 Node 结果一致：宽容解析、导出转义、牌组归属', () => {
  const win = loadInBrowser();
  const broken = '```json\n{"cards":[{"type":"basic","front":"水是 \\(\\ce{H2O}\\)","back":"ok"},{坏卡}, {"type":"cloze","text":"只有 {{c1::一个}} 填空","note":"备注\\t带制表符"}],}\n```';
  assert.equal(JSON.stringify(win.CardFlowShared.salvageCards(broken)), JSON.stringify(shared.salvageCards(broken)));
  const cards = [
    { type: 'basic', front: '正面\t带制表符', back: '背面\n第二行', note: '备注' },
    { type: 'cloze', text: '含 {{c1::答案}} 的句子', note: '' }
  ];
  assert.equal(win.CardFlowShared.exportText(cards, ['通用制卡']), shared.exportText(cards, ['通用制卡']));
  const cache = new Map();
  assert.equal(win.CardFlowShared.deckForCard({ group: '第 3 节' }, '生物', true, cache), shared.deckForCard({ group: '第 3 节' }, '生物', true, new Map()));
});

test('离线页与 Node 结果一致：提示词与「只允许这些类型」的附加说明', () => {
  const win = loadInBrowser();
  const chem = server.ALL_SUBJECTS.find(subject => subject.id === 'demo');
  const options = { minCards: 6, maxCards: 9, extraRules: '多考实验误差', intensity: '深入', reference: '调研内容', maxReference: 500 };
  assert.equal(win.CardFlowShared.buildPrompt(chem, options), shared.buildPrompt(chem, options));

  const data = { url: 'https://example.com/v1', key: 'k', model: 'm', images: ['data:image/png;base64,AA'], enabledTypes: ['cloze'], autoGroup: true, groupRule: '按章节', sources: [{ file: 'a.pdf', page: 2 }] };
  const content = shared.generateMessages(chem, data);
  assert.equal(JSON.stringify(win.CardFlowShared.generateMessages(chem, data)), JSON.stringify(content));
  const text = content[0].text;
  assert.match(text, /本次只允许输出这些卡片 type：cloze/, '只勾填空卡时要明确告诉模型');
  assert.match(text, /自动分层导入已开启/, '开自动分层时要带上分组要求');
  assert.match(text, /按章节/, '分组规则要进提示词');
  // 图片按顺序作为 image_url 追加，最后一项是图片
  assert.equal(content.filter(item => item.type === 'image_url').length, 1);
  assert.equal(content.at(-1).image_url.url, data.images[0]);
});

test('离线页与 Node 结果一致：请求体（地址、温度、消息形状）', () => {
  const win = loadInBrowser();
  const chem = server.ALL_SUBJECTS.find(subject => subject.id === 'demo');
  const bio = server.ALL_SUBJECTS.find(subject => subject.id === 'demo');
  const data = { url: 'https://example.com/v1/', key: 'k', model: 'm', images: ['data:image/png;base64,AA'] };
  const content = shared.generateMessages(bio, data);
  const mine = win.CardFlowShared.chatRequest(chem, data, content);
  const theirs = shared.chatRequest(chem, data, content);
  assert.equal(mine.url, theirs.url);
  assert.equal(mine.url, 'https://example.com/v1/chat/completions', '末尾斜杠不能拼成 //');
  assert.equal(mine.init.body, theirs.init.body);
  assert.equal(JSON.parse(shared.chatRequest(bio, data, content).init.body).temperature, 0.2, '其它学科用 0.2');
  assert.equal(JSON.parse(mine.init.body).messages[0].content.at(-1).type, 'image_url');
});

test('调研内容注入上限：默认 20000，非法值回落默认，硬上限 60000', () => {
  assert.equal(shared.referenceLimit(undefined), 20000);
  assert.equal(shared.referenceLimit(0), 20000);
  assert.equal(shared.referenceLimit('abc'), 20000);
  assert.equal(shared.referenceLimit(120), 500, '低于下限按 500 算');
  assert.equal(shared.referenceLimit(999999), 60000, '高于上限按 60000 算');
});

test('离线页判卡片格式时报的错与服务端一致（遮挡框越界、填空卡只用 c1）', () => {
  const win = loadInBrowser();
  const cases = [
    { type: 'basic', front: '', back: 'x' },
    { type: 'cloze', text: '出现 {{c2::第二个}} 编号' },
    { type: 'occlusion', image: 'data:image/png;base64,AA', masks: [{ x: 0.9, y: 0.1, w: 0.5, h: 0.2 }] },
    { type: 'audio', front: '朗读', back: '答案', audio: 'data:audio/mpeg;base64,AA' },
    { type: 'unknown' }
  ];
  for (const card of cases) {
    assert.equal(win.CardFlowShared.cardIssue(card), shared.cardIssue(card), JSON.stringify(card));
  }
  assert.match(shared.cardIssue(cases[1]), /只能使用 c1/);
});

test('离线页里 Tavily 检索的行为与电脑版一致（请求体、清洗、偏好站点排序）', async () => {
  const win = loadInBrowser();
  const calls = [];
  const transport = async request => {
    calls.push(request);
    return { status: 200, body: JSON.stringify({ results: [
      { url: 'https://www.zhihu.com/question/1', title: '知乎', content: '这是一段足够长的正文内容，用来验证清洗与排序，汉字数量足够多，不会被清洗规则当成短内容丢掉。' },
      { url: 'https://x.example.net/a', title: '普通', content: '另一段足够长的正文内容，用来验证非偏好站点排序靠后，汉字数量同样足够多，不会被丢掉。' }
    ] }) };
  };
  const found = await win.CardFlowShared.tavilySearch(transport, 'tvly-k', '原电池 考点', 4, { domains: ['zhihu.com'] });
  const sent = JSON.parse(calls[0].body);
  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal(calls[0].headers.authorization, 'Bearer tvly-k');
  assert.equal(calls[0].timeout, 45000);
  assert.deepEqual(sent, { query: '原电池 考点', max_results: 4, search_depth: 'advanced' });
  assert.equal(found.provider, 'Tavily', '底层返回服务商名，通道标签（全网 / 站内）由上层 webSearch 加');
  assert.match(found.results[0].title, /^★ zhihu\.com/);
  // 站内检索时才限定域名（手机版用 Tavily 模拟知乎站内）
  await win.CardFlowShared.webSearch({ transport, subject: { search: { preferredDomains: [] } }, key: 'k', query: 'q', maxResults: 2, options: { channel: 'zhihu' } });
  assert.deepEqual(JSON.parse(calls[1].body).include_domains, ['zhihu.com']);
  assert.equal((await win.CardFlowShared.webSearch({ transport, subject: { search: { preferredDomains: [] } }, key: 'k', query: 'q', maxResults: 2, options: {} })).provider, 'Tavily 全网');
});

test('build-shell 生成的离线页：资源齐全、没有残留占位符、脚本按顺序注入', () => {
  const { buildShell } = require('../scripts/build-shell.js');
  const os = require('node:os');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cardflow-shell-'));
  try {
    const result = buildShell({ out });
    assert.deepEqual(result.subjects, ['demo']);
    // 默认把本机已装的学科包也一起打进 APK（自己的包自己用）；--builtin-only 只打自带的两个
    const builtin = buildShell({ out: path.join(out, 'builtin'), builtinOnly: true });
    assert.deepEqual(builtin.subjects, ['demo']);
    for (const file of ['index.html', 'index-demo.html', 'guide.html', 'base-page.html', 'subject-base.json', 'pages.json', 'prompt-data.js', 'postprocess.js', 'local-api.js', 'backup-zip.js', 'pack-import.js', 'app.js', 'cardflow.css', 'shared/parse.js', 'shared/webfetch.js']) {
      assert.ok(fs.existsSync(path.join(out, file)), `缺少 ${file}`);
    }
    const demoPage = fs.readFileSync(path.join(out, 'index-demo.html'), 'utf8');
    assert.ok(!/\{\{[\w.$#/-]+\}\}/.test(demoPage), '还有没替换掉的占位符');
    assert.ok(demoPage.includes('window.CardFlowLocal = true'), '离线开关没注入');
    const order = ['/shared/render.js', '/shared/parse.js', '/shared/cards.js', '/shared/prompt.js', '/shared/generate.js', '/shared/media-note.js', '/shared/webfetch.js', '/shared/search.js', '/shared/research.js', '/postprocess.js', '/prompt-data.js', '/backup-zip.js', '/local-api.js'];
    let last = -1;
    for (const tag of order) {
      const at = demoPage.indexOf(tag);
      assert.ok(at > last, `${tag} 顺序不对`);
      last = at;
    }
    assert.ok(demoPage.indexOf('/local-api.js') < demoPage.indexOf('/app.js'), '离线适配器必须在 app.js 之前注入');
    // 手机版没有服务端 config.json，联网检索的 Key 要有一个只存本机的输入框
    assert.ok(demoPage.includes('id="offlineSearchKey"'), '联网检索 Key 输入框没注入');
    // 新手教程：入口按钮 + 可转发的说明页
    assert.ok(demoPage.includes('id="offlineGuide"'), '新手教程按钮没注入');
    const guide = fs.readFileSync(path.join(out, 'guide.html'), 'utf8');
    assert.ok(guide.includes('复制说明文字'), '说明页要有「复制说明文字」按钮');
    assert.ok(guide.includes('通用制卡'), '说明页要列出内置学科');
    const picker = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(picker, /class="packRow" data-id="demo" data-name="通用制卡"/, '选择页行要带 data-id/data-name（长按隐藏与设置恢复靠它）');
    const settingsSource = fs.readFileSync(path.join(out, 'settings.js'), 'utf8');
    assert.match(settingsSource, /cardflow\.offline\.hidden/, '设置脚本要读写隐藏记录');
    assert.ok(picker.includes('guide.html'), '学科选择页要有说明入口');
    assert.ok(picker.includes('id="packFile"') && picker.includes('/pack-import.js'), '学科选择页要能导入学科包');
    assert.ok(picker.includes('/shared/pack-schema.js'), '导入校验要用共享的学科包规则');
    // 学科选择页与学科切换都指向包内文件，不能指向服务器路径
    assert.ok(demoPage.includes('"index-demo.html"'), '学科切换链接没改成离线页');
    assert.ok(!demoPage.includes('"/demo/"'), '还残留服务器挂载路径');
    const data = fs.readFileSync(path.join(out, 'prompt-data.js'), 'utf8');
    assert.match(data, /window\.CardFlowPrompts = \{/);
    assert.ok(data.includes('你是应试 Anki 制卡引擎'), '示例学科提示词没内联进来');
    assert.ok(!data.includes('</script'), '内联数据里不能出现能提前闭合的 </script');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
