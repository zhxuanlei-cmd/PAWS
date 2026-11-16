import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {buildContextPack, readContextPack, verifyContextPack, writeContextPack} from "../src/context.js";

function legacyVault(): {vault: string; projectDir: string} {
  const vault = mkdtempSync(join(tmpdir(), "paws-context-"));
  const projectDir = join(vault, "10-projects", "demo-project");
  mkdirSync(projectDir, {recursive: true});
  writeFileSync(join(vault, "AGENTS.md"), "# Vault rules\n\nNever push automatically.\n");
  writeFileSync(join(projectDir, "AGENTS.md"), "# Project rules\n\ncode_repo: /tmp/demo-repo\n");
  writeFileSync(join(projectDir, "demo-project-主页.md"), "# Demo project homepage\n");
  writeFileSync(join(projectDir, "spec.md"), "# Stable project dossier\n");
  writeFileSync(join(projectDir, "HANDOFF.md"), `---
type: handoff
project: demo-project
status: active
created: 2026-08-04
updated: 2026-08-04
tags: [test]
source: context test
draft: true
next_action: Verify the context pack
---

# Demo background
`);
  writeFileSync(join(projectDir, "tasks.md"), "# Tasks\n\n- [ ] Verify the context pack\n");
  writeFileSync(join(projectDir, "凭据.md"), "# Credential index\n\n- Name: demo-api\n- Location: macOS Keychain\n- Retrieval: use the project launcher without printing the value\n");
  return {vault, projectDir};
}

test("legacy context pack carries background and credential references but no values", () => {
  const value = legacyVault();
  const now = new Date("2026-08-04T00:00:00Z");
  const pack = buildContextPack({vaultRoot: value.vault, project: "demo-project", now});
  assert.equal(pack.mode, "legacy");
  assert.equal(pack.profile, "summary");
  assert.equal(pack.taskId, null);
  assert.equal(pack.delta.nextAction, "Verify the context pack");
  assert.ok(pack.background.sources.some((source) => source.path.endsWith("凭据.md")));
  assert.ok(pack.background.sources.some((source) => source.path.endsWith("demo-project-主页.md")));
  assert.ok(pack.background.sources.some((source) => source.path.endsWith("spec.md")));
  assert.match(pack.background.digest, /^sha256:/);
  assert.ok(pack.delta.sources.every((source) => !source.path.endsWith("HANDOFF.md")));
  assert.match(JSON.stringify(pack), /macOS Keychain/);
  assert.doesNotMatch(JSON.stringify(pack), /demo-secret-value/);
  const path = join(value.vault, "context-output", "context.json");
  writeContextPack(pack, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const result = verifyContextPack(value.vault, readContextPack(path), new Date("2026-08-04T00:05:00Z"));
  assert.equal(result.valid, true);
  assert.deepEqual(result.semanticIssues, []);
  writeFileSync(join(value.projectDir, "tasks.md"), "# changed\n");
  const changed = verifyContextPack(value.vault, pack, new Date("2026-08-04T00:05:00Z"));
  assert.equal(changed.valid, false);
  assert.deepEqual(changed.changedSources, ["10-projects/demo-project/tasks.md"]);
});

test("summary profile excludes governed history while full profile includes it with a stable digest", () => {
  const value = legacyVault();
  mkdirSync(join(value.projectDir, "decisions"), {recursive: true});
  writeFileSync(join(value.projectDir, "decisions", "design.md"), "# Historical design\n");
  const summary = buildContextPack({vaultRoot: value.vault, project: "demo-project", now: new Date("2026-08-04T00:00:00Z")});
  const full = buildContextPack({
    vaultRoot: value.vault,
    project: "demo-project",
    profile: "full",
    now: new Date("2026-08-04T00:00:00Z")
  });
  assert.equal(summary.background.sources.some((source) => source.path.endsWith("design.md")), false);
  assert.equal(full.background.sources.some((source) => source.path.endsWith("design.md")), true);
  assert.notEqual(summary.background.digest, full.background.digest);
});

test("context verification fails closed on a non-Git HANDOFF baseline when a repository exists", () => {
  const value = legacyVault();
  const repo = mkdtempSync(join(tmpdir(), "paws-context-repo-"));
  writeFileSync(join(repo, "README.md"), "demo\n");
  const git = (args: string[]): void => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {...process.env, GIT_AUTHOR_NAME: "PAWS Test", GIT_AUTHOR_EMAIL: "paws@example.invalid", GIT_COMMITTER_NAME: "PAWS Test", GIT_COMMITTER_EMAIL: "paws@example.invalid"}
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["add", "README.md"]);
  git(["commit", "-qm", "fixture"]);
  const handoffPath = join(value.projectDir, "HANDOFF.md");
  const handoff = readFileSync(handoffPath, "utf8").replace("next_action: Verify the context pack", "next_action: Verify the context pack\nbased_on: NO-GIT-20260804");
  writeFileSync(handoffPath, handoff);
  const pack = buildContextPack({vaultRoot: value.vault, project: "demo-project", repoRoot: repo});
  assert.match(pack.runtime.semanticIssues[0] ?? "", /HANDOFF based_on is not a Git commit/);
  const result = verifyContextPack(value.vault, pack);
  assert.equal(result.valid, false);
  assert.equal(result.semanticIssues.length, 1);
});

test("context pack fails closed when a credential value is present", () => {
  const value = legacyVault();
  writeFileSync(join(value.projectDir, "凭据.md"), "api_key=Abcdefghijklmnop1234567890\n");
  assert.throws(
    () => buildContextPack({vaultRoot: value.vault, project: "demo-project"}),
    /likely secret detected/
  );
});
