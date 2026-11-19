// The first message of a candidate window (src/session.ts onFirstPrompt, plan section 9.2) when the
// person answers the architect dialog with the ordinary session, on the first page or after the
// other candidates. The registry, the project directory, the Claude Code config and Jev's
// recommendation are real; the dialog is a `$.ui.ask` promise the test settles with an option's
// label, as the person would. The config directory is a temporary one whose .claude.json does not
// trust the project, so the dialog carries the trust sentence and any trust write would show.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Next, PromptSubmitInput } from 'claude-code'
import { catalogFrom } from '../src/model'
import { Registry } from '../src/registry'
import { loadRules } from '../src/rules'
import { NO_ARCHITECT, OTHER_ARCHITECT, onFirstPrompt } from '../src/session'
import type { Ctx, Host } from '../src/state'
import { freshState } from '../src/state'
import type { Options } from '../src/types'
import { PLUGIN_ROOT } from '../eval/rules-eval'
import { nodeIo } from './node-io'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mt-session-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const SESSION = '3f0c2a9e-5b7d-4c1e-9a8f-2d6b4e1c7a90'
const REQUEST = '把 greet.py 的问候语改成 hello，并说明改了哪一行'

async function scenario(name: string, answers: string[]) {
  const dir = join(root, name)
  const project = join(dir, 'proj')
  const config = join(dir, 'cfg')
  mkdirSync(project, { recursive: true })
  mkdirSync(config, { recursive: true })
  writeFileSync(join(project, 'greet.py'), 'print("hi")\n')
  const claudeJson = JSON.stringify({ projects: {} }, null, 2)
  writeFileSync(join(config, '.claude.json'), claudeJson)
  const handoff = join(dir, 'handoff')
  const opts: Options = {
    gatewayUrl: 'http://127.0.0.1:3425', stateDir: join(dir, 'state'), worktreeDir: join(dir, 'wt'),
    jevUrl: 'https://api.openai.com/v1/decisions', jevModel: 'gpt-6-luna', jevKeyFile: join(homedir(), '.config/jev-opus/openai-jev.key'), jevDeadlineMs: 30_000,
    evaluatorModel: 'claude/claude-opus-5-5', launcher: 'claude-magpie', claudeBin: 'claude',
    telegramStateDir: join(dir, 'tg'), telegramChatId: 'tui', telegramAfterMinutes: 10, timezone: 'Asia/Shanghai', ratingHour: 21,
  }
  const real = nodeIo()
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: config, MAGPIE_TASKS_HANDOFF: handoff }
  const io = { ...real, env: async (k: string) => (k in env ? env[k] : real.env(k)) }
  const reg = new Registry(io, opts, SESSION)
  const shown: string[] = []
  const dialogs: { question: string; options: readonly string[]; header: string | undefined }[] = []
  const timers: number[] = []
  const host = {
    ui: {
      log: (text: string) => { shown.push(text) },
      ask: async (question: string, a: { options: readonly string[]; header?: string }) => {
        dialogs.push({ question, options: a.options, header: a.header })
        const answer = answers[dialogs.length - 1]
        if (answer === undefined) throw new Error(`no answer for dialog ${dialogs.length}`)
        return answer
      },
    },
    clock: { after: (ms: number) => { timers.push(ms); return { cancel: () => {} } } },
    model: { complete: async () => { throw new Error('$.model.complete is available only inside a hook; Jev failed in this test') } },
  } as unknown as Host
  const st = freshState()
  st.role = 'candidate'
  st.sessionId = SESSION
  st.cwd = project
  st.startSource = 'startup'
  const flag = JSON.parse(readFileSync(join(homedir(), '.config/magpie/claude-launch/settings.json'), 'utf8')) as unknown
  const ctx: Ctx = { host, io, opts, rules: await loadRules(io, PLUGIN_ROOT), catalog: catalogFrom(flag), reg, st }
  const passed: PromptSubmitInput[] = []
  const next = (async (e: PromptSubmitInput) => { passed.push(e); return {} }) as unknown as Next<'prompt.submit'>
  const e = { text: REQUEST, origin: { kind: 'composer' } } as unknown as PromptSubmitInput
  const result = await onFirstPrompt(ctx, e, next)
  const tasks = existsSync(join(opts.stateDir, 'tasks')) ? readdirSync(join(opts.stateDir, 'tasks')) : []
  return { result, e, st, shown, dialogs, timers, passed, tasks, handoff, claudeJson, configNow: readFileSync(join(config, '.claude.json'), 'utf8'), worktrees: existsSync(opts.worktreeDir) ? readdirSync(opts.worktreeDir) : [] }
}

function expectOrdinary(s: Awaited<ReturnType<typeof scenario>>) {
  // The message goes on to this window's model as typed, and later messages are not asked about.
  expect(s.passed).toEqual([s.e])
  expect(s.result as unknown).toEqual({})
  expect(s.st.role).toBe('unmanaged')
  expect(s.st.firstPromptSeen).toBe(true)
  expect(s.st.taskId).toBeNull()
  expect(s.shown).toEqual(['magpie-tasks: 本会话按普通会话运行，不登记为长期任务'])
  // No task, no trust, no worktree, no hand-over, no exit.
  expect(s.tasks).toEqual([])
  expect(s.configNow).toBe(s.claudeJson)
  expect(s.worktrees).toEqual([])
  expect(existsSync(s.handoff)).toBe(false)
  expect(s.timers).toEqual([])
}

test('the ordinary session on the first page: the message runs in this window and nothing is recorded', async () => {
  const s = await scenario('first-page', [NO_ARCHITECT])
  expect(s.dialogs).toHaveLength(1)
  const d = s.dialogs[0]!
  expect(d.header).toBe('长期任务')
  expect(d.options).toHaveLength(4)
  expect(d.options[0]).toEndWith('（推荐）')
  expect(d.options.slice(2)).toEqual([OTHER_ARCHITECT, NO_ARCHITECT])
  expect(d.question).toContain(`项目根目录：${join(root, 'first-page', 'proj')}`)
  expect(d.question).toContain('记为受信任的目录')
  expect(d.question).toContain('这个窗口随即切换到那个会话')
  expectOrdinary(s)
}, 60_000)

test('the ordinary session after the other candidates: the second page lists the two models not shown first', async () => {
  const s = await scenario('second-page', [OTHER_ARCHITECT, NO_ARCHITECT])
  expect(s.dialogs).toHaveLength(2)
  const [first, second] = s.dialogs as [typeof s.dialogs[number], typeof s.dialogs[number]]
  const shownFirst = first.options.slice(0, 2).map(o => o.replace('（推荐）', ''))
  const all = ['Opus 5.5', 'Mythos 5.2', 'Astra 6.2', 'Neon']
  expect(second.header).toBe('长期任务')
  expect(second.options).toEqual([...all.filter(n => !shownFirst.includes(n)), NO_ARCHITECT])
  for (const n of second.options.slice(0, 2)) expect(second.question).toContain(`${n}：`)
  expectOrdinary(s)
}, 60_000)
