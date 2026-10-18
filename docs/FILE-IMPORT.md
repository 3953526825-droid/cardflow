# 文件导入

选择文件支持 PDF、DOCX、MD、TXT、CSV、JSON、HTML、XML、LOG 和图片。DOC 需先另存 DOCX/PDF。PDF 不再限制 24 页，使用文档队列分批确认加载。详见 [大文档与扩展卡片](LONG-DOCUMENTS.md)。

512MB 是文件读取上限，不代表手机一定能处理；每批 1–8 页，默认两页；图像默认保留。DOCX 只取正文，如需图片请转 PDF。文件在浏览器本地解析，选中的批次文字和图像发送给你配置的 AI 服务。无新增 npm 依赖。
