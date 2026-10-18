'use strict';
/*
 * 安卓壳（WebView）里 blob: + <a download> 的下载是**不响的**：
 * WebView 没配 DownloadListener 时既不下载也不提示，「下载 .apkg / 备份全部数据 / 下载诊断包」
 * 在手机上点了就像坏了一样。这里拦住这种点击，把字节转成 base64 交给原生 CardFlowNative.saveFile 落盘
 * （不回调，成功与否由原生弹 Toast）。
 * 备份 / 诊断包在 app.js 的 saveBlob() 里优先走 saveFileAs（系统「另存为」，用户自己选位置）；
 * 这个拦截器是普通下载路径的兜底（比如 .apkg 的非安卓壳分支）。
 *
 * 两个细节：
 *   1) app.js 是 link.click() 之后立刻 URL.revokeObjectURL()，所以不能等点击时再去 fetch(href)
 *      —— 这里先把 createObjectURL 的 blob 记下来，点击时直接从表里拿。
 *   2) 桌面浏览器没有 CardFlowNative，脚本直接不生效，原样走浏览器自己的下载。
 */
(function () {
  const native = window.CardFlowNative;
  if (!native || typeof native.saveFile !== 'function') return;
  if (typeof HTMLAnchorElement === 'undefined' || typeof URL === 'undefined') return;

  const blobs = new Map();
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = function (blob) {
    const url = createObjectURL.call(URL, blob);
    try { blobs.set(url, blob); } catch (_) { /* 记不下就退回 fetch */ }
    return url;
  };
  // 只清浏览器那边的 URL，映射留着给 click 用（表很小，一次导出最多几条）
  URL.revokeObjectURL = function (url) {
    revokeObjectURL.call(URL, url);
  };

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error('读取失败'));
      reader.readAsDataURL(blob);
    });
  }

  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const name = this.getAttribute && this.getAttribute('download');
    const href = String(this.href || '');
    if (!name || href.indexOf('blob:') !== 0) return click.apply(this, arguments);
    const cached = blobs.get(href);
    const source = cached ? Promise.resolve(cached) : fetch(href).then(response => response.blob());
    source.then(toBase64).then(dataUrl => {
      const comma = dataUrl.indexOf(',');
      if (comma < 0) throw new Error('读取失败');
      native.saveFile(name, dataUrl.slice(comma + 1));
    }).catch(() => { /* 存不下就什么都别做，别把生成的卡片弄丢 */ });
  };
})();
