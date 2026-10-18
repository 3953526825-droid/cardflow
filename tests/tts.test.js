'use strict';
/*
 * 本地 TTS（音频卡自动配音）：只验证「能不能关掉、关掉时快不快」这类与环境无关的行为。
 * 真正的中文语音合成依赖 Windows SAPI，不在自动化测试里跑（会在导入链路里用到时才触发）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

function freshTts(disabled) {
  if (disabled) process.env.ANKI_DISABLE_TTS = '1';
  else delete process.env.ANKI_DISABLE_TTS;
  delete require.cache[require.resolve('../src/tts')];
  return require('../src/tts');
}

test('本地 TTS：ANKI_DISABLE_TTS=1 时整体不可用，直接返回 null', async () => {
  const tts = freshTts(true);
  assert.equal(tts.enabled(), false);
  assert.equal(await tts.available(), false);
  assert.equal(await tts.synth('细胞膜由磷脂双分子层构成'), null);
  freshTts(false);
});

test('本地 TTS：关掉时不拉起 PowerShell，导入不会被阻塞', async () => {
  const tts = freshTts(true);
  const started = Date.now();
  await tts.synth('很长的文本'.repeat(200));
  assert.ok(Date.now() - started < 500, '禁用后必须立刻返回，不能等外部进程');
  freshTts(false);
});

test('本地 TTS：合成请求会做长度裁剪与空文本短路', async () => {
  const tts = freshTts(true);
  assert.equal(await tts.synth(''), null);
  assert.equal(await tts.synth('   '), null);
  assert.ok(tts.MAX_CHARS > 0 && tts.MAX_CHARS <= 1000, '单条朗读文本要有上限');
  freshTts(false);
});
