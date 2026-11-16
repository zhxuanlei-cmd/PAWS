#!/usr/bin/env bash
# MOC 覆盖率检查 —— Bases 不做反链聚合,"卡新增但忘挂 MOC"只能靠脚本兜
# 输出非空 = 有孤儿卡(没被任何 MOC/总索引引用)
set -u
# ★ 必须钉死排序 locale:卡名全是 CJK,BSD sort -u 在 en_US.UTF-8 下会把不同卡名
#   判为等价而折叠(实测 49 张折成 14 张),comm 随之失效、脚本照样打印"✅ 覆盖率 100%"。
#   守卫自己犯了它要防的错——这类静默失效必须在脚本层堵死,不能依赖调用方环境。
export LC_ALL=C
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

CARDS_DIRS=(30-resources/wiki 20-areas/insights)
# 知识总索引.md 自身带 type: moc,已被 grep 命中;再 ls 一次会重复计数(曾报"MOC 文件: 6"实为 5)。
# 保留 ls 作为"总索引万一丢了 type 字段"的兜底,但统一去重。
MOC_FILES=$( { grep -rl '^type: moc' --include='*.md' 20-areas 30-resources 2>/dev/null; \
               ls 30-resources/知识总索引.md 2>/dev/null; } | sort -u)

# 全部卡文件名(不含扩展名)
all=$(for d in "${CARDS_DIRS[@]}"; do
        [ -d "$d" ] && find "$d" -name '*.md' -exec basename {} .md \;
      done | sort -u)

# 全部被 MOC/总索引引用的名字
linked=$(printf '%s\n' $MOC_FILES | while IFS= read -r f; do
           [ -f "$f" ] && grep -o '\[\[[^]|#]*' "$f" | sed 's/^\[\[//'
         done | sed 's/[[:space:]]*$//' | sort -u)

orphans=$(comm -13 <(printf '%s\n' "$linked") <(printf '%s\n' "$all"))

echo "卡总数: $(printf '%s\n' "$all" | grep -c . )"
echo "MOC 文件: $(printf '%s\n' $MOC_FILES | grep -c .)"
if [ -z "$orphans" ]; then
  echo "✅ 无孤儿卡,MOC 覆盖率 100%"
  exit 0
else
  echo "❌ 孤儿卡(未被任何 MOC 引用):"
  printf '%s\n' "$orphans" | sed 's/^/  /'
  exit 1
fi
