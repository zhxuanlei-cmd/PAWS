#!/usr/bin/env bash
# 在一次性 vault 中验证建档、拒绝覆盖和环境发现边界；所有代码仓均为临时 fixture。
# 不调用真实包管理器、不接触共享 Conda 环境，不提交或发布任何内容。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/paws-project-init-test.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

VAULT="$TMP/vault"
mkdir -p "$VAULT/scripts/templates" "$VAULT/10-projects"
cp "$ROOT/scripts/paws_repository.py" "$ROOT/scripts/paws_derived.py" "$ROOT/scripts/project_init.sh" "$ROOT/scripts/repo_snapshot.sh" "$ROOT/scripts/handoff_sync.sh" "$VAULT/scripts/"
cp "$ROOT/scripts/templates/spec.md" "$ROOT/scripts/templates/项目主页.md" "$ROOT/scripts/templates/凭据.md" "$VAULT/scripts/templates/"
chmod +x "$VAULT/scripts/project_init.sh" "$VAULT/scripts/repo_snapshot.sh" "$VAULT/scripts/handoff_sync.sh"

REPO="$TMP/code repo"
"$VAULT/scripts/project_init.sh" demo-project --repo "$REPO" --name '演示项目' >/dev/null
PROJECT="$VAULT/10-projects/demo-project"

for path in \
  AGENTS.md CLAUDE.md HANDOFF.md spec.md tasks.md 凭据.md demo-project-主页.md 仓库状态.md \
  worklog/.gitkeep decisions/.gitkeep; do
  [ -e "$PROJECT/$path" ] || { echo "缺少: $path" >&2; exit 1; }
done
[ ! -e "$PROJECT/evidence" ]
[ ! -e "$PROJECT/experiments" ]

grep -Fq 'project: demo-project' "$PROJECT/spec.md"
grep -Fq '# spec — 演示项目' "$PROJECT/spec.md"
grep -Fq 'code_repo: '"$REPO" "$PROJECT/AGENTS.md"
grep -Fq '![[10-projects/demo-project/spec]]' "$PROJECT/demo-project-主页.md"
! grep -Eq '<项目名称>|project: <项目>|YYYY-MM-DD' "$PROJECT/spec.md" "$PROJECT/demo-project-主页.md"
[ ! -e "$PROJECT/project.md" ]
[ ! -e "$REPO" ]

# 新项目可以从主页进入开发合同，所有生成的页内锚点、现有 Skill 与共享清单入口都能解析。
# 临时 vault 只复制初始化所需脚本和模板；scripts/ 下的共享 Skill、参考与清单按源仓库解析。
python3 - "$VAULT" "$ROOT" "$PROJECT" <<'PY'
from pathlib import Path
import re
import sys

vault, source, project = map(Path, sys.argv[1:])
for page in (project / 'demo-project-主页.md', project / 'spec.md'):
    for link in re.findall(r'\[\[([^\]]+)\]\]', page.read_text()):
        target = link.replace('\\|', '|').split('|', 1)[0]
        path, _, heading = target.partition('#')
        shared = path.startswith('scripts/')
        root = source if shared else vault
        file = root / (path if Path(path).suffix else path + '.md')
        assert file.is_file(), (page.name, target)
        if heading:
            headings = re.findall(r'^#{1,6}\s+(.+)$', file.read_text(), re.M)
            assert heading in headings, (page.name, target)
PY

tree_digest() {
  find "$PROJECT" -type f -print0 | sort -z | xargs -0 shasum | shasum | awk '{print $1}'
}
before="$(tree_digest)"
if "$VAULT/scripts/project_init.sh" demo-project --repo "$REPO" --name '演示项目' >/dev/null 2>&1; then
  echo '目标已存在时应失败' >&2
  exit 1
fi
after="$(tree_digest)"
[ "$before" = "$after" ]

if "$VAULT/scripts/project_init.sh" 'Bad Project' --repo "$REPO" >/dev/null 2>&1; then
  echo '非法 slug 应失败' >&2
  exit 1
fi
[ ! -e "$VAULT/10-projects/Bad Project" ]

# 原生依赖入口应被引用，但内容和代码仓保持不变。这里用只含普通文本的 fixture，
# 覆盖缺目录、空目录、现有 Python/Conda/混合工具链与仓外链接；不把识别当作恢复验证。
python3 - "$VAULT" "$TMP" <<'PY'
from pathlib import Path
import hashlib
import subprocess
import sys

vault, scratch = map(Path, sys.argv[1:])


def snapshot(root):
    """记录 fixture 路径和文件字节；目录新增和既有内容变化都应被发现。"""
    return {
        str(path.relative_to(root)): (
            'directory' if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest()
        )
        for path in root.rglob('*') if not path.is_symlink()
    }


def create(slug, files):
    """建立临时源目录，执行真实建档入口，返回发现单元格和 spec 全文。"""
    repo = scratch / (slug + ' code')
    repo.mkdir()
    for relative, content in files.items():
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    before = snapshot(repo)
    subprocess.run(
        [str(vault / 'scripts/project_init.sh'), slug, '--repo', str(repo)],
        check=True, stdout=subprocess.DEVNULL,
    )
    assert snapshot(repo) == before, f'建档修改了代码/材料仓: {slug}'
    spec = (vault / '10-projects' / slug / 'spec.md').read_text()
    assert '<项目环境定义>' not in spec
    entry = next(line for line in spec.splitlines() if line.startswith('| 环境定义入口 |'))
    return entry, spec


# 缺目录已由上面的主用例覆盖；不生成伪环境，也不要求用户提供环境名。
missing = (vault / '10-projects/demo-project/spec.md').read_text()
assert '代码/材料目录尚不可用' in missing
assert '不要求用户指定本机 Conda 环境名称' in missing

entry, spec = create('python-project', {
    'pyproject.toml': '[project]\nname = "fixture"\n',
    'uv.lock': 'definition-content-must-stay-in-code-repo\n',
    '.python-version': '3.12\n',
    'setup.py': 'raise RuntimeError("must never execute during project init")\n',
})
assert all('`' + name + '`' in entry for name in ('pyproject.toml', 'uv.lock', '.python-version'))
assert 'definition-content-must-stay-in-code-repo' not in spec

entry, spec = create('conda-project', {
    'environment.yml': 'name: legacy-local-name\nprefix: /not-a-project-contract\n',
    'conda-lock.yml': 'fixture-lock\n',
})
assert '`environment.yml`' in entry and '`conda-lock.yml`' in entry
assert 'legacy-local-name' not in spec and '/not-a-project-contract' not in spec

entry, spec = create('mixed-project', {
    'pixi.toml': '[workspace]\n', 'pixi.lock': 'fixture\n',
    'package.json': '{}\n', 'pnpm-lock.yaml': 'fixture\n',
    '.devcontainer/devcontainer.json': '{}\n',
})
assert all('`' + name + '`' in entry for name in (
    'pixi.toml', 'pixi.lock', 'package.json', 'pnpm-lock.yaml', '.devcontainer/devcontainer.json',
))

entry, spec = create('material-project', {'brief.txt': '只制作材料\n'})
assert '未在常见位置识别定义' in entry and '材料项目可注明不适用' in entry

entry, _ = create('nested-project', {'services/api/pyproject.toml': '[project]\n'})
assert '未在常见位置识别定义' in entry and '嵌套目录' in entry

# 父目录软链接也可能跨出代码仓；不能只检查文件自身是否为软链接。
external = scratch / 'external-definition'
external.mkdir()
(external / 'devcontainer.json').write_text('{}\n')
repo = scratch / 'linked code'
repo.mkdir()
(repo / '.devcontainer').symlink_to(external, target_is_directory=True)
subprocess.run(
    [str(vault / 'scripts/project_init.sh'), 'linked-project', '--repo', str(repo)],
    check=True, stdout=subprocess.DEVNULL,
)
spec = (vault / '10-projects/linked-project/spec.md').read_text()
entry = next(line for line in spec.splitlines() if line.startswith('| 环境定义入口 |'))
assert '.devcontainer/devcontainer.json' not in entry
assert (repo / '.devcontainer').is_symlink()
assert (external / 'devcontainer.json').read_text() == '{}\n'
print('PASS: 环境发现覆盖缺目录、Python、Conda、混合依赖、材料、嵌套项目和仓外链接；未改源仓或复制环境正文')
PY

echo 'PASS: 新项目建档完整，不创建代码仓，已存在项目不覆盖'
