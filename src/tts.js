'use strict';
/*
 * 免费本地 TTS：把卡片文本合成成 WAV。
 *
 * Windows 用系统自带的 SAPI（System.Speech）—— 离线、不花钱、中文语音通常是
 * Microsoft Huihui Desktop；文本通过临时文件传给 PowerShell，不拼命令行，避免注入。
 * 输出 16kHz / 16bit / 单声道，1 秒约 32KB，放进 Anki 完全够用；
 * 同一个文本 + 音色合成过一次就缓存起来，重复导入不再重复合成。
 *
 * Linux / macOS 上如果没有 espeak/say 就返回 null，上层会退回到「这张卡缺音频」的提示。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const PS_SCRIPT = [
  'param([string]$TextFile, [string]$OutFile, [string]$Voice)',
  'Add-Type -AssemblyName System.Speech',
  '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($Voice) { try { $synth.SelectVoice($Voice) } catch { } }',
  '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
  '$synth.SetOutputToWaveFile($OutFile, $fmt)',
  '$synth.Speak([IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8))',
  '$synth.Dispose()'
].join('\n');

const MAX_CHARS = 400;

let voiceCache = null;

function cacheDir() {
  return process.env.ANKI_TTS_DIR || path.join(__dirname, '..', 'data', 'tts');
}

function run(file, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message || '').trim() || 'TTS 调用失败'));
      else resolve(String(stdout || ''));
    });
  });
}

/** 测试/部署可以用 ANKI_DISABLE_TTS=1 关掉（避免拉起 PowerShell） */
function enabled() { return process.env.ANKI_DISABLE_TTS !== '1'; }

/* 测试用：ANKI_TTS_FAKE=1 时假装系统语音可用，合成结果固定（不碰 SAPI，也不写文件）。
   这样「音频卡自动配音」两条分支（可用 / 不可用）都能在无语音的机器上跑测试。 */
const FAKE_WAV_DATA_URL = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
function faked() { return process.env.ANKI_TTS_FAKE === '1'; }

/** 列出系统里的语音：[{ name, culture }] */
async function listVoices() {
  if (voiceCache) return voiceCache;
  if (!enabled()) { voiceCache = []; return voiceCache; }
  if (process.platform === 'win32') {
    const script = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + \'|\' + $_.VoiceInfo.Culture.Name }';
    try {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 15000);
      voiceCache = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const [name, culture] = line.split('|');
        return { name: name || '', culture: culture || '' };
      }).filter(voice => voice.name);
    } catch (_) { voiceCache = []; }
  } else {
    voiceCache = [];
  }
  return voiceCache;
}

/** 首选音色：中文优先，其次系统默认 */
async function pickVoice(text) {
  const voices = await listVoices();
  if (!voices.length) return '';
  const chinese = voices.find(voice => /^zh/i.test(voice.culture)) || voices.find(voice => /huihui|yaoyao|kangkang|chinese|中文/i.test(voice.name));
  if (chinese) return chinese.name;
  void text;
  return '';
}

/** 这套环境能不能合成语音 */
async function available() {
  if (!enabled()) return false;
  if (faked()) return true;
  if (process.platform === 'win32') return (await listVoices()).length > 0;
  return false;
}

/**
 * 合成一段语音。
 * @returns {Promise<{ dataUrl:string, cached:boolean, voice:string, bytes:number }|null>}
 */
async function synth(text, options = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!clean) return null;
  if (faked()) return { dataUrl: FAKE_WAV_DATA_URL, cached: false, voice: 'fake', bytes: 44 };
  const can = await available();
  if (!can) return null;

  const voice = options.voice || await pickVoice(clean);
  const dir = cacheDir();
  const key = crypto.createHash('sha256').update(`${voice}\u001f${clean}`).digest('hex').slice(0, 24);
  const target = path.join(dir, `${key}.wav`);
  try {
    if (fs.existsSync(target)) {
      const data = fs.readFileSync(target);
      return { dataUrl: `data:audio/wav;base64,${data.toString('base64')}`, cached: true, voice, bytes: data.length };
    }
  } catch (_) { /* 缓存读不了就重新合成 */ }

  fs.mkdirSync(dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cardflow-tts-'));
  const textFile = path.join(work, 'text.txt');
  const outFile = path.join(work, 'out.wav');
  const scriptFile = path.join(work, 'synth.ps1');
  try {
    fs.writeFileSync(textFile, clean, 'utf8');
    fs.writeFileSync(scriptFile, PS_SCRIPT, 'utf8');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, '-TextFile', textFile, '-OutFile', outFile, '-Voice', voice], 30000);
    if (!fs.existsSync(outFile)) return null;
    const data = fs.readFileSync(outFile);
    if (!data.length) return null;
    try { fs.writeFileSync(target, data); } catch (_) { /* 缓存写不进去也不影响这次导入 */ }
    return { dataUrl: `data:audio/wav;base64,${data.toString('base64')}`, cached: false, voice, bytes: data.length };
  } catch (_) {
    return null;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* 临时目录清不掉无妨 */ }
  }
}

module.exports = { available, synth, listVoices, pickVoice, enabled, MAX_CHARS };
