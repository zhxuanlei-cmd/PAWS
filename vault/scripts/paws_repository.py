#!/usr/bin/env python3
"""PAWS 仓库身份与 Git 状态的唯一解析器；只读，标准库，无 shell/eval。"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{0,62}$')


class ResolutionError(ValueError):
    def __init__(self, message, projects=None):
        super().__init__(message)
        self.projects = projects


class GitReadError(ResolutionError):
    pass


def git(path, *args, binary='git', strict=False, expected_codes=(), allow_not_repository=False):
    try:
        p = subprocess.run([binary, '-c', 'core.quotepath=false', '-C', str(path), *args], text=True,
                           capture_output=True, timeout=10, env=dict(os.environ, LC_ALL='C'))
    except (OSError, subprocess.TimeoutExpired) as error:
        if strict:
            raise GitReadError('git ' + args[0] + ' unreadable (' + type(error).__name__ + ')') from error
        return None
    if p.returncode == 0:
        return p.stdout.strip()
    if p.returncode in expected_codes:
        return None
    if allow_not_repository and p.returncode == 128 and p.stderr.startswith('fatal: not a git repository'):
        # 真正无 Git 的目录可正常返回；损坏的 .git/worktree 指针不是“未登记”。
        root = Path(path).resolve()
        if not any((ancestor / '.git').exists() or (ancestor / '.git').is_symlink() for ancestor in (root, *root.parents)):
            return None
    if strict:
        # 不转发 stderr：错误文本可能包含凭据、remote 或配置内容。
        raise GitReadError('git ' + args[0] + ' unreadable (exit ' + str(p.returncode) + ')')
    return None


def inside(path, root):
    return path == root or root in path.parents


def parse_path(raw, home=None):
    raw = raw.strip()
    if len(raw) > 1 and raw[0] == raw[-1] and raw[0] in '\"\'`':
        raw = raw[1:-1].strip()
    if not raw or 'TODO' in raw or any(ord(c) < 32 for c in raw):
        return None
    if raw == '~' or raw.startswith('~/'):
        raw = str(home or Path.home()) + raw[1:]
    path = Path(raw)
    return path.resolve() if path.is_absolute() else None


def device_repositories(device=None):
    path = Path(device or os.environ.get('PAWS_DEVICE_CONFIG', str(Path.home() / '.config/paws-oss/device.json')))
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        values = data.get('repositories', {})
        if data.get('schema_version') != 1 or data.get('managed_by') != 'paws_setup' or not isinstance(values, dict):
            raise ValueError()
        if any(not SLUG.fullmatch(k) or not isinstance(v, str) or parse_path(v) is None for k, v in values.items()):
            raise ValueError()
        return values
    except (ValueError, OSError):
        raise ResolutionError('invalid device repository map')


def code_repo(vault, project, *, home=None, device=None):
    if not SLUG.fullmatch(project):
        raise ResolutionError('invalid project id')
    overrides = device_repositories(device)
    if project in overrides:
        return parse_path(overrides[project], home)
    agents = Path(vault) / '10-projects' / project / 'AGENTS.md'
    if not agents.is_file():
        return None
    m = re.search(r'^\s*[-*]?\s*`?code_repo`?\s*[:：]\s*(.+?)\s*$',
                  agents.read_text(encoding='utf-8'), re.M | re.I)
    return parse_path(m.group(1), home) if m else None


def common_dir(path, binary='git'):
    result = git(path, 'rev-parse', '--git-common-dir', binary=binary, strict=True, allow_not_repository=True)
    return str((Path(path) / result).resolve()) if result else None


def resolve_project(vault, cwd, *, home=None, device=None, binary='git'):
    vault, cwd = Path(vault).resolve(), Path(cwd).resolve()
    if not cwd.is_dir() or not (vault / '10-projects').is_dir():
        raise ResolutionError('working directory or vault projects directory is missing')
    current_common = common_dir(cwd, binary)
    matches = []
    unreadable_candidates = []
    for p in sorted((vault / '10-projects').iterdir()):
        if not p.is_dir() or not SLUG.fullmatch(p.name):
            continue
        repo = code_repo(vault, p.name, home=home, device=device)
        if not repo or not repo.is_dir():
            continue
        path_match = inside(cwd, repo)
        try:
            repo_common = common_dir(repo, binary)
        except GitReadError as error:
            if path_match:
                raise GitReadError('related project repository is unreadable: ' + str(error), [p.name]) from error
            # 无关候选的损坏不阻断已确认的匹配；未找到匹配时仍保留定位未决状态。
            unreadable_candidates.append(dict(project=p.name, error=str(error)))
            continue
        if path_match and current_common != repo_common:
            raise ResolutionError('working directory is an independent nested repository', [p.name])
        git_match = current_common is not None and current_common == repo_common
        if path_match or git_match:
            checkout = git(cwd, 'rev-parse', '--show-toplevel', binary=binary, strict=True,
                           allow_not_repository=current_common is None)
            matches.append(dict(project=p.name, projectDir=str(p), codeRepo=str(repo), cwd=str(cwd),
                                checkout=str(Path(checkout).resolve()) if checkout else str(repo),
                                matchedBy='path' if path_match else 'git-common-dir', gitCommonDir=repo_common))
    if len(matches) > 1:
        raise ResolutionError('working directory maps to multiple PAWS projects', [m['project'] for m in matches])
    if matches:
        if unreadable_candidates:
            matches[0]['warnings'] = unreadable_candidates
        return matches[0]
    if unreadable_candidates:
        raise GitReadError('working directory project is unresolved: registered repository identities are unreadable',
                           [candidate['project'] for candidate in unreadable_candidates])
    return None


def repo_state(path, binary='git'):
    path = Path(path).resolve() if path else None
    state = dict(path=str(path) if path else None, state='undeclared', head=None, branch=None,
                 head_state='unknown', dirty=None, unpushed=None, behind=None, has_remote=None,
                 upstream=None, upstream_state='unknown', common_dir=None, checkout=None)
    if path is None:
        return state
    if not path.is_dir():
        state['state'] = 'missing'
        return state
    errors = []

    def unreadable(reason):
        state['state'] = 'unreadable'
        errors.append(reason)
        state['errors'] = errors

    def read(*args, **kwargs):
        try:
            return git(path, *args, binary=binary, strict=True, **kwargs)
        except GitReadError as error:
            unreadable(str(error))
            return None

    valid = read('rev-parse', '--is-inside-work-tree', allow_not_repository=True)
    if valid != 'true':
        if not errors:
            state['state'] = 'not-repository' if valid is None else 'bare'
        return state
    state['state'] = 'ok'
    common = read('rev-parse', '--git-common-dir')
    state['common_dir'] = str((path / common).resolve()) if common else None
    state['checkout'] = read('rev-parse', '--show-toplevel')
    before_head = len(errors)
    state['head'] = read('rev-parse', '--verify', '--quiet', '--short', 'HEAD', expected_codes=(1,))
    state['branch'] = read('symbolic-ref', '--quiet', '--short', 'HEAD', expected_codes=(1,))
    if len(errors) == before_head:
        if state['head']:
            state['head_state'] = 'attached' if state['branch'] else 'detached'
        elif state['branch']:
            ref = read('show-ref', '--verify', '--quiet', 'refs/heads/' + state['branch'], expected_codes=(1,))
            if len(errors) == before_head and ref is None:
                state['head_state'] = 'unborn'
            elif len(errors) == before_head:
                unreadable('HEAD cannot be read from the existing branch')
        else:
            unreadable('HEAD is missing without an unborn branch')
    status = read('status', '--porcelain')
    state['dirty'] = len([line for line in status.splitlines() if not line.endswith('仓库状态.md')]) if status is not None else None
    remotes = read('remote')
    state['has_remote'] = bool(remotes) if remotes is not None else None
    # for-each-ref 对无 upstream 返回成功的空值；失败不会再被当作“无上游”。
    upstream = read('for-each-ref', '--format=%(upstream:short)', 'refs/heads/' + state['branch']) if state['branch'] else ''
    state['upstream'] = upstream or None
    if state['upstream']:
        counts = read('rev-list', '--left-right', '--count', '@{u}...HEAD')
        if counts and re.fullmatch(r'\d+\s+\d+', counts):
            state['behind'], state['unpushed'] = map(int, counts.split())
            state['upstream_state'] = 'tracked'
        else:
            state['upstream_state'] = 'unreadable'
            if counts is not None:
                unreadable('git rev-list returned invalid upstream counts')
    else:
        if upstream is None:
            state['upstream_state'] = 'unreadable'
        elif state['branch'] or state['head_state'] == 'detached':
            state['upstream_state'] = 'no-upstream'
    return state


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--vault', default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument('--cwd')
    ap.add_argument('--project')
    ap.add_argument('--home')
    ap.add_argument('--device')
    ap.add_argument('--git-binary', default='git')
    args = ap.parse_args()
    try:
        if args.project:
            value = repo_state(code_repo(args.vault, args.project, home=args.home, device=args.device), binary=args.git_binary)
        else:
            value = resolve_project(args.vault, args.cwd or os.getcwd(), home=args.home, device=args.device, binary=args.git_binary)
        print(json.dumps(value, ensure_ascii=False))
        return 0
    except ResolutionError as error:
        print(json.dumps({'error': str(error), 'projects': error.projects}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
