'use strict';
/*
 * 手机离线版没有 AnkiWeb 同步：卡片是直接写进 AnkiDroid 的，同步由 AnkiDroid 自己完成。
 * app.js 的 restore() 会把「导入后自动同步」默认勾上（autoSync !== false），于是每次导入都会
 * 追一条必然失败的同步提示（真机反馈里那条「同步失败：离线版不用在这里同步…」）。
 * 这里把这个勾钉死为关：在这个元素上直接定义 checked 的取值，之后谁读都是 false、也写不进去。
 * 只能隐藏不能删 DOM —— app.js 里 byId('autoSync') 是硬引用的。
 */
(function () {
  function pin() {
    const box = document.getElementById('autoSync');
    if (!box || box.dataset.pinned === '1') return;
    try {
      Object.defineProperty(box, 'checked', { get: () => false, set: () => {}, configurable: true });
      box.dataset.pinned = '1';
    } catch (_) { /* 定义不上就退而求其次：至少先关一次 */ }
    box.checked = false;
  }
  if (typeof document === 'undefined') return;
  pin();
  document.addEventListener('DOMContentLoaded', pin);
})();
