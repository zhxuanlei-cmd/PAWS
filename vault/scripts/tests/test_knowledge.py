import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paws_knowledge as k

ROOT = Path(__file__).resolve().parents[2]


class KnowledgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='paws-knowledge-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.vault = self.root / 'vault'
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {'PAWS_STATE_DIR': str(self.root / 'state')}).start()
        self.logs = self.vault / '10-projects/demo/worklog'
        self.logs.mkdir(parents=True)
        common = dict(type='worklog', project='demo', status='active', source_kind='local-project', draft='auto')
        (self.logs / 'evidence.md').write_text(k.markdown(common, '# 证据\n不同 session 不应相互抑制。\n'))
        self.evidence = '10-projects/demo/worklog/evidence.md'
        self.milestone = self.logs / 'milestone.md'
        self.milestone.write_text(k.markdown(dict(common, milestone_id='fixture', milestone_status='done', summary='会话去重以身份和游标为依据。', evidence=[self.evidence]), '# 里程碑\n'))
        (self.vault / 'scripts').mkdir()
        manifest = json.loads((ROOT / 'paws.manifest.json').read_text())
        # 沿用真实三端 target_roots 和 setup 流程，其他入口不是本夹具的测试对象。
        manifest['global_instructions'] = {'source': 'AGENTS.md', 'targets': []}
        manifest['commands'], manifest['adapters'], manifest['skills']['names'] = [], [], []
        (self.vault / 'paws.manifest.json').write_text(json.dumps(manifest))
        self.ident = k.scan(self.vault, 'demo')['created'][0]
        self.folder = self.vault / 'memory/agent/candidates' / self.ident
        self.skill = self.folder / 'skill'
        self.skill.mkdir(parents=True)
        (self.skill / 'SKILL.md').write_text('---\nname: paws-fixture-continuation\ndescription: 检查多个会话的独立接续记录时使用。\n---\n# 核验会话\n读取身份与游标；遇到相同时间但不同 session，保留两条记录。\n')
        review = dict(type='guide', scope='会话接续', counterexample='不同消息仍需新记一条', validation='事件集成测试', duplicate_check='既有接续 skill 未含夹具专用行为')
        (self.folder / 'review.md').write_text(k.markdown(review, '# 审阅\n夹具，不是真实知识批准。\n'))

    def approval(self, digest):
        target = self.vault / 'memory/agent/approvals/fixture-approval.md'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(k.markdown(dict(type='decision', decision='approve', source='user-approval', approved_by='synthetic-fixture', approval_ref='test-only-not-a-real-approval', approved_digest=digest), '# 模拟人工授权\n'))
        return target

    def test_dedup_and_external_source_rejection(self):
        self.assertEqual(k.scan(self.vault, 'demo')['created'], [])
        with (self.logs / 'evidence.md').open('a') as f:
            f.write('https://external.example.invalid\n')
        result = k.scan(self.vault, 'demo')
        self.assertEqual(len(result['rejected']), 1)
        self.assertEqual(result['created'], [])
        with self.assertRaises(ValueError):
            k.prepare(self.vault, self.ident)

    def test_approval_binding_stale_changes_and_canonical_no_overwrite(self):
        package = k.prepare(self.vault, self.ident)
        approval = self.approval(package['digest'])
        with (self.skill / 'SKILL.md').open('a') as f:
            f.write('\n改变了待审阅行为。\n')
        with self.assertRaises(ValueError):
            k.publish(self.vault, self.ident, approval)
        self.assertEqual(json.loads((self.vault / 'paws.manifest.json').read_text())['skills']['names'], [])
        package = k.prepare(self.vault, self.ident)
        result = k.publish(self.vault, self.ident, self.approval(package['digest']))
        self.assertTrue(result['changed'])
        self.assertFalse(k.publish(self.vault, self.ident, self.approval(package['digest']))['changed'])
        canonical = self.vault / 'scripts/skills' / package['name'] / 'SKILL.md'
        canonical.write_text('existing WIP')
        with self.assertRaises(ValueError):
            k.publish(self.vault, self.ident, self.approval(package['digest']))
        self.assertEqual(canonical.read_text(), 'existing WIP')

    def test_symlink_bundle_rejected(self):
        (self.skill / 'outside').symlink_to(self.root)
        with self.assertRaises(ValueError):
            k.prepare(self.vault, self.ident)

    def test_missing_approval_and_foreign_project_record_do_not_publish(self):
        # 构造无有效批准和项目归属不符的输入，两种情况都应明确拒绝。
        package = k.prepare(self.vault, self.ident)
        approval = self.approval(package['digest'])
        approval.write_text(approval.read_text().replace('decision: approve', 'decision: pending'))
        with self.assertRaises(ValueError):
            k.publish(self.vault, self.ident, approval)
        self.assertEqual(json.loads((self.vault / 'paws.manifest.json').read_text())['skills']['names'], [])
        self.milestone.write_text(self.milestone.read_text().replace('project: demo', 'project: other'))
        self.assertEqual(len(k.scan(self.vault, 'demo')['rejected']), 1)

    def test_publication_rolls_back_when_manifest_write_fails(self):
        package = k.prepare(self.vault, self.ident)
        approval = self.approval(package['digest'])
        manifest = self.vault / 'paws.manifest.json'
        before = manifest.read_bytes()
        with patch.object(k, 'atomic', side_effect=OSError('fixture write failure')):
            with self.assertRaises(OSError):
                k.publish(self.vault, self.ident, approval)
        self.assertEqual(manifest.read_bytes(), before)
        self.assertFalse((self.vault / 'scripts/skills' / package['name']).exists())

    def test_publish_register_install_and_three_tool_discovery(self):
        package = k.prepare(self.vault, self.ident)
        k.publish(self.vault, self.ident, self.approval(package['digest']))
        home = self.root / 'new-device'
        # 依次安装三个所测宿主。知识发布夹具不包含 Hermes 配置和薄入口。
        hosts = {
            'codex': '.agents/skills',
            'opencode': '.config/opencode/skills',
            'claude': '.claude/skills',
        }
        for host, relative in hosts.items():
            out = subprocess.check_output(
                ['node', str(ROOT / 'scripts/paws_setup.mjs'), 'apply', '--host', host,
                 '--vault', str(self.vault), '--home', str(home)], text=True)
            self.assertTrue(json.loads(out)['changed'])
            entry = home / relative / package['name']
            self.assertTrue(entry.is_symlink())
            self.assertEqual((entry / 'SKILL.md').read_bytes(), (self.skill / 'SKILL.md').read_bytes())
        # 在另一临时主目录从独立副本重建同源入口，无需旧会话。
        moved = self.root / 'moved-vault'
        shutil.copytree(self.vault, moved)
        second = self.root / 'second-device'
        subprocess.check_output(
            ['node', str(ROOT / 'scripts/paws_setup.mjs'), 'apply', '--host', 'codex',
             '--vault', str(moved), '--home', str(second)], text=True)
        self.assertEqual((second / '.agents/skills' / package['name'] / 'SKILL.md').read_bytes(),
                         (self.skill / 'SKILL.md').read_bytes())


if __name__ == '__main__':
    unittest.main()
