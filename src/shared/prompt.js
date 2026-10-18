'use strict';
/* 制卡提示词拼装：模板在 prompts/<学科>.md，这里只负责填变量。
   纯函数，Node（src/server.js）与安卓壳离线页共用；函数体从 src/server.js 逐字搬来。 */
(function (root) {
const shared = (typeof module !== 'undefined' && module.exports) ? require('./render') : root.CardFlowShared;
const { renderTemplate } = shared;
/* ===== 调研内容注入上限：默认 20000 字。前端可用 maxReference 调高，硬上限 60000，防止提示词被撑爆。 ===== */
const REFERENCE_LIMIT_DEFAULT = 20000;
const REFERENCE_LIMIT_MAX = 60000;
function referenceLimit(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return REFERENCE_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.floor(num), 500), REFERENCE_LIMIT_MAX);
}

function buildPrompt(subject, options = {}) {
  const { cardCount, cardMode } = subject;
  const min = Number(options.minCards) || cardCount.min;
  const max = Number(options.maxCards) || cardCount.max;
  const modeOption = cardMode.options.find(option => option.value === options[cardMode.field]) || cardMode.options[0];
  const extra = String(options.extraRules || '').trim() || '无';
  const reference = String(options.reference || '').trim().slice(0, referenceLimit(options.maxReference));
  const referenceBlock = reference ? `\n\n${renderTemplate(subject.prompts.reference, { reference })}` : '';
  const vars = { min, max, extra, reference, [cardMode.promptVar]: modeOption.prompt };
  return renderTemplate(subject.prompts.generate, vars) + referenceBlock;
}

const api = { referenceLimit, buildPrompt };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.CardFlowShared = Object.assign(root.CardFlowShared || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
