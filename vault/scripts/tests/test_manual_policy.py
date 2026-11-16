import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('manual_policy', ROOT / 'scripts/paws_manual_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class ManualPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='paws-manual-policy-')
        self.home = Path(self.tmp.name) / 'home'

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, relative, value):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
        return path

    def test_runtime_allow_cannot_reenable_workflows_or_expand_other_permissions(self):
        config = {'enabled_providers': ['fixture'], 'permission': {'skill': {'paws-checkpoint': 'allow'}},
                  'agent': {'writer': {'permission': {'skill': {'paws-archive': 'allow', 'office': 'allow'},
                                                     'edit': 'ask'}},
                            'reviewer': {'disable': True, 'permission': 'deny'}}}
        names = json.loads((ROOT / 'paws.manifest.json').read_text())['manual_workflows']
        policy.restrict_config(config, names)
        for owner in [config, *config['agent'].values()]:
            for name in names:
                self.assertEqual(owner['permission']['skill'][name], 'deny')
        self.assertEqual(config['enabled_providers'], ['fixture'])
        self.assertEqual(config['agent']['writer']['permission']['skill']['office'], 'allow')
        self.assertEqual(config['agent']['writer']['permission']['edit'], 'ask')
        self.assertTrue(config['agent']['reviewer']['disable'])
        self.assertEqual(config['agent']['reviewer']['permission']['*'], 'deny')


    def test_runtime_write_repair_does_not_promote_readonly_or_disabled_roles(self):
        data = {'enabled_providers': ['fixture'], 'agent': {
            'paws-build': {'permission': {'edit': 'deny', 'bash': 'deny'}},
            'paws-plan': {'permission': {'edit': {'*': 'deny'}}},
            'paws-maintain': {'disable': True, 'permission': {'edit': {'*': 'deny'}, 'bash': 'deny'}}}}
        before = json.loads(json.dumps(data))
        policy.repair_workflow_contract(data, ROOT)
        self.assertEqual(data, before)

    def test_runtime_writer_and_material_scopes_preserve_sensitive_denies(self):
        from fnmatch import fnmatchcase
        data = {'agent': {
            'paws-build': {'permission': {'edit': {'*': 'allow', str(ROOT / '**'): 'deny'}, 'external_directory': {'*': 'deny', str(ROOT / '**'): 'allow'}}},
            'paws-maintain': {'permission': {'edit': {'*': 'deny', str(ROOT / '30-resources/wiki/*.md'): 'allow', str(ROOT / 'memory/agent/candidates/**'): 'allow'}, 'external_directory': {'*': 'deny', str(ROOT / '**'): 'allow'}, 'bash': 'deny'}}}}
        policy.repair_workflow_contract(data, ROOT)
        def allowed(role, relative):
            value = 'deny'
            for pattern, action in data['agent'][role]['permission']['edit'].items():
                if fnmatchcase(str(ROOT / relative), pattern):
                    value = action
            return value == 'allow'
        for relative in ['10-projects/demo/demo-主页.md', '10-projects/demo/spec.md', '10-projects/demo/HANDOFF.md']:
            self.assertTrue(allowed('paws-build', relative), relative)
        for relative in ['00-inbox/paper.md', '30-resources/literature/paper.md', '10-projects/demo/materials/brief.md']:
            self.assertTrue(allowed('paws-maintain', relative), relative)
        self.assertTrue(allowed('paws-maintain', 'memory/agent/candidates/demo/skill/SKILL.md'))
        for role in ['paws-build', 'paws-maintain']:
            for relative in ['AGENTS.md', 'scripts/skills/paws-reflect/SKILL.md', '10-projects/demo/凭据.md']:
                self.assertFalse(allowed(role, relative), (role, relative))
        for relative in ['00-inbox/AGENTS.md', '10-projects/demo/materials/SKILL.md', '30-resources/literature/credentials.md']:
            self.assertFalse(allowed('paws-maintain', relative), relative)

    def test_bootstrap_and_enabled_readonly_maintain_stay_readonly_in_vault(self):
        data = {'agent': {
            'paws-build': {'permission': {'edit': {'*': 'allow', str(ROOT / '**'): 'deny'},
                                         'external_directory': {'*': 'deny'}}},
            'paws-maintain': {'permission': {'edit': {'*': 'deny'},
                                            'external_directory': {'*': 'deny', str(ROOT / '**'): 'allow'}}}}}
        before = json.loads(json.dumps(data))
        policy.repair_workflow_contract(data, ROOT)
        self.assertEqual(data, before)

    def test_manual_denies_follow_existing_wildcard_skill_allows(self):
        from fnmatch import fnmatchcase
        data = {'permission': {'skill': {'paws-reflect': 'allow', 'paws-*': 'allow'}}}
        names = json.loads((ROOT / 'paws.manifest.json').read_text())['manual_workflows']
        policy.restrict_config(data, names)
        for name in names:
            matches = [v for k, v in data['permission']['skill'].items() if fnmatchcase(name, k)]
            self.assertEqual(matches[-1], 'deny')

    def test_write_repair_keeps_existing_local_denies_and_asks(self):
        from fnmatch import fnmatchcase
        data = {'agent': {'paws-maintain': {'permission': {
            'edit': {'*': 'deny', str(ROOT / '30-resources/wiki/*.md'): 'allow',
                     str(ROOT / '30-resources/literature/private.md'): 'deny',
                     str(ROOT / '00-inbox/review.md'): 'ask', '**/id_rsa*': 'deny'},
            'external_directory': {'*': 'deny', str(ROOT / '**'): 'allow'}}}}}
        policy.repair_workflow_contract(data, ROOT)
        for relative, expected in [('30-resources/literature/private.md', 'deny'),
                                   ('00-inbox/review.md', 'ask'), ('00-inbox/id_rsa.md', 'deny')]:
            rules = data['agent']['paws-maintain']['permission']['edit']
            matches = [v for k, v in rules.items() if fnmatchcase(str(ROOT / relative), k)]
            self.assertEqual(matches[-1], expected)
        first = json.dumps(data)
        policy.repair_workflow_contract(data, ROOT)
        self.assertEqual(json.dumps(data), first)

    def test_narrow_candidate_write_scope_is_preserved(self):
        from fnmatch import fnmatchcase
        data = {'agent': {'paws-maintain': {'permission': {
            'edit': {'*': 'deny', str(ROOT / '30-resources/wiki/*.md'): 'allow',
                     str(ROOT / 'memory/agent/candidates/check/**'): 'allow'},
            'external_directory': {'*': 'deny', str(ROOT / '**'): 'allow'}}}}}
        policy.repair_workflow_contract(data, ROOT)
        rules = data['agent']['paws-maintain']['permission']['edit']
        for candidate, expected in [('check', 'allow'), ('unrelated', 'deny')]:
            path = str(ROOT / 'memory/agent/candidates' / candidate / 'skill/SKILL.md')
            matches = [v for k, v in rules.items() if fnmatchcase(path, k)]
            self.assertEqual(matches[-1], expected)

class ManualInvocationTests(unittest.TestCase):
    """区分六工作流分类与全部手动 Skill，验证 CLI 最终权限而非仅检验字段存在。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='paws-manual-invocation-')
        self.base = Path(self.tmp.name).resolve()
        self.home = self.base / 'home'
        self.vault = self.base / 'vault'
        self.code = self.base / 'code'
        self.home.mkdir()
        self.code.mkdir()
        self.workflows = ['paws-project-continuation', 'paws-checkpoint', 'paws-inbox',
                          'paws-reflect', 'paws-harvest', 'paws-archive']
        self.manual = [*self.workflows, 'paws-project-consolidation']
        self.professional = ['paws-office-delivery', 'paws-ai-experiment']
        self.manifest = {'manual_workflows': self.workflows,
                         'manual_invocation_skills': self.manual,
                         'skills': {'source_root': 'scripts/skills',
                                    'names': [*self.manual, *self.professional]}}
        for name in self.manifest['skills']['names']:
            directory = self.vault / 'scripts/skills' / name
            directory.mkdir(parents=True)
            flag = 'disable-model-invocation: true\n' if name in self.manual else ''
            (directory / 'SKILL.md').write_text('---\nname: ' + name + '\n' + flag + '---\n合成正文\n')
        self.save_manifest()
        # 模拟 TS runtime 将已注册 Skill 全设 allow，以及原生后来合并的未知角色。
        rights = {'skill': {'*': 'deny', **{name: 'allow' for name in self.manifest['skills']['names']}},
                  'read': 'allow', 'edit': 'deny', 'bash': 'deny'}
        self.config = {'permission': rights, 'agent': {
            name: {'permission': json.loads(json.dumps(rights))}
            for name in ['paws-build', 'paws-plan', 'paws-maintain', 'paws-review',
                         'fixture-review-a', 'fixture-review-b', 'paws-explore',
                         'paws-scout', 'title', 'summary', 'compaction', 'local-review']}}
        self.active = self.home / '.config/opencode/opencode.json'
        self.active.parent.mkdir(parents=True)
        self.active.write_text(json.dumps(self.config))

    def tearDown(self):
        self.tmp.cleanup()

    def save_manifest(self):
        """只重写测试临时 manifest，不接触用户配置或业务文件。"""
        (self.vault / 'paws.manifest.json').write_text(json.dumps(self.manifest))

    def cli(self, command, payload=None):
        """运行不触发模型的配置命令；临时目录无 Git 时采用原生 worktree 根目录。"""
        import subprocess
        import sys
        args = [sys.executable, str(ROOT / 'scripts/paws_manual_policy.py'), command,
                '--vault', str(self.vault), '--home', str(self.home)]
        if command in ('overlay', 'finalize'):
            args += ['--cwd', str(self.code), '--config', str(self.active)]
        if command == 'finalize':
            args += ['--worktree', str(Path(self.code.anchor))]
        result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                                text=True, capture_output=True)
        return result, json.loads(result.stdout)

    def assert_manual_denied(self, result):
        """每个角色的手动加载均拒绝；原有专业能力和正文读取不受误伤。"""
        for owner in [result, *result['agent'].values()]:
            rights = owner['permission']
            for name in self.manual:
                matches = [action for pattern, action in policy.permission_map(rights['skill']).items()
                           if policy.native_match(name, pattern)]
                self.assertEqual(matches[-1], 'deny', name)
            for name in self.professional:
                self.assertEqual(rights['skill'][name], 'allow', name)
            reads = policy.permission_map(rights['read'])
            self.assertEqual(reads.get('*'), 'allow')

    def test_overlay_denies_consolidation_and_preserves_explicit_read(self):
        result, payload = self.cli('overlay', self.config)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assert_manual_denied(payload)

    def test_finalize_reasserts_manual_deny_after_native_role_merge(self):
        result, payload = self.cli('finalize', {'effective': self.config, 'overlay': self.config})
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assert_manual_denied(payload)

    def test_new_manifest_rejects_omitted_manual_skill(self):
        """Skill 正本声明手动却漏登记时明确失败，不能再次被通用 allow 悄悄放行。"""
        self.manifest['manual_invocation_skills'] = self.workflows
        self.save_manifest()
        result, payload = self.cli('overlay', self.config)
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertFalse(payload['ok'])
        self.assertIn('paws-project-consolidation', payload['error'])

    def test_new_manifest_rejects_invalid_manual_declarations(self):
        """拒绝重复、未注册条目与遗漏六工作流的声明，避免错误配置静默生效。"""
        for names in [self.manual[:-2] + ['paws-project-consolidation'],
                      self.manual + ['unknown-skill'], self.manual + [self.manual[0]], 'paws-*']:
            with self.subTest(names=names):
                self.manifest['manual_invocation_skills'] = names
                self.save_manifest()
                result, payload = self.cli('overlay', self.config)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertFalse(payload['ok'])

    def test_legacy_registered_skills_recover_all_manual_invocations(self):
        """旧 manifest 已注册 consolidate 时从正本补足门禁，不能降级成只保护六工作流。"""
        del self.manifest['manual_invocation_skills']
        self.save_manifest()
        for command, data in [('overlay', self.config),
                              ('finalize', {'effective': self.config, 'overlay': self.config})]:
            with self.subTest(command=command):
                result, payload = self.cli(command, data)
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assert_manual_denied(payload)

    def test_legacy_minimal_manifest_retains_original_workflow_compatibility(self):
        """未提供 Skill 注册元数据的最小旧夹具仍按原工作流清单工作。"""
        self.manifest = {'manual_workflows': self.workflows}
        self.save_manifest()
        result, payload = self.cli('overlay', self.config)
        self.assertEqual(result.returncode, 0, result.stdout)
        for name in self.workflows:
            self.assertEqual(payload['permission']['skill'][name], 'deny')
        self.assertEqual(payload['permission']['skill']['paws-office-delivery'], 'allow')


class RuntimeProjectionTests(unittest.TestCase):
    """按原生 worktree 相对路径验证允许、拒绝与配置失败，不读取真实用户文件。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='paws-edit-projection-')
        self.base = Path(self.tmp.name).resolve()
        self.vault = self.base / 'vault'
        self.vault.mkdir()
        self.code = self.base / 'code'
        self.code.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def action(self, rules, file, worktree):
        """复现原生仅有 * 与 ? 的最后匹配；文件路径先转 worktree 相对路径。"""
        import re
        relative = os.path.relpath(file, worktree)
        result = 'ask'
        for pattern, action in policy.permission_map(rules).items():
            regex = re.escape(pattern).replace(r'\*', '.*').replace(r'\?', '.')
            if re.fullmatch(regex, relative, flags=re.S):
                result = action
        return result

    def test_maintenance_knowledge_and_sensitive_denies_use_native_paths(self):
        rules = {'*': 'deny', str(self.vault / '30-resources/wiki/*.md'): 'allow',
                 str(self.vault / '30-resources/wiki/private.md'): 'ask',
                 str(self.vault / '**/AGENTS.md'): 'deny',
                 str(self.vault / '**/凭据.md'): 'deny'}
        # 旧绝对规则对原生相对请求不命中：合法知识写入错误落到默认 deny。
        self.assertEqual(self.action(rules, self.vault / '30-resources/wiki/card.md', self.vault), 'deny')
        projected = policy.project_edit_rules(rules, self.vault)
        for path, expected in [('30-resources/wiki/card.md', 'allow'),
                               ('30-resources/wiki/private.md', 'ask'),
                               ('30-resources/wiki/AGENTS.md', 'deny'),
                               ('30-resources/wiki/凭据.md', 'deny'), ('AGENTS.md', 'deny')]:
            self.assertEqual(self.action(projected, self.vault / path, self.vault), expected)

    def test_trusted_build_dossier_allowed_root_and_knowledge_denied(self):
        rules = {'*': 'allow', str(self.vault / '**'): 'deny',
                 str(self.vault / '10-projects/*/HANDOFF.md'): 'allow',
                 str(self.vault / '**/凭据.md'): 'deny'}
        # 同一旧问题也会令 vault 规则文件错误落到开发角色默认 allow。
        self.assertEqual(self.action(rules, self.vault / 'AGENTS.md', self.code), 'allow')
        projected = policy.project_edit_rules(rules, self.code)
        for path, expected in [('10-projects/demo/HANDOFF.md', 'allow'),
                               ('AGENTS.md', 'deny'), ('30-resources/wiki/card.md', 'deny'),
                               ('10-projects/demo/凭据.md', 'deny')]:
            self.assertEqual(self.action(projected, self.vault / path, self.code), expected)
        self.assertEqual(self.action(projected, self.code / 'main.py', self.code), 'allow')

    def test_collision_moves_later_rule_to_its_effective_position(self):
        rules = {'notes/*.md': 'allow', str(self.vault / 'notes/private.md'): 'deny',
                 str(self.vault / 'notes/*.md'): 'ask'}
        projected = policy.project_edit_rules(rules, self.vault)
        self.assertEqual(list(projected), ['notes/private.md', 'notes/*.md'])
        self.assertEqual(self.action(projected, self.vault / 'notes/private.md', self.vault), 'ask')

    def test_availability_can_only_narrow_selected_providers(self):
        data = {'enabled_providers': ['provider-a', 'provider-b'],
                'permission': {'task': {'*': 'allow', 'fixture-review-a': 'allow'}},
                'agent': {'paws-build': {'permission': {'task': {'*': 'allow'}}},
                          'fixture-review-a': {'model': 'provider-b/reviewer', 'disable': False, 'permission': {'read': 'deny'}}}}
        policy.narrow_available_providers(data, ['provider-a', 'provider-c'])
        self.assertEqual(data['enabled_providers'], ['provider-a'])
        self.assertTrue(data['agent']['fixture-review-a']['disable'])
        self.assertEqual(data['permission']['task']['fixture-review-a'], 'deny')
        self.assertEqual(data['agent']['paws-build']['permission']['task']['fixture-review-a'], 'deny')
        self.assertEqual(data['agent']['fixture-review-a']['permission']['read'], 'deny')

    def test_missing_optional_provider_disables_fixed_model_agents_without_switching_models(self):
        """关联提供方不可用时，保留显式选模的主角色并停用使用原提供方的辅助角色。"""
        active = {'agent': {
            'paws-build': {'model': 'provider-a/main'},
            'paws-explore': {'model': 'provider-a/small'},
            'custom-review': {'model': 'provider-c/reviewer'},
            'inherited-model': {},
            'user-disabled': {'model': 'provider-b/available', 'disable': True}}}
        data = {'enabled_providers': ['provider-a', 'provider-c', 'provider-b'],
                'permission': {'task': {'*': 'allow'}},
                'agent': {'paws-build': {'permission': {'task': {'*': 'allow'}}},
                          'paws-explore': {'permission': {'edit': 'deny'}}}}
        policy.narrow_available_providers(data, ['provider-b'], active=active, selected_agent='paws-build')
        self.assertEqual(data['enabled_providers'], ['provider-b'])
        self.assertNotIn('disable', data['agent']['paws-build'])
        for name in ['paws-explore', 'custom-review']:
            self.assertTrue(data['agent'][name]['disable'])
            self.assertEqual(data['agent']['paws-build']['permission']['task'][name], 'deny')
        self.assertEqual(data['agent']['paws-explore']['permission']['edit'], 'deny')
        self.assertNotIn('inherited-model', data['agent'])
        self.assertTrue(policy.merge_config(active, data)['agent']['user-disabled']['disable'])
        self.assertEqual(active['agent']['paws-build']['model'], 'provider-a/main')

    def test_runtime_safe_read_and_bootstrap_cannot_inherit_project_allows(self):
        """最终 hook 必须整替换 edit；原生深合并遗留的本地允许不能绕过运行时边界。"""
        active = {'agent': {'paws-build': {'permission': {'edit': {'*': 'allow'}}}}}
        effective = {'provider': {'fixture': {}}, 'agent': {'paws-build': {'permission': {
            'edit': {'*': 'deny', 'notes/*.md': 'allow'}, 'read': 'ask', 'bash': 'deny'}}}}
        overlay = {'agent': {'paws-build': {'permission': {'edit': 'deny'}}}}
        final = policy.finalize_edit_permissions(effective, overlay, active, self.vault, self.code)
        self.assertEqual(self.action(final['agent']['paws-build']['permission']['edit'], self.code / 'main.py', self.code), 'deny')
        self.assertEqual(final['agent']['paws-build']['permission']['read'], 'ask')
        self.assertEqual(final['agent']['paws-build']['permission']['bash'], 'deny')
        self.assertEqual(final['provider'], effective['provider'])
        effective['agent']['paws-build']['permission']['edit']['*'] = 'allow'
        overlay['agent']['paws-build']['permission']['edit'] = {'*': 'allow', str(self.vault / '**'): 'deny'}
        final = policy.finalize_edit_permissions(effective, overlay, active, self.vault, self.code)
        rules = final['agent']['paws-build']['permission']['edit']
        self.assertEqual(self.action(rules, self.vault / 'notes/card.md', self.code), 'deny')
        self.assertEqual(self.action(rules, self.code / 'main.py', self.code), 'allow')

    def test_final_projection_retains_extra_local_restrictions_but_not_allow(self):
        overlay = {'agent': {'paws-maintain': {'permission': {
            'edit': {'*': 'deny', str(self.vault / '30-resources/wiki/*.md'): 'allow'},
            'external_directory': {'*': 'deny', str(self.vault / '**'): 'allow'}}}}}
        effective = policy.merge_config(overlay, {'agent': {'paws-maintain': {'permission': {'edit': {
            '30-resources/wiki/review.md': 'ask', '30-resources/wiki/private.md': 'deny',
            'scripts/skills/*.md': 'allow'}}}}})
        final = policy.finalize_edit_permissions(effective, overlay, overlay, self.vault, self.vault)
        rules = final['agent']['paws-maintain']['permission']['edit']
        for name, expected in [('card.md', 'allow'), ('review.md', 'ask'), ('private.md', 'deny')]:
            self.assertEqual(self.action(rules, self.vault / '30-resources/wiki' / name, self.vault), expected)
        self.assertEqual(self.action(rules, self.vault / 'scripts/skills/untrusted.md', self.vault), 'deny')
        for path in ['AGENTS.md', 'CLAUDE.md', '.gitignore', '凭据.md', '.env', 'credentials.md',
                     '00-inbox/AGENTS.md', '00-inbox/CLAUDE.md', '00-inbox/.gitignore',
                     '00-inbox/凭据.md', '00-inbox/secret.env', '00-inbox/credentials.md']:
            self.assertEqual(self.action(rules, self.vault / path, self.vault), 'deny', path)

    def test_same_key_project_deny_and_ask_remain_stricter(self):
        """edit 独立快照使原生保留项目同键限制；无效的新增 allow 仍被丢弃。"""
        key = str(self.vault / '30-resources/wiki/*.md')
        active = {'agent': {'paws-maintain': {'permission': {'edit': {'*': 'deny', key: 'allow'}}}}}
        for action in ('deny', 'ask'):
            effective = policy.merge_config(active, {'agent': {'paws-maintain': {'permission': {'edit': {key: action}}}}})
            final = policy.finalize_edit_permissions(effective, active, active, self.vault, self.vault)
            self.assertEqual(self.action(final['agent']['paws-maintain']['permission']['edit'],
                                         self.vault / '30-resources/wiki/card.md', self.vault), action)
        effective = policy.merge_config(active, {'agent': {'paws-maintain': {'permission': {'edit': 'deny'}}}})
        final = policy.finalize_edit_permissions(effective, active, active, self.vault, self.vault)
        self.assertEqual(self.action(final['agent']['paws-maintain']['permission']['edit'],
                                     self.vault / '30-resources/wiki/card.md', self.vault), 'deny')
        bundle = policy.split_edit_policy(active)
        self.assertNotIn('edit', bundle['config']['agent']['paws-maintain']['permission'])
        self.assertEqual(bundle['edit_policy']['agent']['paws-maintain']['permission']['edit'][key], 'allow')

    def test_active_denies_keep_authorized_env_example_order_and_drop_old_allows(self):
        """追加旧拒绝不能误禁原有 .env.example；bootstrap 仍拒绝 trusted 的档案旧例外。"""
        original = {'*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '**/.env.*': 'deny',
                    '*.env.example': 'allow', '**/.env.example': 'allow',
                    str(self.vault / '**'): 'deny', str(self.vault / '10-projects/*/HANDOFF.md'): 'allow'}
        required = {'*': 'allow', '*.env': 'deny', '*.env.*': 'deny',
                    '*.env.example': 'allow', '**/.env.example': 'allow', str(self.vault / '**'): 'deny'}
        active = {'agent': {'paws-build': {'permission': {'edit': original}}}}
        runtime = {'agent': {'paws-build': {'permission': {'edit': required, 'external_directory': {'*': 'deny'}}}}}
        final = policy.finalize_edit_permissions(active, runtime, active, self.vault, self.code)
        rules = final['agent']['paws-build']['permission']['edit']
        self.assertEqual(self.action(rules, self.code / 'nested/.env.example', self.code), 'allow')
        self.assertEqual(self.action(rules, self.code / 'nested/.env.secret', self.code), 'deny')
        self.assertEqual(self.action(rules, self.vault / '10-projects/demo/HANDOFF.md', self.code), 'deny')

    def test_active_same_key_ask_survives_runtime_allow_without_relaxing_deny(self):
        key = str(self.vault / '30-resources/wiki/*.md')
        active = {'agent': {'paws-maintain': {'permission': {'edit': {'*': 'deny', key: 'ask'}}}}}
        runtime = {'agent': {'paws-maintain': {'permission': {'edit': {'*': 'deny', key: 'allow'}}}}}
        final = policy.finalize_edit_permissions(active, runtime, active, self.vault, self.vault)
        self.assertEqual(self.action(final['agent']['paws-maintain']['permission']['edit'],
                                     self.vault / '30-resources/wiki/card.md', self.vault), 'ask')
        runtime['agent']['paws-maintain']['permission']['edit'][key] = 'deny'
        final = policy.finalize_edit_permissions(active, runtime, active, self.vault, self.vault)
        self.assertEqual(self.action(final['agent']['paws-maintain']['permission']['edit'],
                                     self.vault / '30-resources/wiki/card.md', self.vault), 'deny')

    def test_native_worktree_git_subdir_linked_and_no_git(self):
        """用隔离仓库核对 Git 子目录、独立 worktree、未提交仓库和无 Git 根语义。"""
        import subprocess
        def git(*args):
            return subprocess.run(['git', '-C', str(self.code), *args], check=True, capture_output=True)
        self.assertEqual(policy.validate_worktree(self.vault, Path('/')), Path('/'))
        with self.assertRaises(ValueError):
            policy.validate_worktree(self.vault, self.vault)
        git('init', '-q')
        sub = self.code / 'nested'
        sub.mkdir()
        self.assertEqual(policy.validate_worktree(sub, self.code), self.code)
        with self.assertRaises(ValueError):
            policy.validate_worktree(sub, sub)
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture')
        linked = self.base / 'linked'
        git('worktree', 'add', '-q', '--detach', str(linked))
        (linked / 'nested').mkdir()
        self.assertEqual(policy.validate_worktree(linked / 'nested', linked), linked)
        (self.vault / '.git').write_text('gitdir: missing-directory')
        with self.assertRaises(ValueError):
            policy.validate_worktree(self.vault, Path('/'))

    def test_missing_config_invalid_config_and_broad_allow_fail_explicitly(self):
        """缺失输入与无法等价投影的绝对广域 allow 不默认为空配置或扩大权限。"""
        with self.assertRaises(ValueError):
            policy.read_config(self.base / 'missing.json')
        broken = self.base / 'broken.json'
        broken.write_text('{broken')
        with self.assertRaises(ValueError):
            policy.read_config(broken)
        with self.assertRaises(ValueError):
            policy.project_edit_rules({str(self.vault / '**'): 'allow'}, self.vault)

if __name__ == '__main__':
    unittest.main()
