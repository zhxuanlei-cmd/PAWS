---
type: guide
project:
status: active
created: 2026-11-16
updated: 2026-11-16
tags: [PAWS, Skill]
source: PAWS 候选审阅与本地注册流程
draft: auto
---

# Skill 审阅与本地注册

此流程将经过人工审阅的候选登记到当前 vault 的 `paws.manifest.json`，供本机适配器安装或链接。使用 `VAULT_DIR` 指向当前 vault，在其根目录运行示例命令。命令中的 `demo` 和 `candidate-id` 分别替换为实际项目标识和候选标识。

1. 确认项目里程碑有可追溯的证据。来源文件的 frontmatter 包含 `source_kind: local-project`，里程碑 worklog 另含 `milestone_id`、`milestone_status: done`、`summary` 和单行 JSON 数组 `evidence`。证据用 vault 相对路径，指向 `10-projects/<slug>/worklog/`、`decisions/` 或 `evidence/` 中的 Markdown 文件。外部来源不能进入自动候选。
2. 显式运行 `python3 scripts/paws_knowledge.py scan --project demo`，取输出中的候选标识。候选保存在 `memory/agent/candidates/`，保留 `draft: true`。
3. 在 `memory/agent/candidates/candidate-id/skill/` 编写 `SKILL.md` 及确有需要的附属文件，名称使用 `paws-` 前缀。在 `memory/agent/candidates/candidate-id/review.md` 的 frontmatter 填写 `scope`、`counterexample`、`validation` 和 `duplicate_check`，正文记录试用证据、限制及与已有 Skill 的关系。
4. 运行 `python3 scripts/paws_knowledge.py prepare --candidate candidate-id`。审阅 `approval-request.json` 中的候选材料、来源和文件哈希，并把该版本的 `digest` 与实际 Skill 内容交给用户确认。文件变化后重新生成审阅包。
5. 用户明确批准该内容后，在 `memory/agent/approvals/` 以 Markdown 记录授权。frontmatter 需有 `decision: approve`、`source: user-approval`、`approved_by`、`approval_ref` 和 `approved_digest`。`approval_ref` 引用真实授权，`approved_digest` 填用户批准的 `digest`。
6. 运行 `python3 scripts/paws_knowledge.py publish --candidate candidate-id --approval memory/agent/approvals/approved.md`。工具复核内容摘要和批准记录，将新 Skill 写入 `scripts/skills/`，在 manifest 登记并保存 `PUBLICATION.json` 回执。
7. 按公开项目的安装说明，对所选宿主运行安装器的 `plan`、`apply`、`doctor`。需要时在宿主重启或刷新 Skills，再核对发现与调用。对外发布或 Git 推送须有单独授权。

摘要用于绑定用户审阅的内容。候选与批准记录保存在本地资料目录，请保持来源可追溯并限制访问。
