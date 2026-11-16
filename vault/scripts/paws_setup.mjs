#!/usr/bin/env node
/**
 * PAWS 跨工具接线器。
 *
 * 默认命令是 plan（严格只读）。apply 只管理 manifest 中列出的精确目标，普通文件
 * 必须逐个 --adopt；doctor 只读；rollback 在现状仍等于本次安装结果时才恢复。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const COMMANDS = new Set(["plan", "apply", "doctor", "rollback"])
const MANAGED_BY = "paws_setup"
// 宿主定向安装只观察和修改其目录，避免顺带改动其他工具或 device map。
// 宿主写域与安装清单目标相对应。OpenCode launcher 使用单独的文件名，保留原生命令。
const HOST_ROOTS = {
  codex: [".codex", ".agents/skills"],
  claude: [".claude"],
  opencode: [".config/opencode", ".local/bin/paws-opencode"],
  antigravity: [".gemini"],
  hermes: [".hermes"],
}
const HOST_NAMES = Object.keys(HOST_ROOTS).join("|")

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

function usage() {
  return `用法:
  node scripts/paws_setup.mjs [plan] [--home PATH] [--vault PATH] [--host ${HOST_NAMES}]
  node scripts/paws_setup.mjs apply [--home PATH] [--vault PATH]
       [--paws-control PATH] [--opencode-real-bin PATH] [--adopt TARGET ...] [--host ${HOST_NAMES}]
  node scripts/paws_setup.mjs doctor [--home PATH] [--vault PATH]
       [--paws-control PATH] [--opencode-real-bin PATH] [--host ${HOST_NAMES}]
  node scripts/paws_setup.mjs rollback RUN_ID [--home PATH] [--vault PATH]

plan 与 doctor 严格只读。已有普通文件和其他工作区的 symlink 只有在 apply 时逐个 --adopt 才会被备份并接管。
--host 只处理指定宿主入口；OpenCode 接线同时维护设备映射，省略则检查全部入口。
Hermes 配置渲染需要 Python + PyYAML；优先 PAWS_PYTHON、已有 Hermes venv，最后 python3。`
}

function parseArgs(argv) {
  const args = [...argv]
  let command = "plan"
  if (args[0] && !args[0].startsWith("-")) {
    if (!COMMANDS.has(args[0])) throw new CliError(`未知命令: ${args[0]}\n${usage()}`, 2)
    command = args.shift()
  }

  let runId = null
  if (command === "rollback" && args[0] && !args[0].startsWith("-")) runId = args.shift()
  const opts = { command, runId, home: null, vault: null, manifest: null, pawsControl: null, opencodeRealBin: null, host: null, adopts: [] }

  while (args.length) {
    const flag = args.shift()
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    }
    if (!["--home", "--vault", "--manifest", "--paws-control", "--opencode-real-bin", "--adopt", "--host"].includes(flag)) {
      throw new CliError(`未知参数: ${flag}\n${usage()}`, 2)
    }
    if (!args.length) throw new CliError(`${flag} 缺少值`, 2)
    const value = args.shift()
    if (flag === "--home") opts.home = value
    else if (flag === "--vault") opts.vault = value
    else if (flag === "--manifest") opts.manifest = value
    else if (flag === "--paws-control") opts.pawsControl = value
    else if (flag === "--opencode-real-bin") opts.opencodeRealBin = value
    else if (flag === "--host") opts.host = value
    else opts.adopts.push(value)
  }

  if (command === "rollback" && !runId) throw new CliError("rollback 需要 RUN_ID", 2)
  if (command !== "apply" && opts.adopts.length) {
    throw new CliError("--adopt 只允许与 apply 一起使用", 2)
  }
  if (opts.host !== null && (!Object.hasOwn(HOST_ROOTS, opts.host) || command === "rollback")) {
    throw new CliError(`--host 支持 ${HOST_NAMES} 的 plan/apply/doctor；rollback 按 RUN_ID 恢复原批次`, 2)
  }
  if ((opts.opencodeRealBin !== null || opts.pawsControl !== null) &&
      (command === "rollback" || !managesDevice(opts))) {
    throw new CliError("设备参数用于 OpenCode 或全量 plan/apply/doctor", 2)
  }
  return opts
}

/** OpenCode 启动器消费本机映射；其他宿主定向安装无需读取或更新映射。 */
function managesDevice(opts) {
  return !opts.host || opts.host === "opencode"
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file))
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
}

function canonicalizePotential(candidate) {
  let current = path.resolve(candidate)
  const tail = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    tail.unshift(path.basename(current))
    current = parent
  }
  const physical = fs.existsSync(current) ? fs.realpathSync(current) : current
  return path.join(physical, ...tail)
}

function canonicalizeLocation(candidate) {
  return path.join(canonicalizePotential(path.dirname(candidate)), path.basename(candidate))
}

function expandPortable(value, { home, vault }) {
  if (typeof value !== "string") throw new CliError("manifest 路径必须是字符串")
  if (value === "$HOME") return home
  if (value.startsWith("$HOME/")) return path.resolve(home, value.slice(6))
  if (value === "$VAULT") return vault
  if (value.startsWith("$VAULT/")) return path.resolve(vault, value.slice(7))
  return path.resolve(value)
}

function assertPortableSource(source) {
  if (path.isAbsolute(source) || source.split(/[\\/]/).includes("..")) {
    throw new CliError(`source 必须是 vault 内相对路径: ${source}`)
  }
}

function scanManifestForSensitiveValues(value, trail = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanManifestForSensitiveValues(item, `${trail}[${index}]`))
    return
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/(^|_)(password|secret|token|credential|api_key)($|_)/i.test(key)) {
        throw new CliError(`${trail}.${key} 不允许保存敏感字段`)
      }
      scanManifestForSensitiveValues(child, `${trail}.${key}`)
    }
    return
  }
  if (typeof value === "string" && /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/.test(value)) {
    throw new CliError(`${trail} 疑似包含凭据值`)
  }
}

function sourceKind(source) {
  return fs.statSync(source).isDirectory() ? "dir" : "file"
}

function desiredRelativeLink(source, target) {
  const rel = path.relative(path.dirname(target), source)
  if (!rel || path.isAbsolute(rel)) throw new CliError(`无法生成相对 symlink: ${target}`)
  return rel
}

function addLink(links, seen, id, sourceRaw, targetRaw, ctx) {
  assertPortableSource(sourceRaw)
  const source = path.resolve(ctx.vault, sourceRaw)
  if (!isInside(ctx.vault, source)) throw new CliError(`source 越出 vault: ${sourceRaw}`)
  if (!fs.existsSync(source)) throw new CliError(`source 不存在: ${sourceRaw}`)
  const realSource = fs.realpathSync(source)
  const realVault = fs.realpathSync(ctx.vault)
  if (!isInside(realVault, realSource)) throw new CliError(`source symlink 越出 vault: ${sourceRaw}`)
  registerLink(links, seen, id, source, sourceRaw, targetRaw, ctx)
}

/** 将已核验来源加入精确目标清单；所有来源共用 HOME 边界和目标去重。 */
function registerLink(links, seen, id, source, sourceRaw, targetRaw, ctx) {
  const target = expandPortable(targetRaw, ctx)
  if (!isInside(ctx.home, target) || target === ctx.home) {
    throw new CliError(`target 必须位于 HOME 内: ${targetRaw}`)
  }
  if (seen.has(target)) throw new CliError(`manifest target 重复: ${targetRaw}`)
  seen.add(target)
  links.push({ id, source, sourceRaw, target, targetRaw, kind: sourceKind(source) })
}

function flattenLinks(manifest, ctx) {
  const links = []
  const seen = new Set()
  const global = manifest.global_instructions
  for (const [index, target] of global.targets.entries()) {
    addLink(links, seen, `global-${index + 1}`, global.source, target, ctx)
  }
  for (const command of manifest.commands) {
    for (const link of command.links) {
      addLink(links, seen, `command-${command.name}-${links.length}`, link.source, link.target, ctx)
    }
  }
  for (const name of manifest.skills.names) {
    const source = path.posix.join(manifest.skills.source_root, name)
    for (const targetRoot of manifest.skills.target_roots) {
      addLink(links, seen, `skill-${name}-${links.length}`, source, `${targetRoot}/${name}`, ctx)
    }
  }
  for (const adapter of manifest.adapters) {
    addLink(links, seen, `adapter-${adapter.name}`, adapter.source, adapter.target, ctx)
  }
  return links
}

function loadContext(opts) {
  const scriptVault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const home = canonicalizePotential(opts.home || os.homedir())
  // OpenCode 清单只管理 ~/.config；真实 HOME 使用自定义 XDG 时须在接线前报错。
  // 指定其他 --home 的隔离演练和已有批次回滚沿用各自记录的固定路径。
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  if (opts.command !== "rollback" && managesDevice(opts) && xdgConfigHome &&
      home === canonicalizePotential(os.homedir()) &&
      (!path.isAbsolute(xdgConfigHome) ||
       canonicalizePotential(xdgConfigHome) !== canonicalizePotential(path.join(home, ".config")))) {
    throw new CliError("PAWS OpenCode 接线使用 ~/.config/opencode；当前 XDG_CONFIG_HOME 指向其他目录。使用默认配置目录后重试，或继续使用原生 OpenCode。", 2)
  }
  const vault = canonicalizePotential(opts.vault || scriptVault)
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) throw new CliError(`vault 不存在: ${vault}`)
  const manifestPath = path.resolve(opts.manifest || path.join(vault, "paws.manifest.json"))
  if (!isInside(vault, manifestPath)) throw new CliError("manifest 必须位于 vault 内")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  if (manifest.schema_version !== 1 || manifest.managed_by !== MANAGED_BY) {
    throw new CliError("不支持的 manifest schema 或 managed_by")
  }
  scanManifestForSensitiveValues(manifest)
  const ctx = { opts, home, vault, manifestPath, manifest }
  ctx.stateRoot = expandPortable(manifest.state_root, ctx)
  ctx.deviceMap = expandPortable(manifest.device_map, ctx)
  for (const target of [ctx.stateRoot, ctx.deviceMap]) {
    if (!isInside(home, target) || target === home) throw new CliError("状态路径必须位于 HOME 内")
  }
  ctx.links = flattenLinks(manifest, ctx)
  // 仅保留指定宿主的入口；验证并构造完整清单后再按目标归属分组。
  if (opts.host) {
    const roots = HOST_ROOTS[opts.host].map(root => path.join(home, root))
    ctx.links = ctx.links.filter(link => roots.some(root => isInside(root, link.target)))
    if (!ctx.links.length) throw new CliError(`manifest 未声明 ${opts.host} 入口`, 2)
  }
  ctx.adoptSet = new Set(opts.adopts.map((item) => canonicalizeLocation(expandPortable(item, ctx))))
  for (const adopted of ctx.adoptSet) {
    if (!ctx.links.some((link) => link.target === adopted) && (!managesDevice(opts) || adopted !== ctx.deviceMap)) {
      throw new CliError(`--adopt 不是 manifest 管理目标: ${adopted}`, 2)
    }
  }
  return ctx
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

function fingerprint(target) {
  const stat = lstatOrNull(target)
  if (!stat) return "missing"
  if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(target)}`
  if (stat.isFile()) return `file:${sha256File(target)}`
  if (stat.isDirectory()) return "directory"
  return "special"
}

function inspectLink(link, adoptSet) {
  const wanted = desiredRelativeLink(link.source, link.target)
  const stat = lstatOrNull(link.target)
  if (!stat) return { ...link, desiredLink: wanted, status: "missing", blocked: false, beforeFingerprint: "missing" }
  if (stat.isSymbolicLink()) {
    const actual = fs.readlinkSync(link.target)
    // 同一来源的绝对链接可规范化；其他项目或其他安装的链接仍属于用户。
    const resolvesToSource = canonicalizePotential(path.resolve(path.dirname(link.target), actual)) ===
      canonicalizePotential(link.source)
    const blocked = !resolvesToSource && !adoptSet.has(link.target)
    const status = actual === wanted ? "correct" : (blocked ? "blocked-symlink" : "replace-symlink")
    return { ...link, desiredLink: wanted, actualLink: actual, status, blocked, beforeFingerprint: `symlink:${actual}` }
  }
  if (stat.isFile()) {
    const adopted = adoptSet.has(link.target)
    return {
      ...link,
      desiredLink: wanted,
      status: adopted ? "adopt-file" : "blocked-file",
      blocked: !adopted,
      beforeFingerprint: `file:${sha256File(link.target)}`,
    }
  }
  return {
    ...link,
    desiredLink: wanted,
    status: stat.isDirectory() ? "blocked-directory" : "blocked-special",
    blocked: true,
    beforeFingerprint: stat.isDirectory() ? "directory" : "special",
  }
}

function executablePath(name) {
  const suffixes = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return path.resolve(candidate)
      } catch {
        // 继续查找 PATH。
      }
    }
  }
  return null
}

function readManagedDevice(target) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"))
    return parsed && parsed.schema_version === 1 && parsed.managed_by === MANAGED_BY ? parsed : null
  } catch {
    return null
  }
}

/** 生成当前本机映射；只保留明确支持的人工覆盖，不扩大为未知字段透传。 */
function deviceData(ctx, existing = null) {
  // 原生 binary pin 必须是显式绝对路径；可用性由 launcher 核对，不从 PATH 猜测。
  const hasNativePin = ctx.opts.opencodeRealBin !== null || Object.hasOwn(existing || {}, "opencode_real_bin")
  const nativePin = ctx.opts.opencodeRealBin ?? existing?.opencode_real_bin
  if (hasNativePin && (typeof nativePin !== "string" || !path.isAbsolute(nativePin) || /[\x00-\x1f]/.test(nativePin))) {
    throw new CliError("device opencode_real_bin 必须为不含控制字符的绝对路径")
  }
  const pawsControl = ctx.opts.pawsControl
    ? path.resolve(ctx.opts.pawsControl)
    : (existing?.paths?.paws_control || null)
  return {
    schema_version: 1,
    managed_by: MANAGED_BY,
    device_id: os.hostname(),
    platform: process.platform,
    architecture: process.arch,
    // 本机项目路径覆盖不是业务正本；重跑 apply 必须保留，解析器统一消费。
    repositories: existing?.repositories || {},
    ...(hasNativePin ? {opencode_real_bin: nativePin} : {}),
    paths: {
      home: ctx.home,
      vault: ctx.vault,
      paws_control: pawsControl,
    },
    tools: {
      node: process.execPath,
      python3: executablePath("python3"),
      git: executablePath("git"),
      codex: executablePath("codex"),
      opencode: executablePath("opencode"),
      claude: executablePath("claude"),
      hermes: executablePath("hermes"),
    },
  }
}

function inspectDevice(ctx) {
  const stat = lstatOrNull(ctx.deviceMap)
  const existing = stat?.isFile() ? readManagedDevice(ctx.deviceMap) : null
  const content = `${JSON.stringify(deviceData(ctx, existing), null, 2)}\n`
  if (!stat) return { id: "device-map", target: ctx.deviceMap, content, status: "missing", blocked: false, beforeFingerprint: "missing" }
  if (stat.isSymbolicLink()) {
    const adopted = ctx.adoptSet.has(ctx.deviceMap)
    return { id: "device-map", target: ctx.deviceMap, content, status: adopted ? "replace-symlink" : "blocked-symlink",
      blocked: !adopted, beforeFingerprint: fingerprint(ctx.deviceMap) }
  }
  if (stat.isFile()) {
    if (fs.readFileSync(ctx.deviceMap, "utf8") === content) {
      return { id: "device-map", target: ctx.deviceMap, content, status: "correct", blocked: false, beforeFingerprint: fingerprint(ctx.deviceMap) }
    }
    const adopted = ctx.adoptSet.has(ctx.deviceMap)
    return {
      id: "device-map",
      target: ctx.deviceMap,
      content,
      status: existing ? "replace-managed-file" : (adopted ? "adopt-file" : "blocked-file"),
      blocked: !existing && !adopted,
      beforeFingerprint: fingerprint(ctx.deviceMap),
    }
  }
  return {
    id: "device-map",
    target: ctx.deviceMap,
    content,
    status: stat.isDirectory() ? "blocked-directory" : "blocked-special",
    blocked: true,
    beforeFingerprint: stat.isDirectory() ? "directory" : "special",
  }
}

/**
 * 只渲染 Hermes 的 PAWS 配置切片，不安装模型、读取凭据存储或执行工作流。
 * Python 输出只在进程间传递；公开 plan/doctor 仅列状态，绝不打印配置正文。
 */
function inspectHermesConfig(ctx) {
  if (!ctx.manifest.hermes_config || (ctx.opts.host && ctx.opts.host !== "hermes")) return null
  const target = expandPortable(ctx.manifest.hermes_config.target, ctx)
  if (!isInside(path.join(ctx.home, ".hermes"), target)) throw new CliError("Hermes 配置目标越界", 2)
  const stat = lstatOrNull(target)
  if (stat && !stat.isFile()) {
    return { id: "hermes-config", target, status: "blocked-nonfile", blocked: true }
  }
  const original = stat ? fs.readFileSync(target, "utf8") : ""
  const nativePython = path.join(ctx.home, ".hermes", "hermes-agent", "venv", "bin", "python")
  const python = process.env.PAWS_PYTHON || (fs.existsSync(nativePython) ? nativePython : "python3")
  const result = spawnSync(python, ["-B", path.join(ctx.vault, "scripts/adapters/hermes/render_config.py")], {
    input: JSON.stringify({ original, settings: ctx.manifest.hermes_config, home: ctx.home }),
    encoding: "utf8", maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) {
    // 渲染器只输出固定错误类别；不把底层异常（可能带原配置）转发到日志。
    throw new CliError(`Hermes 配置未渲染：${result.error ? "Python 不可执行" : result.stderr.trim() || "渲染失败"}`, 2)
  }
  const { content } = JSON.parse(result.stdout)
  return { id: "hermes-config", target, content,
    status: original === content ? "correct" : (stat ? "merge-hermes-config" : "missing"),
    blocked: false, beforeFingerprint: fingerprint(target) }
}

function inspectAll(ctx) {
  const links = ctx.links.map((link) => inspectLink(link, ctx.adoptSet))
  // 设备映射仅由全量或 OpenCode 安装维护；文件变化与链接进入同一备份和回滚事务。
  const device = managesDevice(ctx.opts) ? inspectDevice(ctx) : null
  const hermes = inspectHermesConfig(ctx)
  return { links, device, hermes, items: [...links, ...[device, hermes].filter(Boolean)] }
}

function publicInspection(inspected) {
  return inspected.items.map((item) => ({
    id: item.id,
    target: item.target,
    source: item.source || undefined,
    status: item.status,
    blocked: item.blocked,
  }))
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function runPlan(ctx) {
  const inspected = inspectAll(ctx)
  const blocked = inspected.items.filter((item) => item.blocked)
  const changes = inspected.items.filter((item) => item.status !== "correct")
  printJson({
    command: "plan",
    host: ctx.opts.host || "all",
    read_only: true,
    ok: blocked.length === 0,
    summary: { total: inspected.items.length, changes: changes.length, blocked: blocked.length },
    items: publicInspection(inspected),
    next: blocked.length ? "逐个核对 blocked 目标；确认接管时用 apply --adopt <精确路径>" : "可执行 apply",
  })
  return blocked.length ? 2 : 0
}

function assertSafeAncestors(home, target) {
  if (!isInside(home, target) || target === home) throw new CliError(`拒绝 HOME 外目标: ${target}`)
  let current = path.dirname(target)
  while (current !== home) {
    const stat = lstatOrNull(current)
    if (stat?.isSymbolicLink()) throw new CliError(`目标祖先是 symlink，拒绝写入: ${current}`)
    const parent = path.dirname(current)
    if (parent === current || !isInside(home, parent)) throw new CliError(`无法验证目标祖先: ${target}`)
    current = parent
  }
}

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function writeJsonPrivate(target, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" })
  try {
    try {
      fs.renameSync(temp, target)
    } catch (error) {
      if (!fs.existsSync(target) || !["EEXIST", "EPERM"].includes(error.code)) throw error
      fs.unlinkSync(target)
      fs.renameSync(temp, target)
    }
    fs.chmodSync(target, 0o600)
  } finally {
    if (lstatOrNull(temp)) fs.unlinkSync(temp)
  }
}

function backupItem(item, backupDir, index) {
  const stat = lstatOrNull(item.target)
  if (!stat) return { kind: "missing" }
  if (stat.isSymbolicLink()) return { kind: "symlink", link: fs.readlinkSync(item.target) }
  if (!stat.isFile()) throw new CliError(`只允许备份普通文件或 symlink: ${item.target}`)
  const name = `${String(index).padStart(3, "0")}.file`
  const backup = path.join(backupDir, name)
  fs.copyFileSync(item.target, backup, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(backup, 0o600)
  return { kind: "file", backup: path.relative(path.dirname(backupDir), backup), mode: stat.mode & 0o777 }
}

function unlinkManagedTarget(target) {
  const stat = lstatOrNull(target)
  if (!stat) return
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new CliError(`拒绝删除非文件目标: ${target}`)
  fs.unlinkSync(target)
}

function installSymlink(item) {
  mkdirPrivate(path.dirname(item.target))
  const temp = `${item.target}.paws-tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  try {
    fs.symlinkSync(item.desiredLink, temp, item.kind === "dir" ? "dir" : "file")
    unlinkManagedTarget(item.target)
    fs.renameSync(temp, item.target)
  } finally {
    if (lstatOrNull(temp)) fs.unlinkSync(temp)
  }
}

function installDevice(item) {
  mkdirPrivate(path.dirname(item.target))
  const temp = `${item.target}.paws-tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  try {
    fs.writeFileSync(temp, item.content, { mode: 0o600, flag: "wx" })
    unlinkManagedTarget(item.target)
    fs.renameSync(temp, item.target)
    fs.chmodSync(item.target, 0o600)
  } finally {
    if (lstatOrNull(temp)) fs.unlinkSync(temp)
  }
}

function restoreRecord(record, runDir) {
  const before = record.before
  if (before.kind === "missing") {
    unlinkManagedTarget(record.target)
    return
  }
  mkdirPrivate(path.dirname(record.target))
  if (before.kind === "symlink") {
    const temp = `${record.target}.paws-restore-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
    try {
      fs.symlinkSync(before.link, temp, record.item_kind === "dir" ? "dir" : "file")
      unlinkManagedTarget(record.target)
      fs.renameSync(temp, record.target)
    } finally {
      if (lstatOrNull(temp)) fs.unlinkSync(temp)
    }
    return
  }
  if (before.kind === "file") {
    const source = path.resolve(runDir, before.backup)
    if (!isInside(runDir, source)) throw new CliError("回滚备份路径越界")
    const temp = `${record.target}.paws-restore-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
    try {
      fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(temp, before.mode)
      unlinkManagedTarget(record.target)
      fs.renameSync(temp, record.target)
    } finally {
      if (lstatOrNull(temp)) fs.unlinkSync(temp)
    }
    return
  }
  throw new CliError(`未知备份类型: ${before.kind}`)
}

function runApply(ctx) {
  const inspected = inspectAll(ctx)
  const blocked = inspected.items.filter((item) => item.blocked)
  if (blocked.length) {
    printJson({
      command: "apply",
      ok: false,
      changed: false,
      reason: "blocked-targets",
      items: publicInspection(inspected),
    })
    return 2
  }
  const changes = inspected.items.filter((item) => item.status !== "correct")
  if (!changes.length) {
    printJson({ command: "apply", ok: true, changed: false, run_id: null, summary: "already-current" })
    return 0
  }

  assertSafeAncestors(ctx.home, ctx.stateRoot)
  for (const item of changes) assertSafeAncestors(ctx.home, item.target)
  mkdirPrivate(ctx.stateRoot)
  const runsRoot = path.join(ctx.stateRoot, "runs")
  mkdirPrivate(runsRoot)
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`
  const runDir = path.join(runsRoot, runId)
  const backupDir = path.join(runDir, "backup")
  fs.mkdirSync(runDir, { mode: 0o700 })
  fs.mkdirSync(backupDir, { mode: 0o700 })

  const records = changes.map((item, index) => ({
    id: item.id,
    target: item.target,
    item_kind: item.kind || "file",
    before_fingerprint: item.beforeFingerprint,
    before: backupItem(item, backupDir, index),
    after: item.source
      ? { kind: "symlink", link: item.desiredLink, fingerprint: `symlink:${item.desiredLink}` }
      : { kind: "file", fingerprint: `file:${sha256Buffer(item.content)}` },
  }))
  const journalPath = path.join(runDir, "journal.json")
  const journal = {
    schema_version: 1,
    managed_by: MANAGED_BY,
    run_id: runId,
    status: "prepared",
    manifest_sha256: sha256File(ctx.manifestPath),
    home: ctx.home,
    vault: ctx.vault,
    records,
  }
  writeJsonPrivate(journalPath, journal)

  const mutated = []
  try {
    for (let index = 0; index < changes.length; index += 1) {
      const item = changes[index]
      const record = records[index]
      if (fingerprint(item.target) !== record.before_fingerprint) {
        throw new CliError(`目标在 plan/apply 之间发生变化: ${item.target}`)
      }
      mutated.push(record)
      if (item.source) installSymlink(item)
      else installDevice(item)
      if (fingerprint(item.target) !== record.after.fingerprint) {
        throw new CliError(`安装后校验失败: ${item.target}`)
      }
    }
    journal.status = "applied"
    journal.applied_at = new Date().toISOString()
    writeJsonPrivate(journalPath, journal)
  } catch (error) {
    let restored = true
    for (const record of [...mutated].reverse()) {
      try {
        restoreRecord(record, runDir)
      } catch {
        restored = false
      }
    }
    journal.status = restored ? "failed-restored" : "failed-needs-manual-recovery"
    journal.failed_at = new Date().toISOString()
    writeJsonPrivate(journalPath, journal)
    throw error
  }

  printJson({
    command: "apply",
    ok: true,
    changed: true,
    run_id: runId,
    changed_targets: records.map((record) => record.target),
    rollback: `node scripts/paws_setup.mjs rollback ${runId}`,
  })
  return 0
}

function modeOf(target) {
  return lstatOrNull(target)?.mode & 0o777
}

function runDoctor(ctx) {
  const inspected = inspectAll(ctx)
  const errors = []
  const warnings = []
  for (const item of inspected.links) {
    if (item.status !== "correct") errors.push({ code: "link-not-current", target: item.target, status: item.status })
  }
  if (inspected.hermes && inspected.hermes.status !== "correct") {
    errors.push({ code: "hermes-config-not-current", target: inspected.hermes.target, status: inspected.hermes.status })
  }
  if (inspected.device && inspected.device.status !== "correct") {
    errors.push({ code: "device-map-not-current", target: ctx.deviceMap, status: inspected.device.status })
  } else if (inspected.device && process.platform !== "win32" && modeOf(ctx.deviceMap) !== 0o600) {
    warnings.push({ code: "device-map-mode", expected: "0600", actual: modeOf(ctx.deviceMap).toString(8) })
  }


  printJson({
    command: "doctor",
    host: ctx.opts.host || "all",
    read_only: true,
    ok: errors.length === 0,
    summary: { links: inspected.links.length, errors: errors.length, warnings: warnings.length },
    errors,
    warnings,
  })
  return errors.length ? 1 : 0
}

function runRollback(ctx) {
  if (!/^[A-Za-z0-9._-]+$/.test(ctx.opts.runId)) throw new CliError("非法 RUN_ID", 2)
  const runsRoot = path.join(ctx.stateRoot, "runs")
  const runDir = path.resolve(runsRoot, ctx.opts.runId)
  if (!isInside(runsRoot, runDir) || runDir === runsRoot) throw new CliError("RUN_ID 越界", 2)
  const journalPath = path.join(runDir, "journal.json")
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"))
  if (journal.schema_version !== 1 || journal.managed_by !== MANAGED_BY || journal.run_id !== ctx.opts.runId) {
    throw new CliError("回滚 journal 无效")
  }
  if (journal.status !== "applied") throw new CliError(`该 run 不可回滚，当前状态: ${journal.status}`, 2)
  if (journal.home !== ctx.home || journal.vault !== ctx.vault) {
    throw new CliError("回滚环境与 apply 时的 HOME/vault 不一致", 2)
  }

  const conflicts = journal.records.filter((record) => fingerprint(record.target) !== record.after.fingerprint)
  if (conflicts.length) {
    printJson({
      command: "rollback",
      ok: false,
      changed: false,
      reason: "post-install-changes-detected",
      conflicts: conflicts.map((record) => record.target),
    })
    return 2
  }
  for (const record of journal.records) assertSafeAncestors(ctx.home, record.target)
  for (const record of [...journal.records].reverse()) restoreRecord(record, runDir)
  journal.status = "rolled-back"
  journal.rolled_back_at = new Date().toISOString()
  writeJsonPrivate(journalPath, journal)
  printJson({
    command: "rollback",
    ok: true,
    changed: true,
    run_id: ctx.opts.runId,
    restored_targets: journal.records.map((record) => record.target),
  })
  return 0
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const ctx = loadContext(opts)
  if (opts.command === "plan") return runPlan(ctx)
  if (opts.command === "apply") return runApply(ctx)
  if (opts.command === "doctor") return runDoctor(ctx)
  return runRollback(ctx)
}

try {
  process.exitCode = main()
} catch (error) {
  printJson({ command: "error", ok: false, message: error instanceof Error ? error.message : "unknown error" })
  process.exitCode = error instanceof CliError ? error.exitCode : 1
}
