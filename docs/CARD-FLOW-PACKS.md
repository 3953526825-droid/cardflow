# CardFlow 学科包（schemaVersion 1）

CardFlow 用于备考制卡：学科包按**考试 + 科目**组织，提示词须覆盖考频／权重、易错点、考试题型和考场作答。主页「复制 AI 生成提示词」提供生成指令；将 AI 的纯 JSON 粘贴或选文件，先由服务端校验预览，再确认导入。导入后存于 `packs/<id>.json`，重启仍可用；可在主页编辑、导出或删除导入包。编辑会先校验、保留原 ID，并在覆盖前备份到 `backups/packs/`；不能修改内置生物、化学的定义。**删除只删除该 JSON，不删除 Anki 卡片、配置或历史。**

示例结构（`prompts` 四段需要真实备考提示词，最短 20 字；不应照抄示例内容作为成品）：

```json
{
  "schemaVersion": 1,
  "id": "kaoyan-shengli",
  "exam": "考研",
  "subject": "生理",
  "name": "考研·生理",
  "description": "西医综合生理考点制卡",
  "cardCount": { "min": 18, "max": 30 },
  "search": {
    "subjectPrefix": "考研西医综合生理",
    "catalogSuffix": "教材章节",
    "preferredDomains": ["edu.cn"]
  },
  "prompts": {
    "generate": "针对备考高频考点、易错题型制卡，数量 {{$min}} 至 {{$max}}，额外要求 {{$extra}}，模式 {{$weight}}。",
    "reference": "仅依据有证据的考试调研：{{$reference}}；标识调研补充，不能凭空编造。",
    "identify": "根据教材图片识别章节和考试考点，不猜测未出现在图片中的内容。",
    "locate": "依据 {{$topic}}、{{$keypoints}} 和 {{$evidence}} 定位教材目录，确认章节后查考点。"
  }
}
```

内置两科继续读取原 `subjects/*.json`、`prompts/*.md` 和 `config/*.config.json`，本机设置键也保持原样。新包的 API 密钥与访问口令不属于可分享的 JSON；新包沿用生物入口服务端配置和访问口令，但浏览器制卡选项使用 `cardflow.pack.<id>` 独立存储键。导入文件不能设置端口、模块、文件路径、密钥或执行代码。学科包管理接口只接受生物入口的 `x-anki-token` 请求头；化学的旧口令仍然独立。可用 `ANKI_PACKS_DIR` 指定隔离目录供测试使用。

PWA 安装入口是 `https://<当前内网 IP>:3212/`；学科页在 `https://<当前内网 IP>:3212/<学科id>/`。旧手机上的 PWA 图标不会被服务器自动删除，确认新图标可用后手动删除即可。
