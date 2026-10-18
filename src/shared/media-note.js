'use strict';
/* 遮挡卡 / 音频卡的字段 HTML：Node（src/media.js 写进 Anki / .apkg）与安卓壳离线页共用同一份，
   免得「手机上看到的遮挡框」和「电脑导入后的遮挡框」长得不一样。
   媒体文件名由调用方给出（Node 用内容哈希，浏览器侧用自己的哈希），这里只管排版。 */
(function (root) {
function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** 一张遮挡卡 / 音频卡 → { front, back } 两段 HTML。
 *  遮挡卡背面（真机反馈：正反面都出现文字答案，全局规则也管不住）：只放图 + 可显示/隐藏的遮挡，
 *  不放 back 文字、不放来源；遮挡默认隐藏（翻面即看到答案），按钮把框盖回去可以再自测一次。
 *  预览（public/app.js）与此同一口径。 */
function mediaNote(card, filename) {
  let front = escapeHtml(card.front || '请回忆图中遮挡部分');
  let back = '';
  if (card.type === 'audio') {
    back = escapeHtml(card.back || '');
    front += '[sound:' + filename + ']';
  } else {
    const img = '<img src="' + filename + '" style="display:block;max-width:100%;width:100%">';
    const masks = card.masks.map(m=>'<span style="position:absolute;background:#3782c8;border:2px solid white;left:'+m.x*100+'%;top:'+m.y*100+'%;width:'+m.w*100+'%;height:'+m.h*100+'%"></span>').join('');
    front += '<div style="position:relative;display:inline-block;max-width:100%">'+img+masks+'</div>';
    back += '<div style="position:relative;display:inline-block;max-width:100%">'+img
      + '<div style="position:absolute;inset:0;display:none">'+masks+'</div></div>'
      + '<button style="margin-top:6px" onclick="var l=this.previousElementSibling.querySelector(\'div\');if(l)l.style.display=l.style.display===\'none\'?\'block\':\'none\';">显示／隐藏遮挡</button>';
  }
  if (card.note) back += '<p>' + escapeHtml(card.note) + '</p>';
  if (card.type !== 'occlusion' && (card.source || card.sourceCandidates)) back += '<small>来源：' + escapeHtml(JSON.stringify(card.source || card.sourceCandidates)) + '</small>';
  return { front, back };
}

const api = { mediaNote, escapeHtml };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.CardFlowShared = Object.assign(root.CardFlowShared || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
