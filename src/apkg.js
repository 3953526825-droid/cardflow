'use strict';
/*
 * .apkg 导出（零依赖：node:sqlite 写 SQLite，src/zip.js 打包）。
 *
 * 用途：不依赖 AnkiConnect / 桌面 Anki 的交付路径 ——
 *   - 手机 AnkiDroid / AnkiMobile 直接打开这个文件就能导入（iOS 上唯一的自动化路径）；
 *   - 电脑上也可以用「文件 > 导入」拿到卡片。
 *
 * 写出的是 schema 11（collection.anki2），这是各平台兼容性最好的版本，新版 Anki 打开会自动升级。
 * 模型用独立的 "CardFlow Basic" / "CardFlow Cloze"，不会覆盖用户已有的模板。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_SQL = `
CREATE TABLE col (
  id integer primary key,
  crt integer not null,
  mod integer not null,
  scm integer not null,
  ver integer not null,
  dty integer not null,
  usn integer not null,
  ls integer not null,
  conf text not null,
  models text not null,
  decks text not null,
  dconf text not null,
  tags text not null
);
CREATE TABLE notes (
  id integer primary key,
  guid text not null,
  mid integer not null,
  mod integer not null,
  usn integer not null,
  tags text not null,
  flds text not null,
  sfld integer not null,
  csum integer not null,
  flags integer not null,
  data text not null
);
CREATE TABLE cards (
  id integer primary key,
  nid integer not null,
  did integer not null,
  ord integer not null,
  mod integer not null,
  usn integer not null,
  type integer not null,
  queue integer not null,
  due integer not null,
  ivl integer not null,
  factor integer not null,
  reps integer not null,
  lapses integer not null,
  left integer not null,
  odue integer not null,
  odid integer not null,
  flags integer not null,
  data text not null
);
CREATE TABLE revlog (
  id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null
);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`;

const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8,ucs,hyperref]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';

const CARD_CSS = [
  '.card {',
  '  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;',
  '  font-size: 20px;',
  '  line-height: 1.65;',
  '  text-align: left;',
  '  color: #203b56;',
  '  background: #f7fbfd;',
  '  padding: 14px 16px;',
  '}',
  '.card b, .card strong { color: #12395f; }',
  '.card img { max-width: 100%; height: auto; }',
  '.card audio { max-width: 100%; }',
  '.card small { color: #61778c; }',
  '.nightMode .card, .night_mode .card { color: #e6edf5; background: #16202b; }',
  '.nightMode .card b, .nightMode .card strong, .night_mode .card b, .night_mode .card strong { color: #cfe4ff; }',
  '.nightMode .card small, .night_mode .card small { color: #9db0c4; }'
].join('\n');

/** 纯文本：给 sfld / csum 用（去掉 HTML、媒体标记与 cloze 包裹） */
function plainText(html) {
  return String(html || '')
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function fieldChecksum(text) {
  const digest = crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
}

function modelDefinitions(nowSec) {
  const basicId = 1699999900001;
  const clozeId = 1699999900002;
  const basic = {
    id: basicId, name: 'CardFlow Basic', type: 0, mod: nowSec, usn: -1, sortf: 0, did: null,
    tmpls: [{
      name: '正面 → 背面', ord: 0,
      qfmt: '{{Front}}',
      afmt: '{{Front}}<hr id=answer>{{Back}}',
      bqfmt: '', bafmt: '', did: null, bfont: '', bsize: 0
    }],
    flds: [
      { name: 'Front', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
      { name: 'Back', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] }
    ],
    css: CARD_CSS, latexPre: LATEX_PRE, latexPost: '\\end{document}', latexsvg: false,
    req: [[0, 'any', [0]]], tags: [], vers: []
  };
  const cloze = {
    id: clozeId, name: 'CardFlow Cloze', type: 1, mod: nowSec, usn: -1, sortf: 0, did: null,
    tmpls: [{
      name: '填空', ord: 0,
      qfmt: '{{cloze:Text}}',
      afmt: '{{cloze:Text}}<br>{{Back Extra}}',
      bqfmt: '', bafmt: '', did: null, bfont: '', bsize: 0
    }],
    flds: [
      { name: 'Text', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
      { name: 'Back Extra', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] }
    ],
    css: CARD_CSS, latexPre: LATEX_PRE, latexPost: '\\end{document}', latexsvg: false,
    req: [], tags: [], vers: []
  };
  return { basic, cloze, ids: { Basic: basicId, Cloze: clozeId } };
}

/**
 * @param {object} input
 *   input.decks  [{ name, notes: [{ model:'Basic'|'Cloze', fields:[...], tags?:string[] }] }]
 *   input.media  [{ filename, data:Buffer }]（可选；文件名要唯一）
 * @returns {Buffer} .apkg 字节
 */
function buildApkg(input) {
  const decks = Array.isArray(input && input.decks) ? input.decks.filter(deck => deck && String(deck.name || '').trim()) : [];
  if (!decks.length) throw new Error('.apkg 导出缺少牌组。');
  const media = Array.isArray(input && input.media) ? input.media.filter(item => item && item.filename && item.data) : [];

  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const models = modelDefinitions(nowSec);

  /* ===== 牌组：父牌组 id=1，子牌组依次 2、3…（名字里的 :: 就是层级） ===== */
  const deckTable = {};
  const deckIds = new Map();
  let nextDeckId = 1;
  const baseDeckFields = name => ({
    name, conf: 1, desc: '', dyn: 0, collapsed: false, extendNew: 10, extendRev: 50,
    newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0],
    browserCollapsed: false, usn: 0, mod: nowSec, maxTaken: 0, closed: false, dyn2: false
  });
  for (const deck of decks) {
    const name = String(deck.name).trim();
    if (deckIds.has(name)) continue;
    const id = nextDeckId++;
    deckIds.set(name, id);
    deckTable[String(id)] = { id, ...baseDeckFields(name) };
  }
  const colConf = {
    nextPos: 1, estTimes: true, activeDecks: [1], sortType: 'noteFld', timeLim: 0,
    sortBackwards: false, addToCur: true, curDeck: 1, newBury: true, newSpread: 0,
    dueCounts: true, curModel: String(models.ids.Basic), collapseTime: 1200
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardflow-apkg-'));
  const dbFile = path.join(dir, 'collection.anki2');
  const db = new DatabaseSync(dbFile);
  let noteSeq = 0;
  const mediaMap = {};
  try {
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      1, nowSec, nowMs, nowMs, 11, 0, 0, 0,
      JSON.stringify(colConf), JSON.stringify({ [models.ids.Basic]: models.basic, [models.ids.Cloze]: models.cloze }),
      JSON.stringify(deckTable), JSON.stringify({ 1: { id: 1, name: 'Default', replayq: true, timer: 0, maxTaken: 60, autoplay: true, mod: 0, usn: 0, addToCur: true, new: { delays: [1, 10], ints: [1, 4], initialFactor: 2500, separate: true, order: 1, perDay: 20, bury: false }, rev: { perDay: 200, ease4: 1.3, ivlFct: 1, maxIvl: 36500, bury: false, hardFactor: 1.2 }, lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 }, dyn: false } }),
      '{}'
    );
    db.exec('BEGIN');
    const insertNote = db.prepare('INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const insertCard = db.prepare('INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    let dueSeq = 0;
    for (const deck of decks) {
      const deckId = deckIds.get(String(deck.name).trim());
      const notes = Array.isArray(deck.notes) ? deck.notes : [];
      for (const note of notes) {
        const modelName = note.model === 'Cloze' ? 'Cloze' : 'Basic';
        const fields = Array.isArray(note.fields) ? note.fields.map(value => String(value == null ? '' : value)) : [];
        const flds = fields.join('\u001f');
        const sfld = plainText(fields[0]);
        const mid = models.ids[modelName];
        const noteId = nowMs + (noteSeq++);
        const guid = crypto.createHash('sha256').update(`${mid}\u001f${flds}`).digest('base64').slice(0, 8);
        const tags = Array.isArray(note.tags) ? note.tags.filter(Boolean).map(tag => String(tag).replace(/\s+/g, '_')).join(' ') : '';
        insertNote.run(noteId, guid, mid, nowMs, -1, tags ? ` ${tags} ` : '', flds, sfld, fieldChecksum(sfld), 0, '');
        insertCard.run(noteId, noteId, deckId, 0, nowMs, -1, 0, 0, dueSeq++, 0, 2500, 0, 0, 0, 0, 0, 0, '');
      }
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }

  media.forEach((item, index) => { mediaMap[String(index)] = item.filename; });
  const entries = [{ name: 'collection.anki2', data: fs.readFileSync(dbFile) }];
  if (media.length) {
    entries.push({ name: 'media', data: Buffer.from(JSON.stringify(mediaMap), 'utf8') });
    media.forEach((item, index) => entries.push({ name: String(index), data: item.data }));
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 临时目录清不掉也无所谓 */ }

  const { zipSync } = require('./zip');
  return zipSync(entries);
}

module.exports = { buildApkg, plainText, fieldChecksum };
