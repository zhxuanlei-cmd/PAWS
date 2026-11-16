import {existsSync, readFileSync, realpathSync, statSync} from "node:fs";
import {homedir} from "node:os";
import {join, relative, resolve, sep} from "node:path";
import {spawnSync} from "node:child_process";
import {sha256Bytes} from "./digest.js";
import {PawsError} from "./errors.js";
import {parseMarkdown} from "./frontmatter.js";

export const BASELINE_PROVIDER = "openai";

export const EXTERNAL_REVIEW_ROUTES = {
  zhipuai: "paws-review-glm",
  deepseek: "paws-review-deepseek"
} as const;

export type ProviderPolicyMode = "strict" | "legacy" | "unmanaged";
export type ProjectMatchKind = "path" | "git-common-dir";
export type ReviewerWorkspaceAccess = "current-workspace" | "prompt-only";
export type ExecutionTrustProfile = "trusted-build" | "bootstrap-build" | "safe-read";
export type ExternalReviewAgent = typeof EXTERNAL_REVIEW_ROUTES[keyof typeof EXTERNAL_REVIEW_ROUTES];

export interface ProjectResolution {
  project: string;
  projectDir: string;
  codeRepo: string;
  cwd: string;
  matchedBy: ProjectMatchKind;
  gitCommonDir: string | null;
}

export interface ProviderPolicyResolution {
  mode: ProviderPolicyMode;
  project: string | null;
  projectDir: string | null;
  codeRepo: string | null;
  matchedBy: ProjectMatchKind | null;
  policyPath: string | null;
  policyHash: string | null;
  dataClass: string | null;
  allowedProviders: string[];
  reviewerWorkspaceAccess: ReviewerWorkspaceAccess;
  executionTrust: ExecutionTrustProfile;
}

export interface ResolveProjectOptions {
  gitBinary?: string;
  homeDir?: string;
  baselineProvider?: string;
}

export interface ProviderSelection {
  allowedProviders: readonly string[];
  reviewerWorkspaceAccess: ReviewerWorkspaceAccess;
  executionTrust: ExecutionTrustProfile;
  vaultRoot?: string;
  availableProviders?: readonly string[] | undefined;
}

type PermissionAction = "allow" | "deny";
// 提供方与 Task 路由仍只能明确放行或拒绝；仅 Bash 工具具有向用户询问的状态。
type BashPermissionAction = PermissionAction | "ask";
type JsonObject = Record<string, unknown>;

export interface OpenCodeRuntimeOverlay extends JsonObject {
  permission: JsonObject;
  agent: Record<string, JsonObject>;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ROUTING_PRIMARY_AGENTS = [
  "build",
  "plan",
  "paws-build",
  "paws-plan"
] as const;
const NON_ROUTING_AGENTS = [
  "general",
  "explore",
  "paws-review",
  "paws-explore"
] as const;
const PAWS_MCP_TOOLS = [
  "paws_projects_list",
  "paws_tasks_list",
  "paws_task_get",
  "paws_context_get",
  "paws_neighbors",
  "paws_search"
] as const;

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function policyError(code: "E_ACTION_PRECONDITION" | "E_POLICY_DENIED" | "E_SCHEMA", path: string, message: string, details?: Record<string, unknown>): PawsError {
  return new PawsError({code, path, message, ...(details ? {details} : {})});
}

function canonicalDirectory(input: string, label: string): string {
  const absolute = resolve(input);
  if (!existsSync(absolute)) {
    throw policyError("E_ACTION_PRECONDITION", absolute, `${label} does not exist`);
  }
  if (!statSync(absolute).isDirectory()) {
    throw policyError("E_ACTION_PRECONDITION", absolute, `${label} is not a directory`);
  }
  return realpathSync(absolute);
}

function within(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function reviewerWorkspaceAccess(vaultRoot: string, cwd: string): ReviewerWorkspaceAccess {
  return within(cwd, vaultRoot) || within(vaultRoot, cwd)
    ? "prompt-only"
    : "current-workspace";
}

function bootstrapWorkspaceAllowed(cwd: string, homeDirInput: string): boolean {
  const home = canonicalDirectory(homeDirInput, "home directory");
  if (cwd === home || within(home, cwd)) return false;

  if (within(cwd, home)) {
    const firstSegment = relative(home, cwd).split(sep)[0] ?? "";
    // Hidden user state and macOS application state are credential/configuration
    // surfaces, not project bootstrap roots. Normal visible project directories
    // under Home remain eligible.
    return firstSegment.length > 0 && !firstSegment.startsWith(".") && firstSegment !== "Library";
  }

  const homeParent = resolve(home, "..");
  if (within(cwd, homeParent)) return false;

  // Unmanaged workspaces on data volumes are useful bootstrap targets, while
  // system/runtime trees must never acquire writer authority by path alone.
  for (const root of [
    "/Applications",
    "/Library",
    "/System",
    "/bin",
    "/etc",
    "/opt",
    "/private",
    "/sbin",
    "/usr",
    "/var"
  ]) {
    if (within(cwd, resolve(root))) return false;
  }
  return cwd !== resolve("/");
}

function executionTrust(
  project: ProjectResolution | null,
  access: ReviewerWorkspaceAccess,
  cwd: string,
  homeDir: string
): ExecutionTrustProfile {
  if (access !== "current-workspace" || !bootstrapWorkspaceAllowed(cwd, homeDir)) return "safe-read";
  return project !== null ? "trusted-build" : "bootstrap-build";
}

/** Identity is owned by the vault resolver, shared with snapshots and capture. */
export function resolveProjectForCwd(
  vaultRootInput: string, cwdInput: string, options: ResolveProjectOptions = {}
): ProjectResolution | null {
  const vaultRoot = canonicalDirectory(vaultRootInput, "vault root");
  const cwd = canonicalDirectory(cwdInput, "OpenCode working directory");
  const script = join(vaultRoot, "scripts", "paws_repository.py");
  const result = spawnSync("python3", [script, "--vault", vaultRoot, "--cwd", cwd,
    "--home", options.homeDir ?? homedir(), "--git-binary", options.gitBinary ?? "git"],
    {encoding: "utf8", timeout: 30_000});
  let value: any;
  try { value = JSON.parse(result.stdout || ""); }
  catch { throw policyError("E_ACTION_PRECONDITION", script, "shared repository resolver unavailable"); }
  if (result.status !== 0 || value?.error) {
    throw policyError(value?.projects ? "E_POLICY_DENIED" : "E_ACTION_PRECONDITION", cwd,
      value?.error || "shared repository resolver failed", value?.projects ? {projects: value.projects} : undefined);
  }
  return value as ProjectResolution | null;
}

function stringArray(data: Record<string, unknown>, key: string, path: string): string[] {
  const value = data[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw policyError("E_SCHEMA", path, `${key} must be an array of non-empty strings`);
  }
  return value.map(String);
}

function validatedProviders(data: Record<string, unknown>, path: string): string[] {
  const providers = stringArray(data, "allowed_providers", path);
  if (providers.some((provider) => !PROVIDER_ID.test(provider))) {
    throw policyError("E_SCHEMA", path, "allowed_providers contains an invalid provider id");
  }
  if (new Set(providers).size !== providers.length) {
    throw policyError("E_SCHEMA", path, "allowed_providers contains duplicate provider ids");
  }
  return providers.sort(utf8Compare);
}

/**
 * 解析当前 OpenCode 启动的提供方授权。已登记项目的明确策略优先。
 * 没有策略时只开放本次配置指定的默认提供方；其余提供方需在项目策略明确列出。
 */
export function resolveProviderPolicy(
  vaultRootInput: string,
  cwdInput: string,
  options: ResolveProjectOptions = {}
): ProviderPolicyResolution {
  const vaultRoot = canonicalDirectory(vaultRootInput, "vault root");
  const cwd = canonicalDirectory(cwdInput, "OpenCode working directory");
  const homeDir = options.homeDir ?? homedir();
  const baselineProvider = options.baselineProvider ?? BASELINE_PROVIDER;
  if (!PROVIDER_ID.test(baselineProvider)) {
    throw policyError("E_SCHEMA", cwd, "invalid baseline provider id");
  }
  const access = reviewerWorkspaceAccess(vaultRoot, cwd);
  const project = resolveProjectForCwd(vaultRoot, cwd, options);
  if (!project) {
    return {
      mode: "unmanaged",
      project: null,
      projectDir: null,
      codeRepo: null,
      matchedBy: null,
      policyPath: null,
      policyHash: null,
      dataClass: null,
      allowedProviders: [baselineProvider],
      reviewerWorkspaceAccess: access,
      executionTrust: executionTrust(project, access, cwd, homeDir)
    };
  }

  const policyPath = join(project.projectDir, "execution-policy.md");
  if (!existsSync(policyPath)) {
    return {
      mode: "legacy",
      project: project.project,
      projectDir: project.projectDir,
      codeRepo: project.codeRepo,
      matchedBy: project.matchedBy,
      policyPath: null,
      policyHash: null,
      dataClass: null,
      allowedProviders: [baselineProvider],
      reviewerWorkspaceAccess: access,
      executionTrust: executionTrust(project, access, cwd, homeDir)
    };
  }

  const source = readFileSync(policyPath, "utf8");
  const document = parseMarkdown(source, policyPath);
  const data = document.data;
  if (data.type !== "policy") {
    throw policyError("E_SCHEMA", policyPath, "execution policy type must be policy");
  }
  if (data.project !== project.project) {
    throw policyError("E_SCHEMA", policyPath, "execution policy project does not match the resolved project");
  }
  if (data.status !== "active") {
    throw policyError("E_POLICY_DENIED", policyPath, "execution policy is not active");
  }
  const harnesses = stringArray(data, "allowed_harnesses", policyPath);
  if (!harnesses.includes("opencode")) {
    throw policyError("E_POLICY_DENIED", policyPath, "execution policy does not authorize the opencode harness");
  }
  const dataClass = data.data_class;
  if (dataClass !== undefined && (typeof dataClass !== "string" || dataClass.trim().length === 0)) {
    throw policyError("E_SCHEMA", policyPath, "data_class must be a non-empty string when present");
  }

  return {
    mode: "strict",
    project: project.project,
    projectDir: project.projectDir,
    codeRepo: project.codeRepo,
    matchedBy: project.matchedBy,
    policyPath,
    policyHash: sha256Bytes(source),
    dataClass: typeof dataClass === "string" ? dataClass : null,
    allowedProviders: validatedProviders(data, policyPath),
    reviewerWorkspaceAccess: access,
    executionTrust: executionTrust(project, access, cwd, homeDir)
  };
}

/**
 * 限定具有浏览器/桌面副作用的第三方 MCP；权限按原生工具名前缀匹配。
 * 静态服务及启动参数仍由 active config 管理，这里只保证工作区 trust 和只读角色
 * 不因新增 MCP 继承控制能力；公开文档检索不在这组执行权限中。
 */
function executionMcpPermission(action: PermissionAction): JsonObject {
  return {"playwright_*": action, "chrome_devtools_*": action, "peekaboo_*": action,
    // 桌面桥只提供原生动作；这些入口会启动另一个模型 Agent/视觉提供方，不在出口授权内。
    "peekaboo_agent": "deny", "peekaboo_analyze": "deny"};
}

function taskRules(glm: PermissionAction, deepseek: PermissionAction): Record<ExternalReviewAgent, PermissionAction> {
  return {
    "paws-review-glm": glm,
    "paws-review-deepseek": deepseek
  };
}

function taskPolicy(routes: Record<ExternalReviewAgent, PermissionAction>): Record<string, PermissionAction> {
  return {
    "*": "deny",
    "paws-review": "allow",
    "paws-explore": "allow",
    "paws-scout": "allow",
    ...routes
  };
}

/**
 * 生成只读角色的执行权限；是否允许 Task 路由由角色职责决定。
 * 普通角色不写 skill 字段，沿用 active config 中的专业能力和手动工作流设置；
 * Skill 访问不改变这里的 Bash/Edit/provider 限制，scout 与外部 reviewer 另保留明确拒绝。
 */
function safeReadPermission(routes: Record<ExternalReviewAgent, PermissionAction>, allowRouting: boolean): JsonObject {
  return {
    read: {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    edit: "deny",
    bash: "deny",
    external_directory: {"*": "deny"},
    webfetch: "allow",
    websearch: "allow",
    lsp: "allow",
    doom_loop: "ask",
    paws_maintenance_check: "deny",
    ...executionMcpPermission("deny"),
    task: allowRouting ? taskPolicy(routes) : "deny"
  };
}

/**
 * 生成推送审批规则：普通推送使用宿主 ask，原有破坏性推送范围继续拒绝。
 * 覆盖当前 PATH 命令、/usr/bin/git 和常用 -C/-c 全局参数；规则按插入顺序匹配。
 * 通配规则只提供命令入口约束，不解析全部 Git 参数，也不宣称完整 Shell 沙箱。
 */
function gitPushBashPolicy(): Record<string, BashPermissionAction> {
  const rules: Record<string, BashPermissionAction> = {};
  for (const command of ["git push", "git * push", "/usr/bin/git push", "/usr/bin/git * push"]) {
    rules[`${command}*`] = "ask";
    // 子集拒绝必须放在 ask 之后，保留强制更新、镜像和远端删除的既有禁区。
    const deniedSuffixes = ["--force*", " -f*", "--delete*", " -d*", "--mirror*", "--prune*",
      " +*", " :*", " \"+*", " '+*", " \":*", " ':*"];
    // -vf/-vd 等常见短选项组合同样有破坏语义；用字面前缀避免误拒 --follow-tags 等长选项。
    // 通配匹配并非完整 Git 参数解析；未覆盖的别名或组合仍不能取得破坏推送的任务授权。
    for (const prefix of ["v", "q", "u", "n", "4", "6", "vu", "uv", "vq", "qv"]) {
      deniedSuffixes.push(` -${prefix}f*`, ` -${prefix}d*`);
    }
    for (const suffix of deniedSuffixes) rules[`${command}*${suffix}`] = "deny";
  }
  return rules;
}

/**
 * 生成可信写者的 Shell 策略，返回由原生配置最后合并的命令规则。
 * 常规开发继续自动执行；裸 AppleScript 解释器必须显式询问，不能随通配 allow 放开。
 * 已审查 Word 包装脚本的单独 allow 由活跃配置维护，此处不复制其机器路径或扩大授权。
 */
function trustedWriterBashPolicy(): Record<string, BashPermissionAction> {
  return {
    "*": "allow",
    // 无参与带参入口分别限定，覆盖 PATH 命令和系统绝对路径；bootstrap 写者也继承该限制。
    "osascript": "ask",
    "osascript *": "ask",
    "/usr/bin/osascript": "ask",
    "/usr/bin/osascript *": "ask",
    // 暂存、提交和普通推送交给宿主审批；任务明确授权仍是前提，不自动批准 Git 写操作。
    "git add*": "ask",
    "git commit*": "ask",
    ...gitPushBashPolicy(),
    "git reset --hard*": "deny",
    "git clean -f*": "deny",
    "rm -r*": "deny",
    "rm -rf*": "deny",
    "security *": "deny",
    "/usr/bin/security *": "deny",
    "env*": "deny",
    "/usr/bin/env*": "deny",
    "printenv*": "deny",
    "/usr/bin/printenv*": "deny",
    "cat *.env*": "deny",
    "head *.env*": "deny",
    "tail *.env*": "deny",
    "grep *.env*": "deny",
    "rg *.env*": "deny",
    // 重型 Engine 写入口继续休眠；手动 /checkpoint 是 Skill，不是下面的 CLI 写命令。
    "paws task create*": "deny",
    "paws claim*": "deny",
    "paws checkpoint*": "deny",
    "paws release*": "deny",
    "paws resume*": "deny",
    "paws gate *": "deny",
    "paws gate run*": "deny",
    "paws gate record*": "deny",
    "paws materialize*": "deny",
    "paws recover*": "deny",
    "paws migration *": "deny",
    "paws adapters sync*": "deny"
  };
}

/** 生成当前可信工作区的写者权限；Skill 选择归 active config，此处只约束执行范围。 */
function trustedWriterPermission(
  routes: Record<ExternalReviewAgent, PermissionAction>,
  vaultRoot?: string
): JsonObject {
  const edit: Record<string, PermissionAction> = {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
    "**/.env.example": "allow",
    "**/凭据.md": "deny"
  };
  const externalDirectory: Record<string, PermissionAction> = {"*": "deny"};
  if (vaultRoot) {
    edit[`${resolve(vaultRoot)}/**`] = "deny";
    externalDirectory[`${resolve(vaultRoot)}/**`] = "allow";
  }
  return {
    read: {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    edit,
    bash: trustedWriterBashPolicy(),
    ...executionMcpPermission("allow"),
    external_directory: externalDirectory,
    webfetch: "allow",
    websearch: "allow",
    lsp: "allow",
    doom_loop: "ask",
    task: taskPolicy(routes)
  };
}

function trustedPlanPermission(
  routes: Record<ExternalReviewAgent, PermissionAction>,
  vaultRoot?: string
): JsonObject {
  const permission = safeReadPermission(routes, true);
  permission.edit = {
    "*": "deny",
    "**/tasks.md": "allow",
    "**/decisions/*.md": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "**/凭据.md": "deny"
  };
  const externalDirectory: Record<string, PermissionAction> = {"*": "deny"};
  if (vaultRoot) externalDirectory[`${resolve(vaultRoot)}/**`] = "allow";
  permission.external_directory = externalDirectory;
  return permission;
}

function bootstrapWriterPermission(
  routes: Record<ExternalReviewAgent, PermissionAction>,
  vaultRoot?: string
): JsonObject {
  const permission = trustedWriterPermission(routes, vaultRoot);
  const bash = permission.bash;
  if (!isJsonObject(bash)) {
    throw policyError("E_SCHEMA", "runtime-overlay", "bootstrap writer bash policy must be an object");
  }
  permission.bash = {
    ...bash,
    // Bootstrap may create and test project files, but it is not a PAWS project
    // identity and therefore cannot mutate canonical task/evidence state.
    "paws task create*": "deny",
    "paws claim*": "deny",
    "paws checkpoint*": "deny",
    "paws release*": "deny",
    "paws resume*": "deny",
    "paws gate run*": "deny",
    "paws gate record*": "deny",
    "paws materialize*": "deny",
    "paws recover*": "deny",
    "paws adapters sync*": "deny"
  };
  permission.external_directory = {"*": "deny"};
  return permission;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 生成手动整固角色的权限：允许跨目录读取 Vault，并仅编辑既有知识/记忆 Markdown 域。
 * vaultRoot 未提供时不授予编辑或跨目录访问；无论 cwd 是否建档，均不授予 shell、cwd 业务代码写入或 Task 路由。
 */
function maintenancePermission(vaultRoot?: string): JsonObject {
  const permission = safeReadPermission(taskRules("deny", "deny"), false);
  const edit: Record<string, PermissionAction> = {"*": "deny"};
  if (vaultRoot) {
    const root = resolve(vaultRoot);
    for (const suffix of ["30-resources/wiki/*.md", "20-areas/insights/*.md",
      "memory/facts/*.md", "memory/profile.md", "memory/episodes/*.md",
      "memory/agent/cases/*.md", "memory/agent/candidates/**",
      "20-areas/*/MOC-*.md", "30-resources/知识总索引.md"])
      edit[`${root}/${suffix}`] = "allow";
    permission.external_directory = {"*": "deny", [root + "/**"]: "allow"};
  }
  permission.edit = edit;
  permission.bash = "deny";
  permission.paws_maintenance_check = "allow";
  return permission;
}

function externalReviewer(enabled: boolean, access: ReviewerWorkspaceAccess): JsonObject {
  const workspaceReadable = enabled && access === "current-workspace";
  const permission: JsonObject = {
    "*": "deny",
    read: workspaceReadable
      ? {
          "*": "allow",
          "*.env": "deny",
          "*.env.*": "deny",
          "**/.env": "deny",
          "**/.env.*": "deny",
          "**/*.pem": "deny",
          "**/*.key": "deny",
          "**/id_rsa": "deny",
          "**/id_ed25519": "deny",
          "**/.aws/credentials": "deny",
          "**/凭据.md": "deny",
          "*.env.example": "allow",
          "**/.env.example": "allow"
        }
      : "deny",
    glob: workspaceReadable ? "allow" : "deny",
    grep: workspaceReadable ? "allow" : "deny",
    list: workspaceReadable ? "allow" : "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    skill: "deny",
    webfetch: "deny",
    websearch: "deny",
    question: "deny",
    todowrite: "deny",
    doom_loop: "deny",
    external_directory: {"*": "deny"},
    "paws_*": "deny",
    ...executionMcpPermission("deny"),
    "context7_*": "deny",
    "openai_docs_*": "deny"
  };
  for (const tool of PAWS_MCP_TOOLS) permission[tool] = "deny";
  return {
    disable: !enabled,
    hidden: !enabled,
    permission
  };
}

/**
 * Build a highest-precedence OpenCode inline overlay. Unapproved reviewer
 * agents are removed from the runtime registry (`disable`), so neither Task,
 * direct @ invocation nor `--auto` can turn an earlier project-level allow into
 * an external-provider call.
 */
export function buildRuntimeOverlay(selection: ProviderSelection): OpenCodeRuntimeOverlay {
  const available = new Set(selection.availableProviders ?? selection.allowedProviders);
  const allowed = new Set(selection.allowedProviders.filter(p => available.has(p)));
  const glmEnabled = allowed.has("zhipuai");
  const deepseekEnabled = allowed.has("deepseek");
  const denyRoutes = taskRules("deny", "deny");
  const selectedRoutes = taskRules(glmEnabled ? "allow" : "deny", deepseekEnabled ? "allow" : "deny");
  const agents: Record<string, JsonObject> = {};

  for (const agent of NON_ROUTING_AGENTS) {
    agents[agent] = {permission: safeReadPermission(denyRoutes, false)};
  }
  for (const agent of ROUTING_PRIMARY_AGENTS) {
    const trustedWriter = selection.executionTrust === "trusted-build" && agent === "paws-build";
    const trustedPlan = selection.executionTrust === "trusted-build" && agent === "paws-plan";
    const bootstrapWriter = selection.executionTrust === "bootstrap-build" && agent === "paws-build";
    agents[agent] = {
      permission: trustedWriter
        ? trustedWriterPermission(selectedRoutes, selection.vaultRoot)
        : trustedPlan
          ? trustedPlanPermission(selectedRoutes, selection.vaultRoot)
        : bootstrapWriter
          ? bootstrapWriterPermission(selectedRoutes, selection.vaultRoot)
        : safeReadPermission(selectedRoutes, true)
    };
  }
  // The scout only receives its bounded question and primary-source web access.
  agents["paws-scout"] = {permission: {...safeReadPermission(denyRoutes, false), read: "deny",
    glob: "deny", grep: "deny", list: "deny", skill: "deny", lsp: "deny"}};
  // 手动维护的目标是 Vault 记录，不是 cwd 的业务代码；已有写域限制足以分离两者。
  // 入口始终可用，不能再因来源会话未建档或代码 trust 为只读而被隐藏/禁用。
  agents["paws-maintain"] = {disable: false, hidden: false,
    permission: maintenancePermission(selection.vaultRoot)};
  agents["paws-review-glm"] = externalReviewer(glmEnabled, selection.reviewerWorkspaceAccess);
  agents["paws-review-deepseek"] = externalReviewer(deepseekEnabled, selection.reviewerWorkspaceAccess);

  const overlay: OpenCodeRuntimeOverlay = {
    permission: safeReadPermission(selectedRoutes, true),
    agent: agents,
    enabled_providers: [...allowed]
  };
  return overlay;
}
