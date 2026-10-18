'use strict';
/*
 * 音频卡自动配音：TTS 可用时，没带 audio 的音频卡应当被接受，并在导入时补上 [sound:...]；
 * TTS 不可用时必须仍然拒收（给出「需提供音频」的提示）。
 *
 * 用 ANKI_TTS_FAKE=1 假装系统语音可用（不碰真实 SAPI，也不写音频文件），
 * 这样两条分支在没有中文语音的机器上也能跑测试。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer } = require('./helpers/harness');
const { startFakeAnki } = require('./helpers/fakes');

const CARD = { type: 'audio', front: '细胞膜的作用是什么', back: '选择透过性', speak: '细胞膜的作用', tags: ['通用制卡'] };

test('TTS 可用：没带音频的音频卡被接受，导入时自动配音', async () => {
  const anki = await startFakeAnki(['Default', '生物']);
  const server = await startServer({ subject: 'demo', ankiUrl: anki.url, env: { ANKI_TTS_FAKE: '1', ANKI_DISABLE_TTS: '' } });
  try {
    const response = await server.api('/api/import', { method: 'POST', body: { deck: '生物', cards: [CARD] } });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.added, 1);
    assert.equal((anki.state.media || []).length, 1, '合成的音频要存进 Anki 的媒体库');
    const notes = anki.state.calls.filter(call => call.action === 'addNotes').flatMap(call => call.params.notes || []);
    assert.equal(notes.length, 1);
    assert.match(notes[0].fields.Front, /\[sound:cardflow-[0-9a-f]+\.wav\]/, '字段里要带上音频引用');
  } finally {
    await server.stop();
    await anki.close();
  }
});

test('TTS 关掉：没带音频的音频卡仍然按老规矩拒收', async () => {
  const anki = await startFakeAnki(['Default', '生物']);
  const server = await startServer({ subject: 'demo', ankiUrl: anki.url });
  try {
    const response = await server.api('/api/import', { method: 'POST', body: { deck: '生物', cards: [CARD] } });
    assert.equal(response.status, 400);
    assert.match(response.json.error, /音频卡需提供 MP3\/WAV\/OGG/);
  } finally {
    await server.stop();
    await anki.close();
  }
});

test('TTS 可用：导出 .apkg 时同样接受并补音频', async () => {
  const anki = await startFakeAnki(['Default', '生物']);
  const server = await startServer({ subject: 'demo', ankiUrl: anki.url, env: { ANKI_TTS_FAKE: '1', ANKI_DISABLE_TTS: '' } });
  try {
    const response = await server.api('/api/apkg', { method: 'POST', body: { deck: '生物', cards: [CARD] } });
    assert.equal(response.status, 200, response.text);
    assert.ok(response.text.length > 200, '.apkg 应该真的有内容');
  } finally {
    await server.stop();
    await anki.close();
  }
});
