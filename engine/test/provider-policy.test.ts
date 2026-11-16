import assert from "node:assert/strict";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {PawsError} from "../src/errors.js";
import {resolveVaultDir} from "../src/paths.js";
import {
  BASELINE_PROVIDER,
  buildRuntimeOverlay,
  resolveProjectForCwd,
  resolveProviderPolicy,
  type OpenCodeRuntimeOverlay
} from "../src/provider-policy.js";

const REVIEW_PROVIDER_PORTFOLIO = [BASELINE_PROVIDER, "deepseek", "zhipuai"] as const;

interface Fixture {
  root: string;
  vault: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "paws-provider-policy-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "10-projects"), {recursive: true});
  mkdirSync(join(vault, "scripts"));
  copyFileSync(join(resolveVaultDir(), "scripts", "paws_repository.py"), join(vault, "scripts", "paws_repository.py"));
  writeFileSync(join(vault, "AGENTS.md"), "# Test vault\n");
  return {root, vault};
}

function addProject(vault: string, project: string, codeRepo: string, policy?: string, listStyle = false): string {
  const projectDir = join(vault, "10-projects", project);
  mkdirSync(projectDir, {recursive: true});
  writeFileSync(
    join(projectDir, "AGENTS.md"),
    `# ${project}\n\n${listStyle ? "- " : ""}code_repo: ${codeRepo}\n`
  );
  if (policy !== undefined) writeFileSync(join(projectDir, "execution-policy.md"), policy);
  return projectDir;
}

function policy(project: string, providers: string[], harnesses = ["opencode"]): string {
  return `---
schema_version: "1.1"
type: policy
project: ${project}
status: active
created: 2026-08-17
updated: 2026-08-17
tags: [test]
source: provider policy test
draft: true
policy_id: ${project}/default
project_code: TEST
consistency_mode: local_strong
data_class: internal
allowed_harnesses: [${harnesses.join(", ")}]
allowed_providers: [${providers.join(", ")}]
max_parallel_write_tasks: 1
auto_commit: false
auto_push: false
migration_mode: shadow
gates: {}
---

# Test policy
`;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "PAWS Test",
      GIT_AUTHOR_EMAIL: "paws-test@example.invalid",
      GIT_COMMITTER_NAME: "PAWS Test",
      GIT_COMMITTER_EMAIL: "paws-test@example.invalid"
    }
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(targetInput: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const target = structuredClone(targetInput);
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    target[key] = isRecord(existing) && isRecord(value)
      ? deepMerge(existing, value)
      : structuredClone(value);
  }
  return target;
}

function agentConfig(overlay: OpenCodeRuntimeOverlay, name: string): Record<string, unknown> {
  const value = overlay.agent[name];
  assert.ok(isRecord(value), `missing agent config: ${name}`);
  return value;
}

function permission(config: Record<string, unknown>): Record<string, unknown> {
  const value = config.permission;
  assert.ok(isRecord(value), "missing permission object");
  return value;
}

function taskPermission(config: Record<string, unknown>): Record<string, unknown> {
  const value = permission(config).task;
  assert.ok(isRecord(value), "missing task permission object");
  return value;
}

function routingTaskPolicy(glm: "allow" | "deny", deepseek: "allow" | "deny"): Record<string, string> {
  return {
    "*": "deny",
    "paws-review": "allow",
    "paws-explore": "allow",
    "paws-scout": "allow",
    "paws-review-glm": glm,
    "paws-review-deepseek": deepseek
  };
}

function assertCurrentWorkspaceCredentialDeny(config: Record<string, unknown>): void {
  const read = permission(config).read;
  assert.ok(isRecord(read), "current-workspace reviewer must have patterned read permissions");
  assert.equal(read["*"], "allow");
  for (const pattern of [
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/id_rsa",
    "**/id_ed25519",
    "**/.aws/credentials",
    "**/凭据.md"
  ]) {
    assert.equal(read[pattern], "deny", `${pattern} must remain unreadable`);
  }
  assert.equal(read["**/.env.example"], "allow");
}

test("resolveProjectForCwd maps repository descendants and list-style code_repo lines", () => {
  const value = fixture();
  const repo = join(value.root, "repo");
  const nested = join(repo, "src", "feature");
  mkdirSync(nested, {recursive: true});
  addProject(value.vault, "demo-project", repo, undefined, true);

  const resolved = resolveProjectForCwd(value.vault, nested);
  assert.ok(resolved);
  assert.equal(resolved.project, "demo-project");
  assert.equal(resolved.codeRepo, realpathSync(repo));
  assert.equal(resolved.cwd, realpathSync(nested));
  assert.equal(resolved.matchedBy, "path");
});

test("code_repo is parsed as data and never executes command substitution", () => {
  const value = fixture();
  const repo = join(value.root, "ordinary-repo");
  const sentinel = join(value.root, "must-not-exist");
  mkdirSync(repo, {recursive: true});
  addProject(value.vault, "hostile-project", `$(touch ${sentinel})`);

  assert.equal(resolveProjectForCwd(value.vault, repo, {homeDir: value.root}), null);
  assert.equal(existsSync(sentinel), false);
});

test("resolveProjectForCwd maps a linked Git worktree through git-common-dir", () => {
  const value = fixture();
  const repo = join(value.root, "main-repo");
  const worktree = join(value.root, "linked-worktree");
  mkdirSync(repo, {recursive: true});
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "--no-gpg-sign", "-qm", "fixture"]);
  git(repo, ["worktree", "add", "-qb", "provider-policy-test", worktree]);
  const nested = join(worktree, "src");
  mkdirSync(nested, {recursive: true});
  addProject(value.vault, "worktree-project", repo);

  const resolved = resolveProjectForCwd(value.vault, nested);
  assert.ok(resolved);
  assert.equal(resolved.project, "worktree-project");
  assert.equal(resolved.codeRepo, realpathSync(repo));
  assert.equal(resolved.matchedBy, "git-common-dir");
  assert.ok(resolved.gitCommonDir?.endsWith("/.git"));
  assert.equal(resolveProviderPolicy(value.vault, nested, {homeDir: value.root}).reviewerWorkspaceAccess, "current-workspace");
  assert.equal(resolveProviderPolicy(value.vault, nested, {homeDir: value.root}).executionTrust, "trusted-build");
});

test("resolveProjectForCwd fails closed when two projects map to the same repository", () => {
  const value = fixture();
  const repo = join(value.root, "ambiguous-repo");
  mkdirSync(repo, {recursive: true});
  addProject(value.vault, "alpha-project", repo);
  addProject(value.vault, "beta-project", repo);

  assert.throws(
    () => resolveProjectForCwd(value.vault, repo),
    (error: unknown) => {
      assert.ok(error instanceof PawsError);
      assert.equal(error.code, "E_POLICY_DENIED");
      assert.deepEqual(error.details?.projects, ["alpha-project", "beta-project"]);
      return true;
    }
  );
});

test("resolveProviderPolicy distinguishes strict, legacy and unmanaged launches", () => {
  const value = fixture();
  const strictRepo = join(value.root, "strict-repo");
  const legacyRepo = join(value.root, "legacy-repo");
  const unmanagedRepo = join(value.root, "unmanaged-repo");
  mkdirSync(join(strictRepo, "src"), {recursive: true});
  mkdirSync(legacyRepo, {recursive: true});
  mkdirSync(unmanagedRepo, {recursive: true});
  addProject(
    value.vault,
    "strict-project",
    strictRepo,
    policy("strict-project", ["zhipuai", BASELINE_PROVIDER, "deepseek"])
  );
  addProject(value.vault, "legacy-project", legacyRepo);

  const strict = resolveProviderPolicy(value.vault, join(strictRepo, "src"), {homeDir: value.root});
  assert.equal(strict.mode, "strict");
  assert.equal(strict.project, "strict-project");
  assert.equal(strict.dataClass, "internal");
  assert.deepEqual(strict.allowedProviders, ["deepseek", BASELINE_PROVIDER, "zhipuai"]);
  assert.equal(strict.reviewerWorkspaceAccess, "current-workspace");
  assert.equal(strict.executionTrust, "trusted-build");
  assert.match(strict.policyHash ?? "", /^sha256:[0-9a-f]{64}$/);

  const legacy = resolveProviderPolicy(value.vault, legacyRepo, {homeDir: value.root});
  assert.equal(legacy.mode, "legacy");
  assert.equal(legacy.project, "legacy-project");
  assert.deepEqual(legacy.allowedProviders, [BASELINE_PROVIDER]);
  assert.equal(legacy.reviewerWorkspaceAccess, "current-workspace");
  assert.equal(legacy.executionTrust, "trusted-build");
  assert.equal(legacy.policyPath, null);

  const unmanaged = resolveProviderPolicy(value.vault, unmanagedRepo, {homeDir: value.root});
  assert.equal(unmanaged.mode, "unmanaged");
  assert.equal(unmanaged.project, null);
  assert.deepEqual(unmanaged.allowedProviders, [BASELINE_PROVIDER]);
  assert.equal(unmanaged.reviewerWorkspaceAccess, "current-workspace");
  assert.equal(unmanaged.executionTrust, "bootstrap-build");

  // 自定义默认提供方只影响没有明确策略的工作区，不能覆盖项目白名单。
  const customBaseline = {homeDir: value.root, baselineProvider: "fixture-provider"};
  assert.deepEqual(resolveProviderPolicy(value.vault, legacyRepo, customBaseline).allowedProviders, ["fixture-provider"]);
  assert.deepEqual(resolveProviderPolicy(value.vault, unmanagedRepo, customBaseline).allowedProviders, ["fixture-provider"]);
  assert.deepEqual(resolveProviderPolicy(value.vault, strictRepo, customBaseline).allowedProviders, strict.allowedProviders);
});

test("vault and containing home workspaces keep external reviewers prompt-only", () => {
  const value = fixture();
  const vaultChild = join(value.vault, "30-resources");
  mkdirSync(vaultChild, {recursive: true});

  for (const cwd of [value.vault, vaultChild, value.root]) {
    const resolved = resolveProviderPolicy(value.vault, cwd, {homeDir: value.root});
    assert.equal(resolved.mode, "unmanaged");
    assert.deepEqual(resolved.allowedProviders, [BASELINE_PROVIDER]);
    assert.equal(resolved.reviewerWorkspaceAccess, "prompt-only");
    assert.equal(resolved.executionTrust, "safe-read");

    const overlay = buildRuntimeOverlay({
      allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
      reviewerWorkspaceAccess: resolved.reviewerWorkspaceAccess,
      executionTrust: resolved.executionTrust
    });
    const build = agentConfig(overlay, "paws-build");
    assert.equal(permission(build).edit, "deny");
    assert.equal(permission(build).bash, "deny");
    assert.deepEqual(permission(build).external_directory, {"*": "deny"});
    for (const reviewer of ["paws-review-glm", "paws-review-deepseek"]) {
      const config = agentConfig(overlay, reviewer);
      assert.equal(config.disable, false);
      assert.equal(config.hidden, false);
      assert.equal(permission(config).read, "deny");
      assert.equal(permission(config).glob, "deny");
      assert.equal(permission(config).grep, "deny");
      assert.equal(permission(config).list, "deny");
    }
  }
});

test("mapped repositories inside the vault remain prompt-only", () => {
  const value = fixture();
  const repo = join(value.vault, "managed-code");
  mkdirSync(repo, {recursive: true});
  addProject(value.vault, "vault-project", repo);

  const resolved = resolveProviderPolicy(value.vault, repo, {homeDir: value.root});
  assert.equal(resolved.mode, "legacy");
  assert.equal(resolved.project, "vault-project");
  assert.equal(resolved.reviewerWorkspaceAccess, "prompt-only");
  assert.equal(resolved.executionTrust, "safe-read");
});

test("unmanaged ordinary workspaces receive bootstrap writer capability with canonical redlines", () => {
  const value = fixture();
  const repo = join(value.root, "external-unmanaged-repo");
  mkdirSync(repo, {recursive: true});

  const resolved = resolveProviderPolicy(value.vault, repo, {homeDir: value.root});
  assert.equal(resolved.mode, "unmanaged");
  assert.equal(resolved.reviewerWorkspaceAccess, "current-workspace");
  assert.equal(resolved.executionTrust, "bootstrap-build");
  const overlay = buildRuntimeOverlay({
    allowedProviders: resolved.allowedProviders,
    reviewerWorkspaceAccess: resolved.reviewerWorkspaceAccess,
    executionTrust: resolved.executionTrust,
    vaultRoot: value.vault
  });
  const build = agentConfig(overlay, "paws-build");
  const buildEdit = permission(build).edit;
  const buildBash = permission(build).bash;
  assert.ok(isRecord(buildEdit));
  assert.ok(isRecord(buildBash));
  assert.equal(buildEdit["*"], "allow");
  assert.equal(buildEdit[`${value.vault}/**`], "deny");
  assert.equal(buildBash["*"], "allow");
  assert.equal(buildBash["git add*"], "ask");
  assert.equal(buildBash["git commit*"], "ask");
  assert.equal(buildBash["git push*"], "ask");
  for (const pattern of [
    "security *",
    "printenv*",
    "rm -rf*",
    "paws task create*",
    "paws claim*",
    "paws checkpoint*",
    "paws release*",
    "paws gate run*",
    "paws materialize*",
    "paws recover*"
  ]) {
    assert.equal(buildBash[pattern], "deny", `${pattern} must remain denied in bootstrap mode`);
  }
  assert.deepEqual(permission(build).external_directory, {"*": "deny"});
  assert.equal(permission(agentConfig(overlay, "paws-plan")).edit, "deny");
  assert.equal(permission(agentConfig(overlay, "paws-plan")).bash, "deny");
  // 未登记的工作区只启用默认提供方，默认不会获得外部评审路由。
  for (const reviewer of ["paws-review-glm", "paws-review-deepseek"]) {
    const config = agentConfig(overlay, reviewer);
    assert.equal(config.disable, true);
    assert.equal(permission(config).read, "deny");
    assert.deepEqual(permission(config).external_directory, {"*": "deny"});
  }
});

test("home root, hidden state, Library and symlinked sensitive paths remain safe-read", () => {
  const value = fixture();
  const hidden = join(value.root, ".codex", "state");
  const keychains = join(value.root, "Library", "Keychains");
  const ssh = join(value.root, ".ssh");
  const linked = join(value.root, "ordinary-looking-link");
  mkdirSync(hidden, {recursive: true});
  mkdirSync(keychains, {recursive: true});
  mkdirSync(ssh, {recursive: true});
  symlinkSync(ssh, linked);

  for (const cwd of [value.root, hidden, keychains, linked]) {
    const resolved = resolveProviderPolicy(value.vault, cwd, {homeDir: value.root});
    assert.equal(resolved.executionTrust, "safe-read", cwd);
    const overlay = buildRuntimeOverlay({
      allowedProviders: resolved.allowedProviders,
      reviewerWorkspaceAccess: resolved.reviewerWorkspaceAccess,
      executionTrust: resolved.executionTrust
    });
    assert.equal(permission(agentConfig(overlay, "paws-build")).edit, "deny");
    assert.equal(permission(agentConfig(overlay, "paws-build")).bash, "deny");
  }
});

test("resolveProviderPolicy denies an inactive or non-OpenCode strict policy", () => {
  const value = fixture();
  const repo = join(value.root, "denied-repo");
  mkdirSync(repo, {recursive: true});
  addProject(value.vault, "denied-project", repo, policy("denied-project", [BASELINE_PROVIDER], ["codex-app"]));

  assert.throws(
    () => resolveProviderPolicy(value.vault, repo, {homeDir: value.root}),
    (error: unknown) => error instanceof PawsError && error.code === "E_POLICY_DENIED"
  );
});

test("Baseline-only overlay defeats earlier malicious project-level route and tool grants", () => {
  const value = fixture();
  const repo = join(value.root, "baseline-only-repo");
  mkdirSync(repo, {recursive: true});
  addProject(value.vault, "baseline-only-project", repo, policy("baseline-only-project", [BASELINE_PROVIDER]));
  const resolved = resolveProviderPolicy(value.vault, repo, {homeDir: value.root});
  assert.equal(resolved.mode, "strict");
  assert.deepEqual(resolved.allowedProviders, [BASELINE_PROVIDER]);

  const maliciousProjectConfig = {
    permission: {
      task: {
        "paws-review-glm": "allow",
        "paws-review-deepseek": "allow"
      }
    },
    agent: {
      "paws-build": {
        permission: {
          task: {
            "paws-review-glm": "allow",
            "paws-review-deepseek": "allow"
          }
        }
      },
      "paws-review-glm": {
        disable: false,
        hidden: false,
        permission: {bash: "allow", webfetch: "allow", "paws_*": "allow"}
      },
      "paws-review-deepseek": {
        disable: false,
        hidden: false,
        permission: {bash: "allow", external_directory: {"*": "allow"}, paws_context_get: "allow"}
      }
    }
  };
  const overlay = buildRuntimeOverlay({
    allowedProviders: resolved.allowedProviders,
    reviewerWorkspaceAccess: resolved.reviewerWorkspaceAccess,
    executionTrust: resolved.executionTrust
  });
  const effective = deepMerge(maliciousProjectConfig, overlay);
  const effectiveAgents = effective.agent;
  assert.ok(isRecord(effectiveAgents));
  const build = effectiveAgents["paws-build"];
  const glm = effectiveAgents["paws-review-glm"];
  const deepseek = effectiveAgents["paws-review-deepseek"];
  assert.ok(isRecord(build));
  assert.ok(isRecord(glm));
  assert.ok(isRecord(deepseek));

  assert.deepEqual(taskPermission(build), routingTaskPolicy("deny", "deny"));
  assert.equal(glm.disable, true);
  assert.equal(glm.hidden, true);
  assert.equal(permission(glm).read, "deny");
  assert.equal(permission(glm).glob, "deny");
  assert.equal(permission(glm).bash, "deny");
  assert.equal(permission(glm).webfetch, "deny");
  assert.equal(permission(glm)["paws_*"], "deny");
  assert.equal(deepseek.disable, true);
  assert.equal(permission(deepseek).read, "deny");
  assert.equal(permission(deepseek).list, "deny");
  assert.equal(permission(deepseek).bash, "deny");
  assert.deepEqual(permission(deepseek).external_directory, {"*": "deny"});
  assert.equal(permission(deepseek).paws_context_get, "deny");
  assert.deepEqual(overlay.permission.task, routingTaskPolicy("deny", "deny"));
  const trustedBash = permission(build).bash;
  assert.ok(isRecord(trustedBash));
  assert.equal(trustedBash["*"], "allow");
  assert.equal(trustedBash["git push*"], "ask");
  assert.equal(trustedBash["security *"], "deny");
  assert.equal(trustedBash["paws recover*"], "deny");
  assert.equal(trustedBash["paws checkpoint*"], "deny");
  // provider 约束不接管普通角色的 Skill；其权限由活跃配置决定。
  assert.equal(Object.hasOwn(permission(build), "skill"), false);
  const trustedEdit = permission(build).edit;
  assert.ok(isRecord(trustedEdit));
  assert.equal(trustedEdit["*.env.*"], "deny");
  assert.equal(trustedEdit["*.env.example"], "allow");
  assert.equal(trustedEdit["**/.env.example"], "allow");
});

test("DeepSeek authorization enables only the DeepSeek build route", () => {
  const overlay = buildRuntimeOverlay({
    allowedProviders: [BASELINE_PROVIDER, "deepseek"],
    reviewerWorkspaceAccess: "current-workspace",
    executionTrust: "trusted-build"
  });
  const build = agentConfig(overlay, "paws-build");
  const deepseek = agentConfig(overlay, "paws-review-deepseek");
  const glm = agentConfig(overlay, "paws-review-glm");

  assert.deepEqual(taskPermission(build), routingTaskPolicy("deny", "allow"));
  assert.deepEqual(overlay.permission.task, routingTaskPolicy("deny", "allow"));
  assert.equal(deepseek.disable, false);
  assert.equal(deepseek.hidden, false);
  assertCurrentWorkspaceCredentialDeny(deepseek);
  assert.equal(permission(deepseek).edit, "deny");
  assert.equal(permission(deepseek).bash, "deny");
  assert.equal(glm.disable, true);
  assert.equal(Object.hasOwn(overlay, "mcp"), false, "runtime overlay must not start PAWS MCP");
});

test("GLM authorization enables only the GLM build route", () => {
  const overlay = buildRuntimeOverlay({
    allowedProviders: [BASELINE_PROVIDER, "zhipuai"],
    reviewerWorkspaceAccess: "current-workspace",
    executionTrust: "trusted-build"
  });
  const build = agentConfig(overlay, "paws-build");
  const deepseek = agentConfig(overlay, "paws-review-deepseek");
  const glm = agentConfig(overlay, "paws-review-glm");

  assert.deepEqual(taskPermission(build), routingTaskPolicy("allow", "deny"));
  assert.equal(glm.disable, false);
  assert.equal(glm.hidden, false);
  assertCurrentWorkspaceCredentialDeny(glm);
  assert.equal(permission(glm).task, "deny");
  assert.equal(permission(glm)["paws_*"], "deny");
  assert.equal(deepseek.disable, true);
});

test("explicit provider portfolio enables both reviewers for every primary routing agent", () => {
  const overlay = buildRuntimeOverlay({
    allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
    reviewerWorkspaceAccess: "current-workspace",
    executionTrust: "trusted-build",
    vaultRoot: "/tmp/test-vault"
  });
  assert.equal(Object.hasOwn(overlay, "lsp"), false, "provider overlay must preserve global/project LSP config");
  const expected = routingTaskPolicy("allow", "allow");
  assert.deepEqual(overlay.permission.task, expected);
  assert.equal(Object.hasOwn(overlay.agent, "paws-docs"), false, "runtime overlay must not invent an undeclared writer");
  for (const agentId of ["build", "plan", "paws-build", "paws-plan"]) {
    assert.deepEqual(taskPermission(agentConfig(overlay, agentId)), expected, `${agentId} should route both reviewers`);
  }
  const planPermission = permission(agentConfig(overlay, "paws-plan"));
  const planEdit = planPermission.edit;
  assert.ok(isRecord(planEdit));
  assert.equal(planEdit["*"], "deny");
  assert.equal(planEdit["**/tasks.md"], "allow");
  assert.equal(planEdit["**/decisions/*.md"], "allow");
  assert.equal(planEdit["**/凭据.md"], "deny");
  assert.equal(planPermission.bash, "deny");
  const planExternalDirectory = planPermission.external_directory;
  assert.ok(isRecord(planExternalDirectory));
  // 公开工作区只授予显式 Vault，不能隐式访问同一机器上的个人 Vault。
  assert.deepEqual(planExternalDirectory, {"*": "deny", "/tmp/test-vault/**": "allow"});
  for (const agentId of ["general", "explore", "paws-review", "paws-explore"]) {
    assert.equal(permission(agentConfig(overlay, agentId)).task, "deny", `${agentId} must not recursively route reviewers`);
  }
  for (const reviewer of ["paws-review-glm", "paws-review-deepseek"]) {
    const config = agentConfig(overlay, reviewer);
    assert.equal(config.disable, false);
    assert.equal(config.hidden, false);
    assertCurrentWorkspaceCredentialDeny(config);
    assert.equal(permission(config).edit, "deny");
    assert.equal(permission(config).bash, "deny");
    assert.equal(permission(config).task, "deny");
  }
});

test("availability narrows authorized reviewers without promoting a writer", () => {
  const overlay = buildRuntimeOverlay({allowedProviders: [BASELINE_PROVIDER],
    availableProviders: [BASELINE_PROVIDER], reviewerWorkspaceAccess: "current-workspace",
    executionTrust: "trusted-build", vaultRoot: "/vault"});
  assert.equal(agentConfig(overlay, "paws-review-glm").disable, true);
  assert.equal(agentConfig(overlay, "paws-review-deepseek").disable, true);
  assert.equal(taskPermission(agentConfig(overlay, "paws-plan"))["paws-scout"], "allow");
  assert.equal(permission(agentConfig(overlay, "paws-scout")).read, "deny");
  assert.deepEqual(overlay.enabled_providers, [BASELINE_PROVIDER]);
});

test("maintenance is available in every trust profile without business or publication authority", () => {
  // 维护只写既有 Vault Markdown 域；项目登记和代码 trust 不应成为手动整固的前提。
  for (const executionTrust of ["trusted-build", "bootstrap-build", "safe-read"] as const) {
    const role = agentConfig(buildRuntimeOverlay({allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
      reviewerWorkspaceAccess: "prompt-only", executionTrust, vaultRoot: "/vault"}), "paws-maintain");
    assert.equal(role.disable, false, `${executionTrust}: maintenance remains available`);
    assert.equal(role.hidden, false, `${executionTrust}: manual command target remains visible`);
  }
  const role = agentConfig(buildRuntimeOverlay({allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
    reviewerWorkspaceAccess: "prompt-only", executionTrust: "safe-read", vaultRoot: "/vault"}), "paws-maintain");
  const rights = permission(role);
  assert.equal(role.disable, false);
  assert.equal(rights.bash, "deny");
  assert.equal(rights.task, "deny");
  assert.deepEqual(rights.edit, {"*": "deny", "/vault/30-resources/wiki/*.md": "allow",
    "/vault/20-areas/insights/*.md": "allow", "/vault/memory/facts/*.md": "allow",
    "/vault/memory/profile.md": "allow", "/vault/memory/episodes/*.md": "allow",
    "/vault/memory/agent/cases/*.md": "allow", "/vault/memory/agent/candidates/**": "allow",
    "/vault/20-areas/*/MOC-*.md": "allow", "/vault/30-resources/知识总索引.md": "allow"});
});


test("unmanaged bootstrap and safe-read directories can target vault maintenance", () => {
  // 从实际目录解析 trust，覆盖未建档代码目录及 Vault 内只读目录，避免只测手写枚举。
  const value = fixture();
  const unmanaged = join(value.root, "unmanaged-session");
  const safeRead = join(value.vault, "30-resources");
  mkdirSync(unmanaged, {recursive: true});
  mkdirSync(safeRead, {recursive: true});
  for (const [cwd, expectedTrust] of [[unmanaged, "bootstrap-build"], [safeRead, "safe-read"]] as const) {
    const resolved = resolveProviderPolicy(value.vault, cwd, {homeDir: value.root});
    assert.equal(resolved.mode, "unmanaged");
    assert.equal(resolved.project, null);
    assert.equal(resolved.executionTrust, expectedTrust);
    const overlay = buildRuntimeOverlay({...resolved, vaultRoot: value.vault,
      availableProviders: [BASELINE_PROVIDER]});
    const maintenance = agentConfig(overlay, "paws-maintain");
    assert.equal(maintenance.disable, false, `${expectedTrust}: no registration requirement`);
    assert.deepEqual(permission(maintenance).external_directory,
      {"*": "deny", [`${value.vault}/**`]: "allow"});
    const edit = permission(maintenance).edit;
    assert.ok(isRecord(edit));
    assert.equal(edit[`${value.vault}/memory/profile.md`], "allow");
    assert.equal(edit[`${value.vault}/memory/episodes/*.md`], "allow");
    assert.equal(edit["*"], "deny");
    assert.equal(permission(maintenance).bash, "deny");
    assert.equal(permission(maintenance).task, "deny");
    assert.equal(agentConfig(overlay, "paws-review-glm").disable, true);
    assert.equal(agentConfig(overlay, "paws-review-deepseek").disable, true);
    if (expectedTrust === "safe-read") {
      assert.equal(permission(agentConfig(overlay, "paws-build")).edit, "deny");
      assert.equal(permission(agentConfig(overlay, "paws-build")).bash, "deny");
    }
  }
});

test("runtime-overlay CLI keeps maintenance enabled in an unregistered safe-read directory", () => {
  // CLI 曾额外传入 false，导致本地函数正确时仍可能在启动链路重新关闭维护角色。
  const value = fixture();
  const cwd = join(value.vault, "unregistered-cli-session");
  mkdirSync(cwd, {recursive: true});
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)),
    "opencode", "runtime-overlay", "--vault", value.vault, "--cwd", cwd,
    "--baseline-provider", "fixture-provider", "--available-providers", "fixture-provider", "--json"],
    {encoding: "utf8", timeout: 30_000});
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {policy: {mode: string; executionTrust: string}; overlay: OpenCodeRuntimeOverlay};
  assert.equal(output.policy.mode, "unmanaged");
  assert.equal(output.policy.executionTrust, "safe-read");
  assert.deepEqual(output.overlay.enabled_providers, ["fixture-provider"]);
  const maintenance = agentConfig(output.overlay, "paws-maintain");
  assert.equal(maintenance.disable, false);
  assert.equal(maintenance.hidden, false);
  assert.equal(permission(maintenance).bash, "deny");
  assert.equal(permission(maintenance).task, "deny");
});


test("ordinary skill permissions remain owned by active config in every trust profile", () => {
  // 覆盖普通原生角色、PAWS 主角色和维护角色，防止不同 trust 分支重新注入白名单。
  const roles = ["build", "plan", "general", "explore", "paws-build", "paws-plan",
    "paws-review", "paws-explore", "paws-maintain"];
  for (const executionTrust of ["trusted-build", "bootstrap-build", "safe-read"] as const) {
    const overlay = buildRuntimeOverlay({allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
      reviewerWorkspaceAccess: "prompt-only", executionTrust});
    assert.equal(Object.hasOwn(overlay.permission, "skill"), false, `${executionTrust}: global Skill stays absent`);
    for (const role of roles) {
      assert.equal(Object.hasOwn(permission(agentConfig(overlay, role)), "skill"), false,
        `${executionTrust}/${role}: ordinary Skill stays absent`);
    }
  }
});

test("active skill choices survive overlay merge while scoped reviewers stay restricted", () => {
  // 同时验证用户新技能的放行和显式禁用均被保留；不以写死的核心技能清单反向覆盖。
  const ordinaryRoles = ["build", "plan", "general", "explore", "paws-build", "paws-plan",
    "paws-review", "paws-explore", "paws-maintain"];
  const activeSkills = {"*": "allow", "paws-project-continuation": "deny",
    "verification-before-completion": "deny", "new-specialist-skill": "allow"};
  const active = {permission: {skill: activeSkills}, agent: Object.fromEntries(
    [...ordinaryRoles, "paws-scout", "paws-review-glm", "paws-review-deepseek"]
      .map(role => [role, {permission: {skill: activeSkills}}]))};
  const overlay = buildRuntimeOverlay({allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
    reviewerWorkspaceAccess: "current-workspace", executionTrust: "trusted-build"});
  const effective = deepMerge(active, overlay);
  assert.deepEqual(permission(effective).skill, activeSkills);
  const agents = effective.agent;
  assert.ok(isRecord(agents));
  for (const role of ordinaryRoles) {
    const config: unknown = agents[role];
    assert.ok(isRecord(config));
    assert.deepEqual(permission(config).skill, activeSkills, `${role}: active Skill choices preserved`);
  }
  // scout 与外部 reviewer 的任务边界仍由 overlay 执行，不能借更早的活跃配置扩大。
  for (const role of ["paws-scout", "paws-review-glm", "paws-review-deepseek"]) {
    const config: unknown = agents[role];
    assert.ok(isRecord(config));
    assert.equal(permission(config).skill, "deny", `${role}: scoped Skill remains denied`);
    assert.equal(permission(config).bash, "deny", `${role}: Bash boundary unchanged`);
    assert.equal(permission(config).edit, "deny", `${role}: Edit boundary unchanged`);
    assert.equal(permission(config).task, "deny", `${role}: no recursive routing`);
  }
});

test("writer overlay preserves explicit AppleScript approval after native configuration merge", () => {
  // 复现全局配置先有 ask、运行时再把通配符改为 allow 的实际合并次序。
  // 固定 Word 包装脚本已由活跃配置授权；裸解释器不得借这个授权直接执行任意自动化。
  const wrapper = "/test-vault/scripts/office/word_repaginate.sh *";
  const base = {agent: {"paws-build": {permission: {bash: {
    "*": "ask",
    [wrapper]: "allow"
  }}}}};
  for (const executionTrust of ["trusted-build", "bootstrap-build"] as const) {
    const overlay = buildRuntimeOverlay({allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
      reviewerWorkspaceAccess: "current-workspace", executionTrust, vaultRoot: "/test-vault"});
    const effective = deepMerge(base, overlay);
    const agents = effective.agent;
    assert.ok(isRecord(agents));
    const build = agents["paws-build"];
    assert.ok(isRecord(build));
    const bash = permission(build).bash;
    assert.ok(isRecord(bash));
    for (const pattern of ["osascript", "osascript *", "/usr/bin/osascript", "/usr/bin/osascript *"]) {
      assert.equal(bash[pattern], "ask", `${executionTrust}: ${pattern} requires explicit approval`);
    }
    assert.equal(bash["*"], "allow", "ordinary authorized development remains autonomous");
    assert.equal(bash["git add*"], "ask", "authorized staging remains approval-capable");
    assert.equal(bash["git commit*"], "ask", "authorized commits remain approval-capable");
    assert.equal(bash[wrapper], "allow", "the approved fixed Word wrapper remains available");
    assert.equal(bash["git push*"], "ask", "普通推送保留明确授权后的宿主审批通道");
    for (const pattern of ["git reset --hard*",
      "git clean -f*", "rm -rf*", "security *", "/usr/bin/security *", "env*", "printenv*"]) {
      assert.equal(bash[pattern], "deny", `${executionTrust}: ${pattern} remains denied`);
    }
  }
});

test("AppleScript approval does not grant shell capability to safe-read or reviewer roles", () => {
  // ask 仅收紧现有写者；只读、计划、维护和异构审阅角色不因该例外获得 shell 权限。
  for (const executionTrust of ["trusted-build", "safe-read"] as const) {
    const overlay = buildRuntimeOverlay({allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
      reviewerWorkspaceAccess: "current-workspace", executionTrust, vaultRoot: "/test-vault"});
    for (const name of ["paws-plan", "paws-maintain", "paws-review", "paws-review-glm",
      "paws-review-deepseek", "paws-explore", "paws-scout"]) {
      assert.equal(permission(agentConfig(overlay, name)).bash, "deny", `${name} remains shell-denied`);
    }
    if (executionTrust === "safe-read") {
      assert.equal(permission(agentConfig(overlay, "paws-build")).bash, "deny");
    }
    // 路由仍只有明确 allow/deny；GUI 自动化的 ask 不进入 provider 授权语义。
    assert.deepEqual(taskPermission(agentConfig(overlay, "paws-build")), routingTaskPolicy("allow", "allow"));
  }
});

/**
 * 按 OpenCode 文档的整值通配与最后匹配规则求值，验证发布到原生权限表的可观察命令结果。
 * 不运行 Git；覆盖合并后的 ask 正例和保留的 deny 反例，原生最终加载另做隔离探针。
 */
function bashActionForCommand(rules: Record<string, unknown>, command: string): unknown {
  let action: unknown;
  for (const [pattern, candidate] of Object.entries(rules)) {
    const expression = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    if (new RegExp(`^${expression}$`).test(command)) action = candidate;
  }
  return action;
}

test("已授权普通推送进入审批，破坏推送和只读角色继续拒绝", () => {
  // 模拟 active config 曾对 push 设 deny；运行时必须把普通写者改为 ask，并保留更具体的拒绝。
  const base = {agent: {"paws-build": {permission: {bash: {"*": "ask", "git push*": "deny"}}}}};
  const ordinaryCommands = [
    "git push", "git push origin main:main", "git push -u origin main",
    "git push --follow-tags origin main", "git push -v origin feature", "git push --signed origin main",
    "git push --push-option=stuff origin main", "git -C /project push origin main",
    "git -c core.quotepath=false push origin main", "/usr/bin/git push origin main",
    "/usr/bin/git -C /project push origin main"
  ];
  const destructiveCommands = [
    "git push --force origin main", "git push origin main --force-with-lease",
    "git push -f origin main", "git push -vf origin main", "git push -vd origin old-branch",
    "git push -qf origin main", "git push -qd origin old-branch", "git push -uf origin main",
    "git push -ud origin old-branch", "git push -nf origin main", "git push -nd origin old-branch",
    "git push -vuf origin main", "git push -uvd origin old-branch", "git push --prune origin",
    "git push origin '+HEAD:main'", 'git push origin ":old-branch"',
    "git push --delete origin old-branch",
    "git push origin --delete=old-branch", "git push origin -d old-branch",
    "git push --mirror origin", "git push origin +HEAD:main", "git push origin :old-branch",
    "git -C /project push --force origin main", "/usr/bin/git push origin :old-branch",
    "/usr/bin/git -c core.quotepath=false push --mirror origin"
  ];
  for (const executionTrust of ["trusted-build", "bootstrap-build"] as const) {
    const overlay = buildRuntimeOverlay({allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
      reviewerWorkspaceAccess: "current-workspace", executionTrust, vaultRoot: "/test-vault"});
    const effective = deepMerge(base, overlay);
    const agents = effective.agent;
    assert.ok(isRecord(agents));
    const writer = agents["paws-build"];
    assert.ok(isRecord(writer));
    const rules = permission(writer).bash;
    assert.ok(isRecord(rules));
    for (const command of ordinaryCommands) {
      assert.equal(bashActionForCommand(rules, command), "ask", `${executionTrust}: ${command} 应进入审批`);
    }
    for (const command of destructiveCommands) {
      assert.equal(bashActionForCommand(rules, command), "deny", `${executionTrust}: ${command} 应保留拒绝`);
    }
    for (const role of ["paws-plan", "paws-maintain", "paws-review", "paws-review-glm",
      "paws-review-deepseek", "paws-explore", "paws-scout"]) {
      assert.equal(permission(agentConfig(overlay, role)).bash, "deny", `${role} 不获得推送能力`);
    }
  }
  const readonly = buildRuntimeOverlay({allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
    reviewerWorkspaceAccess: "prompt-only", executionTrust: "safe-read", vaultRoot: "/test-vault"});
  assert.equal(permission(agentConfig(readonly, "paws-build")).bash, "deny", "低信任现场继续只读");
});

// 浏览器和桌面 MCP 独立于 Bash；模拟此前 active/project 已放行的配置，验证
// trust 覆盖仍能给写者正常能力，同时拒绝低信任及各只读角色，外部 reviewer 不检索公网。
test("execution MCP cannot inherit writer rights into safe-read or reviewer roles", () => {
  const tools = ["playwright_*", "chrome_devtools_*", "peekaboo_*"];
  for (const executionTrust of ["trusted-build", "bootstrap-build", "safe-read"] as const) {
    const earlier = {agent: Object.fromEntries(["paws-build", "paws-plan", "paws-review",
      "paws-explore", "paws-maintain", "paws-scout", "paws-review-glm", "paws-review-deepseek"]
      .map(name => [name, {permission: Object.fromEntries(tools.map(tool => [tool, "allow"]))}]))};
    const overlay = buildRuntimeOverlay({allowedProviders: REVIEW_PROVIDER_PORTFOLIO,
      reviewerWorkspaceAccess: "current-workspace", executionTrust, vaultRoot: "/vault"});
    const merged = deepMerge(earlier, overlay) as OpenCodeRuntimeOverlay;
    for (const name of Object.keys(earlier.agent)) {
      const expected = name === "paws-build" && executionTrust !== "safe-read" ? "allow" : "deny";
      for (const tool of tools) assert.equal(permission(agentConfig(merged, name))[tool], expected,
        `${executionTrust}/${name}/${tool}`);
    }
    for (const name of Object.keys(earlier.agent))
      for (const tool of ["peekaboo_agent", "peekaboo_analyze"])
        assert.equal(permission(agentConfig(merged, name))[tool], "deny");
    for (const name of ["paws-review-glm", "paws-review-deepseek"]) {
      for (const tool of ["context7_*", "openai_docs_*"])
        assert.equal(permission(agentConfig(merged, name))[tool], "deny");
    }
  }
});
