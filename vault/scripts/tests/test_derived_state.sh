#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/paws-derived-test.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

VAULT="$TMP/vault"
TMP="$(cd "$TMP" && pwd -P)"
VAULT="$TMP/vault"
TEST_HOME="$TMP/home"
mkdir -p "$VAULT/scripts" "$VAULT/10-projects/demo" "$TEST_HOME/code repo" "$TMP/bin"
cp "$ROOT/scripts/paws_repository.py" "$ROOT/scripts/paws_derived.py" "$ROOT/scripts/repo_snapshot.sh" "$ROOT/scripts/handoff_sync.sh" "$VAULT/scripts/"
chmod +x "$VAULT/scripts/repo_snapshot.sh" "$VAULT/scripts/handoff_sync.sh"

# 伪时钟用于证明“时间已变、状态未变”时文件仍不重写。
cat > "$TMP/bin/date" <<'SH'
#!/bin/sh
case "${1:-}" in
  '+%Y-%m-%d %H:%M') printf '%s\n' "${FAKE_DATE_TIME:-2030-01-01 00:00}" ;;
  '+%Y-%m-%d') printf '%s\n' "${FAKE_DATE:-2030-01-01}" ;;
  *) /bin/date "$@" ;;
esac
SH
chmod +x "$TMP/bin/date"

git -C "$TEST_HOME/code repo" init -q
git -C "$TEST_HOME/code repo" config user.email test@example.invalid
git -C "$TEST_HOME/code repo" config user.name PAWS-Test
printf 'base\n' > "$TEST_HOME/code repo/tracked.txt"
git -C "$TEST_HOME/code repo" add tracked.txt
git -C "$TEST_HOME/code repo" commit -qm init

cat > "$VAULT/10-projects/demo/AGENTS.md" <<'EOF'
# demo
- code_repo: ~/code repo
EOF
cat > "$VAULT/10-projects/demo/HANDOFF.md" <<'EOF'
---
type: handoff
project: demo
status: active
created: 2030-01-01
updated: 2030-01-01
based_on: TODO
next_action: test
draft: auto
---
# HANDOFF — demo

## 下一步
- test
EOF
cat > "$VAULT/10-projects/demo/tasks.md" <<'EOF'
---
type: guide
project: demo
status: active
created: 2030-01-01
updated: 2030-01-01
draft: auto
---
# tasks
- [ ] todo
- [/] in progress
- [~] existing partial marker
- [x] done
- [X] unregistered marker stays TODO in Tasks
- [-] cancelled with reason
EOF

git -C "$VAULT" init -q
git -C "$VAULT" config user.email test@example.invalid
git -C "$VAULT" config user.name PAWS-Test
git -C "$VAULT" add .
git -C "$VAULT" commit -qm baseline

run_snapshot() {
  HOME="$TEST_HOME" PATH="$TMP/bin:$PATH" FAKE_DATE="$1" FAKE_DATE_TIME="$2" \
    "$VAULT/scripts/repo_snapshot.sh" --project demo
}
run_handoff() {
  HOME="$TEST_HOME" PATH="$TMP/bin:$PATH" FAKE_DATE="$1" FAKE_DATE_TIME="$2" \
    "$VAULT/scripts/handoff_sync.sh" --project demo
}

run_snapshot 2030-01-01 '2030-01-01 00:00' >/dev/null
run_handoff 2030-01-01 '2030-01-01 00:00' >/dev/null
grep -Fq '| 待办 | 未完成 4 / 已完成 1 / 已取消 1 |' "$VAULT/10-projects/demo/HANDOFF.md"
git -C "$VAULT" add 10-projects/demo
git -C "$VAULT" commit -qm generated-baseline

second_snapshot="$(run_snapshot 2030-01-02 '2030-01-02 12:34')"
second_handoff="$(run_handoff 2030-01-02 '2030-01-02 12:34')"
git -C "$VAULT" diff --exit-code -- 10-projects/demo/HANDOFF.md 10-projects/demo/仓库状态.md >/dev/null
grep -q '状态未变，未写入' <<<"$second_snapshot"
grep -q '状态未变，未写入' <<<"$second_handoff"
grep -q '2030-01-01 00:00' "$VAULT/10-projects/demo/仓库状态.md"
grep -q '2030-01-01 00:00' "$VAULT/10-projects/demo/HANDOFF.md"

# 真实 Git 状态变化时必须更新。
printf 'dirty\n' >> "$TEST_HOME/code repo/tracked.txt"
run_snapshot 2030-01-03 '2030-01-03 09:00' >/dev/null
run_handoff 2030-01-03 '2030-01-03 09:00' >/dev/null
grep -q 'code_dirty: 1' "$VAULT/10-projects/demo/仓库状态.md"
grep -q '2030-01-03 09:00' "$VAULT/10-projects/demo/仓库状态.md"
grep -q '| 未提交 | 1 个条目' "$VAULT/10-projects/demo/HANDOFF.md"
grep -q '2030-01-03 09:00' "$VAULT/10-projects/demo/HANDOFF.md"

# 两个入口必须产生同一个安全展开后路径。
grep -Fq "code_repo: $TEST_HOME/code repo" "$VAULT/10-projects/demo/仓库状态.md"
grep -Fq "| 代码仓 | \`$TEST_HOME/code repo\` |" "$VAULT/10-projects/demo/HANDOFF.md"

# 惊险路径始终是字面量，不得触发 `$()`。
mkdir -p "$VAULT/10-projects/evil"
MARKER="$TMP/command-was-executed"
printf '# evil\n- code_repo: /tmp/$(touch %s)\n' "$MARKER" > "$VAULT/10-projects/evil/AGENTS.md"
cat > "$VAULT/10-projects/evil/HANDOFF.md" <<'EOF'
---
type: handoff
project: evil
status: active
created: 2030-01-01
updated: 2030-01-01
based_on: TODO
next_action: test
draft: auto
---
# HANDOFF — evil
EOF
HOME="$TEST_HOME" PATH="$TMP/bin:$PATH" "$VAULT/scripts/repo_snapshot.sh" --project evil >/dev/null
HOME="$TEST_HOME" PATH="$TMP/bin:$PATH" "$VAULT/scripts/handoff_sync.sh" --project evil >/dev/null
[ ! -e "$MARKER" ]
grep -Fq '$(touch ' "$VAULT/10-projects/evil/仓库状态.md"
grep -Fq '$(touch ' "$VAULT/10-projects/evil/HANDOFF.md"
! grep -Eq 'eval[[:space:]]+echo' "$VAULT/scripts/handoff_sync.sh"

# 指定项目缺少交接正本时，不能以 exit 0 冒充派生刷新完成。
mkdir -p "$VAULT/10-projects/no-handoff"
printf '# no-handoff\ncode_repo: %s\n' "$TEST_HOME/code repo" > "$VAULT/10-projects/no-handoff/AGENTS.md"
if HOME="$TEST_HOME" PATH="$TMP/bin:$PATH" "$VAULT/scripts/handoff_sync.sh" --project no-handoff >"$TMP/missing-handoff.log" 2>&1; then
  echo 'FAIL: missing HANDOFF was silently accepted' >&2
  exit 1
fi
grep -q 'HANDOFF' "$TMP/missing-handoff.log"
[ ! -e "$VAULT/10-projects/no-handoff/HANDOFF.md" ]

# Git 局部读取失败时，派生字段不能把“未知”再猜成 detached/无提交。
TEST_GIT_REAL="$(command -v git)"
cat > "$TMP/bin/git" <<'SH'
#!/usr/bin/env bash
if [[ "${PAWS_TEST_GIT_FAULT:-}" == branch && "$*" == *symbolic-ref* ]] ||
   [[ "${PAWS_TEST_GIT_FAULT:-}" == head && "$*" == *--verify* && "${!#}" == HEAD ]] ||
   [[ "${PAWS_TEST_GIT_FAULT:-}" == log && "$*" == *" log "* ]]; then
  echo 'fatal: simulated read failure' >&2
  exit 128
fi
exec "$PAWS_TEST_GIT_REAL" "$@"
SH
chmod +x "$TMP/bin/git"
for git_fault in branch head; do
  HOME="$TEST_HOME" PATH="$TMP/bin:$PATH" PAWS_TEST_GIT_REAL="$TEST_GIT_REAL" PAWS_TEST_GIT_FAULT="$git_fault" \
    "$VAULT/scripts/repo_snapshot.sh" --project demo >/dev/null
  grep -q '^code_state: unreadable$' "$VAULT/10-projects/demo/仓库状态.md"
  grep -q '^code_head_state: unknown$' "$VAULT/10-projects/demo/仓库状态.md"
  if ! grep -q "^code_${git_fault}: null$" "$VAULT/10-projects/demo/仓库状态.md"; then
    echo "FAIL: unreadable $git_fault was not preserved as null in snapshot" >&2
    exit 1
  fi
done

# 已有 HEAD 时提交列表读取失败必须停止刷新，并逐字节保留已有快照。
HOME="$TEST_HOME" PATH="$TMP/bin:$PATH" PAWS_TEST_GIT_REAL="$TEST_GIT_REAL" \
  "$VAULT/scripts/repo_snapshot.sh" --project demo >/dev/null
cp "$VAULT/10-projects/demo/仓库状态.md" "$TMP/before-log-failure.md"
if HOME="$TEST_HOME" PATH="$TMP/bin:$PATH" PAWS_TEST_GIT_REAL="$TEST_GIT_REAL" PAWS_TEST_GIT_FAULT=log \
   "$VAULT/scripts/repo_snapshot.sh" --project demo >"$TMP/log-failure.log" 2>&1; then
  echo 'FAIL: unreadable git log was silently accepted' >&2
  exit 1
fi
grep -q 'git log unreadable' "$TMP/log-failure.log"
cmp -s "$TMP/before-log-failure.md" "$VAULT/10-projects/demo/仓库状态.md"

# 无提交仓仍是正常状态，无须调用必然失败的 git log。
mkdir -p "$TEST_HOME/unborn" "$VAULT/10-projects/unborn"
"$TEST_GIT_REAL" -C "$TEST_HOME/unborn" init -q
printf '# unborn\ncode_repo: %s\n' "$TEST_HOME/unborn" > "$VAULT/10-projects/unborn/AGENTS.md"
HOME="$TEST_HOME" PATH="$TMP/bin:$PATH" PAWS_TEST_GIT_REAL="$TEST_GIT_REAL" PAWS_TEST_GIT_FAULT=log \
  "$VAULT/scripts/repo_snapshot.sh" --project unborn >/dev/null
grep -q '^code_state: ok$' "$VAULT/10-projects/unborn/仓库状态.md"
grep -q '^code_head_state: unborn$' "$VAULT/10-projects/unborn/仓库状态.md"

echo 'PASS: 路径解析安全，两入口一致，无变化不写入，缺交接报错，读取失败保留未知'
