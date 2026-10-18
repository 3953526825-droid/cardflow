'use strict';
/*
 * 手机端的学科包：导入 / 编辑 / 复制 / 删除，并按学科包拼出卡片页。
 *
 * 三份存储（都在 localStorage）：
 *   cardflow.offline.packs      手机上导入的学科包
 *   cardflow.offline.overrides  对「打包进 APK 的学科包」的修改（改的是本机副本，不动 APK 里的原件）
 *   cardflow.offline.hidden     从列表里去掉的学科包 id
 *
 * 卡片页不是从零渲染的：它是「基础学科页」（打包时渲染好的那个学科的静态页）+ 学科包的差异拼出来的。
 * 差异只有标题、学科名、副标题、卡片数量上下限与提示、检索词/牌组名/额外规则占位符、学科下拉、
 * 内联学科配置、app.js 版本号、资料框副标题这几处，拼装逻辑在 src/shared/pack-schema.js 的 packPageFromBase
 * （与电脑端渲染学科包页面用的是同一套规则），少一处就报错，不会悄悄拼出一个怪页面。
 */
(function () {
  const STORE = 'cardflow.offline.packs';
  const OVERRIDES = 'cardflow.offline.overrides';
  const HIDDEN = 'cardflow.offline.hidden';
  // 学科包相关的纯逻辑在 shared/pack-schema.js（挂在自己的全局上，避免与 CardFlowShared.validate 撞名）
  const PACKS = window.CardFlowPacks || {};

  /* 与电脑端 public/cardflow.js 的「复制提示词」同一段（手机上没有服务器，这里自带一份） */
  const PACK_PROMPT = '请为【考试·科目】制作备考 Anki 学科包，只输出一个 JSON 对象，不加代码围栏、不要任何解释。字段：schemaVersion=1，id（2–32 位小写英文数字连字符），exam，subject，name，description（可选），cardCount:{min,max}（1–100），search:{subjectPrefix,catalogSuffix,preferredDomains:[域名]}，prompts:{generate,reference,identify,locate}（每段 20 字以上），chemFormulas（可选，true/false：这个科目要不要把 CO2、H2O 这类化学式转成 Anki 的 \\ce 规范写法，化学类科目填 true，其它科目省略或填 false）。内容围绕该考试的考频、权重、题型、易错点和考场作答。generate 使用 {{$min}} {{$max}} {{$extra}} {{$weight}} 变量，reference 使用 {{$reference}}，locate 使用 {{$topic}} {{$keypoints}} {{$evidence}}。不要包含密钥、URL、HTML、路径或服务端指令。重要：四段提示词的文本里不要出现英文双引号，需要指代字段名时用单引号（例如 cards 字段）——否则 JSON 会被引号截断、根本导不进来。generate 段里还要说明生成卡片时的输出格式：只输出一个 JSON 对象，卡片数组放在 cards 字段里，不要直接把数组当顶层、不要代码围栏、不要多余说明。';

  function readObject(key) {
    try {
      const raw = localStorage.getItem(key);
      const value = raw ? JSON.parse(raw) : {};
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) { return {}; }
  }
  function writeObject(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }
  function readArray(key) {
    try {
      const raw = localStorage.getItem(key);
      const value = raw ? JSON.parse(raw) : [];
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }
  const readPacks = () => readObject(STORE);
  const readOverrides = () => readObject(OVERRIDES);
  const readHidden = () => readArray(HIDDEN);

  async function textOf(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`取不到 ${url}（HTTP ${response.status}）`);
    return response.text();
  }

  let context = null;
  /** base-page.html / subject-base.json / pages.json：拼装学科包页面和列学科都要用 */
  async function loadContext() {
    if (context) return context;
    const [baseHtml, baseSubject, pages] = await Promise.all([
      textOf('/base-page.html'),
      textOf('/subject-base.json').then(JSON.parse),
      textOf('/pages.json').then(JSON.parse)
    ]);
    context = { baseHtml, baseSubject, pages };
    return context;
  }

  /**
   * 当前这台设备上能用的学科包：打包时带进来的 + 手机上自己导入的，去掉被隐藏的。
   * 每个条目的 json 就是「打开/编辑」要用的那份数据（改过的优先）。
   * 内置学科（如示例学科）不是学科包（json 为 null），不参与编辑。
   */
  async function catalog() {
    const ctx = await loadContext();
    const hidden = readHidden();
    const overrides = readOverrides();
    const local = readPacks();
    const list = [];
    const seen = new Set();
    const add = (id, fallbackName, packaged) => {
      if (!id || seen.has(id) || hidden.includes(id)) return;
      seen.add(id);
      const own = local[id] || null;
      const json = overrides[id] || own || (packaged ? packaged : null);
      if (!json) return;
      list.push({ id, name: json.name || fallbackName || id, json, local: Boolean(own), modified: Boolean(overrides[id]) });
    };
    ((ctx.pages && ctx.pages.subjects) || []).forEach(item => add(item.id, item.name, item.pack ? item.json : null));
    Object.values(local).forEach(pack => add(pack.id, pack.name, null));
    return list;
  }
  /** 学科下拉用的清单：打包时的全部学科（含内置学科），名字跟着改过的包走 ——
   *  前面这一段要和 build-shell 生成静态页时的 pages.subjects.map({id,name}) 保持一致。
   *  后面再接上「手机自己导入的包」：它们没有对应的静态页，值用 pack:<id>，
   *  由卡片页脚本调 openPack 打开 —— 否则下拉与学科包列表两边对不上（真机反馈）。 */
  async function subjectList() {
    const ctx = await loadContext();
    const items = await catalog();
    const hidden = readHidden();
    const names = new Map(items.map(item => [item.id, item.name]));
    // 被隐藏的学科不出现在下拉里（选择页长按隐藏，设置里可恢复）
    const list = ((ctx.pages && ctx.pages.subjects) || [])
      .filter(item => !hidden.includes(item.id))
      .map(item => ({ id: item.id, name: names.get(item.id) || item.name }));
    const seen = new Set(list.map(item => item.id));
    items.forEach(item => {
      if (seen.has(item.id) || !item.local) return;
      seen.add(item.id);
      list.push({ id: item.id, name: item.name, href: `pack:${item.id}` });
    });
    return list;
  }

  async function itemOf(id) {
    return (await catalog()).find(item => item.id === id) || null;
  }

  /** 打包进 App 的学科 id（含内置科目）。
   *  保存学科包时用它区分「改内置包（存 overrides）」还是「新增自己的包（存 packs）」。 */
  async function packagedIds() {
    try {
      const ctx = await loadContext();
      return new Set(((ctx.pages && ctx.pages.subjects) || []).map(item => item.id));
    } catch (_) { return new Set(); }
  }

  /** 打开学科包：拼出卡片页后整页替换（脚本会重新执行，与静态页同一条路） */
  async function openPack(id) {
    const item = await itemOf(id);
    if (!item) throw new Error('找不到这个学科包（可能已经被删掉了）。');
    const ctx = await loadContext();
    const html = PACKS.packPageFromBase(ctx.baseHtml, ctx.baseSubject, item.json, await subjectList());
    document.open();
    document.write(html);
    document.close();
  }

  /** 保存编辑结果：校验规则与电脑端完全同一份（字段白名单、id 格式、prompts 段落…）。
   *  同一个 id 再导一次就是「改」；打包进 App 的包改的是本机副本（存在 overrides 里）。
   *  存储位置看「这个 id 是不是打包时带来的学科」，而不是「本机有没有同名包」：
   *  手机自己新导入的包必须落进 packs，否则选择页列表刷不出来（真机实测的 bug）。 */
  async function savePack(source, expectedId) {
    if (!PACKS.validate) throw new Error('页面脚本没加载完，请重开一次 App。');
    let raw;
    try { raw = JSON.parse(String(source)); } catch (error) {
      throw new Error('这段内容不是合法的 JSON（' + (error && error.message ? error.message : '语法错误') + '）。'
        + '最常见的坑：AI 在提示词文本里写了 {"cards":…} 这类带英文双引号的例子却没转义，引号把 JSON 截断了。'
        + '把提示词里的双引号换成单引号，让 AI 重新生成一次；或手动把那些引号改成 \\" 再导入。');
    }
    const pack = PACKS.validate(raw);
    if (expectedId && pack.id !== expectedId) throw new Error(`id 不能改（原来是 ${expectedId}），改了就是另一个包。`);
    const local = readPacks();
    const packaged = (await packagedIds()).has(pack.id);
    if (local[pack.id] || !packaged) {
      local[pack.id] = pack;
      if (!writeObject(STORE, local)) throw new Error('本机存储写不进去（空间不足或被系统限制）。');
    } else {
      const overrides = readOverrides();
      overrides[pack.id] = pack;
      if (!writeObject(OVERRIDES, overrides)) throw new Error('本机存储写不进去（空间不足或被系统限制）。');
    }
    // 之前隐藏过同名包的话，重新导入/保存就让它回来
    const hidden = readHidden();
    if (hidden.includes(pack.id)) writeObject(HIDDEN, hidden.filter(id => id !== pack.id));
    return pack;
  }

  function removePack(item) {
    if (item.local) {
      const local = readPacks();
      delete local[item.id];
      writeObject(STORE, local);
      return '已删除';
    }
    const overrides = readOverrides();
    delete overrides[item.id];
    writeObject(OVERRIDES, overrides);
    const hidden = readHidden();
    if (!hidden.includes(item.id)) { hidden.push(item.id); writeObject(HIDDEN, hidden); }
    return '已从列表里去掉（重装 App 会回来）';
  }

  function resetPack(item) {
    const overrides = readOverrides();
    delete overrides[item.id];
    writeObject(OVERRIDES, overrides);
  }

  /* ===== 界面 ===== */
  let lastLongPressAt = 0;

  function setNote(message, kind) {
    const note = document.getElementById('packNote');
    if (note) {
      note.textContent = message;
      note.className = 'cfPackMsg' + (kind === 'error' ? ' isError' : kind === 'ok' ? ' isOk' : '');
    }
    // 装/改学科包那块默认是收起的：出错就把它展开并把消息滚进视野，别让「点了没反应」
    if (kind) {
      const box = document.getElementById('packBox');
      if (box && kind === 'error') box.open = true;
      if (note) { try { note.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) { note.scrollIntoView(); } }
    }
  }

  async function copyText(text, okMessage) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        setNote(okMessage);
        return true;
      }
    } catch (_) { /* 下面兜底 */ }
    const box = document.getElementById('packText');
    if (box) {
      box.value = text;
      box.focus();
      box.select();
      try { if (document.execCommand('copy')) { setNote(okMessage); return true; } } catch (_) {}
      setNote('自动复制不可用：内容已放进下面的输入框，长按选中复制即可。');
      return true;
    }
    setNote('这台设备不支持自动复制，请长按选中内容手动复制。');
    return false;
  }

  function button(label, className, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (className) element.className = className;
    element.addEventListener('click', onClick);
    return element;
  }

  /** 弹出一个底部操作菜单 */
  function actionSheet(title, actions) {
    const sheet = document.createElement('dialog');
    sheet.className = 'cfSheet';
    const heading = document.createElement('h2');
    heading.textContent = title;
    sheet.append(heading);
    actions.forEach(action => sheet.append(button(action.label, action.danger ? 'danger' : '', () => {
      sheet.close();
      action.run();
    })));
    sheet.append(button('取消', 'cancel', () => sheet.close()));
    document.body.append(sheet);
    sheet.addEventListener('close', () => sheet.remove());
    sheet.showModal();
  }

  /** 长按：手机上不习惯把「删除」直接摆在行里，改成按住弹出菜单 */
  function longPress(element, handler) {
    let timer = null;
    const begin = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; lastLongPressAt = Date.now(); handler(); }, 500);
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

  /** 学科包行：点开、长按出菜单。非学科包（内置学科）不接菜单。 */
  function attachRow(row, item, onChanged) {
    const link = row.querySelector('.cfPick');
    if (link) link.addEventListener('click', event => {
      event.preventDefault();
      if (Date.now() - lastLongPressAt < 800) return;
      openPack(item.id).catch(error => setNote(`打开失败：${error.message}`, 'error'));
    });
    const nameBox = row.querySelector('.cfPickName');
    if (nameBox) {
      const label = item.local || item.modified ? `${item.name}（本机）` : item.name;
      if (nameBox.textContent !== label) nameBox.textContent = label;
    }
    longPress(row, () => actionSheet(item.name, [
      { label: '编辑学科包', run: () => openEditor(item.id, onChanged) },
      { label: '复制 JSON', run: () => copyText(JSON.stringify(item.json, null, 2), `已复制「${item.name}」的 JSON。`) },
      { label: item.local ? '删除' : '从列表里去掉', danger: true, run: () => {
        if (!confirm(item.local ? `删除学科包「${item.name}」？（已经生成的卡片与历史不会动）` : `把「${item.name}」从列表里去掉？（它已经打包进 App，删不掉文件；重装 App 会回来）`)) return;
        setNote(`${removePack(item)}：${item.name}`);
        onChanged();
      } }
    ]));
  }

  /** 学科包编辑器：JSON 直接改，校验与电脑端同一份 */
  async function openEditor(id, onChanged) {
    const item = await itemOf(id);
    if (!item) return setNote('找不到这个学科包。', 'error');
    const dialog = document.createElement('dialog');
    dialog.className = 'cfEditor';
    const heading = document.createElement('h2');
    heading.textContent = `编辑学科包：${item.name}`;
    const hint = document.createElement('div');
    hint.className = 'cfEditorNote';
    hint.textContent = item.local ? '这是本机导入的包。' : '这是打包进 App 的包，改动只存在这台手机上，可以「恢复默认」。';
    const box = document.createElement('textarea');
    box.spellcheck = false;
    box.value = JSON.stringify(item.json, null, 2);
    const note = document.createElement('div');
    note.className = 'cfEditorNote';
    // 公式转换开关：勾上就把包里的 chemFormulas 设为 true（预览/导入时把 CO2、H2O 这类裸公式转成 \ce 规范写法）。
    const chemRow = document.createElement('label');
    chemRow.className = 'cfEditorCheck';
    chemRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:6px 0;font-size:13px';
    const chemBox = document.createElement('input');
    chemBox.type = 'checkbox';
    chemBox.style.cssText = 'flex:0 0 auto;width:auto;min-width:0';
    chemBox.checked = Boolean(item.json && item.json.chemFormulas);
    chemRow.append(chemBox, document.createTextNode(' 化学式转换（把 CO2、H2O 这类裸化学式转成 Anki 的 \\(\\ce{...}\\)）'));
    chemBox.addEventListener('change', () => {
      try {
        const data = JSON.parse(box.value);
        if (chemBox.checked) data.chemFormulas = true; else delete data.chemFormulas;
        box.value = JSON.stringify(data, null, 2);
        note.textContent = chemBox.checked ? '已打开化学式转换（点「保存」后生效）。' : '已关闭化学式转换（点「保存」后生效）。';
      } catch (_) {
        chemBox.checked = !chemBox.checked;
        note.textContent = '上面的 JSON 现在不是合法内容，先修好 JSON 再切换这个开关。';
      }
    });
    const row = document.createElement('div');
    row.className = 'cfEditorRow';
    const close = () => dialog.close();
    row.append(
      button('保存', '', async () => {
        try {
          const pack = await savePack(box.value, item.id);
          note.textContent = `已保存「${pack.name}」。`;
          setTimeout(() => { dialog.close(); onChanged(); }, 500);
        } catch (error) { note.textContent = `保存失败：${error.message}`; }
      }),
      button('复制', '', () => {
        const text = box.value;
        const done = () => { note.textContent = '已复制编辑器里的 JSON。'; };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, () => { note.textContent = '复制不可用，请长按选中。'; }); return; }
        } catch (_) { /* 走下面的兑底 */ }
        box.select();
        note.textContent = '复制不可用，已帮你选中，长按内容再复制。';
      }),
      button('恢复默认', '', () => {
        if (!item.modified) return (note.textContent = '这个包没有被改过。');
        if (!confirm('放弃本机修改，恢复成 App 里打包的版本？')) return;
        resetPack(item);
        dialog.close();
        onChanged();
      }),
      button('取消', '', close)
    );
    dialog.append(heading, hint, chemRow, box, note, row);
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  }

  /** 设置面板里的「学科包」区块（由 settings.js 挂进去；电脑端没有这个全局，不受影响） */
  function settingsSection() {
    const section = document.createElement('section');
    section.className = 'cfPacks';
    const heading = document.createElement('h3');
    heading.textContent = '学科包';
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = '在这里改学科包的提示词、卡片数量上下限等；打包进 App 的包改的是本机副本，随时可以恢复默认。';
    section.append(heading, hint);
    const list = document.createElement('div');
    section.append(list);
    const refresh = () => {
      list.textContent = '';
      catalog().then(items => {
        if (!items.length) { list.textContent = '还没有可编辑的学科包。'; return; }
        items.forEach(item => {
          const rowItem = document.createElement('div');
          rowItem.className = 'cfPackItem';
          const name = document.createElement('span');
          name.className = 'cfPackName';
          name.textContent = item.modified ? `${item.name}（已改）` : item.name;
          rowItem.append(name, button('编辑', '', () => openEditor(item.id, refresh)));
          list.append(rowItem);
        });
      }).catch(error => { list.textContent = `读取失败：${error.message}`; });
    };
    refresh();
    return section;
  }

  /* ===== 页面初始化 ===== */
  function appendLocalRow(container, item, onChanged) {
    const holder = document.createElement('div');
    holder.innerHTML = '<a class="cfPick" href="#"><span class="cfBadge" aria-hidden="true"></span><span class="cfPickText"><span class="cfPickName"></span><span class="cfPickSub"></span></span><span class="cfPickGo" aria-hidden="true">›</span></a>';
    const link = holder.firstChild;
    const pack = item.json || {};
    link.querySelector('.cfPickName').textContent = item.name;
    link.querySelector('.cfBadge').textContent = String(pack.subject || item.name || '制').slice(0, 1);
    const sub = link.querySelector('.cfPickSub');
    const subText = [pack.exam, pack.subject].filter(Boolean).join(' · ');
    if (subText) sub.textContent = subText; else sub.remove();
    const row = document.createElement('div');
    row.className = 'packRow';
    row.dataset.id = item.id;
    row.dataset.pack = '1';
    row.append(link);
    container.append(row);
    attachRow(row, item, onChanged);
  }

  /** 卡片页的学科下拉：静态页里只有打包时的学科，把「本机导入的包」补进去（值 pack:<id>，
   *  由卡片页脚本调 openPack 打开）；顺手把改过名字的包在下拉里也更新成新名字。
   *  选择页没有 #subjectSwitch，这里直接跳过。 */
  function syncSubjectOptions() {
    const select = document.getElementById('subjectSwitch');
    if (!select) return;
    return catalog().then(items => {
      const names = new Map(items.map(item => [item.id, item.name]));
      const hidden = readHidden();
      // 打包进来的学科：值形如 index-<id>.html；被隐藏的直接去掉，改过名字的跟着新名字走
      [...select.options].forEach(option => {
        const matched = String(option.value).match(/^index-(.+)\.html$/);
        if (matched && hidden.includes(matched[1])) { option.remove(); return; }
        const name = matched && names.has(matched[1]) ? names.get(matched[1]) : null;
        if (name && option.textContent !== name) option.textContent = name;
      });
      // 本机导入的包：静态页里没有这一项，补在最后
      const have = new Set([...select.options].map(option => option.value));
      items.filter(item => item.local).forEach(item => {
        const value = `pack:${item.id}`;
        if (have.has(value)) return;
        const option = document.createElement('option');
        option.value = value;
        option.textContent = item.name;
        select.append(option);
        have.add(value);
      });
    }).catch(() => {});
  }

  function bind() {
    const packList = document.getElementById('packList');
    const holder = document.getElementById('packExtra');
    // 从卡片页的学科下拉切到「本机导入的包」时，会导航到 index.html?pack=<id>；
    // 这里负责把它打开（选择页没有卡片页的学科下拉，只能在入口处认这个参数）。
    if (packList && typeof location !== 'undefined') {
      const wanted = /[?&]pack=([^&]+)/.exec(String(location.search || ''));
      if (wanted) {
        openPack(decodeURIComponent(wanted[1])).catch(error => setNote(`打开失败：${error.message}`, 'error'));
      }
    }
    const refresh = () => {
      catalog().then(items => {
        if (!items.length) return;
        // 打包进来的学科包行：在静态 HTML 里，按 id 认领；隐藏的删掉。
        // 只有 data-pack 的行才碰 —— 生物/化学不是学科包，千万别动它们。
        if (packList) {
          packList.querySelectorAll('.packRow[data-pack][data-id]').forEach(row => {
            const item = items.find(entry => entry.id === row.dataset.id);
            if (!item) { row.remove(); return; }
            attachRow(row, item, refresh);
          });
        }
        // 手机上导入的包：静态 HTML 里没有，动态补在下面
        if (holder) {
          holder.textContent = '';
          items.filter(item => item.local).forEach(item => {
            if (packList && packList.querySelector(`.packRow[data-id="${item.id}"]`)) return;
            appendLocalRow(holder, item, refresh);
          });
        }
      }).catch(() => {});
    };
    const input = document.getElementById('packFile');
    if (input) input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      try {
        setNote('正在导入……');
        const pack = await savePack(await file.text(), null);
        refresh();
        setNote(`已导入「${pack.name}」：点它就能开始制卡。`, 'ok');
      } catch (error) {
        setNote(`导入失败：${error.message}`, 'error');
      }
    });
    const box = document.getElementById('packText');
    const save = document.getElementById('packSave');
    if (save) save.addEventListener('click', async () => {
      const source = box ? box.value.trim() : '';
      if (!source) return setNote('先粘贴学科包 JSON（或选择文件）。', 'error');
      try {
        const pack = await savePack(source, null);
        if (box) box.value = '';
        refresh();
        setNote(`已保存「${pack.name}」：点它就能开始制卡。`, 'ok');
      } catch (error) {
        setNote(`保存失败：${error.message}`, 'error');
      }
    });
    const prompt = document.getElementById('packPrompt');
    if (prompt) prompt.addEventListener('click', () => {
      copyText(PACK_PROMPT, '已复制提示词：粘给 AI，把【考试·科目】换成目标科目，拿到 JSON 再粘回上面的输入框。');
    });
    refresh();
    syncSubjectOptions();
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('DOMContentLoaded', bind);

  // 按 schema 的已有全局合并（保留 validate / packPageFromBase，别把共享层盖掉）
  window.CardFlowPacks = Object.assign({}, PACKS, {
    readPacks, readOverrides, catalog, subjectList, openPack, savePack, removePack, resetPack, settingsSection, syncSubjectOptions, PACK_PROMPT
  });
})();
