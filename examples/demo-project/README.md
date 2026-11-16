# 示例项目 · Markdown 标题检查器

一个用于演示 PAWS 项目接续的小型本地工具。它读取指定 Markdown 文件并检查首个非空行是否为一级标题，使用 Python 标准库。

```sh
python3 check_notes.py sample.md
```

预期输出 `OK sample.md`。删去示例文件的标题后，命令应返回非零退出码。
