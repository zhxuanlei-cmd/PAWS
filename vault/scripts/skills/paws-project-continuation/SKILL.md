---
name: paws-project-continuation
description: 手动开工接续；仅在用户执行 /start、点选本 Skill 或明确要求按 PAWS 开工时使用。恢复项目目标、现场与下一步，不自动补日志。
disable-model-invocation: true
metadata:
  vault: PAWS
  invocation: manual
  command: start
---

# 开工接续

让当前工具仅凭项目文件和现场恢复可工作的上下文。输入是可选的项目名/路径、本次任务；输出是准确的接续简报。

## 触发与作用域

仅执行用户本次明确触发的开工流程。讨论命令、普通开发、工具启动或上下文压缩均不自动触发。
本文件是正文正本；短命令与旧 prompt 只定位到这里。开工不串行启动其他 PAWS 工作流。

## 定位后读取

1. 保存当前实际工作目录。使用安装时设置的 `VAULT_DIR` 或用户明确指定的 vault 路径。无法确定时先核对当前文件和项目所在的 PAWS vault。
   先读 vault 根 `AGENTS.md`，再用 `python3 scripts/paws_repository.py --vault <vault> --cwd <实际目录>` 定位。
   根据解析出的实际 checkout 区分 worktree，核对用户指定的项目。
   `--project <slug>` 查询项目默认仓库，不能用于当前 worktree 的定位。
   用户指定的项目与当前目录分离时，先核对其档案与本机映射，再对可读的映射目录用 `--cwd` 核实实际 checkout。
2. 解析成功但返回 `null` 时，没有指定项目就列出相关登记项，请用户明确项目；没有相关登记时报告“未登记”。
   项目映射冲突则报告候选与冲突原因，解析报错则报告实际错误。唯一匹配附有无关项目的读取警告时，继续接续并附报警告。
   已明确项目且 `10-projects/<slug>/AGENTS.md` 存在，但项目目录缺失或不可读时，用 `--project <slug>` 核实默认目录状态，
   区分 `missing`、`undeclared`、`unreadable` 与查询失败。记录“已登记，现场不可用”，继续读取档案，并保留旧快照。
   实际 checkout 可读且 `--cwd` 能核实归属时，以它为准。归属未决时记录待核实项，未登记时只读相关 vault 文件与现场；这两种情况下跳过派生刷新。
3. 已登记项目读项目 `AGENTS.md`、`<项目>-主页.md` 的相关介绍、`spec.md`、`HANDOFF.md` 与 `tasks.md` 中有效任务。
   根据本次任务及交接缺口读取相关 worklog、决定和证据，不固定日志篇数；历史已完成项只在需要追溯时展开。
   主页提供背景、目标、数据概况与基本方案；spec 提供开发要求、规范、环境和适用 Skills。
   状态直接读 HANDOFF/tasks，不依赖主页查询渲染；私有会话与 Context Pack 均不替代这些正本。
   只读取本次任务相关的能力 Skill；核实正文/依赖是否可用，待开发能力如实报告，不因清单自动运行六个工作流。
   已附具体任务时，按根 AGENTS 的“检索入口”按需读取相关共享知识与偏好；仅报到且任务未定时不扩大检索。
4. 以实际 checkout 现场读取 Git：分支/HEAD、已提交与未提交变化、上游情况。无 Git、无提交、
   无上游与读取失败分别报告；未知值不写成 0。记录当前 WIP，保留它与本次任务的边界。

## 核对与刷新

- 将 HANDOFF 的 `based_on`、下一步和任务状态与现场核对。无法从现有证据解释的漂移列为未核验；
  不从 Git 推断当时理由，不自愈补 worklog，不调用 distill。
- 读完规则并确认目标后，以 vault 为工作目录依次运行：
  `./scripts/repo_snapshot.sh --project <slug> --cwd <实际 checkout>`、
  `./scripts/handoff_sync.sh --project <slug> --cwd <实际 checkout>`。
  这只是用户本次开工授权内的派生刷新。刷新后重读派生区；无变化不应写入。
  当前角色无法执行时，报告“现场已读/派生未刷新”及具体缺项，不绕过权限或改用错误 checkout。
- 提出技术方案前检索本项目 `decisions/` 的 `rejected|否决|不做|production-unchanged|no-go`，
  读取相关条目全文。新方案与已否决方案相似时说明新的证据或条件变化。
- 已归档项目可只读接续；不得因执行 /start 就把它重新设为 active。恢复维护需用户明确要求。

## 完成结果

用简短结果说明：项目与实际目录；稳定目标；上次停点；当前 WIP 与验证边界；
本次任务与可执行下一步；阻塞、冲突与派生刷新结果。优先用户最新任务，不让历史下一步覆盖新指令。
只输入 /start 时完成接续简报；同时指定任务时继续该已授权任务。不得自动收工、萃取或归档。
