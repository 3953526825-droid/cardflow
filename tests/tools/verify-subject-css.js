'use strict';
/*
 * 关键色值/最终生效值比对：证明「bio 作用域下算出的值 == Bio2Anki 原样式表」、
 * 「chem 作用域下算出的值 == Chem2Anki 原样式表」。
 *
 * 做法：把合并样式表（public/index.html 里的 styleBlock）用同一套级联裁决器（tests/helpers/dom.js）
 * 分别挂在带 data-subject="bio" / "chem" 的 html/body 探针上，与两个参考 index.html 里
 * 各自原来的样式表逐属性对比。
 *
 * 覆盖两层：
 *   1) tests/helpers/css-probes.js 的 64 个真实探针（归一化 + 加 data-subject 前缀）；
 *   2) 任务点名的关键项（:root 变量、body 背景、.toast 背景、h1 颜色、.sectionTitle 颜色、button 背景
 *      等），逐条列出两边算出来的值；关键项还会把全部断点轮一遍。
 *
 * 注意：`:root` 的规则要挂在 html 元素上才会命中；因此「正文元素」的参考探针会补一个空的 html 祖先，
 * 与 scoped 探针（html[data-subject=…] 祖先）保持同样的结构。
 *
 * 用法：node tests/tools/verify-subject-css.js
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const REFERENCE = {
  bio: 'C:/Users/Administrator/Bio2Anki/public/index.html',
  chem: 'C:/Users/Administrator/Chem2Anki/public/index.html'
};

const { compileCss, extractStyles, resolveDeclaration, makeProbeNode, parseCompoundList, matchFrom, probeFromPath } = require('../helpers/dom');
const { PROBES, breakpointWidths } = require('../helpers/css-probes');

/**
 * 裁决器把裸 `{`/`}` 当块边界，而 tests/helpers/dom.js 的 splitRules 不认注释，
 * 样式表注释里的反引号会让它误判出块、打乱规则顺序。两边都先用同一段「保长度去注释」预处理，
 * 保证对比口径一致。（tests/css.test.js 用的是 helpers 里的原版 compileCss，不受这里影响。）
 */
const compileClean = text => compileCss(text.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')));

const mergedCss = compileClean(extractStyles(fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), 'utf8')));
const referenceCss = {
  bio: compileClean(extractStyles(fs.readFileSync(REFERENCE.bio, 'utf8'))),
  chem: compileClean(extractStyles(fs.readFileSync(REFERENCE.chem, 'utf8')))
};

/** 给探针描述链的第一个复合选择器挂上 data-subject（与 tests/helpers/css-probes.js 的 scopedPath 同义）。 */
function scoped(descriptorPath, subject) {
  const attr = `[data-subject="${subject}"]`;
  const [first, ...rest] = descriptorPath;
  if (first === 'html') return [`html${attr}`, ...rest];
  if (first === 'body') return [`html${attr}`, `body${attr}`, ...descriptorPath.slice(1)];
  return [`html${attr}`, `body${attr}`, ...descriptorPath];
}

/** 参考侧探针：与 scoped 探针保持同样的结构（不额外补祖先）。 */
function referenceProbe(descriptorPath) {
  return probeFromPath(descriptorPath);
}

/** body:before / body:after 用的探针：html(:root) > body，scoped 侧两层的 data-subject 都带上。 */
function bodyPseudoProbe(subject, pseudo) {
  const html = makeProbeNode(subject ? `html[data-subject="${subject}"]` : 'html');
  const body = makeProbeNode(subject ? `body[data-subject="${subject}"]` : 'body');
  body.parentElement = html;
  body._pseudoStates = new Set([pseudo]);
  return body;
}

/** 任务点名的关键项：[说明, 探针描述链, 属性列表, 是否补 html 祖先]。
 *  `:root` 这类规则必须落在「没有父节点」的 html 探针上才会命中，因此默认不补祖先；
 *  只有需要模拟「正文元素挂在 html 下面」的项（如 body:before 的继承）才补。 */
const KEY_CASES = [
  [':root（设计变量）', ['html'], ['font', 'color', 'background', '--ink', '--muted', '--brand', '--brand2', '--line', '--panel', 'font-size']],
  ['html', ['html'], ['min-height', 'background']],
  // body 的 color/background 会被 :root 的更高特异性盖掉，这里只比 body 自己的那份声明
  ['body（自身声明）', ['body'], ['margin', 'min-height', 'position', 'isolation', 'overflow-x', 'background-attachment']],
  // 继承到 body 上的最终值：html 是 :root 的宿主，body 继承 :root 的继承属性
  ['body（继承 :root 的最终值）', ['html'], ['color', 'background', 'font']],
  // body:before 的背景来自 body 的继承值。真实页面里 body 在 html 下面，所以参考探针也要挂在
  // html 下面（否则 body 会被当成 :root，算出的是 :root 的值，口径就不一致了）。
  ['body:before', 'custom-body:before', ['content', 'width', 'height', 'background', 'animation', 'z-index']],
  ['body:after', 'custom-body:after', ['content', 'width', 'height', 'background', 'animation', 'z-index']],
  ['.toast', ['body', 'div.toast'], ['background', 'color', 'border-radius', 'max-width', 'z-index']],  ['.toast.error', ['body', 'div.toast.error'], ['background']],
  ['.toast.warn', ['body', 'div.toast.warn'], ['background']],
  ['.toast.busy', ['body', 'div.toast.busy'], ['background']],
  ['.topStatus', ['body', 'main', 'div.topStatus'], ['background', 'color', 'box-shadow', 'border-radius']],
  ['h1', ['body', 'main', 'h1'], ['color', 'font-size', 'line-height', 'display', 'gap']],
  ['h1:before', ['body', 'main', 'h1'], ['content', 'background', 'box-shadow', 'width', 'height', 'color', 'font-size']],
  ['h1 small', ['body', 'main', 'h1', 'small'], ['color', 'background']],
  ['.sub', ['body', 'main', 'div.sub'], ['color', 'font-size', 'margin', 'max-width']],
  ['.sectionTitle', ['body', 'main', 'details.box', 'div.inside', 'div.searchResults', 'div.sectionTitle'], ['color', 'font-size', 'font-weight', 'margin']],
  ['button', ['body', 'main', 'details.box', 'div.inside', 'button'], ['background', 'color', 'border-radius', 'min-height', 'font-size', 'white-space']],
  ['.secondary', ['body', 'main', 'details.box', 'div.inside', 'button.secondary'], ['background']],
  ['.danger', ['body', 'main', 'details.box', 'div.inside', 'button.danger'], ['background']],
  ['.primaryAction', ['body', 'main', 'details.box', 'div.inside', 'button.primaryAction'], ['background']],
  ['#retry', ['body', 'main', 'details.box', 'div.inside', 'button#retry'], ['background']],
  ['input', ['body', 'main', 'details.box', 'div.inside', 'input'], ['background', 'border', 'border-radius', 'font-size', 'min-height', 'padding']],
  ['select', ['body', 'main', 'details.box', 'div.inside', 'select'], ['background', 'border', 'border-radius', 'font-size']],
  ['textarea', ['body', 'main', 'details.box', 'div.inside', 'textarea'], ['background', 'border-radius', 'min-height', 'font']],
  ['label', ['body', 'main', 'details.box', 'div.inside', 'label'], ['color', 'font-weight', 'font-size', 'margin']],
  ['.box', ['body', 'main', 'details.box'], ['background', 'border', 'border-radius', 'box-shadow', 'backdrop-filter']],
  ['.box>summary', ['body', 'main', 'details.box', 'summary'], ['color', 'background', 'font-size', 'padding', 'border-bottom']],
  ['.inside', ['body', 'main', 'details.box', 'div.inside'], ['padding']],
  ['.grid', ['body', 'main', 'details.box', 'div.inside', 'div.grid'], ['grid-template-columns', 'gap', 'display']],
  ['.card', ['body', 'main', 'details.box', 'div.inside', 'div.cards', 'div.card'], ['background', 'border', 'border-left', 'font-size', 'line-height', 'padding']],
  ['.chosen', ['body', 'main', 'details.box', 'div.inside', 'div.chosen'], ['background', 'color', 'border', 'border-radius', 'min-height', 'font-weight']],
  ['.tree', ['body', 'main', 'details.box', 'div.inside', 'div.tree'], ['background', 'border', 'border-radius', 'max-height']],
  ['.leaf', ['body', 'main', 'details.box', 'div.inside', 'div.tree', 'button.leaf'], ['background', 'color', 'border-radius']],
  ['.drop', ['body', 'main', 'details.box', 'div.inside', 'div.drop'], ['background', 'border', 'border-color', 'border-radius', 'min-height', 'font-size']],
  ['.drop:before', ['body', 'main', 'details.box', 'div.inside', 'div.drop'], ['content', 'color', 'font-size']],
  ['.drop:after', ['body', 'main', 'details.box', 'div.inside', 'div.drop'], ['content', 'color', 'display']],
  ['.muted', ['body', 'main', 'details.box', 'div.inside', 'div.muted'], ['color', 'font-size', 'line-height']],
  ['.searchItem', ['body', 'main', 'details.box', 'div.inside', 'div.searchResults', 'div.searchItem'], ['background', 'border-left', 'font-size', 'padding']],
  ['.searchItem a', ['body', 'main', 'details.box', 'div.inside', 'div.searchResults', 'div.searchItem', 'a'], ['color', 'font-weight']],
  ['.snipToggle', ['body', 'main', 'details.box', 'div.inside', 'div.searchResults', 'div.searchItem', 'div.snipToggle'], ['color', 'font-size', 'margin']],
  ['.tokenGate', ['body', 'div.tokenGate'], ['background', 'z-index', 'position', 'padding']],
  ['.tokenGate h2', ['body', 'div.tokenGate', 'div.tokenCard', 'h2'], ['color', 'font-size', 'margin']],
  ['.tokenError', ['body', 'div.tokenGate', 'div.tokenCard', 'div.tokenError'], ['color', 'font-size', 'font-weight']],
  ['.deckNewLabel', ['body', 'main', 'details.box', 'div.inside', 'div.deckNew', 'label.deckNewLabel'], ['color', 'font-weight', 'font-size']],
  ['.deckNewPreview', ['body', 'main', 'details.box', 'div.inside', 'div.deckNew', 'div.deckNewPreview'], ['color', 'font-size']],
  ['#deckDeleteInfo', ['body', 'main', 'details.box', 'div.inside', 'div#deckDeleteInfo'], ['color', 'font-size', 'line-height']],
  ['#referenceInfo', ['body', 'main', 'details.box', 'div.inside', 'span#referenceInfo'], ['color', 'font-size']],
  ['.thumb img', ['body', 'main', 'details.box', 'div.inside', 'div.thumbs', 'div.thumb', 'img'], ['width', 'height', 'border-radius', 'box-shadow']],
  ['.searchItem button', ['body', 'main', 'details.box', 'div.inside', 'div.searchResults', 'div.searchItem', 'button'], ['font-size', 'min-height', 'padding']]
];

const SUBJECTS = ['bio', 'chem'];

/** 把一条关键项转成「scoped 探针 + 参考探针」。 */
function probesFor(descriptorPath, subject) {
  if (descriptorPath === 'custom-body:before') return { mine: bodyPseudoProbe(subject, 'before'), ref: bodyPseudoProbe('', 'before') };
  if (descriptorPath === 'custom-body:after') return { mine: bodyPseudoProbe(subject, 'after'), ref: bodyPseudoProbe('', 'after') };
  return { mine: probeFromPath(scoped(descriptorPath, subject)), ref: referenceProbe(descriptorPath) };
}

function main() {
  const widths = [...new Set([
    ...breakpointWidths(mergedCss),
    ...breakpointWidths(referenceCss.bio),
    ...breakpointWidths(referenceCss.chem)
  ])].sort((a, b) => a - b);
  const diffs = [];
  let checked = 0;

  // ① 关键项逐条（1280px 全部列出，方便人读）
  console.log('==== 关键项：合并样式表（scoped）vs 参考样式表（1280px）====');
  for (const subject of SUBJECTS) {
    console.log(`---- ${subject} ----`);
    for (const [label, descriptorPath, properties] of KEY_CASES) {
      const { mine: mineNode, ref: refNode } = probesFor(descriptorPath, subject);
      for (const property of properties) {
        const mine = resolveDeclaration(mergedCss, mineNode, property, 1280);
        const reference = resolveDeclaration(referenceCss[subject], refNode, property, 1280);
        checked++;
        const same = mine === reference;
        if (!same) diffs.push(`${label} { ${property}: ${JSON.stringify(reference)} -> ${JSON.stringify(mine)} }`);
        console.log(`  ${same ? 'OK ' : 'XX '} ${label.padEnd(18)} ${property.padEnd(22)} ${JSON.stringify(mine)}`);
      }
    }
  }

  // ② css-probes 的全部探针（1280px），属性集合取自参考样式表
  let probeChecks = 0;
  for (const subject of SUBJECTS) {
    for (const [name, descriptorPath] of Object.entries(PROBES)) {
      // `css-probes` 里名为 html/body 的探针是单节点（没有 html 祖先），:root 会误命中它；
      // 真实的 html 元素由上面「:root / html」两项覆盖，这里跳过该探针，避免口径不一致。
      if (name === 'html/body') continue;
      const { mine: mineNode, ref: refNode } = probesFor(descriptorPath, subject);
      const properties = new Set();
      for (const rule of referenceCss[subject]) {
        for (const selector of rule.selectors) {
          const compounds = parseCompoundList(selector);
          if (compounds.length && matchFrom(compounds, compounds.length - 1, refNode)) {
            rule.decls.forEach(decl => properties.add(decl.property));
          }
        }
      }
      for (const property of properties) {
        const mine = resolveDeclaration(mergedCss, mineNode, property, 1280);
        const reference = resolveDeclaration(referenceCss[subject], refNode, property, 1280);
        checked++;
        probeChecks++;
        if (mine !== reference) diffs.push(`${name}(${subject}) { ${property}: ${JSON.stringify(reference)} -> ${JSON.stringify(mine)} }`);
      }
    }
  }
  console.log('==== 全量探针 ====');
  console.log(`  css-probes ${Object.keys(PROBES).length} 个探针 × 2 学科，共比较 ${probeChecks} 项属性。`);

  // ③ 关键项 × 代表性断点（左端 / 手机档 / 断点上下沿 / 桌面档）
  const sampleWidths = [...new Set([390, 719, 720, 759, 760, 1059, 1060, 1280, ...widths])].sort((a, b) => a - b);
  let widthChecks = 0;
  for (const subject of SUBJECTS) {
    for (const [label, descriptorPath, properties] of KEY_CASES) {
      const { mine: mineNode, ref: refNode } = probesFor(descriptorPath, subject);
      for (const width of sampleWidths) {
        for (const property of properties) {
          const mine = resolveDeclaration(mergedCss, mineNode, property, width);
          const reference = resolveDeclaration(referenceCss[subject], refNode, property, width);
          checked++;
          widthChecks++;
          if (mine !== reference) diffs.push(`${label}(${subject}) @${width}px { ${property}: ${JSON.stringify(reference)} -> ${JSON.stringify(mine)} }`);
        }
      }
    }
  }
  console.log(`  关键项 × ${sampleWidths.length} 档宽度（${sampleWidths.join(', ')}），共比较 ${widthChecks} 项属性。`);

  console.log('==== 结论 ====');
  console.log(`  共比较 ${checked} 项。`);
  console.log(`  差异：${diffs.length} 处${diffs.length ? '' : '（两个学科在各自作用域下的最终生效值与参考文件完全一致）'}`);
  diffs.slice(0, 60).forEach(line => console.log('  XX ' + line));
  process.exitCode = diffs.length ? 1 : 0;
}

if (require.main === module) main();
