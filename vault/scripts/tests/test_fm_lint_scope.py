"""范围门禁的正负例：相关文件通过、错误拒绝、跨文件关系扩展、无关历史不影响。"""

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1]


class ScopedLintTest(unittest.TestCase):
    """复制真实入口到临时 Vault，保证测试不写入真实项目和知识卡。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="paws-lint-scope-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "vault"
        (self.root / "scripts").mkdir(parents=True)
        for name in ("fm_lint.sh", "fm_lint_scope.py", "knowledge_fm_lint.py", "decision_link_lint.py", "check_moc_coverage.sh"):
            shutil.copy2(SCRIPTS / name, self.root / "scripts" / name)
        self.write("10-projects/demo/worklog/new.md", "---\ntype: worklog\nproject: demo\ndraft: auto\n---\n")
        self.write("10-projects/other/worklog/broken.md", "这份无关历史故意缺少 frontmatter\n")

    def write(self, name, body):
        """为合成输入准备父目录，不复用用户项目数据。"""
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")

    def run_lint(self, *files):
        """执行真实 Shell 到 Python 入口，继承 PyYAML 解释器且隔离宿主 Engine 配置。"""
        env = os.environ.copy()
        env.pop("PAWS_BIN", None)
        return subprocess.run(["bash", str(self.root / "scripts/fm_lint.sh"), "--files", *files],
                              cwd=self.root, text=True, capture_output=True, env=env)

    def test_record_scope_passes_without_reading_unrelated_broken_history(self):
        selected = "10-projects/demo/worklog/new.md"
        before = (self.root / selected).stat().st_mtime_ns
        result = self.run_lint(selected)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("已检查 1 个", result.stdout)
        self.assertEqual((self.root / selected).stat().st_mtime_ns, before)
        self.assertFalse((self.root / "scripts/__pycache__").exists())
        self.assertNotEqual(self.run_lint("10-projects/other/worklog/broken.md").returncode, 0)

    def test_yaml_missing_paths_and_outside_paths_fail(self):
        self.write("10-projects/demo/worklog/bad.md", "---\ntype: worklog\ntype: guide\nproject: demo\n---\n")
        for path in ("10-projects/demo/worklog/bad.md", "missing.md", str(SCRIPTS / "../AGENTS.md")):
            with self.subTest(path=path):
                self.assertNotEqual(self.run_lint(path).returncode, 0)
        self.assertNotEqual(self.run_lint().returncode, 0)

    def test_adr_checks_related_project_and_rejects_unresolved_target(self):
        path = "10-projects/demo/decisions/new.md"
        self.write(path, "---\ntype: decision\nproject: demo\ncorrects: [old]\n---\n")
        self.assertNotEqual(self.run_lint(path).returncode, 0)
        self.write("10-projects/demo/decisions/old.md", "---\ntype: decision\nproject: demo\n---\n")
        # 同项目的关系检查不能被别的项目既有错误拖成全库检查。
        self.write("10-projects/other/decisions/broken.md", "---\ntype: decision\nproject: other\ncorrects: [missing]\n---\n")
        result = self.run_lint(path)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("demo/old", result.stdout)
        self.assertNotIn("other", result.stdout)

    def test_knowledge_change_checks_moc_coverage(self):
        path = "30-resources/wiki/示例.md"
        self.write(path, "---\ntype: wiki\nproject: ''\nprojects: []\nstatus: active\ncreated: 2026-09-22\nupdated: 2026-09-22\ntags: []\nsource: 合成测试\ndomain: 工程\nsubdomain: 测试\ndraft: true\n---\n")
        (self.root / "20-areas/insights").mkdir(parents=True)
        result = self.run_lint(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("孤儿卡", result.stdout)
        self.write("30-resources/知识总索引.md", "---\ntype: moc\n---\n[[示例]]\n")
        self.assertEqual(self.run_lint(path).returncode, 0)

    def test_strict_object_checks_referenced_files_outside_selected_list(self):
        # 真实 CLI + G0 正例：仅选择 task，但仍必须带上未选中的 repo/policy 关系。
        engine = SCRIPTS.parent.parent / "engine"
        if not (engine / "dist/src/cli.js").is_file():
            self.skipTest("严格对象集成测试需要先构建同一检出的 Engine")
        # 采用发行目录结构，在临时 Vault 旁使用本次构建；与系统 PATH 上的 paws 隔离。
        (self.root.parent / "engine").symlink_to(engine, target_is_directory=True)
        self.write("AGENTS.md", "# 严格对象夹具\n")
        source = SCRIPTS.parent / "ontology"
        shutil.copytree(source / "schema", self.root / "ontology/schema")
        for fixture, target in (("positive/p01-task.md.in", "task.md"),
                                ("_shared/repository.md.in", "repository.md"),
                                ("_shared/policy.md.in", "policy.md")):
            self.write("10-projects/fixture-project/" + target,
                       (source / "fixtures" / fixture).read_text(encoding="utf-8"))
        selected = "10-projects/fixture-project/task.md"
        good = self.run_lint(selected)
        self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
        # 未选中的被引用对象消失后，仍必须失败，不能只检查 task 本身的字段。
        (self.root / "10-projects/fixture-project/repository.md").unlink()
        bad = self.run_lint(selected)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("E_LINK_TARGET_MISSING", bad.stdout + bad.stderr)


if __name__ == "__main__":
    unittest.main()
