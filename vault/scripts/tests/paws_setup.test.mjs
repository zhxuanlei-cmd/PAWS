import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const SCRIPT = path.join(ROOT, "scripts", "paws_setup.mjs")

function invoke(command, fakeHome, extra = [], overrides = {}) {
  const positional = command === "rollback" ? extra.slice(0, 1) : []
  const trailing = command === "rollback" ? extra.slice(1) : extra
  const commandArgs = command ? [command] : []
  const args = [SCRIPT, ...commandArgs, ...positional, "--home", fakeHome, "--vault", ROOT, ...trailing]
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...overrides } })
  let output
  try {
    output = JSON.parse(result.stdout)
  } catch {
    throw new Error(`无法解析 setup 输出(exit=${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  return { ...result, output }
}

function treeSnapshot(root) {
  if (!fs.existsSync(root)) return []
  const result = []
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const target = path.join(current, name)
      const rel = path.relative(root, target)
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink()) {
        result.push([rel, "link", fs.readlinkSync(target), stat.mtimeMs])
      } else if (stat.isDirectory()) {
        result.push([rel, "dir", stat.mode & 0o777, stat.mtimeMs])
        visit(target)
      } else {
        const digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")
        result.push([rel, "file", digest, stat.mode & 0o777, stat.mtimeMs])
      }
    }
  }
  visit(root)
  return result
}

function withTempHome(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "paws-setup-test-"))
  const fakeHome = path.join(base, "home")
  try {
    fn(fakeHome)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

test("plan/doctor 默认只读，apply 使用相对 symlink 且幂等，rollback 可恢复", () => {
  withTempHome((fakeHome) => {
    const plan = invoke(null, fakeHome)
    assert.equal(plan.status, 0)
    assert.equal(plan.output.read_only, true)
    // 核对全部宿主的链接目标、设备映射与 Hermes 配置合计。
    assert.equal(plan.output.summary.total, 89)
    assert.equal(fs.existsSync(fakeHome), false, "plan 不得创建 HOME")

    const doctorBefore = invoke("doctor", fakeHome)
    assert.equal(doctorBefore.status, 1)
    assert.equal(doctorBefore.output.read_only, true)
    assert.equal(fs.existsSync(fakeHome), false, "doctor 不得创建 HOME")

    const applied = invoke("apply", fakeHome)
    assert.equal(applied.status, 0)
    assert.equal(applied.output.changed, true)
    assert.ok(applied.output.run_id)
    assert.equal(applied.output.changed_targets.length, 89)

    const sampleLinks = [
      path.join(fakeHome, ".codex", "AGENTS.md"),
      path.join(fakeHome, ".codex", "prompts", "start.md"),
      path.join(fakeHome, ".config", "opencode", "skills", "paws-checkpoint"),
      path.join(fakeHome, ".claude", "commands", "harvest.md"),
      path.join(fakeHome, ".config", "opencode", "plugins", "paws-tools.ts"),
      path.join(fakeHome, ".local", "bin", "paws-opencode"),
      path.join(fakeHome, ".gemini", "GEMINI.md"),
      path.join(fakeHome, ".gemini", "config", "skills", "start"),
      path.join(fakeHome, ".gemini", "config", "skills", "paws-office-delivery"),
    ]
    for (const target of sampleLinks) {
      assert.equal(fs.lstatSync(target).isSymbolicLink(), true)
      assert.equal(path.isAbsolute(fs.readlinkSync(target)), false, `${target} 必须使用相对 symlink`)
      assert.equal(fs.existsSync(target), true)
    }

    const devicePath = path.join(fakeHome, ".config", "paws-oss", "device.json")
    const device = JSON.parse(fs.readFileSync(devicePath, "utf8"))
    assert.equal(device.managed_by, "paws_setup")
    assert.equal(device.paths.home, fs.realpathSync(fakeHome))
    assert.equal(device.paths.vault, ROOT)
    if (process.platform !== "win32") assert.equal(fs.statSync(devicePath).mode & 0o777, 0o600)

    const beforeDoctor = treeSnapshot(fakeHome)
    const doctor = invoke("doctor", fakeHome)
    const afterDoctor = treeSnapshot(fakeHome)
    assert.equal(doctor.status, 0)
    assert.equal(doctor.output.ok, true)
    assert.equal(doctor.output.summary.warnings, 0)
    assert.deepEqual(afterDoctor, beforeDoctor, "doctor 不得改变内容或 mtime")

    const runsRoot = path.join(fakeHome, ".local", "state", "paws-oss", "runs")
    const runsBefore = fs.readdirSync(runsRoot)
    const secondApply = invoke("apply", fakeHome)
    assert.equal(secondApply.status, 0)
    assert.equal(secondApply.output.changed, false)
    assert.deepEqual(fs.readdirSync(runsRoot), runsBefore, "幂等 apply 不得新增 run")

    const rolledBack = invoke("rollback", fakeHome, [applied.output.run_id])
    assert.equal(rolledBack.status, 0)
    assert.equal(rolledBack.output.changed, true)
    for (const target of sampleLinks) assert.equal(fs.existsSync(target), false)
    assert.equal(fs.existsSync(devicePath), false)
    const journal = JSON.parse(fs.readFileSync(path.join(runsRoot, applied.output.run_id, "journal.json"), "utf8"))
    assert.equal(journal.status, "rolled-back")
  })
})

test("未知普通文件 fail closed；显式 adopt 后可精确恢复", () => {
  withTempHome((fakeHome) => {
    const globalTarget = path.join(fakeHome, ".codex", "AGENTS.md")
    const absoluteLink = path.join(fakeHome, ".codex", "prompts", "start.md")
    fs.mkdirSync(path.dirname(globalTarget), { recursive: true })
    fs.writeFileSync(globalTarget, "user-owned\n", "utf8")
    fs.mkdirSync(path.dirname(absoluteLink), { recursive: true })
    fs.symlinkSync(path.join(ROOT, "scripts/adapters/commands/codex/start.md"), absoluteLink)

    const stateRoot = path.join(fakeHome, ".local", "state", "paws-oss")
    const blockedPlan = invoke("plan", fakeHome)
    assert.equal(blockedPlan.status, 2)
    assert.equal(blockedPlan.output.summary.blocked, 1)
    assert.equal(fs.existsSync(stateRoot), false, "blocked plan 不得创建状态目录")

    const blockedApply = invoke("apply", fakeHome)
    assert.equal(blockedApply.status, 2)
    assert.equal(blockedApply.output.changed, false)
    assert.equal(fs.readFileSync(globalTarget, "utf8"), "user-owned\n")
    assert.equal(path.isAbsolute(fs.readlinkSync(absoluteLink)), true)
    assert.equal(fs.existsSync(stateRoot), false, "blocked apply 必须在任何写入前停止")

    const adopted = invoke("apply", fakeHome, ["--adopt", globalTarget])
    assert.equal(adopted.status, 0)
    assert.equal(path.isAbsolute(fs.readlinkSync(globalTarget)), false)
    assert.equal(path.isAbsolute(fs.readlinkSync(absoluteLink)), false, "已有绝对 symlink 应收口为相对 symlink")

    const rollback = invoke("rollback", fakeHome, [adopted.output.run_id])
    assert.equal(rollback.status, 0)
    assert.equal(fs.lstatSync(globalTarget).isFile(), true)
    assert.equal(fs.readFileSync(globalTarget, "utf8"), "user-owned\n")
    assert.equal(fs.lstatSync(absoluteLink).isSymbolicLink(), true)
    assert.equal(path.isAbsolute(fs.readlinkSync(absoluteLink)), true, "回滚应恢复原 symlink 文本")
  })
})

// 已有 PAWS 工作区的链接也是用户文件，定向安装不得隐式切换工作区。
test("其他安装的 symlink 需要逐个 adopt，回滚恢复原链接", () => {
  withTempHome(fakeHome => {
    const previous = path.join(fakeHome, "previous/AGENTS.md")
    const target = path.join(fakeHome, ".codex/AGENTS.md")
    for (const file of [previous, target]) fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(previous, "原工作区规则\n")
    fs.symlinkSync("../previous/AGENTS.md", target)
    const run = ["--host", "codex"]
    const before = treeSnapshot(fakeHome)
    const blocked = invoke("apply", fakeHome, run)
    assert.equal(blocked.status, 2)
    assert.deepEqual(treeSnapshot(fakeHome), before)
    const accepted = invoke("apply", fakeHome, [...run, "--adopt", target])
    assert.equal(accepted.status, 0)
    assert.equal(fs.realpathSync(target), path.join(ROOT, "scripts/adapters/global-instructions.md"))
    assert.equal(invoke("rollback", fakeHome, [accepted.output.run_id]).status, 0)
    assert.equal(fs.readlinkSync(target), "../previous/AGENTS.md")
    assert.equal(fs.readFileSync(target, "utf8"), "原工作区规则\n")
  })
})

test("安装后人工改动会阻止 rollback，且不覆盖改动", () => {
  withTempHome((fakeHome) => {
    const applied = invoke("apply", fakeHome)
    assert.equal(applied.status, 0)
    const target = path.join(fakeHome, ".codex", "prompts", "start.md")
    fs.unlinkSync(target)
    fs.writeFileSync(target, "manual-change\n", "utf8")

    const rollback = invoke("rollback", fakeHome, [applied.output.run_id])
    assert.equal(rollback.status, 2)
    assert.equal(rollback.output.reason, "post-install-changes-detected")
    assert.equal(fs.readFileSync(target, "utf8"), "manual-change\n")
  })
})

test("manifest 可迁移且不含绝对用户路径或凭据值", () => {
  const raw = fs.readFileSync(path.join(ROOT, "paws.manifest.json"), "utf8")
  assert.equal(raw.includes("/Users/"), false)
  assert.equal(/sk-[A-Za-z0-9_-]{12,}/.test(raw), false)
  assert.doesNotThrow(() => JSON.parse(raw))
})

// 定向接入第四宿主时，其他工具的用户文件与旧 device map 必须逐字、逐 mtime 保留。
test("Antigravity 定向安装只接线本宿主，支持幂等、只读 doctor 和精确回滚", () => {
  withTempHome(fakeHome => {
    const legacy = path.join(fakeHome, ".claude", "CLAUDE.md")
    const device = path.join(fakeHome, ".config", "paws-oss", "device.json")
    fs.mkdirSync(path.dirname(legacy), {recursive: true})
    fs.mkdirSync(path.dirname(device), {recursive: true})
    fs.writeFileSync(legacy, "原有宿主用户文件\n")
    fs.writeFileSync(device, "未纳管设备映射，应保持原样\n")
    const legacyBefore = treeSnapshot(path.dirname(legacy))
    const deviceBefore = treeSnapshot(path.dirname(device))
    const scope = ["--host", "antigravity"]
    const before = treeSnapshot(fakeHome)
    const planned = invoke("plan", fakeHome, scope)
    assert.equal(planned.status, 0)
    assert.equal(planned.output.summary.total, 17)
    assert.equal(planned.output.host, "antigravity")
    assert.deepEqual(treeSnapshot(fakeHome), before)
    // macOS 的 /var 临时目录会规范化为 /private/var，写域比较也必须使用真实 HOME。
    assert.ok(planned.output.items.every(x => x.target.startsWith(path.join(fs.realpathSync(fakeHome), ".gemini") + path.sep)))

    const applied = invoke("apply", fakeHome, scope)
    assert.equal(applied.status, 0)
    assert.equal(applied.output.changed_targets.length, 17)
    for (const target of applied.output.changed_targets) {
      assert.equal(fs.lstatSync(target).isSymbolicLink(), true)
      assert.equal(path.isAbsolute(fs.readlinkSync(target)), false)
      assert.equal(fs.existsSync(target), true)
    }
    assert.deepEqual(treeSnapshot(path.dirname(legacy)), legacyBefore)
    assert.deepEqual(treeSnapshot(path.dirname(device)), deviceBefore)
    const afterApply = treeSnapshot(fakeHome)
    assert.equal(invoke("doctor", fakeHome, scope).status, 0)
    assert.deepEqual(treeSnapshot(fakeHome), afterApply)
    assert.equal(invoke("apply", fakeHome, scope).output.changed, false)
    assert.equal(invoke("rollback", fakeHome, [applied.output.run_id]).status, 0)
    for (const target of applied.output.changed_targets) assert.equal(fs.existsSync(target), false)
    assert.deepEqual(treeSnapshot(path.dirname(legacy)), legacyBefore)
    assert.deepEqual(treeSnapshot(path.dirname(device)), deviceBefore)
  })
})

// 不能以新增工具为由覆盖已有 GEMINI.md；冲突需要逐个接管，回滚恢复用户原字节。
test("Antigravity 已有规则冲突会在所有写入前拒绝，明确 adopt 后可恢复", () => {
  withTempHome(fakeHome => {
    const target = path.join(fakeHome, ".gemini", "GEMINI.md")
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, "已有个人规则\n")
    const before = treeSnapshot(fakeHome)
    const scope = ["--host", "antigravity"]
    assert.equal(invoke("apply", fakeHome, scope).status, 2)
    assert.deepEqual(treeSnapshot(fakeHome), before)
    const applied = invoke("apply", fakeHome, [...scope, "--adopt", target])
    assert.equal(applied.status, 0)
    assert.equal(invoke("rollback", fakeHome, [applied.output.run_id]).status, 0)
    assert.equal(fs.readFileSync(target, "utf8"), "已有个人规则\n")
  })
})

// 参数错误必须显式失败，尤其空 host 不能退回“全量安装”而扩大写域。
test("宿主定向安装拒绝错误范围和跨宿主 adopt", () => {
  withTempHome(fakeHome => {
    for (const host of ["", "unknown", "antigravity/", "hermes/"]) {
      assert.equal(invoke("apply", fakeHome, ["--host", host]).status, 2)
      assert.equal(fs.existsSync(fakeHome), false)
    }
    assert.equal(invoke("apply", fakeHome, ["--host", "antigravity", "--adopt", path.join(fakeHome, ".config/paws-oss/device.json")]).status, 2)
    assert.equal(fs.existsSync(fakeHome), false)
  })
})

// 新宿主须在同一事务中接线与合并配置；既有模型、身份、其他工具和设备映射不可被覆盖。
test("Hermes 定向安装保留原配置与 SOUL，幂等且可恢复原字节", () => {
  withTempHome(fakeHome => {
    const native = path.join(fakeHome, ".hermes")
    fs.mkdirSync(native, {recursive: true})
    const config = path.join(native, "config.yaml")
    const original = "# 保留模型注释\nmodel:\n  provider: local\n  model: existing-model\nskills:\n  creation_nudge_interval: 7\n  auto_load: [existing-context]\nquick_commands:\n  existing:\n    type: alias\n    target: /help\n"
    fs.writeFileSync(config, original, {mode: 0o600})
    const soul = path.join(native, "SOUL.md")
    fs.writeFileSync(soul, "原有身份与用户偏好\n")
    const other = path.join(fakeHome, ".claude/CLAUDE.md")
    fs.mkdirSync(path.dirname(other), {recursive: true})
    fs.writeFileSync(other, "其他宿主规则\n")
    const scope = ["--host", "hermes"]
    const before = treeSnapshot(fakeHome)
    const plan = invoke("plan", fakeHome, scope)
    assert.equal(plan.status, 0)
    assert.equal(plan.output.summary.total, 18)
    assert.deepEqual(treeSnapshot(fakeHome), before)
    const applied = invoke("apply", fakeHome, scope)
    assert.equal(applied.status, 0)
    assert.equal(applied.output.changed_targets.length, 18)
    const text = fs.readFileSync(config, "utf8")
    assert.ok(text.startsWith("# 保留模型注释\nmodel:\n  provider: local\n  model: existing-model\n"))
    assert.match(text, /creation_nudge_interval: 7/)
    assert.match(text, /existing-context/)
    assert.match(text, /paws-context/)
    assert.match(text, /target: paws-start/)
    assert.match(text, /target: \/help/)
    assert.equal(fs.statSync(config).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(soul, "utf8"), "原有身份与用户偏好\n")
    assert.equal(fs.readFileSync(other, "utf8"), "其他宿主规则\n")
    assert.equal(fs.existsSync(path.join(fakeHome, ".config/paws-oss/device.json")), false)
    const installed = treeSnapshot(fakeHome)
    assert.equal(invoke("doctor", fakeHome, scope).status, 0)
    assert.deepEqual(treeSnapshot(fakeHome), installed)
    assert.equal(invoke("apply", fakeHome, scope).output.changed, false)
    assert.equal(invoke("rollback", fakeHome, [applied.output.run_id]).status, 0)
    assert.equal(fs.readFileSync(config, "utf8"), original)
    assert.equal(fs.readFileSync(soul, "utf8"), "原有身份与用户偏好\n")
  })
})

// 发生配置冲突、重复键或错误列表类型时，在第一个文件写入前失败；不静默扩大或丢失配置。
test("Hermes 配置冲突和重复键在接线前拒绝且不泄露配置正文", () => {
  for (const original of [
    "quick_commands:\n  start:\n    type: alias\n    target: /help\n",
    "skills:\n  auto_load: existing-context\n",
    "model: first\nmodel: second\n",
  ]) withTempHome(fakeHome => {
    const config = path.join(fakeHome, ".hermes/config.yaml")
    fs.mkdirSync(path.dirname(config), {recursive: true})
    fs.writeFileSync(config, original)
    const before = treeSnapshot(fakeHome)
    const refused = invoke("apply", fakeHome, ["--host", "hermes"])
    assert.equal(refused.status, 2)
    assert.deepEqual(treeSnapshot(fakeHome), before)
    assert.ok(!refused.stderr.includes(original.trim()))
  })
})

// 安装后新的人为配置必须保留；回滚沿用原有指纹保护，而不覆盖新配置。
test("Hermes 安装后的配置漂移阻止整批回滚", () => {
  withTempHome(fakeHome => {
    const applied = invoke("apply", fakeHome, ["--host", "hermes"])
    assert.equal(applied.status, 0)
    const config = path.join(fakeHome, ".hermes/config.yaml")
    fs.appendFileSync(config, "\n# 用户后续改动\n")
    const before = treeSnapshot(fakeHome)
    assert.equal(invoke("rollback", fakeHome, [applied.output.run_id]).status, 2)
    assert.deepEqual(treeSnapshot(fakeHome), before)
  })
})

// 短入口必须可解析并回到唯一正文；不在适配器重复完整工作流或旧 workflows 目录。
test("Antigravity 七个短命令与九个 PAWS Skill 均指向现行正本", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "paws.manifest.json"), "utf8"))
  const names = new Set(manifest.skills.names)
  assert.equal(names.size, 9)
  assert.ok(manifest.skills.target_roots.includes("$HOME/.gemini/config/skills"))
  assert.ok(manifest.global_instructions.targets.includes("$HOME/.gemini/GEMINI.md"))
  assert.equal(manifest.commands.length, 7)
  for (const command of manifest.commands) {
    const links = command.links.filter(link => link.target.startsWith("$HOME/.gemini/"))
    assert.equal(links.length, 1)
    const source = fs.readFileSync(path.join(ROOT, links[0].source, "SKILL.md"), "utf8")
    const canonical = source.match(/^  canonical_skill: (paws-[a-z-]+)$/m)?.[1]
    assert.ok(names.has(canonical))
    assert.ok(fs.existsSync(path.join(ROOT, "scripts", "skills", canonical, "SKILL.md")))
    assert.match(source, new RegExp(`^name: ${command.name}$`, "m"))
    assert.match(source, /disable-model-invocation: true/)
    assert.match(source, /先核对本次用户确已触发/)
    assert.ok(source.length < 1500, "短入口只定位正文")
    assert.ok(!links[0].target.includes("workflows"), "不接入即将退役的旧 Workflow 入口")
  }
  assert.equal(Object.hasOwn(manifest, "shared_skills"), false)
})

// 用户自己的 Skills、旧版设备映射与原生启动器存在时，公开版只安装自己的入口。
test("定向安装只触碰目标宿主，保留原生 OpenCode 和已有本机文件", () => {
  withTempHome(fakeHome => {
    const existingSkill = path.join(fakeHome, ".agents/skills/example-method/SKILL.md")
    const privateDevice = path.join(fakeHome, ".config/paws/device.json")
    const original = path.join(fakeHome, ".local/bin/opencode")
    for (const sample of [existingSkill, privateDevice, original]) {
      fs.mkdirSync(path.dirname(sample), {recursive: true})
      fs.writeFileSync(sample, "原有文件\n")
    }
    for (const [host, hostRoot] of [["codex", ".codex"], ["claude", ".claude"],
      ["opencode", ".config/opencode"]]) {
      const pin = host === "opencode" ? ["--opencode-real-bin", original] : []
      const before = treeSnapshot(fakeHome)
      const result = invoke("apply", fakeHome, ["--host", host, ...pin])
      assert.equal(result.status, 0)
      assert.ok(fs.existsSync(path.join(fakeHome, hostRoot)))
      assert.equal(fs.existsSync(path.join(fakeHome, ".hermes")), false)
      assert.equal(fs.existsSync(path.join(fakeHome, ".gemini")), false)
      assert.equal(fs.existsSync(path.join(fakeHome, ".claude/skills/example-method")), false)
      for (const sample of [existingSkill, privateDevice, original]) {
        assert.equal(fs.readFileSync(sample, "utf8"), "原有文件\n")
      }
      assert.equal(invoke("doctor", fakeHome, ["--host", host]).status, 0)
      if (host === "opencode") {
        assert.equal(fs.realpathSync(path.join(fakeHome, ".local/bin/paws-opencode")),
          path.join(ROOT, "scripts/adapters/opencode/launcher.zsh"))
        const device = JSON.parse(fs.readFileSync(path.join(fakeHome, ".config/paws-oss/device.json"), "utf8"))
        assert.equal(device.opencode_real_bin, original)
      }
      assert.equal(invoke("rollback", fakeHome, [result.output.run_id]).status, 0)
      const allExistingFiles = tree => tree.filter(([, kind]) => kind === 'file')
        .filter(([name]) => !name.startsWith('.local/state/paws-oss/'))
      assert.deepEqual(allExistingFiles(treeSnapshot(fakeHome)), allExistingFiles(before))
    }
  })
})

test("本机 repository 覆盖经 apply 保留", () => {
  withTempHome(fakeHome => {
    assert.equal(invoke('apply', fakeHome).status, 0)
    const target = path.join(fakeHome, '.config/paws-oss/device.json')
    const data = JSON.parse(fs.readFileSync(target, 'utf8'))
    data.repositories = {demo: path.join(fakeHome, 'new-location')}
    fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n')
    assert.equal(invoke('apply', fakeHome).status, 0)
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).repositories, data.repositories)
  })
})

// 原生 pin 是用户确认的本机路径；迁移时保留它，不从 PATH 的 launcher/旧安装推断。
test('本机 OpenCode binary pin 经 apply 保留且不自动生成', () => {
  withTempHome(fakeHome => {
    assert.equal(invoke('apply', fakeHome).status, 0)
    const target = path.join(fakeHome, '.config/paws-oss/device.json')
    const data = JSON.parse(fs.readFileSync(target, 'utf8'))
    assert.equal(Object.hasOwn(data, 'opencode_real_bin'), false)
    data.opencode_real_bin = path.join(fakeHome, 'confirmed-opencode/bin/opencode')
    fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n')
    assert.equal(invoke('apply', fakeHome).status, 0)
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).opencode_real_bin, data.opencode_real_bin)
    assert.equal(invoke('doctor', fakeHome).status, 0)
    assert.equal(invoke('apply', fakeHome).output.changed, false)
  })
})

// 无效 pin 应明确失败并保留现场，不能靠删除字段悄悄回退到 PATH 搜索。
test('无效 OpenCode binary pin 拒绝 apply 且不改文件', () => {
  withTempHome(fakeHome => {
    assert.equal(invoke('apply', fakeHome).status, 0)
    const target = path.join(fakeHome, '.config/paws-oss/device.json')
    const data = JSON.parse(fs.readFileSync(target, 'utf8'))
    for (const invalid of ['opencode', '', null, 123, '/native\n/opencode']) {
      data.opencode_real_bin = invalid
      const source = JSON.stringify(data, null, 2) + '\n'
      fs.writeFileSync(target, source)
      const result = invoke('apply', fakeHome)
      assert.notEqual(result.status, 0)
      assert.match(result.output.message, /opencode_real_bin/)
      assert.equal(fs.readFileSync(target, 'utf8'), source)
    }
  })
})

// OpenCode 在真实的自定义 XDG 环境提前退出，保留默认路径和其他宿主的安装支持。
test("OpenCode 自定义 XDG 在写入前报错，隔离演练和其他宿主不受影响", () => {
  withTempHome(fakeHome => {
    const custom = { HOME: fakeHome, USERPROFILE: fakeHome, XDG_CONFIG_HOME: path.join(fakeHome, "config-custom") }
    for (const action of ["plan", "apply", "doctor"]) {
      const result = invoke(action, fakeHome, ["--host", "opencode"], custom)
      assert.equal(result.status, 2)
      assert.match(result.output.message, /XDG_CONFIG_HOME/)
      assert.deepEqual(treeSnapshot(fakeHome), [])
    }
    const isolated = path.join(path.dirname(fakeHome), "isolated")
    assert.equal(invoke("plan", isolated, ["--host", "opencode"], custom).status, 0)
    assert.equal(invoke("plan", fakeHome, ["--host", "codex"], custom).status, 0)
    const defaults = { ...custom, XDG_CONFIG_HOME: path.join(fakeHome, ".config") }
    assert.equal(invoke("apply", fakeHome, ["--host", "opencode"], defaults).status, 0)
    assert.equal(invoke("doctor", fakeHome, ["--host", "opencode"], defaults).status, 0)
  })
})
