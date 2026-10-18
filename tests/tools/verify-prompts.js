'use strict';
// 提示词黄金测试：把 prompts/{bio,chem}.md 的分段模板渲染出来，与 fixtures 里的原文逐字比对。
// 零依赖，只用 node 内置模块。运行：node tests/tools/verify-prompts.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');            // anki-card-maker/
const PROMPTS = path.join(ROOT, 'prompts');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

// ---------------------------------------------------------------- 渲染引擎

// 条件块 {{#key}}...{{/key}}：key 值非空（trim 后）才保留块体。
function renderConditional(template, vars) {
  return template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (m, key, body) => (String(vars[key] == null ? '' : vars[key]).trim() ? body : ''));
}
// 变量占位符 {{$key}}：null/undefined 渲染成空串。
function renderVars(template, vars) {
  return template.replace(/\{\{\$(\w+)\}\}/g, (m, key) => (vars[key] == null ? '' : String(vars[key])));
}
function renderPrompt(template, vars) {
  return renderVars(renderConditional(template, vars), vars);
}

// 段内容里出现「单独一行的 === xxx ===」会导致解析歧义，直接判失败
function hasMarkerLine(text) {
  return /^=== \w+ ===$/m.test(text);
}

// ---------------------------------------------------------------- 段解析

// 段标记行必须正好是「=== 段名 ===」；段内容去掉首尾空行/换行。
function parseSegments(text, label) {
  const lines = text.split('\n');
  const marks = [];
  lines.forEach((line, i) => {
    const m = line.match(/^=== (\w+) ===$/);
    if (m) marks.push({ name: m[1], index: i });
  });
  if (!marks.length) throw new Error(`${label}: 没有找到任何「=== 段名 ===」段标记`);
  const segs = {};
  marks.forEach((mark, i) => {
    if (mark.name in segs) throw new Error(`${label}: 段名重复 ${mark.name}`);
    const from = mark.index + 1;
    const to = i + 1 < marks.length ? marks[i + 1].index : lines.length;
    segs[mark.name] = lines.slice(from, to).join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  });
  return segs;
}

// ---------------------------------------------------------------- 服务器侧语义复刻

const SUBJECTS = {
  bio: {
    mode: { name: 'weight', label: 'clozeWeight' },
    defaults: { min: 25, max: 35 },
    modeValue: o => (o.clozeWeight === 'very-high' ? '很高' : o.clozeWeight === 'balanced' ? '均衡' : '高'),
  },
  chem: {
    mode: { name: 'intensity', label: 'depth' },
    defaults: { min: 18, max: 28 },
    modeValue: o => (o.depth === 'deep' ? '深入' : o.depth === 'balanced' ? '均衡' : '理解优先'),
  },
};

function buildVars(options, spec) {
  return {
    min: Number(options.minCards) || spec.defaults.min,
    max: Number(options.maxCards) || spec.defaults.max,
    extra: String(options.extraRules || '').trim() || '无',
    reference: String(options.reference || '').trim().slice(0, 20000),
    [spec.mode.name]: spec.modeValue(options),
  };
}

// 服务器侧拼装：generate 段渲染结果 + （有 reference 时）'\n\n' + reference 段渲染结果
function assemble(segs, vars, spec) {
  const head = renderPrompt(segs.generate, vars);
  const referenceBlock = vars.reference ? '\n\n' + renderPrompt(segs.reference, { reference: vars.reference }) : '';
  return head + referenceBlock;
}

// ---------------------------------------------------------------- 校验小工具

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function show(s, at) {
  return JSON.stringify(s.slice(Math.max(0, at - 20), at + 40));
}

let passed = 0, failed = 0;
function record(ok, name, detail) {
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}
function compare(name, actual, expected) {
  if (actual === expected) { record(true, name); return true; }
  const at = firstDiff(actual, expected);
  record(false, name, `首个不同字符 @${at} (actual ${actual.length} 字符 / expected ${expected.length} 字符)\n        actual  : ${show(actual, at)}\n        expected: ${show(expected, at)}`);
  return false;
}

// ---------------------------------------------------------------- 主流程

const REQUIRED = ['generate', 'identify', 'locate', 'reference'];
const loaded = {};

for (const kind of ['bio', 'chem']) {
  const mdPath = path.join(PROMPTS, kind + '.md');
  const fixturePath = path.join(FIXTURES, `prompt-${kind}.json`);
  const buf = fs.readFileSync(mdPath);
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) throw new Error(`${kind}.md 含 UTF-8 BOM`);
  if (buf.includes(Buffer.from('\r\n'))) throw new Error(`${kind}.md 含 CRLF 换行`);
  const text = buf.toString('utf8');
  const segs = parseSegments(text, `${kind}.md`);
  for (const name of REQUIRED) {
    if (!(name in segs)) throw new Error(`${kind}.md 缺少「${name}」段`);
  }
  const extra = Object.keys(segs).filter(n => !REQUIRED.includes(n));
  if (extra.length) throw new Error(`${kind}.md 出现未知段：${extra.join(', ')}`);

  const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (!Array.isArray(cases) || !cases.length) throw new Error(`${kind} fixtures 不是非空数组`);
  loaded[kind] = { segs, cases, text };

  // 段边界完整性：段内不得再出现段标记行
  for (const name of REQUIRED) {
    if (hasMarkerLine(segs[name])) throw new Error(`${kind}.md 的「${name}」段内出现段标记行`);
  }
}

for (const kind of ['bio', 'chem']) {
  const spec = SUBJECTS[kind];
  const { segs, cases } = loaded[kind];
  console.log(`\n--- ${kind} (${cases.length} 个用例, 模式变量 ${spec.mode.label} -> {{$${spec.mode.name}}}) ---`);

  // 1) generate(+reference) 段：与真实 prompt() 输出逐字比对
  for (const item of cases) {
    const name = item.case || JSON.stringify(item.options);
    const vars = buildVars(item.options, spec);
    let actual;
    try {
      actual = assemble(segs, vars, spec);
    } catch (error) {
      record(false, `${kind}/${name} 渲染异常`, error.message);
      continue;
    }
    const ok = compare(`${kind}/${name}`, actual, item.expected);

    // 分支语义断言
    const hasBlock = actual.includes('以下是用户提供的【联网考情调研】');
    if (vars.reference && !hasBlock) record(false, `${kind}/${name} referenceBlock 应出现`, '有 reference 但没拼上 reference 段');
    if (!vars.reference && hasBlock) record(false, `${kind}/${name} referenceBlock 不应出现`, '无 reference 却拼上了 reference 段');
    if (vars.reference.length > 20000) record(false, `${kind}/${name} reference 未截断`, `长度 ${vars.reference.length}`);
    if (ok && vars.reference === 'A'.repeat(20000) && item.expected.includes('A'.repeat(20000))) {
      record(true, `${kind}/${name} 截断为 20000 字符`);
    }
  }

  // 2) reference 段单独验证：有 reference 逐字相同；无 reference 不出现
  const probe = '甲。乙\n丙';
  const refOnly = renderPrompt(segs.reference, { reference: probe });
  record(refOnly.includes(probe), `${kind}/reference 段渲染含 {{$reference}} 原值`);
  record(!renderPrompt(segs.generate, buildVars({}, spec)).includes('以下是用户提供的【联网考情调研】'),
    `${kind}/generate 段自身不含 referenceBlock 文本`);
  record(segs.generate.endsWith('。'), `${kind}/generate 段以「。」结尾（拼接点正确）`);
  record(segs.reference.endsWith('---') && segs.reference.startsWith('以下是用户提供的【联网考情调研】'),
    `${kind}/reference 段以正文开头、以 --- 结尾`);
  record(!/^\n|\n$/.test(segs.generate) && !/^\n|\n$/.test(segs.reference),
    `${kind}/generate 与 reference 段首尾无空行`);
  record(!loaded[kind].text.split('\n').some(l => /^\s*\{\{#/.test(l) || /\{\{\//.test(l)),
    `${kind}.md 不含条件块语法残留`);

  // 3) identify / locate 段：占位符消费检查（渲染后不该残留 {{$...}}）
  const locVars = { topic: '细胞膜的结构与功能', keypoints: JSON.stringify(['结构', '功能']), evidence: '【示例】正文…' };
  for (const [segName, vars] of [['identify', {}], ['locate', locVars]]) {
    const out = renderPrompt(segs[segName], vars);
    record(!/\{\{\$/.test(out), `${kind}/${segName} 段占位符全部被消费`);
    record(out.trim().length > 0, `${kind}/${segName} 段渲染结果非空`);
  }
}

console.log(`\n汇总: ${passed} PASS, ${failed} FAIL (共 ${passed + failed} 项断言)`);
process.exitCode = failed ? 1 : 0;
