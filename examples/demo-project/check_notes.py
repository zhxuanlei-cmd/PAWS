"""示例 CLI。校验 UTF-8 Markdown 文件的第一条非空行是否为一级标题。"""

import argparse
from pathlib import Path
import sys


def main():
    """读取命令行文件参数。符合要求时返回 0，格式或读取失败时返回 1。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path, help="待检查的 Markdown 文件")
    path = parser.parse_args().file
    try:
        heading = next((line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()), "")
    except (OSError, UnicodeError) as error:
        print(f"无法读取 {path}: {error}", file=sys.stderr)
        return 1
    if not heading.startswith("# ") or not heading[2:].strip():
        print(f"缺少一级标题 {path}", file=sys.stderr)
        return 1
    print(f"OK {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
