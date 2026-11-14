// Where a long task's questions and notices reach the person: the architect's window first, and
// Telegram too once nobody has answered there for `telegramAfterMinutes`. The plugin cannot tell
// whether anyone looks at a window (a `claude attach` in a herdr or tmux pane stays connected while
// the person is elsewhere, and `$.session.surfaces()` reads `terminal` either way), so every question
// is put in the window at once as a dialog with one notification, and time decides about Telegram.
// A turn a Telegram message started sends its questions and notices to both at once.
//
// The timers live in the architect's process. What they wait for is on the task record (a decision's
// `askedAt`, the `notices`), so a restarted session sends what is overdue at once and gives the rest
// its remaining time (resumeChannels).
import { newId } from './io'
import { notice, telegramReport } from './session'
import type { Ctx } from './state'
import { clip } from './telegram'
import type { Decision, Options, TaskRecord } from './types'

export type Via = NonNullable<Decision['via']>
// Where something went: the window alone (the task has no Telegram chat), the window with Telegram to
// follow when nobody answers, or both at once.
export type Route = 'window' | 'window-then-telegram' | 'both'

// How a decision's answer is read from free text (the answer, or 'unclear') and carried out;
// architect.ts supplies both.
export interface DecisionFlow {
  read(ctx: Ctx, decision: Decision, text: string): Promise<string>
  apply(ctx: Ctx, task: TaskRecord, decision: Decision, answer: string, via: Via): Promise<string>
}

export const SEPARATE = '单独副本'
export const WAIT = '等待前一方'
// The second option of a dialog whose question has one: `$.ui.ask` takes at least two.
const LATER = '稍后回答'

// The decisions asked as a dialog in the window: their answer is one of the question's options.
const WINDOW_KINDS: readonly Decision['kind'][] = ['file-conflict', 'integration-conflict', 'no-progress', 'fix-confirm', 'model-unavailable', 'interrupted']
const HEADER: Partial<Record<Decision['kind'], string>> = { 'file-conflict': '文件冲突', 'integration-conflict': '整合冲突', 'no-progress': '没有进展', 'fix-confirm': '返工结果', 'model-unavailable': '模型不可用', 'interrupted': '任务中断' }

// ---- pure parts -------------------------------------------------------------------------------

export function afterMs(opts: Pick<Options, 'telegramAfterMinutes'>): number {
  return opts.telegramAfterMinutes * 60_000
}

export function asksInWindow(d: Pick<Decision, 'kind'>): boolean {
  return WINDOW_KINDS.includes(d.kind)
}

// The open decision words typed in the window may answer: the one asked last.
export function openWindowDecision(task: TaskRecord): Decision | undefined {
  return Object.values(task.decisions)
    .filter(d => d.resolvedAt === undefined && asksInWindow(d))
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

// When something shown in the window at `askedAt` goes to Telegram: never (no chat, the terminal-only
// chat `tui`, or already sent), now (a turn a Telegram message started, or the wait is over), or
// after the rest of the wait.
export type Forward = { when: 'never' } | { when: 'now' } | { when: 'later'; inMs: number }
export function forwardWhen(a: { chatId: string | undefined; sent: boolean; telegramTurn: boolean; askedAt: number; now: number; afterMs: number }): Forward {
  if (a.chatId === undefined || a.chatId === 'tui' || a.sent) return { when: 'never' }
  if (a.telegramTurn) return { when: 'now' }
  const left = a.askedAt + a.afterMs - a.now
  return left <= 0 ? { when: 'now' } : { when: 'later', inMs: left }
}

export function windowOptions(d: Pick<Decision, 'options'>): string[] {
  return d.options.length >= 2 ? d.options.slice(0, 4) : [...d.options, LATER]
}

// The answer a dialog label stands for: `later` leaves the question open, null is free text typed
// under the dialog's Other, for the flow to read. A model-unavailable question's answer is what the
// person picked or wrote, as it stands (等待, 改用 <model>, or their words): the architect arranges it.
export function optionAnswer(d: Pick<Decision, 'kind' | 'options'>, label: string): string | 'later' | null {
  const i = d.options.indexOf(label)
  if (i < 0 && label === LATER && d.options.length < 2) return 'later'
  if (d.kind === 'model-unavailable') return label.trim() === '' ? null : label.trim()
  if (i < 0) return null
  if (d.kind === 'file-conflict') return label === SEPARATE ? 'separate' : label === WAIT ? 'wait' : null
  return i === 0 ? 'approve' : i === 1 ? 'reject' : null
}

// The option a resolved decision was answered with, as the person reads it.
export function answerLabel(d: Pick<Decision, 'kind' | 'options' | 'answer'>): string {
  const a = d.answer ?? ''
  if (d.kind === 'model-unavailable') return a
  if (d.kind === 'file-conflict') return a === 'separate' ? SEPARATE : a === 'wait' ? WAIT : a
  return a === 'approve' ? d.options[0] ?? a : a === 'reject' ? d.options[1] ?? a : a
}

// What a later answer to an already resolved decision gets, from either side.
export function decidedLine(d: Pick<Decision, 'kind' | 'options' | 'answer' | 'via'>): string {
  const where = d.via === 'telegram' ? '在 Telegram 上' : d.via === 'window' ? '在窗口里' : d.via === 'architect' ? '由架构师' : ''
  return `这个问题已经${where}按「${answerLabel(d)}」决定，这次回答没有再执行。`
}

export function routeNote(route: Route, opts: Pick<Options, 'telegramAfterMinutes'>): string {
  if (route === 'both') return 'The person was asked in the window and on Telegram.'
  if (route === 'window') return 'The person was asked in the window (the task has no Telegram chat).'
  return `The person was asked in the window; unanswered for ${opts.telegramAfterMinutes} minutes, the question goes to Telegram too.`
}

export interface PersonQuestion { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }

// The questions of an AskUserQuestion call, checked: the take-over shows each as a dialog of its own.
export function parseQuestions(raw: unknown): PersonQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('AskUserQuestion: questions must be a non-empty array')
  return raw.map((q: unknown, i: number) => {
    const o = q as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown }
    if (typeof q !== 'object' || q === null || typeof o.question !== 'string' || o.question.trim() === '') throw new Error(`AskUserQuestion: question ${i + 1} has no text`)
    if (!Array.isArray(o.options) || o.options.length < 2) throw new Error(`AskUserQuestion: question ${i + 1} needs at least two options`)
    const options = o.options.map((x: unknown, j: number) => {
      const p = x as { label?: unknown; description?: unknown }
      if (typeof x !== 'object' || x === null || typeof p.label !== 'string' || p.label === '') throw new Error(`AskUserQuestion: option ${j + 1} of question ${i + 1} has no label`)
      return { label: p.label, description: typeof p.description === 'string' ? p.description : '' }
    })
    return { question: o.question, header: typeof o.header === 'string' ? o.header : '', multiSelect: o.multiSelect === true, options }
  })
}

// The dialog's text: `$.ui.ask` draws option labels only, so what each option means goes under the question.
export function questionText(q: PersonQuestion): string {
  const explained = q.options.filter(o => o.description.trim() !== '')
  return explained.length === 0 ? q.question : `${q.question}\n${explained.map(o => `· ${o.label}：${o.description}`).join('\n')}`
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

function errorText(err: unknown): string {
  return firstLine(err instanceof Error ? err.message : String(err))
}

// ---- this process's state -----------------------------------------------------------------------

// Timers waiting to send something to Telegram, by decision or notice ID (and one for the architect's question).
const timers = new Map<string, { cancel: () => void }>()
// Decisions whose dialog this process has put in the window.
const raised = new Set<string>()
// Sends to Telegram under way, so a timer and a Telegram message arriving together send once.
const sending = new Set<string>()
// Answers to one decision run one after the other: the second finds it resolved.
const turns = new Map<string, Promise<unknown>>()
// Texts of this plugin's dialogs in flight: their own AskUserQuestion call is not taken over.
const own = new Map<string, number>()

interface PendingQuestion { text: string; forwarded: boolean; answer: (text: string) => void }
// The architect's question waiting in the window (one tool call asks one question at a time).
let pending: PendingQuestion | null = null

export function resetChannels(): void {
  for (const t of timers.values()) t.cancel()
  timers.clear()
  raised.clear()
  sending.clear()
  turns.clear()
  own.clear()
  pending = null
}

export function isOwnDialog(question: string): boolean {
  return own.has(question)
}

// Work that goes on after the hook that started it has returned (a dialog's answer, a timer): its
// failure stops that work and is reported in the window, the debug log and the task log.
function detached(ctx: Ctx, taskId: string, what: { zh: string; en: string }, work: Promise<unknown>): void {
  void work.catch(async (err: unknown) => {
    const line = errorText(err)
    notice(ctx, `magpie-tasks 出错（任务 ${taskId}）：${what.zh}失败：${line}`)
    await ctx.io.log(`channel error during ${what.en} (task ${taskId}): ${line}`)
    await ctx.reg.log(taskId, { type: 'error', during: what.en, error: line })
  }).catch((err: unknown) => notice(ctx, `magpie-tasks 出错（任务 ${taskId}）：没有记下${what.zh}的失败：${errorText(err)}`))
}

const DIALOG = { zh: '窗口提问', en: 'window dialog' }
const RING = { zh: '系统通知', en: 'window notification' }
const FORWARD = { zh: '转发到 Telegram ', en: 'telegram forward' }

async function taskOf(ctx: Ctx, taskId: string): Promise<TaskRecord> {
  const t = await ctx.reg.get(taskId)
  if (t === undefined) throw new Error(`task ${taskId} does not exist`)
  return t
}

function arm(ctx: Ctx, taskId: string, key: string, inMs: number, send: () => Promise<void>): void {
  timers.get(key)?.cancel()
  timers.set(key, ctx.host.clock.after(inMs, () => {
    timers.delete(key)
    detached(ctx, taskId, FORWARD, send())
  }))
}

function disarm(key: string): void {
  timers.get(key)?.cancel()
  timers.delete(key)
}

// The engine's AskUserQuestion dialog with `question`; null when the person closed it. `$.ui.ask`
// rejects with "no answer" for a closed dialog; any other rejection is an error.
async function dialog(ctx: Ctx, question: string, o: { options: string[]; header: string; multiSelect?: true }): Promise<string | null> {
  own.set(question, (own.get(question) ?? 0) + 1)
  try {
    return await ctx.host.ui.ask(question, { options: o.options, ...(o.header !== '' ? { header: Array.from(o.header).slice(0, 12).join('') } : {}), ...(o.multiSelect ? { multiSelect: true } : {}) })
  } catch (err) {
    if (/no answer/.test(err instanceof Error ? err.message : String(err))) return null
    throw err
  } finally {
    const n = (own.get(question) ?? 1) - 1
    if (n <= 0) own.delete(question)
    else own.set(question, n)
  }
}

// One native notification, so the multiplexer marks the window that waits; what became of it is logged.
async function ring(ctx: Ctx, taskId: string, text: string): Promise<void> {
  const r = await ctx.host.ui.notify(clip(text, 200), { title: 'magpie-tasks' })
  await ctx.reg.log(taskId, { type: 'window-notify', sent: r.isSent, ...(r.isSent ? { channel: r.channel } : { reason: r.reason }) })
}

// ---- decisions ------------------------------------------------------------------------------------

// Puts a decision in the window as a dialog, with one notification, and sends it to Telegram when
// forwardWhen says so: at once in a turn a Telegram message started (a failed send fails the caller,
// whose result the person reads there), at once behind the hook when its wait is already over (a
// restarted session: a failed send is reported like a timer's and the dialog stays), else after the
// rest of the wait. Answers where it went.
export async function askInWindow(ctx: Ctx, flow: DecisionFlow, taskId: string, decisionId: string): Promise<Route> {
  const now = await ctx.io.now()
  const task = await ctx.reg.update(taskId, t => {
    const x = t.decisions[decisionId]
    if (x === undefined) throw new Error(`decision ${decisionId} does not exist in task ${taskId}`)
    if (x.askedAt === undefined) x.askedAt = now
  }, { type: 'ask', decision: decisionId, channel: 'window' })
  const d = task.decisions[decisionId]!
  const telegramTurn = ctx.st.replyTargets.length > 0
  const fw = forwardWhen({ chatId: task.telegram?.chatId, sent: d.telegram !== undefined, telegramTurn, askedAt: d.askedAt!, now, afterMs: afterMs(ctx.opts) })
  if (!raised.has(decisionId)) {
    raised.add(decisionId)
    detached(ctx, taskId, DIALOG, windowDialog(ctx, flow, taskId, d))
    detached(ctx, taskId, RING, ring(ctx, taskId, firstLine(d.question)))
  }
  if (fw.when === 'now' && telegramTurn) await forwardDecision(ctx, taskId, decisionId, 'telegram-turn')
  else if (fw.when === 'now') detached(ctx, taskId, FORWARD, forwardDecision(ctx, taskId, decisionId, 'overdue'))
  if (fw.when === 'later') arm(ctx, taskId, decisionId, fw.inMs, () => forwardDecision(ctx, taskId, decisionId, 'unanswered'))
  return fw.when === 'now' || d.telegram !== undefined ? 'both' : fw.when === 'later' ? 'window-then-telegram' : 'window'
}

async function forwardDecision(ctx: Ctx, taskId: string, decisionId: string, why: string): Promise<void> {
  if (sending.has(decisionId)) return
  sending.add(decisionId)
  try {
    const task = await taskOf(ctx, taskId)
    const d = task.decisions[decisionId]
    const chatId = task.telegram?.chatId
    if (d === undefined || d.resolvedAt !== undefined || d.telegram !== undefined || chatId === undefined || chatId === 'tui') return
    const messageId = await telegramReport(ctx, task, `${d.question}\n回复：${d.options.join(' / ')}`, { decisionId })
    if (messageId === null) throw new Error(`decision ${decisionId} was not sent to chat ${chatId}`)
    await ctx.reg.update(taskId, t => { const x = t.decisions[decisionId]; if (x !== undefined) x.telegram = { chatId, messageId } }, { type: 'telegram', decision: decisionId, messageId, why })
  } finally {
    sending.delete(decisionId)
  }
}

// The dialog of one decision, from the moment it is put in the window to the person's answer.
async function windowDialog(ctx: Ctx, flow: DecisionFlow, taskId: string, d: Decision): Promise<void> {
  const label = await dialog(ctx, d.question, { options: windowOptions(d), header: HEADER[d.kind] ?? '' })
  const current = (await taskOf(ctx, taskId)).decisions[d.id]
  if (current === undefined) throw new Error(`decision ${d.id} does not exist in task ${taskId}`)
  // The plugin cannot close a dialog: one left open after the other side answered only gets this line.
  if (current.resolvedAt !== undefined) return notice(ctx, decidedLine(current))
  const picked = label === null ? 'later' : optionAnswer(d, label)
  if (picked === 'later') {
    const wait = timers.has(d.id) ? `；${ctx.opts.telegramAfterMinutes} 分钟内没有回答，它会发到 Telegram` : ''
    return notice(ctx, `问题还没有回答（${firstLine(d.question)}）。直接在窗口里输入你的回答即可：${d.options.join(' / ')}${wait}。`)
  }
  await personActed(ctx, taskId, 'window')
  const answer = picked ?? await flow.read(ctx, d, label!)
  if (answer === 'unclear') return notice(ctx, `没有读出你的选择（${clip(label!, 80)}）。直接在窗口里输入你的回答：${d.options.join(' / ')}。`)
  const r = await answerDecision(ctx, flow, taskId, d.id, answer, 'window')
  if ('already' in r) return notice(ctx, decidedLine(r.already))
  // The architect reads what the answer led to in a turn of its own.
  await ctx.host.prompt.submit({ text: `[magpie-tasks] The person answered decision ${d.id} (${d.kind}) in the window: ${label}. It was carried out: ${r.result}` })
}

// Carries out the answer to a decision unless it is resolved already. Both sides and the architect's
// resolve_conflict come through here, one at a time per decision, so one answer is carried out.
export async function answerDecision(ctx: Ctx, flow: DecisionFlow, taskId: string, decisionId: string, answer: string, via: Via): Promise<{ result: string } | { already: Decision }> {
  const before = turns.get(decisionId) ?? Promise.resolve()
  const mine = before.then(() => undefined, () => undefined).then(async () => {
    const task = await taskOf(ctx, taskId)
    const d = task.decisions[decisionId]
    if (d === undefined) throw new Error(`decision ${decisionId} does not exist in task ${taskId}`)
    if (d.resolvedAt !== undefined) return { already: d }
    const result = await flow.apply(ctx, task, d, answer, via)
    disarm(decisionId)
    return { result }
  })
  turns.set(decisionId, mine)
  try {
    return await mine
  } finally {
    if (turns.get(decisionId) === mine) turns.delete(decisionId)
  }
}

// ---- notices --------------------------------------------------------------------------------------

// A notice of a long task (notify_user, the plugin's own notes): in the window at once, with one
// notification; on Telegram too at once in a turn a Telegram message started, else once the person
// has sent this session nothing for the wait. `telegramTurn` is for the end of a turn, whose reply
// targets were already taken.
export async function showNotice(ctx: Ctx, task: TaskRecord, text: string, o: { telegramTurn?: boolean } = {}): Promise<Route> {
  const now = await ctx.io.now()
  const fw = forwardWhen({ chatId: task.telegram?.chatId, sent: false, telegramTurn: o.telegramTurn ?? ctx.st.replyTargets.length > 0, askedAt: now, now, afterMs: afterMs(ctx.opts) })
  notice(ctx, text)
  detached(ctx, task.id, RING, ring(ctx, task.id, firstLine(text)))
  if (fw.when === 'now') {
    const messageId = await telegramReport(ctx, task, text)
    await ctx.reg.log(task.id, { type: 'telegram', notice: 'at-once', messageId, why: 'telegram-turn' })
  }
  if (fw.when !== 'later') return fw.when === 'now' ? 'both' : 'window'
  const id = newId('n', now)
  await ctx.reg.update(task.id, t => { (t.notices ??= {})[id] = { id, at: now, text } }, { type: 'notice', id, channel: 'window' })
  arm(ctx, task.id, id, fw.inMs, () => forwardNotice(ctx, task.id, id, 'unanswered'))
  return 'window-then-telegram'
}

async function forwardNotice(ctx: Ctx, taskId: string, id: string, why: string): Promise<void> {
  if (sending.has(id)) return
  sending.add(id)
  try {
    const task = await taskOf(ctx, taskId)
    const n = task.notices?.[id]
    if (n === undefined) return
    const messageId = await telegramReport(ctx, task, n.text)
    await ctx.reg.update(taskId, t => { if (t.notices !== undefined) delete t.notices[id] }, { type: 'telegram', notice: id, messageId, why })
  } finally {
    sending.delete(id)
  }
}

// The person sent this session something. From the window they have seen its notices, which stay off
// Telegram; from Telegram they are there now, so the notices still waiting go there at once.
export async function personActed(ctx: Ctx, taskId: string, where: 'window' | 'telegram'): Promise<void> {
  const ids = Object.keys((await taskOf(ctx, taskId)).notices ?? {})
  if (ids.length === 0) return
  for (const id of ids) disarm(id)
  if (where === 'telegram') {
    for (const id of ids) await forwardNotice(ctx, taskId, id, 'telegram-message')
    return
  }
  await ctx.reg.update(taskId, t => { for (const id of ids) if (t.notices !== undefined) delete t.notices[id] }, { type: 'notice-seen', ids })
}

// ---- after a restart ------------------------------------------------------------------------------

// The architect session started with open questions or notices on its task (a restart, a takeover's
// copy, a promoted daily task's question): each open question gets its dialog again; what has waited
// its time goes to Telegram at once (behind the hook, a failed send reported like a timer's) and the
// rest keeps its remaining time.
export async function resumeChannels(ctx: Ctx, flow: DecisionFlow, taskId: string): Promise<void> {
  const task = await taskOf(ctx, taskId)
  for (const d of Object.values(task.decisions)) {
    if (d.resolvedAt === undefined && asksInWindow(d)) await askInWindow(ctx, flow, taskId, d.id)
  }
  const now = await ctx.io.now()
  for (const n of Object.values(task.notices ?? {})) {
    const fw = forwardWhen({ chatId: task.telegram?.chatId, sent: false, telegramTurn: false, askedAt: n.at, now, afterMs: afterMs(ctx.opts) })
    if (fw.when === 'now') detached(ctx, taskId, FORWARD, forwardNotice(ctx, taskId, n.id, 'overdue'))
    else if (fw.when === 'later') arm(ctx, taskId, n.id, fw.inMs, () => forwardNotice(ctx, taskId, n.id, 'unanswered'))
  }
}

// ---- the architect's own questions ------------------------------------------------------------------

const QUESTION_KEY = 'architect-question'

// The AskUserQuestion call of the architect's main conversation, taken over: each question is a
// dialog in the window with one notification, goes to Telegram like a decision, and the first answer
// from either side is the tool's result. A closed dialog ends the call as the person's refusal.
export async function architectQuestions(ctx: Ctx, task: TaskRecord, raw: unknown): Promise<{ result: { questions: unknown; answers: Record<string, string> }; context?: string[] } | { deny: string }> {
  const answers: Record<string, string> = {}
  let onTelegram = false
  for (const q of parseQuestions(raw)) {
    const a = await architectQuestion(ctx, task, q)
    if (a.via === 'closed') return { deny: 'The person closed the question in the window without answering it. Go on without that answer, or say in your answer what you need from them.' }
    answers[q.question] = a.text
    if (a.via === 'telegram') onTelegram = true
  }
  return {
    result: { questions: raw, answers },
    ...(onTelegram ? { context: ['[magpie-tasks] The person answered on Telegram. Your final answer of this turn is sent back there as plain text: lead with the conclusion and use no Markdown markup.'] } : {}),
  }
}

async function architectQuestion(ctx: Ctx, task: TaskRecord, q: PersonQuestion): Promise<{ via: 'window' | 'telegram'; text: string } | { via: 'closed' }> {
  const now = await ctx.io.now()
  const labels = q.options.map(o => o.label)
  let settle!: (text: string) => void
  const telegram = new Promise<{ via: 'telegram'; text: string }>(resolve => { settle = text => resolve({ via: 'telegram', text }) })
  const me: PendingQuestion = { text: `长期任务「${task.title}」（${task.id}）的架构师问：\n${questionText(q)}\n回复：${labels.join(' / ')}，或直接写你的回答`, forwarded: false, answer: settle }
  await ctx.reg.log(task.id, { type: 'ask', question: clip(q.question, 200), channel: 'window' })
  const telegramTurn = ctx.st.replyTargets.length > 0
  const fw = forwardWhen({ chatId: task.telegram?.chatId, sent: false, telegramTurn, askedAt: now, now, afterMs: afterMs(ctx.opts) })
  pending = me
  try {
    if (fw.when === 'now') await forwardQuestion(ctx, task.id, me, 'telegram-turn')
    const window = dialog(ctx, questionText(q), { options: labels, header: q.header, ...(q.multiSelect ? { multiSelect: true as const } : {}) })
      .then(label => (label === null ? { via: 'closed' as const } : { via: 'window' as const, text: label }))
    detached(ctx, task.id, RING, ring(ctx, task.id, q.question))
    if (fw.when === 'later') arm(ctx, task.id, QUESTION_KEY, fw.inMs, () => forwardQuestion(ctx, task.id, me, 'unanswered'))
    const first = await Promise.race([window, telegram])
    if (first.via === 'telegram') {
      // The dialog stays open (the plugin cannot close it); what the person does with it later gets a line.
      detached(ctx, task.id, DIALOG, window.then(() => notice(ctx, `这个问题已经在 Telegram 上回答（${clip(first.text, 80)}），窗口里的这次回答没有再交给架构师。`)))
    } else {
      await personActed(ctx, task.id, 'window')
    }
    await ctx.reg.log(task.id, { type: 'answer', question: clip(q.question, 200), via: first.via })
    return first
  } finally {
    disarm(QUESTION_KEY)
    if (pending === me) pending = null
  }
}

async function forwardQuestion(ctx: Ctx, taskId: string, me: PendingQuestion, why: string): Promise<void> {
  if (pending !== me || me.forwarded || sending.has(QUESTION_KEY)) return
  sending.add(QUESTION_KEY)
  try {
    const messageId = await telegramReport(ctx, await taskOf(ctx, taskId), me.text)
    // Only a question that reached Telegram is answered by a message from there.
    me.forwarded = true
    await ctx.reg.log(taskId, { type: 'telegram', question: true, messageId, why })
  } finally {
    sending.delete(QUESTION_KEY)
  }
}

// A Telegram message reached the architect session while its question waits. Once the question is on
// Telegram the message is its answer (the architect reads nothing else until the question is answered):
// true, and the caller takes the message out of the queue. A message that came before the question
// went there sends it at once, since the person is on Telegram now, and goes on to the queue.
export async function questionFromTelegram(ctx: Ctx, taskId: string, body: string, tg: { chatId: string; messageId: number }): Promise<boolean> {
  const p = pending
  if (p === null) return false
  if (!p.forwarded) {
    disarm(QUESTION_KEY)
    detached(ctx, taskId, FORWARD, forwardQuestion(ctx, taskId, p, 'telegram-message'))
    return false
  }
  const at = await ctx.io.now()
  await ctx.reg.update(taskId, t => { t.followUps.push({ at, source: 'telegram', text: body }) }, { type: 'follow-up', source: 'telegram', answers: 'architect-question', messageId: tg.messageId })
  // The turn's answer goes back under the person's reply.
  ctx.st.replyTargets.push(tg)
  await personActed(ctx, taskId, 'telegram')
  p.answer(body)
  return true
}
