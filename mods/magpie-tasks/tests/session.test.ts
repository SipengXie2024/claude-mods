// Session roles and the confirmation dialog (plan section 12.1, session/launch row): section 2's role
// table, the worktree isolation answer for background sessions (the flag layer is Magpie's launch
// settings; of ~/.config/magpie/claude-launch/settings.json the test carries only
// env.ANTHROPIC_BASE_URL, read on 2026-11-09), and the text and options of the long-task dialog
// with the rules file.
import { expect, test } from 'claude-code/testing'
import type { SettingsReadInput } from 'claude-code'
import { parseRules } from '../src/rules'
import { architectMarkTask } from '../src/launch'
import { architectFirstMessage, askText, bgIsolationAnswer, isOwner, optionModels, roleRule, type RoleFacts } from '../src/session'
import type { TaskRecord } from '../src/types'
import { bgFirstPromptRead, bgFirstPromptSent } from './data/bg-first-prompts'
import { routingRules } from './data/jev-rules'

const GATEWAY = 'http://127.0.0.1:3425'
// env.ANTHROPIC_BASE_URL of ~/.config/magpie/claude-launch/settings.json.
const MAGPIE_FLAG = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425' } }
const rules = parseRules(routingRules, { deepYes: 0.85 })

const base: RoleFacts = { baseUrl: GATEWAY, gatewayUrl: GATEWAY, isInteractive: true, roleEnv: undefined, ownsTask: false, jobDir: undefined, bgSource: undefined }

test('the role table of section 2, in its order', () => {
  expect(roleRule({ ...base, baseUrl: undefined })).toBe('inactive')
  expect(roleRule({ ...base, baseUrl: 'https://api.anthropic.com', roleEnv: 'router' })).toBe('inactive')
  expect(roleRule({ ...base, isInteractive: false, roleEnv: 'router' })).toBe('inactive')
  expect(roleRule({ ...base, roleEnv: 'router', ownsTask: true })).toBe('router')
  expect(roleRule({ ...base, ownsTask: true, jobDir: '/home/ubuntu/.claude/jobs/9c0bfc0e' })).toBe('architect')
  expect(roleRule({ ...base, jobDir: '/home/ubuntu/.claude/jobs/e21efae8', bgSource: 'slash' })).toBe('takeover-copy')
  expect(roleRule({ ...base, jobDir: '/home/ubuntu/.claude/jobs/9c0bfc0e' })).toBe('bg-unclaimed')
  expect(roleRule({ ...base, jobDir: '' })).toBe('candidate')
  expect(roleRule(base)).toBe('candidate')
})

const owned = (owner: TaskRecord['owner'], source: 'new' | 'takeover' | 'promoted'): TaskRecord => ({
  schema: 1, id: 'l-20261109-a1b2c3', kind: 'long', title: 'greet', state: 'running', pausedByUser: false, createdAt: 0, updatedAt: 0,
  request: '检查 greet.py', followUps: [], project: { root: '/tmp/p' }, worktree: null, extraWorktrees: {}, owner,
  architect: { model: 'claude/claude-opus-5-5', recommendation: { model: 'claude/claude-opus-5-5', reason: 'r', limits: 'l', judgment: null }, userChoice: 'Opus 5.5（推荐）', confirmedAt: 0, source },
  telegram: null, agents: {}, blockers: {}, decisions: {}, deliverables: [], feedback: [], ratings: [], pendingRelays: {},
})

test('a session owns its task once claimed, or from the takeover; the launching window never does', () => {
  const S = '9c0bfc0e-0b69-4110-8ef7-f1c6ae54e901'
  const session = { kind: 'session' as const, sessionId: S, previousSessionIds: [], model: 'claude/claude-opus-5-5', contextMemoryFingerprint: '' }
  expect(isOwner(owned({ ...session, jobShortId: '9c0bfc0e' }, 'new'), S)).toBe(true)
  expect(isOwner(owned(session, 'new'), S)).toBe(false)
  expect(isOwner(owned(session, 'takeover'), S)).toBe(true)
  expect(isOwner(owned({ ...session, previousSessionIds: [S], sessionId: 'e21efae8-7435-4b2e-9c1e-0a6f5b1d2c3e', jobShortId: 'e21efae8' }, 'takeover'), S)).toBe(false)
  expect(isOwner(owned({ kind: 'agent', agentId: 'a1', workerName: 'w', routerSessionId: S }, 'promoted'), S)).toBe(false)
})

const read = (layers: SettingsReadInput['layers'], source?: SettingsReadInput['source']): SettingsReadInput => (source === undefined ? { layers } : { layers, source })

test('merged settings with Magpie\'s flag layer get worktree.bgIsolation none; others stay as they are', () => {
  const merged = { model: 'codex/gpt-6-astra', env: MAGPIE_FLAG.env, worktree: { symlinkDirectories: ['node_modules'] } }
  const layers = [{ source: 'user' as const, settings: { model: 'opus' } }, { source: 'flag' as const, settings: MAGPIE_FLAG }]
  expect(bgIsolationAnswer(read(layers), merged, GATEWAY)).toEqual({ ...merged, worktree: { symlinkDirectories: ['node_modules'], bgIsolation: 'none' } })
  expect(bgIsolationAnswer(read([layers[1]!]), { model: 'x' }, GATEWAY)).toEqual({ model: 'x', worktree: { bgIsolation: 'none' } })
  expect(bgIsolationAnswer(read([layers[0]!]), merged, GATEWAY)).toBe(merged)
  expect(bgIsolationAnswer(read(layers), merged, 'http://127.0.0.1:9999')).toBe(merged)
  expect(bgIsolationAnswer(read([{ source: 'flag', settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }]), merged, GATEWAY)).toBe(merged)
  expect(bgIsolationAnswer(read([layers[1]!], 'flag'), MAGPIE_FLAG, GATEWAY)).toBe(MAGPIE_FLAG)
})

test('the dialog offers exactly the four architect candidates, the recommendation first', () => {
  const sol = rules.architect.candidates.find(c => c.model === 'codex/gpt-6.1-sol')!
  const { question, options } = askText({ recommendation: { model: sol.model, reason: `Jev 判断这项长期任务符合「${sol.when}」。`, limits: sol.limits }, root: '/tmp/mt/proj', workspace: '直接修改：/tmp/mt/proj（不是 Git 仓库，没有差异记录）', trusted: false, handoff: false }, rules)
  expect(options).toEqual(['Sol 6.1（推荐）', 'Opus 5.5', 'Mythos 5.2', 'Astra'])
  expect(optionModels(sol.model, rules)).toEqual(['codex/gpt-6.1-sol', 'claude/claude-opus-5-5', 'claude/claude-mythos-5-2', 'codex/gpt-6-astra'])
  expect(question).toContain(sol.limits)
  expect(question).toContain('项目根目录：/tmp/mt/proj')
  expect(question).toContain('直接修改：/tmp/mt/proj（不是 Git 仓库，没有差异记录）')
  expect(question).not.toContain('建立 Git 仓库')
  expect(question).toContain('Claude Code 还没有把 /tmp/mt/proj 记为受信任的目录，后台会话不能在那里启动。确认即表示你信任这个目录')
  expect(question.split('\n').at(-1)).toContain('不需要登记的临时操作请使用普通 claude')
  expect(question.split('\n').at(-1)).toContain('当前窗口随即关闭')
  const repo = askText({ recommendation: { model: 'claude/claude-opus-5-5', reason: 'r', limits: 'l' }, root: '/home/ubuntu/sipeng/claude-mods', workspace: '直接修改：/home/ubuntu/sipeng/claude-mods', trusted: true, handoff: true }, rules)
  expect(repo.options).toEqual(['Opus 5.5（推荐）', 'Mythos 5.2', 'Astra', 'Sol 6.1'])
  expect(repo.question).not.toContain('Git 仓库')
  expect(repo.question).not.toContain('受信任')
  // Under the launcher's hand-over the window goes on with the background session.
  expect(repo.question.split('\n').at(-1)).toContain('这个窗口随即切换到那个会话')
  expect(repo.question).not.toContain('随即关闭')
  expect(() => optionModels('claude/claude-haiku-5-5', rules)).toThrow('not an architect candidate')
})

test('the architect\'s first message carries the task marker on its own line after the request', () => {
  const m = architectFirstMessage('检查 greet.py 并只回复 ok', 'l-20261109-a1b2c3', { mode: 'worktree', path: '/tmp/mt/wt/l-20261109-a1b2c3' })
  const lines = m.split('\n')
  expect(lines[0]).toBe('检查 greet.py 并只回复 ok')
  expect(lines[1]).toBe('')
  expect(lines[2]).toBe('[magpie-tasks architect task=l-20261109-a1b2c3 worktree=/tmp/mt/wt/l-20261109-a1b2c3]')
  expect(m).toContain('Commit and push only when the person asks')
  expect(m).toContain('never in the task worktree')
  const direct = architectFirstMessage('检查 greet.py 并只回复 ok', 'l-20261109-a1b2c3', { mode: 'direct', path: '/tmp/mt/proj' })
  expect(direct.split('\n')[2]).toBe('[magpie-tasks architect task=l-20261109-a1b2c3 direct=/tmp/mt/proj]')
  expect(direct).toContain('work directly in the project directory /tmp/mt/proj')
  expect(direct).not.toContain('worktree')
})

test('a background session names its task by the marker line, which the engine leaves intact while it escapes the paste tags of a pasted request', () => {
  // tests/data/bg-first-prompts.ts: one message as passed to `claude-magpie --bg` and the text the
  // background session's prompt.submit hook read (Claude Code 2.1.322): no hash of the sent message
  // can match the text read.
  expect(bgFirstPromptSent).toContain('<pasted_content id="d2bf">')
  expect(bgFirstPromptRead).toContain('<\\pasted_content id="d2bf">')
  expect(bgFirstPromptRead).not.toBe(bgFirstPromptSent)
  expect(architectMarkTask(bgFirstPromptSent)).toBe('l-20261112-a1b2c3')
  expect(architectMarkTask(bgFirstPromptRead)).toBe('l-20261112-a1b2c3')
})

test('architectMarkTask reads the marker architectFirstMessage writes, the last one when the request quotes others, and none from a prompt the person typed', () => {
  const workspaces = [{ mode: 'direct' as const, path: '/tmp/mt/proj' }, { mode: 'worktree' as const, path: '/tmp/mt/wt/d-20261109-a1b2c3' }, null]
  for (const workspace of workspaces) expect(architectMarkTask(architectFirstMessage('检查 greet.py 并只回复 ok', 'd-20261109-a1b2c3', workspace))).toBe('d-20261109-a1b2c3')
  const quoted = '看一下这段输出：\n[magpie-tasks architect task=l-20261108-zzzzzz direct=/tmp/old]\nYou are the architect of this long task'
  expect(architectMarkTask(architectFirstMessage(quoted, 'l-20261109-a1b2c3', workspaces[0]!))).toBe('l-20261109-a1b2c3')
  expect(architectMarkTask('检查 greet.py 并只回复 ok')).toBeNull()
  expect(architectMarkTask('[magpie-tasks takeover task=l-20261109-a1b2c3 claim=c-20261109-abc123]')).toBeNull()
  expect(architectMarkTask('[magpie-tasks architect task=../x direct=/tmp]')).toBeNull()
  expect(architectMarkTask('[magpie-tasks architect task=a/../x direct=/tmp]')).toBeNull()
})
