'use strict';
/* 卡片的校验、导出与牌组归属：纯函数，Node（src/server.js）与安卓壳离线页共用。
   遮挡/音频卡的细节校验复用 public/core.js（两端同一份），函数体从 src/server.js 逐字搬来。 */
(function (root) {
const proCore = (typeof module !== 'undefined' && module.exports) ? require('../../public/core.js') : root.CardFlowCore;
function cardIssue(card, options) {
  if (!card || typeof card !== 'object') return '卡片不是对象。';
  if (!['basic','cloze','occlusion','audio'].includes(card.type)) return '卡片类型不支持。';
  if (['audio','occlusion'].includes(card.type)) return proCore.issue(card, options);
  if (!['basic', 'cloze'].includes(card.type)) return '卡片类型必须是 basic 或 cloze。';
  if (card.type === 'basic' && (!card.front?.trim() || !card.back?.trim())) return '普通卡缺少正面或背面。';
  if (card.type === 'cloze') {
    if (!card.text?.trim()) return '填空卡缺少文本。';
    if (!/\{\{c1::.+?\}\}/.test(card.text) || /\{\{c(?!1::)/.test(card.text)) return '填空卡必须且只能使用 c1。';
  }
  return '';
}

function validate(data, options) {
  if (!data || !Array.isArray(data.cards)) throw new Error('卡片 JSON 中缺少 cards 数组。');
  if (!data.deck) throw new Error('未选择导入牌组。');
  // 填空卡字段归一（front/back 里带 {{c1::…}} 的搬进 text）。放在校验入口做，
  // 导入、导出、离线页三条路都不会漏：真机反馈过「一批 44 张里 12 张全判缺少文本」。
  const coerce = (typeof module !== 'undefined' && module.exports)
    ? require('./parse.js').coerceCards
    : (root.CardFlowShared && root.CardFlowShared.coerceCards);
  if (typeof coerce === 'function') coerce(data.cards);
  data.cards.forEach((card, i) => {
    const issue = cardIssue(card, options);
    if (issue) throw new Error(`第 ${i + 1} 张：${issue}`);
  });
  return data;
}

function countCardTypes(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const count = type => list.filter(card => card && card.type === type).length;
  // 四种类型都数（真机反馈：历史记录只数普通/填空，全勾音频卡时显示「普通卡 0 · 填空卡 0 · 共 5 张」）
  return { basic: count('basic'), cloze: count('cloze'), occlusion: count('occlusion'), audio: count('audio'), total: list.length };
}

function cardTitles(cards, max = 30) {
  return (Array.isArray(cards) ? cards : []).slice(0, max).map(card => {
    const source = card && card.type === 'cloze' ? card.text : card && card.front;
    return String(source || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  });
}

function escapeExportField(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')      // 制表符换成 4 个空格：HTML 与纯文本两种导入模式都不会错位
    .replace(/\n/g, '<br>');     // 换行换成 <br>：Anki 默认按 HTML 渲染字段
}

const EXPORT_TYPE_LABELS = { basic: '普通卡', cloze: '填空卡', occlusion: '图像遮挡卡', audio: '音频卡' };
function exportFields(card, defaultTags) {
  // 与 /api/import 里的 `card.tags || defaultTags` 保持完全一致（空数组也算「有 tags」，不加默认标签）
  const tags = (card.tags || defaultTags || []).join(' ');
  if (card.type === 'cloze') return [card.text || '', card.note || '', tags];
  const back = `${card.back || ''}${card.note ? `<br><br><small>${card.note}</small>` : ''}`;
  return [card.front || '', back, tags];
}

function exportText(cards, defaultTags) {
  return cards.map(card => exportFields(card, defaultTags).map(escapeExportField).join('\t')).join('\n') + '\n';
}

function deckForCard(card, parentDeck, grouping, cache) {
  if (!grouping || !parentDeck) return parentDeck;
  // 只认模型明确给出的分组（group / section）。以前 source.page 也当分组用，
  // 于是 group 为空时就会造出「父牌组::第 3 页」这种以页数命名的牌组（真机反馈：一次导入多出
  // 四个页数牌组）。页码是定位信息，不是分组信息。
  const raw = String(card.group || card.section || (card.source && card.source.section) || '').trim();
  const parts = raw.split(/[\\/]+|::+/).map(part => part.replace(/[:"<>|*?^\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  // 纯页码（「第 3 页」「P3」「page 3」）也不算分组：宁可不分层，也不要凭空造牌组
  const onlyPage = parts.length === 1 && /^(?:第\s*\d+\s*页|p\.?\s*\d+|page\s*\d+)$/i.test(parts[0]);
  if (!parts.length || onlyPage) return parentDeck;
  const child = parts.join('::').slice(0, 120).replace(/::+$/g, '');
  if (!child) return parentDeck;
  if (!cache.has(child)) cache.set(child, `${parentDeck}::${child}`);
  return cache.get(child);
}

const api = { cardIssue, validate, countCardTypes, cardTitles, escapeExportField, exportFields, exportText, deckForCard, EXPORT_TYPE_LABELS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.CardFlowShared = Object.assign(root.CardFlowShared || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
