#!/usr/bin/env python3
"""ADR 失效关系门禁 —— 让"这条决定已被更正/取代"成为可检索的 frontmatter 事实。

## 为什么需要这个门禁

根 AGENTS「提方案前的强制检索」要求提方案前先检索本项目 `decisions/`，因此 ADR 对
后续工作具有**阻断力**。但 PAWS 的类型学把 `decision` 归为记录类（见 fm_lint.sh 的
分级注释），它没有字段门禁，也没有失效字段（`superseded_by` 原本只给 `fact` 用）。
结果是：一条被后来证据推翻的判据，可以继续以完整 ADR 权威被检索到，旁边没有任何标记。

例如，后续验证发现某项验收阈值的计算错误，应由新 ADR 显式登记更正关系。

## 设计取舍：只做前向声明，不改写历史文件

失效关系**只由新 ADR 声明**（`corrects` / `supersedes`），被更正的旧文件一律不动。
这样既满足不变量 I4（供检索的状态存于 frontmatter，不只在正文），又不触碰
根 AGENTS 禁区中「历史记录只追加」的边界——旧 ADR 不需要被回头编辑。

代价是「某条 ADR 是否已被更正」需要反查而非直接读它的头部；本脚本的汇总输出
和一条 `rg 'corrects:.*<slug>'` 都能回答，Bases 视图亦可聚合。

## 字段语义

- `corrects: [slug, ...]`    —— **部分**更正：旧 ADR 的某些结论作废，其余仍有效。
- `supersedes: [slug, ...]`  —— **整体**取代：旧 ADR 不再适用。

slug 为被指向 ADR 的文件名去掉 `.md`，须与本 ADR 在同一项目的 `decisions/` 下。

## 检查项

1. `corrects` / `supersedes` 中的每个 slug 必须能解析到同项目 `decisions/` 下的真实文件；
   指向不存在的文件即失败（防拼错导致的静默失联）。
2. 不得自指（A 更正 A）。
3. 同一个 slug 不得同时出现在 `corrects` 与 `supersedes`（语义互斥：部分更正 vs 整体取代）。

退出码：0 = 通过；1 = 发现问题。汇总区始终打印，便于人工扫一眼哪些 ADR 已被更正。
"""

import argparse
import os
import re
import sys

# frontmatter 的两种 YAML 列表写法都要支持：
#   corrects: [a, b]            —— 行内
#   corrects:\n  - a\n  - b     —— 块状
# 行尾允许 ` # 说明`（YAML 注释），故各式都不以 `$` 硬收口，改为先剥注释再匹配。
_INLINE = re.compile(r"^(corrects|supersedes):\s*\[(.*?)\]\s*$")
_BLOCK_KEY = re.compile(r"^(corrects|supersedes):\s*$")
_BLOCK_ITEM = re.compile(r"^\s+-\s*(.+?)\s*$")


def strip_comment(line):
    """剥掉 YAML 行尾注释。

    只处理不在引号内的 `#`——本脚本关心的字段值是 ADR slug（`YYYY-MM-DD-...`），
    不含引号内的 `#`，故按首个 ` #` 截断即可，不引入完整 YAML 解析依赖。
    """
    idx = line.find(" #")
    return line[:idx].rstrip() if idx >= 0 else line.rstrip()
_TYPE = re.compile(r'^type:\s*"?([a-z-]+)"?')


def read_frontmatter(path):
    """读取文件开头的 frontmatter 原始行。

    仅当首行为 `---` 时认为存在 frontmatter；返回其中的行列表（不含两条 `---`）。
    读取失败或无 frontmatter 时返回空列表，由调用方按"不参与检查"处理。
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            first = f.readline()
            if first.strip() != "---":
                return []
            lines = []
            for line in f:
                if line.strip() == "---":
                    return lines
                lines.append(line.rstrip("\n"))
    except OSError:
        return []
    return []


def parse_links(fm_lines):
    """从 frontmatter 行中解析 corrects / supersedes 两个 slug 列表。

    返回 {"corrects": [...], "supersedes": [...]}；缺字段时对应列表为空。
    值两侧的引号会被剥掉，空串被丢弃（`corrects: []` 是合法的"没有更正任何条目"）。
    """
    out = {"corrects": [], "supersedes": []}
    key = None
    for raw in fm_lines:
        line = strip_comment(raw)
        m = _INLINE.match(line)
        if m:
            key = None
            items = [x.strip().strip("\"'") for x in m.group(2).split(",")]
            out[m.group(1)] = [x for x in items if x]
            continue
        m = _BLOCK_KEY.match(line)
        if m:
            key = m.group(1)
            continue
        if key:
            m = _BLOCK_ITEM.match(line)
            if m:
                out[key].append(m.group(1).strip().strip("\"'"))
                continue
            # 块状列表在遇到下一个顶格字段时结束
            if line and not line[0].isspace():
                key = None
    return out


def decision_type(fm_lines):
    """取 frontmatter 的 type 值；取不到返回空串。"""
    for line in fm_lines:
        m = _TYPE.match(line)
        if m:
            return m.group(1)
    return ""


def main():
    """可显式缩小到受影响项目；仍核对该项目全部声明及目标，保留原无参全量入口。"""
    parser = argparse.ArgumentParser(description="只读检查 ADR 的 corrects/supersedes 关系")
    parser.add_argument("vault", nargs="?", default=os.getcwd())
    parser.add_argument("--project", help="只检查受影响项目，仍解析同项目的全部目标")
    args = parser.parse_args()
    vault = args.vault
    projects_dir = os.path.join(vault, "10-projects")
    if args.project and not os.path.isdir(os.path.join(projects_dir, args.project, "decisions")):
        print("指定项目的 decisions 目录不存在", file=sys.stderr)
        return 1
    if not os.path.isdir(projects_dir):
        print(f"  未找到 {projects_dir}，跳过")
        return 0

    fail = 0
    # corrected[project][slug] = [声明更正它的 slug, ...]，用于最后的汇总输出
    corrected = {}

    for project in sorted(os.listdir(projects_dir)):
        if args.project and project != args.project:
            continue
        ddir = os.path.join(projects_dir, project, "decisions")
        if not os.path.isdir(ddir):
            continue
        slugs = {f[:-3] for f in os.listdir(ddir) if f.endswith(".md")}

        for fname in sorted(os.listdir(ddir)):
            if not fname.endswith(".md"):
                continue
            path = os.path.join(ddir, fname)
            fm = read_frontmatter(path)
            if not fm or decision_type(fm) != "decision":
                continue
            me = fname[:-3]
            links = parse_links(fm)

            both = set(links["corrects"]) & set(links["supersedes"])
            for slug in sorted(both):
                print(f"  ❌ {project}/{fname}: `{slug}` 同时列在 corrects 与 supersedes"
                      f"（部分更正与整体取代互斥，二选一）")
                fail = 1

            for field in ("corrects", "supersedes"):
                for slug in links[field]:
                    if slug == me:
                        print(f"  ❌ {project}/{fname}: {field} 指向自身")
                        fail = 1
                        continue
                    if slug not in slugs:
                        print(f"  ❌ {project}/{fname}: {field} 指向的 `{slug}` "
                              f"在 {project}/decisions/ 下不存在（拼错会导致失效关系静默失联）")
                        fail = 1
                        continue
                    corrected.setdefault(project, {}).setdefault(slug, []).append(
                        f"{me}({'取代' if field == 'supersedes' else '更正'})")

    if corrected:
        print("  —— 已被声明更正/取代的 ADR ——")
        for project in sorted(corrected):
            for slug in sorted(corrected[project]):
                who = "、".join(corrected[project][slug])
                print(f"  · {project}/{slug} ← {who}")
    else:
        print("  （当前没有任何 ADR 声明 corrects/supersedes）")

    return fail


if __name__ == "__main__":
    sys.exit(main())
