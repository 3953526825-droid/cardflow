/* CardFlow 离线入口：旧学科路径仍可使用；接口、密钥及管理页面绝不缓存。 */
const SCOPE = new URL(self.registration.scope).pathname;
const CACHE = 'cardflow-v3-' + (SCOPE === '/' ? 'root' : SCOPE.replace(/\W+/g, '-'));
const ASSETS = SCOPE === '/' ? ['/', '/core.js', '/settings.js', '/picker.css', '/cardflow.js', '/manifest.json', '/icon-cardflow-192.png', '/icon-cardflow-512.png']
  : [`${SCOPE}`, `${SCOPE}app.js`, `${SCOPE}files.js`, `${SCOPE}core.js`, `${SCOPE}workflow.js`, `${SCOPE}vendor/pdf.min.js`, `${SCOPE}vendor/pdf.worker.min.js`, `${SCOPE}vendor/mammoth.browser.min.js`, `${SCOPE}cardflow.css`, `${SCOPE}manifest.json`, `${SCOPE}icon-192.png`, `${SCOPE}icon-512.png`];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/')) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok && !url.pathname.includes('/api/')) {
      const copy=response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
    }
    return response;
  }).catch(() => caches.match(request).then(hit => hit || caches.match(SCOPE))));
});
