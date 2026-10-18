'use strict';
/*
 * 提示词黄金测试：用新的「学科配置 + prompts/<学科>.md」渲染，必须与重构前 server.js 里
 * prompt() 的原文逐字符一致（黄金数据由重构前的旧代码现场生成）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// require 之前把配置指到临时文件，绝不读真实 config/<学科>.config.json
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-prompt-'));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ token: 'prompt-test-token' }));
process.env.ANKI_CONFIG = path.join(tmp, 'config.json');

const { ALL_SUBJECTS, buildPrompt } = require('../src/server.js');

const FIXTURES = { demo: 'prompt-demo.json' };

for (const [subjectId, fixtureName] of Object.entries(FIXTURES)) {
  const subject = ALL_SUBJECTS.find(item => item.id === subjectId);
  const file = path.join(__dirname, 'fixtures', fixtureName);
  const cases = JSON.parse(fs.readFileSync(file, 'utf8'));

  test(`${subjectId}：提示词与重构前逐字符一致（${cases.length} 个用例）`, () => {
    assert.ok(subject, `subjects/${subjectId}.json 不存在`);
    cases.forEach((item, index) => {
      const actual = buildPrompt(subject, item.options || {});
      assert.equal(actual, item.expected, `第 ${index + 1} 个用例不一致：${JSON.stringify(item.options)}`);
    });
  });
}

test('提示词模板按学科分文件加载，且四个段都齐', () => {
  for (const subject of ALL_SUBJECTS) {
    for (const section of ['generate', 'identify', 'locate', 'reference']) {
      assert.equal(typeof subject.prompts[section], 'string', `${subject.id} 缺少 ${section} 段`);
      assert.ok(subject.prompts[section].length > 0, `${subject.id} 的 ${section} 段为空`);
    }
    // 每个学科的提示词里只能出现自己的模式变量
    const other = subject.cardMode.promptVar === 'weight' ? 'intensity' : 'weight';
    assert.ok(!subject.prompts.generate.includes(`{{$${other}}}`), `${subject.id} 的提示词里出现了另一个学科的模式变量`);
  }
});
