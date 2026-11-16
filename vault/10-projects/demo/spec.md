---
type: spec
project: demo
status: active
created: 2026-01-15
updated: 2026-01-15
source: 公开版合成示例
draft: auto
---
# 开发要求

- 输入单个 UTF-8 Markdown 文件，通过标准库读取。
- 忽略开头空白行。首个非空行须以 `# ` 开头且标题内容非空。
- 格式符合要求时返回 0，读取失败或缺少一级标题时返回 1。
- 验收用一份带一级标题的合成笔记和一份缺少一级标题的笔记。结果写入实施记录。
