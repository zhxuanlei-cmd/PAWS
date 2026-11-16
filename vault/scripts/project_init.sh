#!/usr/bin/env bash
# PAWS 新项目建档：只创建 vault 命名空间，只读识别依赖文件入口；不修改代码仓或安装环境。
# 用法: ./scripts/project_init.sh <slug> --repo <绝对路径或~/路径> [--name <显示名称>]
# 安全性: 目标已存在立即失败；先在同盘临时目录生成完整内容，再一次移入。
set -eu

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
VAULT="$PWD"
PROJECTS="$VAULT/10-projects"

usage() {
  echo "用法: $0 <slug> --repo <绝对路径或~/路径> [--name <显示名称>]" >&2
  exit 2
}

die() {
  echo "错误: $1" >&2
  exit 1
}

[ "$#" -ge 1 ] || usage
SLUG="$1"
shift
DISPLAY_NAME=""
CODE_REPO=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$#" -ge 2 ] || usage
      CODE_REPO="$2"
      shift 2
      ;;
    --name)
      [ "$#" -ge 2 ] || usage
      DISPLAY_NAME="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "slug 只允许小写字母、数字和连字符，最长 63 字符"
[ -n "$CODE_REPO" ] || die "必须用 --repo 声明代码或材料正本路径（目录可尚未创建）"
case "$CODE_REPO" in
  /*|"~"|"~/"*) ;;
  *) die "--repo 必须是绝对路径或 ~/ 路径" ;;
esac
case "$CODE_REPO" in
  *$'\n'*|*$'\r'*|*'`'*) die "--repo 不能包含换行或反引号" ;;
esac

[ -n "$DISPLAY_NAME" ] || DISPLAY_NAME="$SLUG"
case "$DISPLAY_NAME" in
  *$'\n'*|*$'\r'*) die "--name 不能包含换行" ;;
esac

TARGET="$PROJECTS/$SLUG"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  die "项目已存在，未写入任何文件: $TARGET"
fi

for template in "$VAULT/scripts/templates/spec.md" "$VAULT/scripts/templates/项目主页.md" "$VAULT/scripts/templates/凭据.md"; do
  [ -f "$template" ] || die "缺少模板: $template"
done

STAGE="$(mktemp -d "$PROJECTS/.project_init.${SLUG}.XXXXXX")" || die "无法创建临时目录"
cleanup() {
  [ -z "${STAGE:-}" ] || rm -rf "$STAGE"
}
trap cleanup EXIT INT TERM

mkdir -p "$STAGE/worklog" "$STAGE/decisions"
touch "$STAGE/worklog/.gitkeep" "$STAGE/decisions/.gitkeep"
TODAY="$(date '+%Y-%m-%d')"

render_template() {
  # 将已确认的项目标识与只读探测结果填入模板；版本和依赖内容仍由代码仓原生文件管理。
  python3 - "$1" "$2" "$SLUG" "$DISPLAY_NAME" "$TODAY" "$CODE_REPO" <<'PY'
import sys
from pathlib import Path


def environment_entry(repo):
    """返回常见环境文件的相对入口，供 spec 引用，不解析或执行项目内容。

    输入为用户声明的代码/材料目录（允许尚不存在）。这里只识别根目录及
    标准 .devcontainer 位置，不遍历大型工作树；未命中不等于不存在环境定义。
    不读取文件正文、不跟随指向仓外的链接、不安装依赖，也不检查锁文件有效性。
    """
    try:
        root = Path(repo).expanduser().resolve()
        if not root.is_dir():
            return "代码/材料目录尚不可用；由 agent 在开发时识别或建立项目定义，无需提供本机环境名"
        candidates = (
            "pyproject.toml", "uv.lock", ".python-version", "pylock.toml",
            "pixi.toml", "pixi.lock", "environment.yml", "environment.yaml",
            "conda-lock.yml", "conda-lock.yaml", "poetry.lock", "pdm.lock",
            "requirements.in", "requirements.txt", "requirements.lock",
            "package.json", "package-lock.json", "npm-shrinkwrap.json",
            "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
            ".node-version", ".nvmrc", "Dockerfile", "compose.yaml",
            "docker-compose.yml", ".devcontainer/devcontainer.json",
        )
        found = []
        for relative in candidates:
            candidate = root / relative
            try:
                candidate.resolve().relative_to(root)
            except ValueError:
                # 仓外链接不用于自动建档；具体外部依赖由后续任务核实其来源和授权。
                continue
            if candidate.is_file():
                found.append(f"`{relative}`")
        if found:
            return "代码/材料仓内 " + "、".join(found) + "；由 agent 核对权威定义及兼容性，不据存在性判定可用"
        return "未在常见位置识别定义；由 agent 核对构建/CI 或嵌套目录，再按任务选择；材料项目可注明不适用"
    except (OSError, RuntimeError):
        # 权限不足或链接循环只降低发现结果，不能误报已识别或阻止其他档案生成。
        return "环境入口未能完整读取；由 agent 核实目录访问与项目定义，无需提供本机环境名"


source, target, slug, display_name, today, repo = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    text = handle.read()
if "<项目环境定义>" in text:
    text = text.replace("<项目环境定义>", environment_entry(repo))
text = (
    text.replace("<项目名称>", display_name)
        .replace("<项目名>", display_name)
        .replace("<项目>", slug)
        .replace("<proj>", slug)
        .replace("YYYY-MM-DD", today)
)
with open(target, "x", encoding="utf-8", newline="\n") as handle:
    handle.write(text)
PY
}

render_template "$VAULT/scripts/templates/spec.md" "$STAGE/spec.md"
render_template "$VAULT/scripts/templates/项目主页.md" "$STAGE/$SLUG-主页.md"
render_template "$VAULT/scripts/templates/凭据.md" "$STAGE/凭据.md"

PROJECT_STAGE="$STAGE" PROJECT_SLUG="$SLUG" PROJECT_NAME="$DISPLAY_NAME" PROJECT_REPO="$CODE_REPO" PROJECT_DATE="$TODAY" \
python3 <<'PY'
import os
from pathlib import Path

stage = Path(os.environ["PROJECT_STAGE"])
slug = os.environ["PROJECT_SLUG"]
name = os.environ["PROJECT_NAME"]
repo = os.environ["PROJECT_REPO"]
today = os.environ["PROJECT_DATE"]

files = {
    "AGENTS.md": f"""# {name}（{slug}）项目约定

> vault 全局规则以根目录 `AGENTS.md` 为正本；本文件只声明项目映射和项目专属差异，不复制全局规则。

## 代码/材料正本

- code_repo: {repo}

## 项目入口

- 项目背景、目标、资料与基本方案：`{slug}-主页.md`
- 开发/制作需求、规范、环境、验收与适用 Skills：`spec.md`
- 当前接续：`HANDOFF.md`
- 任务状态：`tasks.md`
- 历史/决策：`worklog/` · `decisions/`；证据和实验目录有真实内容时再按需创建

## 项目专属约束

- TODO：只在这里记录相对 vault 全局规则更严或本项目独有的边界。
""",
    "CLAUDE.md": "@AGENTS.md\n",
    "HANDOFF.md": f"""---
type: handoff
project: {slug}
status: active
created: {today}
updated: {today}
started: {today}
phase: 建档
based_on: TODO
head_repo: code
next_action: 复核主页的项目介绍与 spec.md 开发要求，确认第一个可验收里程碑
draft: auto
---
# HANDOFF — {name}

## 当前状态

- PAWS 项目命名空间已建立，项目背景待在 `{slug}-主页.md` 复核，开发要求待在 `spec.md` 确认。
- 代码/材料正本声明为 `{repo}`；是否已建仓、分支和提交状态以上方机器派生区为准。

## 下一步

1. 复核 `{slug}-主页.md` 的背景、目标、数据概况、基本方案和预期交付物。
2. 复核 `spec.md` 的需求与验收；由 agent 核对仓内环境定义和可执行入口，不要求用户指定本机 Conda 名称；核实适用 Skill。
3. 在 `tasks.md` 只拆第一个可验收里程碑；需要开工接续时由用户手动执行 `/start`。

## 待人裁决

- 项目档案中的 TODO 项尚未复核；建档不等于方案已批准。
""",
    "tasks.md": f"""---
type: guide
project: {slug}
status: active
created: {today}
updated: {today}
tags: [tasks]
source: 项目建档
draft: auto
---
# tasks — {name}

- [ ] 补齐并复核 `{slug}-主页.md` 的项目介绍。
- [ ] 复核 `spec.md` 的开发/制作需求、验收条件与适用 Skills。
- [ ] 由 agent 核对或定义项目环境、安装/运行入口与隔离验证；材料项目注明实际制作工具。
- [ ] 确认代码/材料正本 `{repo}` 可读，并记录当前 Git 或 no-git 边界。
- [ ] 定义第一个可验收里程碑及其证据。
""",
}

for relative, content in files.items():
    with (stage / relative).open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
PY

mv "$STAGE" "$TARGET"
STAGE=""

# 生成首份机器派生状态；代码目录尚未建立也可如实记录。
if ! "$VAULT/scripts/repo_snapshot.sh" --project "$SLUG"; then
  echo "警告: 项目已创建，但首次仓库状态生成失败；修复后运行 /start" >&2
  exit 1
fi
if ! "$VAULT/scripts/handoff_sync.sh" --project "$SLUG"; then
  echo "警告: 项目已创建，但首次 HANDOFF 派生区生成失败；修复后运行 /start" >&2
  exit 1
fi

echo "✅ 已创建 PAWS 项目: $TARGET"
echo "下一步: 复核 $TARGET/$SLUG-主页.md 与 $TARGET/spec.md；需要接续时手动运行 /start"
echo "未创建或修改代码仓，未执行 git add/commit/push。"
