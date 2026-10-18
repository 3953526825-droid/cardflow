'use strict';
/*
 * 用真实 src/server.js 渲染两个学科的页面，断言：
 *   1) 渲染结果里没有残留的 {{...}} 占位符；
 *   2) 渲染出来的 HTML 保存到 tests/.tmp/rendered-<学科>.html；
 *   3) 渲染结果与对应参考文件（Bio2Anki / Chem2Anki）逐字对比，列出差异（应只剩本次明确改动的那几处）。
 *
 * 用法：node tests/tools/render-subjects.js
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const { startServer } = require('../helpers/harness');

const REFERENCE = {
  bio: 'C:/Users/Administrator/Bio2Anki/public/index.html',
  chem: 'C:/Users/Administrator/Chem2Anki/public/index.html'
};

/** 逐行/逐段找出两段文本的第一处差异，并给出上下文，便于人读。 */
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { index: i, a: a.slice(Math.max(0, i - 120), i + 240), b: b.slice(Math.max(0, i - 120), i + 240) };
}

async function main() {
  const server = await startServer({ multi: true });
  try {
    const results = {};
    for (const id of ['bio', 'chem']) {
      const response = await fetch(`${server.base}/${id}/`);
      const html = await response.text();
      const file = path.join(PROJECT_ROOT, 'tests', '.tmp', `rendered-${id}.html`);
      fs.writeFileSync(file, html);
      const leftovers = [...new Set(html.match(/\{\{[^}]*\}\}/g) || [])];
      const reference = fs.readFileSync(REFERENCE[id], 'utf8');
      const diff = firstDiff(html, reference);
      results[id] = { status: response.status, length: html.length, file, leftovers, same: html === reference, diff };
    }

    // 报告
    for (const id of ['bio', 'chem']) {
      const r = results[id];
      console.log(`==== ${id} ====`);
      console.log(`  HTTP ${r.status}，渲染 ${r.length} 字符 -> ${path.relative(PROJECT_ROOT, r.file)}`);
      console.log(`  残留 {{...}}：${r.leftovers.length ? r.leftovers.join(' ') : '（无）'}`);
      console.log(`  与参考文件逐字相同：${r.same ? '是' : '否'}`);
      if (!r.same) {
        console.log(`  第一处不同在第 ${r.diff.index} 字符：`);
        console.log(`    渲染: ${JSON.stringify(r.diff.a)}`);
        console.log(`    参考: ${JSON.stringify(r.diff.b)}`);
      }
    }

    // 关键内容抽查：两个学科各自的差异点必须真的被渲染出来
    const bioHtml = fs.readFileSync(results.bio.file, 'utf8');
    const chemHtml = fs.readFileSync(results.chem.file, 'utf8');
    const checks = [
      ['bio <title>Bio2Anki</title>', bioHtml.includes('<title>Bio2Anki</title>')],
      ['chem <title>Chem2Anki</title>', chemHtml.includes('<title>Chem2Anki</title>')],
      ['bio theme-color #2269d1', bioHtml.includes('content="#2269d1"')],
      ['chem theme-color #117c9c', chemHtml.includes('content="#117c9c"')],
      ['bio viewport-fit=cover', bioHtml.includes('viewport-fit=cover')],
      ['chem 无 viewport-fit', !chemHtml.includes('viewport-fit')],
      ['bio 模式控件 id="clozeWeight"', bioHtml.includes('<select id="clozeWeight">')],
      ['chem 模式控件 id="depth"', chemHtml.includes('<select id="depth">')],
      ['bio min/max 25/35', bioHtml.includes('id="minCards" type="number" min="1" max="100" value="25" aria-label="最少卡片数"')],
      ['chem min/max 18/28 且无 aria-label', chemHtml.includes('value="18">') && chemHtml.includes('value="28">') && !chemHtml.includes('aria-label="最少卡片数"')],
      ['bio 填空卡提示', bioHtml.includes('定义、名词、精确数值仍使用普通卡')],
      ['chem 无填空卡提示', !chemHtml.includes('定义、名词、精确数值仍使用普通卡')],
      ['bio 无 formulaHelp 块', !bioHtml.includes('<details class="formulaHelp">')],
      ['chem 有 formulaHelp 块', chemHtml.includes('<details class="formulaHelp"><summary>化学表达式与导入格式说明</summary>')],
      ['chem 有 MathJax/mhchem 注入（需要服务器把 subject.previewNormalizes 加进 computedValues）', chemHtml.includes('tex-mml-chtml.js') && chemHtml.includes("load:['[tex]/mhchem']")],
      ['bio 无 MathJax（bio 的公式块必须被服务器删掉）', !bioHtml.includes('tex-mml-chtml.js')],
      ['bio 无 data-subject 的 html/body', bioHtml.includes('<html lang="zh-CN" data-subject="bio">') && bioHtml.includes('<body data-subject="bio">')],
      ['chem 的 html/body 带 data-subject', chemHtml.includes('<html lang="zh-CN" data-subject="chem">') && chemHtml.includes('<body data-subject="chem">')],
      ['bio 引入 app.js?v=stable2', bioHtml.includes('<script src="/bio/app.js?v=stable2"></script>')],
      ['chem 引入 app.js?v=chem2', chemHtml.includes('<script src="/chem/app.js?v=chem2"></script>')],
      ['bio 注入 window.__SUBJECT__', bioHtml.includes('window.__SUBJECT__ = {"id":"bio"')],
      ['chem 注入 window.__SUBJECT__', chemHtml.includes('window.__SUBJECT__ = {"id":"chem"')],
      ['bio 有学科切换器（两项）', (bioHtml.match(/<option value="\/bio\/" selected>高中生物<\/option><option value="\/chem\/">高中化学<\/option>/) || []).length === 1],
      ['chem 有学科切换器（chem 默认选中）', (chemHtml.match(/<option value="\/bio\/">高中生物<\/option><option value="\/chem\/" selected>高中化学<\/option>/) || []).length === 1],
      ['bio 的 manifest/图标走 /bio/ 前缀', bioHtml.includes('href="/bio/manifest.json"') && bioHtml.includes('href="/bio/apple-touch-icon.png"') && bioHtml.includes('href="/bio/icon-192.png"')]
    ];
    console.log('==== 关键内容抽查 ====');
    let failed = 0;
    for (const [name, ok] of checks) {
      if (!ok) failed++;
      console.log(`  ${ok ? '✔' : '✖'} ${name}`);
    }
    const leftoverTotal = results.bio.leftovers.length + results.chem.leftovers.length;
    console.log(`结论：残留占位符 ${leftoverTotal} 个；抽查 ${checks.length} 项，失败 ${failed} 项。`);

    /* ===== MathJax 条件块：验证模板语法本身，并指出服务器缺的那个 key ===== */
    const serverModule = require(path.join(PROJECT_ROOT, 'src', 'server.js'));
    const template = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), 'utf8');
    console.log('==== MathJax 条件块（{{#subject.previewNormalizes}}）====');
    const chemSubject = serverModule.ALL_SUBJECTS.find(item => item.id === 'chem');
    const withoutKey = serverModule.renderSubjectTemplate(chemSubject, template);
    // 复制一份 renderSubjectTemplate 的实现，把缺的 computed key 与布尔判断补上，验证模板语法本身没问题
    const lookup = (subject, key) => key.split('.').reduce((value, part) => (value == null ? value : value[part]), subject);
    const truthy = value => {
      if (typeof value === 'boolean') return value;
      if (Array.isArray(value)) return value.length > 0;
      return String(value == null ? '' : value).trim() !== '';
    };
    const renderWithExtras = (subject, extras) => {
      const withConditionals = String(template).replace(/\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, body) => {
        const value = key in extras ? extras[key] : lookup(subject, key);
        return truthy(value) ? body : '';
      });
      return withConditionals.replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
        const value = key in extras ? extras[key] : lookup(subject, key);
        return value === undefined || value === null ? '' : String(value);
      });
    };
    const withKey = renderWithExtras(chemSubject, { 'subject.previewNormalizes': chemSubject.previewNormalizes });
    const bioSubject = serverModule.ALL_SUBJECTS.find(item => item.id === 'bio');
    const bioWithKey = renderWithExtras(bioSubject, { 'subject.previewNormalizes': bioSubject.previewNormalizes });
    const rendered = { chem: withKey, bio: bioWithKey };
    // 只看 <style> 之后的部分，并用 MathJax 的 CDN 地址判别（window.__SUBJECT__ 的 JSON 里含 previewNormalizes 字样）
    const afterStyle = html => html.slice(html.indexOf('</style>'));
    const hasMathJax = html => afterStyle(html).includes('tex-mml-chtml.js');
    console.log(`  当前 src/server.js 渲染 chem：含 MathJax = ${hasMathJax(withoutKey)}`);
    console.log(`  computedValues 补 'subject.previewNormalizes': subject.previewNormalizes 后渲染 chem：含 MathJax = ${hasMathJax(rendered.chem)}`);
    console.log(`  同样补上后渲染 bio：含 MathJax = ${hasMathJax(rendered.bio)}（应为 false）`);
    console.log(`  两者补 key 后的渲染结果仍无残留占位符：${!/\{\{/.test(withKey) && !/\{\{/.test(bioWithKey)}`);
    console.log(`  （chem.json 里 previewNormalizes = ${JSON.stringify(chemSubject.previewNormalizes)}；`);
    console.log('    renderSubjectTemplate 的 lookupSubject 查的是 subject 对象上的 subject.previewNormalizes，');
    console.log('    而 computedValues() 目前只给了 subject.base / subject.viewportFit，缺这一个 key。）');
    process.exitCode = leftoverTotal || failed ? 1 : 0;
  } finally {
    await server.stop();
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });
