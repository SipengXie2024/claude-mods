// The architect session (plan sections 9.5, 9.9, 9.12): messages the architect receives (Telegram
// hand-overs with reply targets and decision answers, window messages, the per-turn context), the
// end of its turns (Telegram replies, the debug-log check), its main conversation's tool limits, its
// subagents' write range and file conflicts, their reports and separate-copy merges, the architect
// tools, and the execution of every decision of a long task.
import type { Next, PromptSubmitInput, ToolCallInput, ToolCallResult, TurnCompleteInput } from 'claude-code'
import { parseStatus } from './brief'
import { findConflict, isCheckCommand, porcelainChanged, touchedPaths } from './conflict'
import { relay } from './daily'
import { architectDeny, placeWith, repoOfWith, subagentWriteDeny } from './gate'
import { baseRefName, createWorktree, gitRun } from './git'
import { integrate, integrateTask, projectRootOf, recordIntegration, type IntegrationResult } from './integrate'
import { newId } from './io'
import { agentLabel } from './model'
import { MODEL_OPINION_QUESTION, predicate, UNSUITABLE_QUESTION } from './judge'
import { isRecoveryMessage, scanDebugLog } from './recovery'
import { modelRoute } from './route'
import { architectContext, judgeCtxOf, notice, onTakeoverTurnEnd, telegramReport } from './session'
import type { Ctx, PromptResult } from './state'
import { clip, send } from './telegram'
import type { ArchitectToolName } from './tools'
import type { AgentRecord, Blocker, Decision, TaskRecord, Workspace } from './types'
import { directHolders, firstPlaced, isLive, pathOf, workspaceOf, workspacePaths, workspaces, worktreePath, writeRange } from './workspace'

type ToolEvent = { tool: string; [k: string]: unknown }
type LongAnswer = 'separate' | 'wait' | 'approve' | 'reject' | 'unclear'

const TELEGRAM_MARK = /^\[magpie-tasks telegram chat=(\S+) message=(\d+)(?: decision=(\S+) answer=(separate|wait|approve|reject|unclear))?\][ \t]*$/

// Per-process bookkeeping for conflict checks (all subagents of an architect run in its process):
// when each agent last changed a file, and when it last ran each check command.
const touchedAt = new Map<string, number>()
const checkRunAt = new Map<string, number>()
const active = new Set<string>()

// ---- helpers ----------------------------------------------------------------------------------

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

async function taskOf(ctx: Ctx): Promise<TaskRecord> {
  const id = ctx.st.taskId
  if (id === null) throw new Error('this architect session has no task')
  const t = await ctx.reg.get(id)
  if (t === undefined) throw new Error(`task ${id} does not exist`)
  return t
}

function placeFor(ctx: Ctx): (path: string) => Promise<string | null> {
  return placeWith(p => ctx.io.realPath(p), ctx.st.cwd)
}

async function appendForArchitect(ctx: Ctx, text: string): Promise<void> {
  const r = await ctx.host.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  if (r.deny !== undefined) throw new Error(`appending a note for the architect was refused: ${r.deny}`)
}

function agentName(a: AgentRecord): string {
  return a.name ? `${a.name} (${a.agentId})` : a.agentId
}

// Telegram (or the transcript) for a long-task decision, its message stored on the decision.
async function askPerson(ctx: Ctx, task: TaskRecord, decision: Decision): Promise<void> {
  const text = `${decision.question}\n回复：${decision.options.join(' / ')}`
  const messageId = await telegramReport(ctx, task, text, { decisionId: decision.id })
  if (messageId !== null && task.telegram !== null) {
    const chatId = task.telegram.chatId
    await ctx.reg.update(task.id, t => { const d = t.decisions[decision.id]; if (d) d.telegram = { chatId, messageId } }, { type: 'telegram', decision: decision.id, messageId })
  }
}

// Marks a decision resolved; a task that waited only on it runs again.
function resolve(t: TaskRecord, id: string, answer: string, at: number): void {
  const d = t.decisions[id]
  if (d === undefined) throw new Error(`decision ${id} does not exist in task ${t.id}`)
  d.resolvedAt = at
  d.answer = answer
  if (t.state === 'waiting-user' && Object.values(t.decisions).every(x => x.resolvedAt !== undefined)) t.state = 'running'
}

// ---- messages the architect receives (section 9.12) --------------------------------------------

// The Router's $.session.send reaches the architect framed as a peer's message: the engine wraps
// the text in a <cross-session-message …> element, with a line before it and a paragraph after, and
// leaves its characters unescaped (E9, 2026-11-10). The message is the element's content; a text
// without the element (the first message of `claude --bg --resume`) is the message itself.
const PEER_MESSAGE = /<cross-session-message\b[^>]*>\n([\s\S]*)\n<\/cross-session-message>/

export function parseTelegramMarker(received: string): { chatId: string; messageId: number; decision?: { id: string; answer: LongAnswer }; body: string } | null {
  const text = PEER_MESSAGE.exec(received)?.[1] ?? received
  const nl = text.indexOf('\n')
  const first = nl < 0 ? text : text.slice(0, nl)
  const m = TELEGRAM_MARK.exec(first)
  if (!m) return null
  return {
    chatId: m[1]!,
    messageId: Number(m[2]),
    ...(m[3] !== undefined ? { decision: { id: m[3], answer: m[4] as LongAnswer } } : {}),
    body: nl < 0 ? '' : text.slice(nl + 1),
  }
}

export async function onArchitectPrompt(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult> {
  const { st, reg, io } = ctx
  if (e.command !== undefined) return next(e)
  let task = await taskOf(ctx)
  const context = [...(e.context ?? [])]
  const marker = parseTelegramMarker(e.text)
  const source = marker !== null ? 'telegram' : e.origin.kind === 'composer' && !isRecoveryMessage(e.text) ? 'window' : null
  if (marker !== null) {
    // A message delivered into a running turn is answered by that turn's answer too.
    st.replyTargets.push({ chatId: marker.chatId, messageId: marker.messageId })
    context.push('[magpie-tasks] This message came from the person on Telegram. Your final answer of this turn is sent back there as plain text: lead with the conclusion and use no Markdown markup.')
    if (marker.decision !== undefined) context.push(await decisionFromTelegram(ctx, task, marker.decision, marker.body))
  }
  if (source !== null) {
    const text = marker !== null ? marker.body : e.text
    const at = await io.now()
    const from = task.state
    if (from === 'done') context.push(await reopen(ctx, task))
    task = await reg.update(task.id, t => {
      t.followUps.push({ at, source, text })
      if (t.state === 'error' || t.state === 'done') t.state = 'running'
    }, from === 'error' || from === 'done' ? { type: 'state', from, to: 'running', source } : { type: 'follow-up', source })
    const taskId = task.id
    // Runs after the prompt has gone on; a failure to record the feedback is reported here.
    void judgeFeedback(ctx, taskId, source, text, at).catch((err: unknown) => notice(ctx, `magpie-tasks 出错（任务 ${taskId}）：记录反馈失败：${firstLine(err instanceof Error ? err.message : String(err))}`))
  }
  context.push(architectContext(task, ctx.opts))
  return next({ ...e, context })
}

// The person's message to a done long task reopens it. Its worktrees were removed once the session
// stopped (src/reclaim.ts); a fresh one of its first project as it is now takes the same path,
// which the architect and its subagents already know, and a further project is opened again by the
// subagent that changes it. Answers the note the architect reads beside the message.
async function reopen(ctx: Ctx, task: TaskRecord): Promise<string> {
  const closed = (task.more ?? []).filter(w => pathOf(w) === null).map(w => w.project.root)
  const further = closed.length === 0 ? '' : ` The worktrees of its further projects (${closed.join(', ')}) were removed too: a subagent whose work changes one of them opens it again with mcp__magpie-tasks__open_project.`
  if (task.worktree !== null || task.direct != null || task.project === null) return `[magpie-tasks] This long task was done; the person's message reopens it.${further}`
  const path = worktreePath(ctx.opts, task.id, 1)
  const made = await createWorktree(ctx.io, task.project.root, path, baseRefName(task.id), task.project.root)
  await ctx.reg.update(task.id, t => { t.worktree = { path, baseRef: made.baseRef, baseCommit: made.baseCommit } }, { type: 'worktree', path, root: task.project.root, baseCommit: made.baseCommit, reason: 'reopened' })
  return `[magpie-tasks] This long task was done; the person's message reopens it. Its worktree was removed when it closed and is made again at ${path} from the project as it is now; delegate changes there as before.${further}`
}

async function decisionFromTelegram(ctx: Ctx, task: TaskRecord, a: { id: string; answer: LongAnswer }, body: string): Promise<string> {
  const d = task.decisions[a.id]
  if (d === undefined) throw new Error(`the Telegram reply names decision ${a.id}, which task ${task.id} does not have`)
  if (d.resolvedAt !== undefined) return `[magpie-tasks] Decision ${d.id} (${d.kind}) was already resolved: ${d.answer}. The person's reply below is for your information.`
  if (d.kind === 'model-unavailable' || d.kind === 'model-change-confirm' || d.kind === 'route-confirm') {
    const at = await ctx.io.now()
    await ctx.reg.update(task.id, t => resolve(t, d.id, body.trim(), at), { type: 'decision', decision: d.id, kind: d.kind, answer: 'person-words' })
    if (d.kind === 'route-confirm') {
      // A routing assessment asked before the daily task was promoted: its subagent belonged to the
      // Router session, so the architect delegates the work itself.
      return `[magpie-tasks] Decision ${d.id} (route-confirm: the routing assessment of the daily task this long task was promoted from) is resolved with the person's words below; the assessment subagent ran in the Router session and does not continue. Delegate the work as they say, with "[model-reason user: <their words>]" for a model they named.`
    }
    return `[magpie-tasks] Decision ${d.id} (${d.kind}: ${d.question}) is resolved with the person's words below. Arrange the hand-over as they say: delegate with "[model-reason user: <their words>]" for a model they named, or wait if they chose to wait.`
  }
  if (a.answer === 'unclear') {
    const how = d.kind === 'file-conflict'
      ? 'Confirm with the person, then call mcp__magpie-tasks__resolve_conflict.'
      : 'Ask the person to reply to that Telegram question again with one of its options; the reply is carried out when it arrives.'
    return `[magpie-tasks] The person replied to decision ${d.id} (${d.kind}: ${d.question}), but the reply could not be read as one of its options (${d.options.join(' / ')}). ${how}`
  }
  const result = await applyLongDecision(ctx, task, d, a.answer)
  return `[magpie-tasks] Decision ${d.id} (${d.kind}) was carried out on the person's Telegram reply (${a.answer}): ${result}`
}

// Section 9.14 feedback: the person's words, judged for "unsuitable" and "model opinion" after the
// prompt has gone on. A failed judgment keeps the words with null judgments and is reported.
async function judgeFeedback(ctx: Ctx, taskId: string, source: 'telegram' | 'window', text: string, at: number): Promise<void> {
  const input = [{ role: 'user' as const, content: text }]
  try {
    const jc = judgeCtxOf(ctx)
    const [unsuitable, opinion] = await Promise.all([predicate(jc, UNSUITABLE_QUESTION, input), predicate(jc, MODEL_OPINION_QUESTION, input)])
    await ctx.reg.update(taskId, t => { t.feedback.push({ at, source, text, unsuitable: unsuitable.yes, modelOpinion: opinion.yes }) }, { type: 'feedback', source, unsuitable: unsuitable.p, modelOpinion: opinion.p, provider: unsuitable.provider })
  } catch (err) {
    const line = firstLine(err instanceof Error ? err.message : String(err))
    notice(ctx, `magpie-tasks 出错（任务 ${taskId}）：反馈判断失败：${line}`)
    await ctx.reg.update(taskId, t => { t.feedback.push({ at, source, text, unsuitable: null, modelOpinion: null }) }, { type: 'error', during: 'feedback', error: line })
  }
}

// ---- the end of the architect's turns ------------------------------------------------------------

const ENDED: Record<string, string> = {
  aborted: '架构师的这一轮被中断，没有给出回答。',
  refusal: '架构师的模型拒绝回答这条消息。',
  error: '架构师的这一轮因 API 错误结束，没有给出回答。',
}

export async function onArchitectComplete(ctx: Ctx, e: TurnCompleteInput): Promise<void> {
  const { st, io, opts, reg } = ctx
  await onTakeoverTurnEnd(ctx)
  const task = await taskOf(ctx)
  const shortId = task.owner.kind === 'session' ? task.owner.jobShortId : undefined
  const errorNote = e.reason === 'error'
    ? `架构师会话 ${st.sessionId} 的主对话因 API 错误结束${st.stopFailures.get('main') ? `（${st.stopFailures.get('main')}）` : ''}；模型由你决定${shortId ? `，打开会话：claude attach ${shortId}` : ''}。`
    : null
  const targets = st.replyTargets.splice(0)
  if (targets.length > 0) {
    const target = targets[0]!
    const text = e.reason === 'answer'
      ? clip(e.answer.trim() === '' ? '（架构师这一轮没有文字回答）' : e.answer)
      : `${ENDED[e.reason] ?? `架构师的这一轮以 ${e.reason} 结束。`}${errorNote ?? ''}`
    const messageId = await send(io, opts, target.chatId, text, target.messageId, true)
    await reg.updateIndex(x => { x.messages[`${target.chatId}:${messageId}`] = { taskId: task.id, kind: 'long' } })
    await reg.log(task.id, { type: 'telegram', messageId, replyTo: target.messageId, reason: e.reason, targets: targets.length })
  } else if (errorNote !== null) {
    await telegramReport(ctx, task, `长期任务「${task.title}」（${task.id}）：${errorNote}`)
  }
  const hit = await scanDebugLog(ctx)
  if (hit !== null) {
    await reg.log(task.id, { type: 'error', during: 'context-memory', error: hit.slice(0, 500) })
    await telegramReport(ctx, task, `长期任务「${task.title}」（${task.id}）的架构师会话报告 context-memory 归档失败，压缩没有生效：${clip(hit, 500)}`)
  }
}

// ---- the main conversation's tool limits (section 9.5) -------------------------------------------

export async function onArchitectToolCall(ctx: Ctx, e: ToolCallInput, next: Next<'tool.call'>): Promise<ToolCallResult> {
  const task = await taskOf(ctx)
  const home = await ctx.io.env('HOME')
  if (home === undefined || home === '') throw new Error('HOME is not set')
  const deny = await architectDeny(e as unknown as ToolEvent, { projectRoot: task.project?.root ?? ctx.st.cwd, home, place: placeFor(ctx) })
  return deny === null ? next(e) : { deny }
}

// ---- subagents: write range, touched files and conflicts (sections 9.5, 9.9) ----------------------

function shares(task: TaskRecord, a: AgentRecord): boolean {
  const ws = workspaceOf(task)
  return task.kind === 'long' && ws !== null && a.worktree === ws
}

const pausedText = (decisionId: string | undefined) => `magpie-tasks has paused you${decisionId ? ` (decision ${decisionId})` : ''}: another subagent works on the same files in the task's shared working directory. Stop changing files; in your answer say what you have done and what remains, then end this turn. You will be told how to continue.`

// A task that ended and was resumed may not write in a project directory it changed in place once
// another live task changes that project in place: it first moves to a worktree of it through
// open_project (leaveIfTaken). Outside Git every task works in place, so nothing is refused there.
async function takenDeny(ctx: Ctx, task: TaskRecord, e: ToolEvent, place: (path: string) => Promise<string | null>): Promise<string | null> {
  if (isLive(task)) return null
  const paths = await placed(place, touchedPaths(e.tool, e))
  for (const w of workspaces(task)) {
    const d = w.worktree === null ? w.direct : null
    if (d == null || d.baseRef === null || !paths.some(p => p.startsWith(`${d.dir}/`))) continue
    const others = await directHolders(ctx.reg, d.dir, task.id)
    if (others.length > 0) return `Another task now changes ${d.dir} in place (${others.map(o => `「${o.title}」`).join(', ')}). Call mcp__magpie-tasks__open_project with { "project": "${d.dir}" } again: this task then gets a Git worktree of the project as it is now, and you continue there.`
  }
  return null
}

export async function onSubagentToolCall(ctx: Ctx, e: ToolCallInput, next: Next<'tool.call'>): Promise<ToolCallResult> {
  const { st, reg, io } = ctx
  const agentId = e.agentId
  const taskId = agentId === undefined ? undefined : st.agents.get(agentId)
  if (agentId === undefined || taskId === undefined) return next(e)
  let task = await reg.get(taskId)
  if (task === undefined) throw new Error(`task ${taskId} of agent ${agentId} does not exist`)
  let agent = task.agents[agentId]
  if (agent === undefined) throw new Error(`agent ${agentId} is not recorded in task ${taskId}`)
  const ev = e as unknown as ToolEvent
  const place = placeFor(ctx)
  const deny = await subagentWriteDeny(ev, { ...writeRange(task, agent), place, repoOf: repoOfWith(io) }) ?? await takenDeny(ctx, task, ev, place)
  if (deny !== null) {
    await reg.log(taskId, { type: 'write-denied', agentId, tool: e.tool, reason: deny.slice(0, 300) })
    return { deny }
  }
  // Outside Git a task's change is the files its agents edit with the file tools.
  const untracked = workspaces(task).some(w => w.worktree === null && w.direct != null && w.direct.baseRef === null)
  if (!shares(task, agent)) {
    const edits = untracked ? touchedPaths(e.tool, ev) : []
    if (edits.length === 0) return next(e)
    const r = await next(e)
    if (r.deny === undefined && r.isError === undefined) await recordTouches(ctx, taskId, agentId, await placed(place, edits))
    return r
  }
  if (!active.has(agentId)) {
    active.add(agentId)
    if (agent.state === 'idle') task = await reg.update(taskId, t => { t.agents[agentId]!.state = 'running' }, { type: 'state', agentId, to: 'running' })
    agent = task.agents[agentId]!
  }
  if (await place(workspaceOf(task)!) === null) throw new Error(`the task's working directory ${workspaceOf(task)} does not exist`)
  const edits = touchedPaths(e.tool, ev)
  if (edits.length > 0) {
    if (agent.state === 'paused') return { deny: pausedText(agent.pausedFor) }
    const paths = await placed(place, edits)
    for (const path of paths) {
      const other = findConflict(st.touches, agentId, path, runningShared(task))
      if (other !== null) {
        const paused = await fileConflict(ctx, task, agentId, other, { path, cause: 'same-file' })
        if (paused === agentId) return { deny: pausedText(task.agents[agentId]?.pausedFor) }
      }
    }
    const r = await next(e)
    if (r.deny === undefined && r.isError === undefined) await recordTouches(ctx, taskId, agentId, paths)
    return r
  }
  if (e.tool !== 'Bash') return next(e)
  if (agent.state === 'paused') return { deny: pausedText(agent.pausedFor) }
  // A shell command's changes show in the Git status of the task's working directories; outside
  // Git there is no status to compare, and they are not tracked.
  const dirs = await placed(place, workspaces(task).filter(w => w.worktree !== null || w.direct?.baseRef != null).map(w => pathOf(w)!))
  if (dirs.length === 0) return next(e)
  const command = typeof ev['command'] === 'string' ? ev['command'] : ''
  const before = await Promise.all(dirs.map(d => porcelain(ctx, d)))
  const startedAt = await io.now()
  const r = await next(e)
  const after = await Promise.all(dirs.map(d => porcelain(ctx, d)))
  const changed = dirs.flatMap((d, i) => porcelainChanged(before[i]!, after[i]!).map(p => `${d}/${p}`))
  if (changed.length > 0) await recordTouches(ctx, taskId, agentId, changed)
  if (!isCheckCommand(command)) return r
  const key = `${agentId}\0${command}`
  const since = checkRunAt.get(key) ?? agent.startedAt
  checkRunAt.set(key, startedAt)
  if (r.isError !== true) return r
  // A check that failed after another running agent changed files since this agent last ran it.
  const fresh = await reg.get(taskId)
  const culprit = [...runningShared(fresh!)].find(id => id !== agentId && (touchedAt.get(id) ?? 0) > since)
  if (culprit === undefined) return r
  const paused = await fileConflict(ctx, fresh!, agentId, culprit, { path: command, cause: 'check-failed' })
  if (paused !== agentId) return r
  return { ...r, context: [...(r.context ?? []), pausedText(fresh!.agents[agentId]?.pausedFor)] }
}

async function placed(place: (path: string) => Promise<string | null>, paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    const real = await place(p)
    if (real !== null) out.push(real)
  }
  return out
}

function runningShared(task: TaskRecord): Set<string> {
  return new Set(Object.values(task.agents).filter(a => a.state === 'running' && shares(task, a)).map(a => a.agentId))
}

async function porcelain(ctx: Ctx, wt: string): Promise<string> {
  const r = await gitRun(ctx.io, ['-C', wt, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 120_000 })
  if (r.exitCode !== 0) throw new Error(`git -C ${wt} status exited ${r.exitCode}: ${firstLine(r.stderr)}`)
  return r.stdout
}

async function recordTouches(ctx: Ctx, taskId: string, agentId: string, paths: string[]): Promise<void> {
  const { st, reg, io } = ctx
  const set = st.touches.get(agentId) ?? new Set<string>()
  st.touches.set(agentId, set)
  for (const p of paths) set.add(p)
  touchedAt.set(agentId, await io.now())
  const task = await reg.get(taskId)
  const known = new Set(task?.agents[agentId]?.filesTouched ?? [])
  const added = paths.filter(p => !known.has(p))
  if (added.length === 0) return
  await reg.update(taskId, t => {
    const a = t.agents[agentId]!
    for (const p of added) if (!a.filesTouched.includes(p)) a.filesTouched.push(p)
  }, { type: 'touch', agentId, files: added })
}

// Pauses the later-started of two agents (section 9.9 step 1/3), records a file-conflict decision
// and tells the architect and the person. Returns the paused agent's ID.
async function fileConflict(ctx: Ctx, task: TaskRecord, a: string, b: string, why: { path: string; cause: 'same-file' | 'check-failed' }): Promise<string> {
  const { reg, io } = ctx
  const A = task.agents[a]!
  const B = task.agents[b]!
  const [later, earlier] = A.startedAt >= B.startedAt ? [A, B] : [B, A]
  if (later.state === 'paused') return later.agentId
  const now = await io.now()
  const label = (x: AgentRecord) => agentLabel(x, ctx.rules)
  const ws = workspacePaths(task).find(p => why.path.startsWith(`${p}/`))
  const file = ws !== undefined && workspacePaths(task).length === 1 ? why.path.slice(ws.length + 1) : why.path
  const copy = canCopy(task, why.cause === 'same-file' ? why.path : null)
  const what = why.cause === 'same-file'
    ? `${label(A)}和仍在运行的${label(B)}改动了同一个文件 ${file}`
    : `${label(A)}的检查命令 ${why.path} 在仍在运行的${label(B)}改动文件之后失败`
  const cause = why.cause === 'same-file'
    ? `${agentName(A)} and the still running ${agentName(B)} both changed ${why.path}`
    : `the check \`${why.path}\` of ${agentName(A)} failed after the still running ${agentName(B)} changed files`
  const decision: Decision = {
    id: newId('q', now),
    kind: 'file-conflict',
    createdAt: now,
    question: copy === null
      ? `长期任务「${task.title}」（${task.id}）：${what}。已暂停后启动的${label(later)}。让它在单独的工作副本中继续，还是等${label(earlier)}完成后再继续？`
      : `长期任务「${task.title}」（${task.id}）：${what}。已暂停后启动的${label(later)}，等${label(earlier)}完成后它再继续（${copy.zh}，没有单独副本可用）。`,
    options: copy === null ? ['单独副本', '等待前一方'] : ['等待前一方'],
    data: { agentId: later.agentId, otherAgentId: earlier.agentId, path: why.path, cause: why.cause },
  }
  const updated = await reg.update(task.id, t => {
    t.decisions[decision.id] = decision
    const x = t.agents[later.agentId]!
    x.state = 'paused'
    x.pausedFor = decision.id
  }, { type: 'decision', decision: decision.id, kind: 'file-conflict', paused: later.agentId, other: earlier.agentId, path: why.path, cause: why.cause })
  task.agents[later.agentId] = updated.agents[later.agentId]!
  task.decisions[decision.id] = decision
  await appendForArchitect(ctx, `[magpie-tasks] File conflict in the task's working directory: subagent ${agentName(later)} was paused (it started later) because ${cause}. Decision ${decision.id}: discuss it with the person if needed, then call mcp__magpie-tasks__resolve_conflict with agent_id ${later.agentId} and decision ${copy === null ? 'separate (it continues in its own Git worktree copied from the working directory) or wait' : `wait (${copy.en}, so there is no separate copy)`} (it continues after ${earlier.agentId} finishes). The person was asked on Telegram as well.`)
  await askPerson(ctx, updated, decision)
  return later.agentId
}

// Why an agent that conflicts over `path` (null: over a failed check) cannot get a separate copy, or
// null when it can. A separate copy is a Git worktree copied from the task's first working
// directory: a project outside Git has none, and a file in another project of the task is not in it.
function canCopy(task: TaskRecord, path: string | null): { zh: string; en: string } | null {
  const first = firstPlaced(task)
  if (first === null || (first.worktree === null && first.direct?.baseRef == null)) return { zh: '项目不是 Git 仓库', en: 'the project is not a Git repository' }
  if (path !== null && !path.startsWith(`${pathOf(first)}/`)) return { zh: `这个文件不在 ${pathOf(first)} 中，单独副本只复制这个目录`, en: `the file is outside ${pathOf(first)}, the only directory a separate copy holds` }
  return null
}

// ---- subagent turn ends (section 9.9 steps 5, 6) ---------------------------------------------------

export async function onSubagentComplete(ctx: Ctx, e: TurnCompleteInput): Promise<void> {
  const { st, reg, io } = ctx
  const agentId = e.agentId
  const taskId = agentId === undefined ? undefined : st.agents.get(agentId)
  if (agentId === undefined || taskId === undefined) return
  active.delete(agentId)
  // An API error ends the turn through the unavailable-model handling (section 9.16).
  if (e.reason === 'error') return
  const status = e.reason === 'answer' ? parseStatus(e.answer) : null
  const at = await io.now()
  const task = await reg.update(taskId, t => {
    const a = t.agents[agentId]
    if (a === undefined) throw new Error(`agent ${agentId} is not recorded in task ${taskId}`)
    a.reports.push({ at, status: status?.status ?? 'missing', text: e.answer, verification: status?.verification ?? [] })
    if (a.state === 'running') a.state = 'idle'
  }, { type: 'report', agentId, status: status?.status ?? 'missing', reason: e.reason })
  const extra = task.extraWorktrees[agentId]
  if (extra !== undefined && status?.status === 'done') await mergeWhenFree(ctx, task, agentId, extra)
  for (const d of Object.values(task.decisions)) {
    if (d.kind !== 'file-conflict' || d.data['otherAgentId'] !== agentId) continue
    if (d.answer === 'wait') await release(ctx, task, d)
    if (d.answer === 'separate' && d.data['merge'] === 'waiting') {
      const other = d.data['agentId']!
      await reg.update(task.id, t => { t.decisions[d.id]!.data['merge'] = 'done' }, { type: 'merge-released', decision: d.id, agentId: other })
      const fresh = (await reg.get(task.id))!
      await mergeSeparate(ctx, fresh, other, fresh.extraWorktrees[other]!)
    }
  }
}

// A separate copy goes back into the task's working directory only after the agent it conflicted with has
// finished: merged earlier, the still running agent finds its file changed under it and writes its
// own version back (E7, 2026-11-09), and the merged change is lost.
async function mergeWhenFree(ctx: Ctx, task: TaskRecord, agentId: string, extra: { path: string; baseRef: string }): Promise<void> {
  const d = Object.values(task.decisions).find(x => x.kind === 'file-conflict' && x.answer === 'separate' && x.data['agentId'] === agentId)
  const other = d === undefined ? undefined : task.agents[d.data['otherAgentId']!]
  if (d === undefined || other === undefined || other.state !== 'running') return mergeSeparate(ctx, task, agentId, extra)
  await ctx.reg.update(task.id, t => { t.decisions[d.id]!.data['merge'] = 'waiting' }, { type: 'merge-deferred', decision: d.id, agentId, until: other.agentId })
  await appendForArchitect(ctx, `[magpie-tasks] Subagent ${agentId} finished in its separate worktree ${extra.path}; its changes go into ${workspaceOf(task)} once ${other.agentId}, which it conflicted with, finishes.`)
}

async function mergeSeparate(ctx: Ctx, task: TaskRecord, agentId: string, extra: { path: string; baseRef: string }): Promise<void> {
  const first = firstPlaced(task)
  if (first === null) throw new Error(`task ${task.id} has a separate worktree but no working directory`)
  const target = pathOf(first)!
  const r = await integrate(ctx.io, ctx.reg, { taskId: task.id, repo: first.project.root, source: extra.path, target, baseRef: extra.baseRef })
  if (r.status === 'applied') {
    await appendForArchitect(ctx, `[magpie-tasks] Subagent ${agentId} finished in its separate worktree ${extra.path}; its changes were merged into ${target}: ${r.files.join(', ')}.`)
  } else if (r.status === 'empty') {
    await appendForArchitect(ctx, `[magpie-tasks] Subagent ${agentId} finished in its separate worktree ${extra.path} with no changes to merge into ${target}.`)
  } else {
    await integrationConflict(ctx, task, { source: extra.path, target, baseRef: extra.baseRef, agentId }, r)
  }
}

// Wakes the agent a resolved 'wait' decision kept paused, once the agent it waited for has finished.
async function release(ctx: Ctx, task: TaskRecord, d: Decision): Promise<void> {
  const pausedId = d.data['agentId']
  if (pausedId === undefined) throw new Error(`decision ${d.id} names no paused agent`)
  const paused = task.agents[pausedId]
  if (paused === undefined || paused.state !== 'paused' || paused.pausedFor !== d.id) return
  const now = await ctx.io.now()
  await ctx.reg.update(task.id, t => { const x = t.agents[pausedId]!; x.state = 'idle'; delete x.pausedFor }, { type: 'resume', agentId: pausedId, decision: d.id })
  await relay(ctx, {
    id: newId('r', now), taskId: task.id, createdAt: now, kind: 'wake', agentId: pausedId, raises: [],
    message: `magpie-tasks: the subagent you were waiting for (${d.data['otherAgentId']}) has finished. Continue your task in ${paused.worktree ?? workspaceOf(task)}; check the files it changed before you change them again.`,
  })
}

// ---- integration and its conflicts ----------------------------------------------------------------

async function integrationConflict(ctx: Ctx, task: TaskRecord, a: { source: string; target: string; baseRef: string; agentId?: string }, r: Extract<IntegrationResult, { status: 'conflict' }>): Promise<Decision> {
  const now = await ctx.io.now()
  const detail = clip(r.detail, 800)
  const decision: Decision = {
    id: newId('q', now),
    kind: 'integration-conflict',
    createdAt: now,
    question: `长期任务「${task.title}」（${task.id}）的改动没能应用到 ${a.target}：与那里已有的改动冲突。冲突文件：${r.files.join('、')}。\n${detail}\n处理好冲突后回复“重试”，或回复“放弃”保留工作副本、不整合。`,
    options: ['重试', '放弃'],
    data: { source: a.source, target: a.target, baseRef: a.baseRef, files: r.files.join('\n'), ...(a.agentId ? { agentId: a.agentId } : {}) },
  }
  const updated = await ctx.reg.update(task.id, t => { t.decisions[decision.id] = decision; t.state = 'waiting-user' }, { type: 'decision', decision: decision.id, kind: 'integration-conflict', target: a.target, files: r.files })
  await appendForArchitect(ctx, `[magpie-tasks] Integration conflict (decision ${decision.id}): applying ${a.source} to ${a.target} failed on ${r.files.join(', ')}:\n${detail}\nThe person was asked on Telegram whether to retry after resolving it or to give up.`)
  await askPerson(ctx, updated, decision)
  return decision
}

// Integrates after the person approved: the one integration the decision recorded (its source,
// target and base ref), or, for a decision a promoted daily task brought along (it records none),
// every project of the task. A conflict becomes a new integration-conflict decision.
async function integrateApproved(ctx: Ctx, task: TaskRecord, decision: Decision): Promise<string> {
  const { source, target, baseRef, agentId } = decision.data
  if (source === undefined || target === undefined || baseRef === undefined) return integrateAll(ctx, task)
  const a = { source, target, baseRef, ...(agentId ? { agentId } : {}) }
  // A separate copy goes into the first working directory, whose repository is that project's.
  const root = await projectRootOf(ctx.io, task, target)
  const r = await integrate(ctx.io, ctx.reg, { taskId: task.id, repo: root ?? firstPlaced(task)?.project.root ?? target, source, target, baseRef })
  if (root !== null) await recordIntegration(ctx.io, ctx.reg, task.id, [{ root, status: r.status, files: r.status === 'empty' ? [] : r.files }])
  if (r.status === 'conflict') {
    const again = await integrationConflict(ctx, (await ctx.reg.get(task.id))!, a, r)
    return `${integrationText(r, target)} New decision ${again.id}; the person was asked on Telegram.`
  }
  return integrationText(r, target)
}

// Brings the change of every project of the task into its project directory (integrateTask) and
// says what became of each; a conflict becomes an integration-conflict decision of its project.
async function integrateAll(ctx: Ctx, task: TaskRecord): Promise<string> {
  const outcomes = await integrateTask(ctx.io, ctx.reg, task.id)
  if (outcomes.length === 0) throw new Error(`task ${task.id} has no working directory to integrate`)
  const lines: string[] = []
  for (const o of outcomes) {
    if (o.status === 'in-place') lines.push(`The subagents work directly in ${o.root}, so the change is already there; recorded as the task's result: ${o.files.join(', ')}. It is uncommitted, for the person to review and commit.`)
    else if (o.status === 'empty') lines.push(workspaces(task).some(w => w.project.root === o.root && w.worktree === null) ? `Nothing changed in ${o.root} since the last record.` : integrationText({ status: 'empty' }, o.root))
    else if (o.status === 'applied') lines.push(integrationText({ status: 'applied', files: o.files, newBase: '' }, o.root))
    else {
      const r = { status: 'conflict' as const, files: o.files, detail: o.conflict!.detail }
      const decision = await integrationConflict(ctx, (await ctx.reg.get(task.id))!, { source: o.conflict!.source, target: o.root, baseRef: o.conflict!.baseRef }, r)
      lines.push(`${integrationText(r, o.root)}\n${r.detail}\nNothing was applied there. The task waits for the person (decision ${decision.id}); they were asked on Telegram.`)
    }
  }
  return lines.join('\n')
}

function integrationText(r: IntegrationResult, target: string): string {
  if (r.status === 'applied') return `Applied to ${target}: ${r.files.join(', ')}. The changes are in the working tree there, uncommitted, for the person to review and commit.`
  if (r.status === 'empty') return `No changes since the last integration; nothing was applied to ${target}.`
  return `Conflict: the changes do not apply to ${target} (${r.files.join(', ')}).`
}

// ---- decisions of a long task --------------------------------------------------------------------

// Carries out a long task's decision in the architect session (resolve_conflict and Telegram replies
// share it); returns what happened, for the architect to read.
export async function applyLongDecision(ctx: Ctx, task: TaskRecord, decision: Decision, answer: string): Promise<string> {
  const { reg, io, opts } = ctx
  if (decision.resolvedAt !== undefined) return `Decision ${decision.id} was already resolved (${decision.answer ?? ''}).`
  const now = await io.now()
  const log = { type: 'decision', decision: decision.id, kind: decision.kind, answer }
  switch (decision.kind) {
    case 'file-conflict': {
      const agentId = decision.data['agentId']
      if (agentId === undefined || task.agents[agentId] === undefined) throw new Error(`decision ${decision.id} names no agent of task ${task.id}`)
      if (answer === 'separate') {
        const from = workspaceOf(task)
        if (from === null) throw new Error(`task ${task.id} has no working directory to copy`)
        const no = canCopy(task, decision.data['cause'] === 'same-file' ? decision.data['path'] ?? null : null)
        if (no !== null) throw new Error(`agent ${agentId} cannot get a separate copy: ${no.en}; answer wait instead`)
        const path = `${opts.worktreeDir}/${task.id}-${agentId}`
        const wt = await createWorktree(io, firstPlaced(task)!.project.root, path, baseRefName(task.id, agentId), from)
        await reg.update(task.id, t => {
          t.extraWorktrees[agentId] = { path, baseRef: wt.baseRef, forAgent: agentId }
          const a = t.agents[agentId]!
          a.worktree = path
          a.state = 'idle'
          delete a.pausedFor
          resolve(t, decision.id, 'separate', now)
        }, { ...log, path })
        // Its touches were in the shared worktree; from now on it cannot conflict there.
        ctx.st.touches.delete(agentId)
        await relay(ctx, {
          id: newId('r', now), taskId: task.id, createdAt: now, kind: 'wake', agentId, raises: [],
          message: `magpie-tasks: you now have a separate worktree ${path}, a copy of ${from} as it is now. Continue your task there: make every change under ${path} (cd ${path} before running commands) and do not write in ${from}. Report as before when you finish; your changes are then merged into ${from}.`,
        })
        return `separate worktree ${path} created for agent ${agentId}, which is woken to continue there; its changes are merged into ${from} when it reports done.`
      }
      if (answer === 'wait') {
        const updated = await reg.update(task.id, t => resolve(t, decision.id, 'wait', now), log)
        const other = decision.data['otherAgentId']
        const otherAgent = other === undefined ? undefined : updated.agents[other]
        if (otherAgent === undefined || otherAgent.state !== 'running') {
          await release(ctx, updated, { ...decision, resolvedAt: now, answer: 'wait' })
          return `agent ${agentId} waited for ${other}, which is no longer running; it is woken to continue.`
        }
        return `agent ${agentId} stays paused and is woken when ${other} finishes.`
      }
      throw new Error(`a file-conflict decision takes separate or wait, not ${answer}`)
    }
    case 'integration-conflict': {
      if (answer === 'reject') {
        await reg.update(task.id, t => resolve(t, decision.id, 'reject', now), log)
        return 'the person gave up this integration; the worktree keeps the changes.'
      }
      if (answer !== 'approve') throw new Error(`an integration-conflict decision takes approve or reject, not ${answer}`)
      const updated = await reg.update(task.id, t => resolve(t, decision.id, 'approve', now), log)
      return `retried: ${await integrateApproved(ctx, updated, decision)}`
    }
    case 'fix-confirm': {
      // A daily task's fixed result, asked about before the task was promoted (section 9.11).
      const changed = decision.data['change'] === 'yes'
      if (answer === 'reject') {
        await reg.update(task.id, t => resolve(t, decision.id, 'reject', now), log)
        return changed
          ? `the person declined to integrate the fixed result of the daily task this long task was promoted from; the changes stay in ${workspaces(task).flatMap(w => (w.worktree !== null ? [w.worktree.path] : [])).join(', ') || 'the worktree'}.`
          : 'the person did not accept the fixed result of the daily task this long task was promoted from.'
      }
      if (answer !== 'approve') throw new Error(`a fix-confirm decision takes approve or reject, not ${answer}`)
      const updated = await reg.update(task.id, t => resolve(t, decision.id, 'approve', now), log)
      if (!changed) return 'the person accepted the fixed result of the daily task this long task was promoted from (it changed no files).'
      return `the person approved integrating the fixed result of the daily task this long task was promoted from: ${await integrateApproved(ctx, updated, decision)}`
    }
    case 'no-progress':
    case 'interrupted': {
      if (answer !== 'approve' && answer !== 'reject') throw new Error(`a ${decision.kind} decision takes approve or reject, not ${answer}`)
      await reg.update(task.id, t => {
        resolve(t, decision.id, answer, now)
        if (decision.kind === 'interrupted' && answer === 'reject') { t.state = 'paused'; t.pausedByUser = true }
      }, log)
      if (decision.kind === 'interrupted') {
        return answer === 'approve'
          ? `the person checked the interrupted step (${decision.data['reason'] ?? ''}) and asks you to continue.`
          : 'the person keeps the task paused after the interruption.'
      }
      return answer === 'approve' ? 'the person agrees with the proposal in the no-progress report.' : 'the person does not agree with the proposal in the no-progress report; discuss the next step with them.'
    }
    case 'model-unavailable':
    case 'model-change-confirm':
    case 'route-confirm':
      await reg.update(task.id, t => resolve(t, decision.id, answer, now), log)
      return `recorded the person's answer: ${answer}`
    default:
      throw new Error(`decision ${decision.id} of task ${task.id} has the unknown kind ${String((decision as { kind: unknown }).kind)}`)
  }
}

// ---- architect tools (section 9.5) ------------------------------------------------------------------

const OUTCOMES = ['accepted', 'rejected', 'diagnosis', 'diagnosis-redelegate', 'model-change'] as const
type Outcome = typeof OUTCOMES[number]

function str(args: Record<string, unknown>, name: string, required: true): string
function str(args: Record<string, unknown>, name: string, required: false): string | undefined
function str(args: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const v = args[name]
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${name} is required`)
    return undefined
  }
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  return v.trim()
}

export async function architectTool(ctx: Ctx, name: ArchitectToolName, args: Record<string, unknown>): Promise<string> {
  const task = await taskOf(ctx)
  switch (name) {
    case 'model_route': return modelRoute(ctx, task, args)
    case 'task_status': return taskStatus(task)
    case 'report_outcome': return reportOutcome(ctx, task, args)
    case 'integrate': return integrateTool(ctx, task, str(args, 'note', false))
    case 'notify_user': return notifyUser(ctx, task, args)
    case 'resolve_conflict': {
      const agentId = str(args, 'agent_id', true)
      const answer = str(args, 'decision', true)
      if (answer !== 'separate' && answer !== 'wait') throw new Error('decision must be separate or wait')
      const agent = task.agents[agentId]
      if (agent === undefined) throw new Error(`agent ${agentId} is not a subagent of task ${task.id}`)
      const decision = agent.pausedFor === undefined ? undefined : task.decisions[agent.pausedFor]
      if (decision === undefined || decision.kind !== 'file-conflict') throw new Error(`agent ${agentId} has no pending file-conflict decision`)
      return applyLongDecision(ctx, task, decision, answer)
    }
    default:
      throw new Error(`${String(name)} is not an architect tool`)
  }
}

export function taskStatus(task: TaskRecord): string {
  const lines = [`Task ${task.id} "${task.title}": ${task.kind}, state ${task.state}${task.pausedByUser ? ' (paused by the person)' : ''}${task.error ? `, last error: ${task.error}` : ''}.`]
  lines.push(`Project main directory: ${task.project?.root ?? '(none)'}.`)
  const whereOf = (w: Workspace) => (w.direct != null
    ? `Subagents work directly in ${w.direct.dir}${w.direct.baseRef === null ? ' (not a Git repository: no diff, only the files edited with the file tools)' : ` (base ref ${w.direct.baseRef})`}.`
    : `Task worktree: ${w.worktree ? `${w.worktree.path} (base ref ${w.worktree.baseRef})` : '(none)'}.`)
  const [first, ...more] = workspaces(task)
  lines.push(first === undefined ? 'Task worktree: (none).' : whereOf(first))
  for (const w of more) lines.push(`Further project ${w.project.root}. ${whereOf(w)}`)
  for (const [agentId, x] of Object.entries(task.extraWorktrees)) lines.push(`Separate worktree of ${agentId}: ${x.path} (base ref ${x.baseRef}).`)
  const agents = Object.values(task.agents)
  lines.push(agents.length === 0 ? 'Subagents: none yet.' : 'Subagents:')
  for (const a of agents) {
    const efforts = a.efforts.map(c => `${c.from ?? '-'}→${c.to} (${c.reason}${c.note ? `: ${c.note}` : ''})`).join(', ')
    const last = a.reports[a.reports.length - 1]
    lines.push(`- ${agentName(a)}: ${a.role}, rule ${a.ruleId ?? 'none'} (${a.rulesVersion}), selection ${a.selection.kind}, model ${a.model}, effort ${a.effort}${efforts ? ` [${efforts}]` : ''}, state ${a.state}${a.pausedFor ? ` (decision ${a.pausedFor})` : ''}${a.worktree ? `, worktree ${a.worktree}` : ''}${a.replacedBy ? `, replaced by ${a.replacedBy}` : ''}${a.pendingRaises.length ? `, raises on next run: ${a.pendingRaises.join(', ')}` : ''}${last ? `, last report ${last.status}` : ''}.`)
  }
  const blockers = Object.values(task.blockers)
  lines.push(blockers.length === 0 ? 'Blockers: none.' : 'Blockers (reuse the ID for the same problem):')
  for (const b of blockers) lines.push(`- ${b.id}: ${b.description} (diagnoses ${b.diagnoses}, model changes ${b.modelChanges})`)
  const open = Object.values(task.decisions).filter(d => d.resolvedAt === undefined)
  lines.push(open.length === 0 ? 'Open decisions: none.' : 'Open decisions:')
  for (const d of open) lines.push(`- ${d.id} ${d.kind}: ${d.question} (options: ${d.options.join(' / ')})`)
  return lines.join('\n')
}

async function reportOutcome(ctx: Ctx, task: TaskRecord, args: Record<string, unknown>): Promise<string> {
  const { reg, io } = ctx
  const agentId = str(args, 'agent_id', true)
  const outcome = str(args, 'outcome', true) as Outcome
  if (!OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(', ')}`)
  const notes = str(args, 'notes', false) ?? ''
  const agent = task.agents[agentId]
  if (agent === undefined) throw new Error(`agent ${agentId} is not a subagent of task ${task.id}; task_status lists them`)
  const at = await io.now()
  if (outcome === 'accepted') {
    const last = agent.reports[agent.reports.length - 1]
    await reg.update(task.id, t => { t.deliverables.push({ at, summary: notes || `accepted the result of ${agentId}`, verification: last?.verification ?? [] }) }, { type: 'outcome', agentId, outcome, notes })
    const placed = workspaces(task).filter(w => pathOf(w) !== null)
    return placed.length === 1 && placed[0]!.worktree === null
      ? `Recorded the result of ${agentId} as accepted. Call mcp__magpie-tasks__integrate to record the change it made in ${pathOf(placed[0]!)} as the task's result.`
      : placed.length <= 1
        ? `Recorded the result of ${agentId} as accepted. Call mcp__magpie-tasks__integrate to apply the task worktree's changes to the project main directory.`
        : `Recorded the result of ${agentId} as accepted. Call mcp__magpie-tasks__integrate to bring the change of each of the task's projects into its project directory: a task worktree's change is applied there, a change made in a project directory itself is recorded as the result.`
  }
  if (outcome === 'rejected') {
    await addRaise(ctx, task.id, agentId, 'acceptance-failed', { type: 'acceptance', agentId, pass: false, notes })
    return `Recorded the rejection of ${agentId}'s result; its effort is raised one level the next time it runs. Send it the problems to fix (SendMessage).`
  }
  const blockerId = str(args, 'blocker_id', true)
  const description = blockerId === 'new' ? str(args, 'blocker', true) : undefined
  // Blockers are never removed, so an existing ID checked on this snapshot stays valid.
  if (blockerId !== 'new' && task.blockers[blockerId] === undefined) {
    const known = Object.values(task.blockers).map(b => `${b.id} (${b.description})`).join('; ')
    throw new Error(`blocker ${blockerId} does not exist; existing blockers: ${known || 'none'}. Use blocker_id new with a one-sentence blocker for a new problem.`)
  }
  const counter = outcome === 'diagnosis' ? 'diagnoses' : outcome === 'model-change' ? 'modelChanges' : null
  const step = outcome === 'model-change' ? 'model-change' : 'diagnosis'
  // The new ID and the one-diagnosis / one-model-change check are taken from the locked record, so
  // two parallel reports neither share a new ID nor both pass the check. Registry appends the log
  // entry after the change has run, so the change fills in what it decided.
  const log: { type: string; [k: string]: unknown } = { type: outcome === 'model-change' ? 'blocker' : 'diagnosis', agentId, outcome, notes }
  let blocker = null as Blocker | null
  let refused = false as boolean
  const updated = await reg.update(task.id, t => {
    let b: Blocker
    if (blockerId === 'new') {
      let n = 1
      while (`b${n}` in t.blockers) n++
      b = t.blockers[`b${n}`] = { id: `b${n}`, description: description!, diagnoses: 0, modelChanges: 0, history: [] }
    } else {
      b = t.blockers[blockerId]!
    }
    blocker = b
    log['blocker'] = b.id
    if (counter !== null && b[counter] >= 1) {
      refused = true
      log['refused'] = true
      return
    }
    if (counter !== null) b[counter] += 1
    b.history.push({ at, step, agentId, note: notes, match: { provider: 'architect', confidence: null } })
  }, log)
  const b = blocker!
  if (refused) return noProgress(ctx, updated, b, outcome, agentId, notes)
  if (outcome === 'diagnosis-redelegate') {
    await addRaise(ctx, task.id, agentId, 'diagnosis-redelegate', { type: 'effort', agentId, raise: 'diagnosis-redelegate', blocker: b.id })
    return `Recorded the re-delegation of ${agentId} after diagnosis of blocker ${b.id}; its effort is raised one level the next time it runs.`
  }
  return `Recorded ${outcome} for blocker ${b.id}${blockerId === 'new' ? ` (new blocker ${b.id}: use this ID for the same problem from now on)` : ''}.`
}

async function addRaise(ctx: Ctx, taskId: string, agentId: string, reason: 'acceptance-failed' | 'diagnosis-redelegate', log: { type: string; [k: string]: unknown }): Promise<void> {
  await ctx.reg.update(taskId, t => { t.agents[agentId]!.pendingRaises.push(reason) }, log)
  const raises = ctx.st.pendingRaises.get(agentId) ?? []
  raises.push(reason)
  ctx.st.pendingRaises.set(agentId, raises)
}

async function noProgress(ctx: Ctx, task: TaskRecord, blocker: Blocker, outcome: Outcome, agentId: string, notes: string): Promise<string> {
  const now = await ctx.io.now()
  const what = outcome === 'diagnosis' ? '已经做过一次独立诊断' : '已经更换过一次模型'
  const decision: Decision = {
    id: newId('q', now),
    kind: 'no-progress',
    createdAt: now,
    question: `长期任务「${task.title}」（${task.id}）没有进展：阻碍 ${blocker.id}（${blocker.description}）${what}，架构师又申报了一次${outcome === 'diagnosis' ? '诊断' : '模型更换'}${notes ? `（${notes}）` : ''}。受影响的工作已暂停，请和架构师商量下一步。`,
    options: ['同意架构师的方案', '不同意'],
    data: { blockerId: blocker.id, agentId, outcome },
  }
  const updated = await ctx.reg.update(task.id, t => { t.decisions[decision.id] = decision }, { type: 'decision', decision: decision.id, kind: 'no-progress', blocker: blocker.id, outcome, agentId })
  await askPerson(ctx, updated, decision)
  return `Refused: blocker ${blocker.id} already had its ${outcome === 'diagnosis' ? 'one independent diagnosis' : 'one model change'}. Pause the work this blocker affects and discuss the next step with the person; they were notified on Telegram (decision ${decision.id}).`
}

async function integrateTool(ctx: Ctx, task: TaskRecord, note: string | undefined): Promise<string> {
  if (workspaceOf(task) === null) throw new Error(`task ${task.id} has no working directory to integrate`)
  if (note !== undefined) await ctx.reg.log(task.id, { type: 'integrate-request', note })
  return integrateAll(ctx, task)
}

// kind decision: a question the person must answer; result: a finished part worth their attention;
// done: the whole task is finished, so it closes. A closed task's architect session is stopped once it
// has been idle for ten minutes and its worktree removed (src/reclaim.ts); the person's next message
// reopens the task and resumes the session.
async function notifyUser(ctx: Ctx, task: TaskRecord, args: Record<string, unknown>): Promise<string> {
  const kind = str(args, 'kind', true)
  if (kind !== 'decision' && kind !== 'result' && kind !== 'done') throw new Error('kind must be decision, result or done')
  const text = str(args, 'text', true)
  const now = await ctx.io.now()
  const heading = kind === 'done' ? '完成' : kind === 'result' ? '有了结果' : '需要你决定'
  const messageId = await telegramReport(ctx, task, `长期任务「${task.title}」${heading}：\n${text}`)
  await ctx.reg.update(task.id, t => {
    if (kind !== 'done') return
    t.completedAt = now
    t.state = 'done'
  }, { type: 'notify', kind, messageId, ...(kind === 'done' ? { state: 'done' } : {}) })
  const where = messageId === null ? 'Shown in this window (the task has no Telegram chat)' : 'Sent to the person on Telegram'
  if (kind === 'done') return `${where}. The task is closed: once you have been idle for ten minutes this session is stopped and the task worktree removed; the person's next message reopens the task.`
  return kind === 'decision' ? `${where}; their reply comes back to this session.` : `${where}.`
}
