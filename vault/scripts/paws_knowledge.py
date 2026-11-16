#!/usr/bin/env python3
"""里程碑候选与 Skill 发布；只自动提候选，批准绑定审阅包摘要。无需模型/API。"""
from __future__ import annotations
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

from paws_lock import record_lock
from paws_repository import SLUG, inside


def digest(data):
    return hashlib.sha256(data).hexdigest()


def frontmatter(path):
    text = path.read_text(encoding='utf-8')
    match = re.match(r'^---\n(.*?)\n---(?:\n|$)', text, re.S)
    if not match:
        raise ValueError('missing frontmatter: ' + path.name)
    fields = {}
    # 此接口使用标量和单行 JSON 数组/对象；拒绝关键字段使用未支持的 YAML 表达式。
    for line in match.group(1).splitlines():
        m = re.match(r'^([a-z_][a-z0-9_-]*):\s*(.*?)\s*$', line)
        if not m:
            continue
        key, raw = m.groups()
        if key in fields:
            raise ValueError('duplicate frontmatter key')
        try:
            fields[key] = json.loads(raw)
        except ValueError:
            fields[key] = raw.strip('\"\'')
    return fields, text


def markdown(fields, body):
    def value(v):
        if isinstance(v, str) and re.fullmatch(r'[a-z0-9/-]+', v):
            return v
        return json.dumps(v, ensure_ascii=False)
    return '---\n' + '\n'.join(k + ': ' + value(v) for k, v in fields.items()) + '\n---\n' + body


def atomic(path, data):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.paws-')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def safe_source(vault, relative, seen=None):
    seen = {} if seen is None else seen
    if not isinstance(relative, str) or Path(relative).is_absolute():
        raise ValueError('evidence must use vault-relative paths')
    p = vault / relative
    if not inside(p.resolve(), vault) or p.is_symlink() or not p.is_file():
        raise ValueError('evidence missing or outside vault')
    rel = p.resolve().relative_to(vault).as_posix()
    if not re.fullmatch(r'10-projects/[a-z0-9-]+/(worklog|decisions|evidence)/[^/]+\.md', rel):
        raise ValueError('automatic candidates accept local project records only')
    if rel in seen:
        return seen
    data, text = frontmatter(p)
    if data.get('source_kind') != 'local-project':
        raise ValueError('evidence requires explicit local-project provenance')
    if re.search(r'https?://|00-inbox/|30-resources/literature/|[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]', text):
        raise ValueError('external or hidden-control content is excluded from automatic promotion')
    seen[rel] = digest(p.read_bytes())
    links = data.get('evidence', [])
    if not isinstance(links, list):
        raise ValueError('evidence must be a one-line JSON array')
    # 普通双链也构成溯源依赖：自动通道要求明确的相对路径，不能静默跳过。
    links = links + [m.split('|')[0].split('#')[0] for m in re.findall(r'\[\[([^\]]+)\]\]', text)]
    for link in links:
        safe_source(vault, link if link.endswith('.md') else link + '.md', seen)
    return seen


def scan(vault, project=None):
    if project and not SLUG.fullmatch(project):
        raise ValueError('invalid project id')
    queue = vault / 'memory/agent/candidates'
    created, existing, rejected = [], [], []
    pattern = (project or '*') + '/worklog/*.md'
    for source in sorted((vault / '10-projects').glob(pattern)):
        fields, _ = frontmatter(source)
        if fields.get('milestone_status') != 'done':
            continue
        relative = source.relative_to(vault).as_posix()
        try:
            if fields.get('project') != source.parent.parent.name or not SLUG.fullmatch(fields.get('project', '')):
                raise ValueError('milestone project must match its canonical directory')
            milestone = fields.get('milestone_id', '')
            summary = fields.get('summary', '')
            if not SLUG.fullmatch(milestone) or not isinstance(summary, str) or not summary.strip() or not fields.get('evidence'):
                raise ValueError('completed milestone requires id, summary and evidence')
            sources = safe_source(vault, relative)
            fingerprint = digest(json.dumps(sources, sort_keys=True).encode())
            ident = fields['project'] + '-' + milestone + '-' + fingerprint[:12]
            queue.mkdir(parents=True, exist_ok=True)
            target = queue / (ident + '.md')
            with record_lock(target):
                if target.exists():
                    existing.append(ident)
                    continue
                date = datetime.date.today().isoformat()
                item = dict(type='guide', project=fields['project'], status='draft', created=date, updated=date,
                            tags=['经验候选'], source='milestone-scan', draft=True, candidate_kind='experience',
                            milestone_id=milestone, source_digest=fingerprint, evidence=list(sources), source_hashes=sources)
                body = '# 待核验经验候选\n\n' + summary + '\n\n'
                body += '自动捕获完成记录中的摘要，尚未证明跨任务可复用。审阅时检查重复知识、反例、适用范围与独立验证。\n'
                body += '\n'.join('- `' + link + '`' for link in sources) + '\n'
                atomic(target, markdown(item, body).encode())
                created.append(ident)
        except (ValueError, KeyError) as e:
            rejected.append({'source': relative, 'reason': str(e)})
    return dict(created=created, existing=existing, rejected=rejected)


def bundle(vault, ident):
    if not re.fullmatch(r'[a-z0-9-]{1,180}', ident):
        raise ValueError('invalid candidate id')
    base = vault / 'memory/agent/candidates'
    candidate = base / (ident + '.md')
    fields, _ = frontmatter(candidate)
    expected = fields.get('source_hashes')
    current = {}
    for source in fields.get('evidence', []):
        safe_source(vault, source, current)
    if not expected or expected != current:
        raise ValueError('candidate evidence changed; rescan before review')
    folder = base / ident
    skill = folder / 'skill'
    if candidate.is_symlink() or folder.is_symlink() or skill.is_symlink() or not inside(skill.resolve(), vault):
        raise ValueError('candidate bundle must be inside vault without symlinks')
    meta, _ = frontmatter(skill / 'SKILL.md')
    name = meta.get('name', '')
    if not isinstance(name, str) or not re.fullmatch(r'paws-[a-z0-9]+(?:-[a-z0-9]+)*', name) or len(name) > 64:
        raise ValueError('skill name must be a valid paws- name')
    if not isinstance(meta.get('description'), str) or not meta['description'].strip() or len(meta['description']) > 1024:
        raise ValueError('skill requires a concrete trigger description')
    if set(meta) - {'name', 'description', 'license', 'allowed-tools', 'metadata'}:
        raise ValueError('unsupported Agent Skills frontmatter')
    review, _ = frontmatter(folder / 'review.md')
    for key in ['scope', 'counterexample', 'validation', 'duplicate_check']:
        if not review.get(key) or review[key] == '待确认':
            raise ValueError('review requires ' + key)
    files = {}
    for path in sorted(skill.rglob('*')):
        if path.is_symlink() or not inside(path.resolve(), skill.resolve()):
            raise ValueError('skill bundle cannot contain symlinks')
        if path.is_file():
            rel = path.relative_to(skill).as_posix()
            if rel == 'PUBLICATION.json':
                raise ValueError('reserved publication receipt filename')
            if any(part.startswith('.') for part in path.relative_to(skill).parts):
                raise ValueError('hidden files are not publishable')
            files[rel] = digest(path.read_bytes())
    package = dict(candidate=ident, name=name, files=files, sources=current,
                   candidate_hash=digest(candidate.read_bytes()), review_hash=digest((folder / 'review.md').read_bytes()))
    package['digest'] = digest(json.dumps(package, sort_keys=True).encode())
    return package, skill


def prepare(vault, ident):
    package, _ = bundle(vault, ident)
    request = vault / 'memory/agent/candidates' / ident / 'approval-request.json'
    atomic(request, (json.dumps(package, ensure_ascii=False, indent=2) + '\n').encode())
    return package


def publish(vault, ident, approval):
    approval = Path(approval).resolve()
    decision_root = (vault / 'memory/agent/approvals').resolve()
    if not inside(decision_root, vault) or not inside(approval, decision_root) or not approval.is_file():
        raise ValueError('approval must be a local human decision under memory/agent/approvals')
    auth, _ = frontmatter(approval)
    if auth.get('decision') != 'approve' or auth.get('source') != 'user-approval' or not auth.get('approved_by') or not auth.get('approval_ref'):
        raise ValueError('explicit human approval record required')
    with record_lock(vault / 'paws.manifest.json'):
        package, skill = bundle(vault, ident)
        if auth.get('approved_digest') != package['digest']:
            raise ValueError('approval does not match the current reviewed bundle')
        manifest_path = vault / 'paws.manifest.json'
        manifest = json.loads(manifest_path.read_text())
        canonical = vault / manifest['skills']['source_root'] / package['name']
        if not inside(canonical.resolve(), vault / 'scripts/skills'):
            raise ValueError('canonical skill root must be scripts/skills')
        if canonical.exists():
            receipt = canonical / 'PUBLICATION.json'
            if package['name'] in manifest['skills']['names'] and receipt.is_file():
                previous = json.loads(receipt.read_text())
                actual = {p.relative_to(canonical).as_posix(): digest(p.read_bytes()) for p in canonical.rglob('*') if p.is_file() and p.name != 'PUBLICATION.json'}
                if previous.get('digest') == package['digest'] and actual == package['files']:
                    return dict(published=package['name'], changed=False)
            raise ValueError('existing canonical skill is never overwritten')
        if package['name'] in manifest['skills']['names']:
            raise ValueError('inconsistent manifest registration')
        canonical.parent.mkdir(parents=True, exist_ok=True)
        temp = Path(tempfile.mkdtemp(prefix='.publish-', dir=canonical.parent))
        moved = False
        try:
            shutil.copytree(skill, temp, dirs_exist_ok=True)
            # 写前重验，避免复制期间改变审阅内容。
            copied = {p.relative_to(temp).as_posix(): digest(p.read_bytes()) for p in temp.rglob('*') if p.is_file()}
            if copied != package['files']:
                raise ValueError('skill changed during publication')
            (temp / 'PUBLICATION.json').write_text(json.dumps(dict(package, approval=approval.relative_to(vault).as_posix()), ensure_ascii=False, indent=2) + '\n')
            os.rename(temp, canonical)
            moved = True
            manifest['skills']['names'].append(package['name'])
            atomic(manifest_path, (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode())
        except BaseException:
            if moved:
                shutil.rmtree(canonical)
            raise
        finally:
            if temp.exists():
                shutil.rmtree(temp)
    return dict(published=package['name'], changed=True, next='node scripts/paws_setup.mjs plan --host <host>')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('command', choices=['scan', 'prepare', 'publish'])
    ap.add_argument('--vault', default=os.environ.get('VAULT_DIR', str(Path(__file__).resolve().parent.parent)))
    ap.add_argument('--project')
    ap.add_argument('--candidate')
    ap.add_argument('--approval')
    args = ap.parse_args()
    vault = Path(args.vault).resolve()
    try:
        if args.command == 'scan':
            result = scan(vault, args.project)
        elif args.command == 'prepare':
            result = prepare(vault, args.candidate or '')
        else:
            if not args.approval:
                raise ValueError('--approval is required; approval cannot be inferred from implementation authorization')
            result = publish(vault, args.candidate or '', args.approval)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result.get('rejected') else 0
    except (ValueError, OSError) as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    sys.exit(main())
