'use strict';
/* 抓网页原文（Jina Reader）之后的清洗与限额：Node（src/server.js 的抓取接口）与安卓壳离线页共用同一份。
   只做纯文本处理，真正的请求由调用方发（Node 用 fetch，手机走原生桥）。 */
(function (root) {
/** Jina Reader 的默认入口：给一个网址就返回干净的 Markdown。 */
const JINA_DEFAULT = 'https://r.jina.ai/';

/** 去掉 Jina 前缀行、图片、外链；压缩空行。与重构前逐字一致。 */
function cleanFetchedText(markdown) {
  return String(markdown || '')
    .replace(/^(Title|URL Source|Published Time|Markdown Content):.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\((?:https?:\/\/)[^)]*\)/g, '$1')
    .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 页面框架噪音（页码、登录、作品ID 这类）：命中 3 次以上就提示「这页多半没抓到正文」。 */
function frameNoiseCount(text) {
  return (String(text || '').match(/页码|浏览：|下载：|作品ID|作者ID|内容目录|全屏|演示|发布\s*浏览|登录|注册/g) || []).length;
}

/** 原文限额：默认 12000 字，最少 500、最多 40000。 */
function fetchLimit(value) {
  const num = Number(value);
  return Math.min(Math.max(Number.isFinite(num) && num > 0 ? num : 12000, 500), 40000);
}

const api = { cleanFetchedText, frameNoiseCount, fetchLimit, JINA_DEFAULT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.CardFlowShared = Object.assign(root.CardFlowShared || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
