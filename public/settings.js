'use strict';
/* 全局设置弹窗 + 选择页的「长按隐藏学科」。
   隐藏状态与 pack-import.js 共用同一份本机记录（cardflow.offline.hidden，字符串数组），
   所以「从列表里去掉的学科包」和「长按隐藏的内置学科」能在同一个设置区块里恢复。
   本脚本在选择页（电脑版 / 离线版）都会加载；卡片页不加载它，学科下拉的过滤在 app.js 里做。 */
(function () {
  const HIDDEN = 'cardflow.offline.hidden';
  function readHidden() {
    try {
      const value = JSON.parse(localStorage.getItem(HIDDEN) || '[]');
      return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
    } catch (_) { return []; }
  }
  function writeHidden(list) {
    try { localStorage.setItem(HIDDEN, JSON.stringify([...new Set(list)])); return true; } catch (_) { return false; }
  }
  /** 选择页上的学科行：电脑版是 #packList 下的 li，离线版是 .packRow（都带 data-id / data-name）。 */
  const subjectRows = () => [...document.querySelectorAll('#packList [data-id]')];
  function rowName(row) {
    if (!row) return '';
    const named = row.getAttribute('data-name');
    if (named) return named;
    const label = row.querySelector('.cfPickName, .packText b');
    return (label && label.textContent) || row.getAttribute('data-id') || '';
  }
  function notify(text) {
    const note = document.getElementById('packNote') || document.getElementById('packStatus');
    if (note) {
      note.textContent = text;
      note.className = 'cfPackMsg isOk';
    }
  }
  /** 把记录里被隐藏的学科行藏起来（不删 DOM：设置里恢复时还要用它的名字）。 */
  function applyHidden() {
    const hidden = readHidden();
    subjectRows().forEach(row => { row.hidden = hidden.includes(row.getAttribute('data-id')); });
  }

  /* ===== 长按：手机上不习惯把「隐藏」摆在行里；按住 0.55 秒弹确认 ===== */
  let lastLongPressAt = 0;
  function longPress(element, handler) {
    let timer = null;
    const begin = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; lastLongPressAt = Date.now(); handler(); }, 550);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    element.addEventListener('touchstart', begin, { passive: true });
    element.addEventListener('touchmove', cancel, { passive: true });
    element.addEventListener('touchend', cancel);
    element.addEventListener('touchcancel', cancel);
    element.addEventListener('mousedown', begin);
    element.addEventListener('mouseup', cancel);
    element.addEventListener('mouseleave', cancel);
    element.addEventListener('contextmenu', event => event.preventDefault());
  }

  /** 只给「内置学科」绑定长按隐藏；学科包行（data-pack）由 pack-import.js 的菜单管理。 */
  function bindHide() {
    subjectRows().forEach(row => {
      if (row.getAttribute('data-pack')) return;
      const link = row.querySelector('a');
      // 长按抬手时浏览器还会补一次 click：拦掉它，别顺手把页面打开了
      if (link) link.addEventListener('click', event => {
        if (Date.now() - lastLongPressAt < 800) { event.preventDefault(); event.stopPropagation(); }
      }, true);
      longPress(row, () => {
        const id = row.getAttribute('data-id');
        const name = rowName(row);
        if (!confirm(`隐藏「${name}」？\n隐藏后它会从选择页和学科页的学科包选择里消失；需要时可在「设置 → 学科显示」里恢复。`)) return;
        if (!writeHidden([...readHidden(), id])) return notify('本机存储写不进去，没能隐藏。');
        applyHidden();
        notify(`已隐藏「${name}」。可在设置里恢复。`);
      });
    });
  }

  /** 设置弹窗里的「学科显示」：列出被隐藏的学科，点「恢复」就回到选择页与下拉里。 */
  function hiddenSection() {
    const section = document.createElement('section');
    section.className = 'cfSettingsSubjects';
    const heading = document.createElement('h3');
    heading.textContent = '学科显示';
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = '长按选择页的学科可以隐藏；这里恢复被隐藏的学科（学科包也能在这里恢复）。';
    const list = document.createElement('div');
    const render = () => {
      list.textContent = '';
      const hidden = readHidden();
      if (!hidden.length) { list.textContent = '没有被隐藏的学科。'; return; }
      hidden.forEach(id => {
        const item = document.createElement('div');
        item.className = 'cfPackItem';
        const name = document.createElement('span');
        name.className = 'cfPackName';
        name.textContent = rowName(subjectRows().find(row => row.getAttribute('data-id') === id)) || id;
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.textContent = '恢复';
        restore.onclick = () => {
          if (!writeHidden(readHidden().filter(item => item !== id))) return;
          applyHidden();
          render();
          notify(`已恢复「${name.textContent}」。`);
        };
        item.append(name, restore);
        list.append(item);
      });
    };
    render();
    section.append(heading, hint, list);
    return section;
  }

  applyHidden();
  bindHide();

  const button = document.getElementById('globalSettings');
  if (!button) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'cfSettings';
  dialog.innerHTML = '<form method="dialog"><h2>全局设置</h2><p>保存在当前浏览器，适用于此地址下的全部学科包。密钥仍在原配置中管理。</p><div id="ruleRows"></div><button type="button" id="ruleAdd">添加规则</button><label>每批最多页数（1–25，越大越省事，但一次生成更慢、更容易被截断）<input id="settingBatch" type="number" min="1" max="25"></label><label><input type="checkbox" id="settingVisual">保留 PDF 页面图像（遮挡卡需要）</label><label>问题过长阈值<input id="settingQuestion" type="number" min="40" max="2000"></label><label>答案过载阈值<input id="settingAnswer" type="number" min="80" max="10000"></label><label><input type="checkbox" id="settingDup">检查重复卡</label><label><input type="checkbox" id="settingSources">预览显示来源</label><p id="settingsMessage" role="status"></p><div><button value="cancel">取消</button><button id="settingsSave" type="button">保存设置</button></div></form>';
  document.body.append(dialog);
  const form = dialog.querySelector('form') || dialog;
  // 「学科显示」放在保存按钮前（与学科包区块并列）
  form.insertBefore(hiddenSection(), form.lastElementChild);
  if (window.CardFlowPacks && typeof window.CardFlowPacks.settingsSection === 'function') {
    try {
      const extra = window.CardFlowPacks.settingsSection();
      if (extra) form.insertBefore(extra, form.lastElementChild);
    } catch (_) { /* 学科包区块初始化失败不影响其它设置 */ }
  }
  const e = id => dialog.querySelector('#' + id);
  function row(rule = { text: '', enabled: true }) {
    const r = document.createElement('div');
    r.className = 'ruleRow';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = rule.enabled !== false;
    const text = document.createElement('textarea');
    text.rows = 2;
    text.maxLength = 2000;
    text.value = rule.text || '';
    text.placeholder = '例如：每张卡只考一个知识点';
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '移除';
    del.onclick = () => r.remove();
    r.append(check, text, del);
    e('ruleRows').append(r);
  }
  button.onclick = () => {
    const s = CardFlowCore.settings();
    e('ruleRows').replaceChildren();
    s.rules.forEach(row);
    e('settingBatch').value = s.batchSize;
    e('settingVisual').checked = s.visual;
    e('settingQuestion').value = s.questionLimit;
    e('settingAnswer').value = s.answerLimit;
    e('settingDup').checked = s.duplicateCheck;
    e('settingSources').checked = s.showSources;
    applyHidden();
    dialog.showModal();
  };
  e('ruleAdd').onclick = () => { if (e('ruleRows').children.length < 30) row(); };
  e('settingsSave').onclick = () => {
    const rules = [...e('ruleRows').children].map(r => ({ enabled: r.children[0].checked, text: r.children[1].value.trim() })).filter(r => r.text);
    const s = { rules, batchSize: Number(e('settingBatch').value), visual: e('settingVisual').checked, questionLimit: Number(e('settingQuestion').value), answerLimit: Number(e('settingAnswer').value), duplicateCheck: e('settingDup').checked, showSources: e('settingSources').checked };
    if (!Number.isInteger(s.batchSize) || s.batchSize < 1 || s.batchSize > 25 || s.questionLimit < 40 || s.questionLimit > 2000 || s.answerLimit < 80 || s.answerLimit > 10000 || rules.reduce((n, r) => n + r.text.length, 0) > 20000) {
      e('settingsMessage').textContent = s.batchSize < 1 || s.batchSize > 25 ? '每批页数只能填 1–25。' : '请检查范围；全局规则累计上限 2 万字。';
      return;
    }
    try {
      localStorage.setItem('cardflow.settings', JSON.stringify(s));
      dialog.close();
    } catch (_) {
      e('settingsMessage').textContent = '本机存储已满，未保存。';
    }
  };
})();
