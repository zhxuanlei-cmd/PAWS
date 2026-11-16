#!/usr/bin/env node

import {existsSync, readFileSync, statSync} from "node:fs";
import {homedir} from "node:os";
import {isAbsolute, join, resolve} from "node:path";
import {parseDocument} from "yaml";
import {PawsError} from "./errors.js";
import {resolveVaultDir, schemaDir, walkMarkdown} from "./paths.js";
import {buildContextPack, readContextPack, verifyContextPack, writeContextPack} from "./context.js";
import {adapterTargets, checkAdapters, planAdapters, syncAdapters} from "./adapters.js";
import {readOpenCodeConfig, summarizeOpenCodeConfig, validateOpenCodeConfig} from "./opencode-validation.js";
import {BASELINE_PROVIDER, buildRuntimeOverlay, resolveProviderPolicy} from "./provider-policy.js";
import {assertNoLikelySecret} from "./security.js";
import type {ActionRequest, ValidationContext, ValidationResult} from "./types.js";
import {OntologyValidator} from "./validator.js";

interface ParsedArgs {
  command: string;
  options: Map<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const booleanOptions = new Set(["--json"]);
  const options = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value) continue;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [key, inline] = value.split("=", 2);
    if (!key) throw new Error(`invalid option: ${value}`);
    if (inline !== undefined) {
      options.set(key, inline);
      continue;
    }
    if (booleanOptions.has(key)) {
      options.set(key, true);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return {command, options, positional};
}

function option(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredOption(args: ParsedArgs, name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`missing required option: ${name}`);
  return value;
}

function positional(args: ParsedArgs, index: number, label: string): string {
  const value = args.positional[index];
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function stateDir(args: ParsedArgs): string {
  return resolve(option(args, "--state-dir") ?? process.env.PAWS_STATE_DIR ?? join(homedir(), ".local", "state", "paws-oss"));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeYaml(path: string): Record<string, unknown> {
  const document = parseDocument(readFileSync(path, "utf8"), {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false
  });
  if (document.errors.length > 0 || document.warnings.length > 0) throw new Error(`invalid YAML: ${path}`);
  const value = document.toJS({maxAliasCount: 0});
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`expected YAML mapping: ${path}`);
  return value as Record<string, unknown>;
}

function safeJsonMapping(path: string): Record<string, string> {
  const source = readFileSync(path, "utf8");
  assertNoLikelySecret(source, path);
  const value = JSON.parse(source) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`expected JSON mapping: ${path}`);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
}

function absoluteFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function printResult(result: ValidationResult, json: boolean): void {
  if (json) {
    printJson({valid: result.valid, code: result.code, issues: result.issues});
    return;
  }
  if (result.valid) {
    process.stdout.write(`PAWS_LINT_OK documents=${result.documents.length}\n`);
    return;
  }
  for (const issue of result.issues) {
    process.stderr.write(`${issue.code} ${issue.path}${issue.pointer ?? ""}: ${issue.message}\n`);
  }
}

function hasStrictFrontmatterType(source: string): boolean {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) return false;
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\s*\r?$/m);
  return match?.[1] ? /^type:\s*(task|evidence|repository|policy)\s*$/m.test(match[1]) : false;
}

function fixtureTest(args: ParsedArgs): number {
  const vault = resolveVaultDir(option(args, "--vault"));
  const manifestPath = absoluteFrom(vault, option(args, "--manifest") ?? "ontology/fixtures/manifest.yaml");
  const fixtureRoot = resolve(manifestPath, "..");
  const manifest = safeYaml(manifestPath);
  const validator = new OntologyValidator(schemaDir(vault, String(manifest.schema_version ?? "1.1")));
  const shared = (manifest.shared_objects as string[]).map((path) => join(fixtureRoot, path));
  const cases = manifest.cases as Array<Record<string, unknown>>;
  let positive = 0;
  let negative = 0;
  let failed = 0;
  for (const fixtureCase of cases) {
    const id = String(fixtureCase.id);
    const expected = fixtureCase.expected as {valid: boolean; code: string};
    const paths = [...shared, ...(fixtureCase.objects as string[]).map((path) => join(fixtureRoot, path))];
    const context: ValidationContext = {fixedNow: String(manifest.fixed_now)};
    if (fixtureCase.repo_root) context.repoRoot = join(fixtureRoot, String(fixtureCase.repo_root));
    if (fixtureCase.environment_probe_results) {
      context.environmentProbeResults = fixtureCase.environment_probe_results as Record<string, string>;
    }
    if (fixtureCase.action_request) {
      context.actionRequest = safeYaml(join(fixtureRoot, String(fixtureCase.action_request))) as unknown as ActionRequest;
    }
    const result = validator.validateFiles(paths, context);
    const passed = result.valid === expected.valid && result.code === expected.code;
    process.stdout.write(`${passed ? "PASS" : "FAIL"} ${id} -> ${result.code}\n`);
    if (!passed) failed += 1;
    if (fixtureCase.kind === "positive") positive += 1;
    if (fixtureCase.kind === "negative") negative += 1;
  }
  if (failed > 0) {
    process.stderr.write(`PAWS_FIXTURE_GATE_FAILED failed=${failed}\n`);
    return 1;
  }
  process.stdout.write(`PAWS_FIXTURE_GATE_OK positive=${positive} negative=${negative} total=${cases.length}\n`);
  return 0;
}

function lint(args: ParsedArgs): number {
  const vault = resolveVaultDir(option(args, "--vault"));
  const mode = option(args, "--mode") ?? "compatibility";
  if (!(["compatibility", "strict"] as const).includes(mode as "compatibility" | "strict")) {
    throw new Error(`invalid lint mode: ${mode}`);
  }
  const paths = args.positional.length > 0
    ? args.positional.map((path) => absoluteFrom(process.cwd(), path))
    : walkMarkdown(vault);
  const validator = new OntologyValidator(schemaDir(vault));
  const strictPaths = paths.filter((path) => {
    const source = readFileSync(path, "utf8");
    return hasStrictFrontmatterType(source);
  });
  const result = validator.validateFiles(strictPaths);
  printResult(result, args.options.has("--json"));
  return result.valid ? 0 : 1;
}

function schemaCheck(args: ParsedArgs): number {
  const vault = resolveVaultDir(option(args, "--vault"));
  const directory = schemaDir(vault);
  if (!existsSync(directory)) throw new Error(`schema directory missing: ${directory}`);
  new OntologyValidator(directory);
  process.stdout.write(`PAWS_SCHEMA_OK version=1.1 path=${directory}\n`);
  return 0;
}

function doctor(args: ParsedArgs): number {
  const vault = resolveVaultDir(option(args, "--vault"));
  const state = stateDir(args);
  const lintResult = new OntologyValidator(schemaDir(vault)).validateFiles(
    walkMarkdown(vault).filter((path) => hasStrictFrontmatterType(readFileSync(path, "utf8")))
  );
  // 薄桥日常运行不要求事务缓存存在；诊断不得初始化或修复该目录。
  // 不可读等错误继续报错，不能把权限失败伪装成「尚未初始化」。
  const stateInfo = (() => {
    try { return statSync(state); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  })();
  const stateMode = stateInfo ? stateInfo.mode & 0o777 : undefined;
  const stateStatus = !stateInfo ? "absent" : !stateInfo.isDirectory() ? "not-directory"
    : (stateMode! & 0o077) === 0 ? "secure" : "insecure";
  const output = {
    ok: lintResult.valid && ["absent", "secure"].includes(stateStatus),
    vault,
    schemaVersion: "1.1",
    strictDocuments: lintResult.documents.length,
    lintCode: lintResult.code,
    stateDir: state,
    stateStatus,
    stateMode: stateMode === undefined ? null : stateMode.toString(8).padStart(4, "0"),
    autoCommit: false,
    autoPush: false
  };
  if (args.options.has("--json")) printJson(output);
  else process.stdout.write(`${output.ok ? "PAWS_DOCTOR_OK" : "PAWS_DOCTOR_FAILED"} strict=${output.strictDocuments} state=${output.stateStatus} state_mode=${output.stateMode ?? "not-created"}\n`);
  return output.ok ? 0 : 1;
}

function contextCommand(args: ParsedArgs): number {
  const subcommand = positional(args, 0, "context subcommand");
  const vault = resolveVaultDir(option(args, "--vault"));
  if (subcommand === "build") {
    const project = requiredOption(args, "--project");
    const taskId = option(args, "--task");
    const profile = option(args, "--profile") ?? "summary";
    if (profile !== "summary" && profile !== "full") throw new Error(`invalid context profile: ${profile}`);
    const credentialsPath = option(args, "--credential-status-file");
    const credentialPresence = credentialsPath
      ? Object.fromEntries(Object.entries(safeJsonMapping(resolve(credentialsPath))).map(([name, value]) => {
          if (!["present", "absent", "unknown"].includes(value)) throw new Error(`invalid credential presence for ${name}`);
          return [name, value as "present" | "absent" | "unknown"];
        }))
      : {};
    const pack = buildContextPack({
      vaultRoot: vault,
      project,
      ...(taskId ? {taskId} : {}),
      ...(option(args, "--repo") ? {repoRoot: resolve(requiredOption(args, "--repo"))} : {}),
      profile,
      credentialPresence
    });
    const output = resolve(option(args, "--output") ?? join(stateDir(args), "contexts", project, taskId ?? "legacy", "context.json"));
    writeContextPack(pack, output);
    if (args.options.has("--json")) printJson({output, pack});
    else process.stdout.write(`PAWS_CONTEXT_OK pack=${pack.packId} output=${output}\n`);
    return 0;
  }
  if (subcommand === "verify") {
    const path = resolve(requiredOption(args, "--file"));
    const result = verifyContextPack(vault, readContextPack(path));
    if (args.options.has("--json")) printJson(result);
    else process.stdout.write(`${result.valid ? "PAWS_CONTEXT_VALID" : "PAWS_CONTEXT_STALE"} changed=${result.changedSources.length} missing=${result.missingSources.length} semantic=${result.semanticIssues.length}\n`);
    return result.valid ? 0 : 1;
  }
  if (subcommand === "show") {
    printJson(readContextPack(resolve(requiredOption(args, "--file"))));
    return 0;
  }
  throw new Error(`unknown context subcommand: ${subcommand}`);
}

function adaptersCommand(args: ParsedArgs): number {
  const subcommand = positional(args, 0, "adapters subcommand");
  const vault = resolveVaultDir(option(args, "--vault"));
  const source = resolve(option(args, "--source") ?? join(vault, "scripts", "skills", "paws-project-continuation"));
  // 独立导出落在公开版状态目录，真实宿主入口由支持冲突检测的安装器管理。
  const targets = adapterTargets(option(args, "--test-root") ?? join(stateDir(args), "adapters"));
  if (subcommand === "plan") {
    printJson(planAdapters(source, targets));
    return 0;
  }
  if (subcommand === "sync") {
    const result = syncAdapters(source, targets);
    printJson(result);
    return result.every((item) => item.valid) ? 0 : 1;
  }
  if (subcommand === "check") {
    const result = checkAdapters(source, targets);
    printJson(result);
    return result.every((item) => item.valid) ? 0 : 1;
  }
  throw new Error(`unknown adapters subcommand: ${subcommand}`);
}

function opencodeCommand(args: ParsedArgs): number {
  const subcommand = positional(args, 0, "opencode subcommand");
  if (subcommand === "runtime-overlay" || subcommand === "provider-check") {
    const vault = resolveVaultDir(option(args, "--vault"));
    const cwd = resolve(option(args, "--cwd") ?? process.cwd());
    // 公开版从当前启动配置接收默认提供方。已登记项目的白名单仍优先，不能由参数放宽。
    const baselineProvider = option(args, "--baseline-provider") ?? BASELINE_PROVIDER;
    const policy = resolveProviderPolicy(vault, cwd, {baselineProvider});
    if (subcommand === "provider-check") {
      const provider = requiredOption(args, "--provider");
      const allowed = policy.allowedProviders.includes(provider);
      if (args.options.has("--json")) printJson({allowed, provider, policy});
      return allowed ? 0 : 3;
    }
    if (!policy.allowedProviders.includes(baselineProvider)) {
      throw new Error(`OpenCode default provider ${baselineProvider} is not authorized for ${policy.project ?? cwd}`);
    }
    const overlay = buildRuntimeOverlay({
      allowedProviders: policy.allowedProviders,
      reviewerWorkspaceAccess: policy.reviewerWorkspaceAccess,
      executionTrust: policy.executionTrust,
      vaultRoot: vault,
      // Skill 权限由 OpenCode active config 管理；provider overlay 不读取或复制技能注册清单。
      availableProviders: option(args, "--available-providers")?.split(",").filter(Boolean)
    });
    if (args.options.has("--json")) printJson({policy, overlay});
    else process.stdout.write(`${JSON.stringify(overlay)}\n`);
    return 0;
  }
  // 退役写入口在读取路径与配置前拒绝，不能因补齐旧参数而恢复生成器。
  if (subcommand !== "validate") throw new Error(`unsupported opencode subcommand: ${subcommand}; use validate or runtime-overlay`);
  const configPath = resolve(requiredOption(args, "--config"));
  const schemaPath = resolve(requiredOption(args, "--schema"));
  if (subcommand === "validate") {
    const config = readOpenCodeConfig(configPath);
    validateOpenCodeConfig(config, schemaPath);
    printJson({valid: true, summary: summarizeOpenCodeConfig(config)});
    return 0;
  }
  throw new Error(`unknown opencode subcommand: ${subcommand}`);
}

function help(): void {
  process.stdout.write([
    "PAWS minimal active bridge 0.1.0 (package: paws-control)",
    "",
    "Read commands:",
    "  paws doctor [--vault PATH] [--json]",
    "  paws lint [--vault PATH] [--mode compatibility|strict] [--json] [FILES...]",
    "  paws fixture-test [--vault PATH] [--manifest PATH]",
    "  paws schema-check --vault PATH",
    "",
    "Explicit derived-output commands (may write generated files):",
    "  paws context build --project PROJECT [--task TASK] [--repo PATH] [--profile summary|full] [--output FILE]",
    "  paws context verify --file FILE [--json]",
    "  paws context show --file FILE",
    "  paws adapters plan|sync|check [--source DIR] [--test-root DIR]",
    "",
    "Read-only OpenCode bridge commands:",
    "  paws opencode validate --config FILE --schema FILE",
    "  paws opencode runtime-overlay --cwd PATH [--vault PATH] [--baseline-provider ID] [--available-providers IDS] [--json]",
    "  paws opencode provider-check --cwd PATH --provider ID [--vault PATH] [--baseline-provider ID] [--json]",
    "",
    ""
  ].join("\n"));
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "lint") return lint(args);
  if (args.command === "fixture-test") return fixtureTest(args);
  if (args.command === "schema-check") return schemaCheck(args);
  if (args.command === "doctor") return doctor(args);
  if (args.command === "context") return contextCommand(args);
  if (args.command === "adapters") return adaptersCommand(args);
  if (args.command === "opencode") return opencodeCommand(args);
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    help();
    return 0;
  }
  if (args.command === "version" || args.command === "--version" || args.command === "-v") {
    process.stdout.write("0.1.0\n");
    return 0;
  }
  throw new Error(`unknown command: ${args.command}`);
}

try {
  process.exitCode = main();
} catch (error: unknown) {
  if (error instanceof PawsError) {
    process.stderr.write(`${error.code} ${error.path}: ${error.message}\n`);
  } else {
    process.stderr.write(`PAWS_ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
