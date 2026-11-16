#!/usr/bin/env python3
"""fm_lint.sh 的只读范围检查实现；复用现有 YAML、知识卡、ADR 与严格对象门禁。"""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

from knowledge_fm_lint import KNOWLEDGE_DIRS, field_errors, parse_frontmatter, yaml_loader


def check_files(vault, files, types):
    """校验显式文件及其关系；返回退出码，不写入源文件或生成缓存。

    常规记录不依赖全库；ADR 扩到同项目，严格对象扩到完整图，知识/MOC 扩到覆盖检查。
    文件删除或迁移后应运行全量门禁，不能用不存在的路径静默缩小验证范围。
    """
    yaml, loader = yaml_loader()
    failures, checked, decisions = [], [], set()
    strict = knowledge = False
    for raw in dict.fromkeys(files):
        path = (vault / raw).resolve()
        try:
            relative = path.relative_to(vault)
            if not path.is_file() or path.suffix != ".md":
                raise ValueError("必须指定存在的 Markdown 文件；删除/迁移后请运行全量检查")
            # 指令不是内容对象；00-inbox 的捕获零门槛继续生效。
            if path.name in {"AGENTS.md", "CLAUDE.md"} or relative.parts[0] == "00-inbox":
                continue
            data = parse_frontmatter(path, yaml, loader)
            kind = data.get("type")
            if kind not in types:
                raise ValueError("type 缺失或不在白名单内")
            if relative.parts[0] == "10-projects" and "project" not in data:
                raise ValueError("项目内容缺少 project 字段")
            for directory, expected in KNOWLEDGE_DIRS.items():
                if path.is_relative_to(vault / directory):
                    failures.extend(f"{relative}: {error}" for error in field_errors(data, expected))
                    knowledge = True
            knowledge |= kind == "moc"
            strict |= kind in {"task", "evidence", "repository", "policy"}
            if kind == "decision" and len(relative.parts) >= 4 and relative.parts[0] == "10-projects":
                decisions.add(relative.parts[1])
            checked.append(str(relative))
        except (OSError, UnicodeError, ValueError, TypeError) as error:
            failures.append(f"{raw}: {error}")
    for failure in failures:
        print(failure, file=sys.stderr)
    print(f"范围 frontmatter: 已检查 {len(checked)} 个内容文件，发现 {len(failures)} 个问题")
    if failures:
        return 1
    commands = []
    for project in sorted(decisions):
        commands.append([sys.executable, str(vault / "scripts/decision_link_lint.py"), str(vault), "--project", project])
    if strict:
        # 严格对象含跨文件引用，不把单文件 schema 通过冒充完整图有效。
        bundled = vault.parent / "engine/dist/src/cli.js"
        paws = os.environ.get("PAWS_BIN")
        if paws:
            engine = [paws]
        elif bundled.is_file():
            engine = ["node", str(bundled)]
        elif shutil.which("paws"):
            engine = ["paws"]
        else:
            print("严格对象门禁未执行：找不到 paws CLI", file=sys.stderr)
            return 2
        commands.append([*engine, "lint", "--vault", str(vault), "--mode", "compatibility"])
    if knowledge:
        commands.append(["bash", str(vault / "scripts/check_moc_coverage.sh")])
    results = [subprocess.run(command, cwd=vault, check=False).returncode for command in commands]
    return 1 if any(results) else 0


def main():
    """仅接受来自 fm_lint.sh 的类型清单与显式文件；不自动从脏工作树推定授权范围。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--types", required=True)
    parser.add_argument("--files", nargs="+", required=True)
    args = parser.parse_args()
    try:
        return check_files(Path(__file__).resolve().parents[1], args.files, set(args.types.split("|")))
    except RuntimeError as error:
        print(f"范围检查未执行: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
