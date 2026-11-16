---
name: paws-checkpoint
description: 手动收工保存；仅在用户执行 /checkpoint、点选本 Skill 或明确要求按 PAWS 保存交接状态时使用。保存事实、决定、WIP、证据与下一步。
disable-model-invocation: true
metadata:
  vault: PAWS
  invocation: manual
  command: checkpoint
---

# 收工保存

把本次尚未记录的工作变成下一工具可直接接续的文件。收工表示保存当前状态，不表示项目完成或已发布。

## 输入与边界

仅在用户本次明确触发时执行。输入为当前会话的实际工作、可选项目与交接要求。
使用安装时设置的 `VAULT_DIR` 或用户明确指定的 vault 路径。无法确定时先核对当前文件和项目所在的 PAWS vault，再继续。
先读根/项目 AGENTS，并用
`scripts/paws_repository.py --vault <vault> --cwd <实际目录>` 核实项目，并与用户指定项目核对。
`--project` 只查询默认仓库，不用于当前 worktree 定位；必要时先解析项目映射，再对实际目录用 --cwd。
保留实际 checkout；跨项目只记录各自被实质推进的部分，不向所有项目批量写入。
用户已明确项目且档案存在、但现场目录不可用时，用 `--project <slug>` 查询默认目录状态，
继续读取该项目档案并保存有来源的本次新增事实，不改记到未登记 episodes。保留原 based_on 与旧派生区，
标明现场未核对/派生未刷新，跳过需要实际 checkout 的步骤，报告“部分保存”；不把默认仓库状态冒充本次 worktree。
未登记的 vault 工作写 `memory/episodes/YYYY-MM-DD.md`，跳过不存在的项目文件与派生脚本。

## 形成可接续的内容

先读已有主页的项目介绍正文、spec、HANDOFF、任务、最近相关记录与 live Git，区分本次新增事实、原有 WIP 和未验证假设。
重复执行时只补新增信息；没有新增事实不追加空日志。无需查找或依赖宿主私有会话 ID/转录。

1. **追加 worklog**：使用 `worklog/YYYY-MM-DD.md`，新文件含完整记录类 frontmatter、`headline`、
   `draft: auto`。一节只写做了什么、决定与理由、进行中/WIP、下一步及验收办法、验证结果和证据路径。
   没有执行的检查写“未执行”；命令存在或 HTTP 可达不等于任务验收通过。
   文档工作应记录实际交付文件、来源版本和渲染检查；算法工作应记录协议、数据范围与结论边界。
2. **维护项目介绍与开发要求**：未来会需要理由的决定写 ADR；已确认的背景、业务目标、数据概况、
   基本方案和预期交付变化写主页；功能/制作范围、数据合同、规范、环境或验收变化写 spec。
   保留各自来源与 created，同一事实只在对应正本维护；主页中的当前进度仍从 HANDOFF/tasks 聚合。
3. **更新 HANDOFF 判断区与 tasks**：保留机器派生区标记；判断区写当前阶段、WIP、阻塞、未核验项
   和唯一下一步。维护 `status/updated/next_action/based_on`；based_on 取实际 checkout 的 HEAD，
   无 Git/无提交分别注明。任务只有有证据完成时才标 `[x]`；取消/已取代用 `[-]` 并保留理由，
   未完成及未验证项保留为有效待办，不把“取消”当“完成”。phase/next_action 与判断区对应同一当前事实。
   判断区只保留可接续的当前事实，已完成历史用 worklog/证据入口追溯，不按字符数或删除比例重复审批已授权整理。
   保留当前约束、WIP、未决项和唯一下一步，未知意图或实质内容损失先澄清。历史 worklog 只追加。
4. **最后刷新派生状态**：上面所有事实与任务写完后，才以 vault 为工作目录运行
   `./scripts/handoff_sync.sh --project <slug> --cwd <实际 checkout>`，再运行
   `./scripts/repo_snapshot.sh --project <slug> --cwd <实际 checkout>`。
   重读派生区，确认基线与任务计数对应最终文件。不能因前面曾运行过就省略这一步。
5. **检查与回读**：对本次实际写入的内容文件执行 `./scripts/fm_lint.sh --files <文件...>`；
   该入口按需扩到同项目 ADR 关系、完整严格对象图或知识卡/MOC 覆盖。删除迁移、全局规则/schema/检查器变更，
   或用户明确要求时，执行全量 `./scripts/fm_lint.sh` 与 `./scripts/check_moc_coverage.sh`。
   当前版本、输入、环境与声称范围均匹配的有效证据可复用；受限角色只有 `paws_maintenance_check` 时可用其固定全量检查，逐项查看 exit_code。
   区分本次引入问题和既有问题，不为全绿修改无关材料。回读实际写入的状态、路径和下一步。

## 输出与停止

报告已保存文件、已执行检查及失败/未执行项、遗留 WIP、明确的下一步。
任何必需写入被拒绝或失败都报告“部分保存”，不声称完成交接；展示具体剩余动作。
本工作流不自动 add/commit/push；有实际变更可给出分仓 commit 建议。用户另外明确授权本地暂存/提交时按范围执行，不重复询问；push 仍须单独授权。

本命令不执行 distill、不写捕获标记、不扫描知识候选、不提示定期 reflect，不自动调用 harvest/archive。
里程碑事实可正常记录在项目 worklog；是否萃取、整固或归档由用户另行手动触发。
