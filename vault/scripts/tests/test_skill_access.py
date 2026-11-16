"""使用合成安装目录验证专业技能依赖读取；不接触实际凭据或用户资料。"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('skill_policy', ROOT / 'scripts/paws_manual_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class SkillAccessTests(unittest.TestCase):
    """覆盖受信目录、三端别名、局部限制、只读边界与恶意链接。"""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='paws-skill-access-')
        self.home = Path(self.tmp.name).resolve() / 'home'
        self.vault = self.home / 'vault'
        self.code = self.home / 'code'
        self.code.mkdir(parents=True)
        self.bases = [self.home / x for x in ['.agents/skills', '.claude/skills', '.config/opencode/skills']]
        for base in self.bases:
            base.mkdir(parents=True)
        self.canonical = self.vault / 'scripts/skills/paws-office-delivery'
        (self.canonical / 'references').mkdir(parents=True)
        (self.canonical / 'SKILL.md').write_text('---\nname: paws-office-delivery\ndescription: Fixture\n---\nFixture')
        (self.canonical / 'references/word.md').write_text('SYNTHETIC')
        (self.vault / 'paws.manifest.json').write_text(json.dumps({'skills': {'source_root':'scripts/skills', 'names':['paws-office-delivery', 'paws-checkpoint']}, 'manual_workflows':['paws-checkpoint']}))
        for base in self.bases:
            (base / 'paws-office-delivery').symlink_to(self.canonical)
        rights = {'read': {'*':'allow','*.env':'deny'}, 'edit': {'*':'allow'},
                  'external_directory': {'*':'deny',str(self.vault / '**'):'allow'},
                  'skill': {'*':'deny','paws-office-delivery':'allow','paws-checkpoint':'deny'}}
        self.active = {'agent':{'paws-build':{'permission':rights}}}
        self.overlay = copy.deepcopy(self.active)
        self.paths = [self.canonical, *[b / 'paws-office-delivery' for b in self.bases]]

    def tearDown(self):
        self.tmp.cleanup()

    def finalize(self, effective=None):
        return policy.finalize_skill_access(copy.deepcopy(effective or self.active), self.overlay,
                                            self.active, self.vault, self.code, self.home)

    def action(self, rules, path):
        result = 'ask'
        for pattern, action in policy.permission_map(rules).items():
            if policy.native_match(str(path), pattern):
                result = action
        return result

    def test_reads_all_registered_aliases_without_broad_home_access_and_denies_writes(self):
        rights = self.finalize()['agent']['paws-build']['permission']
        for root in self.paths:
            self.assertEqual(self.action(rights['external_directory'], root / 'references/*'), 'allow')
            self.assertEqual(self.action(rights['edit'], os.path.relpath(root / 'references/word.md', self.code)), 'deny')
        self.assertEqual(self.action(rights['external_directory'], self.home / '.config/private/*'), 'deny')
        self.assertEqual(rights['skill']['paws-checkpoint'], 'deny')
        self.assertEqual(rights['read'], self.active['agent']['paws-build']['permission']['read'])

    def test_same_key_local_external_deny_and_ask_are_not_overwritten(self):
        for action in ('deny','ask'):
            effective = copy.deepcopy(self.active)
            effective['agent']['paws-build']['permission']['external_directory'][str(self.vault / '**')] = action
            rights = self.finalize(effective)['agent']['paws-build']['permission']
            for root in self.paths:
                self.assertEqual(self.action(rights['external_directory'], root / 'references/*'), action)

    def test_specific_alias_restriction_applies_to_same_canonical_files(self):
        effective = copy.deepcopy(self.active)
        effective['agent']['paws-build']['permission']['external_directory'][str(self.paths[1] / 'references/**')] = 'deny'
        rights = self.finalize(effective)['agent']['paws-build']['permission']
        for root in self.paths:
            self.assertEqual(self.action(rights['external_directory'], root / 'references/*'), 'deny')

    def test_local_read_deny_and_disabled_skill_do_not_get_bypassed(self):
        effective = copy.deepcopy(self.active)
        effective['agent']['paws-build']['permission']['read'] = 'deny'
        self.assertEqual(self.action(self.finalize(effective)['agent']['paws-build']['permission']['read'], 'any.txt'), 'deny')
        effective['agent']['paws-build']['permission']['skill']['paws-office-delivery'] = 'deny'
        rights = self.finalize(effective)['agent']['paws-build']['permission']
        self.assertEqual(self.action(rights['external_directory'], self.paths[1] / 'references/*'), 'deny')

    def test_existing_native_non_paws_install_is_readable_but_redirect_to_home_is_not(self):
        real = self.bases[2] / 'officecli'
        real.mkdir()
        (real / 'SKILL.md').write_text('---\nname: officecli\ndescription: Fixture\n---\nFixture')
        (self.bases[0] / 'officecli').symlink_to(real)
        self.active['agent']['paws-build']['permission']['skill']['officecli'] = 'allow'
        self.overlay = copy.deepcopy(self.active)
        rights = self.finalize()['agent']['paws-build']['permission']
        self.assertEqual(self.action(rights['external_directory'], real / '*'), 'allow')
        (self.bases[0] / 'officecli').unlink()
        (self.bases[0] / 'officecli').symlink_to(self.home)
        rights = self.finalize()['agent']['paws-build']['permission']
        self.assertEqual(self.action(rights['external_directory'], self.bases[0] / 'officecli/private/*'), 'deny')

    def test_nested_symlink_escape_gets_no_extra_alias_grants(self):
        """拒绝新增三端别名例外；canonical 原有 vault 读取不属于本次撤销范围。"""
        outside = self.home / 'private'
        outside.mkdir()
        (outside / 'fixture.txt').write_text('SYNTHETIC')
        (self.canonical / 'references/escape').symlink_to(outside)
        rights = self.finalize()['agent']['paws-build']['permission']
        for root in self.paths[1:]:
            self.assertEqual(self.action(rights['external_directory'], root / 'references/escape/*'), 'deny')

    def test_agent_wildcard_skill_deny_or_ask_overrides_global_specific_allow(self):
        self.active['permission'] = {'skill': {'*':'deny','paws-office-delivery':'allow'}}
        for action in ('deny','ask'):
            self.active['agent']['paws-build']['permission']['skill'] = {'*':action}
            self.overlay = copy.deepcopy(self.active)
            rights = self.finalize()['agent']['paws-build']['permission']
            self.assertEqual(self.action(rights['external_directory'], self.paths[1] / 'references/*'), 'deny')

    def test_alias_and_layer_conflicts_keep_the_more_restrictive_deny(self):
        first = str(self.paths[1] / 'references/**')
        second = str(self.paths[2] / 'references/**')
        self.active['permission'] = {'external_directory': {first:'ask'}}
        self.active['agent']['paws-build']['permission']['external_directory'].update({first:'deny',second:'ask'})
        self.overlay = copy.deepcopy(self.active)
        rights = self.finalize()['agent']['paws-build']['permission']
        for path in self.paths:
            self.assertEqual(self.action(rights['external_directory'], path / 'references/*'), 'deny')

    def test_global_and_local_read_restrictions_follow_canonical_and_alias_paths(self):
        first = str(self.paths[1] / 'references/word.md')
        self.active['permission'] = {'read': {first:'ask'}}
        effective = copy.deepcopy(self.active)
        effective['agent']['paws-build']['permission']['read'][first] = 'deny'
        rights = self.finalize(effective)['agent']['paws-build']['permission']
        for path in self.paths:
            self.assertEqual(self.action(rights['read'], os.path.relpath(path / 'references/word.md', self.code)), 'deny')

    def test_runtime_read_allow_never_relaxes_existing_specific_deny(self):
        self.active['agent']['paws-build']['permission']['read']['*.env.example'] = 'deny'
        self.overlay = copy.deepcopy(self.active)
        self.overlay['agent']['paws-build']['permission']['read']['*.env.example'] = 'allow'
        rights = self.finalize()['agent']['paws-build']['permission']
        self.assertEqual(self.action(rights['read'], 'local.env.example'), 'deny')

    def test_global_read_ask_cannot_promote_whole_agent_read_deny(self):
        key = str(self.paths[1] / 'references/word.md')
        self.active['permission'] = {'read': {key:'ask'}}
        effective = copy.deepcopy(self.active)
        effective['agent']['paws-build']['permission']['read'] = 'deny'
        rights = self.finalize(effective)['agent']['paws-build']['permission']
        for root in self.paths:
            self.assertEqual(self.action(rights['read'], os.path.relpath(root / 'references/word.md', self.code)), 'deny')
        for root in self.paths[1:]:
            self.assertEqual(self.action(rights['external_directory'], root / 'references/*'), 'deny')

    def test_wildcard_read_ask_does_not_relax_existing_narrow_deny(self):
        first = str(self.paths[1] / 'references/**')
        private = str(self.paths[1] / 'references/private.md')
        self.active['permission'] = {'read': {first:'ask'}}
        effective = copy.deepcopy(self.active)
        effective['agent']['paws-build']['permission']['read'][private] = 'deny'
        rights = self.finalize(effective)['agent']['paws-build']['permission']
        for root in self.paths:
            self.assertEqual(self.action(rights['read'], os.path.relpath(root / 'references/private.md', self.code)), 'deny')

    def test_split_retains_local_external_rules_until_final_hook(self):
        bundle = policy.split_edit_policy(self.overlay)
        self.assertNotIn('external_directory', bundle['config']['agent']['paws-build']['permission'])
        self.assertIn('external_directory', bundle['edit_policy']['agent']['paws-build']['permission'])

    def native_professional_fixture(self):
        """创建不在 PAWS 注册表和精确白名单中的原生专业技能及其参考文件。"""
        directory = self.bases[0] / 'web-design-guidelines'
        (directory / 'references').mkdir(parents=True)
        (directory / 'SKILL.md').write_text('---\nname: web-design-guidelines\ndescription: Fixture\n---\nFixture')
        (directory / 'references/checks.md').write_text('SYNTHETIC')
        self.active['permission'] = {'skill': {'*': 'allow', 'paws-checkpoint': 'deny'}}
        self.active['agent']['paws-build']['permission']['skill'] = {'paws-checkpoint': 'deny'}
        self.overlay = copy.deepcopy(self.active)
        return directory

    def test_native_wildcard_discovers_unlisted_professional_dependencies(self):
        """原生 allow 应使已安装专业技能的依赖可读，不要求再维护一份名称表。"""
        directory = self.native_professional_fixture()
        self.active['agent']['paws-build']['permission']['edit'] = 'deny'
        self.active['agent']['paws-build']['permission']['bash'] = 'deny'
        self.overlay = copy.deepcopy(self.active)
        rights = self.finalize()['agent']['paws-build']['permission']
        self.assertEqual(self.action(rights['external_directory'], directory / 'references/*'), 'allow')
        self.assertEqual(self.action(rights['edit'], os.path.relpath(directory / 'references/checks.md', self.code)), 'deny')
        self.assertEqual(self.action(rights['edit'], 'project.py'), 'deny')
        self.assertEqual(rights['bash'], 'deny')
        self.assertEqual(rights['skill']['paws-checkpoint'], 'deny')

    def test_native_specific_skill_restrictions_do_not_gain_dependency_grants(self):
        """全局开放后，active 或项目有效配置中的 deny/ask 仍决定是否自动补依赖。"""
        directory = self.native_professional_fixture()
        for source in ('active', 'effective'):
            for action in ('ask', 'deny'):
                with self.subTest(source=source, action=action):
                    effective = copy.deepcopy(self.active)
                    target = self.active if source == 'active' else effective
                    target['agent']['paws-build']['permission']['skill']['web-design-guidelines'] = action
                    rights = self.finalize(effective)['agent']['paws-build']['permission']
                    self.assertEqual(self.action(rights['external_directory'], directory / 'references/*'), 'deny')
                    self.active['agent']['paws-build']['permission']['skill'].pop('web-design-guidelines', None)

    def test_native_project_skill_does_not_expand_external_dependency_scope(self):
        """项目同名技能按原生发现；全局安装的窄许可不能顺带放行其越界依赖。"""
        directory = self.native_professional_fixture()
        project_skill = self.code / '.opencode/skills/web-design-guidelines'
        project_skill.mkdir(parents=True)
        (project_skill / 'SKILL.md').write_text('---\nname: web-design-guidelines\ndescription: Local fixture\n---\nFixture')
        outside = self.home / 'unrelated'
        outside.mkdir()
        (project_skill / 'references').symlink_to(outside)
        rights = self.finalize()['agent']['paws-build']['permission']
        self.assertEqual(self.action(rights['external_directory'], directory / 'references/*'), 'allow')
        self.assertEqual(self.action(rights['external_directory'], outside / '*'), 'deny')


if __name__ == '__main__':
    unittest.main()
