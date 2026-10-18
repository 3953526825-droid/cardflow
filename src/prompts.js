'use strict';
/*
 * 提示词外置：从 prompts/<学科>.md 读取，按 `=== 段名 ===` 分段。
 *
 * 段名固定四个：
 *   generate  —— 制卡提示词（占位符 {{$min}} {{$max}} {{$extra}} 以及学科自己的 {{$weight}} 或 {{$intensity}}）
 *   reference —— 联网调研块正文（占位符 {{$reference}}），只有在有调研内容时才拼接
 *   identify  —— 读图定知识主题（无占位符）
 *   locate    —— 用目录证据锁定章节位置（占位符 {{$topic}} {{$keypoints}} {{$evidence}}）
 *
 * 改提示词只需要改 md 文件，不需要动代码；README 里有说明。
 */
const fs = require('fs');
const { renderTemplate, parseSections } = require('./shared/render');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED_SECTIONS = ['generate', 'reference', 'identify', 'locate'];



/** 读取并校验一个学科的提示词文件。 */
function loadPromptFile(relativePath) {
  const file = path.isAbsolute(relativePath) ? relativePath : path.join(ROOT, relativePath);
  const sections = parseSections(fs.readFileSync(file, 'utf8'));
  const missing = REQUIRED_SECTIONS.filter(name => typeof sections[name] !== 'string' || !sections[name].length);
  if (missing.length) throw new Error(`${relativePath} 缺少段落：${missing.map(name => `=== ${name} ===`).join('、')}`);
  return sections;
}

module.exports = { renderTemplate, parseSections, loadPromptFile, REQUIRED_SECTIONS };
