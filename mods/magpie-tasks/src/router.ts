// The Router role (plan section 9.12): the claude-telegram session. magpie-tasks sits inside
// tg-router; tg-router routes replies to its own messages and hands the rest on. Here: replies to the
// messages magpie-tasks indexed (long tasks go to their architect session, daily-task follow-ups to
// the task's current executor, decision answers to whichever session carries the decision out,
// scores to the task record), the long-task list beside every message, the Router tools
// (forward_long, recommend_architect, promote_task), and the follow-ups tg-router sends to its
// workers, recorded as the person's feedback.
import type { Next, PromptSubmitInput, SessionSendInput, SessionSendResult } from 'claude-code'
import { parseRating } from './calibration'
import { applyDailyDecision, askDecision, openDailyDecision, tell, withOutcome } from './daily'
import { CONFLICT_CHOICE, choose, MODEL_OPINION_QUESTION, predicate, recommendArchitect, UNSUITABLE_QUESTION } from './judge'
import { launchArchitect, listAgents, resumeSession } from './launch'
import { displayName, sameModel } from './model'
import { architectFirstMessage, judgeCtxOf } from './session'
import type { Ctx, PromptResult } from './state'
import { clip, defaultChat, parseChannelTag, send } from './telegram'
import type { RouterToolName } from './tools'
import type { Decision, JevJudgment, TaskRecord, TelegramIndex } from './types'
import type { Rules } from './rules'
import { workspaceOf } from './workspace'

type LongAnswer = 'separate' | 'wait' | 'approve' | 'reject' | 'unclear'
type Tg = { chatId: string; messageId: number }
type Recommendation = { model: string; reason: string; limits: string; judgment: JevJudgment | null }

// tg-router's follow-up format (mods/tg-router/src/prompts.ts `followUp`): Telegram or terminal.
const FOLLOW_UP = /^(?:Telegram|终端) 追问（message_id=(\d+)）：\n([\s\S]*)$/
// The reason a follow-up's send is refused with when magpie-tasks took the words as the person's answer
// to the task's open decision; tg-router (src/magpie.ts DECISION_HANDLED) reads it as handled, not lost.
export const DECISION_HANDLED = 'magpie-tasks answered a decision: '
// The context entry tg-router adds when it hands one of its own task's replies on: the worker name.
const WORKER_HINT = /^\[tg-router worker=([^\]\s]+)\]$/
// The context entry tg-router adds beside a message typed in this terminal: the message_id it gave it.
const TERMINAL_HINT = /^\[tg-router terminal message_id=(\d+)\]$/
const TERMINAL_CHAT = 'tui'
const OPEN: readonly TaskRecord['state'][] = ['starting', 'running', 'paused', 'waiting-user', 'error']
// States of a daily task that the person's words to its agent set running again.
const RESUMED: readonly TaskRecord['state'][] = ['paused', 'waiting-user', 'done']
const REMEMBERED = 200

const APPROVE = {
  instructions: 'How does the person answer the question in the previous message: approve what it proposes (go on, apply, accept), reject it, or neither?',
  choices: [
    { value: 'approve', description: 'Approves, agrees, or asks to go on (继续, 整合, 接受, 同意)' },
    { value: 'reject', description: 'Rejects or declines (不整合, 不接受, 不同意, 暂停)' },
    { value: 'unclear', description: 'Neither, or cannot be read as a yes or no' },
  ],
}

// Messages this Router received, by `chat:message`, for forward_long: channel messages, and messages
// typed in its terminal under chat 'tui' and the message_id tg-router gave them.
const received = new Map<string, { chatId: string; messageId: number; text: string }>()
// recommend_architect's answer per task, so promote_task records what the person was shown.
const recommendations = new Map<string, Recommendation>()

// ---- pure parts ------------------------------------------------------------------------------

export type ReplyRoute =
  | { to: 'architect'; taskId: string }
  | { to: 'architect-decision'; taskId: string; decisionId: string }
  | { to: 'executor'; taskId: string }
  | { to: 'daily-decision'; taskId: string; decisionId: string }
  | { to: 'rating'; taskId: string; score: number }
  | { to: 'rating-other'; taskId: string }      // a reply to an invitation that is not a score
  | { to: 'rating-no-task' }                    // `评分 N` that names no task of the index
  | { to: 'router' }

// Where a channel message goes, from the index entry of the message it replies to, its text, and
// the worker tg-router named when the reply was to one of its own messages.
export function replyRoute(index: TelegramIndex, tag: { chatId: string; replyTo?: number }, body: string, worker: string | null): ReplyRoute {
  const entry = tag.replyTo === undefined ? undefined : index.messages[`${tag.chatId}:${tag.replyTo}`]
  const byWorker = worker === null ? undefined : index.workers[worker]
  const score = parseRating(body, entry?.kind)
  if (score !== null) {
    const taskId = entry?.taskId ?? byWorker?.taskId
    return taskId === undefined ? { to: 'rating-no-task' } : { to: 'rating', taskId, score }
  }
  if (entry !== undefined) {
    switch (entry.kind) {
      case 'long': return entry.decisionId === undefined ? { to: 'architect', taskId: entry.taskId } : { to: 'architect-decision', taskId: entry.taskId, decisionId: entry.decisionId }
      case 'magpie': return { to: 'executor', taskId: entry.taskId }
      case 'decision':
        if (entry.decisionId === undefined) throw new Error(`Telegram index: message ${tag.chatId}:${tag.replyTo} is a decision without decisionId`)
        return { to: 'daily-decision', taskId: entry.taskId, decisionId: entry.decisionId }
      case 'rating': return { to: 'rating-other', taskId: entry.taskId }
    }
  }
  if (byWorker !== undefined && byWorker.long) return { to: 'architect', taskId: byWorker.taskId }
  return { to: 'router' }
}

export function workerHint(context: readonly string[] | undefined): string | null {
  for (const c of context ?? []) {
    const m = WORKER_HINT.exec(c.trim())
    if (m) return m[1]!
  }
  return null
}

// The message_id tg-router gave a message typed in this terminal, from the context it added.
export function terminalHint(context: readonly string[] | undefined): number | null {
  for (const c of context ?? []) {
    const m = TERMINAL_HINT.exec(c.trim())
    if (m) return Number(m[1])
  }
  return null
}

// What the architect receives for the person's answer to a decision. An approved 'interrupted'
// decision carries the message that did not arrive (its `data.message`), so the architect reads it
// together with the person's reply.
export function decisionDelivery(decision: Decision, answer: LongAnswer, reply: string): string {
  const original = decision.kind === 'interrupted' && answer === 'approve' ? decision.data['message'] : undefined
  if (original === undefined) return reply
  return `${original}\n\n[magpie-tasks] The message above did not reach you earlier; the person checked the interruption and replied: ${reply}`
}

// Whether promote_task may turn the task into a long one: a daily task still run by its executor.
export function promotable(task: TaskRecord): boolean {
  return task.kind === 'daily' && task.owner.kind === 'agent'
}

// Undoes a promotion whose architect did not start: the task is a daily task of its executor again,
// stopped on the error (launchArchitect may have set the state already, with its own reason).
export function demoteAfterFailedLaunch(t: TaskRecord, error: string): void {
  t.kind = 'daily'
  delete t.architect
  if (t.state !== 'error') {
    t.state = 'error'
    t.error = `promotion failed: ${error}`
  }
}

// What the architect session receives (section 9.12): the hand-over marker as the first line (none
// for a message typed in the Router's terminal), then the message.
export function architectText(text: string, tg: Tg | null, decision?: { id: string; answer: LongAnswer }): string {
  if (tg === null) return text
  const mark = `[magpie-tasks telegram chat=${tg.chatId} message=${tg.messageId}${decision ? ` decision=${decision.id} answer=${decision.answer}` : ''}]`
  return `${mark}\n${text}`
}

// The person's words in one of tg-router's follow-ups (`Telegram 追问（message_id=N）：` and the
// channel message it carries, tag included), or null for another text.
export function followUpBody(text: string): { messageId: number; body: string } | null {
  const m = FOLLOW_UP.exec(text)
  if (!m) return null
  const tag = parseChannelTag(m[2]!)
  return { messageId: Number(m[1]), body: tag === null ? m[2]!.trim() : channelText(tag) }
}

// A channel message without its tag: the text, and the photo's path on a line of its own.
export function channelText(tag: { body: string; imagePath?: string }): string {
  return tag.imagePath === undefined ? tag.body : `${tag.body}\nimage_path: ${tag.imagePath}`
}

function minutesAgo(at: number, now: number): number {
  return Math.max(0, Math.round((now - at) / 60_000))
}

// The context beside each channel or terminal message the Router reads (English, as the model reads it).
export function routerContext(longTasks: TaskRecord[], now: number, rules: Rules): string {
  const ids = Object.entries(rules.models).map(([id, m]) => `${id} (${m.name})`).join(', ')
  const list = longTasks.length === 0
    ? '(none)'
    : longTasks.map(t => `- ${t.id} "${t.title}": architect ${t.architect?.model ?? (t.owner.kind === 'session' ? t.owner.model : 'unknown')}, ${t.state}, last activity ${minutesAgo(t.updatedAt, now)} min ago`).join('\n')
  return `[magpie-tasks] Long tasks, each led by an architect in its own background session (you never work on them yourself):
${list}
- A message that continues one of these long tasks (it names the task or plainly carries on its discussion) and does not reply to one of its messages: call mcp__magpie-tasks__forward_long with its chat_id, its message_id and the task ID. The host delivers it to the architect and tells the person; do not dispatch it. A message typed in this terminal uses chat_id "tui". When it is unclear which long task the message belongs to, ask the person in one sentence.
- When a daily task's worker reports that its work needs sustained design discussion over many turns, or the person asks to keep designing a daily task with an architect, call mcp__magpie-tasks__recommend_architect with the worker name, tell the person the recommended architect model with its reason and evidence limits, and once the person confirms a model, call mcp__magpie-tasks__promote_task with the worker name, the confirmed model and the person's words of confirmation.
- When the person explicitly asks for a particular model for a request, call mcp__tg-router__dispatch with model set to that model's Magpie ID and model_reason set to the person's own words asking for it. The Magpie IDs: ${ids}. Otherwise leave both out: the routing rules choose the model.`
}

// The hand-over an architect starts from when a daily task becomes a long one (section 9.12 step 3).
export function promotionBrief(task: TaskRecord, a: { worker: string; confirmation: string }): string {
  const lines = [
    `This long task was promoted from daily Telegram task ${task.id} (worker ${a.worker}). The person confirmed the architect with these words: "${a.confirmation}"`,
    '',
    'The original request:',
    task.request,
  ]
  if (task.followUps.length > 0) {
    lines.push('', 'Follow-ups from the person, in order:')
    for (const f of task.followUps) lines.push(`- (${f.source}) ${f.text}`)
  }
  const agents = Object.values(task.agents).sort((x, y) => x.startedAt - y.startedAt)
  if (agents.length > 0) {
    lines.push('', 'Agents of the daily task and their reports:')
    for (const ag of agents) {
      lines.push(`- ${ag.name ?? ag.agentId} (${ag.agentId}): ${ag.role}, rule ${ag.ruleId ?? 'none'}, ${ag.model}/${ag.effort}, ${ag.state}${ag.replacedBy ? `, replaced by ${ag.replacedBy}` : ''}`)
      for (const r of ag.reports) {
        lines.push(`  report (${r.status}): ${clip(r.text.trim(), 1500)}`)
        if (r.verification.length > 0) lines.push(`  verification: ${r.verification.join('; ')}`)
      }
    }
  }
  const checks = task.deliverables.filter(d => d.acceptance !== undefined || d.integration !== undefined)
  const blockers = Object.values(task.blockers)
  if (checks.length > 0 || blockers.length > 0) {
    lines.push('', 'Acceptance, integration and diagnosis:')
    for (const d of checks) {
      if (d.acceptance) lines.push(`- acceptance by ${d.acceptance.agentId}: ${d.acceptance.pass ? 'passed' : 'failed'}; ${clip(d.acceptance.notes.trim(), 800)}`)
      if (d.integration) lines.push(`- integration: ${d.integration.status}${d.integration.files.length ? ` (${d.integration.files.join(', ')})` : ''}`)
    }
    for (const b of blockers) {
      lines.push(`- blocker ${b.id} "${b.description}": diagnoses ${b.diagnoses}, model changes ${b.modelChanges}`)
      for (const h of b.history) lines.push(`  ${h.step} (${h.agentId}): ${h.note}`)
    }
  }
  lines.push('', task.direct != null
    ? `The task works directly in the project directory ${task.direct.dir}; its subagents keep working there.`
    : task.worktree !== null
      ? `Task worktree: ${task.worktree.path}`
      : 'The task has no project yet: no project was named. Once the person names the project, delegate the work there; magpie-tasks gives the task its working directory.')
  const decisions = Object.values(task.decisions)
  const settled = decisions.filter(d => d.resolvedAt !== undefined)
  const open = decisions.filter(d => d.resolvedAt === undefined)
  if (settled.length > 0) {
    lines.push('', 'Settled with the person:')
    for (const d of settled) lines.push(`- ${d.kind}: ${d.question} → ${d.answer ?? ''}`)
  }
  if (open.length > 0) {
    lines.push('', 'Still open (their Telegram replies now come to you):')
    for (const d of open) lines.push(`- ${d.id} ${d.kind}: ${d.question} (options: ${d.options.join(' / ')})`)
  }
  return lines.join('\n')
}

// ---- helpers ---------------------------------------------------------------------------------

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

async function taskOrThrow(ctx: Ctx, id: string): Promise<TaskRecord> {
  const t = await ctx.reg.get(id)
  if (t === undefined) throw new Error(`task ${id} does not exist`)
  return t
}

function remember(value: { chatId: string; messageId: number; text: string }): void {
  const key = `${value.chatId}:${value.messageId}`
  received.delete(key)
  received.set(key, value)
  while (received.size > REMEMBERED) received.delete(received.keys().next().value!)
}

function errorLine(err: unknown): string {
  return firstLine(err instanceof Error ? err.message : String(err))
}

async function home(ctx: Ctx): Promise<string> {
  const h = await ctx.io.env('HOME')
  if (h === undefined || h === '') throw new Error('HOME is not set')
  return h
}

// A reply under the person's message; indexed so a reply to it routes like the message it answers.
async function replyNote(ctx: Ctx, task: TaskRecord, tg: Tg, text: string, entry: TelegramIndex['messages'][string], notify = false): Promise<number> {
  const messageId = await send(ctx.io, ctx.opts, tg.chatId, text, tg.messageId, notify)
  await ctx.reg.updateIndex(x => { x.messages[`${tg.chatId}:${messageId}`] = entry })
  await ctx.reg.log(task.id, { type: 'telegram', chatId: tg.chatId, messageId, replyTo: tg.messageId, kind: entry.kind })
  return messageId
}

// The person's words to a task: a follow-up. Words that go on to a daily task's agent set the task
// running again (from an error, a pause, a wait or done), so the reclaim sweep leaves its worktree
// alone while the agent works; an answer to a decision leaves the state to the decision.
async function recordFollowUp(ctx: Ctx, taskId: string, text: string, judge: boolean, resumes = true): Promise<void> {
  const at = await ctx.io.now()
  const before = await taskOrThrow(ctx, taskId)
  const wakes = resumes && (before.state === 'error' || (before.kind === 'daily' && RESUMED.includes(before.state)))
  await ctx.reg.update(taskId, t => {
    t.followUps.push({ at, source: 'telegram', text })
    if (wakes) {
      t.state = 'running'
      t.pausedByUser = false
    }
  }, wakes ? { type: 'state', from: before.state, to: 'running', source: 'telegram' } : { type: 'follow-up', source: 'telegram' })
  if (judge) {
    // Runs after the message has gone on, outside any hook's error handling: whatever the report of
    // a failure throws itself is left in the transcript and the debug log.
    void judgeFeedback(ctx, taskId, text, at).catch((err: unknown) => {
      const line = `magpie-tasks 出错（任务 ${taskId}）：反馈记录失败：${errorLine(err)}`
      ctx.host.ui.log(line)
      ctx.host.ui.log(line, { to: 'debug' })
    })
  }
}

// Section 9.14 feedback, judged after the message has gone on; a failed judgment keeps the words with
// null judgments and is reported like a flow error (section 8): debug log, task log, transcript line
// and a Telegram notice. The task keeps its state: the message itself went on.
async function judgeFeedback(ctx: Ctx, taskId: string, text: string, at: number): Promise<void> {
  const input = [{ role: 'user' as const, content: text }]
  let judged: [Awaited<ReturnType<typeof predicate>>, Awaited<ReturnType<typeof predicate>>]
  try {
    const jc = judgeCtxOf(ctx)
    judged = await Promise.all([predicate(jc, UNSUITABLE_QUESTION, input), predicate(jc, MODEL_OPINION_QUESTION, input)])
  } catch (err) {
    const line = errorLine(err)
    const task = await ctx.reg.update(taskId, t => { t.feedback.push({ at, source: 'telegram', text, unsuitable: null, modelOpinion: null }) }, { type: 'error', during: 'feedback', error: line })
    const report = `magpie-tasks 出错（任务 ${taskId}）：反馈判断失败：${line}`
    await ctx.io.log(report)
    ctx.host.ui.log(report)
    const chatId = task.telegram !== null && task.telegram.chatId !== TERMINAL_CHAT ? task.telegram.chatId : await defaultChat(ctx.io, ctx.opts)
    await send(ctx.io, ctx.opts, chatId, `magpie-tasks 出错：任务「${task.title}」（${task.id}）的反馈判断失败：${line}。这条消息已经交出，反馈记为未判断。`, task.telegram?.rootMessageId, true)
    return
  }
  const [unsuitable, opinion] = judged
  await ctx.reg.update(taskId, t => { t.feedback.push({ at, source: 'telegram', text, unsuitable: unsuitable.yes, modelOpinion: opinion.yes }) }, { type: 'feedback', source: 'telegram', unsuitable: unsuitable.p, modelOpinion: opinion.p, provider: unsuitable.provider })
}

// The person's answer to a long task's decision, as the hand-over marker carries it. Model choices
// are left to the architect, who reads the person's words.
async function longAnswer(ctx: Ctx, decision: Decision, text: string): Promise<LongAnswer> {
  const input = [{ role: 'assistant' as const, content: `${decision.question}\n${decision.options.join(' / ')}` }, { role: 'user' as const, content: text }]
  switch (decision.kind) {
    case 'file-conflict':
      return (await choose(judgeCtxOf(ctx), CONFLICT_CHOICE.instructions, CONFLICT_CHOICE.choices, input)).choice as LongAnswer
    case 'integration-conflict':
    case 'fix-confirm':
    case 'no-progress':
    case 'interrupted':
      return (await choose(judgeCtxOf(ctx), APPROVE.instructions, APPROVE.choices, input)).choice as LongAnswer
    case 'model-unavailable':
    case 'model-change-confirm':
    case 'route-confirm':
      return 'unclear'
  }
}

async function withContext(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult> {
  const longTasks = await ctx.reg.list(t => t.kind === 'long' && OPEN.includes(t.state))
  return next({ ...e, context: [...(e.context ?? []), routerContext(longTasks, await ctx.io.now(), ctx.rules)] })
}

// ---- the Router's prompts --------------------------------------------------------------------

// Every prompt of the Router session goes through here: replies to magpie-tasks' messages, then the
// long-task context.
export async function onRouterPrompt(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult> {
  if (e.command !== undefined) return next(e)
  const o = e.origin
  if (o.kind === 'composer' || o.kind === 'bridge') {
    const messageId = terminalHint(e.context)
    if (messageId !== null) remember({ chatId: TERMINAL_CHAT, messageId, text: e.text })
    return withContext(ctx, e, next)
  }
  const handedBack = o.kind === 'plugin' && o.name === 'tg-router'
  if (o.kind !== 'channel' && !handedBack) return next(e)
  const tag = parseChannelTag(e.text)
  if (tag === null) return next(e)
  remember({ chatId: tag.chatId, messageId: tag.messageId, text: channelText(tag) })
  // A follow-up a worker handed back is the Router's to place, never back to where it replied.
  if (handedBack) return withContext(ctx, e, next)

  const tg: Tg = { chatId: tag.chatId, messageId: tag.messageId }
  const route = replyRoute(await ctx.reg.readIndex(), tag, tag.body, workerHint(e.context))
  await ctx.io.log(`router reply ${tag.chatId}:${tag.messageId} → ${route.to}${'taskId' in route ? ` ${route.taskId}` : ''}`)
  switch (route.to) {
    case 'router':
      return withContext(ctx, e, next)
    case 'architect': {
      const task = await taskOrThrow(ctx, route.taskId)
      const r = await deliverToArchitect(ctx, task, channelText(tag), tg)
      return { drop: r === 'failed' ? `magpie-tasks: 没能把消息交给长期任务「${task.title}」的架构师，已报告` : `magpie-tasks: 已转给长期任务「${task.title}」的架构师` }
    }
    case 'architect-decision':
      return longDecisionReply(ctx, await taskOrThrow(ctx, route.taskId), route.decisionId, tag, tg)
    case 'daily-decision': {
      const task = await taskOrThrow(ctx, route.taskId)
      // A daily task promoted since the question was asked: its decisions are the architect's now.
      if (task.owner.kind === 'session') return longDecisionReply(ctx, task, route.decisionId, tag, tg)
      const decision = task.decisions[route.decisionId]
      if (decision === undefined) throw new Error(`task ${task.id} has no decision ${route.decisionId}`)
      await recordFollowUp(ctx, task.id, tag.body, false, false)
      const answer = await applyDailyDecision(ctx, (await taskOrThrow(ctx, task.id)), decision, tag.body, 'ask')
      if (answer === null) throw new Error(`decision ${decision.id} of task ${task.id} gave no answer to show`)
      await replyNote(ctx, task, tg, answer, { taskId: task.id, kind: 'decision', decisionId: decision.id })
      return { drop: `magpie-tasks: 已处理任务「${task.title}」的决定：${firstLine(answer)}` }
    }
    case 'executor':
      return executorReply(ctx, await taskOrThrow(ctx, route.taskId), tag, tg)
    case 'rating': {
      const task = await taskOrThrow(ctx, route.taskId)
      const at = await ctx.io.now()
      const invited = tag.replyTo !== undefined && (await ctx.reg.readIndex()).messages[`${tag.chatId}:${tag.replyTo}`]?.kind === 'rating'
      await ctx.reg.update(task.id, t => { t.ratings.push({ at, score: route.score, raw: tag.body, invited }) }, { type: 'rating', score: route.score, invited, messageId: tag.messageId })
      await send(ctx.io, ctx.opts, tag.chatId, `已记录评分 ${route.score}`, tag.messageId, false)
      return { drop: `magpie-tasks: 已记录任务「${task.title}」的评分 ${route.score}` }
    }
    case 'rating-no-task':
      await send(ctx.io, ctx.opts, tag.chatId, '没有找到这条评分对应的任务；请回复任务的某条消息，写“评分 N”（N 为 1–5）。', tag.messageId, false)
      return { drop: 'magpie-tasks: 评分没有对应的任务，已请用户回复任务的消息' }
    case 'rating-other':
      return withContext(ctx, e, next)
  }
}

async function longDecisionReply(ctx: Ctx, task: TaskRecord, decisionId: string, tag: { body: string; imagePath?: string }, tg: Tg): Promise<PromptResult> {
  const decision = task.decisions[decisionId]
  if (decision === undefined) throw new Error(`task ${task.id} has no decision ${decisionId}`)
  const answer = await longAnswer(ctx, decision, tag.body)
  await ctx.io.log(`decision ${decision.id} (${decision.kind}) of task ${task.id}: answer ${answer}`)
  await ctx.reg.log(task.id, { type: 'decision', stage: 'answer-judged', decision: decision.id, kind: decision.kind, answer })
  const r = await deliverToArchitect(ctx, task, decisionDelivery(decision, answer, channelText(tag)), tg, { id: decision.id, answer })
  return { drop: r === 'failed' ? `magpie-tasks: 没能把决定的回答交给长期任务「${task.title}」的架构师，已报告` : `magpie-tasks: 已把决定的回答（${answer}）交给长期任务「${task.title}」的架构师` }
}

// A reply to a daily task's message from magpie-tasks: an answer to the task's open decision when it
// reads as one, else to the task's current executor, in tg-router's follow-up format.
async function executorReply(ctx: Ctx, task: TaskRecord, tag: { body: string; imagePath?: string; messageId: number }, tg: Tg): Promise<PromptResult> {
  const decided = await decisionByFollowUp(ctx, task, tag.body, tag.messageId)
  if (decided !== null) return { drop: `magpie-tasks: 已把这条消息当作任务「${task.title}」待决定问题的回答：${firstLine(decided)}` }
  const index = await ctx.reg.readIndex()
  const worker = Object.values(index.workers).find(w => w.taskId === task.id)
  const agentId = worker?.ownerAgentId ?? (task.owner.kind === 'agent' ? task.owner.agentId : undefined)
  if (agentId === undefined) throw new Error(`daily task ${task.id} has no executor`)
  await recordFollowUp(ctx, task.id, tag.body, true)
  const out = await withOutcome(ctx, task.id, `Telegram 追问（message_id=${tag.messageId}）：\n${channelText(tag)}${worktreeGoneNote(task) ?? ''}`)
  const r = await ctx.host.session.send({ to: { agentId }, text: out.text })
  if (r.isDelivered) {
    await out.delivered()
    await ctx.reg.updateIndex(x => { x.messages[`${tg.chatId}:${tg.messageId}`] = { taskId: task.id, kind: 'magpie' } })
    await ctx.reg.log(task.id, { type: 'relay', stage: 'follow-up', agentId, messageId: tag.messageId })
    return { drop: `magpie-tasks: 已转给任务「${task.title}」的执行者` }
  }
  await ctx.reg.log(task.id, { type: 'error', during: 'follow-up', agentId, error: r.reason })
  await send(ctx.io, ctx.opts, tg.chatId, `任务「${task.title}」的执行者已不在（${r.reason}），可能是 Router 重启过。回复这个任务原来的请求消息，新的执行者会接手。`, tg.messageId, true)
  return { drop: `magpie-tasks: 任务「${task.title}」的执行者已不在，已告诉用户` }
}

// The note a daily task's agent reads under the person's words once the task's worktree was removed
// after the task finished: a change to the project needs a fresh worktree first.
export function worktreeGoneNote(task: TaskRecord): string | null {
  if (task.kind !== 'daily' || task.project === null || task.worktree !== null || task.direct != null) return null
  return `\n\n[magpie-tasks] This task's worktree was removed when the task finished. If this message asks for changes to ${task.project.root}, call mcp__magpie-tasks__open_project again first; it gives you a working directory of the project as it is now.`
}

// The person's words reached a daily task outside a reply to a decision message: a terminal
// follow-up, a Telegram message forwarded to the task, or a reply to another of its messages. When the
// task has an open decision and the words answer it, the decision is carried out, the words recorded
// and the person told under their message. Answers what the person was told, or null when the words
// do not answer the decision and go on to the task's agent.
async function decisionByFollowUp(ctx: Ctx, task: TaskRecord, body: string, messageId: number): Promise<string | null> {
  if (task.kind !== 'daily') return null
  const open = openDailyDecision(task)
  if (open === undefined) return null
  const answer = await applyDailyDecision(ctx, task, open, body, 'pass')
  if (answer === null) return null
  await recordFollowUp(ctx, task.id, body, false, false)
  await tell(ctx, task, answer, { kind: 'decision', notify: false, replyTo: messageId, decisionId: open.id })
  return answer
}

// ---- hand-over to an architect ---------------------------------------------------------------

// Sends a message to a long task's architect session; a stopped session is resumed under its own ID
// with the message; a session that cannot be reached becomes an 'interrupted' decision the person is
// asked about. Telegram messages are answered under the person's message.
export async function deliverToArchitect(ctx: Ctx, task: TaskRecord, text: string, tg: { chatId: string; messageId: number } | null, decision?: { id: string; answer: 'separate' | 'wait' | 'approve' | 'reject' | 'unclear' }): Promise<'sent' | 'resumed' | 'failed'> {
  if (task.owner.kind !== 'session') throw new Error(`task ${task.id} has no architect session`)
  const sessionId = task.owner.sessionId
  const message = architectText(text, tg, decision)
  const entry = { taskId: task.id, kind: 'long' as const }
  const told = async (note: string) => {
    if (tg === null) return
    await ctx.reg.updateIndex(x => { x.messages[`${tg.chatId}:${tg.messageId}`] = entry })
    await replyNote(ctx, task, tg, note, entry)
  }
  const r = await ctx.host.session.send({ to: { sessionId }, text: message })
  if (r.isDelivered) {
    await ctx.reg.log(task.id, { type: 'telegram', stage: 'forwarded', sessionId, ...(tg ? { messageId: tg.messageId } : {}), ...(decision ? { decision: decision.id, answer: decision.answer } : {}) })
    await told(`已转给长期任务「${task.title}」的架构师。`)
    return 'sent'
  }
  const row = (await listAgents(ctx.io, ctx.opts)).find(x => x.sessionId === sessionId)
  if (row !== undefined && row.pid == null) {
    await resumeSession(ctx, sessionId, message, task.project?.root ?? await home(ctx))
    await ctx.reg.log(task.id, { type: 'recovery', action: 'resume', reason: 'hand-over', sessionId, ...(tg ? { messageId: tg.messageId } : {}) })
    await told(`长期任务「${task.title}」的架构师会话已停止，已恢复并把消息交给它。`)
    return 'resumed'
  }
  const why = row === undefined
    ? `会话 ${sessionId} 不在 claude agents 列表中`
    : `会话 ${row.id} 仍在运行却没有收到消息（${r.reason}）`
  await ctx.reg.log(task.id, { type: 'error', during: 'hand-over', sessionId, error: r.reason, listed: row !== undefined })
  if (tg !== null) await ctx.reg.updateIndex(x => { x.messages[`${tg.chatId}:${tg.messageId}`] = entry })
  const attach = task.owner.jobShortId ?? sessionId.slice(0, 8)
  await askDecision(ctx, task, {
    kind: 'interrupted',
    question: `无法把消息交给长期任务「${task.title}」（${task.id}）的架构师：${why}。消息原文：${clip(text.trim(), 500)}\n请检查架构师会话（claude attach ${attach}）后回复“继续”重新交给它，或回复“暂停”。`,
    options: ['继续', '暂停'],
    data: { reason: why, sessionId, message: text, ...(tg ? { chatId: tg.chatId, messageId: String(tg.messageId) } : {}) },
  }, 'waiting-user')
  return 'failed'
}

// ---- Router tools ----------------------------------------------------------------------------

function str(args: Record<string, unknown>, name: string): string {
  const v = args[name]
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${name} is required`)
  return v.trim()
}

// A task named by its ID, or by the tg-router worker name the index records for it.
async function namedTask(ctx: Ctx, name: string): Promise<{ task: TaskRecord; worker: string | null }> {
  const byId = /^[ld]-\d{8}-[0-9a-z]{6}$/.test(name) ? await ctx.reg.get(name) : undefined
  const index = await ctx.reg.readIndex()
  if (byId !== undefined) {
    const worker = Object.entries(index.workers).find(([, w]) => w.taskId === byId.id)?.[0] ?? null
    return { task: byId, worker }
  }
  const w = index.workers[name]
  if (w === undefined) throw new Error(`no task with ID or worker name ${name}`)
  return { task: await taskOrThrow(ctx, w.taskId), worker: name }
}

async function forwardLong(ctx: Ctx, args: Record<string, unknown>): Promise<string> {
  const chatId = str(args, 'chat_id')
  const messageId = str(args, 'message_id')
  const { task } = await namedTask(ctx, str(args, 'task'))
  if (task.kind !== 'long' || task.owner.kind !== 'session') throw new Error(`task ${task.id} is not a long task with an architect session`)
  // A done long task reopens with the message (its architect session resumes); an abandoned one does not.
  if (task.state === 'abandoned') throw new Error(`long task ${task.id} was abandoned`)
  const m = received.get(`${chatId}:${messageId}`)
  if (m === undefined) {
    throw new Error(chatId === TERMINAL_CHAT
      ? `no message typed in this terminal has message_id ${messageId} (tg-router numbers them in its context line [tg-router terminal message_id=N])`
      : `no Telegram message ${chatId}:${messageId} reached this session`)
  }
  const tg: Tg | null = chatId === TERMINAL_CHAT ? null : { chatId: m.chatId, messageId: m.messageId }
  const r = await deliverToArchitect(ctx, task, m.text, tg)
  const who = `the architect of long task ${task.id} "${task.title}"`
  if (r === 'failed') return `Could not deliver the message to ${who}; the person was asked on Telegram what to do. Do not reply about it again.`
  const how = r === 'sent' ? `Delivered the message to ${who}` : `${who} had stopped; its session was resumed with the message`
  return tg === null
    ? `${how}. Its answer stays in the architect's window (claude attach). Tell the person so in one sentence.`
    : `${how}; the person was told under the message and the architect's answer will be posted there. Do not reply to it.`
}

// What Jev reads to recommend an architect for a daily task: its request and the person's follow-ups.
function recommendationInput(task: TaskRecord): string {
  const parts = [task.request]
  for (const f of task.followUps) parts.push(f.text)
  return parts.join('\n\n')
}

async function recommendTool(ctx: Ctx, args: Record<string, unknown>): Promise<string> {
  const { task } = await namedTask(ctx, str(args, 'task'))
  const rec = await recommendArchitect(judgeCtxOf(ctx), recommendationInput(task))
  recommendations.set(task.id, rec)
  await ctx.reg.log(task.id, { type: 'recommendation', model: rec.model, provider: rec.judgment?.provider ?? null, confidence: rec.judgment?.confidence ?? null })
  const others = ctx.rules.architect.candidates.filter(c => c.model !== rec.model).map(c => `${c.name} (${c.model})`).join(', ')
  return [
    `Recommended architect for task ${task.id} "${task.title}": ${displayName(rec.model, ctx.rules)} (${rec.model}).`,
    `Reason: ${rec.reason}`,
    `Evidence limits: ${rec.limits}`,
    `Other candidates: ${others}.`,
    'Tell the person this in Chinese; call mcp__magpie-tasks__promote_task only after they confirm a model, with their words of confirmation.',
  ].join('\n')
}

async function promoteTool(ctx: Ctx, args: Record<string, unknown>): Promise<string> {
  const { io, reg, opts, rules, catalog } = ctx
  const asked = str(args, 'model')
  const confirmation = str(args, 'user_confirmation')
  const candidate = rules.architect.candidates.find(c => c.name === asked || sameModel(c.model, asked, catalog))
  if (candidate === undefined) throw new Error(`model ${asked} is not an architect candidate; the candidates are ${rules.architect.candidates.map(c => `${c.name} (${c.model})`).join(', ')}`)
  const named = await namedTask(ctx, str(args, 'worker'))
  const task = named.task
  const worker = named.worker ?? (task.owner.kind === 'agent' ? task.owner.workerName : null)
  if (!promotable(task)) throw new Error(`task ${task.id} is not a daily task`)
  if (task.state === 'abandoned') throw new Error(`task ${task.id} was abandoned`)
  if (worker === null) throw new Error(`task ${task.id} has no worker name`)

  const recommendation = recommendations.get(task.id) ?? await recommendArchitect(judgeCtxOf(ctx), recommendationInput(task))
  const now = await io.now()
  // The state stays 'running' while the architect starts: a 'starting' record older than ten minutes
  // reads to startup recovery as a launch nobody claimed.
  const promoted = await reg.update(task.id, t => {
    t.kind = 'long'
    t.state = 'running'
    t.pausedByUser = false
    t.architect = { model: candidate.model, recommendation, userChoice: confirmation, confirmedAt: now, source: 'promoted' }
  }, { type: 'promote', worker, model: candidate.model, confirmation, workspace: workspaceOf(task) })
  const workspace = task.direct != null ? { mode: 'direct' as const, path: task.direct.dir } : task.worktree !== null ? { mode: 'worktree' as const, path: task.worktree.path } : null
  const message = architectFirstMessage(promotionBrief(promoted, { worker, confirmation }), task.id, workspace)
  const cwd = task.project?.root ?? await home(ctx)
  let shortId: string
  try {
    ({ shortId } = await launchArchitect(ctx, { task: promoted, model: candidate.model, message, cwd }))
  } catch (err) {
    // The executor and the index never changed hands; the record goes back to match them, so the
    // promotion can be asked for again.
    const line = errorLine(err)
    await reg.update(task.id, t => demoteAfterFailedLaunch(t, line), { type: 'promote-failed', worker, model: candidate.model, error: line })
    throw err
  }
  recommendations.delete(task.id)

  await reg.updateIndex(x => {
    const w = x.workers[worker]
    if (w !== undefined) w.long = true
    for (const entry of Object.values(x.messages)) {
      if (entry.taskId !== task.id || entry.kind === 'rating') continue
      entry.kind = 'long'
    }
  })
  const name = displayName(candidate.model, rules)
  const tg = task.telegram
  if (tg !== null && tg.chatId !== 'tui') {
    const messageId = await send(io, opts, tg.chatId, `已转为长期任务，架构师 ${name}：claude attach ${shortId}`, tg.rootMessageId, true)
    await reg.updateIndex(x => { x.messages[`${tg.chatId}:${messageId}`] = { taskId: task.id, kind: 'long' } })
    await reg.log(task.id, { type: 'telegram', chatId: tg.chatId, messageId, kind: 'long', stage: 'promoted' })
  }
  return `Task ${task.id} "${task.title}" is now a long task. Its architect ${name} (${candidate.model}) runs in background session ${shortId}${cwd === task.project?.root ? ` in ${cwd}` : ''}; replies to the task's messages go to it from now on.${tg !== null && tg.chatId !== 'tui' ? ' The person was told on Telegram.' : ` Tell the person: claude attach ${shortId}.`}`
}

export async function routerTool(ctx: Ctx, name: RouterToolName, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'forward_long': return forwardLong(ctx, args)
    case 'recommend_architect': return recommendTool(ctx, args)
    case 'promote_task': return promoteTool(ctx, args)
    default: throw new Error(`unknown Router tool ${String(name)}`)
  }
}

// ---- follow-ups tg-router sends --------------------------------------------------------------

// A message the Router or tg-router sends to a daily task's executor carries the note on what became
// of the executor's last result (withOutcome). A tg-router follow-up that answers the task's open
// decision is carried out here and the send refused with DECISION_HANDLED; any other follow-up goes on
// (with a note when the task's worktree was removed) and is recorded as the person's words, judged as
// feedback.
export async function onSessionSend(ctx: Ctx, e: SessionSendInput, next: Next<'session.send'>): Promise<SessionSendResult> {
  const fromTgRouter = e.origin.kind === 'plugin' && e.origin.name === 'tg-router'
  const fromRouter = e.origin.kind === 'model' && e.agentId === undefined
  if (!fromTgRouter && !fromRouter) return next(e)
  const index = await ctx.reg.readIndex()
  const worker = index.workers[e.to] !== undefined ? e.to : index.agents[e.to]
  const taskId = worker === undefined ? undefined : index.workers[worker]?.taskId
  if (taskId === undefined) return next(e)
  const f = fromTgRouter ? followUpBody(e.text) : null
  const task = await taskOrThrow(ctx, taskId)
  if (f !== null) {
    const decided = await decisionByFollowUp(ctx, task, f.body, f.messageId)
    if (decided !== null) return { isDelivered: false, reason: `${DECISION_HANDLED}${decided}` }
  }
  const out = await withOutcome(ctx, taskId, `${e.text}${f === null ? '' : worktreeGoneNote(task) ?? ''}`)
  const r = await next(out.text === e.text ? e : { ...e, text: out.text })
  if (!r.isDelivered) return r
  await out.delivered()
  if (f !== null) await recordFollowUp(ctx, taskId, f.body, true)
  return r
}
