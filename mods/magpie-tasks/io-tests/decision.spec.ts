// The person's words to a terminal daily task with an open fix-confirm question (the shape of task
// ydz2kl on 2026-11-11), sent the way tg-router's forward sends them: with the real Jev, a real
// repository and the real registry. Words that answer the question are carried out (here: the fix is
// integrated into the project and the task is done) and the send is refused as handled; words that do
// not answer it go on to the executor unchanged. Like judge.spec.ts, `$.model.complete` exists only
// inside hooks, so the `complete` below throws if Jev failed; the transcript lines `ui.log` would draw
// are kept to be read.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Next, SessionSendInput, SessionSendResult } from 'claude-code'
import { baseRefName, createWorktree } from '../src/git'
import { catalogFrom } from '../src/model'
import { Registry } from '../src/registry'
import { DECISION_HANDLED, onSessionSend } from '../src/router'
import { loadRules } from '../src/rules'
import type { Ctx, Host } from '../src/state'
import { freshState } from '../src/state'
import type { Options, TaskRecord } from '../src/types'
import { PLUGIN_ROOT } from '../eval/rules-eval'
import { nodeIo } from './node-io'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mt-decision-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const WORKER = 'tui-1794376290888'
const EXECUTOR = 'a1beb54a1ecb3dec9'
const TASK = 'd-20261111-ydz2kl'

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
}

async function scenario(name: string) {
  const dir = join(root, name)
  const project = join(dir, 'proj')
  mkdirSync(project, { recursive: true })
  sh(project, 'init', '-q')
  writeFileSync(join(project, 'greet.py'), 'print("hello")\n')
  sh(project, 'add', '-A')
  sh(project, 'commit', '-qm', 'init')
  const opts: Options = {
    gatewayUrl: 'http://127.0.0.1:3425', stateDir: join(dir, 'state'), worktreeDir: join(dir, 'wt'),
    jevUrl: 'https://api.openai.com/v1/decisions', jevModel: 'gpt-6-luna', jevKeyFile: join(homedir(), '.config/jev-opus/openai-jev.key'), jevDeadlineMs: 30_000,
    evaluatorModel: 'claude/claude-opus-5-5', launcher: 'claude-magpie', claudeBin: 'claude',
    telegramStateDir: join(homedir(), '.claude/channels/telegram-live'), telegramChatId: '', timezone: 'Asia/Shanghai', ratingHour: 21,
  }
  const io = nodeIo()
  const reg = new Registry(io, opts, 'router-session')
  const wt = join(opts.worktreeDir, TASK)
  const made = await createWorktree(io, project, wt, baseRefName(TASK), project)
  writeFileSync(join(wt, 'greet.py'), 'print("hi")\n')
  const now = Date.now()
  const record: Omit<TaskRecord, 'schema' | 'createdAt' | 'updatedAt'> = {
    id: TASK, kind: 'daily', title: '把 greet.py 的 hello 改成 hi', state: 'waiting-user', pausedByUser: false,
    request: '把 greet.py 的 hello 改成 hi', followUps: [], project: { root: project },
    worktree: { path: wt, baseRef: made.baseRef, baseCommit: made.baseCommit }, extraWorktrees: {},
    owner: { kind: 'agent', agentId: EXECUTOR, workerName: WORKER, routerSessionId: 'router-session' },
    telegram: { chatId: 'tui', workerName: WORKER },
    agents: {}, blockers: {},
    decisions: {
      'q-20261111-fix001': {
        id: 'q-20261111-fix001', kind: 'fix-confirm', createdAt: now - 60_000,
        question: '「把 greet.py 的 hello 改成 hi」验收没有通过，执行者已经修复。\n验收意见：greet.py 仍然输出 hello。\n修复结果：greet.py 现在输出 hi。\n改动了 1 个文件（greet.py）。回复是否把改动整合到项目。',
        options: ['整合', '不整合'], data: { agentId: EXECUTOR, change: 'yes' },
      },
    },
    deliverables: [{ at: now - 120_000, summary: 'greet.py 现在输出 hi', verification: ['python3 greet.py：hi'], acceptance: { agentId: 'acc1', pass: false, notes: 'greet.py 仍然输出 hello。', fixed: { at: now - 60_000 } } }],
    feedback: [], ratings: [], pendingRelays: {},
  }
  await reg.create(record)
  await reg.updateIndex(x => {
    x.workers[WORKER] = { taskId: TASK, ownerAgentId: EXECUTOR, long: false }
    x.agents[EXECUTOR] = WORKER
  })
  const shown: string[] = []
  const host = {
    ui: { log: (text: string) => { shown.push(text) } },
    model: { complete: async () => { throw new Error('$.model.complete is available only inside a hook; Jev failed in this test') } },
  } as unknown as Host
  const st = freshState()
  st.role = 'router'
  st.sessionId = 'router-session'
  // Magpie's own flag settings, as claude-magpie passes them to the Router.
  const flag = JSON.parse(readFileSync(join(homedir(), '.config/magpie/claude-launch/settings.json'), 'utf8')) as unknown
  const ctx: Ctx = { host, io, opts, rules: await loadRules(io, PLUGIN_ROOT), catalog: catalogFrom(flag), reg, st }
  return { project, wt, reg, ctx, shown }
}

function sendOf(text: string): SessionSendInput {
  return { to: WORKER, text, origin: { kind: 'plugin', name: 'tg-router' } }
}

// The delivery beneath magpie-tasks' hook: what reaches it is kept, and it reports the send delivered.
function delivery(passed: SessionSendInput[]): Next<'session.send'> {
  return (async (e: SessionSendInput): Promise<SessionSendResult> => { passed.push(e); return { isDelivered: true } }) as unknown as Next<'session.send'>
}

test('words that answer the open fix-confirm are carried out: the fix is integrated and the send is handled', async () => {
  const s = await scenario('approve')
  const passed: SessionSendInput[] = []
  const r = await onSessionSend(s.ctx, sendOf('终端 追问（message_id=1794390000001）：\n整合吧'), delivery(passed))
  expect(passed).toEqual([])
  expect(r.isDelivered).toBe(false)
  expect(!r.isDelivered && r.reason.startsWith(DECISION_HANDLED)).toBe(true)
  expect(readFileSync(join(s.project, 'greet.py'), 'utf8')).toBe('print("hi")\n')
  const t = (await s.reg.get(TASK))!
  expect(t.state).toBe('done')
  expect(t.decisions['q-20261111-fix001']!.answer).toStartWith('approve: 整合吧')
  expect(t.followUps.map(f => f.text)).toEqual(['整合吧'])
  expect(s.shown.some(line => line.includes('已整合到'))).toBe(true)
}, 120_000)

test('words that do not answer it go on to the executor unchanged, and the question stays open', async () => {
  const s = await scenario('other')
  const text = '终端 追问（message_id=1794390000002）：\n顺便把 README 也补上一段用法说明'
  const passed: SessionSendInput[] = []
  const r = await onSessionSend(s.ctx, sendOf(text), delivery(passed))
  expect(r.isDelivered).toBe(true)
  expect(passed.map(e => e.text)).toEqual([text])
  const t = (await s.reg.get(TASK))!
  expect(t.decisions['q-20261111-fix001']!.resolvedAt).toBeUndefined()
  expect(t.state).toBe('running')
  expect(readFileSync(join(s.project, 'greet.py'), 'utf8')).toBe('print("hello")\n')
}, 120_000)
