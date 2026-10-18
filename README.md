# CardFlow 卡流

把教材/讲义截图拍照上传，由 AI 读图生成 Anki 卡片，再导入本机 Anki 的**本地制卡平台**。

一份代码 + 每个科目一份配置（`subjects/<id>.json` + `prompts/<id>.md`）。仓库自带一个中性的
**「通用制卡」示例学科**，复制它就能加上自己的科目——不需要改代码。

服务端**零依赖**，只用 Node 内置模块；所有密钥只存在本机，AnkiConnect 只连 `127.0.0.1:8765`。

---

## 功能

- 拍照 / 相册 / PDF / DOCX / Markdown → AI 读图生成卡片（普通卡、填空卡、图像遮挡卡、音频卡）
- 预览、逐张勾选、手改 JSON、单卡重试（新旧对照，采纳才覆盖）
- 一键导入本机 Anki（AnkiConnect），或导出 `.apkg`（含图片与音频）
- 自动分层导入（按章节建子牌组）、遮挡框手动微调、深色模式
- 可选的联网调研（检索服务商 / 自建 SearXNG）与「抓全文」（Jina Reader，可配中转）
- 手机版：安卓 WebView 壳离线运行，直接写 AnkiDroid 或生成 `.apkg`；备份 / 诊断包走系统「另存为」

---

## 目录结构

```
anki-card-maker/
├── src/
│   ├── server.js                唯一一份服务端（HTTP + HTTPS）
│   ├── prompts.js               提示词模板加载与占位符替换
│   └── postprocess/chem.js      可选示例：公式规范化后处理
├── public/
│   ├── index.html               唯一一份前端页面（单学科模板）
│   ├── app.js                   唯一一份前端脚本
│   ├── manifest.json            PWA 清单（按学科渲染）
│   ├── sw.js                    Service Worker（按挂载点自适应）
│   └── vendor/                  第三方静态 js（二维码库，不进 package.json）
├── prompts/
│   └── demo.md                  示例学科的提示词（generate / identify / locate / reference 四段）
├── subjects/
│   └── demo.json                示例学科的全部差异（文案、配色、默认值、检索词前缀……）
├── config/
│   ├── demo.config.json         口令与密钥（**不进版本控制**）
│   └── demo.config.example.json 占位符版本，进版本控制
├── scripts/                     启动、看门狗、证书、备份、打包脚本
├── android/                     安卓 WebView 壳（离线页 + 原生桥）
├── tests/                       零依赖测试（node:test）
├── Dockerfile / docker-compose.yml
└── README.md
```

---

## 快速开始

前置：装好 Node.js（`node -v` 能看到版本），装好 Anki 并打开（AnkiConnect 插件监听 `127.0.0.1:8765`）。

```powershell
cd <项目目录>
copy config\demo.config.example.json config\demo.config.json   # 填 token / apiKey / model
node src/server.js
```

启动后打开：

| 地址 | 说明 |
|---|---|
| `http://127.0.0.1:3210/` | 学科选择页 |
| `http://127.0.0.1:3210/demo/` | 示例学科制卡页 |

只跑一个学科（API 挂在根路径）：

```powershell
node src/server.js --subject=demo     # http://127.0.0.1:3210/
```

命令行参数：

| 参数 | 说明 |
|---|---|
| `--subject=<id>` | 单学科模式（`subjects/` 下的 id） |
| 环境变量 `ANKI_PORT` / `ANKI_HTTPS_PORT` | 覆盖监听端口（测试用） |
| 环境变量 `ANKI_HOST` | 覆盖监听地址，默认有口令时 `0.0.0.0`，没口令时只监听 `127.0.0.1` |
| 环境变量 `ANKI_URL` | AnkiConnect 地址，默认 `http://127.0.0.1:8765` |
| 环境变量 `ANKI_JINA_BASE` / `ANKI_ZHIHU_BASE` | 抓全文 / 知乎 MCP 的基地址 |
| 环境变量 `ANKI_CONFIG` / `ANKI_CONFIG_<ID>` | 指定配置文件位置（测试用） |

---

## 加一个新学科（零代码）

1. 复制 `subjects/demo.json` 成 `subjects/<新id>.json`，改 `id` / `name` / `shortName` / `httpPort` /
   `httpsPort` / `themeColor` / `copy`（全部界面文案）/ `cardCount` / `cardMode` / `search`。
2. 复制 `prompts/demo.md` 成 `prompts/<新id>.md`，改四段提示词
   （`generate` / `identify` / `locate` / `reference`）。
3. 复制 `config/demo.config.example.json` 成 `config/<新id>.config.json`，填口令与密钥。
4. 在 `public/index.html` 的样式里，把 `[data-subject="demo"]` 复制一份改成 `[data-subject="<新id>"]`
   （配色与背景文案可以按需改；不改也能用，只是沿用示例主题）。
5. 重启服务。页面、接口、PWA 清单、学科切换器都会自动带上它。

如果新学科还需要特殊处理（例如公式规范化），在 `subjects/<新id>.json` 里把 `postprocess`
指向 `src/postprocess/` 下的模块名，并在 `src/server.js` 的加载表里登记。

---

## 改提示词

提示词是纯文本，在 `prompts/<学科>.md` 里，分四段，每段以独占一行的 `=== 段名 ===` 开头：

| 段名 | 用途 | 可用占位符 |
|---|---|---|
| `generate` | 生成卡片的主提示词 | `{{$min}}` `{{$max}}` `{{$extra}}`，以及本学科的模式变量（示例用 `{{$weight}}`） |
| `reference` | 联网调研那一块正文 | `{{$reference}}` |
| `identify` | 读图判断知识主题 | 无 |
| `locate` | 用目录证据锁定章节位置 | `{{$topic}}` `{{$keypoints}}` `{{$evidence}}` |

规则：

- 段内容**首尾不要留空行**；段内换行原样保留。
- 只有出现 `{{$xxx}}` 的地方会被替换；没有占位符的纯文本原样进提示词。
- 有调研内容时，服务器把 `reference` 段渲染后以两个换行接到 `generate` 段末尾；没有调研内容时整段不出现。
- 改完跑一下 `npm test`：`tests/fixtures/prompt-demo.json` 是提示词快照，能立刻发现误删误改。

---

## 配置文件字段

`config/<学科>.config.json`（**含密钥，绝不提交、绝不外发**）：

| 字段 | 说明 |
|---|---|
| `token` | 访问口令，手机和电脑首次打开网页时输入；服务端校验请求头 `x-anki-token` |
| `apiUrl` / `apiKey` / `model` | AI 服务商（OpenAI 兼容接口）的地址、Key、默认模型 |
| `tavilyKey` | Tavily 搜索 Key（可选，联网检索） |
| `zhihuKey` | 知乎开放平台 Access Secret（可选） |

`subjects/<学科>.json`（进版本控制，不含密钥）里放的是**学科差异**：端口、提示词文件、
主题色、界面文案、卡片默认数量、卡片模式控件及其取值映射、检索词前缀与偏好站点、默认标签等。

---

## 手机访问

1. 手机和电脑连**同一个 WiFi**。
2. 浏览器打开 `http://192.168.1.100:3210/`（把 IP 换成这台电脑的内网地址），点进学科。
3. 首次打开会让你输入**访问口令**（`config/<学科>.config.json` 的 `token`）。
4. 想「添加到主屏幕 / 离线打开」（PWA 需要安全上下文），走 HTTPS：
   `https://192.168.1.100:3212/demo/`，并在手机上**安装一次** `ca.crt`（自签证书的根证书，可以安全外发；
   `cert.pfx` 含私钥，只留在服务端，不要外发）。

> ⚠️ 内网 IP 是路由器 DHCP 分配的，换网络或过一段时间可能变。建议在路由器里给这台电脑做
> **DHCP 保留（静态绑定 MAC）**，否则手机上的书签会失效。

### 换地址 / 加地址时怎么重签证书

证书是 `scripts\gen-cert.ps1` 用本机的自签 CA 签出来的。**CA 会被复用**，所以只换叶子证书时手机上
已经装过的 `ca.crt` 不用重装。

```powershell
# 局域网 IP 用 -Ip；还要写进 SAN 的其它地址用 -ExtraIp（可多个）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gen-cert.ps1 -OutDir . -Ip 192.168.1.100
```

**换完必须重启服务** —— `cert.pfx` 只在进程启动时读一次。

---

## 接口清单

除 `/api/health` 与 `/api/config` 外，所有 `/api/*` 都要校验口令：请求头 `x-anki-token: <token>`
或查询参数 `?token=<token>`，校验失败返回 `401 {"error":"未授权：请输入正确的访问口令。"}`。
`/api/health`、`/api/config` **不带口令**可访问（页面首次加载、体检用），但如果**带了错误口令**仍返回 401。

多学科模式下所有接口都挂在学科前缀下（`/demo/api/...`），口令取各自学科的配置。

| 接口 | 入参（JSON） | 返回要点 |
|---|---|---|
| `GET /api/health` | — | `{ok, version}`，`version` 来自 AnkiConnect |
| `GET /api/config` | — | `{apiUrl, model, hasKey, hasSearch, hasZhihu}`（**绝不返回密钥**） |
| `GET /api/decks` | — | `{decks: ["默认", "课程::第一章", ...]}` |
| `POST /api/models` | `{url?, key?}` | `{models: [...]}`，按字母排序 |
| `POST /api/generate` | `{url?, key?, model?, images: ["data:image/..."], minCards, maxCards, extraRules, reference}` | AI 返回的卡片 JSON `{cards:[...], image_occlusion_suggestions:[...]}` |
| `POST /api/research` | 同 `generate`（`images` 必填） | `{identify, position, topic, catalogQuery, catalog, examQueries, exams}` |
| `POST /api/search` | `{query, channel: "zhihu"\|"global"\|"tavily", maxResults}` | `{query, answer, results, dropped, provider}` |
| `POST /api/fetch` | `{url, limit?, jinaBase?}` | `{url, length, content, suspicious}`；`suspicious=true` 表示抓回的像页面框架 |
| `POST /api/deck/create` | `{deck}` | `{deck, id}` |
| `POST /api/deck/delete` | `{deck, dryRun?}` | `dryRun` 时只预览；否则真删 |
| `POST /api/import` | `{deck, cards:[...]}` | `{added, skipped}` |
| `POST /api/apkg` | 同 `import` | `.apkg` 文件流（含图片与音频） |
| `POST /api/normalize` | `{cards:[...]}` | 仅配了 `postprocess` 的学科有；其它学科 404 |

---

## 导出 `.apkg`

「检查、修改与导入」面板里的**「下载 .apkg」**会把勾选的卡片打包成 Anki 安装包（含遮挡卡图片、
音频卡音频）：在手机上的 AnkiDroid / AnkiMobile 里打开就能导入；电脑上直接拖进 Anki 也行。
点按钮时会先弹出确认层，勾选要包含的卡片类型。

---

## 扫码连接（手机免输口令）

配置区里的**「扫码连接」**显示一个二维码，内容就是本机内网地址 + 学科路径 + 访问口令，
手机扫一下直接进页面。

- 地址由服务端每次请求现探测（`/api/network`），过滤回环、`169.254.x`、VPN fake-IP 段与虚拟网卡；
  换了网络按一下**「刷新地址」**即可。
- 二维码库：`qrcode-generator 1.4.4`（MIT），静态文件放在 `public/vendor/`，没有写进 `package.json`。

> ⚠️ **链接里带访问口令**。只在自己的设备上扫，不要截图发出去或贴到公开地方。

---

## 安卓离线壳

`android/` 是一个 WebView 壳：`scripts/build-shell.js` 把 `public/`、`src/shared/`、`prompts/`、
`subjects/` 渲染成离线页塞进 APK，页面不连任何服务器。

```powershell
node scripts\build-shell.js       # 生成 android/app/src/main/assets
cd android && gradle assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

手机版能力：直连 AI（原生桥绕开 CORS）、直写 AnkiDroid、系统 TTS 合成音频卡、系统「另存为」
（备份 / 诊断包）、长按学科行编辑 / 隐藏学科包。

---

## Docker

```bash
cp config/demo.config.example.json config/demo.config.json   # 填 token / apiKey
docker compose up -d --build
# 浏览器打开 http://127.0.0.1:3210/
```

- 镜像基于 `node:22-slim`，**零 npm 依赖**。
- `config/`、`prompts/`、`subjects/` 都是卷挂载：改提示词、加学科、换口令都不用重新 build。
- **容器里连不到宿主机的 AnkiConnect**（它只监听 `127.0.0.1:8765`，这是刻意的安全设计）。
  Docker 版的「导入 Anki」用不了，请用「下载 .apkg」把包导出来再导入。

---

## 测试

```powershell
npm test          # node:test，零依赖
```

覆盖：提示词渲染、AI 响应解析与宽容修补、卡片校验与媒体、`.apkg` 生成、离线 API 适配、
鉴权与牌组增删、抓全文清洗、检索服务商、前端交互（预览 / 导入 / 遮挡框 / 深色）、
CSS 最终生效值快照、页面渲染契约、离线壳构建产物。

默认**不会**碰真实 Anki；需要时用 `$env:ANKI_LIVE='1'; npm test` 跑一次真实自检
（只自建空牌组再删掉，并断言用户原有牌组一字不变）。

---

## 安全性（刻意设计，别改）

1. **AnkiConnect 只监听 `127.0.0.1:8765`**。它没有任何认证，一旦暴露到 `0.0.0.0`，
   局域网里任何人都能删你的卡。
2. `config/*.config.json` 已在 `.gitignore` 里；`/api/config` 只返回 `apiUrl` / `model`
   与几个布尔开关，**从不返回任何密钥**。
3. `/api/config` 与 `/api/health` 免口令（页面首次加载、体检用）；其余 `/api/*` 都要口令。
4. 多学科模式下每个学科的口令相互独立；拿 A 学科的口令访问 B 学科的 `/api/*` 会 401。
