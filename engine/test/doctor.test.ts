import assert from "node:assert/strict";
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {resolveVaultDir, schemaDir} from "../src/paths.js";

/** 建立只有 schema 的空 Vault；所有写入均在临时目录，避免诊断触碰真实状态。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-doctor-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "10-projects"), {recursive: true});
  writeFileSync(join(vault, "AGENTS.md"), "# 诊断夹具\n");
  cpSync(schemaDir(resolveVaultDir()), schemaDir(vault), {recursive: true});
  return {root, vault, state: join(root, "state")};
}

/** 通过真正 CLI 子进程检验诊断，而不是只验证内部对象。 */
function doctor(vault: string, state: string) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)),
    "doctor", "--vault", vault, "--state-dir", state, "--json"], {encoding: "utf8"});
}

test("doctor does not initialize missing state, even on a failed validation", () => {
  const {vault, state} = fixture();
  const first = doctor(vault, state);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).stateStatus, "absent");
  assert.equal(JSON.parse(first.stdout).stateMode, null);
  assert.equal(existsSync(state), false);
  // 非完整的严格对象应使检查失败，失败路径同样不得初始化事务缓存。
  writeFileSync(join(vault, "10-projects", "invalid.md"), "---\ntype: task\n---\n");
  assert.notEqual(doctor(vault, state).status, 0);
  assert.equal(existsSync(state), false);
});

test("doctor preserves existing state content, permissions and modification times", () => {
  const {vault, state} = fixture();
  mkdirSync(state, {mode: 0o700});
  const marker = join(state, "marker");
  writeFileSync(marker, "不应被诊断修改\n");
  const before = [statSync(state).mtimeMs, statSync(marker).mtimeMs];
  for (const mode of [0o700, 0o755]) {
    chmodSync(state, mode);
    const result = doctor(vault, state);
    assert.equal(result.status, mode === 0o700 ? 0 : 1, result.stderr);
    assert.equal(statSync(state).mode & 0o777, mode);
    assert.deepEqual([statSync(state).mtimeMs, statSync(marker).mtimeMs], before);
    assert.equal(readFileSync(marker, "utf8"), "不应被诊断修改\n");
    for (const name of ["transactions", "idempotency", "locks"]) assert.equal(existsSync(join(state, name)), false);
  }
  assert.notEqual(doctor(vault, marker).status, 0, "regular files cannot be state directories");
});

test("retired stage entry rejects before reading config and never creates output", () => {
  const {root} = fixture();
  const output = join(root, "generated.json");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)),
    "opencode", "stage", "--config", "/missing/config.json", "--output", output], {encoding: "utf8"});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported opencode subcommand: stage/);
  assert.equal(existsSync(output), false);
});
