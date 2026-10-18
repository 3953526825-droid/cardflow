'use strict';
// 检查两个学科真实渲染出来的页面：关键元素、MathJax 注入、无残留占位符
const fs = require('fs');
const path = require('path');
const { ALL_SUBJECTS, renderSubjectTemplate } = require('../../src/server.js');

const template = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
let failures = 0;
for (const subject of ALL_SUBJECTS) {
  const html = renderSubjectTemplate(subject, template);
  const checks = [
    ['无残留占位符', !html.includes('{{')],
    ['有导入/.apkg 确认弹层（导出为文件已删）', html.includes('id="exportGate"') && !html.includes('id="exportFile"')],
    ['有扫码区块', html.includes('id="qrBox"')],
    ['引入二维码库', html.includes('vendor/qrcode-generator-1.4.4.js')],
    ['有学科切换器', html.includes('id="subjectSwitch"')],
    ['注入了 __SUBJECT__', /window\.__SUBJECT__ = \{/.test(html)],
    [`MathJax 注入符合预期（chem=true / bio=false）`, html.includes('tex-mml-chtml') === Boolean(subject.previewNormalizes)],
    ['data-subject 正确', html.includes(`data-subject="${subject.id}"`)]
  ];
  console.log(`=== ${subject.id} ===`);
  for (const [name, ok] of checks) {
    if (!ok) failures++;
    console.log(`  ${ok ? '✔' : '✖'} ${name}`);
  }
  fs.writeFileSync(path.join(__dirname, '..', '.tmp', `rendered-${subject.id}.html`), html);
}
console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
