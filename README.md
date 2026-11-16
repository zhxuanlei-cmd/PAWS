# PAWS

**Personal AI Work System · 个人 AI 智能体工作系统**

换一个 AI 工具，继续同一个项目。

做了几天的项目，换个模型、打开新会话，常常又要解释背景、约束和上次做到哪。PAWS 用本地 Markdown 记录这些信息。工作告一段落时执行 `/checkpoint`，下次在原工具或另一个已接入的工具里执行 `/start`，它就能读到同一份项目档案，并核对当前 Git 状态。

[命令速查](#paws-命令速查) · [快速体验](#快速体验) · [接入你的 AI 工具](#接入你的-ai-工具) · [项目档案](#项目档案) · [MIT 许可证](LICENSE)

## PAWS 能帮你做什么

| 你遇到的情况 | PAWS 提供的帮助 |
| --- | --- |
| 在不同 AI 工具之间接力 | Codex、Claude Code、OpenCode、Antigravity、Hermes 使用同一套项目文件和工作流正文，各自使用原生模型与工具。 |
| 隔天回来，不确定做到哪 | 接续时读项目目标、约束、上次停点和待办，再核对实际 checkout、提交与未提交改动。 |
| 两周后要追查当时的决定 | 在 worklog 里保留过程和验证结果，在 decisions 里记录取舍，待办可以指向具体证据。 |
| 想留下可复用的方法 | 手动提炼项目经验，审阅后再保存为知识卡或同源 Skill。 |

```mermaid
flowchart LR
    A["AI 工具 A<br/>收工时执行 /checkpoint"] --> B["Vault 中的 Markdown<br/>进展 · 证据 · 下一步"]
    B --> C["AI 工具 B<br/>开工时执行 /start"]
    D["实际 Git checkout"] --> C
```

工作流由你主动触发。Vault 文件用普通编辑器即可查看，也可以纳入你自己的版本管理。

## PAWS 命令速查

日常接续只需 **`/start` 开工、`/checkpoint` 留下交接**。在 AI 工具中主动触发工作流。看不到斜杠命令时，点选对应的 [Skill](vault/scripts/skills)，或明确请 AI 执行该流程。

终端命令从 PAWS 仓库根目录运行。表中的 `paws …` 可用 `node engine/dist/src/cli.js …` 执行，首次使用前先[构建 Engine](#构建和验证)。将 `PROJECT`、`PATH`、`FILE` 等占位符替换为实际值。

| 能力 | 命令 / 入口 | 何时用 |
| --- | --- | --- |
| 项目接续 | `/start`（Hermes 也可用 `/paws-start`） | 开新会话或换工具时，恢复项目目标、约束、待办与下一步，并核对实际 Git 状态。 |
| 项目接续 | `/checkpoint` | 工作告一段落时，保存进展、决定、证据、未提交工作与下一步。 |
| 材料与知识 | `/inbox` | 给收件箱里的材料分类、查重，并按确认的去向归档。 |
| 材料与知识 | `/reflect` | 从当前会话整理可长期复用的偏好和工作约定，也适用于未建档项目。 |
| 材料与知识 | `/harvest` | 从项目资料、代码和验证证据中提炼可复用的知识草稿。 |
| 结项与维护 | `/consolidate` | 把探索阶段的项目整理成可继续维护的形态，明确正本、保留恢复点并补齐运行与交付说明。 |
| 结项与维护 | `/archive` | 核对交付、验收和遗留事项，再在原目录标记归档。 |
| 专业 Skills | `paws-ai-experiment` / `paws-office-delivery` | 按任务调用，用于设计和验证 AI 实验，或制作和检查办公文档。 |
| 安装宿主 | `node vault/scripts/paws_setup.mjs plan --host HOST` | 预览指定宿主会安装哪些入口以及是否有冲突。 |
| 安装宿主 | `node vault/scripts/paws_setup.mjs apply --host HOST` | 安装或更新该宿主的 PAWS 入口。 |
| 安装宿主 | `node vault/scripts/paws_setup.mjs doctor --host HOST` | 检查已安装的入口是否齐全、是否指向当前 Vault。 |
| 安装宿主 | `node vault/scripts/paws_setup.mjs rollback RUN_ID` | 按安装时返回的批次号恢复安装前状态，发现后续修改时会提示冲突。 |
| OpenCode | `~/.local/bin/paws-opencode` | 启动已配置的 OpenCode，并应用 PAWS 的工作区与模型提供方规则。 |
| 建档与定位 | `vault/scripts/project_init.sh PROJECT --repo PATH` | 给现有代码或材料目录创建主页、开发要求、交接记录和待办。 |
| 建档与定位 | `python3 vault/scripts/paws_repository.py --cwd PATH` | 从当前工作目录定位项目和实际 Git checkout。 |
| 建档与定位 | `vault/scripts/repo_snapshot.sh --project PROJECT --cwd PATH` | 从当前 checkout 更新项目的仓库状态快照。 |
| 建档与定位 | `vault/scripts/handoff_sync.sh --project PROJECT --cwd PATH` | 更新 HANDOFF 中由脚本生成的 Git 状态和待办统计。 |
| Vault 检查 | `vault/scripts/fm_lint.sh` | 检查 Markdown 元数据和决策引用，可用 `--files` 指定文件范围。 |
| Vault 检查 | `vault/scripts/check_moc_coverage.sh` | 找出尚未被知识索引或 MOC 引用的知识卡。 |
| Vault 检查 | `python3 vault/scripts/decision_link_lint.py vault` | 单独检查决策记录的更正与取代关系。 |
| Vault 检查 | `python3 vault/scripts/paws_maintenance_check.py` | 汇总格式检查、知识索引覆盖和 Vault 工作树状态。 |
| Skill 审阅 | `python3 vault/scripts/paws_knowledge.py scan --project PROJECT` | 从有证据的项目里程碑发现可审阅的 Skill 候选。 |
| Skill 审阅 | `python3 vault/scripts/paws_knowledge.py prepare --candidate ID` | 为已整理的候选生成带内容摘要的审批请求。 |
| Skill 审阅 | `python3 vault/scripts/paws_knowledge.py publish --candidate ID --approval FILE` | 核验人工批准与内容摘要一致后，将 Skill 登记到本地 Vault。 |
| Engine 诊断 | `paws doctor` | 检查 Vault 的结构化文档及本地状态目录权限。 |
| Engine 诊断 | `paws lint` | 校验 Vault 或指定文件中的结构化任务、证据、仓库和策略记录。 |
| Engine 诊断 | `paws schema-check --vault vault` / `paws fixture-test` | 检查 Schema 能否加载，并用自带正反例验证校验规则。 |
| 上下文包 | `paws context build --project PROJECT` | 从项目档案生成可重建的 Context Pack。 |
| 上下文包 | `paws context verify --file FILE` / `paws context show --file FILE` | 检查包的来源是否有变更，或查看包内容。 |
| 适配器诊断 | `paws adapters plan` / `paws adapters sync` / `paws adapters check` | 预览、生成或校验适配器导出，可用 `--test-root` 指定测试目录。 |
| OpenCode 诊断 | `paws opencode validate --config FILE --schema FILE` | 用指定的 JSON Schema 检查 OpenCode 配置。 |
| OpenCode 诊断 | `paws opencode runtime-overlay --cwd PATH` | 查看当前工作区的 OpenCode 运行时规则。 |
| OpenCode 诊断 | `paws opencode provider-check --cwd PATH --provider ID` | 核对当前工作区是否允许某个模型提供方。 |
| 帮助 | `paws --help` / `paws --version` | 查看 CLI 用法和当前版本。 |

## 快速体验

准备 **Git、Python 3.10+**，在 macOS 或 Linux 的终端中运行。这个示例会在临时目录运行一个 Markdown 标题检查器，并为它创建 PAWS 项目档案。

```sh
git clone https://github.com/zhxuanlei-cmd/PAWS.git
cd PAWS
export VAULT_DIR="$(pwd -P)/vault"

demo="$(mktemp -d)"
cp -R examples/demo-project/. "$demo/"
git -C "$demo" init -q
(cd "$demo" && python3 check_notes.py sample.md)

"$VAULT_DIR/scripts/project_init.sh" quickstart --repo "$demo" --name "Markdown 标题检查器"
python3 "$VAULT_DIR/scripts/paws_repository.py" --vault "$VAULT_DIR" --cwd "$demo"
```

检查器应输出 `OK sample.md`，定位结果应包含 `"project": "quickstart"`。打开 `vault/10-projects/quickstart/HANDOFF.md`，可以看到这个项目的阶段、下一步和 Git 快照。

## 接入你的 AI 工具

再准备 **Node.js 24+** 及所选工具。选择一个工具安装，下面以 Codex 为例。先运行 `plan` 查看将创建的入口，再运行 `apply` 安装。已有入口来自其他工作区时，先处理安装器报告的冲突。

```sh
cd "$(dirname "$VAULT_DIR")"
host=codex
node vault/scripts/paws_setup.mjs plan --host "$host" --vault "$VAULT_DIR"
node vault/scripts/paws_setup.mjs apply --host "$host" --vault "$VAULT_DIR"
node vault/scripts/paws_setup.mjs doctor --host "$host" --vault "$VAULT_DIR"
```

可用的 `host` 值是 `codex`、`claude`、`opencode`、`antigravity`、`hermes`。要先在隔离目录试装，在当前终端设置 `test_home="$(mktemp -d)"`，再在三条命令末尾分别加上 `--home "$test_home"`。

在同一终端执行 `cd "$demo"`，从该目录启动已接入的工具。桌面客户端可直接打开这个目录，再在会话中提供 Vault 的绝对路径。

1. **开工**。点选 `paws-project-continuation`，或直接说「请按 PAWS 开工，接续项目 quickstart」。如果工具显示 PAWS 的 `/start`，也可以直接执行。Hermes 还可使用 `/paws-start`。
2. **工作**。请 AI 运行示例检查器并核对结果。
3. **收工并接力**。点选 `paws-checkpoint`，执行工具里可见的 `/checkpoint`，或明确要求按 PAWS 保存本次结果和下一步。打开另一个已接入的工具，对着同一个目录再按 PAWS 开工。

看不到 Skill 时，也可以直接向 AI 提供对应 [Skill 正本](vault/scripts/skills)的绝对路径，请它读取并执行。

> **OpenCode 和 Hermes。** OpenCode 的命令和 Skills 可独立安装。需要运行时策略时，先构建 Engine、安装 zsh，在原生 OpenCode 完成模型配置与登录，再运行 `paws-opencode`。启动器使用默认的 `~/.config/opencode/opencode.json`（标准 JSON）。如果你自定义了 `XDG_CONFIG_HOME`，可继续使用原生 OpenCode。Hermes 安装需要 PyYAML，可使用现有 Hermes 环境，也可按下方步骤安装 Python 依赖并设置 `PAWS_PYTHON="$(command -v python3)"`。

## 项目档案

开始自己的项目时，将建档命令中的 `quickstart`、`--repo` 和 `--name` 改成自己的项目标识、真实代码目录的绝对路径及显示名称。PAWS 会生成下面的档案，源码继续由原来的仓库维护。

| 文件 | 回答的问题 |
| --- | --- |
| `<项目>-主页.md` | 这个项目给谁用，预期做到什么？ |
| `spec.md` | 有哪些需求、技术约束和验收标准？ |
| `HANDOFF.md` | 做到哪了，目前有什么阻塞，下一步是什么？ |
| `tasks.md` | 哪些事待办、已完成或已取消？ |
| `worklog/` 与 `decisions/` | 做过什么验证，关键选择是怎么定的？ |

这个公开仓库的忽略规则会排除你新建的项目档案和知识卡。需要备份或跨设备接续时，用自己的 Vault 仓库同步档案，并在新设备核对代码目录映射。

查看完整的[示例项目](vault/10-projects/demo/demo-主页.md)和 [Vault 工作约定](vault/AGENTS.md)。

## 构建和验证

使用 Engine CLI、OpenCode 运行时策略，或参与开发时，在仓库根目录运行。

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r vault/requirements.txt

npm --prefix engine ci
npm --prefix engine run build
node engine/dist/src/cli.js doctor
pack_dir="$(mktemp -d)"
node engine/dist/src/cli.js context build --project demo --output "$pack_dir/context.json"
node engine/dist/src/cli.js context verify --file "$pack_dir/context.json"
```

`doctor` 检查 Engine 与 Vault，接下来的命令在临时目录生成样例 Context Pack 并核对其来源。日常接续以项目 Markdown 与实际 Git 状态为准。OpenCode 启动器安装后位于 `~/.local/bin/paws-opencode`。可用 `OPENCODE_REAL_BIN` 指定原生 OpenCode 的可执行文件。

<details>
<summary>运行测试套件</summary>

```sh
npm --prefix engine test
node --test vault/scripts/tests/*.test.mjs
python -B -m unittest discover -s vault/scripts/tests -p 'test_*.py'
bash vault/scripts/tests/test_derived_state.sh
bash vault/scripts/tests/test_project_init.sh
bash vault/scripts/fm_lint.sh
bash vault/scripts/check_moc_coverage.sh
```

</details>

[Engine 使用说明](engine/README.md) · [MIT 许可证](LICENSE)
