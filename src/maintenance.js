'use strict';
/*
 * 维护性功能（都不依赖 AnkiConnect）：
 *   1. 服务端「已出现过的问题」池 —— 跨批次、跨设备的去重依据（浏览器清缓存也不丢）；
 *   2. 一键备份 / 恢复：学科包 + 历史记录 + 前端设置（密钥不进备份，恢复后重填即可）；
 *   3. 诊断包：环境 + 脱敏配置 + AnkiConnect 状态 + 最近历史摘要 + 日志尾部。
 */
const fs = require('node:fs');
const path = require('node:path');
const { zipSync, unzipSync } = require('./zip');

const SEEN_LIMIT = 4000;

function create(options) {
  const dataDir = options.dataDir;
  const packsDir = options.packsDir;
  const version = options.version || '1.0.0';
  const packIdPattern = /^[a-z][a-z0-9-]{1,31}$/;

  const seenPath = () => path.join(dataDir, 'seen.json');

  function readAll() {
    try {
      const raw = JSON.parse(fs.readFileSync(seenPath(), 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch (_) { return {}; }
  }

  /** 某个学科已经出现过的问题（小写、去空白与标点后的文本），用于跨批次去重 */
  function readSeen(subjectId) {
    const all = readAll();
    const list = Array.isArray(all[subjectId]) ? all[subjectId] : [];
    return list.filter(item => typeof item === 'string');
  }

  /** 记一批问题文本进池子（超上限丢最老的） */
  function addSeen(subjectId, texts) {
    const incoming = (Array.isArray(texts) ? texts : [])
      .map(text => String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''))
      .filter(text => text.length >= 2);
    if (!incoming.length) return { added: 0, total: readSeen(subjectId).length };
    const all = readAll();
    const list = Array.isArray(all[subjectId]) ? all[subjectId].filter(item => typeof item === 'string') : [];
    const known = new Set(list);
    let added = 0;
    for (const text of incoming) {
      if (known.has(text)) continue;
      known.add(text);
      list.push(text);
      added++;
    }
    all[subjectId] = list.slice(-SEEN_LIMIT);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(seenPath(), JSON.stringify(all));
    } catch (_) { /* 写不进去不致命：下批再试 */ }
    return { added, total: all[subjectId].length };
  }

  /** 读目录里所有学科包文件（只取 *.json） */
  function readPacks() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(packsDir); } catch (_) { return out; }
    for (const name of names) {
      if (!name.endsWith('.json') || !packIdPattern.test(name.replace(/\.json$/, ''))) continue;
      try { out.push({ name, data: fs.readFileSync(path.join(packsDir, name)) }); } catch (_) { /* 读不了就跳过 */ }
    }
    return out;
  }

  /**
   * 备份包：zip 里放 meta.json / packs/ / history.jsonl / settings.json
   * settings 由前端传进来（它存在浏览器 localStorage 里）。
   */
  function exportBackup(context = {}) {
    const entries = [];
    const meta = {
      kind: 'cardflow-backup',
      version,
      generatedAt: new Date().toISOString(),
      subjects: Array.isArray(context.subjects) ? context.subjects : [],
      includesHistory: false,
      includesPacks: false,
      includesSettings: Boolean(context.settings && typeof context.settings === 'object')
    };
    entries.push({ name: 'meta.json', data: Buffer.from(JSON.stringify(meta, null, 2), 'utf8') });
    for (const pack of readPacks()) {
      entries.push({ name: `packs/${pack.name}`, data: pack.data });
      meta.includesPacks = true;
    }
    if (context.historyText) {
      entries.push({ name: 'history.jsonl', data: Buffer.from(String(context.historyText), 'utf8') });
      meta.includesHistory = true;
    }
    if (meta.includesSettings) entries.push({ name: 'settings.json', data: Buffer.from(JSON.stringify(context.settings, null, 2), 'utf8') });
    // meta 放在最前面，但 includesX 是后来才填的，所以重新写一次
    entries[0] = { name: 'meta.json', data: Buffer.from(JSON.stringify(meta, null, 2), 'utf8') };
    return { buffer: zipSync(entries), meta };
  }

  /**
   * 恢复：只认 zip 里的 packs/*.json 与 history.jsonl；覆盖前把旧文件挪进 backups/。
   * @returns {{packs:number, history:boolean, settings:object|null, backupDir:string|null}}
   */
  function restoreBackup(buffer) {
    const files = unzipSync(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backupDir = path.join(path.dirname(packsDir), 'backups', `restore-${stamp}`);
    let saved = 0;
    let settings = null;
    let historyWritten = false;
    fs.mkdirSync(packsDir, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      if (name.startsWith('packs/')) {
        const id = name.slice('packs/'.length).replace(/\.json$/, '');
        if (!packIdPattern.test(id)) continue;
        const target = path.join(packsDir, `${id}.json`);
        try {
          if (fs.existsSync(target)) {
            fs.mkdirSync(backupDir, { recursive: true });
            fs.copyFileSync(target, path.join(backupDir, `${id}.json`));
          }
          fs.writeFileSync(target, data);
          saved++;
        } catch (_) { /* 单个包写失败不影响其它 */ }
      } else if (name === 'history.jsonl' && options.historyFile) {
        try {
          if (fs.existsSync(options.historyFile)) {
            fs.mkdirSync(backupDir, { recursive: true });
            fs.copyFileSync(options.historyFile, path.join(backupDir, 'history.jsonl'));
          }
          fs.mkdirSync(path.dirname(options.historyFile), { recursive: true });
          fs.writeFileSync(options.historyFile, data);
          historyWritten = true;
        } catch (_) { /* 历史写不进去就只恢复学科包 */ }
      } else if (name === 'settings.json') {
        try { settings = JSON.parse(data.toString('utf8')); } catch (_) { settings = null; }
      }
    }
    return { packs: saved, history: historyWritten, settings, backupDir: saved || historyWritten ? backupDir : null };
  }

  /** 诊断包：够定位问题，又不含任何密钥 */
  function diagnose(context = {}) {
    const config = context.config || {};
    const sanitizeUrl = value => {
      try { return new URL(String(value || '')).origin; } catch (_) { return String(value || '') ? '（非标准 URL，已省略）' : ''; }
    };
    const logTail = (() => {
      if (!context.logFile) return '';
      try {
        const text = fs.readFileSync(context.logFile, 'utf8');
        return text.split(/\r?\n/).slice(-120).join('\n');
      } catch (_) { return '（日志文件读不到）'; }
    })();
    return {
      kind: 'cardflow-diagnose',
      version,
      generatedAt: new Date().toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid },
      subject: context.subject || '',
      config: {
        apiUrlOrigin: sanitizeUrl(config.apiUrl),
        model: config.model || '',
        hasApiKey: Boolean(config.apiKey),
        hasTavilyKey: Boolean(config.tavilyKey),
        hasZhihuKey: Boolean(config.zhihuKey),
        hasToken: Boolean(config.token),
        ttsAvailable: Boolean(context.tts)
      },
      anki: context.anki || { checked: false },
      history: Array.isArray(context.history) ? context.history : [],
      seenCount: Number(context.seenCount) || 0,
      log: logTail
    };
  }

  return { readSeen, addSeen, exportBackup, restoreBackup, diagnose, SEEN_LIMIT };
}

module.exports = { create, SEEN_LIMIT };
