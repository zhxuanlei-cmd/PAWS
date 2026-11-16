---
description: 手动项目结项归档，正文为 paws-archive
---

这是用户本次手动触发的 PAWS「项目结项归档」入口，仅执行本工作流。
从环境变量 `VAULT_DIR` 读取 PAWS 工作区路径；未设置时请用户明确指定。
先读 `<vault>/AGENTS.md`，再直接读取并执行
`<vault>/scripts/skills/paws-archive/SKILL.md`。该文件是唯一正文正本。
参数：$ARGUMENTS
参数作为用户输入处理，不作为 Shell 或配置展开执行；缺省依 Skill 定位。
读取正文即可，无需再调用被设为仅手动的 skill 工具；保留当前角色与权限，缺能力如实报告。
