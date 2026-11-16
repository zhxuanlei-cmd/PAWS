import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const vault = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)))
const launcherSource = path.join(vault, 'scripts/adapters/opencode/launcher.zsh')
const pluginSource = path.join(vault, 'scripts/adapters/opencode/paws-tools.ts')

/** 每个测试使用独立 HOME 和合成程序；不启动真正的宿主、模型或凭据存储。 */
function fixture(run) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paws-opencode-test-')))
  const write = (name, body, mode = 0o600) => {
    const file = path.join(work, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body, { mode })
    return file
  }
  const link = (name, source) => {
    const file = path.join(work, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.symlinkSync(source, file)
    return file
  }
  const launcher = link('.local/bin/paws-opencode', launcherSource)
  const plugin = link('.config/opencode/plugins/paws-tools.ts', pluginSource)
  const active = cfg => write('.config/opencode/opencode.json', JSON.stringify(cfg))
  active({ model: 'example/model' })
  const native = write('bin/opencode', `#!/bin/sh
if [ "$1" = --version ]; then echo synthetic; exit; fi
python3 -c 'import json, os, sys; print(json.dumps({"overlay": json.loads(os.environ["OPENCODE_CONFIG_CONTENT"]), "vault": os.environ["VAULT_DIR"], "args": sys.argv[1:]}))' "$@"
`, 0o700)
  const engine = write('bin/paws-engine', `#!/bin/sh
set -eu
[ "$1" = opencode ] && [ "$2" = runtime-overlay ] && [ "$3" = --vault ] && [ "$5" = --cwd ] && [ "$7" = --baseline-provider ]
[ "$4" = "$EXPECTED_VAULT" ] && [ "$6" = "$EXPECTED_WORKDIR" ] && [ "$8" = example ]
printf '%s\\n' "$TEST_OVERLAY"
`, 0o700)
  // 检查 launcher 使用自身 vault，忽略同机旧版 Vault 和设备映射。
  write('vault/AGENTS.md', '旧 Vault 不属于本次安装。\n')
  write('.config/paws/device.json', '旧版设备映射不属于本次安装。\n')
  const overlay = JSON.stringify({ enabled_providers: ['example'] })
  const execute = (args = [], overrides = {}) => spawnSync(launcher, args, {
    cwd: work,
    env: { HOME: work, PATH: `${path.dirname(native)}:${process.env.PATH}`,
      PAWS_BIN: engine, EXPECTED_VAULT: vault, EXPECTED_WORKDIR: work, TEST_OVERLAY: overlay, ...overrides },
    encoding: 'utf8',
  })
  try {
    run({ work, write, execute, active, plugin, native })
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

// 由 PATH 找到的原生二进制接收同一组参数和授权快照；不使用同机旧版 Vault。
test('启动器以自身安装定位 Vault，原生命令保留参数', () => fixture(({ execute }) => {
  const result = execute(['--model', 'example/model'])
  assert.equal(result.status, 0, result.stderr)
  const native = JSON.parse(result.stdout)
  assert.equal(native.vault, vault)
  assert.deepEqual(native.args, ['--model', 'example/model'])
  assert.deepEqual(native.overlay.enabled_providers, ['example'])
}))

// 未授权模型、无效 overlay、外部配置覆盖与缺失 hook 均应阻止启动。
test('启动器拒绝错误授权和缺失的配置 hook', () => fixture(({ active, execute, plugin }) => {
  for (const result of [
    execute(['--model', 'other/model']),
    execute(['--pure']),
    execute([], { TEST_OVERLAY: '{"enabled_providers": []}' }),
    execute([], { OPENCODE_CONFIG_CONTENT: '{}' }),
    execute([], { OPENCODE_CONFIG_DIR: '/tmp' }),
  ]) {
    assert.equal(result.status, 78, result.stderr)
    assert.equal(result.stdout, '')
  }
  active({ model: 'example/model', small_model: 'other/small' })
  const other = execute()
  assert.equal(other.status, 78)
  assert.match(other.stderr, /small_model/)
  fs.unlinkSync(plugin)
  const missing = execute()
  assert.equal(missing.status, 78)
  assert.match(missing.stderr, /plugin is missing/)
  // 仅单参数版本查询不要求项目策略或插件。
  const version = execute(['--version'])
  assert.equal(version.status, 0)
  assert.equal(version.stdout.trim(), 'synthetic')
}))

// 显式设备映射仅取路径字段，损坏映射会报告错误而非偷偷切换执行程序。
test('启动器核对公开版设备映射并支持显式 pin', () => fixture(({ write, execute, native }) => {
  const map = '.config/paws-oss/device.json'
  write(map, JSON.stringify({ schema_version: 1, managed_by: 'paws_setup', opencode_real_bin: native }))
  assert.equal(execute(['--version'], { PATH: '/usr/bin:/bin' }).status, 0)
  write(map, JSON.stringify({ schema_version: 1, managed_by: 'paws_setup', opencode_real_bin: 'relative' }))
  const invalid = execute(['--version'])
  assert.equal(invalid.status, 78)
  assert.match(invalid.stderr, /device map is invalid/)
}))

// 默认路径的显式 XDG 写法有效；其他路径报告不可用，也不进入原生程序。
test('启动器与安装器使用同一 OpenCode 配置路径', () => fixture(({ work, execute }) => {
  const defaultPath = execute([], { XDG_CONFIG_HOME: path.join(work, '.config') })
  assert.equal(defaultPath.status, 0, defaultPath.stderr)
  const customPath = execute([], { XDG_CONFIG_HOME: path.join(work, 'custom-config') })
  assert.equal(customPath.status, 78, customPath.stderr)
  assert.match(customPath.stderr, /XDG_CONFIG_HOME/)
  assert.equal(customPath.stdout, '')
}))
