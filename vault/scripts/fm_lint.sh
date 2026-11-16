#!/usr/bin/env bash
# frontmatter 体检 —— 防"视图静默匹配 0 行"这类故障(已发生过一次)
# 用法:./scripts/fm_lint.sh [--files 文件...]；无参数保留全量检查，指定文件只查相关范围。
# 知识卡 YAML 解析需要 Python 3 + PyYAML；PAWS_PYTHON 可指定已配置依赖的解释器。
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

# 只体检"知识/项目"内容;指令文件(AGENTS/命令薄壳/提示词正本)本就不该有 frontmatter
# 扫 30-resources 与 20-areas 全树(含根目录的总索引等);已归档文档在 40-archive,不在扫描范围
SCAN_DIRS=(10-projects 20-areas 30-resources memory daily 00-inbox)
EXCLUDE='/\.git/|TaskNotes/'
TYPES='wiki|insight|decision|worklog|episode|fact|profile|skill|handoff|spec|daily|inbox|moc|experiment|repostate|dashboard|guide|architecture|task|evidence|repository|policy'

# 范围检查复用 YAML 和 ADR 门禁；知识关系、严格对象关系按实际影响扩展检查。
# 参数传递不经过 eval；空清单或无效路径报错，避免把「未检查」当成通过。
if [ "$#" -gt 0 ]; then
  exec "${PAWS_PYTHON:-python3}" -B scripts/fm_lint_scope.py --types "$TYPES" "$@"
fi

fail=0
note() { echo "  $1"; fail=1; }

echo "== (a) 缺 frontmatter 的内容文件 =="
# 00-inbox 豁免:架构 §6.1 规定捕获零门槛(任何格式先扔进来),分流时才补 frontmatter
for d in "${SCAN_DIRS[@]}"; do
  [ -d "$d" ] || continue
  [ "$d" = "00-inbox" ] && continue
  while IFS= read -r f; do
    echo "$f" | grep -qE "$EXCLUDE" && continue
    case "$(basename "$f")" in AGENTS.md|CLAUDE.md) continue ;; esac
    head -1 "$f" | grep -q '^---$' || note "缺 frontmatter: $f"
  done < <(find "$d" -name '*.md' 2>/dev/null)
done
n_inbox=$(find 00-inbox -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[ "$n_inbox" -gt 0 ] && echo "  (00-inbox 待分流 $n_inbox 条,豁免 frontmatter 检查;跑 /inbox 清空)"

echo "== (b) type 值不在白名单内 =="
while IFS= read -r line; do
  f="${line%%:*}"; v="$(echo "$line" | sed -E 's/.*type:[[:space:]]*//' | tr -d '"'"'"' ')"
  echo "$f" | grep -qE "$EXCLUDE" && continue
  echo "$v" | grep -qE "^($TYPES)$" || note "type 非法「${v}」: ${f}"
done < <(grep -rn '^type:' --include='*.md' "${SCAN_DIRS[@]}" 2>/dev/null)

echo "== (c) 10-projects/ 下缺 project 字段 =="
while IFS= read -r f; do
  case "$(basename "$f")" in AGENTS.md|CLAUDE.md) continue ;; esac
  head -20 "$f" | grep -q '^project:' || note "缺 project: $f"
done < <(find 10-projects -name '*.md' 2>/dev/null)

echo "== (d) draft: true 存量(按 type 分级;2026-08-31 变更)=="
# 分级依据:draft 只对「会被复用的知识断言」有意义。
# 记录类(worklog/decision/handoff/spec/episode/repostate/experiment/daily)是既成事实的记录,
# 人工复核它们不产生信息增量,只制造无法清空的队列——实测曾积压至 197/385(51%)。
# 严格对象(task/evidence/repository/policy)的 JSON Schema 要求 draft 必须是 boolean,
# 不可降级为 auto——2026-08-31 曾因此打破 paws lint,已回滚并在此固化保护。
STRICT_TYPES='task|evidence|repository|policy'
KNOWLEDGE_TYPES='wiki|insight|fact|profile|skill|moc'
drafts=$(grep -rl '^draft: true' --include='*.md' "${SCAN_DIRS[@]}" 2>/dev/null | grep -vE "$EXCLUDE")
n_all=$(printf '%s\n' "$drafts" | grep -c . || true)
n_k=0; n_r=0
klist=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  t="$(head -20 "$f" | sed -nE 's/^type:[[:space:]]*"?([a-z-]+)"?.*/\1/p' | head -1)"
  if echo "$t" | grep -qE "^($KNOWLEDGE_TYPES|$STRICT_TYPES)$" || head -30 "$f" | grep -q '^candidate_kind:'; then
    n_k=$((n_k+1)); klist="${klist}    [${t}] ${f}
"
  else
    n_r=$((n_r+1))
  fi
done <<< "$drafts"
echo "  ① 知识断言类(需人工复核): $n_k 个"
[ -n "$klist" ] && printf '%s' "$klist"
echo "  ② 记录类(draft 无意义,建议批量降为 draft: auto): $n_r 个"
echo "  合计 $n_all;分级前的「待复核」口径会把 ② 也算进来,那是队列永远清不空的原因。"

echo "== (e) 共享 wiki/insight YAML 与检索字段门禁 =="
paws_python="${PAWS_PYTHON:-python3}"
"$paws_python" scripts/knowledge_fm_lint.py --vault "$PWD" || fail=1

echo "== (f) PAWS Ontology Lite 严格对象门禁 =="
# 优先使用公开副本随附的 Engine。显式 PAWS_BIN 可选择独立安装。
paws_lint=()
if [ -n "${PAWS_BIN:-}" ]; then
  paws_lint=("$PAWS_BIN")
elif [ -f "$PWD/../engine/dist/src/cli.js" ]; then
  paws_lint=(node "$PWD/../engine/dist/src/cli.js")
elif command -v paws >/dev/null 2>&1; then
  paws_lint=(paws)
fi
if [ "${#paws_lint[@]}" -gt 0 ]; then
  "${paws_lint[@]}" lint --vault "$PWD" --mode compatibility || fail=1
else
  echo "  (未安装 paws CLI，跳过 Ontology Lite 增量门禁；保留 (a)-(e) 门禁)"
fi

echo "== (g) ADR 失效关系门禁(corrects/supersedes 可解析且语义不冲突)=="
# ADR 对后续工作有阻断力(根 AGENTS「提方案前的强制检索」),但 decision 属记录类、
# 原本没有失效字段。失效关系只由新 ADR 前向声明,历史文件不改写;详见脚本内文档。
"$paws_python" scripts/decision_link_lint.py "$PWD" || fail=1

echo
[ "$fail" = 0 ] && echo "✅ frontmatter 体检通过" || echo "❌ 体检发现问题(见上)"
exit "$fail"
