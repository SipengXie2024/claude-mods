// Session roles and the confirmation dialog (plan section 12.1, session/launch row): section 2's role
// table, the worktree isolation answer for background sessions (the flag layer is Magpie's launch
// settings; of ~/.config/magpie/claude-launch/settings.json the test carries only
// env.ANTHROPIC_BASE_URL, read on 2026-11-09), and the text and options of the long-task dialog
// with the rules file.
import { expect, test } from 'claude-code/testing'
import type { SettingsReadInput } from 'claude-code'
import { parseRules } from '../src/rules'
import { architectMarkTask } from '../src/launch'
import { architectFirstMessage, architectPage, askText, bgIsolationAnswer, chooseArchitect, isOwner, NO_ARCHITECT, optionModels, OTHER_ARCHITECT, otherArchitectText, roleRule, type RoleFacts } from '../src/session'
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

const ASTRA = 'codex/gpt-6.2-astra'
const OPUS = 'claude/claude-opus-5-5'
const MYTHOS = 'claude/claude-mythos-5-2'
const NEON = 'hakimi/gemini-4-neon'
const where = { root: '/tmp/mt/proj', workspace: '直接修改：/tmp/mt/proj（不是 Git 仓库，没有差异记录）', trusted: false, handoff: false }

// The rules file with its architect candidates replaced, parsed as the plugin parses it.
function withCandidates(models: string[]) {
  const json = JSON.parse(JSON.stringify(routingRules)) as { architect: { candidates: { model: string }[] } }
  const byModel = (m: string) => json.architect.candidates.find(c => c.model === m) ?? { model: m, name: m, when: `${m} 适合的长期任务`, evidence: 'e', limits: 'l' }
  json.architect.candidates = models.map(byModel)
  return parseRules(json, { deepYes: 0.85 })
}

// The person going through the dialog: answers each page with the next of `answers` (a function
// answers with the page's options), Esc when `answers` holds 'Esc'. Returns the result and the pages.
async function walk(first: ReturnType<typeof askText>, answers: (string | ((options: string[]) => string))[], r = rules) {
  const asked: { question: string; options: string[] }[] = []
  const result = await chooseArchitect(async (question, options) => {
    asked.push({ question, options })
    const a = answers[asked.length - 1]
    if (a === undefined) throw new Error(`no answer for page ${asked.length}`)
    if (a === 'Esc') throw new Error('magpie-tasks: $.ui.ask: no answer (The user doesn\'t want to proceed with this tool use.)')
    return typeof a === 'function' ? a(options) : a
  }, first, r)
  return { result, asked }
}

test('the first page: the recommendation and the next candidate, the other candidates, the ordinary session', () => {
  const astra = rules.architect.candidates.find(c => c.model === ASTRA)!
  expect(rules.architect.candidates.map(c => c.model)).toEqual([OPUS, MYTHOS, ASTRA, NEON])
  const { question, page } = askText({ recommendation: { model: astra.model, reason: `Jev 判断这项长期任务符合「${astra.when}」。`, limits: astra.limits }, ...where }, rules)
  expect(optionModels(astra.model, rules)).toEqual([ASTRA, OPUS, MYTHOS, NEON])
  expect(page).toEqual({ models: [ASTRA, OPUS], options: ['Astra 6.2（推荐）', 'Opus 5.5', OTHER_ARCHITECT, NO_ARCHITECT], rest: [MYTHOS, NEON] })
  expect(page.options).toEqual(['Astra 6.2（推荐）', 'Opus 5.5', '选择其他架构师模型', '不用架构师（普通会话）'])
  expect(question).toContain(astra.limits)
  expect(question).toContain('项目根目录：/tmp/mt/proj')
  expect(question).toContain('直接修改：/tmp/mt/proj（不是 Git 仓库，没有差异记录）')
  expect(question).not.toContain('建立 Git 仓库')
  expect(question).toContain('Claude Code 还没有把 /tmp/mt/proj 记为受信任的目录，后台会话不能在那里启动。确认即表示你信任这个目录')
  const last = question.split('\n').at(-1)!
  expect(last).toContain('当前窗口随即关闭')
  expect(last).toContain('「选择其他架构师模型」列出其余候选')
  expect(last).toContain('选择「不用架构师（普通会话）」时，这个窗口按普通会话运行这条消息，不登记长期任务')
  expect(question).not.toContain('普通 claude')
  const repo = askText({ recommendation: { model: OPUS, reason: 'r', limits: 'l' }, root: '/home/ubuntu/sipeng/claude-mods', workspace: '直接修改：/home/ubuntu/sipeng/claude-mods', trusted: true, handoff: true }, rules)
  expect(repo.page.options).toEqual(['Opus 5.5（推荐）', 'Mythos 5.2', OTHER_ARCHITECT, NO_ARCHITECT])
  expect(repo.page.rest).toEqual([ASTRA, NEON])
  expect(repo.question).not.toContain('Git 仓库')
  expect(repo.question).not.toContain('受信任')
  // Under the launcher's hand-over the window goes on with the background session.
  expect(repo.question.split('\n').at(-1)).toContain('这个窗口随即切换到那个会话')
  expect(repo.question).not.toContain('随即关闭')
  expect(() => optionModels('claude/claude-haiku-5-5', rules)).toThrow('not an architect candidate')
})

test('the page after the other candidates lists them with when each suits, and the ordinary session', () => {
  const page = architectPage([MYTHOS, NEON], rules, false)
  expect(page).toEqual({ models: [MYTHOS, NEON], options: ['Mythos 5.2', 'Neon', NO_ARCHITECT], rest: [] })
  const text = otherArchitectText(page, rules)
  for (const m of [MYTHOS, NEON]) {
    const c = rules.architect.candidates.find(x => x.model === m)!
    expect(text).toContain(`${c.name}：${c.when}`)
  }
  expect(text).not.toContain(OTHER_ARCHITECT)
  expect(text).toContain(NO_ARCHITECT)
  // One model left still makes two options, the fewest $.ui.ask takes.
  expect(architectPage([NEON], rules, false).options).toEqual(['Neon', NO_ARCHITECT])
  expect(() => architectPage([], rules, false)).toThrow('no models left')
})

test('three candidates or fewer fit one page with the ordinary session; more page on in twos', () => {
  const three = withCandidates([OPUS, MYTHOS, NEON])
  const one = askText({ recommendation: { model: NEON, reason: 'r', limits: 'l' }, ...where }, three)
  expect(one.page).toEqual({ models: [NEON, OPUS, MYTHOS], options: ['Neon（推荐）', 'Opus 5.5', 'Mythos 5.2', NO_ARCHITECT], rest: [] })
  expect(one.question).not.toContain(OTHER_ARCHITECT)
  expect(askText({ recommendation: { model: OPUS, reason: 'r', limits: 'l' }, ...where }, withCandidates([OPUS])).page.options).toEqual(['Opus 5.5（推荐）', NO_ARCHITECT])
  // Six candidates: 2 on the first page, 2 on the second with the entry to the third, 2 on the third.
  const six = withCandidates([OPUS, MYTHOS, ASTRA, NEON, 'codex/gpt-6.2-sol', 'hakimi/gemini-4-carbon'])
  const first = askText({ recommendation: { model: OPUS, reason: 'r', limits: 'l' }, ...where }, six)
  expect(first.page.options).toEqual(['Opus 5.5（推荐）', 'Mythos 5.2', OTHER_ARCHITECT, NO_ARCHITECT])
  const second = architectPage(first.page.rest, six, false)
  expect(second).toEqual({ models: [ASTRA, NEON], options: ['Astra 6.2', 'Neon', OTHER_ARCHITECT, NO_ARCHITECT], rest: ['codex/gpt-6.2-sol', 'hakimi/gemini-4-carbon'] })
  expect(otherArchitectText(second, six)).toContain('「选择其他架构师模型」列出其余候选')
  expect(architectPage(second.rest, six, false).options).toEqual(['Sol 6.2', 'Carbon', NO_ARCHITECT])
})

test('chooseArchitect: Enter on the first page takes the recommendation; the other page takes the third and fourth models', async () => {
  const first = askText({ recommendation: { model: OPUS, reason: 'r', limits: 'l' }, ...where }, rules)
  expect(await walk(first, [o => o[0]!])).toEqual({ result: { model: OPUS, answer: 'Opus 5.5（推荐）' }, asked: [{ question: first.question, options: first.page.options }] })
  expect((await walk(first, ['Mythos 5.2'])).result).toEqual({ model: MYTHOS, answer: 'Mythos 5.2' })
  const third = await walk(first, [OTHER_ARCHITECT, 'Astra 6.2'])
  expect(third.result).toEqual({ model: ASTRA, answer: 'Astra 6.2' })
  expect(third.asked[1]!.options).toEqual(['Astra 6.2', 'Neon', NO_ARCHITECT])
  expect(third.asked[1]!.question).toBe(otherArchitectText(architectPage([ASTRA, NEON], rules, false), rules))
  expect((await walk(first, [OTHER_ARCHITECT, 'Neon'])).result).toEqual({ model: NEON, answer: 'Neon' })
  const six = withCandidates([OPUS, MYTHOS, ASTRA, NEON, 'codex/gpt-6.2-sol', 'hakimi/gemini-4-carbon'])
  const deep = await walk(askText({ recommendation: { model: OPUS, reason: 'r', limits: 'l' }, ...where }, six), [OTHER_ARCHITECT, OTHER_ARCHITECT, 'Carbon'], six)
  expect(deep.result).toEqual({ model: 'hakimi/gemini-4-carbon', answer: 'Carbon' })
  expect(deep.asked.map(a => a.options.length)).toEqual([4, 4, 3])
})

test('chooseArchitect: the ordinary session on any page, Esc on any page, and an answer no option names', async () => {
  const first = askText({ recommendation: { model: ASTRA, reason: 'r', limits: 'l' }, ...where }, rules)
  expect((await walk(first, [NO_ARCHITECT])).result).toBe('none')
  expect((await walk(first, [OTHER_ARCHITECT, NO_ARCHITECT])).result).toBe('none')
  const cancelled = { drop: 'magpie-tasks: 已取消；消息已放回输入框，再次发送会重新询问' }
  expect((await walk(first, ['Esc'])).result).toEqual(cancelled)
  expect((await walk(first, [OTHER_ARCHITECT, 'Esc'])).result).toEqual(cancelled)
  const unrecognized = { drop: 'magpie-tasks: 没有识别出选择；消息已放回输入框，再次发送会重新询问' }
  // Free text in the dialog's own entry, a model of another page, and OTHER_ARCHITECT on a last page.
  expect((await walk(first, ['先别建任务'])).result).toEqual(unrecognized)
  expect((await walk(first, ['Neon'])).result).toEqual(unrecognized)
  expect((await walk(first, [OTHER_ARCHITECT, OTHER_ARCHITECT])).result).toEqual(unrecognized)
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
