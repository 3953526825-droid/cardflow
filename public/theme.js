/* 深色 / 浅色主题切换：一个不和页面打架的小圆钮，选择记在 localStorage */
(function () {
  'use strict';
  var KEY = 'cardflow.theme';
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; }
  }

  function preferred() {
    var saved = stored();
    if (saved === 'dark' || saved === 'light') return saved;
    // 没选过就跟随系统
    try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (_) { return 'light'; }
  }

  function apply(mode) {
    root.setAttribute('data-theme', mode);
    var button = document.getElementById('cfThemeBtn');
    if (button) {
      button.dataset.mode = mode;
      button.textContent = mode === 'dark' ? '☀' : '☾';
      button.title = mode === 'dark' ? '切到浅色模式' : '切到深色模式';
      button.setAttribute('aria-label', button.title);
    }
  }

  function toggle() {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch (_) { /* 隐私模式写不进去就算了 */ }
    apply(next);
  }

  function mount() {
    if (document.getElementById('cfThemeBtn')) return;
    var button = document.createElement('button');
    button.id = 'cfThemeBtn';
    button.type = 'button';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      toggle();
    });
    document.body.appendChild(button);
    apply(preferred());
  }

  apply(preferred());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
