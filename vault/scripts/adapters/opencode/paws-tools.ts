/** PAWS 固定检查工具；不监听会话、不注入游标、不自动写入记录。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

const run = promisify(execFile)

export const PawsTools = async ({ directory, worktree }) => ({
  config: async (config) => {
    // config hook 位于原生本地配置与角色合并之后；整替换 edit/read/external_directory，保留更严局部限制。
    // 宿主会吞掉 hook 异常，因此失败必须明确退出，不能仅 throw 后继续带错误写权限运行。
    try {
      const vault = process.env.VAULT_DIR
      const source = process.env.PAWS_OPENCODE_CONFIG
      const launch = process.env.PAWS_OPENCODE_CWD
      const raw = process.env.PAWS_OPENCODE_EDIT_POLICY
      // 普通原生启动没有 PAWS 上下文，保留宿主原有配置；不完整的 launcher 上下文则拒绝。
      if (!source && !launch && !raw) return
      if (!vault || !source || !launch || !raw || !directory || !worktree ||
          realpathSync(launch) !== realpathSync(directory)) {
        throw new Error('PAWS launcher context is missing or does not match the native directory')
      }
      const permissionsOnly = (value) => ({
        permission: value.permission,
        agent: Object.fromEntries(Object.entries(value.agent || {}).map(([name, owner]) =>
          [name, { permission: owner.permission, disable: owner.disable }])),
      })
      // 仅传权限字段；edit_policy 旧接口名兼容启动器，现含三类路径权限快照，不传 provider 或提示词。
      const overlay = permissionsOnly(JSON.parse(raw))
      const job = run('python3', [join(vault, 'scripts/paws_manual_policy.py'), 'finalize',
        '--vault', vault, '--cwd', realpathSync(directory), '--worktree', resolve(worktree),
        '--config', source], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 })
      job.child.stdin?.end(JSON.stringify({ effective: permissionsOnly(config), overlay }))
      const final = JSON.parse((await job).stdout)
      // 只报告技能名与固定原因；越界依赖不静默扩大目录访问，也不输出配置或文件内容。
      for (const item of final._paws_skill_access || []) {
        process.stderr.write(`OpenCode PAWS Skill ${item.name}: extra dependency access skipped (${item.reason}).\n`)
      }
      config.permission = final.permission
      for (const [name, owner] of Object.entries(final.agent || {})) {
        if (config.agent?.[name] && owner.permission) config.agent[name].permission = owner.permission
      }
    } catch {
      // 不输出配置、子进程正文或凭据；提示用户从当前配置和启动目录排查。
      process.stderr.write('OpenCode PAWS edit permission initialization failed; start aborted. Check launcher context, config and Git worktree.\n')
      process.exit(78)
    }
  },
  tool: {
    paws_maintenance_check: {
      description: '按显式工具调用运行 vault 固定的 frontmatter/MOC 门禁；逐项返回退出码，无任意 Shell 参数。',
      args: {},
      execute: async () => {
        const vault = process.env.VAULT_DIR
        if (!vault) throw new Error('Set VAULT_DIR to the PAWS workspace before running maintenance checks.')
        try {
          const job = run('python3', [join(vault, 'scripts/paws_maintenance_check.py')], { timeout: 120000 })
          job.child.stdin?.end()
          return (await job).stdout
        } catch (error) {
          // 门禁非零仍保留结构化结果；启动失败/超时交给宿主报告，不能伪装成功。
          if (error.code && error.stdout && !error.killed) {
            try { JSON.parse(error.stdout); return error.stdout } catch { /* invalid output */ }
          }
          throw error
        }
      },
    },
  },
})
