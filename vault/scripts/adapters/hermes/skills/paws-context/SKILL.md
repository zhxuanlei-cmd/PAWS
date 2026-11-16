---
name: paws-context
description: Hermes 的 PAWS 用户级规则定位入口；仅加载规则，不执行任何手动工作流。
metadata:
  vault: PAWS
  invocation: context
---

# PAWS 用户级规则入口

本文件仅通过 Hermes 原生 skills.auto_load 加载规则定位说明。加载、普通任务、结束回复、压缩或换会话均不触发任何 PAWS 工作流。
使用安装时设置的 `VAULT_DIR` 或用户明确指定的 vault 路径。无法确定时先核对当前文件和项目所在的 PAWS vault，再继续。
先读取 `<vault>/scripts/adapters/global-instructions.md` 与 `<vault>/AGENTS.md`，再按当前任务读取相关项目正本。规则以这些正本为准，不以本入口另存项目事实。
七个手动短命令为 /start、/checkpoint、/inbox、/reflect、/harvest、/archive、/consolidate。
Hermes 的 /start 通过原生 quick_commands 别名定位 /paws-start；也可显式使用 /paws-start 或 /paws-project-continuation。
仅用户本次输入命令、点选或明确要求执行对应流程时，读取该入口所指向的唯一 SKILL.md 正文；讨论流程不构成执行授权。
模型、工具、记忆、会话与审批继续使用 Hermes 原生能力。共享 Skill 不移植其他宿主的模型、插件、provider 检查或权限，不自动提交或推送；保留已有 WIP。
