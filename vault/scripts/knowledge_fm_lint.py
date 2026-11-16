#!/usr/bin/env python3
"""只读校验共享 wiki/insight 的 YAML 与检索字段。

依赖 Python 3 + PyYAML（python3 -m pip install PyYAML）。
可直接由已有解释器运行，或用 PAWS_PYTHON=/path/to/python3 ./scripts/fm_lint.sh。
不扫描项目历史，不改写卡片，不触发任何 PAWS 工作流。
"""

import argparse
from datetime import date
from pathlib import Path
import sys


KNOWLEDGE_DIRS = {"30-resources/wiki": "wiki", "20-areas/insights": "insight"}
STATES = {"active", "paused", "done", "archived", "draft"}


def yaml_loader():
    try:
        import yaml
    except ImportError:
        raise RuntimeError(
            "缺少 PyYAML；请为所选 Python 安装 PyYAML，或用 PAWS_PYTHON 指定已具备此依赖的解释器"
        ) from None

    class UniqueSafeLoader(yaml.SafeLoader):
        def construct_mapping(self, node, deep=False):
            seen = set()
            for key_node, _ in node.value:
                # YAML 合并键允许继承默认值后显式覆盖；重复的实际字段仍报错。
                if key_node.tag == "tag:yaml.org,2002:merge":
                    continue
                key = self.construct_object(key_node, deep=deep)
                try:
                    if key in seen:
                        raise yaml.constructor.ConstructorError(
                            None, None, "重复的 YAML 字段", key_node.start_mark
                        )
                    seen.add(key)
                except TypeError:
                    raise yaml.constructor.ConstructorError(
                        None, None, "YAML 映射键必须可哈希", key_node.start_mark
                    ) from None
            return super().construct_mapping(node, deep=deep)

    return yaml, UniqueSafeLoader


def parse_frontmatter(path, yaml, loader):
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("缺少开头的 frontmatter 分隔线")
    try:
        end = lines.index("---", 1)
    except ValueError:
        raise ValueError("frontmatter 缺少结束分隔线") from None
    try:
        data = yaml.load("\n".join(lines[1:end]), Loader=loader)
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        position = f"（第 {mark.line + 2} 行，第 {mark.column + 1} 列）" if mark else ""
        problem = getattr(error, "problem", None) or "解析失败"
        raise ValueError(f"YAML 错误{position}: {problem}") from None
    if not isinstance(data, dict):
        raise ValueError("frontmatter 必须是字段映射")
    return data


def field_errors(data, expected_type):
    errors = []
    if data.get("type") != expected_type:
        errors.append(f"type 必须为 {expected_type}")
    if not isinstance(data.get("status"), str) or data["status"] not in STATES:
        errors.append("status 缺失或不在允许值内")
    if "project" not in data or data["project"] not in (None, ""):
        errors.append("共享卡 project 必须留空，关联项目写入 projects")
    # 总索引允许未成域的卡暂留空 domain，字段仍需存在才能供统一检索。
    if "domain" not in data or (data["domain"] is not None and not isinstance(data["domain"], str)):
        errors.append("domain 字段必填，须为文本或留空（未成域）")
    for field in ("source", "subdomain"):
        if not isinstance(data.get(field), str) or not data[field].strip():
            errors.append(f"{field} 必须是非空文本")
    for field in ("projects", "tags"):
        value = data.get(field)
        if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
            errors.append(f"{field} 必须是文本列表（可为空列表）")
    for field in ("created", "updated"):
        value = data.get(field)
        try:
            if type(value) is not date:
                if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
                    raise ValueError()
        except ValueError:
            errors.append(f"{field} 必须是 YYYY-MM-DD 日期")
    if "draft" in data and type(data["draft"]) is not bool:
        errors.append("知识卡 draft 若存在必须是布尔值，不能使用记录类的 auto")
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--vault", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        yaml, loader = yaml_loader()
    except RuntimeError as error:
        print(f"知识卡门禁未执行: {error}", file=sys.stderr)
        return 2
    checked = 0
    errors = []
    for relative, expected_type in KNOWLEDGE_DIRS.items():
        directory = args.vault / relative
        if not directory.is_dir():
            errors.append(f"扫描目录不存在: {directory}")
            continue
        paths = sorted(directory.glob("*.md"))
        # 新建 Vault 可以没有知识卡；目录缺失仍会报告扫描范围不完整。
        for path in paths:
            checked += 1
            try:
                data = parse_frontmatter(path, yaml, loader)
                errors.extend(f"{path}: {error}" for error in field_errors(data, expected_type))
            except (OSError, UnicodeError, ValueError) as error:
                errors.append(f"{path}: {error}")
    for error in errors:
        print(f"  {error}", file=sys.stderr)
    print(f"知识卡 YAML 门禁: 检查 {checked} 张，发现 {len(errors)} 个问题")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
