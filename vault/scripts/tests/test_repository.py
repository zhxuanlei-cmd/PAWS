import json
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paws_repository as r


class RepositoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='paws-repo-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.device_env = patch.dict(os.environ, {'PAWS_DEVICE_CONFIG': str(self.root / 'no-device.json')})
        self.device_env.start()
        self.addCleanup(self.device_env.stop)
        self.vault = self.root / 'vault'
        self.repo = self.root / '代码 repo'
        self.repo.mkdir()
        p = self.vault / '10-projects/demo'
        p.mkdir(parents=True)
        (p / 'AGENTS.md').write_text('- `code_repo`： `' + str(self.repo) + '`\n')
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        (self.repo / 'tracked').write_text('base')
        self.git('add', 'tracked')
        self.git('commit', '-qm', 'fixture')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True).strip()

    def test_worktree_and_detached(self):
        wt = self.root / 'worktree'
        self.git('worktree', 'add', '-q', '--detach', str(wt))
        (wt / 'tracked').write_text('changed')
        state = r.repo_state(wt)
        self.assertEqual(state['dirty'], 1)
        self.assertEqual(state['head_state'], 'detached')
        self.assertIsNone(state['unpushed'])
        match = r.resolve_project(self.vault, wt)
        self.assertEqual(match['project'], 'demo')
        self.assertEqual(match['matchedBy'], 'git-common-dir')
        self.assertEqual(match['checkout'], str(wt))

    def test_unknown_is_not_zero_and_upstream_is_measured(self):
        self.assertIsNone(r.repo_state(self.repo)['unpushed'])
        missing = r.repo_state(self.root / 'missing')
        self.assertEqual(missing['state'], 'missing')
        self.assertIsNone(missing['dirty'])
        self.assertEqual(r.repo_state(self.root)['state'], 'not-repository')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.git('config', 'remote.origin.url', str(self.root / 'origin.git'))
        self.git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
        branch = self.git('branch', '--show-current')
        self.git('config', 'branch.' + branch + '.remote', 'origin')
        self.git('config', 'branch.' + branch + '.merge', 'refs/heads/main')
        self.assertEqual(r.repo_state(self.repo)['unpushed'], 0)

    def test_ambiguous_identity_fails_closed(self):
        p = self.vault / '10-projects/other'
        p.mkdir()
        (p / 'AGENTS.md').write_text('code_repo: ' + str(self.repo))
        with self.assertRaises(r.ResolutionError):
            r.resolve_project(self.vault, self.repo)

    def test_device_override_and_literal_path(self):
        device = self.root / 'device.json'
        device.write_text(json.dumps({'schema_version': 1, 'managed_by': 'paws_setup', 'repositories': {'demo': str(self.repo)}}))
        self.assertEqual(r.code_repo(self.vault, 'demo', device=device), self.repo)
        with self.assertRaises(r.ResolutionError):
            r.resolve_project(self.vault, self.root / 'missing')
        self.assertIsNone(r.parse_path('$(touch /tmp/never)', self.root))

    def test_worktree_git_failures_are_errors_not_unregistered(self):
        wt = self.root / 'worktree'
        self.git('worktree', 'add', '-q', '--detach', str(wt))
        run = subprocess.run
        failures = [OSError('git unavailable'), subprocess.TimeoutExpired('git', 10),
                    subprocess.CompletedProcess([], 128, '', 'fatal: detected dubious ownership')]
        for failure in failures:
            def failed_discovery(command, *args, **kwargs):
                if str(wt) in command and '--git-common-dir' in command:
                    if isinstance(failure, Exception):
                        raise failure
                    return failure
                return run(command, *args, **kwargs)
            with self.subTest(failure=type(failure).__name__), patch.object(r.subprocess, 'run', side_effect=failed_discovery):
                output = io.StringIO()
                with patch.object(sys, 'argv', ['paws_repository.py', '--vault', str(self.vault), '--cwd', str(wt)]), contextlib.redirect_stdout(output):
                    result = r.main()
                self.assertEqual(result, 2)
                self.assertIn('error', json.loads(output.getvalue()))

    def register_broken_repository(self):
        repo = self.root / 'unrelated-broken-repository'
        repo.mkdir()
        (repo / '.git').write_text('gitdir: /missing/paws-test-git-dir\n')
        project = self.vault / '10-projects/aaa-broken'
        project.mkdir()
        (project / 'AGENTS.md').write_text('code_repo: ' + str(repo))
        return repo

    def test_unrelated_broken_repository_does_not_block_known_checkouts(self):
        self.register_broken_repository()
        wt = self.root / 'worktree'
        self.git('worktree', 'add', '-q', '--detach', str(wt))
        for cwd, matched_by in ((self.repo, 'path'), (wt, 'git-common-dir')):
            with self.subTest(cwd=cwd):
                match = r.resolve_project(self.vault, cwd)
                self.assertEqual(match['project'], 'demo')
                self.assertEqual(match['matchedBy'], matched_by)
                self.assertEqual(match['checkout'], str(cwd))
                self.assertEqual([item['project'] for item in match['warnings']], ['aaa-broken'])
                self.assertNotIn('/missing/paws-test-git-dir', json.dumps(match['warnings']))

    def test_unrelated_git_errors_do_not_hide_ambiguity(self):
        self.register_broken_repository()
        other = self.vault / '10-projects/other'
        other.mkdir()
        (other / 'AGENTS.md').write_text('code_repo: ' + str(self.repo))
        with self.assertRaises(r.ResolutionError) as raised:
            r.resolve_project(self.vault, self.repo)
        self.assertIn('multiple PAWS projects', str(raised.exception))
        self.assertEqual(raised.exception.projects, ['demo', 'other'])

    def test_unregistered_checkout_remains_unresolved_with_unreadable_candidates(self):
        self.register_broken_repository()
        (self.vault / '10-projects/demo/AGENTS.md').unlink()
        unrelated = self.root / 'unregistered'
        unrelated.mkdir()
        subprocess.check_call(['git', '-C', str(unrelated), 'init', '-q'])
        with self.assertRaises(r.GitReadError) as raised:
            r.resolve_project(self.vault, unrelated)
        self.assertEqual(raised.exception.projects, ['aaa-broken'])

    def test_related_repository_git_error_cannot_be_skipped(self):
        child = self.repo / 'ordinary-directory'
        child.mkdir()
        run = subprocess.run
        def failed_parent(command, *args, **kwargs):
            if str(self.repo) in command and '--git-common-dir' in command:
                return subprocess.CompletedProcess(command, 128, '', 'fatal: private diagnostic must not escape')
            return run(command, *args, **kwargs)
        with patch.object(r.subprocess, 'run', side_effect=failed_parent):
            with self.assertRaises(r.GitReadError) as raised:
                r.resolve_project(self.vault, child)
        self.assertEqual(raised.exception.projects, ['demo'])
        self.assertNotIn('private diagnostic', str(raised.exception))

    def test_current_broken_repository_remains_an_error(self):
        broken = self.register_broken_repository()
        with self.assertRaises(r.GitReadError):
            r.resolve_project(self.vault, broken)

    def test_independent_nested_repository_is_a_conflict(self):
        self.register_broken_repository()
        nested = self.repo / 'other-repository'
        nested.mkdir()
        subprocess.check_call(['git', '-C', str(nested), 'init', '-q'])
        with self.assertRaises(r.ResolutionError) as raised:
            r.resolve_project(self.vault, nested)
        self.assertIn('independent nested repository', str(raised.exception))
        self.assertEqual(raised.exception.projects, ['demo'])

    def test_normal_subdirectory_and_non_git_project_remain_supported(self):
        child = self.repo / 'ordinary-directory'
        child.mkdir()
        self.assertEqual(r.resolve_project(self.vault, child)['checkout'], str(self.repo))
        materials = self.root / 'materials'
        materials.mkdir()
        (self.vault / '10-projects/demo/AGENTS.md').write_text('code_repo: ' + str(materials))
        self.assertEqual(r.resolve_project(self.vault, materials)['project'], 'demo')
        self.assertEqual(r.repo_state(materials)['state'], 'not-repository')
        self.assertIsNone(r.resolve_project(self.vault, self.root))

    def test_unborn_repository_remains_distinct_from_unreadable_head(self):
        unborn = self.root / 'unborn'
        unborn.mkdir()
        subprocess.check_call(['git', '-C', str(unborn), 'init', '-q'])
        self.assertEqual(r.repo_state(unborn)['head_state'], 'unborn')
        run = subprocess.run
        def fail_head(command, *args, **kwargs):
            if '--verify' in command and command[-1] == 'HEAD':
                return subprocess.CompletedProcess(command, 128, '', 'fatal: permission denied')
            return run(command, *args, **kwargs)
        with patch.object(r.subprocess, 'run', side_effect=fail_head):
            state = r.repo_state(self.repo)
        self.assertEqual(state['state'], 'unreadable')
        self.assertEqual(state['head_state'], 'unknown')
        self.assertIsNone(state['head'])

    def test_unreadable_upstream_is_not_no_upstream(self):
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.git('config', 'remote.origin.url', str(self.root / 'origin.git'))
        self.git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
        branch = self.git('branch', '--show-current')
        self.git('config', 'branch.' + branch + '.remote', 'origin')
        self.git('config', 'branch.' + branch + '.merge', 'refs/heads/main')
        self.assertEqual(r.repo_state(self.repo)['upstream_state'], 'tracked')
        run = subprocess.run
        def fail_upstream(command, *args, **kwargs):
            if '@{u}' in command or 'for-each-ref' in command:
                return subprocess.CompletedProcess(command, 128, '', 'fatal: permission denied')
            return run(command, *args, **kwargs)
        with patch.object(r.subprocess, 'run', side_effect=fail_upstream):
            state = r.repo_state(self.repo)
        self.assertEqual(state['upstream_state'], 'unreadable')
        self.assertIsNone(state['unpushed'])

    def test_invalid_upstream_counts_are_unreadable(self):
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.git('config', 'remote.origin.url', str(self.root / 'origin.git'))
        self.git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
        branch = self.git('branch', '--show-current')
        self.git('config', 'branch.' + branch + '.remote', 'origin')
        self.git('config', 'branch.' + branch + '.merge', 'refs/heads/main')
        run = subprocess.run
        def invalid_counts(command, *args, **kwargs):
            if 'rev-list' in command and '--count' in command:
                return subprocess.CompletedProcess(command, 0, 'not-a-count\n', '')
            return run(command, *args, **kwargs)
        with patch.object(r.subprocess, 'run', side_effect=invalid_counts):
            state = r.repo_state(self.repo)
        self.assertEqual(state['state'], 'unreadable')
        self.assertEqual(state['upstream_state'], 'unreadable')
        self.assertIsNone(state['behind'])
        self.assertIsNone(state['unpushed'])


if __name__ == '__main__':
    unittest.main()
