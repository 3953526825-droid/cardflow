'use strict';
/*
 * CSS 测试（多学科版）：
 *   1) 每个学科的结构性断言（手机单栏、桌面双栏、按钮换行……）；
 *   2) 与 tests/css-baseline-<学科>.json 逐项对比 —— 基准是**重构前**两个项目各自的样式表，
 *      探针带上 data-subject 属性后算出的最终生效值必须一模一样，这就是「两套主题都原样保留」的证据；
 *   3) 主题调色板变量与 subjects/<学科>.json 里的 theme 一致。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PROBES, compileProject, snapshotAll, breakpointWidths, scopedPath, stripScope } = require('./helpers/css-probes');
const { resolveDeclaration, probeFromPath } = require('./helpers/dom');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SUBJECTS = ['demo'];
const css = compileProject(PROJECT_ROOT);

function value(subject, probeName, property, width) {
  assert.ok(PROBES[probeName], `未定义的探针：${probeName}`);
  return resolveDeclaration(css, probeFromPath(scopedPath(subject, PROBES[probeName])), property, width);
}

/** 把嵌套快照压成「路径 -> 值」的扁平表，任何层级的新增/删除/变化都会被看见。 */
function flatten(node, prefix = '', out = new Map()) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const key of Object.keys(node)) flatten(node[key], prefix ? `${prefix} | ${key}` : key, out);
  } else {
    out.set(prefix, node);
  }
  return out;
}

function diffSections(before, after) {
  const a = flatten(before || {});
  const b = flatten(after || {});
  const diffs = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) !== b.get(key)) diffs.push(`${key}: ${JSON.stringify(a.get(key))} -> ${JSON.stringify(b.get(key))}`);
  }
  // 特意新增的样式，不作为「与重构前一致」的回归（它们的值由下面的用例单独断言）：
  //   1) --subject-* 调色板变量（阶段 C 加的）
  //   2) .cardTitle / .note：卡片预览的排版（标题加粗、备注缩小变灰）
  const isIntended = line => line.includes('--subject-') || /^\.cardTitle \|/.test(line) || /^\.note \|/.test(line);
  return diffs.filter(line => !isIntended(line));
}

function baselineFor(subject) {
  const file = path.join(__dirname, `css-baseline-${subject}.json`);
  assert.ok(fs.existsSync(file), `缺少 tests/css-baseline-${subject}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function currentFor(subject) {
  const base = baselineFor(subject);
  const widths = [...new Set([...(base.selectorWidths || []), ...breakpointWidths(css)])].sort((a, b) => a - b);
  const viewportWidths = [...new Set([...(base.viewportWidths || []), 390, 760, 1280])].sort((a, b) => a - b);
  return { base, current: snapshotAll(PROJECT_ROOT, { subject, selectorWidths: widths, viewportWidths }) };
}

for (const subject of SUBJECTS) {
  test(`[${subject}] 390px（手机）：单栏、按钮换行、检索输入独占一行`, () => {
    assert.equal(value(subject, '.grid', 'grid-template-columns', 390), '1fr');
    assert.equal(value(subject, 'button', 'white-space', 390), 'normal');
    assert.equal(value(subject, '.searchRow>input', 'flex', 390), '1 1 100%');
    assert.equal(value(subject, '.inside>button', 'width', 390), '100%');
  });

  test(`[${subject}] 1280px（桌面）：双栏、按钮不换行、检索输入自适应`, () => {
    const columns = value(subject, '.grid', 'grid-template-columns', 1280) || '';
    let depth = 0;
    let tracks = 1;
    for (const ch of columns) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ' ' && depth === 0) tracks++;
    }
    assert.equal(tracks, 2, `.grid 在 1280px 下应为两栏，实际 ${columns}`);
    assert.equal(value(subject, 'button', 'white-space', 1280), 'nowrap');
    assert.equal(value(subject, '.searchRow>input', 'flex', 1280), '1');
    assert.equal(value(subject, '.grid>div+div', 'padding-left', 1280), '30px');
  });

  test(`[${subject}] 760px：仍然是手机单栏（历史坑：不带媒体查询的双栏 .grid 排在断点之后）`, () => {
    assert.equal(value(subject, '.grid', 'grid-template-columns', 760), '1fr');
  });

  test(`[${subject}] 与重构前逐条一致：探针快照零差异`, () => {
    const { base, current } = currentFor(subject);
    const diffs = diffSections(base.viewport, current.viewport);
    assert.equal(diffs.length, 0, `探针最终生效值与基准不一致（${diffs.length} 处）：\n${diffs.slice(0, 40).join('\n')}`);
  });

  test(`[${subject}] 与重构前逐条一致：每条选择器 × 每个断点零差异`, () => {
    const { base, current } = currentFor(subject);
    const diffs = diffSections(base.selectors, current.selectors);
    assert.equal(diffs.length, 0, `选择器最终生效值与基准不一致（${diffs.length} 处）：\n${diffs.slice(0, 40).join('\n')}`);
  });

  test(`[${subject}] 主题调色板变量与 subjects/${subject}.json 的 theme 一致`, () => {
    const config = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'subjects', `${subject}.json`), 'utf8'));
    const node = probeFromPath([`html[data-subject="${subject}"]`]);
    const expected = {
      '--subject-accent': config.theme.accent,
      '--subject-accent-soft': config.theme.accentSoft,
      '--subject-ink': config.theme.ink,
      '--subject-muted': config.theme.muted,
      '--subject-line': config.theme.line,
      '--subject-panel': config.theme.panel,
      '--subject-toast-bg': config.theme.toastBg
    };
    for (const [property, want] of Object.entries(expected)) {
      assert.equal(resolveDeclaration(css, node, property, 1280), want, `${property} 应与配置里的主题色一致`);
    }
  });

  test(`[${subject}] 卡片预览排版：标题加粗、备注缩小变灰（上面两条特意新增，这里单独校验值）`, () => {
    const title = probeFromPath(scopedPath(subject, ['div.cardTitle']));
    assert.equal(resolveDeclaration(css, title, 'font-weight', 1280), '700');
    assert.equal(resolveDeclaration(css, title, 'font-weight', 390), '700', '手机上标题也要加粗');
    const note = probeFromPath(scopedPath(subject, ['div.note']));
    assert.equal(resolveDeclaration(css, note, 'font-size', 1280), '13px');
    assert.equal(resolveDeclaration(css, note, 'color', 1280), subject === 'demo' ? '#5a6b80' : '#607080');
  });

  test(`[${subject}] 规则带自己的作用域前缀`, () => {
    const selectors = css.flatMap(rule => rule.selectors);
    assert.ok(selectors.some(sel => sel.includes(`[data-subject="${subject}"]`)), `${subject} 的规则应当带自己的作用域前缀`);
    assert.equal(stripScope(`[data-subject="${subject}"] .grid`, subject), '.grid');
    assert.equal(stripScope(`body[data-subject="${subject}"]:before`, subject), 'body:before');
  });
}
