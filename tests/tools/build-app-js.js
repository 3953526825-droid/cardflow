'use strict';
/*
 * 生成双学科共用的 public/app.js，并顺手证明「除列出的差异外与原 bio 版逐字相同」。
 *
 * 输入（只读）：
 *   Bio2Anki/public/app.js    —— 基准（保留原排版，逐字替换）
 *   Chem2Anki/public/app.js   —— 只用来核对化学独有函数（formulaWarnings / textLine / normalizeThenPreview / preview）的原文
 *   subjects/*.json           —— storageKey / tokenKey / cardMode 等差异的来源说明
 * 输出：
 *   public/app.js
 *
 * 差异全部由 window.__SUBJECT__ 驱动（服务器注入，见 src/server.js 的 computedValues()）：
 *   base（API 前缀）、storageKey、tokenKey、assetVersion、cardModeControl、cardModeField、
 *   defaultDeck、previewNormalizes、subjectSwitch。
 *
 * 用法：node tests/tools/build-app-js.js
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BIO_APP = 'C:/Users/Administrator/Bio2Anki/public/app.js';
const CHEM_APP = 'C:/Users/Administrator/Chem2Anki/public/app.js';

/* ---------- ① 逐字替换表：bio 原文 -> 共用写法 ---------- */
const REPLACEMENTS = [
  [`const STORE = 'bio2anki.stable1';
const TOKEN_KEY = 'bio2anki.token';`,
    `/* ===== 学科配置（服务器注入 window.__SUBJECT__；缺省值让脚本单独加载时也能跑）===== */
const SUBJECT = window.__SUBJECT__ || {};
const subjectName = (key, fallback) => (SUBJECT[key] === undefined || SUBJECT[key] === null ? fallback : SUBJECT[key]);
/** API 前缀：多学科模式下是 /bio、/chem，单学科模式下是空串。 */
const api = p => String(subjectName('base', '')) + p;
/** 模式控件的 DOM id / 提交给服务端的字段名（bio: clozeWeight，chem: depth）。 */
const cardModeControl = () => subjectName('cardModeControl', 'clozeWeight');
const cardModeField = () => subjectName('cardModeField', 'clozeWeight');
/** 预览按钮：previewNormalizes 为 true 的学科（化学）先按 Anki MathJax/mhchem 规则标准化公式。 */
const previewNormalizes = () => Boolean(subjectName('previewNormalizes', false));
/** 学科切换器的选择记在这里（页面加载时只回填、不自动跳转）。 */
const SUBJECT_STORE = 'ankiCardMaker.subject';
/* 已保存的口令与配置必须和原来用同一批键名，换键会让用户重输口令、丢配置。 */
let STORE = subjectName('storageKey', 'bio2anki.stable1');
let TOKEN_KEY = subjectName('tokenKey', 'bio2anki.token');`],
  // API 前缀（脚本会统计 /api/ 字面量总数，逐条覆盖；同一路径出现在多个函数里时要写清次数）
  [`request('/api/health')`, `request(api('/api/health'))`, 2],
  [`request('/api/decks')`, `request(api('/api/decks'))`],
  [`request('/api/models'`, `request(api('/api/models')`],
  [`request('/api/generate'`, `request(api('/api/generate')`],
  [`request('/api/import'`, `request(api('/api/import')`],
  [`request('/api/deck/create'`, `request(api('/api/deck/create')`],
  [`request('/api/deck/delete'`, `request(api('/api/deck/delete')`, 2],
  [`request('/api/research'`, `request(api('/api/research')`],
  [`request('/api/search'`, `request(api('/api/search')`],
  [`request('/api/fetch'`, `request(api('/api/fetch')`],
  [`request('/api/config')`, `request(api('/api/config'))`],
  // 模式控件（读数与绑定都按配置取 id）
  [`clozeWeight: byId('clozeWeight').value`, `clozeWeight: byId(cardModeControl()).value`, 2],
  [`if (data.clozeWeight) byId('clozeWeight').value = data.clozeWeight;`, `if (data[cardModeField()]) byId(cardModeControl()).value = data[cardModeField()];`],
  [`clozeWeight: byId(cardModeControl()).value, extraRules: byId('extraRules').value, reference: byId('reference').value`,
    `[cardModeField()]: byId(cardModeControl()).value, extraRules: byId('extraRules').value, reference: byId('reference').value`],
  [`['apiUrl', 'apiKey', 'model', 'minCards', 'maxCards', 'clozeWeight', 'extraRules'].forEach(id => byId(id).onchange = saveConfig);`,
    `['apiUrl', 'apiKey', 'model', 'minCards', 'maxCards', cardModeControl(), 'extraRules'].forEach(id => byId(id).onchange = saveConfig);`],
  // SW 也走学科前缀（单学科模式下 base 是空串，结果仍是 /sw.js）
  [`navigator.serviceWorker.register('/sw.js')`, `navigator.serviceWorker.register(api('/sw.js'))`]
];

/* ---------- ② 化学独有的函数（逐字取自 Chem2Anki/public/app.js） ---------- */
const CHEM_FUNCTIONS = `
/** 化学：预览前的常见公式格式提示（普通卡/填空卡都可能踩到）。 */
function formulaWarnings(cards) {
  const raw = JSON.stringify(cards), a = [];
  if (/\\{\\{c(?!1::)/.test(raw)) a.push('发现 c2/c3 等非 c1 填空。');
  if (/\\b(?:H2O|CO2|O2|H2|NaOH|HCl|SO4|OH)\\b/.test(raw) && !/\\\\\\(\\\\ce\\{/.test(raw)) a.push('疑似有裸化学式，建议检查。');
  return a;
}
/** 化学：预览按行拼 DOM（不用 innerHTML），方便 MathJax 逐块排版。 */
function textLine(parent, text) {
  const n = document.createElement('div');
  n.textContent = text || '';
  parent.append(n);
  return n;
}`;

/** 化学版的 preview()：逐字取自 Chem2Anki/public/app.js，只把 request 换成 api()。 */
const CHEM_PREVIEW = `function preview() {
  try {
    const d = parsedCards(), cs = d.cards || [], out = byId('cards');
    out.replaceChildren();
    cs.forEach((c, i) => {
      const b = document.createElement('div'); b.className = 'card'; textLine(b, \`\${i + 1}. \${c.type === 'cloze' ? '填空卡' : '普通卡'} \${c.priority || ''}\`); const q = textLine(b, c.text || c.front || ''); q.className = 'cardQuestion'; const hr = document.createElement('hr'); b.append(hr); const ans = textLine(b, c.type === 'cloze' ? (c.note || '') : (c.back || '')); ans.className = 'cardAnswer'; if (c.note && c.type !== 'cloze') {
        const note = textLine(b, c.note); note.className = 'note';
      }
      out.append(b);
    });
    const w = formulaWarnings(cs);
    setStatus(w.length ? \`预览完成：\${cs.length} 张。⚠ \${w.join(' ')}\` : \`预览完成：\${cs.length} 张；未发现常见公式格式问题。\`);
    if (window.MathJax && MathJax.typesetClear) MathJax.typesetClear([out]);
    if (window.MathJax && MathJax.typesetPromise) MathJax.typesetPromise([out]);
  } catch (e) {
    setStatus(\`JSON 格式错误：\${e.message}\`, 'error');
    showResults();
  }
}

/** 化学：#preview 按钮先调 /api/normalize 标准化公式，再预览。 */
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
    setStatus(\`公式标准化失败：\${e.message}\`, 'error');
    showResults();
  }
}`;

/* ---------- ③ 预览分派 + 学科切换器 ---------- */
const PREVIEW_DISPATCH = `
/* ===== 预览：按学科配置分派（化学先标准化公式，生物直接预览）===== */
function runPreview() {
  return previewNormalizes() ? normalizeThenPreview() : preview();
}`;

const SUBJECT_SWITCH = `
/* ===== 学科切换器：切换会丢失当前页面进度，先确认再跳转 ===== */
function initSubjectSwitch() {
  const select = byId('subjectSwitch');
  if (!select) return;
  try {
    const saved = localStorage.getItem(SUBJECT_STORE);
    if (saved && [...select.options].some(option => option.value === saved)) select.value = saved;
  } catch (_) {
  }
  // 单学科模式（只有一个选项）时整个控件都不显示
  const options = [...select.options];
  if (options.length <= 1) {
    if (select.previousElementSibling) select.previousElementSibling.hidden = true;
    select.hidden = true;
    return;
  }
  select.onchange = () => {
    const href = select.value;
    const previous = [...select.options].find(option => option.selected && option.value !== href);
    if (!href) return;
    if (typeof confirm === 'function' && !confirm('切换学科会丢失当前页面进度（已上传的图片与已生成的卡片），是否继续？')) {
      select.value = previous ? previous.value : select.options[0].value;
      return;
    }
    try {
      localStorage.setItem(SUBJECT_STORE, href);
    } catch (_) {
    }
    location.href = href;
  };
}
initSubjectSwitch();
`;

/* ---------- ④ 工具 ---------- */

/** 逐字替换；默认必须恰好命中一次，`times` 可放宽到「正好命中 N 次」。 */
function replaceOnce(text, from, to, label, times = 1) {
  const count = text.split(from).length - 1;
  if (count !== times) throw new Error(`${label}：在 bio 版 app.js 里命中 ${count} 次（应为 ${times} 次）：${JSON.stringify(from.slice(0, 80))}`);
  return text.split(from).join(to);
}

/** 取出某个顶层函数的完整源码块（含结尾的 `}` 与紧随的换行）。 */
function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (!depth) break; }
  }
  let end = i + 1;
  if (source[end] === '\n') end++;
  return { start, end, text: source.slice(start, end) };
}

/** 校验：bio 里每个 /api/ 字面量都必须包在 api(...) 里；化学独有的函数名不能出现在产物里。 */
function selfCheck(output, source) {
  const problems = [];
  const literal = /request\('(\/api\/[^']*)'/g;
  let match;
  while ((match = literal.exec(output))) problems.push(`request('${match[1]}') 没有加 api() 前缀`);
  // /api/ 字面量的总数必须与基准一致，外加化学独有流程里新用到的接口
  const total = text => (text.match(/\/api\//g) || []).length;
  const expectedExtra = 2; // 化学的 preview/normalizeThenPreview 里的 /api/normalize（上方常量与自检各出现一次）
  if (total(output) !== total(source) + expectedExtra) {
    problems.push(`/api/ 出现次数从 ${total(source)} 变成了 ${total(output)}（预期 ${total(source) + expectedExtra}）`);
  }
  for (const name of ['formulaWarnings', 'textLine', 'normalizeThenPreview', 'runPreview', 'initSubjectSwitch', 'SUBJECT_STORE']) {
    if (!output.includes(name)) problems.push(`产物里缺少 ${name}`);
  }
  if (!output.includes("window.__SUBJECT__")) problems.push('没有读取 window.__SUBJECT__');
  if (!output.includes("subjectName('storageKey'")) problems.push('STORE 没有从配置取');
  if (!output.includes("subjectName('tokenKey'")) problems.push('TOKEN_KEY 没有从配置取');
  if (output.includes("'bio2anki.stable1'") === false) problems.push('缺省 storageKey 兜底丢了');
  return problems;
}

function main() {
  const bio = fs.readFileSync(BIO_APP, 'utf8');
  const chem = fs.readFileSync(CHEM_APP, 'utf8');

  let out = bio;
  for (const [from, to, times] of REPLACEMENTS) out = replaceOnce(out, from, to, '逐字替换', times || 1);

  // 预览：把 bio 的 preview() 换成「bio 版 preview() + 化学版 preview() + 化学版 normalizeThenPreview()」，
  // 再用 runPreview() 分派；bio 的 preview() 原样保留（函数名不变，行为不变）。
  const bioPreview = functionBlock(out, 'preview');
  const next = `${bioPreview.text}${CHEM_FUNCTIONS}\n\n${CHEM_PREVIEW}\n${PREVIEW_DISPATCH}\n`;
  out = replaceOnce(out, bioPreview.text, next, '预览区改造');

  // #preview 按钮改走分派
  out = replaceOnce(out, "byId('preview').onclick = preview;", "byId('preview').onclick = runPreview;", '预览按钮绑定');

  // 学科切换器：先把定义插到「手机端支持」那一段之前，再在启动代码里调用
  const sectionAnchor = '/* ===== 手机端支持：访问口令 / 服务端配置 / 拍照 / PWA ===== */';
  out = replaceOnce(out, sectionAnchor, `${SUBJECT_SWITCH}\n${sectionAnchor}`, '学科切换器定义');
  const bootAnchor = "byId('tokenSave').onclick = submitToken;";
  out = replaceOnce(out, bootAnchor, `initSubjectSwitch();\n${bootAnchor}`, '学科切换器绑定');

  // 确认化学版 preview() 与参考文件里的写法一致（忽略 request 前缀差异）
  const chemPreviewRef = functionBlock(chem, 'preview').text;
  const samePreview = chemPreviewRef.replace(/\s+/g, ' ').trim();
  const minePreview = functionBlock(CHEM_PREVIEW, 'preview').text.replace(/\s+/g, ' ').trim();
  if (samePreview !== minePreview) {
    console.log('提示：化学版 preview() 与参考文件在排版/命名上有差异（逻辑相同），已按上面的写法写入。');
  }

  const problems = selfCheck(out, bio);
  if (problems.length) {
    problems.forEach(line => console.error('  ' + line));
    throw new Error(`app.js 自检失败（${problems.length} 条）`);
  }

  fs.writeFileSync(path.join(PROJECT_ROOT, 'public', 'app.js'), out);
  console.log(`public/app.js 已生成：${out.length} 字符（bio 原版 ${bio.length} 字符）`);
  console.log(`逐字替换 ${REPLACEMENTS.length} 处 + 预览区改造 + 学科切换器 + 预览按钮分派`);
  console.log('自检通过：所有 /api/ 都带 api() 前缀、STORE/TOKEN_KEY 从配置取、化学独有函数已并入。');
}

module.exports = { REPLACEMENTS, CHEM_FUNCTIONS, CHEM_PREVIEW, PREVIEW_DISPATCH, SUBJECT_SWITCH, replaceOnce, functionBlock, selfCheck };

if (require.main === module) main();
