#!/usr/bin/env python3
"""仓库快照与 HANDOFF 派生区共用状态；未知值保留，不修改人的判断区。"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from paws_repository import SLUG, ResolutionError, code_repo, git, repo_state, resolve_project

ROOT = Path(__file__).resolve().parent.parent
BEGIN = '<!-- paws:handoff:derived:start -->'
END = '<!-- paws:handoff:derived:end -->'


def now(fmt):
    # 保留现有测试的可控观测时钟；时间不参与语义比较。
    return subprocess.check_output(['date', '+' + fmt], text=True).strip()


def scalar(value):
    if value is None:
        return 'null'
    if isinstance(value, (bool, int)):
        return json.dumps(value)
    if ': ' in str(value) or any(c in str(value) for c in '\n\r#{}[]'):
        return json.dumps(str(value), ensure_ascii=False)
    return str(value)


def normalized(text):
    text = re.sub(r'(?m)^(updated|snapshot_at):.*$', r'\1: <time>', text)
    text = re.sub(r'(?m)^(> 状态记录时间:).*$', r'\1<time>', text)
    return re.sub(r'(?m)^\| 状态记录时间 \|.*$', '| 状态记录时间 | <time> |', text)


def write_changed(target, text):
    old = target.read_text(encoding='utf-8') if target.exists() else ''
    if normalized(old) == normalized(text):
        print('= ' + str(target.relative_to(ROOT)) + ' 状态未变，未写入')
        return
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix='.paws-derived-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    print('✓ ' + str(target.relative_to(ROOT)))


def display(value):
    return '未知' if value is None else str(value)


def refresh(slug, mode, cwd=None):
    p = ROOT / '10-projects' / slug
    repo = code_repo(ROOT, slug)
    if cwd:
        resolved = resolve_project(ROOT, cwd)
        if not resolved or resolved['project'] != slug:
            raise ResolutionError('cwd does not identify the requested project')
        repo = Path(resolved['checkout'])
    state = repo_state(repo)
    when = now('%Y-%m-%d %H:%M')
    head, branch = state['head'], state['branch']
    branch_label = branch or ('detached' if state['head_state'] == 'detached' else '—')
    upstream = (str(state['unpushed']) + ' 个提交') if state['unpushed'] is not None else '未知（' + state['upstream_state'] + '）'
    if mode == 'snapshot':
        fm = dict(type='repostate', project=slug, status='active', updated=now('%Y-%m-%d'), snapshot_at=when,
                  code_repo=str(repo) if repo else None, code_state=state['state'],
                  code_head=head or ('none' if state['head_state'] == 'unborn' else None),
                  code_branch=branch or ('detached' if state['head_state'] == 'detached' else None),
                  code_head_state=state['head_state'],
                  code_dirty=state['dirty'], code_unpushed=state['unpushed'], code_behind=state['behind'],
                  code_has_remote=state['has_remote'], code_upstream=state['upstream'],
                  code_upstream_state=state['upstream_state'], code_common_dir=state['common_dir'],
                  source='repo_snapshot.sh', draft='auto')
        recent = git(repo, 'log', '--oneline', '-8', strict=True) if head else None
        text = '---\n' + '\n'.join(k + ': ' + scalar(v) for k, v in fm.items()) + '\ntags: [repostate, 派生]\n---\n'
        text += f'# 仓库状态 — {slug}\n\n> **派生文件，由 `scripts/repo_snapshot.sh` 整文件重写，勿手改。**\n'
        text += f'> 状态记录时间:{when} —— 每次重读 Git，语义状态改变时才更新。\n\n'
        text += '| 仓库 | 分支 | HEAD | 未提交 | 未推送 |\n|---|---|---|---|---|\n'
        text += f'| 代码 `{repo}` | {branch_label} | `{head or "—"}` | {display(state["dirty"])} | {upstream} |\n\n'
        text += '## 代码仓最近提交\n' + ('\n'.join('- `' + line + '`' for line in recent.splitlines()) if recent else '- （无提交或无法读取；以 code_state 为准）') + '\n'
        write_changed(p / '仓库状态.md', text)
        return
    target = p / 'HANDOFF.md'
    if not target.exists():
        raise ResolutionError('HANDOFF.md is missing for project ' + slug + '; derived state was not refreshed')
    old = target.read_text(encoding='utf-8')
    m = re.search(r'^based_on:\s*(.*?)\s*$', old, re.M)
    baseline = m.group(1).strip('\"\'') if m else ''
    drift = '—'
    if state['state'] != 'ok':
        drift = '仓库状态未知（' + state['state'] + '），不得据此判定无提交'
    elif state['head_state'] == 'unborn':
        drift = '代码仓无提交历史，无法比较提交基线'
    elif re.fullmatch(r'[a-fA-F0-9]{7,40}', baseline):
        counts = git(repo, 'rev-list', '--left-right', '--count', baseline + '...HEAD')
        if counts and re.fullmatch(r'\d+\s+\d+', counts):
            left, right = map(int, counts.split())
            drift = '对齐' if left == right == 0 else f'基线独有 {left} / 当前独有 {right} 个提交 —— 核对分支与 worklog'
        else:
            drift = '基线 sha 无法读取 —— 需人工核对'
    tasks = (p / 'tasks.md').read_text(encoding='utf-8') if (p / 'tasks.md').exists() else ''
    # 与 Tasks 默认状态一致：完成/取消不进入有效待办，其余标记（含进行中）保持未完成。
    task_states = re.findall(r'^\s*[-*+] \[(.)\] ', tasks, re.M)
    done = task_states.count('x')
    cancelled = task_states.count('-')
    todo = len(task_states) - done - cancelled
    logs = sorted((p / 'worklog').glob('*.md'))
    values = [('代码仓', f'`{repo or "（未声明 code_repo）"}`'), ('仓库状态', state['state']),
              ('分支@HEAD', f'{branch_label}@{head or "（无提交或未知）"}'),
              ('未提交', display(state['dirty']) + ' 个条目（未跟踪目录折叠计数）'),
              ('未推送', upstream), ('HANDOFF 基线', f'`{baseline or "（未填）"}`'), ('基线漂移', drift),
              ('待办', f'未完成 {todo} / 已完成 {done} / 已取消 {cancelled}'), ('最近 worklog', logs[-1].stem if logs else '无'),
              ('状态记录时间', when)]
    block = BEGIN + '\n> **本区由 `scripts/handoff_sync.sh` 生成；状态变化时更新。不要手改。**\n> 判断性内容写在本区之外。\n\n| 项 | 值 |\n|---|---|\n'
    block += '\n'.join(f'| {k} | {v} |' for k, v in values) + '\n' + END
    if BEGIN in old and END in old:
        text = re.sub(re.escape(BEGIN) + '.*?' + re.escape(END), lambda _: block, old, count=1, flags=re.S)
    else:
        title = re.search(r'^#\s+.*$', old, re.M)
        pos = title.end() if title else len(old)
        text = old[:pos] + '\n\n' + block + '\n' + old[pos:]
    write_changed(target, text)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('mode', choices=['snapshot', 'handoff'])
    group = ap.add_mutually_exclusive_group()
    group.add_argument('--project')
    group.add_argument('--all', action='store_true')
    ap.add_argument('--cwd', help='观察实际会话 checkout；省略则观察项目声明的默认仓库')
    args = ap.parse_args()
    if args.mode == 'handoff' and not args.project and not args.all:
        ap.error('handoff requires --project or --all')
    if args.project and not SLUG.fullmatch(args.project):
        ap.error('invalid project id')
    if args.cwd and not args.project:
        ap.error('--cwd requires --project')
    projects = [args.project] if args.project else sorted(p.name for p in (ROOT / '10-projects').iterdir() if p.is_dir() and SLUG.fullmatch(p.name))
    for project in projects:
        refresh(project, args.mode, args.cwd)


if __name__ == '__main__':
    main()
