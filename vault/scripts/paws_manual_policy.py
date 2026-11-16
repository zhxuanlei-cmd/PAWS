#!/usr/bin/env python3
"""维护所有手动 Skill 的调用门禁及原生路径权限；plan/doctor 只读，apply 先备份。"""
import argparse
import copy
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import sys


def permission_map(value):
    if value is None:
        return {}
    if isinstance(value, str) and value in ('allow', 'ask', 'deny'):
        return {'*': value}
    if not isinstance(value, dict):
        raise ValueError('unsupported permission format')
    return value


def load_manual_policy(vault):
    """读取工作流分类与手动调用清单，供安装检查、overlay 和最终合并共同使用。

    旧 manifest 有 Skill 注册表时从正本补足手动项；连注册表也没有时才兼容原工作流清单。
    新清单必须完整覆盖工作流和正本已声明手动的 Skill；漏登记、重复、未注册或正文缺失时明确失败。
    """
    import re
    manifest = read_config(vault / 'paws.manifest.json')

    def names(field):
        """只接受唯一的确切 Skill 名称，拒绝通配符和会改变匹配范围的无效值。"""
        value = manifest.get(field)
        if (not isinstance(value, list) or
                not all(isinstance(item, str) and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', item)
                        for item in value) or len(set(value)) != len(value)):
            raise ValueError('invalid manifest Skill list: ' + field)
        return value

    workflows = names('manual_workflows')
    legacy = 'manual_invocation_skills' not in manifest
    if legacy and 'skills' not in manifest:
        return workflows, workflows
    manual = list(workflows) if legacy else names('manual_invocation_skills')
    missing = set(workflows) - set(manual)
    if missing:
        raise ValueError('manual_invocation_skills omits workflows: ' + ', '.join(sorted(missing)))
    skills = manifest.get('skills', {})
    if not isinstance(skills, dict):
        raise ValueError('invalid manifest Skill registry')
    registered = skills.get('names', [])
    if (not isinstance(registered, list) or
            not all(isinstance(name, str) and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', name)
                    for name in registered)):
        raise ValueError('invalid manifest registered Skill names')
    unknown = set(manual) - set(registered)
    if unknown:
        raise ValueError('manual_invocation_skills contains unregistered Skills: ' + ', '.join(sorted(unknown)))
    # 仅读 canonical frontmatter 的调用标记，不加载/执行正文，也不依赖宿主的 YAML 扩展语义。
    declared = set()
    for name in registered:
        source = vault / skills.get('source_root', 'scripts/skills') / name / 'SKILL.md'
        try:
            header = source.read_text(encoding='utf-8').split('---', 2)
        except OSError as error:
            raise ValueError('cannot inspect registered Skill invocation: ' + name) from error
        if len(header) < 3 or header[0].strip():
            raise ValueError('registered Skill frontmatter is missing: ' + name)
        if (re.search(r'^disable-model-invocation:\s*(?:true|yes|on|1)\s*(?:#.*)?$', header[1], re.M | re.I) or
                re.search(r'^\s+invocation:\s*[\"\']?manual[\"\']?\s*(?:#.*)?$', header[1], re.M | re.I)):
            declared.add(name)
    if legacy:
        # 老设备缺新字段不等于撤销已登记 Skill 的手动属性；按注册顺序补入，输出保持稳定。
        manual.extend(name for name in registered if name in declared and name not in manual)
    missing = declared - set(manual)
    if missing:
        raise ValueError('manual_invocation_skills omits manual Skills: ' + ', '.join(sorted(missing)))
    return workflows, manual


def restrict_workflows(owner, names):
    """只禁止模型主动调用指定 Skill；读取正本及显式命令沿用角色现有权限。"""
    permission = permission_map(owner.get('permission'))
    skills = permission_map(permission.get('skill'))
    for name in names:
        skills.pop(name, None)
        skills[name] = 'deny'
    permission['skill'] = skills
    owner['permission'] = permission


def restrict_config(data, names):
    """在全局与全部角色末尾追加拒绝，覆盖前面的广域或精确 Skill allow。"""
    restrict_workflows(data, names)
    for agent in data.get('agent', {}).values():
        if isinstance(agent, dict):
            restrict_workflows(agent, names)


def repair_workflow_contract(data, vault):
    """收紧本次内存配置的旧提示并补已有写角色的窄写域，不修改已保存配置。"""
    root = str(vault.resolve())
    guards = [root + '/' + suffix for suffix in
              ['AGENTS.md', 'CLAUDE.md', '.gitignore', '凭据.md', '*.env*', 'credentials*.md', 'secrets*.md',
               '**/AGENTS.md', '**/CLAUDE.md', '**/.gitignore',
               'scripts/skills/**', '00-inbox/**/SKILL.md', '00-inbox/SKILL.md',
               '30-resources/literature/**/SKILL.md', '30-resources/literature/SKILL.md',
               '10-projects/**/SKILL.md', 'memory/episodes/**/SKILL.md', 'memory/episodes/SKILL.md',
               '**/凭据.md', '**/*.env*', '**/credentials*.md', '**/secrets*.md']]
    def allowed(rules, path):
        if not isinstance(rules, dict):
            return False
        matches = [action for pattern, action in rules.items()
                   if fnmatchcase(path, os.path.expanduser(pattern))]
        return bool(matches) and matches[-1] == 'allow'

    for name, agent in data.get('agent', {}).items():
        if not isinstance(agent, dict):
            continue
        prompt = agent.get('prompt')
        if name in ('paws-build', 'paws-plan', 'paws-maintain') and isinstance(prompt, str):
            for old, new in (
                ('Start with paws-project-continuation',
                 'Follow vault/AGENTS.md; run PAWS workflows only on this user turn\'s explicit request'),
                ('then use paws-checkpoint before handoff or compaction',
                 'use paws-checkpoint only when the user explicitly requests saving a checkpoint'),
                ('read the project spec, HANDOFF, recent worklog',
                 'read the project homepage introduction, spec, HANDOFF, tasks, recent worklog'),
                ('plan from the stable spec, current HANDOFF',
                 'plan from the project homepage, development spec, current HANDOFF'),
                ('先读 vault/AGENTS.md 和对应 paws-inbox、paws-reflect 或 paws-harvest skill。',
                 '先读 vault/AGENTS.md；仅按用户本次显式触发读取对应工作流正本。'),
            ):
                prompt = prompt.replace(old, new)
            agent['prompt'] = prompt
        rights = agent.get('permission')
        if agent.get('disable') or not isinstance(rights, dict):
            continue
        edit = rights.get('edit')
        if not isinstance(edit, dict):
            continue
        # bootstrap 只能写当前代码目录；既有 vault 访问许可仍由宿主裁决。
        external = rights.get('external_directory')
        if not isinstance(external, dict) or not any(
                os.path.expanduser(key) == root + '/**' and action == 'allow'
                for key, action in external.items()):
            continue
        if not allowed(external, root + '/__paws_scope_check__'):
            continue
        if name == 'paws-build' and edit.get('*') == 'allow':
            suffixes = ['10-projects/*/*-主页.md', '10-projects/*/spec.md',
                        '10-projects/*/HANDOFF.md', '10-projects/*/tasks.md',
                        '10-projects/*/worklog/*.md', '10-projects/*/decisions/*.md',
                        'memory/episodes/*.md']
        elif name == 'paws-maintain' and edit.get(root + '/30-resources/wiki/*.md') == 'allow' and allowed(edit, root + '/30-resources/wiki/check.md'):
            suffixes = ['00-inbox/*.md', '30-resources/literature/*.md',
                        '10-projects/*/materials/*.md']
        else:
            continue
        # 保留用户已有的局部拒绝/询问；全局规则仅投影到 vault，避免改动代码写域。
        exceptions = []
        for pattern, action in edit.items():
            expanded = os.path.expanduser(pattern)
            if action not in ('deny', 'ask') or expanded in ('*', root + '/**', *guards):
                continue
            if expanded.startswith(root + '/'):
                exceptions.append((expanded, action))
            elif not os.path.isabs(expanded):
                scoped = root + '/' + expanded
                if scoped not in guards:
                    exceptions.append((scoped, action))
        # OpenCode 使用最后匹配项；规则/凭据拒绝必须在新增允许项之后。
        for suffix in suffixes:
            key = root + '/' + suffix
            edit.pop(key, None)
            edit[key] = 'allow'
        for key in guards:
            edit.pop(key, None)
            edit[key] = 'deny'
        for key, action in exceptions:
            edit.pop(key, None)
            edit[key] = action


def merge_config(base, override):
    """仅在内存中按配置的对象递归合并语义取最终值，保留键的插入顺序。"""
    if not isinstance(base, dict) or not isinstance(override, dict):
        return copy.deepcopy(override)
    result = copy.deepcopy(base)
    for key, value in override.items():
        result[key] = merge_config(result[key], value) if key in result else copy.deepcopy(value)
    return result


def narrow_available_providers(data, available, active=None, selected_agent=None):
    """按授权提供方收窄快照，停用静态模型超出允许范围的角色。

    显式 --model 可以覆盖主角色的静态模型，
    因而保留 selected_agent。其余固定模型不可用时局部禁用，不替换模型或重开已禁用角色。
    """
    selected = data.get('enabled_providers')
    if not isinstance(selected, list) or not all(isinstance(item, str) for item in selected):
        raise ValueError('runtime overlay must declare enabled_providers')
    data['enabled_providers'] = [item for item in selected if item in set(available)]
    agents = data.setdefault('agent', {})
    unavailable = set()
    # 仅依据角色实际声明的模型提供方，保留原生继承模型的角色。
    for name, owner in merge_config(active or {}, data).get('agent', {}).items():
        if not isinstance(owner, dict) or name == selected_agent:
            continue
        model = owner.get('model')
        if isinstance(model, str) and '/' in model and model.split('/', 1)[0] not in data['enabled_providers']:
            unavailable.add(name)
    for name in sorted(unavailable):
        agent = agents.setdefault(name, {})
        agent.update(disable=True, hidden=True)
        for owner in [data, *agents.values()]:
            rights = permission_map(owner.get('permission'))
            if rights.get('task') == 'deny':
                continue
            routes = permission_map(rights.get('task'))
            routes.pop(name, None)
            routes[name] = 'deny'
            rights['task'] = routes
            owner['permission'] = rights


def read_config(path):
    """配置缺失、无效或读取失败即报错；错误消息不回显配置正文或凭据。"""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError('cannot read valid OpenCode config: ' + str(path)) from error
    if not isinstance(data, dict):
        raise ValueError('OpenCode config must be an object')
    return data


def validate_worktree(cwd, worktree):
    """核对宿主实际 worktree：Git 用 checkout 顶层，无 Git 用文件系统根。"""
    import subprocess
    cwd = cwd.resolve(strict=True)
    worktree = worktree.resolve(strict=True)
    if not cwd.is_dir() or not worktree.is_dir():
        raise ValueError('OpenCode directory and worktree must be directories')
    marker = None
    for parent in (cwd, *cwd.parents):
        try:
            (parent / '.git').lstat()
        except FileNotFoundError:
            continue
        marker = parent
        break
    if marker is None:
        expected = Path(cwd.anchor)
    else:
        # 与原生 Git.repo.discover 相同地从最近 .git 所在目录查询；不能把损坏仓库当成无 Git。
        results = []
        for flag in ('--show-toplevel', '--git-dir', '--git-common-dir'):
            job = subprocess.run(['git', '-C', str(marker), 'rev-parse', flag],
                                 capture_output=True, text=True, timeout=10)
            if job.returncode or not job.stdout.strip():
                raise ValueError('cannot verify OpenCode Git worktree')
            results.append(job.stdout.strip())
        expected = Path(results[0]).resolve(strict=True)
    if worktree != expected:
        raise ValueError('OpenCode native worktree does not match verified repository context')
    return worktree


def project_edit_rules(value, worktree):
    """将绝对 edit 模式投影到原生相对路径；重复键按最后匹配位置重建。"""
    if isinstance(value, str):
        if value not in ('allow', 'ask', 'deny'):
            raise ValueError('unsupported edit permission action')
        return value
    projected = {}
    for pattern, action in permission_map(value).items():
        if not isinstance(pattern, str) or action not in ('allow', 'ask', 'deny'):
            raise ValueError('unsupported edit permission rule')
        expanded = os.path.expanduser(pattern.replace('$HOME', str(Path.home()), 1)
                                      if pattern.startswith('$HOME') else pattern)
        key = expanded
        if os.path.isabs(expanded):
            # 原生模式不支持排除 ../；拒绝无法等价表达的跨根广域允许，避免悄然扩大权限。
            wildcard = min([expanded.find(char) for char in '*?' if char in expanded] or [len(expanded)])
            fixed = expanded[:wildcard].rstrip('/')
            if wildcard < len(expanded) and (str(worktree) + '/').startswith(expanded[:wildcard]):
                if action != 'deny' or str(worktree) != fixed:
                    raise ValueError('absolute edit glob overlaps worktree root; use a narrow explicit scope')
                key = expanded[wildcard:]
            else:
                key = os.path.relpath(expanded, worktree).replace(os.sep, '/')
        projected.pop(key, None)
        projected[key] = action
    return projected


def split_edit_policy(data):
    """把 edit/read/external_directory 留给最终 hook，保留项目同键限制的来源差异。

    edit_policy 名称沿用已安装启动器的 JSON 接口；内容是本次三类路径权限快照。
    """
    config = copy.deepcopy(data)
    edit_policy = {'agent': {}}
    owners = [(config, edit_policy)]
    for name, owner in config.get('agent', {}).items():
        target = {}
        edit_policy['agent'][name] = target
        if 'disable' in owner:
            target['disable'] = owner['disable']
        owners.append((owner, target))
    for owner, target in owners:
        rights = permission_map(owner.get('permission'))
        target['permission'] = {key: rights.pop(key) for key in ('edit', 'read', 'external_directory') if key in rights}
        owner['permission'] = rights
    return {'config': config, 'edit_policy': edit_policy}


def finalize_edit_permissions(effective, overlay, active, vault, worktree):
    """原生全部合并后整替换 edit；只叠加全局及项目原有的更严限制，不引入额外允许。"""
    import re
    if not all(isinstance(item, dict) for item in (effective, overlay, active)):
        raise ValueError('final edit projection requires object configurations')
    runtime = copy.deepcopy(overlay)
    pairs = [(runtime, active)] + [(owner, active.get('agent', {}).get(name, {}))
                                   for name, owner in runtime.get('agent', {}).items()]
    for owner, baseline in pairs:
        rights = permission_map(owner.get('permission'))
        required = rights.get('edit')
        original = permission_map(baseline.get('permission')).get('edit')
        if isinstance(required, dict) and isinstance(original, dict):
            # 保留 active 的规则顺序与受认可的例外（如 .env.example），丢弃当前模式未批准的旧 allow。
            combined = {key: action for key, action in original.items()
                        if action != 'allow' or required.get(key) == 'allow'}
            for key, action in required.items():
                old = combined.get(key)
                combined[key] = old if key != '*' and old in ('deny', 'ask') and action == 'allow' else action
            rights['edit'] = combined
            owner['permission'] = rights
    repair_workflow_contract(runtime, vault)
    result = copy.deepcopy(effective)
    owners = [(result, active, runtime)]
    for name, owner in result.get('agent', {}).items():
        if isinstance(owner, dict):
            owners.append((owner, active.get('agent', {}).get(name, {}), runtime.get('agent', {}).get(name, {})))
    for owner, baseline, contract in owners:
        rights = permission_map(owner.get('permission'))
        native = rights.get('edit')
        original = permission_map(baseline.get('permission')).get('edit')
        required = permission_map(contract.get('permission')).get('edit')
        if required is None:
            if native is not None:
                rights['edit'] = project_edit_rules(native, worktree)
                owner['permission'] = rights
            continue
        # 运行时写域整替换；bootstrap 不得继承 active 中仅 trusted 模式允许的档案例外。
        value = project_edit_rules(required, worktree)
        changes = []
        if isinstance(original, str) and original in ('deny', 'ask') and native == original:
            changes.append(('*', original))
        if isinstance(native, str) and native in ('deny', 'ask'):
            changes.append(('*', native))
        elif isinstance(native, dict):
            previous = permission_map(original)
            changes.extend((key, action) for key, action in native.items()
                           if action in ('ask', 'deny') and previous.get(key) != action)
        for key, action in changes:
            projected = project_edit_rules({key: action}, worktree)
            key = next(iter(projected))
            rules = permission_map(value)
            if action == 'deny':
                rules.pop(key, None)
                rules[key] = 'deny'
            elif key == '*':
                # 整体 ask 只把既有 allow 收窄；任何 deny 仍然 deny。
                rules = {pattern: 'ask' if permission == 'allow' else permission
                         for pattern, permission in rules.items()}
            elif key in rules:
                if rules[key] == 'allow':
                    rules[key] = 'ask'
            elif '*' in key or '?' in key:
                # 原生 glob 无交集运算；不能把原本 deny 的范围放松成 ask。
                raise ValueError('additional wildcard ask needs an existing matching edit scope')
            else:
                matches = [permission for pattern, permission in rules.items()
                           if re.fullmatch(re.escape(pattern).replace(r'\*', '.*').replace(r'\?', '.'), key, flags=re.S)]
                if matches and matches[-1] == 'allow':
                    rules[key] = 'ask'
            value = rules
        rights['edit'] = value
        owner['permission'] = rights
    return result


def native_match(value, pattern):
    """按原生权限的 * / ? 语义匹配；不把 [] 误解释为字符集合。"""
    import re
    return re.fullmatch(re.escape(pattern).replace(r'\*', '.*').replace(r'\?', '.'),
                        value, flags=re.S) is not None


def skill_directories(names, vault, home, diagnostics=None):
    """定位现有全局安装及同源别名；names 为 None 时按原生目录自动发现。

    此处只决定可补充的依赖路径，不维护第二份专业 Skill 许可表；实际 allow/ask/deny
    仍由 active 与原生最终配置决定。PAWS 正文取 manifest，任意 home/config 链接不获额外访问。
    """
    import re
    manifest = read_config(vault / 'paws.manifest.json')
    registered = set(manifest.get('skills', {}).get('names', []))
    bases = [home / x for x in ('.agents/skills', '.claude/skills', '.config/opencode/skills')]
    # 原生全局技能根自身不能被改向其他目录；PAWS 的正文仍只取 manifest 正本。
    safe_bases = [p for p in bases if p.is_dir() and p.resolve() == p]
    if names is None:
        names = registered | {p.name for base in safe_bases for p in base.iterdir() if p.is_dir()}
    groups = {}
    for name in sorted(names):
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', name):
            continue
        candidates = [base / name for base in safe_bases]
        if name.startswith('paws-'):
            if name not in registered:
                continue
            canonical = vault / manifest['skills'].get('source_root', 'scripts/skills') / name
            trusted = [canonical] if canonical.is_dir() and canonical.resolve() == canonical else []
        else:
            trusted = [p.resolve() for p in candidates if p.is_dir()
                       and any(p.resolve().is_relative_to(base) and p.resolve() != base for base in safe_bases)]
        for canonical in set(trusted):
            main = canonical / 'SKILL.md'
            if not main.is_file() or not main.resolve().is_relative_to(canonical):
                continue
            # 文件名和正文名称必须一致；不接受目录之外的文件充当已注册 Skill。
            header = main.read_text(encoding='utf-8').split('---', 2)
            if len(header) < 3 or not re.search(r'^name:\s*[\"\']?' + re.escape(name) + r'[\"\']?\s*$', header[1], re.M):
                continue
            aliases = {canonical, *[p for p in candidates if p.is_dir() and p.resolve() == canonical]}
            escapes = []
            for directory, dirs, files in os.walk(canonical, followlinks=False):
                for entry in dirs + files:
                    path = Path(directory) / entry
                    if path.is_symlink() and not path.resolve().is_relative_to(canonical):
                        escapes.append(path.relative_to(canonical))
            # 整份安装含越界依赖时不增加任何额外读取例外，避免把链接分析变成文件沙箱。
            if not escapes:
                groups.setdefault(name, []).append(sorted(aliases))
            elif diagnostics is not None:
                diagnostics.append({'name': name, 'reason': 'dependency symlink leaves the trusted Skill directory'})
    return groups


def finalize_skill_access(effective, overlay, active, vault, worktree, home=None):
    """恢复已授权 Skill 的窄依赖访问；同源别名只读，项目更严限制继续生效。

    本函数只适配原生路径工具权限，既有 Bash 不是操作系统文件沙箱；不改变 Bash/Skill/read 授权。
    """
    home = (home or Path.home()).resolve()
    def expand(pattern):
        if pattern == '~' or pattern.startswith('~/'):
            return str(home) + pattern[1:]
        if pattern == '$HOME' or pattern.startswith('$HOME/'):
            return str(home) + pattern[5:]
        return pattern
    def rights(config, name):
        owner = config if name is None else config.get('agent', {}).get(name, {})
        return permission_map(owner.get('permission'))
    def selected(layers, name):
        matches = [action for layer in layers for pattern, action in permission_map(layer).items()
                   if native_match(name, pattern)]
        return matches[-1] if matches else 'deny'
    diagnostics = []
    # 原生通配许可同样有效；从安装现场找依赖，避免每装一项专业技能就重复登记精确 allow。
    groups = skill_directories(None, vault, home, diagnostics)
    result = copy.deepcopy(effective)
    for name, owner in [(None, result), *result.get('agent', {}).items()]:
        if not isinstance(owner, dict):
            continue
        current = rights(effective, name)
        original = rights(active, name)
        contract = rights(overlay, name)
        output = permission_map(owner.get('permission'))
        read_before = permission_map(original.get('read'))
        read_native = permission_map(current.get('read'))
        read_required = permission_map(contract.get('read'))
        reads = {**read_before, **read_required} if read_required else dict(read_native)
        for key, action in read_before.items():
            if action in ('deny', 'ask') and reads.get(key) == 'allow':
                reads[key] = action
        for key, action in read_native.items():
            if action in ('deny', 'ask') and read_before.get(key) != action:
                if action == 'ask' and reads.get(key) == 'deny':
                    continue
                if key == '*' and action == 'ask':
                    reads = {pattern: 'ask' if value == 'allow' else value for pattern, value in reads.items()}
                else:
                    reads.pop(key, None)
                    reads[key] = action
        if reads:
            output['read'] = project_edit_rules(reads, worktree)
        before = permission_map(original.get('external_directory'))
        native = permission_map(current.get('external_directory'))
        required = permission_map(contract.get('external_directory'))
        external = {expand(k): v for k, v in {**before, **required}.items()}
        if not required:
            external = {expand(k): v for k, v in native.items()}
        # 项目附加 allow 不扩大边界；同键 deny/ask 在 runtime 外部目录尚未合并时保留来源。
        restrictions = {expand(k): v for k, v in before.items() if k != '*' and v in ('deny', 'ask')}
        restrictions.update({expand(k): v for k, v in native.items()
                             if v in ('deny', 'ask') and (k != '*' or before.get(k) != v)})
        for k, v in restrictions.items():
            external.pop(k, None)
            external[k] = v
        # 原生先全局后角色逐层匹配；不能用 dict 合并丢失重复 * 的最后位置。
        allowed = [rights(effective, None).get('skill'), current.get('skill')]
        declared = [rights(active, None).get('skill'), original.get('skill')]
        # 整体只读拒绝不因技能引用修复而获得目录例外或可批准的 ask。
        read_rules = permission_map(output.get('read'))
        whole_read_denied = current.get('read') == 'deny' or (read_rules.get('*') == 'deny' and set(read_rules.values()) == {'deny'})
        if not owner.get('disable') and not whole_read_denied:
            for skill, installations in groups.items():
                if selected(allowed, skill) != 'allow' or selected(declared, skill) != 'allow':
                    continue
                for aliases in installations:
                    for path in aliases:
                        external[str(path / '**')] = 'allow'
                        edits = permission_map(output.get('edit'))
                        key = os.path.relpath(path / '**', worktree).replace(os.sep, '/')
                        edits.pop(key, None)
                        edits[key] = 'deny'
                        output['edit'] = edits
                    # 全局或项目对某个别名的限制同步到相同正文，避免换写法绕过 deny/ask。
                    guards = dict(restrictions)
                    for key, action in permission_map(rights(effective, None).get('external_directory')).items():
                        if key != '*' and action in ('deny', 'ask') and guards.get(expand(key)) != 'deny':
                            guards[expand(key)] = action
                    translated = {}
                    for pattern, action in guards.items():
                        for source in aliases:
                            prefix = str(source)
                            if pattern == prefix or pattern.startswith(prefix + '/'):
                                suffix = pattern[len(prefix):]
                            elif native_match(prefix + '/', pattern):
                                suffix = '/**'
                            else:
                                continue
                            for target in aliases:
                                key = str(target) + suffix
                                if translated.get(key) != 'deny':
                                    translated[key] = action
                    # deny 最后追加；ask 不能把已拒绝区域重新变成可批准区域。
                    for action in ('ask', 'deny'):
                        for pattern, value in translated.items():
                            if value == action:
                                external.pop(pattern, None)
                                external[pattern] = value
                    # read 同样按相对 worktree 请求；具体别名限制同步到同一正文，不增加 read allow。
                    read_guards = {}
                    for layer in [rights(effective, None).get('read'), current.get('read')]:
                        for key, action in permission_map(layer).items():
                            absolute = expand(key)
                            if not os.path.isabs(absolute):
                                absolute = os.path.normpath(str(worktree / absolute))
                            if key != '*' and action in ('deny', 'ask'):
                                for source in aliases:
                                    prefix = str(source)
                                    if absolute == prefix or absolute.startswith(prefix + '/'):
                                        for target in aliases:
                                            mapped = os.path.relpath(str(target) + absolute[len(prefix):], worktree)
                                            if read_guards.get(mapped) != 'deny':
                                                read_guards[mapped] = action
                    if read_guards:
                        reads = permission_map(output.get('read'))
                        for action in ('ask', 'deny'):
                            for key, value in read_guards.items():
                                if action == value:
                                    if value == 'ask':
                                        if selected([reads], key) == 'deny':
                                            continue
                                        # 无法等价表达 wildcard ask 与既有 deny 的交集时保守拒绝该范围。
                                        if any(char in key for char in '*?') and 'deny' in reads.values():
                                            value = 'deny'
                                    reads.pop(key, None)
                                    reads[key] = value
                        output['read'] = reads
        if native or required or external:
            output['external_directory'] = external
        owner['permission'] = output
    if diagnostics:
        result['_paws_skill_access'] = diagnostics
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['overlay', 'finalize'])
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--vault', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--cwd', type=Path)
    parser.add_argument('--worktree', type=Path)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--available-providers')
    parser.add_argument('--selected-agent', help='本次主角色；显式选模时不按其旧静态模型禁用')
    parser.add_argument('--split-edit', action='store_true',
                        help='兼容现有启动器：拆出 edit/read/external_directory，交最终原生配置 hook 合并')
    args = parser.parse_args()
    home, vault = args.home.resolve(), args.vault.resolve()
    if args.command == 'finalize':
        if not args.cwd or not args.worktree or not args.config:
            raise ValueError('finalize requires --cwd, --worktree and --config')
        worktree = validate_worktree(args.cwd, args.worktree)
        envelope = json.load(sys.stdin)
        active = read_config(args.config)
        final = finalize_edit_permissions(envelope['effective'], envelope['overlay'], active, vault, worktree)
        # 原生项目配置和新增角色可在 overlay 后合并；最终层再次收紧同一清单，避免重新放行。
        restrict_config(final, load_manual_policy(vault)[1])
        final = finalize_skill_access(final, envelope['overlay'], active, vault, worktree, home)
        print(json.dumps(final))
        return 0
    if not args.cwd or not args.config:
        raise ValueError('overlay requires --cwd and --config')
    if not args.cwd.resolve(strict=True).is_dir():
        raise ValueError('OpenCode cwd must be a directory')
    active = read_config(args.config)
    _, names = load_manual_policy(vault)
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        raise ValueError('runtime overlay must be an object')
    if args.available_providers is not None:
        narrow_available_providers(data, args.available_providers.split(','), active, args.selected_agent)
    restrict_config(data, names)
    repair_workflow_contract(data, vault)
    print(json.dumps(split_edit_policy(data) if args.split_edit else data))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(2)
