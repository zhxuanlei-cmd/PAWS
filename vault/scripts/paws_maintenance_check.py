#!/usr/bin/env python3
"""知识维护角色的固定门禁。无任意命令、路径、参数或凭据接口。"""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def main():
    checks = []
    for name in ['fm_lint.sh', 'check_moc_coverage.sh']:
        result = subprocess.run(['bash', str(ROOT / 'scripts' / name)], cwd=ROOT, capture_output=True, text=True, timeout=50)
        checks.append(dict(check=name, exit_code=result.returncode, output=result.stdout[-12000:]))
    status = subprocess.run(['git', '-C', str(ROOT), 'status', '--porcelain'], capture_output=True, text=True, timeout=10)
    ok = all(item['exit_code'] == 0 for item in checks) and status.returncode == 0
    print(json.dumps(dict(ok=ok, checks=checks, vault_dirty=bool(status.stdout) if status.returncode == 0 else None,
                         sync='read-only; no pull performed'), ensure_ascii=False))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
