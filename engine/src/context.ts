import {spawnSync} from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import {basename, dirname, join, relative, resolve, sep} from "node:path";
import {digestJson, sha256Bytes} from "./digest.js";
import {parseMarkdownFile} from "./frontmatter.js";
import {assertNoLikelySecret} from "./security.js";
import {ProjectStore} from "./store.js";

export interface ContextSource {
  path: string;
  sha256: string;
  bytes: number;
  content: string;
  truncated: boolean;
}

export interface ContextPack {
  formatVersion: 1;
  packId: string;
  project: string;
  taskId: string | null;
  mode: "legacy" | "shadow" | "cutover";
  profile: "summary" | "full";
  generatedAt: string;
  expiresAt: string;
  background: {
    ttlSeconds: number;
    digest: string;
    sources: ContextSource[];
  };
  delta: {
    ttlSeconds: number;
    sources: ContextSource[];
    task: Record<string, unknown> | null;
    evidence: Array<Record<string, unknown>>;
    basedOn: string | null;
    branch: string | null;
    writeScope: string[];
    requiredGates: string[];
    evidenceFreshness: "runtime-context-required" | "not-applicable";
    blocker: string | null;
    nextAction: string;
  };
  runtime: {
    ttlSeconds: number;
    git: {
      available: boolean;
      head: string | null;
      branch: string | null;
      dirtyCount: number | null;
      diffDigest: string | null;
    };
    tools: Record<string, string>;
    credentialPresence: Record<string, "present" | "absent" | "unknown">;
    activeClaim: Record<string, unknown> | null;
    semanticIssues: string[];
  };
}

export interface BuildContextOptions {
  vaultRoot: string;
  project: string;
  taskId?: string;
  repoRoot?: string;
  profile?: "summary" | "full";
  credentialPresence?: Record<string, "present" | "absent" | "unknown">;
  now?: Date;
}

export interface VerifyContextResult {
  valid: boolean;
  expired: boolean;
  changedSources: string[];
  missingSources: string[];
  semanticIssues: string[];
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sourceEntry(vaultRoot: string, path: string): ContextSource {
  const source = readFileSync(path, "utf8");
  assertNoLikelySecret(source, path);
  const bytes = Buffer.byteLength(source);
  const limit = 64 * 1024;
  const content = bytes <= limit
    ? source
    : `${Buffer.from(source).subarray(0, 48 * 1024).toString("utf8")}\n\n[... PAWS context truncated ...]\n\n${Buffer.from(source).subarray(-16 * 1024).toString("utf8")}`;
  return {
    path: relative(vaultRoot, path).split(sep).join("/"),
    sha256: sha256Bytes(source),
    bytes,
    content,
    truncated: bytes > limit
  };
}

function filesIn(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(directory, entry.name))
    .sort(utf8Compare);
}

function backgroundPaths(vaultRoot: string, projectDir: string, profile: "summary" | "full"): string[] {
  const direct = [
    join(vaultRoot, "AGENTS.md"),
    join(projectDir, "AGENTS.md"),
    join(projectDir, `${basename(projectDir)}-主页.md`),
    join(projectDir, "spec.md"),
    join(projectDir, "HANDOFF.md"),
    join(projectDir, "execution-policy.md"),
    join(projectDir, "repository.md"),
    join(projectDir, "凭据.md")
  ].filter((path) => existsSync(path));
  const governed = [
    ...filesIn(join(projectDir, "spec")),
    ...filesIn(join(projectDir, "decisions"))
  ];
  return [...new Set(profile === "full" ? [...direct, ...governed] : direct)].sort(utf8Compare);
}

function toolVersion(command: string): string {
  const candidates = [command];
  if (command === "opencode") {
    const override = process.env.OPENCODE_REAL_BIN;
    if (override) candidates.unshift(override);
  }
  for (const candidate of [...new Set(candidates)]) {
    if (candidate.includes(sep) && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], {encoding: "utf8", timeout: 5_000});
    if (result.error || result.status !== 0) continue;
    return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/, 1)[0] ?? "unknown";
  }
  return "absent";
}

function gitRuntime(repoRoot?: string): ContextPack["runtime"]["git"] {
  if (!repoRoot || !existsSync(repoRoot)) {
    return {available: false, head: null, branch: null, dirtyCount: null, diffDigest: null};
  }
  const run = (args: string[]): string | null => {
    const result = spawnSync("git", args, {cwd: repoRoot, encoding: "utf8", timeout: 10_000});
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const head = run(["rev-parse", "HEAD"]);
  const branch = run(["branch", "--show-current"]);
  const status = run(["status", "--porcelain=v1", "-z"]);
  if (head === null || status === null) {
    return {available: false, head: null, branch: null, dirtyCount: null, diffDigest: null};
  }
  return {
    available: true,
    head,
    branch: branch || null,
    dirtyCount: status ? status.split("\0").filter(Boolean).length : 0,
    diffDigest: digestJson(status.split("\0").filter(Boolean).sort(utf8Compare))
  };
}

function legacyNextAction(handoffPath: string): string {
  try {
    const handoff = parseMarkdownFile(handoffPath);
    if (typeof handoff.data.next_action === "string" && handoff.data.next_action.trim()) return handoff.data.next_action;
    const section = handoff.body.match(/##\s*下一步[^\n]*\n([\s\S]*?)(?=\n##\s|$)/)?.[1]?.trim();
    return section ?? "人工读取 HANDOFF 下一步；legacy 模式禁止自动写入";
  } catch {
    return "HANDOFF frontmatter 无法安全解析；先修复或人工读取，legacy 模式禁止自动写入";
  }
}

function basedOnIssue(repoRoot: string | undefined, label: string, basedOn: unknown, head: string | null): string | null {
  if (!repoRoot || !head || typeof basedOn !== "string" || !basedOn.trim()) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(basedOn)) return `${label} based_on is not a Git commit: ${basedOn}`;
  const result = spawnSync("git", ["merge-base", "--is-ancestor", basedOn, head], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000
  });
  return result.status === 0 ? null : `${label} based_on is not an ancestor of runtime HEAD: ${basedOn}`;
}

export function buildContextPack(options: BuildContextOptions): ContextPack {
  const vaultRoot = resolve(options.vaultRoot);
  const projectDir = join(vaultRoot, "10-projects", options.project);
  if (!existsSync(projectDir)) throw new Error(`project does not exist: ${options.project}`);
  const now = options.now ?? new Date();
  const profile = options.profile ?? "summary";
  const background = backgroundPaths(vaultRoot, projectDir, profile).map((path) => sourceEntry(vaultRoot, path));
  const backgroundDigest = digestJson(background.map((source) => [source.path, source.sha256]));
  const runtimeGit = gitRuntime(options.repoRoot);
  const semanticIssues: string[] = [];
  let mode: ContextPack["mode"] = "legacy";
  let task: Record<string, unknown> | null = null;
  let taskSources: ContextSource[] = [];
  let evidence: Array<Record<string, unknown>> = [];
  let basedOn: string | null = null;
  let branch: string | null = null;
  let writeScope: string[] = [];
  let requiredGates: string[] = [];
  let blocker: string | null = null;
  let nextAction = legacyNextAction(join(projectDir, "HANDOFF.md"));
  let activeClaim: Record<string, unknown> | null = null;
  if (options.taskId) {
    const store = new ProjectStore(vaultRoot, options.project);
    mode = store.migrationMode() as ContextPack["mode"];
    const document = store.readTask(options.taskId);
    task = document.data;
    taskSources = [sourceEntry(vaultRoot, document.path)];
    evidence = store.evidenceDocuments()
      .filter((candidate) => Array.isArray(candidate.data.links) && candidate.data.links.some((link) => {
        return link !== null && typeof link === "object" && !Array.isArray(link) &&
          (link as Record<string, unknown>).rel === "evidence_for" &&
          (link as Record<string, unknown>).target === `task:${options.taskId}`;
      }))
      .map((candidate) => candidate.data);
    taskSources.push(...store.evidenceDocuments()
      .filter((candidate) => evidence.includes(candidate.data))
      .map((candidate) => sourceEntry(vaultRoot, candidate.path)));
    basedOn = String(document.data.based_on);
    branch = String(document.data.branch);
    writeScope = Array.isArray(document.data.write_scope) ? document.data.write_scope.map(String) : [];
    requiredGates = Array.isArray(document.data.required_gates) ? document.data.required_gates.map(String) : [];
    blocker = typeof document.data.blocker === "string" ? document.data.blocker : null;
    nextAction = String(document.data.next_action);
    activeClaim = document.data.claim && typeof document.data.claim === "object"
      ? document.data.claim as Record<string, unknown>
      : null;
  } else {
    const legacyPaths = [join(projectDir, "tasks.md")].filter((path) => existsSync(path));
    taskSources = legacyPaths.map((path) => sourceEntry(vaultRoot, path));
  }
  if (runtimeGit.available) {
    const handoff = parseMarkdownFile(join(projectDir, "HANDOFF.md"));
    const handoffIssue = basedOnIssue(options.repoRoot, "HANDOFF", handoff.data.based_on, runtimeGit.head);
    if (handoffIssue) semanticIssues.push(handoffIssue);
    const taskIssue = basedOnIssue(options.repoRoot, `WorkItem ${options.taskId ?? ""}`.trim(), task?.based_on, runtimeGit.head);
    if (taskIssue) semanticIssues.push(taskIssue);
  }
  const generatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  const packId = sha256Bytes(`${options.project}\0${options.taskId ?? "legacy"}\0${generatedAt}`);
  const pack: ContextPack = {
    formatVersion: 1,
    project: options.project,
    taskId: options.taskId ?? null,
    mode,
    profile,
    background: {ttlSeconds: 7 * 24 * 60 * 60, digest: backgroundDigest, sources: background},
    packId,
    generatedAt,
    expiresAt,
    delta: {
      ttlSeconds: 24 * 60 * 60,
      sources: taskSources,
      task,
      evidence,
      basedOn,
      branch,
      writeScope,
      requiredGates,
      evidenceFreshness: evidence.length > 0 ? "runtime-context-required" : "not-applicable",
      blocker,
      nextAction
    },
    runtime: {
      ttlSeconds: 15 * 60,
      git: runtimeGit,
      tools: {
        node: process.version,
        opencode: toolVersion("opencode"),
        claude: toolVersion("claude"),
        codex: toolVersion("codex")
      },
      credentialPresence: options.credentialPresence ?? {},
      activeClaim,
      semanticIssues
    }
  };
  assertNoLikelySecret(JSON.stringify(pack), `context pack ${packId}`);
  return pack;
}

export function writeContextPack(pack: ContextPack, path: string): void {
  const source = `${JSON.stringify(pack, null, 2)}\n`;
  assertNoLikelySecret(source, path);
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, source);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readContextPack(path: string): ContextPack {
  const source = readFileSync(path, "utf8");
  assertNoLikelySecret(source, path);
  return JSON.parse(source) as ContextPack;
}

export function verifyContextPack(vaultRootInput: string, pack: ContextPack, now = new Date()): VerifyContextResult {
  const vaultRoot = resolve(vaultRootInput);
  const changedSources: string[] = [];
  const missingSources: string[] = [];
  const all = [...pack.background.sources, ...pack.delta.sources];
  for (const source of all) {
    const path = resolve(vaultRoot, source.path);
    if (path !== vaultRoot && !path.startsWith(`${vaultRoot}${sep}`)) {
      changedSources.push(source.path);
      continue;
    }
    if (!existsSync(path)) {
      missingSources.push(source.path);
      continue;
    }
    if (sha256Bytes(readFileSync(path)) !== source.sha256) changedSources.push(source.path);
  }
  const expired = now > new Date(pack.expiresAt);
  const semanticIssues = Array.isArray(pack.runtime.semanticIssues) ? pack.runtime.semanticIssues.map(String) : [];
  return {
    valid: !expired && changedSources.length === 0 && missingSources.length === 0 && semanticIssues.length === 0,
    expired,
    changedSources: [...new Set(changedSources)].sort(utf8Compare),
    missingSources: [...new Set(missingSources)].sort(utf8Compare),
    semanticIssues: [...new Set(semanticIssues)].sort(utf8Compare)
  };
}
