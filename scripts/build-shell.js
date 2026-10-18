'use strict';
/*
 * 生成「安卓壳」要打进 APK 的离线网页资源。
 *
 * 目标：手机上装一个 APK，页面资源全在包里（不连远程站点），AI 请求走原生桥。
 *   - index.html         学科选择页（壳的入口）
 *   - index-<学科>.html  卡片页，由 public/index.html 用「单学科模式」渲染而来（与线上页面同一份模板）
 *   - shared/*.js        纯逻辑（模板渲染 / 宽容解析 / 卡片校验与导出 / 提示词），Node 与浏览器共用同一份
 *   - postprocess.js     公式标准化示例（src/postprocess/formula.js 原文嵌入）
 *   - prompt-data.js     提示词与学科配置（离线页没有服务器，这些得内联）
 *   - local-api.js       离线 API 适配器（把 /api/* 的请求接成本地实现）
 *   - 其余前端文件按 public/ 原样复制
 *
 * 用法：
 *   node scripts/build-shell.js                      # 输出到 android/app/src/main/assets
 *   node scripts/build-shell.js --out <目录>          # 输出到别处（测试用）
 */
const fs = require('node:fs');
const path = require('node:path');
const packSchema = require('../src/shared/pack-schema.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'src', 'shared');
const DEFAULT_OUT = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');

/* 前端要带进 APK 的文件：卡片页真正引用的那些，外加壳自己需要的几个（学科选择页是壳自己生成的，不需要服务端的 picker 脚本） */
const COPY_FILES = [
  'theme.css',
  'theme.js','core.js', 'files.js', 'app.js', 'workflow.js', 'local-api.js', 'backup-zip.js', 'pack-import.js', 'offline-download.js', 'offline-sync-off.js', 'settings.js', 'cardflow.css', 'manifest.json'];
const COPY_DIRS = ['vendor'];
const SHARED_ORDER = ['render.js', 'parse.js', 'cards.js', 'prompt.js', 'generate.js', 'media-note.js', 'webfetch.js', 'search.js', 'research.js'];
/* 只拷进包、不往卡片页里塞的共享文件：pack-schema.js 挂的是 window.CardFlowPacks（独立的全局），
   只有学科选择页要用；它的 validate 会盖掉 CardFlowShared.validate（卡片格式校验），绝不能进卡片页。 */
const EXTRA_SHARED = ['pack-schema.js'];

/** 读一个学科包需要的「制卡信息」：离线页没有服务器，提示词与张数/深度选项都得内联进包里。 */
function promptData(subjects) {
  const data = {};
  for (const subject of subjects) {
    data[subject.id] = {
      id: subject.id,
      name: subject.name,
      postprocess: Boolean(subject.postprocess),
      prompts: subject.prompts,
      cardCount: subject.cardCount,
      cardMode: subject.cardMode,
      defaultTags: (subject.anki && subject.anki.defaultTags) || [],
      defaultDeck: (subject.anki && subject.anki.defaultDeck) || '',
      search: subject.search || null
    };
  }
  return data;
}

/** 把 src/postprocess/formula.js 原文嵌成浏览器可用的模块（不改一个字符，只加一层壳）。 */
function postprocessFile() {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'postprocess', 'formula.js'), 'utf8');
  if (/\brequire\s*\(/.test(source)) throw new Error('src/postprocess/formula.js 里出现了 require，无法直接嵌进浏览器');
  return `/* 自动生成，请勿手改：src/postprocess/formula.js 原文嵌入（离线页里的公式标准化示例）。 */
(function (root) {
  var module = { exports: {} };
${source.replace(/^/gm, '  ')}
  root.CardFlowPostprocess = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

/** 离线页的补丁：把「服务器地址」换成「包内文件」、把远程 MathJax 换成包内副本、补上联网检索 Key 输入框。 */
function patchForOffline(html, subjects) {
  let out = html;
  // 学科下拉与学科切换器："/chem/" → "index-chem.html"（下拉的 value 和内联 __SUBJECT__ 里的 href 都是这个写法）
  for (const subject of subjects) out = out.split(`"/${subject.id}/"`).join(`"index-${subject.id}.html"`);
  // 「返回学科包列表」：回到离线选择页（页而里有两处指向 /）
  out = out.replace('<a class="cfBack" href="/"', '<a class="cfBack" href="index.html"');
  out = out.replace('<a href="/">返回学科包列表</a>', '<a href="index.html">返回学科包列表</a>');
  // 联网检索的 Key：电脑版读的是服务端 config.json；手机上没地方放，就在这里加一个只存本机的输入框
  const anchor = '<div class="muted">也可以手动检索：</div>';
  if (!out.includes(anchor)) throw new Error('public/index.html 里没找到「也可以手动检索」这一行，联网检索 Key 的输入框注入失败');
  out = out.replace(anchor, '<div class="searchRow"><span class="muted">检索 Key</span>'
    + '<input id="offlineSearchKey" type="password" placeholder="联网调研要用；只保存在本机" autocomplete="off" aria-label="检索服务 Key">'
    + '<button id="offlineKeyHelp" class="secondary" style="min-width:auto">说明</button></div>' + anchor);
  // 新手教程 / 自检：挂在「接口设置」面板里（第一次打开 App 会自动弹一次）
  const apiAnchor = '<summary>接口设置（API 地址与 Key）</summary>';
  if (!out.includes(apiAnchor)) throw new Error('public/index.html 里没找到「接口设置」面板，新手教程按钮注入失败');
  out = out.replace(apiAnchor, apiAnchor
    + '<div class="searchRow"><button id="offlineGuide" class="secondary">新手教程与自检</button>'
    + '<button id="offlineGuidePage" class="secondary">使用说明（可转发）</button></div>');
  // MathJax：离线要求「页面资源不连远程站点」，所以用包里的副本（tex-svg 输出，不需要字体文件）。
  // 化学公式要用 \ce{}（mhchem），它不在 combined 包里，得让 loader 从包内目录取。
  // 只有会做公式规范化的学科（化学）页面上才有 MathJax 脚本；其它学科这一步直接跳过。
  const cdn = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js';
  if (out.includes(cdn)) {
    const localMathJax = path.join(PUBLIC, 'vendor', 'mathjax', 'tex-svg.js');
    if (!fs.existsSync(localMathJax)) {
      console.warn('提示：public/vendor/mathjax/tex-svg.js 不存在，公式预览仍会去 CDN 取 MathJax（离线时公式不渲染）。');
    } else {
      out = out.split(cdn).join('/vendor/mathjax/tex-svg.js');
      const anchor = 'window.MathJax={loader:';
      if (!out.includes(anchor)) throw new Error('MathJax 配置注入失败：页面上有 MathJax 脚本，却找不到它的配置');
      out = out.replace(anchor, "window.MathJax={paths:{'[tex]':'/vendor/mathjax/input/tex'},loader:");
    }
  }
  return hideDesktopOnly(out);
}

/**
 * 离线版没有「电脑开服务、手机走局域网访问」那一套（内网地址 / 访问口令 / AnkiConnect / AnkiWeb 同步），
 * 入口留着只会让人以为坏了或者以为有用。
 *
 * 只隐藏、**绝不删 DOM**：app.js 初始化里就有 byId('changeToken').onclick = ...，
 * 把元素删掉会当场抛 TypeError，初始化从那里断掉，后面的 hideTokenGate() 跑不到
 * —— 真机上就因此一开 App 卡在「请输入访问口令」，整个页面都不工作。
 * offline-shell.test.js 里「app.js 引用的 id 都要在离线页里」就是防止再踩这个坑。
 */
function hideDesktopOnly(html) {
  let out = html;
  // 口令门：离线版没有服务端，local-api.js 已经把口令写好（getToken() 一定拿得到），
  // 但页面初始是显示的、要等 app.js 跑到 hideTokenGate 才藏 —— 会闪一下，干脆一开始就藏。
  out = out.replace('<div id="tokenGate" class="tokenGate">', '<div id="tokenGate" class="tokenGate" style="display:none">');
  // 「检测 AnkiConnect」：离线版探测的其实是 AnkiDroid 能不能直写，名字得跟着改
  out = out.replace('<button id="checkAnki" class="secondary">检测 AnkiConnect</button>', '<button id="checkAnki" class="secondary">检测 AnkiDroid</button>');
  // 访问口令 / 扫码连接（复制链接、刷新地址、复制远程链接）：页面就在本机，没有这回事
  out = out.replace('<button id="changeToken" class="secondary">', '<button id="changeToken" class="secondary" style="display:none">');
  out = out.replace('<details class="deckNew" id="qrBox">', '<details class="deckNew" id="qrBox" style="display:none">');
  // 同步 AnkiWeb：卡片直接写进 AnkiDroid，同步由 AnkiDroid 自己完成；「导入后自动同步」同理
  out = out.replace('<button id="syncAnki" class="secondary">', '<button id="syncAnki" class="secondary" style="display:none">');
  out = out.replace('<label class="muted" style="display:flex;align-items:center;gap:6px;margin:8px 0 0">', '<label class="muted" style="display:none">');
  // 联网调研：手机版两个通道都是 Tavily（知乎站内检索要服务端 SSE，手机走不了），
  // 所以不能把「仅知乎站内」当成默认 —— 那是电脑版的选项，在手机上选了也不会按它走。
  out = out.replace(
    '<select id="searchChannel" title="检索范围"><option value="zhihu">仅知乎站内</option><option value="global">全网搜索（含教辅站）</option><option value="tavily">Tavily 全网</option></select>',
    '<select id="searchChannel" title="检索范围"><option value="global">联网检索（默认）</option><option value="tavily">Tavily 全网</option><option value="zhihu">仅知乎站内（电脑版才有）</option></select>');
  return out;
}

/** 离线页要额外引入的脚本：纯逻辑 + 内联提示词 + 化学后处理 + 离线 API 适配器。 */
function extraScripts() {
  const tags = ['<script>window.CardFlowLocal = true;</script>'];
  for (const file of SHARED_ORDER) tags.push(`<script src="/shared/${file}"></script>`);
  tags.push('<script src="/postprocess.js"></script>', '<script src="/prompt-data.js"></script>', '<script src="/backup-zip.js"></script>', '<script src="/offline-download.js"></script>', '<script src="/offline-sync-off.js"></script>', '<script src="/local-api.js"></script>');
  // 卡片页也要能列出 / 打开「手机自己导入的学科包」：静态页里只有打包时带的学科，
  // 少了这两个脚本，学科下拉就与学科包列表对不上（真机反馈：两边未同步）。
  tags.push('<script src="/shared/pack-schema.js"></script>', '<script src="/pack-import.js"></script>');
  return tags.join('');
}

/** 壳的入口页：离线选择学科（纯文字 + 线条图标，不用 emoji）。 */
function pickerPage(subjects) {
  const items = subjects.map(subject => {
    // 学科包行统一由 pack-import.js 接管（支持长按菜单与「改过的包」），非学科包走静态页
    return `      <div class="packRow" data-id="${subject.id}" data-name="${subject.name}"${subject.pack ? ' data-pack="1"' : ''}>
`
      + `      <a class="cfPick" href="index-${subject.id}.html">
`
      + `        <span class="cfPickName">${subject.name}</span>
`
      + `        <span class="cfPickGo" aria-hidden="true">→</span>
`
      + `      </a>\n      </div>`;
  }).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CardFlow 卡流</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 28px 18px 40px; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
         background: linear-gradient(160deg, #eef5fa 0%, #f6f9ff 55%, #eefaf4 100%); color: #17263d; }
  .cfHead { display: flex; align-items: center; gap: 12px; margin: 0 0 22px; }
  .cfLogo { display: block; }
  h1 { font-size: 22px; margin: 0; letter-spacing: .5px; }
  h1 small { font-size: 13px; font-weight: 400; color: #65758e; margin-left: 6px; }
  .cfTagline { font-size: 13px; color: #65758e; margin-top: 4px; }
  .cfPick { display: flex; align-items: center; justify-content: space-between; gap: 12px; text-decoration: none;
            color: #17263d; background: rgba(255,255,255,.86); border: 1px solid rgba(161,185,221,.5);
            border-radius: 14px; padding: 18px 18px; margin: 0 0 12px; box-shadow: 0 4px 14px rgba(23,58,112,.06); }
  .cfPickName { font-size: 17px; font-weight: 600; }
  .cfPickHelp { padding: 14px 18px; }
  .cfPickHelp .cfPickName { font-size: 15px; font-weight: 500; color: #2a4a74; }
  .cfPickGo { color: #2269d1; font-size: 18px; }
  .cfNote { font-size: 12.5px; line-height: 1.7; color: #65758e; margin-top: 18px; }
  .cfNote b { color: #2a4a74; }
  .box { background: rgba(255,255,255,.86); border: 1px solid rgba(161,185,221,.5); border-radius: 14px; padding: 14px 16px; margin: 0 0 14px; }
  .box label { display: block; margin: 0 0 8px; }
  .box input[type=file] { font: inherit; max-width: 100%; }
  .packRow { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; }
  .packRow .cfPick { flex: 1; margin: 0; }
  .cfGear { margin-left: auto; flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px;
            border: 1px solid rgba(161,185,221,.6); background: rgba(255,255,255,.9); color: #496f8b; }
  /* 长按学科包弹出的操作菜单（编辑 / 复制 / 删除） */
  dialog.cfSheet { border: 0; border-radius: 18px 18px 0 0; padding: 6px 0 0; width: 100%; max-width: 100%;
                   margin: auto auto 0; background: #fff; color: #17263d; }
  dialog.cfSheet::backdrop { background: rgba(23,51,79,.35); }
  dialog.cfSheet h2 { margin: 14px 18px 4px; font-size: 15px; font-weight: 600; color: #265a82; }
  dialog.cfSheet button { display: block; width: 100%; box-sizing: border-box; text-align: left; font: inherit; font-size: 15px;
                          padding: 14px 18px; border: 0; border-top: 1px solid #eef3f8; background: #fff; color: #17263d; }
  dialog.cfSheet button.danger { color: #c0392b; }
  dialog.cfSheet button.cancel { text-align: center; color: #65758e; margin-top: 6px; border-top: 6px solid #f2f6fa; }
  /* 学科包编辑器（从设置里进去） */
  dialog.cfEditor { border: 1px solid rgba(161,185,221,.6); border-radius: 16px; width: min(640px, 94vw); max-height: 88vh;
                    padding: 18px; color: #17263d; background: #fff; }
  dialog.cfEditor::backdrop { background: rgba(23,51,79,.35); }
  dialog.cfEditor h2 { margin: 0 0 6px; font-size: 17px; }
  dialog.cfEditor textarea { display: block; width: 100%; box-sizing: border-box; min-height: 42vh; margin: 8px 0;
                    padding: 10px; font: 13px/1.5 ui-monospace, Consolas, monospace; color: #17263d;
                    background: #f9fcfe; border: 1px solid #cadbe7; border-radius: 12px; resize: vertical; }
  .cfEditorRow { display: flex; flex-wrap: wrap; gap: 8px; }
  .cfEditorRow button { font: inherit; padding: 11px 14px; border-radius: 12px; border: 1px solid #bed1e0; background: #f4f9fd; color: #265a82; }
  .cfEditorRow button.danger { border-color: #e2b6b0; color: #c0392b; background: #fdf5f4; }
  .cfEditorNote { font-size: 13px; color: #65758e; min-height: 18px; margin: 8px 0 0; }
  /* 设置面板里的「学科包」区块 */
  .cfPacks h3 { margin: 18px 0 4px; font-size: 15px; color: #265a82; }
  .cfPackItem { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid #eef3f8; font-size: 14px; }
  .cfPackItem .cfPackName { flex: 1; min-width: 0; }
  .cfPackItem button { font: inherit; font-size: 13px; padding: 8px 12px; border-radius: 10px; border: 1px solid #bed1e0; background: #f4f9fd; color: #265a82; }
  #packText { display: block; width: 100%; box-sizing: border-box; min-height: 96px; margin: 10px 0; padding: 10px;
              font: inherit; font-size: 13px; line-height: 1.55; color: #17263d; background: #fff;
              border: 1px solid rgba(161,185,221,.6); border-radius: 12px; resize: vertical; }
  .cfRow { display: flex; flex-wrap: wrap; gap: 8px; }
  .cfRow button { font: inherit; padding: 11px 14px; border-radius: 12px; border: 1px solid #bed1e0; background: #f4f9fd; color: #265a82; }
  dialog.cfSettings { border: 1px solid rgba(161,185,221,.6); border-radius: 16px; width: min(560px, 92vw); max-height: 85vh;
                      padding: 20px; color: #17263d; background: #fff; }
  dialog.cfSettings::backdrop { background: rgba(23,51,79,.35); }
  dialog.cfSettings h2 { margin: 0 0 6px; font-size: 18px; }
  .cfSettings label { display: block; margin: 14px 0; font-size: 14px; }
  .cfSettings input:not([type=checkbox]), .cfSettings select { display: block; width: 100%; box-sizing: border-box; margin-top: 6px;
              padding: 10px; font: inherit; border: 1px solid #cadbe7; border-radius: 8px; background: #f9fcfe; }
  .cfSettings p { font-size: 13px; color: #65758e; }
  .cfSettings button { font: inherit; padding: 10px 14px; margin: 6px 8px 0 0; border-radius: 10px;
              border: 1px solid #bed1e0; background: #f4f9fd; color: #265a82; }
  .ruleRow { display: flex; gap: 8px; align-items: center; margin: 9px 0; }
  .ruleRow textarea { flex: 1; min-width: 0; font: inherit; padding: 8px; border: 1px solid #cadbe7; border-radius: 8px; }
</style>  <link rel="stylesheet" href="/theme.css"><script src="/theme.js"></script>
<style>
.cfPackBox{margin:0 0 14px;border:1px dashed var(--cfLine,#cfd9e6);border-radius:12px;background:var(--cfPanel,rgba(255,255,255,.6));padding:0 12px 10px}
.cfPackBox>summary{cursor:pointer;padding:12px 0;font-weight:600;color:var(--cfInk,#22303f);list-style:none;display:flex;align-items:center;gap:8px}
.cfPackBox>summary::-webkit-details-marker{display:none}
.cfPackBox>summary::before{content:"▸";font-size:12px;opacity:.6;transition:transform .15s ease}
.cfPackBox[open]>summary::before{transform:rotate(90deg)}
.cfPackBox[open]{background:var(--cfPanel,transparent)}
.cfPackMsg{margin-top:10px;font-size:13px;line-height:1.6;color:var(--cfMuted,#65758e);word-break:break-word}
.cfPackMsg.isError{color:#c0392b;font-weight:600}
.cfPackMsg.isOk{color:#1e8449}
</style>
</head><body>
<main>
  <div class="cfHead">
    <img class="cfLogo" src="/icon-cardflow-192.png" alt="" width="48" height="48">
    <div>
      <h1>CardFlow <small>卡流</small></h1>
      <div class="cfTagline">拍照 → 卡片 → Anki</div>
    </div>
    <button id="globalSettings" class="cfGear" type="button" aria-label="全局设置" title="全局设置"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 4.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2Zm0 3.6a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/><rect x="10.75" y="1.2" width="2.5" height="4.6" rx="1.2"/><rect x="10.75" y="18.2" width="2.5" height="4.6" rx="1.2"/><rect x="1.2" y="10.75" width="4.6" height="2.5" rx="1.2"/><rect x="18.2" y="10.75" width="4.6" height="2.5" rx="1.2"/><g transform="rotate(45 12 12)"><rect x="10.75" y="1.2" width="2.5" height="4.6" rx="1.2"/><rect x="10.75" y="18.2" width="2.5" height="4.6" rx="1.2"/><rect x="1.2" y="10.75" width="4.6" height="2.5" rx="1.2"/><rect x="18.2" y="10.75" width="4.6" height="2.5" rx="1.2"/></g></svg></button>
  </div>
  <details class="cfPackBox" id="packBox">
    <summary>添加学科包</summary>
    <div class="box" id="packImportBox">
      <div class="muted">从电脑导出的学科包 .json 可以选文件导入，也可以直接把 JSON 粘在下面；装上后长按学科行可编辑 / 删除。</div>
      <textarea id="packText" placeholder="把学科包 JSON 粘贴到这里"></textarea>
      <div class="cfRow">
        <button id="packPrompt" class="secondary" type="button">复制「让 AI 生成学科包」提示词</button>
        <button id="packSave" class="secondary" type="button">导入 / 保存修改</button>
      </div>
      <label class="muted" for="packFile" style="display:block;margin:12px 0 6px">或者选择文件</label>
      <input id="packFile" type="file" accept="application/json,.json">
      <div class="muted" id="packHint">打包进 App 的学科包也能改（改的是本机副本，设置里能恢复默认）；长按学科行，可以编辑 / 复制 JSON / 删除。</div>
    </div>
    <div id="packNote" class="cfPackMsg" role="status" aria-live="polite"></div>
  </details>
  <div id="packList">
${items}
  </div>
  <div id="packExtra"></div>
  <a class="cfPick cfPickHelp" href="guide.html">
    <span class="cfPickName">新手使用说明（含常见问题）</span>
    <span class="cfPickGo" aria-hidden="true">→</span>
  </a>
</main>
<script src="/core.js"></script>
<script src="/shared/pack-schema.js"></script>
<script src="/pack-import.js"></script>
<script src="/settings.js"></script>
</body></html>
`;
}

/** 使用说明页（可转发）：手机上没有 "分享网页" 的现成路径，所以给一段纯文字 + 一键复制。 */
function guidePage(subjects) {
  const names = subjects.map(subject => subject.name).join('、');
  const text = [
    'CardFlow 卡流（手机版）使用说明',
    '',
    '1) 手机上装 AnkiDroid，并允许它的 API 访问；本 App 首次打开时允许「读写 AnkiDroid 数据库」。',
    '2) 在卡片页「接口设置」里填 AI 接口地址、Key、模型（只保存在这台手机，不会上传）。',
    '3) 拍照或选 PDF → 点「生成卡片」→ 检查 JSON/预览 → 点「导入 Anki」直接写入 AnkiDroid（不需要电脑）。',
    '4) 自动分层导入：在「配置与导入牌组」里打开后，AI 会给每张卡标 group，按层级建子牌组。',
    '5) 联网调研（可选）：在「联网调研」里填一个检索服务的 API Key，然后点「自动调研」。',
    '',
    `内置学科：${names}。`,
    '注：联网检索通过检索服务商完成（默认 Tavily，也可以用自己的 Key）；卡片样式用你 AnkiDroid 里已有的笔记类型。',
    '导入失败时会自动改打包 .apkg 交给 AnkiDroid（点一次确认即可），并会在状态栏说明原因。'
  ].join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CardFlow 使用说明</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 22px 16px 40px; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
         background: #f5f9fd; color: #17263d; line-height: 1.75; }
  h1 { font-size: 20px; margin: 0 0 14px; }
  h2 { font-size: 15px; margin: 22px 0 8px; color: #2a4a74; }
  ol, ul { padding-left: 22px; margin: 0 0 10px; }
  li { margin: 0 0 8px; }
  .box { background: #fff; border: 1px solid rgba(161,185,221,.5); border-radius: 12px; padding: 14px 16px; margin: 0 0 14px; }
  .muted { color: #65758e; font-size: 13px; }
  button, a.btn { font: inherit; padding: 10px 14px; border-radius: 10px; border: 1px solid #2269d1; background: #2269d1; color: #fff;
                 text-decoration: none; display: inline-block; margin: 0 8px 8px 0; }
  button.secondary, a.btn.secondary { background: #fff; color: #2269d1; }
</style><link rel="stylesheet" href="/theme.css"><script src="/theme.js"></script></head><body class="cfGuide">
<h1>CardFlow 手机版使用说明</h1>
<div class="box">
  <ol>
    <li>装 <b>AnkiDroid</b>，并在它的设置里允许 API 访问；本 App 首次打开时允许「读写 AnkiDroid 数据库」。</li>
    <li>卡片页「接口设置」里填 <b>AI 接口地址 / Key / 模型</b>（只保存在这台手机上）。</li>
    <li>拍照或选 PDF → 「生成卡片」→ 检查 → 点「导入 Anki」：卡片直接进 AnkiDroid，不需要电脑。</li>
    <li>「配置与导入牌组」里可以开<b>自动分层导入</b>：AI 给每张卡标 group，按层级建子牌组。</li>
    <li>要用<b>联网调研</b>就在「联网调研」里填一个检索服务的 API Key，然后点「自动调研」。</li>
  </ol>
</div>
<h2>常见问题</h2>
<div class="box">
  <ul>
    <li><b>导入失败</b>：会自动改成打包 .apkg 交给 AnkiDroid，点一次确认即可；原因会写在状态栏。</li>
    <li><b>卡片样式</b>：一键导入用你 AnkiDroid 里已有的笔记类型；想要 CardFlow 自己的模板就用「下载 .apkg」。</li>
    <li><b>音频卡没有声音</b>：靠手机系统的中文语音合成，没装中文语音就配不出音。</li>
    <li><b>公式不渲染</b>：化学页预览需要联网取 MathJax，断网时卡片内容与导入不受影响。</li>
    <li><b>换手机</b>：用「数据维护」里的导出备份，把包拷过去再恢复；或重新构建 APK 装上。</li>
  </ul>
</div>
<h2>转发给别人</h2>
<div class="box">
  <p class="muted">点下面按钮把说明文字复制出来，直接粘贴到微信/QQ 发人就行。</p>
  <button id="copyGuide">复制说明文字</button>
  <button id="backToCards" class="secondary">返回卡片页</button>
</div>
<script>
  var TEXT = ${JSON.stringify(text)};
  document.getElementById('copyGuide').addEventListener('click', function () {
    var button = this;
    var done = function () { button.textContent = '已复制'; setTimeout(function () { button.textContent = '复制说明文字'; }, 1500); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(TEXT).then(done, function () { alert('复制失败，请长按选择文字手动复制。'); }); return; }
    } catch (_) {}
    alert('复制失败，请长按选择文字手动复制。');
  });
  document.getElementById('backToCards').addEventListener('click', function () { location.href = 'index.html'; });
</script>
</body></html>
`;
}

/** 递归复制目录（vendor 下有子目录，比如 vendor/mathjax/input/tex/extensions） */
function copyTree(from, to, out, prefix) {
  const copied = [];
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) copied.push(...copyTree(source, target, out, relative));
    else { fs.copyFileSync(source, target); copied.push(relative); }
  }
  void out;
  return copied;
}

function copyInto(out) {
  const copied = [];
  for (const file of COPY_FILES) {
    const from = path.join(PUBLIC, file);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(from, path.join(out, file));
    copied.push(file);
  }
  for (const dir of COPY_DIRS) {
    const from = path.join(PUBLIC, dir);
    if (!fs.existsSync(from)) continue;
    copied.push(...copyTree(from, path.join(out, dir), out, dir));
  }
  for (const file of fs.readdirSync(PUBLIC)) {
    if (!/^icon-.*\.png$/.test(file)) continue;
    fs.copyFileSync(path.join(PUBLIC, file), path.join(out, file));
    copied.push(file);
  }
  // apple-touch-icon.png 在服务端是「由 icon-cardflow-192.png 现拼」的，这里直接复制一份同内容文件
  fs.copyFileSync(path.join(PUBLIC, 'icon-cardflow-192.png'), path.join(out, 'apple-touch-icon.png'));
  copied.push('apple-touch-icon.png');
  return copied;
}

function buildShell(options = {}) {
  const out = options.out || DEFAULT_OUT;
  // 借服务端的模板渲染：这样离线页与线上页面是同一份 HTML，不会出现两套排版
  process.env.ANKI_DISABLE_TTS = '1';
  const { ALL_SUBJECTS, renderSubjectTemplate } = require('../src/server.js');
  const template = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  // 默认只打自带的学科（subjects/*.json）；用户自己装的学科包（subject.pack）默认不进 APK，
  // 免得把自己的私人学科包一起发出去；确实想要就加 --all。
  // 默认把本机已装的学科包也一起打进去（这台的 APK 自己用）；要把 APK 发给别人时加 --builtin-only，
  // 避开自己的学科包（比如自己写的文言文包）。
  const subjects = options.builtinOnly ? ALL_SUBJECTS.filter(subject => !subject.pack) : ALL_SUBJECTS;
  const skipped = ALL_SUBJECTS.filter(subject => !subjects.includes(subject));
  if (skipped.length) console.log(`跳过的学科包：${skipped.map(subject => subject.id).join('、')}（--builtin-only 时只打自带的生物/化学）`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const written = [];
  let basePage = '';   // 第一个学科的页面：手机上导入新学科包时就以它为底板拼页面（差异只有几处）
  for (const subject of subjects) {
    const rendered = renderSubjectTemplate(subject, template, true);
    let html = patchForOffline(rendered, subjects);
    // 学科包页面：基础页 CSS 里写死的「◌  细胞 · 关系 · 过程」会跟着 data-subject 串过来，覆盖掉
    if (subject.pack) html = packSchema.injectPackCaption(html, subject);
    const anchor = '<script src="/app.js';
    if (!html.includes(anchor)) throw new Error('public/index.html 里没找到 app.js 的 script 标签，离线页无法注入脚本');
    html = html.replace(anchor, `${extraScripts()}${anchor}`);
    if (/\{\{[\w.$#/-]+\}\}/.test(html)) throw new Error(`index-${subject.id}.html 里还残留未替换的占位符`);
    fs.writeFileSync(path.join(out, `index-${subject.id}.html`), html);
    written.push(`index-${subject.id}.html`);
    if (!basePage) basePage = html;
  }
  // 手机上导入新学科包时用到的「底板」与基础学科配置
  fs.writeFileSync(path.join(out, 'base-page.html'), basePage);
  fs.writeFileSync(path.join(out, 'subject-base.json'), JSON.stringify(subjects[0].__raw || JSON.parse(fs.readFileSync(path.join(ROOT, 'subjects', `${subjects[0].id}.json`), 'utf8')), null, 2));
  fs.writeFileSync(path.join(out, 'pages.json'), JSON.stringify({
    base: subjects[0].id,
    // 学科包把原始 JSON 一并带上：手机上要能编辑（连打包进 APK 的那个也能改，改动存 localStorage 覆盖）
    subjects: subjects.map(subject => Object.assign(
      { id: subject.id, name: subject.name, page: `index-${subject.id}.html`, pack: Boolean(subject.pack) },
      subject.pack ? { json: subject.pack } : {}
    ))
  }, null, 2));
  written.push('base-page.html', 'subject-base.json', 'pages.json');
  fs.writeFileSync(path.join(out, 'index.html'), pickerPage(subjects));
  written.push('index.html');
  fs.writeFileSync(path.join(out, 'guide.html'), guidePage(subjects));
  written.push('guide.html');

  fs.mkdirSync(path.join(out, 'shared'), { recursive: true });
  for (const file of [...SHARED_ORDER, ...EXTRA_SHARED]) {
    fs.copyFileSync(path.join(SHARED, file), path.join(out, 'shared', file));
    written.push(`shared/${file}`);
  }
  fs.writeFileSync(path.join(out, 'postprocess.js'), postprocessFile());
  written.push('postprocess.js');

  const data = promptData(subjects);
  fs.writeFileSync(path.join(out, 'prompt-data.js'),
    `/* 自动生成，请勿手改：来自 subjects/*.json 与 prompts/*.md（离线页没有服务器，制卡信息内联在这里）。 */\n`
    + `window.CardFlowPrompts = ${JSON.stringify(data, null, 2).replace(/</g, '\\u003c')};\n`);
  written.push('prompt-data.js');

  written.push(...copyInto(out));
  return { out, subjects: subjects.map(subject => subject.id), written };
}

module.exports = { buildShell, promptData, postprocessFile, DEFAULT_OUT, COPY_FILES, SHARED_ORDER, EXTRA_SHARED };

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  try {
    const result = buildShell({ out: at >= 0 ? path.resolve(args[at + 1]) : DEFAULT_OUT, builtinOnly: args.includes('--builtin-only'), all: args.includes('--all') });
    console.log(`离线资源已生成：${result.out}`);
    console.log(`学科页：${result.subjects.map(id => `index-${id}.html`).join('、')}；共 ${result.written.length} 个文件`);
  } catch (error) {
    console.error(`生成失败：${error.message}`);
    process.exit(1);
  }
}
