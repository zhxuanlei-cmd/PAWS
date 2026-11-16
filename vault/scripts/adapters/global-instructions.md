# PAWS 用户级入口

从 `VAULT_DIR` 定位工作区，读取该目录的 `AGENTS.md` 和任务相关的项目文件。没有配置 `VAULT_DIR` 时，按当前宿主原生方式工作；用户点选 PAWS 手动工作流时，核对工作区路径再执行。

`start`、`checkpoint`、`inbox`、`reflect`、`harvest`、`archive` 和项目整理 `consolidate` 仅在用户明确调用时执行。正文见工作区的 `scripts/skills/`。宿主入口仅用于定位，不触发后台工作。
