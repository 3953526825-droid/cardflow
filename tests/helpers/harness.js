'use strict';
/*
 * 测试夹具：用环境变量把 server.js 指向本地假服务，在随机端口上起一个真进程。
 * 绝不占用 3210/3211/3212/3213，也绝不碰用户正在运行的服务与真实 Anki。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TMP_ROOT = path.join(PROJECT_ROOT, 'tests', '.tmp');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function api(base, pathname, options = {}) {
  const { method = 'GET', body, token, headers = {} } = options;
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  if (token) finalHeaders['x-anki-token'] = token;
  const response = await fetch(base + pathname, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: response.status, json, text, headers: response.headers };
}

/**
 * 启动一个被测服务进程。
 * @param {{ subject?:string, multi?:boolean, ankiUrl?:string, jinaBase?:string, zhihuBase?:string,
 *           config?:object, token?:string, env?:object }} options
 *   subject —— 单学科模式：node src/server.js --subject=<id>，API 挂在根路径
 *   multi   —— 多学科模式：node src/server.js，API 挂在 /<学科>/ 下
 */
async function startServer(options = {}) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'srv-'));
  const subject = options.multi ? '' : (options.subject || 'demo');
  const mount = options.multi ? `/${subject || 'demo'}` : '';
  const token = options.token || `test-token-${Math.random().toString(16).slice(2, 10)}`;
  const config = {
    token,
    apiUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'test-api-key',
    model: 'test-model',
    tavilyKey: '',
    zhihuKey: '',
    ...(options.config || {})
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  // 多学科模式可以给每个学科单独一份配置（用于验证口令相互独立）
  const perSubjectEnv = {};
  for (const [id, value] of Object.entries(options.configs || {})) {
    const file = path.join(dir, `config-${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...config, ...value }, null, 2));
    perSubjectEnv[`ANKI_CONFIG_${id.toUpperCase()}`] = file;
  }

  const port = await freePort();
  const logPath = path.join(dir, 'server.log');
  const logFd = fs.openSync(logPath, 'a');
  const env = {
    ...process.env,
    ANKI_PORT: String(port),
    ANKI_HTTPS_PORT: '0',
    ANKI_HOST: '127.0.0.1',
    ANKI_CONFIG: configPath,
    ANKI_URL: options.ankiUrl || 'http://127.0.0.1:1',
    ANKI_JINA_BASE: options.jinaBase || 'http://127.0.0.1:1/',
    ANKI_ZHIHU_BASE: options.zhihuBase || 'http://127.0.0.1:1',
    // 调用历史写到临时目录：测试绝不能污染用户真正的 history/history.jsonl
    ANKI_HISTORY_FILE: options.historyFile || path.join(dir, 'history.jsonl'),
    // 测试里不要拉 PowerShell 去探测/合成语音，也不要碰真实 Anki 的媒体目录
    ANKI_DISABLE_TTS: '1',
    ANKI_TTS_DIR: path.join(dir, 'tts'),
    ANKI_PACKS_DIR: path.join(dir, 'packs'),
    ANKI_PACKS_BACKUP_DIR: path.join(dir, 'pack-backups'),
    ...perSubjectEnv,
    ...(options.env || {})
  };
  // 多学科模式会尝试在其它学科的旧端口上开跳转监听，测试里必须关掉，避免撞上真服务。
  if (options.multi) env.ANKI_LEGACY_PORTS = '0';
  const args = [options.entry ? path.resolve(options.entry) : path.join(PROJECT_ROOT, 'src', 'server.js')];
  if (subject) args.push(`--subject=${subject}`);
  if (options.args) args.push(...options.args);
  // 用文件描述符而不是管道：避免沙箱对命名管道的限制，同时保留子进程日志便于排错。
  const proc = spawn(process.execPath, args, { env, stdio: ['ignore', logFd, logFd], windowsHide: true });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      // 不带 token 探测：/api/config 免口令，多学科模式下各学科口令不同也能探测到
      const probe = await api(base, `${mount}/api/config`);
      if (probe.status === 200) { ready = true; break; }
    } catch (_) { /* 还没起来 */ }
    await sleep(80);
  }
  const logs = () => { try { return fs.readFileSync(logPath, 'utf8'); } catch (_) { return ''; } };
  if (!ready) {
    try { proc.kill(); } catch (_) {}
    throw new Error(`被测服务没有在 ${port} 端口就绪。\n--- server log ---\n${logs()}`);
  }

  return {
    port,
    base,
    mount,
    subject,
    multi: Boolean(options.multi),
    token,
    config,
    configPath,
    dir,
    proc,
    logs,
    api: (pathname, opts) => api(base, `${mount}${pathname}`, { token, ...opts }),
    raw: (pathname, opts) => api(base, `${mount}${pathname}`, opts),
    stop: async () => {
      try { proc.kill(); } catch (_) {}
      const stopDeadline = Date.now() + 5000;
      while (proc.exitCode === null && Date.now() < stopDeadline) await sleep(30);
      try { fs.closeSync(logFd); } catch (_) {}
      await sleep(50);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

module.exports = { PROJECT_ROOT, TMP_ROOT, freePort, sleep, api, startServer };
