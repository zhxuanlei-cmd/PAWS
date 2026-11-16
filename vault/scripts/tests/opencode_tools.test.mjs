import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { PawsTools } from '../adapters/opencode/paws-tools.ts'

test('加载 PAWS 插件与 idle 不捕获会话，显式检查保留非零门禁结果', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paws-manual-tools-'))
  const previous = process.env.VAULT_DIR
  process.env.VAULT_DIR = root
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.writeFileSync(path.join(root, 'scripts/paws_maintenance_check.py'),
    'import json\nprint(json.dumps({"ok":False,"checks":[{"exit_code":1}]}))\nraise SystemExit(1)\n')
  try {
    const neverRead = new Proxy({}, { get() { throw new Error('must not inspect private sessions') } })
    const plugin = await PawsTools({ client: neverRead, directory: root })
    const before = fs.readdirSync(root)
    await plugin.event?.({ event: { type: 'session.idle', properties: { sessionID: 'unused' } } })
    assert.equal(plugin.event, undefined)
    assert.equal(plugin['shell.env'], undefined)
    assert.deepEqual(fs.readdirSync(root), before)
    const result = JSON.parse(await plugin.tool.paws_maintenance_check.execute({}))
    assert.equal(result.ok, false)
    assert.equal(result.checks[0].exit_code, 1)
  } finally {
    previous === undefined ? delete process.env.VAULT_DIR : process.env.VAULT_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('最终 config hook 投影 edit 并阻止项目允许绕过当前写域；缺上下文时退出 78', () => {
  // 在子进程调用真实插件与 Python 适配器；故障必须阻止后续启动，不能被原生 hook 异常吞掉。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paws-final-edit-hook-'))
  const vault = path.join(root, 'vault')
  const nativePlugin = new URL('../adapters/opencode/paws-tools.ts', import.meta.url).href
  fs.mkdirSync(path.join(vault, 'scripts'), { recursive: true })
  fs.copyFileSync(new URL('../paws_manual_policy.py', import.meta.url), path.join(vault, 'scripts/paws_manual_policy.py'))
  // 使用最小旧版 manifest 验证兼容路径；最终 hook 仍须读取手动清单，不能用缺配置绕过门禁。
  fs.writeFileSync(path.join(vault, 'paws.manifest.json'), JSON.stringify({ manual_workflows: ['paws-checkpoint'] }))
  const configPath = path.join(root, 'opencode.json')
  fs.writeFileSync(configPath, '{}')
  const overlay = { agent: { 'paws-maintain': { permission: {
    edit: { '*': 'deny', [`${vault}/30-resources/wiki/*.md`]: 'allow' },
    external_directory: { '*': 'deny', [`${vault}/**`]: 'allow' }, bash: 'deny',
  } } } }
  fs.writeFileSync(configPath, JSON.stringify(overlay))
  const config = structuredClone(overlay)
  config.agent['paws-maintain'].permission.edit['scripts/*.py'] = 'allow'
  config.agent['paws-maintain'].permission.edit[`${vault}/30-resources/wiki/review.md`] = 'ask'
  const runner = path.join(root, 'runner.mjs')
  fs.writeFileSync(runner, `import { PawsTools } from ${JSON.stringify(nativePlugin)};
const plugin = await PawsTools({ directory: ${JSON.stringify(vault)}, worktree: '/' });
const config = ${JSON.stringify(config)};
await plugin.config(config);
console.log(JSON.stringify(config));`)
  const fixture = { ...process.env, VAULT_DIR: vault, PAWS_OPENCODE_CONFIG: configPath,
    PAWS_OPENCODE_CWD: vault, PAWS_OPENCODE_EDIT_POLICY: JSON.stringify(overlay) }
  try {
    const good = spawnSync(process.execPath, [runner], { env: fixture, encoding: 'utf8' })
    assert.equal(good.status, 0, good.stderr)
    const edited = JSON.parse(good.stdout).agent['paws-maintain'].permission
    assert.equal(edited.edit[`${vault.slice(1)}/30-resources/wiki/*.md`], 'allow')
    assert.equal(edited.edit['scripts/*.py'], undefined)
    assert.equal(edited.edit[`${vault.slice(1)}/30-resources/wiki/review.md`], 'ask')
    assert.equal(edited.bash, 'deny')
    assert.equal(edited.skill['paws-checkpoint'], 'deny')
    for (const bad of [
      { ...fixture, PAWS_OPENCODE_EDIT_POLICY: '' },
      { ...fixture, PAWS_OPENCODE_CONFIG: path.join(root, 'missing.json') },
      { ...fixture, PAWS_OPENCODE_CWD: root },
    ]) {
      const job = spawnSync(process.execPath, [runner], { env: bad, encoding: 'utf8' })
      assert.equal(job.status, 78)
      assert.equal(job.stdout, '')
      assert.match(job.stderr, /edit permission initialization failed; start aborted/)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
