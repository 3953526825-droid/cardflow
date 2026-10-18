# 把 CardFlow 搬到「不用开电脑」的地方

目标：手机上拍照 → 出卡 → 进 Anki，全程不需要电脑。服务本身很小（零依赖 Node 进程 + 一个 SQLite 文件级别的数据量），随便一台常开的设备都能跑。

---

## 0. 先搞清楚你需要哪条链路

| 你的情况 | 需要的组件 | 要不要电脑 |
| --- | --- | --- |
| 电脑上的 Anki 常开，手机上只想生成卡片 | 服务 + AnkiConnect（Anki 里装插件） | 要（Anki 开着就行，不用人操作） |
| 不想开电脑、安卓手机装了 AnkiDroid | 服务 + 「下载 .apkg」按钮 | 不要 |
| iPhone（AnkiMobile） | 服务 + 「下载 .apkg」→ 分享面板导入 | 不要 |

也就是说：**服务搬到常开设备之后，是否需要电脑只取决于你选哪种导入方式**。`下载 .apkg` 这条路完全不需要 AnkiConnect。

---

## 1. 环境要求

- **Node.js 22.5 或更高**（`node:sqlite` 用来生成 .apkg，低版本会报错）
  - 检查：`node -v`
  - Windows/macOS：官网装；树莓派/NAS：用 NodeSource 源或 nvm；安卓 Termux：`pkg install nodejs-lts`（版本可能偏低，见 §4）
- 不需要 `npm install`：这个项目没有任何运行时依赖
- 磁盘：几十 MB 够；卡片图片不落在服务端（只有 TTS 语音缓存在 `data/tts/`）

---

## 2. 搬迁步骤（任何一台常开设备都一样）

1. 只拷这几样过去：
   - `src/`、`public/`、`prompts/`、`subjects/`、`scripts/`
   - `package.json`、`ca.crt`、`cert.pfx`（手机免重装证书要同一套）
   - 你自己的 `config/*.config.json`（里面是 API Key 与访问口令，别进 Git）
   - 想保留历史：`history/`、`packs/`、`data/`
2. 在目标机器上跑一次：
   ```
   node src/server.js
   ```
   看到 `CardFlow on http://127.0.0.1:3210` 就对了。
3. 让它开机自启 / 挂了自动重启：
   - **Windows**：项目自带的 `scripts/watchdog.ps1` + 计划任务（登录时触发，隐藏窗口）
   - **Linux（树莓派 / NAS / 云主机）**：写成 systemd 服务
     ```
     [Unit]
     Description=CardFlow
     After=network.target

     [Service]
     WorkingDirectory=/opt/anki-card-maker
     ExecStart=/usr/bin/node src/server.js
     Restart=always
     RestartSec=5
     Environment=ANKI_URL=http://127.0.0.1:8765

     [Install]
     WantedBy=multi-user.target
     ```
   - **Docker**：仓库里带了 `Dockerfile` 与 `docker-compose.yml`，`docker compose up -d` 即可
4. 手机访问：
   - 同一个 Wi-Fi：用启动日志里打印的局域网地址（`http://192.168.x.x:3210/demo/`）
   - 不在同一个网络：装 Tailscale（电脑和手机各登一次），走 Tailscale 的地址；启动日志会把它单独标成「远程」
   - 手机端要装 `ca.crt` 才能用 HTTPS 装 PWA；只走 HTTP 也能用，只是不能「添加到主屏幕」

---

## 3. 三个开关值得在目标机器上确认

| 环境变量 | 作用 | 建议 |
| --- | --- | --- |
| `ANKI_URL` | AnkiConnect 地址 | 不用 AnkiConnect 就不设 |
| `ANKI_DISABLE_TTS` | 关掉本地语音合成 | Linux 上没有中文语音时设 `1`，避免每次导入白等 |
| `ANKI_DATA_DIR` | 问题池与 TTS 缓存目录 | 想放到别的盘就设 |

`config/*.config.json` 里的 `mobile.token`（手机访问口令）与 `apiKey` 会跟着文件走，不用重新配。

---

## 4. 各平台的坑

- **树莓派 / Linux**：TTS 用的是 Windows 的 SAPI，Linux 上会自动降级为「音频卡缺音频」的提示（不会报错）。想要语音卡就在 Windows 上跑，或者自己接一个 TTS 命令后把 `src/tts.js` 的 `available()` 打开。
- **Termux（旧安卓手机当服务器）**：`nodejs-lts` 有时低于 22.5，那 `下载 .apkg` 会不可用（其它功能照常）。用 `node -e "require('node:sqlite')"` 试一下就知道。
- **NAS（群晖/威联通）**：容器方式最省事，注意把 `packs/`、`history/`、`data/`、`config/` 挂到持久化卷上。
- **云主机**：一定改掉默认访问口令（`config/*.config.json` 的 `token`），并把 3210/3212 只放开给 Tailscale 或加一层反向代理；TLS 证书建议用 Let's Encrypt 而不是仓库里那张自签的。

---

## 5. 搬家之后手机端怎么用

1. 手机浏览器打开服务地址，输入一次访问口令（会记住）
2. 「添加到主屏幕」当 App 用（需要 HTTPS + 已信任的证书）
3. 拍照 / 选 PDF → 生成 → 检查 → 两种收尾任选：
   - 「导入 Anki」：电脑上的 Anki 收卡（要 AnkiConnect）
   - 「下载 .apkg」：手机上用 AnkiDroid / AnkiMobile 打开这个文件 → 一键导入

---

## 6. 出问题先看这两个地方

- 服务日志：Windows 是项目根目录的 `anki-card-maker.log`（watchdog 写的）；Linux 用 `journalctl -u cardflow -n 200`
- 卡片页的「数据维护 → 下载诊断包」：里面是环境、脱敏配置、AnkiConnect 状态、最近 20 条记录和日志尾部，排错时直接发这个就行
