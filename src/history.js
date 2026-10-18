'use strict';
/*
 * 调用历史：每次「生成卡片 / 导入 Anki / 导出文件」写一行 JSON（JSONL），
 * 供网页里的「历史记录」全屏页查看，也是出问题时唯一能回查的记录（服务日志只记启动）。
 *
 * 零依赖，只用 fs；文件超过上限时截断到最近若干条，避免无限增长。
 * 测试用 ANKI_HISTORY_FILE 指向临时文件，绝不会写进用户真正的历史。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* 上限：超了就只保留最近的若干条。默认能装下大约几百次生成（每条记录含卡片正文，
   所以「载入这批卡片」才能用）。测试可用环境变量调小，方便快速验证截断逻辑。 */
function maxBytes() { return Number(process.env.ANKI_HISTORY_MAX_BYTES) || 4 * 1024 * 1024; }
function keepLines() { return Number(process.env.ANKI_HISTORY_KEEP_LINES) || 300; }

function filePath() {
  return process.env.ANKI_HISTORY_FILE || path.join(ROOT, 'history', 'history.jsonl');
}

function trim(file) {
  try {
    if (fs.statSync(file).size <= maxBytes()) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-keepLines());
    fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
  } catch (_) { /* 清理失败不影响主流程 */ }
}

function append(entry) {
  const file = filePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    trim(file);
  } catch (error) {
    console.log(`历史记录写入失败：${error.message}`);
  }
}

/** 最新的在前。损坏的行直接跳过，不让一条坏记录毁掉整个历史页。 */
function read(limit = 100) {
  try {
    const lines = fs.readFileSync(filePath(), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, limit))
      .reverse()
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

/**
 * 改写某一条历史记录（比如「重试这张」采纳新版后把那一张覆盖掉）。
 * mutate 只在第一条时间戳匹配的记录上执行一次；返回是否真的找到了。
 */
function update(stamp, mutate) {
  const file = filePath();
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let found = false;
    const next = lines.map(line => {
      let record;
      try { record = JSON.parse(line); } catch (_) { return line; }
      if (found || Number(record.t) !== Number(stamp)) return line;
      found = true;
      mutate(record);
      return JSON.stringify(record);
    });
    if (found) fs.writeFileSync(file, `${next.join('\n')}\n`);
    return found;
  } catch (_) { return false; }
}

module.exports = { append, read, update, filePath, maxBytes, keepLines };
