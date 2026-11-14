// A long task's questions and notices in the architect session (src/channel.ts, src/architect.ts):
// the window first, Telegram once the wait is over, one answer carried out. The registry, the files
// and Jev are real. The task is the one of e2e E20: two subagents changed greet.py, the later one is
// paused on a file-conflict decision.
//
// Telegram: the task's chat is `1` and the channel directory holds a bot token Telegram refuses, so
// every send the plugin makes is a real request to api.telegram.org that reaches no one and comes
// back `401 Unauthorized`. A test reads the send from that: the curl run in the Io record and the
// error the plugin reports. What needs a send to succeed (the message ID kept on the decision, a
// Telegram reply to the architect's own question) is not covered here.
//
// Time is the plugin's clock: `io.now()` and `$.clock.after` read one clock the test moves. The
// dialogs are `$.ui.ask` promises the test settles as the person would: with an option's label, or
// with the rejection the engine gives a closed dialog (measured 2026-11-13: `HooksError: magpie-tasks:
// $.ui.ask: no answer (The user doesn't want to proceed with this tool use. …)`). `$.ui.notify`
// answers what it answered in a tmux pane that day: `{ isSent: false, reason: 'no-channel' }`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Next, PromptSubmitInput, ToolCallInput, TurnCompleteInput } from 'claude-code'
import { architectTool, onArchitectPrompt, onArchitectReceive, onArchitectToolCall, resumeArchitectChannels } from '../src/architect'
import { resetChannels, SEPARATE, WAIT } from '../src/channel'
import { catalogFrom } from '../src/model'
import { Registry } from '../src/registry'
import { interruptedDecision } from '../src/recovery'
import { loadRules } from '../src/rules'
import { claimTakeover } from '../src/session'
import type { Ctx, Host } from '../src/state'
import { freshState } from '../src/state'
import type { AgentRecord, Options, TaskRecord } from '../src/types'
import { onAgentError } from '../src/unavailable'
import { PLUGIN_ROOT } from '../eval/rules-eval'
import { nodeIo } from './node-io'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mt-channel-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const MIN = 60_000
const SESSION = '6995ef07-1a47-4fa4-a549-9a673ccfcbe3'
const TASK = 'l-20261113-zzyzxo'
const A = 'a92952f59ae89de8a'
const B = 'ac77881ff6b69b608'
const Q = 'q-20261113-aaa111'
const CLOSED = 'magpie-tasks: $.ui.ask: no answer (The user doesn\'t want to proceed with this tool use.)'

function agent(agentId: string, description: string, cwd: string, over: Partial<AgentRecord>): AgentRecord {
  return {
    agentId, description, role: 'implementer', sessionId: SESSION, ruleId: 'code-change', rulesVersion: 'routing-rules.v8',
    selection: { kind: 'rule', reason: 'rule code-change' }, judgment: null, model: 'claude/claude-opus-5-5', effort: 'high', efforts: [],
    contextSource: 'brief', cwd, worktree: cwd, state: 'idle', pendingRaises: [], filesTouched: [`${cwd}/greet.py`], reports: [], startedAt: 0, ...over,
  }
}

// What happened, as the test waits for it: polls until `ok` holds.
async function until(ok: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function scenario(name: string, o: { askedAgo?: number; decision?: boolean; messages?: unknown[] } = {}) {
  resetChannels()
  const dir = join(root, name)
  const project = join(dir, 'proj')
  const tg = join(dir, 'tg')
  mkdirSync(project, { recursive: true })
  mkdirSync(tg, { recursive: true })
  writeFileSync(join(project, 'greet.py'), 'print("hi")\n')
  writeFileSync(join(tg, '.env'), 'TELEGRAM_BOT_TOKEN=1:e2e-refused-token\n')
  const opts: Options = {
    gatewayUrl: 'http://127.0.0.1:3425', stateDir: join(dir, 'state'), worktreeDir: join(dir, 'wt'),
    jevUrl: 'https://api.openai.com/v1/decisions', jevModel: 'gpt-6-luna', jevKeyFile: join(homedir(), '.config/jev-opus/openai-jev.key'), jevDeadlineMs: 30_000,
    evaluatorModel: 'claude/claude-opus-5-5', launcher: 'claude-magpie', claudeBin: 'claude',
    telegramStateDir: tg, telegramChatId: '1', telegramAfterMinutes: 10, timezone: 'Asia/Shanghai', ratingHour: 21,
  }
  // The plugin's clock: io.now() and $.clock.after. `advance` moves it and runs the timers now due.
  let now = Date.now()
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  const advance = (ms: number) => {
    now += ms
    for (const t of timers) {
      if (!t.live || t.at > now) continue
      t.live = false
      t.fn()
    }
  }
  const real = nodeIo()
  const io = { ...real, now: async () => now }
  const curls = () => real.calls.filter(c => c.method === 'run' && c.argv[0] === 'curl').length
  const reg = new Registry(io, opts, SESSION)
  const started = now - 30 * MIN
  const record: Omit<TaskRecord, 'schema' | 'createdAt' | 'updatedAt'> = {
    id: TASK, kind: 'long', title: 'greet', state: 'running', pausedByUser: false, request: '检查 greet.py', followUps: [],
    project: { root: project }, direct: { dir: project, baseRef: null, baseCommit: null }, worktree: null, extraWorktrees: {},
    owner: { kind: 'session', sessionId: SESSION, jobShortId: '6995ef07', previousSessionIds: [], model: 'claude/claude-opus-5-5', contextMemoryFingerprint: 'absent' },
    telegram: { chatId: '1' },
    agents: {
      // A has finished, so a `wait` answer wakes B at once.
      [A]: agent(A, '改成 hi', project, { startedAt: started, reports: [{ at: now - MIN, status: 'done', text: '状态：已完成', verification: [] }] }),
      [B]: agent(B, '改成 hey', project, { startedAt: started + MIN, ...(o.decision === false ? {} : { state: 'paused' as const, pausedFor: Q }) }),
    },
    blockers: {},
    decisions: o.decision === false ? {} : {
      [Q]: {
        id: Q, kind: 'file-conflict', createdAt: now - (o.askedAgo ?? 0), ...(o.askedAgo !== undefined ? { askedAt: now - o.askedAgo } : {}),
        question: '长期任务「greet」（l-20261113-zzyzxo）：实施子代理「改成 hey」和仍在运行的实施子代理「改成 hi」改动了同一个文件 greet.py。已暂停后启动的实施子代理「改成 hey」。让它在单独的工作副本中继续，还是等实施子代理「改成 hi」完成后再继续？',
        options: [SEPARATE, WAIT], data: { agentId: B, otherAgentId: A, path: `${project}/greet.py`, cause: 'same-file' },
      },
    },
    deliverables: [], feedback: [], ratings: [], pendingRelays: {},
  }
  await reg.create(record)
  const shown: string[] = []
  const rang: string[] = []
  const submitted: string[] = []
  const appended: string[] = []
  const woken: string[] = []
  const dialogs: { question: string; options: readonly string[]; answer: (label: string) => void; close: () => void }[] = []
  const host = {
    ui: {
      log: (text: string) => { shown.push(text) },
      ask: (question: string, a: { options: readonly string[] }) => new Promise<string>((resolve, reject) => {
        dialogs.push({ question, options: a.options, answer: resolve, close: () => reject(new Error(CLOSED)) })
      }),
      notify: async (text: string) => { rang.push(text); return { isSent: false, reason: 'no-channel' } },
    },
    clock: { after: (ms: number, fn: () => void) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return { cancel: () => { t.live = false } } } },
    session: {
      append: async (a: { message: { content: { text: string }[] } }) => { appended.push(a.message.content.map(c => c.text).join('')); return {} },
      messages: async () => o.messages ?? [],
      send: async (a: { to: { agentId: string } }) => { woken.push(a.to.agentId); return { isDelivered: true } },
    },
    prompt: { submit: async (a: { text: string }) => { submitted.push(a.text); return {} } },
    model: { complete: async () => { throw new Error('$.model.complete is available only inside a hook; Jev failed in this test') } },
  } as unknown as Host
  const st = freshState()
  st.role = 'architect'
  st.sessionId = SESSION
  st.taskId = TASK
  st.cwd = project
  const flag = JSON.parse(readFileSync(join(homedir(), '.config/magpie/claude-launch/settings.json'), 'utf8')) as unknown
  const ctx: Ctx = { host, io, opts, rules: await loadRules(io, PLUGIN_ROOT), catalog: catalogFrom(flag), reg, st }
  const task = async () => (await reg.get(TASK))!
  const log = () => readFileSync(join(opts.stateDir, 'tasks', `${TASK}.log.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string; [k: string]: unknown })
  // Prompts that went on to the architect model, with the context the plugin added.
  const passed: PromptSubmitInput[] = []
  const next = (async (e: PromptSubmitInput) => { passed.push(e); return {} }) as unknown as Next<'prompt.submit'>
  const typed = (text: string) => onArchitectPrompt(ctx, { text, origin: { kind: 'composer' } } as unknown as PromptSubmitInput, next)
  // What the Router hands the architect for a Telegram message (router.ts architectText).
  const telegram = (messageId: number, body: string, decision?: string, id = Q) => onArchitectPrompt(ctx, { text: `[magpie-tasks telegram chat=1 message=${messageId}${decision ? ` decision=${id} answer=${decision}` : ''}]\n${body}`, origin: { kind: 'peer' } } as unknown as PromptSubmitInput, next)
  // The feedback judgment (Jev) of a message runs behind its prompt; a test ends after it.
  const feedback = (n: number) => until(async () => (await task()).feedback.length >= n, 'the feedback judgment')
  return { ctx, st, reg, project, shown, rang, submitted, appended, woken, dialogs, passed, advance, curls, task, log, typed, telegram, feedback }
}

test('a question answered in the window within the wait is carried out there and never goes to Telegram', async () => {
  const s = await scenario('window')
  await resumeArchitectChannels(s.ctx)
  await until(() => s.dialogs.length === 1 && s.rang.length === 1, 'the dialog and its notification')
  expect(s.dialogs[0]!.options).toEqual(['单独副本', '等待前一方'])
  expect(s.dialogs[0]!.question).toContain('改动了同一个文件 greet.py')
  expect((await s.task()).decisions[Q]!.askedAt).toBeDefined()
  s.advance(9 * MIN)
  s.dialogs[0]!.answer('等待前一方')
  await until(() => s.submitted.length === 1, 'the architect\'s turn about the answer')
  const d = (await s.task()).decisions[Q]!
  expect([d.answer, d.via, d.telegram]).toEqual(['wait', 'window', undefined])
  expect(s.woken).toEqual([B])
  expect((await s.task()).agents[B]!.state).toBe('running')
  expect(s.submitted[0]).toContain(`The person answered decision ${Q} (file-conflict) in the window: 等待前一方. It was carried out:`)
  // The wait runs out long after the answer: nothing is sent.
  s.advance(60 * MIN)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(s.curls()).toBe(0)
  expect(s.log().filter(e => e.type === 'telegram' || e.type === 'error')).toEqual([])
}, 60_000)

test('an unanswered question goes to Telegram when the wait is over, and not a second earlier', async () => {
  const s = await scenario('timeout')
  await resumeArchitectChannels(s.ctx)
  await until(() => s.dialogs.length === 1, 'the dialog')
  s.advance(10 * MIN - 1000)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(s.curls()).toBe(0)
  s.advance(1000)
  await until(() => s.shown.some(line => line.includes('转发到 Telegram 失败')), 'Telegram\'s answer to the send')
  expect(s.curls()).toBe(1)
  expect(s.shown.find(line => line.includes('转发到 Telegram 失败'))).toContain('Telegram sendMessage to 1: HTTP 401: Unauthorized')
  await until(() => s.log().some(e => e.type === 'error'), 'the task log entry')
  expect(s.log().filter(e => e.type === 'error').map(e => [e['during'], e['error']])).toEqual([['telegram forward', 'Telegram sendMessage to 1: HTTP 401: Unauthorized']])
  // The question is still open in the window, and its dialog still answers it.
  s.dialogs[0]!.answer('等待前一方')
  await until(() => s.submitted.length === 1, 'the architect\'s turn about the answer')
  expect((await s.task()).decisions[Q]!.via).toBe('window')
}, 60_000)

test('in a turn a Telegram message started, a new question goes to Telegram at once', async () => {
  const s = await scenario('telegram-turn', { decision: false })
  s.st.replyTargets.push({ chatId: '1', messageId: 41 })
  // A second diagnosis of one blocker is refused and becomes a no-progress question.
  expect(await architectTool(s.ctx, 'report_outcome', { agent_id: A, outcome: 'diagnosis', blocker_id: 'new', blocker: '测试机连不上', notes: '第一次诊断' })).toContain('Recorded diagnosis for blocker b1')
  await expect(architectTool(s.ctx, 'report_outcome', { agent_id: A, outcome: 'diagnosis', blocker_id: 'b1', notes: '第二次诊断' })).rejects.toThrow('Telegram sendMessage to 1: HTTP 401: Unauthorized')
  expect(s.curls()).toBe(1)
  const d = Object.values((await s.task()).decisions)
  expect(d.map(x => [x.kind, x.askedAt !== undefined])).toEqual([['no-progress', true]])
}, 60_000)

test('Telegram answers first: the answer is carried out once, and the window dialog left open only gets a line', async () => {
  const s = await scenario('telegram-first')
  await resumeArchitectChannels(s.ctx)
  await until(() => s.dialogs.length === 1, 'the dialog')
  await s.telegram(77, '等待前一方', 'wait')
  const d = (await s.task()).decisions[Q]!
  expect([d.answer, d.via]).toEqual(['wait', 'telegram'])
  expect(s.woken).toEqual([B])
  expect(s.passed[0]!.context!.some(line => line.includes(`Decision ${Q} (file-conflict) was carried out on the person's Telegram reply (wait)`))).toBe(true)
  // The person later picks the other option in the dialog nobody could close.
  s.dialogs[0]!.answer('单独副本')
  await until(() => s.shown.some(line => line.includes('这个问题已经')), 'the line about the earlier answer')
  expect(s.shown).toContain('这个问题已经在 Telegram 上按「等待前一方」决定，这次回答没有再执行。')
  const after = (await s.task()).decisions[Q]!
  expect([after.answer, after.via]).toEqual(['wait', 'telegram'])
  expect(s.woken).toEqual([B])
  expect(Object.keys((await s.task()).extraWorktrees)).toEqual([])
  expect(s.submitted).toEqual([])
  await s.feedback(1)
}, 120_000)

test('the window answers first: a later Telegram reply is not carried out and is answered with the line', async () => {
  const s = await scenario('window-first')
  await resumeArchitectChannels(s.ctx)
  await until(() => s.dialogs.length === 1, 'the dialog')
  s.dialogs[0]!.answer('等待前一方')
  await until(() => s.submitted.length === 1, 'the architect\'s turn about the answer')
  // The line goes to Telegram under the person's reply: the refused send is that reply.
  await expect(s.telegram(78, '单独副本', 'separate')).rejects.toThrow('Telegram sendMessage to 1: HTTP 401: Unauthorized')
  expect(s.curls()).toBe(1)
  const d = (await s.task()).decisions[Q]!
  expect([d.answer, d.via]).toEqual(['wait', 'window'])
  expect(s.woken).toEqual([B])
  expect(Object.keys((await s.task()).extraWorktrees)).toEqual([])
  expect(s.passed).toEqual([])
  expect(s.st.replyTargets).toEqual([])
}, 60_000)

test('both sides answer at the same moment: one answer is carried out', async () => {
  const s = await scenario('both')
  await resumeArchitectChannels(s.ctx)
  await until(() => s.dialogs.length === 1, 'the dialog')
  const fromTelegram = s.telegram(79, '等待前一方', 'wait')
  s.dialogs[0]!.answer('等待前一方')
  await fromTelegram
  await until(() => s.submitted.length === 1 || s.shown.some(line => line.includes('这个问题已经')), 'the window dialog\'s outcome')
  expect(s.woken).toEqual([B])
  expect(s.log().filter(e => e.type === 'decision' && e['answer'] === 'wait').length).toBe(1)
  expect(s.log().filter(e => e.type === 'resume').length).toBe(1)
  await s.feedback(1)
}, 120_000)

test('after a restart a question keeps the rest of its wait', async () => {
  const s = await scenario('restart-left', { askedAgo: 4 * MIN })
  await resumeArchitectChannels(s.ctx)
  await until(() => s.dialogs.length === 1, 'the dialog put back in the window')
  s.advance(6 * MIN - 1000)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(s.curls()).toBe(0)
  s.advance(1000)
  await until(() => s.curls() === 1, 'the send to Telegram')
}, 60_000)

test('after a restart an overdue question goes to Telegram at once, and its dialog is back whatever the send gives', async () => {
  const s = await scenario('restart-overdue', { askedAgo: 25 * MIN })
  await resumeArchitectChannels(s.ctx)
  await until(() => s.dialogs.length === 1, 'the dialog put back in the window')
  await until(() => s.shown.some(line => line.includes('转发到 Telegram 失败')), 'Telegram\'s answer to the send')
  expect(s.curls()).toBe(1)
  // The line is shown before the task log entry is written.
  await until(() => s.log().some(e => e.type === 'error'), 'the task log entry')
  expect(s.log().filter(e => e.type === 'error').map(e => [e['during'], e['error']])).toEqual([['telegram forward', 'Telegram sendMessage to 1: HTTP 401: Unauthorized']])
  // The question is still open, and its dialog answers it.
  s.dialogs[0]!.answer('等待前一方')
  await until(() => s.submitted.length === 1, 'the architect\'s turn about the answer')
  expect((await s.task()).decisions[Q]!.via).toBe('window')
}, 60_000)

test('a closed dialog leaves the question open; words typed in the window that answer it are carried out, other words are not', async () => {
  const s = await scenario('typed')
  await resumeArchitectChannels(s.ctx)
  await until(() => s.dialogs.length === 1, 'the dialog')
  s.dialogs[0]!.close()
  await until(() => s.shown.some(line => line.includes('问题还没有回答')), 'the line after the dialog was closed')
  expect(s.shown.find(line => line.includes('问题还没有回答'))).toContain('直接在窗口里输入你的回答即可：单独副本 / 等待前一方；10 分钟内没有回答，它会发到 Telegram')
  expect((await s.task()).decisions[Q]!.resolvedAt).toBeUndefined()
  await s.typed('顺便把 README 也补上一段用法说明')
  expect((await s.task()).decisions[Q]!.resolvedAt).toBeUndefined()
  expect(s.passed[0]!.context!.some(line => line.includes('answers decision'))).toBe(false)
  await s.typed('让它等前面那个子代理做完再继续吧')
  const d = (await s.task()).decisions[Q]!
  expect([d.answer, d.via]).toEqual(['wait', 'window'])
  expect(s.woken).toEqual([B])
  expect(s.passed[1]!.context!.some(line => line.includes(`The person's message below answers decision ${Q} (file-conflict:`) && line.includes('with wait; it was carried out:'))).toBe(true)
  // Answered: the timer no longer sends it.
  s.advance(60 * MIN)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(s.curls()).toBe(0)
  await s.feedback(2)
}, 180_000)

test('notify_user shows in the window; Telegram follows only when the person sends this session nothing for the wait', async () => {
  const s = await scenario('notice', { decision: false })
  await expect(architectTool(s.ctx, 'notify_user', { kind: 'decision', text: '用哪个方案？' })).rejects.toThrow('Ask the person what they must decide with AskUserQuestion')
  const told = await architectTool(s.ctx, 'notify_user', { kind: 'result', text: '第一部分已经完成' })
  expect(told).toBe('Shown in the window; it goes to Telegram as well if the person sends this session nothing within 10 minutes.')
  expect(s.shown).toContain('长期任务「greet」有了结果：\n第一部分已经完成')
  await until(() => s.rang.length === 1, 'the notification')
  expect(Object.values((await s.task()).notices ?? {}).map(n => n.text)).toEqual(['长期任务「greet」有了结果：\n第一部分已经完成'])
  // The person types in the window after five minutes: they have seen it.
  s.advance(5 * MIN)
  await s.typed('好的，继续做第二部分')
  expect((await s.task()).notices).toEqual({})
  s.advance(60 * MIN)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(s.curls()).toBe(0)
  // The next notice gets no message for ten minutes.
  await architectTool(s.ctx, 'notify_user', { kind: 'result', text: '第二部分已经完成' })
  s.advance(10 * MIN - 1000)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(s.curls()).toBe(0)
  s.advance(1000)
  await until(() => s.shown.some(line => line.includes('转发到 Telegram 失败')), 'Telegram\'s answer to the send')
  expect(s.curls()).toBe(1)
  // In a turn a Telegram message started, done goes to both at once.
  s.st.replyTargets.push({ chatId: '1', messageId: 42 })
  await expect(architectTool(s.ctx, 'notify_user', { kind: 'done', text: '全部完成' })).rejects.toThrow('Telegram sendMessage to 1: HTTP 401: Unauthorized')
  expect(s.curls()).toBe(2)
  await s.feedback(1)
}, 120_000)

// The call Opus 5.5 made in the architect session of /tmp/mt-e2e-qg8n on 2026-11-13.
const TEA = { tool: 'AskUserQuestion', tool_use_id: 'toolu_01EHTzPXe5Tpmqp8EgG8jUeU', questions: [{ question: '喜欢茶还是咖啡？', header: '饮品', multiSelect: false, options: [{ label: '茶', description: '选择茶' }, { label: '咖啡', description: '选择咖啡' }] }] }

test('the architect\'s AskUserQuestion is shown by the plugin; the window answer is the tool\'s result, and Telegram is tried after the wait', async () => {
  const s = await scenario('question', { decision: false })
  const beneath: ToolCallInput[] = []
  const next = (async (e: ToolCallInput) => { beneath.push(e); return { result: {} } }) as unknown as Next<'tool.call'>
  const call = onArchitectToolCall(s.ctx, TEA as unknown as ToolCallInput, next)
  await until(() => s.dialogs.length === 1 && s.rang.length === 1, 'the dialog and its notification')
  expect(s.dialogs[0]!.question).toBe('喜欢茶还是咖啡？\n· 茶：选择茶\n· 咖啡：选择咖啡')
  expect(s.dialogs[0]!.options).toEqual(['茶', '咖啡'])
  s.advance(10 * MIN)
  await until(() => s.shown.some(line => line.includes('转发到 Telegram 失败')), 'Telegram\'s answer to the send')
  expect(s.curls()).toBe(1)
  // The question never reached Telegram, so a message from there is no answer to it: it stays in the
  // queue, and the question is sent again because the person is on Telegram now.
  expect(await onArchitectReceive(s.ctx, '[magpie-tasks telegram chat=1 message=90]\n咖啡')).toBeNull()
  await until(() => s.curls() === 2, 'the second send')
  s.dialogs[0]!.answer('咖啡')
  expect(await call).toEqual({ result: { questions: TEA.questions, answers: { '喜欢茶还是咖啡？': '咖啡' } } })
  expect(beneath).toEqual([])
  expect(s.log().filter(e => e.type === 'answer').map(e => e['via'])).toEqual(['window'])
  // A closed dialog ends the call as the person's refusal.
  const second = onArchitectToolCall(s.ctx, TEA as unknown as ToolCallInput, next)
  await until(() => s.dialogs.length === 2, 'the second dialog')
  s.dialogs[1]!.close()
  expect(await second).toEqual({ deny: 'The person closed the question in the window without answering it. Go on without that answer, or say in your answer what you need from them.' })
}, 60_000)

// ---- the model-unavailable question --------------------------------------------------------------

// E14's subagent: the person named a model Magpie does not have, and its turn ended on Magpie's 400
// (`model_not_found` after stopFailureCategory). Its rule's models and substitutes are the options.
const C = 'a5b6c7d8e9f001122'
async function unavailableModel(name: string) {
  const s = await scenario(name, { decision: false })
  await s.reg.update(TASK, t => {
    t.agents[C] = agent(C, '统计 greet.py 的行数', s.project, { state: 'running', model: 'codex/gpt-6-magpie-missing', selection: { kind: 'user', reason: '测试不可用模型', userConfirmation: '测试不可用模型' }, startedAt: Date.now() })
  }, { type: 'test', step: 'the subagent on an unavailable model' })
  s.st.agents.set(C, TASK)
  s.st.stopFailures.set(C, 'model_not_found')
  await onAgentError(s.ctx, { reason: 'error', agentId: C } as unknown as TurnCompleteInput)
  const d = Object.values((await s.task()).decisions).find(x => x.kind === 'model-unavailable')!
  await until(() => s.dialogs.length === 1 && s.rang.length === 1, 'the dialog and its notification')
  return { s, d }
}

test('a model-unavailable question opens in the window; the option chosen there, a third one too, is the answer the architect arranges', async () => {
  const { s, d } = await unavailableModel('unavailable-window')
  expect(d.options[0]).toBe('等待')
  expect(d.options.length).toBeGreaterThanOrEqual(3)
  expect((await s.task()).state).toBe('waiting-user')
  expect(s.dialogs[0]!.options).toEqual(d.options.slice(0, 4))
  expect(s.dialogs[0]!.question).toBe(d.question)
  expect(s.appended.some(text => text.includes(`the person decides (decision ${d.id}`) && text.includes('The person was asked in the window; unanswered for 10 minutes, the question goes to Telegram too.'))).toBe(true)
  const third = d.options[2]!
  s.advance(9 * MIN)
  s.dialogs[0]!.answer(third)
  await until(() => s.submitted.length === 1, 'the architect\'s turn about the answer')
  const after = (await s.task()).decisions[d.id]!
  expect([after.answer, after.via]).toEqual([third, 'window'])
  expect((await s.task()).state).toBe('running')
  expect(s.submitted[0]).toContain(`The person answered decision ${d.id} (model-unavailable) in the window: ${third}. It was carried out: the person answered "${third}"`)
  expect(s.submitted[0]).toContain(`[model-reason user: ${third}]`)
  s.advance(60 * MIN)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(s.curls()).toBe(0)
  // A Telegram reply that comes after gets the line, under the reply (the refused send).
  await expect(s.telegram(81, '等待', 'unclear', d.id)).rejects.toThrow('Telegram sendMessage to 1: HTTP 401: Unauthorized')
  expect((await s.task()).decisions[d.id]!.answer).toBe(third)
}, 60_000)

test('words typed in the window that name a model-unavailable option answer it with that label; other words go to the architect', async () => {
  const { s, d } = await unavailableModel('unavailable-typed')
  const second = d.options[1]!
  await s.typed('顺便看一下 README 里的用法说明是不是过时了')
  expect((await s.task()).decisions[d.id]!.resolvedAt).toBeUndefined()
  await s.typed(`那就${second}吧`)
  const after = (await s.task()).decisions[d.id]!
  expect([after.answer, after.via]).toEqual([second, 'window'])
  expect(s.passed[1]!.context!.some(line => line.includes(`The person's message below answers decision ${d.id} (model-unavailable:`) && line.includes(`with ${second}; it was carried out:`))).toBe(true)
  await s.feedback(2)
}, 180_000)

test('a Telegram reply answers a model-unavailable question once, with the person\'s words; the window dialog then only gets the line', async () => {
  const { s, d } = await unavailableModel('unavailable-telegram')
  await s.telegram(82, '先等等，我晚点再定用哪个模型', 'unclear', d.id)
  const after = (await s.task()).decisions[d.id]!
  expect([after.answer, after.via]).toEqual(['先等等，我晚点再定用哪个模型', 'telegram'])
  expect(s.passed[0]!.context!.some(line => line.includes(`Decision ${d.id} (model-unavailable:`) && line.includes('is resolved with the person\'s words below: the person answered "先等等，我晚点再定用哪个模型"'))).toBe(true)
  s.dialogs[0]!.answer(d.options[1]!)
  await until(() => s.shown.some(line => line.includes('这个问题已经')), 'the line about the earlier answer')
  expect(s.shown).toContain('这个问题已经在 Telegram 上按「先等等，我晚点再定用哪个模型」决定，这次回答没有再执行。')
  expect((await s.task()).decisions[d.id]!.answer).toBe('先等等，我晚点再定用哪个模型')
  expect(s.submitted).toEqual([])
  await s.feedback(1)
}, 120_000)

// ---- the interruption recovery asks about ------------------------------------------------------------

const AGENT_CALL = { tool: 'Agent', tool_use_id: 'toolu_01Interrupted', description: '统计行数', prompt: '统计 greet.py 的行数并报告', subagent_type: 'general-purpose' }

test('an open interruption refuses model_route, the Agent tool and integrate; 继续 in the window lets them through', async () => {
  const s = await scenario('interrupted', { decision: false })
  const now = await s.ctx.io.now()
  const d = interruptedDecision(await s.task(), `项目目录 ${s.project}/missing 不存在`, [], now - 2 * MIN, 'q-20261113-eee111')
  await s.reg.update(TASK, t => { t.state = 'waiting-user'; t.decisions[d.id] = d }, { type: 'decision', decision: d.id, kind: d.kind, during: 'recovery' })
  await resumeArchitectChannels(s.ctx)
  await until(() => s.dialogs.length === 1, 'the dialog')
  expect(s.dialogs[0]!.options).toEqual(['继续', '暂停'])
  expect(s.log().filter(e => e.type === 'ask').map(e => e['decision'])).toEqual([d.id])
  const refused = `waits for decision ${d.id} (interrupted: 项目目录 ${s.project}/missing 不存在). The task stays paused until the person answers it`
  await expect(architectTool(s.ctx, 'model_route', { description: '统计行数', prompt: '统计 greet.py 的行数并报告' })).rejects.toThrow(`Refused: Delegating with model_route ${refused}`)
  await expect(architectTool(s.ctx, 'integrate', {})).rejects.toThrow(`Refused: Integrating ${refused}`)
  const beneath: ToolCallInput[] = []
  const next = (async (e: ToolCallInput) => { beneath.push(e); return {} }) as unknown as Next<'tool.call'>
  const denied = await onArchitectToolCall(s.ctx, AGENT_CALL as unknown as ToolCallInput, next)
  expect(denied.deny).toContain(`Refused: Delegating with the Agent tool ${refused}`)
  expect(beneath).toEqual([])
  expect(await architectTool(s.ctx, 'task_status', {})).toContain(`- ${d.id} interrupted:`)
  // The question was asked two minutes ago: its Telegram send keeps the rest of the wait.
  s.advance(8 * MIN - 1000)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(s.curls()).toBe(0)
  s.dialogs[0]!.answer('继续')
  await until(() => s.submitted.length === 1, 'the architect\'s turn about the answer')
  const t = await s.task()
  expect([t.decisions[d.id]!.answer, t.decisions[d.id]!.via, t.state]).toEqual(['approve', 'window', 'running'])
  expect(s.submitted[0]).toContain('asks you to continue; the task runs again.')
  expect(await onArchitectToolCall(s.ctx, AGENT_CALL as unknown as ToolCallInput, next) as unknown).toEqual({})
  expect(beneath.length).toBe(1)
  expect(await architectTool(s.ctx, 'model_route', { description: '统计行数', prompt: '统计 greet.py 的行数并报告', tool_use_id: 'toolu_01RouteAfter' })).not.toContain('Refused')
  // Routed: its subagent waits for the PostToolBatch hook to start it.
  expect(s.st.routed.has('toolu_01RouteAfter')).toBe(true)
  expect(await architectTool(s.ctx, 'integrate', {})).toContain(s.project)
  s.advance(60 * MIN)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(s.curls()).toBe(0)
}, 120_000)

test('暂停 in the window keeps the task paused by the person', async () => {
  const s = await scenario('interrupted-pause', { decision: false })
  const d = interruptedDecision(await s.task(), '工作副本不存在', [], await s.ctx.io.now(), 'q-20261113-eee222')
  await s.reg.update(TASK, t => { t.state = 'waiting-user'; t.decisions[d.id] = d }, { type: 'decision', decision: d.id, kind: d.kind, during: 'recovery' })
  await resumeArchitectChannels(s.ctx)
  await until(() => s.dialogs.length === 1, 'the dialog')
  s.dialogs[0]!.answer('暂停')
  await until(() => s.submitted.length === 1, 'the architect\'s turn about the answer')
  const t = await s.task()
  expect([t.decisions[d.id]!.answer, t.state, t.pausedByUser]).toEqual(['reject', 'paused', true])
  expect(s.submitted[0]).toContain('the person keeps the task paused after the interruption')
}, 60_000)

// ---- the takeover's failure ---------------------------------------------------------------------------

test('a takeover claim that fails is shown in its window only: nothing goes to the task\'s Telegram chat', async () => {
  const s = await scenario('takeover-failed', { decision: false, messages: [{ role: 'user', content: [{ type: 'text', text: `[magpie-tasks takeover task=${TASK} claim=c-20261113-000000-abcdef]` }] }] })
  expect(await claimTakeover(s.ctx)).toBe('failed')
  expect((await s.task()).state).toBe('error')
  expect(s.shown.some(line => line.includes('接管认领失败') && line.includes(TASK))).toBe(true)
  expect(s.curls()).toBe(0)
}, 60_000)
