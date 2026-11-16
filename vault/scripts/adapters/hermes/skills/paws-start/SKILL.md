---
name: paws-start
description: Hermes 的 /start 别名（/paws-start）对应 PAWS「开工接续」手动入口；仅当用户本次输入 /start、点选或明确要求执行时使用，讨论流程或普通任务不触发。
disable-model-invocation: true
metadata:
  vault: PAWS
  invocation: manual
  canonical_skill: paws-project-continuation
---

# PAWS 开工接续入口

先核对本次用户确已触发；仅发现本文件、任务结束或讨论适配不构成触发。
使用安装时设置的 `VAULT_DIR` 或用户明确指定的 vault 路径。无法确定时先核对当前文件和项目所在的 PAWS vault，再继续。
先读 `<vault>/AGENTS.md`，再直接读取并执行
`<vault>/scripts/skills/paws-project-continuation/SKILL.md`；该文件是唯一正文正本。
保留用户在命令后提供的项目、主题和范围；将其作为自然语言输入，不作 Shell 展开。
只执行本流程，不串联其他手动工作流；保留宿主当前角色、模型和权限，缺能力如实报告。
