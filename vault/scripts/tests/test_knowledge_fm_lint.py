"""用临时知识库验证 YAML 解析和门禁失效路径；不改写真实卡片。"""

from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT_DIR = Path(__file__).resolve().parents[1]
LINTER = SCRIPT_DIR / "knowledge_fm_lint.py"
WIKI = """---
type: wiki
project: ""
status: active
created: 2026-09-07
updated: "2026-09-07"
tags: [示例]
source: "项目: 设计文档"
domain: 工程
subdomain: 测试
projects: [example]
draft: true
---
# 示例
"""


class KnowledgeFrontmatterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="paws-knowledge-fm-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.wiki = self.root / "30-resources/wiki/示例.md"
        self.insight = self.root / "20-areas/insights/示例断言.md"
        for path in (self.wiki, self.insight):
            path.parent.mkdir(parents=True)
        self.wiki.write_text(WIKI, encoding="utf-8")
        self.insight.write_text(WIKI.replace("type: wiki", "type: insight"), encoding="utf-8")

    def run_lint(self, *python_flags):
        return subprocess.run(
            [sys.executable, *python_flags, str(LINTER), "--vault", str(self.root)],
            text=True, capture_output=True,
        )

    def replace_wiki(self, old, new):
        self.wiki.write_text(WIKI.replace(old, new), encoding="utf-8")

    def assert_failure(self, diagnostic):
        result = self.run_lint()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(diagnostic, result.stderr)

    def test_quoted_colon_and_nested_yaml_pass(self):
        self.replace_wiki("draft: true", "draft: true\nextra:\n  provenance:\n    - kind: local\n      detail: '工程: 测试'\n  options: {strict: true}")
        result = self.run_lint()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("检查 2 张，发现 0 个问题", result.stdout)

    def test_unquoted_colon_fails_with_file_and_line(self):
        self.replace_wiki('source: "项目: 设计文档"', "source: 示例: docs/example.md")
        self.assert_failure("YAML 错误（第 8 行")

    def test_duplicate_key_is_not_silently_overwritten(self):
        self.replace_wiki("status: active", "status: active\nstatus: archived")
        self.assert_failure("重复的 YAML 字段")

    def test_duplicate_nested_key_is_rejected(self):
        self.replace_wiki("draft: true", "extra: {status: active, status: archived}")
        self.assert_failure("重复的 YAML 字段")

    def test_required_field_and_wrong_list_type_fail(self):
        self.replace_wiki("domain: 工程\n", "")
        self.assert_failure("domain 字段必填")
        self.replace_wiki("projects: [example]", "projects: example")
        self.assert_failure("projects 必须是文本列表")

    def test_unclassified_domain_can_be_empty_but_not_omitted(self):
        for empty_domain in ('domain: ""', "domain:"):
            with self.subTest(domain=empty_domain):
                self.replace_wiki("domain: 工程", empty_domain)
                result = self.run_lint()
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_knowledge_draft_is_optional_and_boolean_when_present(self):
        for draft in ("draft: true", "draft: false", ""):
            with self.subTest(draft=draft):
                self.replace_wiki("draft: true", draft)
                result = self.run_lint()
                self.assertEqual(result.returncode, 0, result.stderr)
        for draft in ("draft: auto", "draft: null", 'draft: "true"', "draft: 1"):
            with self.subTest(draft=draft):
                self.replace_wiki("draft: true", draft)
                self.assert_failure("知识卡 draft 若存在必须是布尔值")

    def test_wrong_state_type_and_invalid_date_fail(self):
        self.replace_wiki("status: active", "status: [active]")
        self.assert_failure("status 缺失或不在允许值内")
        self.replace_wiki('updated: "2026-09-07"', 'updated: "2026-02-30"')
        self.assert_failure("updated 必须是 YYYY-MM-DD 日期")

    def test_mapping_and_complete_delimiters_are_required(self):
        for text, diagnostic in (
            ("---\n- value\n---\n", "frontmatter 必须是字段映射"),
            ("# No metadata\n", "缺少开头"),
            ("---\ntype: wiki\n", "缺少结束"),
        ):
            with self.subTest(text=text):
                self.wiki.write_text(text, encoding="utf-8")
                self.assert_failure(diagnostic)

    def test_yaml_merge_is_accepted_but_explicit_duplicates_are_not(self):
        self.replace_wiki("draft: true", "defaults: &defaults {a: 1}\nextra: {<<: *defaults, a: 2}")
        result = self.run_lint()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_empty_scan_directory_allowed_but_missing_directory_fails(self):
        self.insight.unlink()
        empty = self.run_lint()
        self.assertEqual(empty.returncode, 0, empty.stderr)
        self.insight.parent.rmdir()
        self.assert_failure("扫描目录不存在")

    def test_missing_yaml_dependency_fails_explicitly(self):
        # -S 不加载 site-packages，模拟依赖未安装；不依赖本机第二套 Python。
        result = self.run_lint("-S")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("门禁未执行: 缺少 PyYAML", result.stderr)

    def test_shell_gate_propagates_failure_with_selected_interpreter(self):
        (self.root / "scripts").mkdir()
        # 全量入口已包含 ADR 门禁，夹具必须提供真实依赖。
        for name in ("fm_lint.sh", "knowledge_fm_lint.py", "decision_link_lint.py"):
            shutil.copyfile(SCRIPT_DIR / name, self.root / "scripts" / name)
        for directory in ("10-projects", "memory", "daily", "00-inbox"):
            (self.root / directory).mkdir()
        # 本测试只验证新门禁在原入口中的接线；隔离不相关的 Ontology CLI。
        binary_dir = self.root / "bin"
        binary_dir.mkdir()
        stub = binary_dir / "paws"
        stub.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        stub.chmod(0o755)
        env = dict(os.environ, PAWS_PYTHON=sys.executable, PAWS_BIN=str(stub), PATH=str(binary_dir) + os.pathsep + os.environ["PATH"])
        command = ["bash", str(self.root / "scripts/fm_lint.sh")]
        good = subprocess.run(command, env=env, text=True, capture_output=True)
        self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
        self.replace_wiki('source: "项目: 设计文档"', "source: 示例: docs/example.md")
        bad = subprocess.run(command, env=env, text=True, capture_output=True)
        self.assertEqual(bad.returncode, 1, bad.stdout + bad.stderr)
        self.assertIn("YAML 错误", bad.stderr)
        env["PAWS_PYTHON"] = str(self.root / "unavailable-python")
        missing = subprocess.run(command, env=env, text=True, capture_output=True)
        self.assertEqual(missing.returncode, 1)


if __name__ == "__main__":
    unittest.main()
