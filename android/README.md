# CardFlow 安卓离线版（APK）

手机装一个 APK，自己填 AI Key，拍照/选 PDF → 生成卡片 → **一键导入 AnkiDroid**。
**全程不需要电脑、不需要 AnkiConnect**：页面资源全在包里，只有 AI 请求与联网调研走网络。

## 它是怎么跑起来的

```
APK
├─ assets/            离线网页（由 scripts/build-shell.js 从 public/、src/shared/、prompts/、subjects/ 生成）
│   ├─ index.html           学科选择页（壳的入口）
│   ├─ index-demo.html   卡片页（服务端同一份模板渲染出来的静态页）
│   ├─ shared/*.js          纯逻辑：模板渲染 / 宽容解析 / 卡片校验与导出 / 提示词 / 请求组装 / 遮挡卡排版
│   ├─ prompt-data.js       内联的提示词与学科配置（离线没有服务器，这些必须带在包里）
│   ├─ postprocess.js       公式标准化示例（src/postprocess/formula.js 原文嵌入）
│   ├─ local-api.js         离线 API 适配器：把网页里的 /api/... 接成本地实现
│   └─ app.js / cardflow.css / vendor/…  与服务端同一份前端文件
├─ MainActivity.java        用 WebViewAssetLoader 把 assets 挂到 https://appassets.androidplatform.net/；申请 AnkiDroid 权限
├─ NativeBridge.java        网页 ↔ 原生：httpRequest（绕过 CORS 直连 AI / Tavily / Jina）、buildApkg、tts、
│                           decks、uploadMedia、addNotes、requestAnkiPermission
├─ AnkiDroidApi.java        直写 AnkiDroid（一键导入）：查牌组/笔记类型、上传媒体、写笔记、缺牌组就建
├─ ApkgWriter.java          用系统自带的 SQLite 生成 .apkg（与 src/apkg.js 同一套结构）
└─ AnkiDroidBridge.java     把生成好的 .apkg 交给 AnkiDroid 打开（直接导入走不通时的退路）
```

网页里的 `app.js` / `workflow.js` **一行都没有为离线版改动**：

- `public/local-api.js` 替换 `window.fetch`，凡是打到 `/api/...` 的请求都由它本地处理，其余照旧；
- AI 请求走原生桥（浏览器直连会被 CORS 拦住），`.apkg` 由原生 SQLite 生成，
  音频卡需要配音时调系统语音合成；
- 离线版没有访问口令（本机不需要鉴权），进入页面即可用。

## 构建

前置：JDK 17 + Android SDK 34 + Gradle 8.7（建议装在项目外的工具目录，例如 `C:\tools\cardflow-build\`）。

```bat
:: 1) 先生成离线资源（改了 public/、src/shared/、prompts/、subjects/ 之后必须重跑）
node scripts\build-shell.js

:: 2) 再打包 APK
cmd /c C:\tools\cardflow-build\build.bat
:: 产物：android\app\build\outputs\apk\debug\app-debug.apk
```

`scripts/build-shell.js` **默认把本机已装的所有学科包一起打进 APK**（自己的 APK 自己用：
生物、化学，以及你在电脑上导入过的学科包，比如文言文包）；要把 APK 发给别人时用 `--builtin-only`，
只打自带的生物/化学，避开自己的私人学科包。
离线资源（`android/app/src/main/assets/`）是可再生的构建产物，不进 Git。

### 手机上直接装新学科包

学科选择页底部有「装一个新的学科包（.json）」：把电脑上导出的学科包 .json 选进来就装好了，
装好的包列在页面下方（可删除）。原理：卡片页不是从零渲染的，而是「基础学科页」（打包时渲染好的生物页）
+ 学科包的差异（标题 / 学科名 / 副标题 / 学科下拉 / 卡片数量上下限 / 检索词占位符 / 内联学科配置 / app.js 版本号）
拼出来的，拼装逻辑在 `src/shared/pack-schema.js` 的 `packPageFromBase`，与打包时渲染学科包页面用的是同一套规则；
有一条测试会**逐字比对**「运行时拼出来的页面」与「打包时生成的静态页」，不一致就报错。
校验规则（字段白名单、id 格式、prompts 段落…）也与电脑端是同一份 `validate`。

## 手机上怎么用

1. 装 APK → 打开 → 选学科（生物 / 化学 / 你导入过的学科包）
2. 第一次打开会弹「第一次用：按这个顺序来」的新手引导，里面有「开始自检」（检查 AI 接口、
   AnkiDroid 直写、系统语音、Tavily Key 四项）；以后从「接口设置」里的「新手教程与自检」再进
3. 「接口设置」里填 AI 的 API 地址、Key、模型（只保存在这台手机上）
4. 拍照或选 PDF → 生成 → 检查 → 点「导入 Anki」（一键直写；不行才回退到 .apkg）
5. 联网调研（可选）：在「联网调研」里填 Tavily Key（tavily.com 免费申请），再点「自动调研」

学科选择页上有「新手使用说明（含常见问题）」；卡片页的「接口设置」里还有一个「使用说明（可转发）」，
里面可以一键复制说明文字，直接粘到微信/QQ 发给别人。

## 导入两种方式（默认走第一种）

1. **一键导入（直写 AnkiDroid）**：点「导入 Anki」→ 卡片直接进 AnkiDroid，不弹确认、不切应用。
   用的是 AnkiDroid 的内容提供者接口（`content://com.ichi2.anki.flashcards`）：
   - 牌组：读 AnkiDroid 里真实的牌组；不够的子牌组会自动建
   - 笔记类型：只能用你 AnkiDroid 里**已有**的类型（接口只能查、不能新建），
     优先用之前 .apkg 导入过的「CardFlow Basic / CardFlow Cloze」，否则退到 Basic / Cloze
   - 图片与音频：先 `insert` 进它的媒体库（collection.media），再把实际文件名写进字段
   - 每张卡都要插一遍（与电脑版导入 Anki 的体验一样）

2. **下载 .apkg**：打包成安装包交给 AnkiDroid 打开，用户点一次「导入」确认。
   它不依赖 AnkiDroid 的任何开关与权限，所以是**兜底方案**，也是唯一能保证
   卡片长得像「CardFlow 自制模板」的方式。

一键导入需要三项（任一项不满足会自动回退到 .apkg，并在状态里写清原因）：

- 手机装了 AnkiDroid
- 首次启动时允许 CardFlow 的「读写 AnkiDroid 数据库」权限（`com.ichi2.anki.permission.READ_WRITE_DATABASE`）
- AnkiDroid 里允许 API 访问（它的高级设置）

## 手机上有的功能（与服务端一致的）

| 功能 | 手机版怎么用 |
| --- | --- |
| 生成卡片 | 走原生桥直连 AI（绕开浏览器 CORS），提示词与解析与服务端同一份代码 |
| 一键导入 | 直写 AnkiDroid；失败自动回退 .apkg |
| 下载 .apkg | 原生用系统 SQLite 生成，与 `src/apkg.js` 同一套结构 |
| 图片遮挡卡 / 音频卡 | 直写时先上传媒体；音频卡用系统 TTS 配音 |
| 单卡重试 | 提示词、方向、温度与服务端一致 |
| 联网调研 / 联网检索 | 走 Tavily（自动调研四步：读图定主题 → 搜目录 → 定章节 → 搜考情） |
| 抓网页原文 | 走 Jina Reader，清洗与限额与服务端同一份 |
| 历史记录 / 问题池 | 存在手机本机存储里（跨批次去重照旧） |
| 备份 / 恢复 / 诊断包 | 备份包与服务端同一套 zip 结构（电脑上也能还原）；诊断包不含任何密钥 |
| 学科包 | 学科选择页里直接导入 / 删除（校验与拼装规则与电脑端同一份）|

## 已知限制

- **知乎官方通道**：手机版走不了（它需要 SSE 长连接），两个检索通道都走 Tavily（站内那条限定 zhihu.com）。
- **同步**：手机上没有 AnkiConnect，也不需要 —— 卡片直接进 AnkiDroid，同步由 AnkiDroid 自己做。
- **新增学科包**：可以在手机上直接导入（见上文）；装在手机上的包只在本机，重装 App 会丢，
  要先在卡片页「导出备份」留底。
- **一键导入的笔记类型**：用你 AnkiDroid 里已有的类型，所以卡片样式跟你的卡一致；
  想要 CardFlow 自己的模板（LaTeX/夜间样式都是调好的），就用「下载 .apkg」。
- **公式预览**：MathJax 已打进包里（`public/vendor/mathjax/tex-svg.js` + mhchem 扩展，约 2.2MB），
  断网也能渲染；服务端（电脑版）仍然走 CDN，两边渲染方式不同（包里用 SVG 输出，不需要字体文件）。- 安卓侧代码没有在这台机器上跑过真机验证：先用 `adb install -r`（或直接拷 APK）装上试一次。
