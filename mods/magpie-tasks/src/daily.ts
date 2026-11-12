// Daily tasks and the relay (plan sections 9.8, 9.11): starting and waking subagents from
// prompt.submit, the executor's report, the one acceptance check, diagnosis and model changes,
// integration, the open_project tool, and the person's answers to a daily task's decisions.
// Daily tasks run in the Router session; their subagents are the Router's.
import type { PromptSubmitInput, TurnCompleteInput } from 'claude-code'
import { acceptanceBrief, checkedDeliverable, diagnosisBrief, diffStatOf, handoffBrief, outcomeNote, placingOf, parseDiagnosis, parseRouteConfirm, parseStatus, parseVerdict, resultStanding, resumedSince, stripOutcomeNote, withRouting, assessmentBrief, type ProjectChange } from './brief'
import { briefForJev, endedTurn, subagentDialogue, type ApiMessage } from './dialogue'
import { diffToFile, git, scratchPath } from './git'
import { integrateTask, type ProjectOutcome } from './integrate'
import { integrate, settleDirect, touchedFiles } from './integrate'
import { newId } from './io'
import { checkInput, choose, judgeBlocker, judgeCheck, judgeDeep } from './judge'
import { agentLabel, canonical, displayName, isAvailable, nameLevel, requestId, roleName, sameModel } from './model'
import { acceptancePick, readQuotas } from './quota'
import { raise, ruleById, startEffort, substituteAllowed } from './rules'
import { judgeCtx, markerFor, markRecorded, registerStarted, startAtLevel } from './spawn'
import type { Ctx, PromptResult } from './state'
import { clip, send } from './telegram'
import type { AgentRecord, AgentRole, Blocker, Decision, Effort, EffortChange, RaiseReason, RelayRequest, SelectionKind, TaskRecord } from './types'
import { leaveIfTaken, patchPathOf, pathOf, placeLocked, placementLine, placing, projectDir, workspaceAt, workspaceOf, workspaces, writeRange } from './workspace'



// ---- telling the person ----------------------------------------------------------------------

// Sends `text` about a task to the person: a Telegram message for a task with a chat (recorded in
// the Telegram index under `kind`), else a notice row in this session's transcript, which the
// person sees in the pane and the model never reads (terminal tasks of the Router).
export async function tell(ctx: Ctx, task: Pick<TaskRecord, 'id' | 'title' | 'telegram'>, text: string, o: { kind: 'magpie' | 'decision' | 'long'; notify: boolean; replyTo?: number; decisionId?: string }): Promise<{ chatId: string; messageId: number } | null> {
  if (task.telegram !== null && task.telegram.chatId !== 'tui') {
    const chatId = task.telegram.chatId
    const replyTo = o.replyTo ?? task.telegram.rootMessageId
    const messageId = await send(ctx.io, ctx.opts, chatId, clip(text), replyTo, o.notify)
    await ctx.reg.updateIndex(x => {
      x.messages[`${chatId}:${messageId}`] = { taskId: task.id, kind: o.kind, ...(o.decisionId !== undefined ? { decisionId: o.decisionId } : {}) }
    })
    await ctx.reg.log(task.id, { type: 'telegram', chatId, messageId, kind: o.kind, ...(o.decisionId !== undefined ? { decisionId: o.decisionId } : {}) })
    return { chatId, messageId }
  }
  // Plan section 9.11: a terminal task's notes and reports are lines in the Router's pane. A system
  // row appended with $.session.append is not drawn there (E8, 2026-11-09).
  ctx.host.ui.log(`magpie-tasks ·「${task.title}」（${task.id}）：${text}`)
  return null
}

// A decision the person answers: recorded on the task, then asked (index `decision` for a daily task,
// `long` with the decision ID for a long one, plan section 7.5).
export async function askDecision(ctx: Ctx, task: TaskRecord, d: { kind: Decision['kind']; question: string; options: string[]; data: Record<string, string> }, state: TaskRecord['state']): Promise<Decision> {
  const decision: Decision = { id: newId('q', await ctx.io.now()), kind: d.kind, createdAt: await ctx.io.now(), question: d.question, options: d.options, data: d.data }
  await ctx.reg.update(task.id, t => {
    t.decisions[decision.id] = decision
    t.state = state
  }, { type: 'decision', decisionId: decision.id, kind: d.kind, state })
  const text = `${d.question}\n${d.options.map(o => `· ${o}`).join('\n')}`
  const sent = await tell(ctx, task, text, { kind: task.kind === 'long' ? 'long' : 'decision', notify: true, decisionId: decision.id })
  if (sent !== null) {
    await ctx.reg.update(task.id, t => { t.decisions[decision.id]!.telegram = sent }, { type: 'decision-sent', decisionId: decision.id, messageId: sent.messageId })
    decision.telegram = sent
  }
  return decision
}

// ---- the relay -------------------------------------------------------------------------------

// Plan section 9.8: the only way the plugin starts or wakes a subagent. The request is recorded in
// the task (pendingRelays, removed once carried out) and carried out at once from the hook that asks
// for it: U3's control and U10 (2026-11-09) showed that the plugin's own turn.start, turn.step,
// tool.call and turn.complete hooks see a subagent it started from turn.complete and one it woke from
// prompt.submit, turn.complete or tool.call, and `$.prompt.submit` is refused inside prompt.submit.
// The agent.spawn hook sets the model from the brief's marker (spawn.ts): the Agent tool's input
// takes only the aliases opus, sonnet, haiku and fable. Returns the line shown in the transcript.
export async function relay(ctx: Ctx, req: RelayRequest): Promise<string> {
  ctx.st.relay.set(req.id, req)
  await ctx.reg.update(req.taskId, t => { t.pendingRelays[req.id] = req }, {
    type: 'relay', stage: 'queued', id: req.id, kind: req.kind,
    ...(req.kind === 'wake' ? { agentId: req.agentId, raises: req.raises } : { role: req.role, model: req.agent.model, effort: req.agent.effort }),
  })
  const done = await carryOut(ctx, req.id, req)
  ctx.host.ui.log(done)
  return done
}

async function carryOut(ctx: Ctx, id: string, req: RelayRequest): Promise<string> {
  const { st, reg } = ctx

  if (req.kind === 'spawn') {
    const { model: _model, ...args } = req.args
    const r = await ctx.host.agent.spawn(args)
    if (r.deny !== undefined) throw new Error(`${roleName(req.role)}子代理没有启动：${r.deny}`)
    if (r.agentId === undefined) throw new Error(`relay ${id}: agent.spawn settled without an agentId`)
    const agentId = r.agentId
    registerStarted(st, agentId, markerFor(req.taskId, req.agent))
    const record: AgentRecord = { ...req.agent, agentId, startedAt: await ctx.io.now() }
    const current = await reg.get(req.taskId)
    if (current === undefined) throw new Error(`relay ${id}: task ${req.taskId} is missing`)
    // A daily task's new executor or assessment takes the task over from the agent that owned it.
    const takesOver = current.kind === 'daily' && current.owner.kind === 'agent' && (req.role === 'executor' || req.role === 'assessment')
    const saved = await reg.update(req.taskId, t => {
      t.agents[agentId] = record
      delete t.pendingRelays[id]
      if (takesOver && t.owner.kind === 'agent') {
        const previous = t.agents[t.owner.agentId]
        if (previous !== undefined && previous.agentId !== agentId) {
          previous.replacedBy = agentId
          if (previous.state === 'running') previous.state = 'idle'
        }
        t.owner.agentId = agentId
      }
    }, { type: 'spawn', agentId, role: record.role, ruleId: record.ruleId, model: record.model, effort: record.effort, selection: record.selection.kind, relay: id })
    st.relay.delete(id)
    markRecorded(agentId)
    if (takesOver && saved.owner.kind === 'agent') {
      const worker = saved.owner.workerName
      await reg.updateIndex(x => {
        x.workers[worker] = { taskId: saved.id, ownerAgentId: agentId, long: false }
        x.agents[agentId] = worker
      })
    }
    return `magpie-tasks: 已启动${roleName(req.role)}子代理（${displayName(record.model, ctx.rules)}/${record.effort}）`
  }

  const task = await reg.get(req.taskId)
  if (task === undefined) throw new Error(`relay ${id}: task ${req.taskId} is missing`)
  const agent = task.agents[req.agentId]
  if (agent === undefined) throw new Error(`relay ${id}: agent ${req.agentId} is not on task ${req.taskId}`)
  await reg.update(task.id, t => {
    const a = t.agents[req.agentId]!
    for (const r of req.raises) a.pendingRaises.push(r)
    a.state = 'running'
  }, { type: 'relay', stage: 'raises', id, agentId: req.agentId, raises: req.raises })
  const raises = st.pendingRaises.get(req.agentId) ?? []
  st.pendingRaises.set(req.agentId, [...raises, ...req.raises])
  const sent = await ctx.host.session.send({ to: { agentId: req.agentId }, text: req.message })
  if (!sent.isDelivered) throw new Error(`${agentLabel(agent, ctx.rules)} 没有收到消息：${sent.reason}`)
  await reg.update(task.id, t => { delete t.pendingRelays[id] }, { type: 'relay', stage: 'delivered', id, agentId: req.agentId })
  st.relay.delete(id)
  const what = req.raises.includes('acceptance-failed') ? '验收意见' : req.raises.includes('diagnosis-redelegate') ? '诊断结论' : '消息'
  return `magpie-tasks: 已把${what}交给${agentLabel(agent, ctx.rules)}`
}

export async function wake(ctx: Ctx, task: Pick<TaskRecord, 'id'>, agentId: string, message: string, raises: RaiseReason[]): Promise<void> {
  const now = await ctx.io.now()
  await relay(ctx, { id: newId('r', now), taskId: task.id, createdAt: now, kind: 'wake', agentId, message, raises })
}

function nextName(task: TaskRecord, base: string, tag: string): string {
  const prefix = `${base}-${tag}`
  const n = Object.values(task.agents).filter(a => a.name !== undefined && a.name.startsWith(prefix)).length
  return `${prefix}${n + 1}`
}

function workerOf(task: TaskRecord): string {
  if (task.owner.kind === 'agent') return task.owner.workerName
  return task.telegram?.workerName ?? task.id
}

// A spawn request for an agent the plugin starts in a daily task: the routed brief, the request the
// engine gets, and the record that joins the task once it has started.
export async function spawnAgent(ctx: Ctx, task: TaskRecord, a: {
  role: AgentRole
  ruleId: string | null
  model: string
  efforts: Omit<EffortChange, 'at'>[]
  selection: AgentRecord['selection']
  brief: string
  name: string
  description: string
  worktree: string | null
  reviewOf?: string[]
  checks?: number
}): Promise<void> {
  const now = await ctx.io.now()
  const model = canonical(a.model, ctx.catalog)
  const efforts = startAtLevel(model, a.efforts)
  const effort = efforts[efforts.length - 1]!.to
  const agent: Omit<AgentRecord, 'agentId' | 'startedAt'> = {
    name: a.name,
    description: a.description,
    role: a.role,
    sessionId: ctx.st.sessionId,
    ruleId: a.ruleId,
    rulesVersion: ctx.rules.version,
    selection: a.selection,
    judgment: null,
    model,
    effort,
    efforts: efforts.map(c => ({ ...c, at: now })),
    ...(a.reviewOf !== undefined ? { reviewOf: a.reviewOf } : {}),
    ...(a.checks !== undefined ? { checks: a.checks } : {}),
    contextSource: 'brief',
    cwd: a.worktree ?? ctx.st.cwd,
    worktree: a.worktree,
    state: 'running',
    pendingRaises: [],
    filesTouched: [],
    reports: [],
  }
  const prompt = withRouting(a.brief, markerFor(task.id, agent), placingOf(task, a.worktree))
  await relay(ctx, {
    id: newId('r', now), taskId: task.id, createdAt: now, kind: 'spawn', role: a.role,
    args: { prompt, description: `${a.description} · ${displayName(model, ctx.rules)}/${effort}`, name: a.name, model: requestId(model, ctx.catalog), cwd: a.worktree ?? ctx.st.cwd },
    agent,
  })
}

// The `review` rule's agent (acceptance or diagnosis) at the rule's effort, one level up when Jev
// judges the brief to need deep reasoning.
async function reviewEfforts(ctx: Ctx, brief: string): Promise<Omit<EffortChange, 'at'>[]> {
  const rule = ruleById(ctx.rules, 'review')
  const d = await judgeDeep(judgeCtx(ctx), [{ role: 'user', content: briefForJev(brief) }])
  const start = rule.effort!
  const out: Omit<EffortChange, 'at'>[] = [{ from: null, to: start, reason: 'rule' }]
  const deep = startEffort(rule, d.deep)
  if (deep !== start) out.push({ from: start, to: deep, reason: 'deep', note: `${d.provider} p ${d.p === null ? 'n/a' : d.p.toFixed(2)}` })
  return out
}

// ---- changes in the task workspace -------------------------------------------------------------

// The task's change since its base in each project that holds one, in the order of its projects;
// each patch is written under <stateDir>/tasks/. A direct project's diff compares the project
// directory with its base, so it also holds what the person and other tasks changed there meanwhile;
// the files other tasks changed are named after the diff (alsoChanged). Outside Git there is no
// patch, and the change is the files the agents edited with the file tools.
export async function changesOf(ctx: Ctx, task: TaskRecord): Promise<ProjectChange[]> {
  const out: ProjectChange[] = []
  for (const [i, w] of workspaces(task).entries()) {
    const path = pathOf(w)
    if (path === null) continue
    const direct = w.worktree === null
    const baseRef = w.worktree?.baseRef ?? w.direct!.baseRef
    if (baseRef === null) {
      const files = touchedFiles(task, path)
      if (files.length > 0) out.push({ path, direct, patchPath: null, files, diffStat: [`${path} is not a Git repository, so there is no diff. Files the agents edited with the file tools (changes made by shell commands are not listed):`, ...files.map(f => ` ${f}`)].join('\n') + '\n' })
      continue
    }
    const patchPath = patchPathOf(ctx.opts, task.id, i + 1)
    const { tree, files } = await diffToFile(ctx.io, path, baseRef, await scratchPath(ctx.io, path, 'index'), patchPath)
    if (files.length === 0) continue
    const base = (await git(ctx.io, ['-C', path, 'rev-parse', '--verify', `${baseRef}^{commit}`])).trim()
    let diffStat = await git(ctx.io, ['-C', path, 'diff-tree', '-r', '--no-renames', '--stat', base, tree])
    const others = direct ? (w.alsoChanged ?? []).filter(o => o.files.some(f => files.includes(f))) : []
    if (others.length > 0) {
      diffStat += `Other tasks changed some of these files in ${path} meanwhile; those changes are theirs:\n${others.map(o => ` 「${o.title}」(${o.taskId}): ${o.files.filter(f => files.includes(f)).join(', ')}`).join('\n')}\n`
    }
    out.push({ path, direct, patchPath, diffStat, files })
  }
  return out
}

// ---- the end of a daily agent's turn ---------------------------------------------------------

// Executors asked once for their missing status line; a second answer without one counts as needing
// the person (plan section 9.11, "每个回合最多一次").
const statusAsked = new Set<string>()
// How the plugin's own messages to an executor start: they are not what the person asked.
const ACCEPTANCE_WAKE = 'The acceptance review (agent '
const DIAGNOSIS_WAKE = 'An independent diagnosis (agent '
const STATUS_ASK = 'Your last answer ended without the report lines. Add them now, in a short answer: the `验证：` block with each verification command you ran and its result, then the last line `状态：已完成`, `状态：需要用户决定`, `状态：受阻：<one sentence>` or `状态：进行中：<what it waits for>`.'
export const OWN_WAKES = [STATUS_ASK, ACCEPTANCE_WAKE, DIAGNOSIS_WAKE]

// A daily executor's resumed turn has started: a message reached it after it had answered. The time
// supersedes an acceptance of its earlier result (brief.ts checkedDeliverable), whatever the turn
// ends with, an interruption included.
export async function noteExecutorTurn(ctx: Ctx, agentId: string): Promise<void> {
  const taskId = ctx.st.agents.get(agentId)
  if (taskId === undefined) return
  const task = await ctx.reg.get(taskId)
  if (task === undefined) throw new Error(`task ${taskId} of agent ${agentId} is missing`)
  if (task.kind !== 'daily' || task.agents[agentId]?.role !== 'executor') return
  const now = await ctx.io.now()
  await ctx.reg.update(taskId, t => {
    const a = t.agents[agentId]!
    a.turnAt = now
    a.state = 'running'
  }, { type: 'turn-start', agentId })
}

export async function onDailyComplete(ctx: Ctx, e: TurnCompleteInput): Promise<void> {
  const id = e.agentId
  if (id === undefined) return
  const taskId = ctx.st.agents.get(id)
  if (taskId === undefined) return
  const task = await ctx.reg.get(taskId)
  if (task === undefined) throw new Error(`task ${taskId} of agent ${id} is missing`)
  if (task.kind !== 'daily') return
  const agent = task.agents[id]
  if (agent === undefined) throw new Error(`agent ${id} is not on task ${taskId}`)
  // An API error is onAgentError's (plan section 9.16); it asks for no status line.
  if (e.reason === 'error') return
  if (e.reason !== 'answer') {
    await ctx.reg.update(task.id, t => { t.agents[id]!.state = 'idle' }, { type: 'turn-end', agentId: id, reason: e.reason })
    return
  }
  const isOwner = task.owner.kind === 'agent' && task.owner.agentId === id
  switch (agent.role) {
    case 'executor':
      if (isOwner) return executorDone(ctx, task, agent, e.answer)
      break
    case 'assessment':
      if (isOwner) return assessmentDone(ctx, task, agent, e.answer)
      break
    case 'acceptance':
      return acceptanceDone(ctx, task, agent, e.answer)
    case 'diagnosis':
      return diagnosisDone(ctx, task, agent, e.answer)
    default:
      break
  }
  await ctx.reg.update(task.id, t => { t.agents[id]!.state = 'idle' }, { type: 'turn-end', agentId: id, reason: e.reason })
}

async function executorDone(ctx: Ctx, task: TaskRecord, agent: AgentRecord, answer: string): Promise<void> {
  const now = await ctx.io.now()
  const id = agent.agentId
  let status = parseStatus(answer)
  if (status === null) {
    const changes = await changesOf(ctx, task)
    if (changes.length > 0 && !statusAsked.has(id)) {
      statusAsked.add(id)
      await ctx.reg.update(task.id, t => {
        const a = t.agents[id]!
        a.state = 'idle'
        a.reports.push({ at: now, status: 'missing', text: answer, verification: [] })
      }, { type: 'status-missing', agentId: id })
      await wake(ctx, task, id, STATUS_ASK, [])
      return
    }
    status = { status: 'needs-user', verification: [] }
  }
  statusAsked.delete(id)
  const report = { at: now, status: status.status, text: answer, verification: status.verification }

  // The executor waits for its own background agent or command; that one's completion notice resumes it.
  if (status.status === 'working') {
    await ctx.reg.update(task.id, t => {
      t.agents[id]!.reports.push(report)
      t.agents[id]!.state = 'idle'
    }, { type: 'report', agentId: id, status: status.status })
    return
  }

  if (status.status === 'needs-user') {
    await ctx.reg.update(task.id, t => {
      t.agents[id]!.reports.push(report)
      t.agents[id]!.state = 'idle'
      t.state = 'waiting-user'
    }, { type: 'report', agentId: id, status: status.status })
    return
  }

  if (status.status === 'blocked') {
    await ctx.reg.update(task.id, t => {
      t.agents[id]!.reports.push(report)
      t.agents[id]!.state = 'idle'
    }, { type: 'report', agentId: id, status: status.status, blocker: status.blocker })
    return blocked(ctx, (await ctx.reg.get(task.id))!, id, status.blocker!)
  }

  // Done, or stopped at the person's word. A fix after a failed acceptance is not checked again: an
  // answer ends the task, a change goes to the person in one fix-confirm question (a later report of
  // the same fix replaces it), and again with each later result once they declined to integrate it.
  // A fix the person stopped takes the same way. Once the person has spoken to the task after the
  // fix, the next 'done' is new work and is checked like a first result. A failed result the person
  // had integrated is settled.
  const stopped = status.status === 'stopped'
  const last = task.deliverables[task.deliverables.length - 1]
  const failed = last?.acceptance !== undefined && !last.acceptance.pass && last.integration === undefined ? last.acceptance : undefined
  const pending = fixPending(task)
  const asked = !pending || failed?.fixed?.decisionId === undefined ? undefined : task.decisions[failed.fixed.decisionId]
  if (pending && (failed!.fixed === undefined || asked?.answer?.startsWith('reject') === true)) {
    await ctx.reg.update(task.id, t => {
      t.agents[id]!.reports.push(report)
      t.agents[id]!.state = 'idle'
      const d = t.deliverables[t.deliverables.length - 1]!
      d.summary = answer
      d.verification = status!.verification
      d.acceptance!.fixed = { at: now }
      supersedeFixConfirms(t, now)
    }, { type: 'report', agentId: id, status: status.status, fix: true })
    const fresh = (await ctx.reg.get(task.id))!
    // A fix made in the project directories themselves is already there: it is recorded and the
    // task ends. A fix in a task worktree waits for the person.
    const waiting = (await changesOf(ctx, fresh)).filter(c => !c.direct)
    if (waiting.length === 0) {
      await integrateDaily(ctx, fresh)
      return
    }
    const several = waiting.length > 1
    const files = waiting.flatMap(c => c.files.map(f => (several ? `${c.path}/${f}` : f)))
    const roots = workspaces(fresh).filter(w => waiting.some(c => c.path === w.worktree?.path)).map(w => w.project.root)
    const decision = await askDecision(ctx, fresh, {
      kind: 'fix-confirm',
      question: `「${fresh.title}」的改动在检查后返工过一次，${stopped ? '执行者按你的要求停止了返工' : '执行者已经修复'}，说明见它刚才的回答。改动了 ${files.length} 个文件（${files.slice(0, 8).join('、')}${files.length > 8 ? ' 等' : ''}）。回复是否把改动整合到 ${roots.join('、')}。`,
      options: ['整合', '不整合'],
      data: { agentId: id, change: 'yes' },
    }, 'waiting-user')
    await ctx.reg.update(task.id, t => { t.deliverables[t.deliverables.length - 1]!.acceptance!.fixed!.decisionId = decision.id }, { type: 'fix-confirm', decisionId: decision.id })
    return
  }
  // The fixed change still waits for the person's answer to that question: this turn's answer is
  // theirs to read, and nothing is checked or integrated until they answer it.
  if (asked !== undefined && asked.resolvedAt === undefined) {
    await ctx.reg.update(task.id, t => {
      t.agents[id]!.reports.push(report)
      t.agents[id]!.state = 'idle'
    }, { type: 'report', agentId: id, status: status.status, held: asked.id })
    return
  }

  const previous = agent.reports[agent.reports.length - 1]
  await ctx.reg.update(task.id, t => {
    t.agents[id]!.reports.push(report)
    t.agents[id]!.state = 'idle'
    t.deliverables.push({ at: now, summary: answer, verification: status!.verification, ...(stopped ? { stopped: true as const } : {}) })
    supersedeFixConfirms(t, now)
  }, { type: 'report', agentId: id, status: status.status })
  const fresh = (await ctx.reg.get(task.id))!
  // The person told the executor to stop: its answer is what they chose to have, and a reviewer
  // would only ask it to resume the work they ended.
  if (stopped) {
    await integrateDaily(ctx, fresh)
    return
  }
  const changes = await changesOf(ctx, fresh)
  // An answer that only added the report lines is judged together with the answer they belong to.
  const judged = previous?.status === 'missing' ? `${previous.text}\n\n${answer}` : answer
  const api = await ctx.host.session.messages({ agentId: id, as: 'api' })
  if (!Array.isArray(api)) throw new Error(`messages of agent ${id}: ${api.deny}`)
  const turn = endedTurn(api as ApiMessage[], OWN_WAKES)
  const c = await judgeCheck(judgeCtx(ctx), checkInput({ asked: stripOutcomeNote(turn.asked), tools: turn.tools, answer: judged, diffStat: diffStatOf(changes) }))
  // The judgment belongs to this result (`now`). The executor may have gone back to work while it
  // was asked (the person wrote to it, stopped it or interrupted it): then the judgment is recorded
  // and nothing starts; a stopped result was integrated by its own report.
  const superseded = resultStanding((await ctx.reg.get(task.id))!, now).superseded
  const judgedTask = await ctx.reg.update(task.id, t => {
    t.deliverables[resultStanding(t, now).index]!.check = { needed: c.check, p: c.p, provider: c.provider }
  }, { type: 'check', agentId: id, needed: c.check, p: c.p, provider: c.provider, tools: turn.tools, ...(superseded ? { superseded: true } : {}) })
  if (superseded) return
  if (c.check) await startAcceptance(ctx, judgedTask, fresh.agents[id]!, changes, now)
  else await integrateDaily(ctx, judgedTask)
}

// Whether the task's latest deliverable failed its acceptance, is not integrated, and the person has
// not spoken to the task since the executor first reported its fix: a 'done' now is that fix.
export function fixPending(task: TaskRecord): boolean {
  const d = task.deliverables[task.deliverables.length - 1]
  if (d === undefined || d.acceptance === undefined || d.acceptance.pass || d.integration !== undefined) return false
  const fixedAt = d.acceptance.fixed?.at
  return fixedAt === undefined || !task.followUps.some(f => f.at > fixedAt)
}

// Closes the open fix-confirm questions: a newer report replaces what they asked about.
function supersedeFixConfirms(t: TaskRecord, now: number): void {
  for (const d of Object.values(t.decisions)) {
    if (d.kind === 'fix-confirm' && d.resolvedAt === undefined) Object.assign(d, { resolvedAt: now, answer: 'superseded by a later report' })
  }
}

// Starts again the check a Router restart cut off: a new acceptance of the latest deliverable, or a
// new diagnosis of the blocker the cut-off one was looking at (the blocker keeps its one diagnosis).
export async function rerunCheck(ctx: Ctx, task: TaskRecord, role: 'acceptance' | 'diagnosis'): Promise<void> {
  if (task.owner.kind !== 'agent') throw new Error(`daily task ${task.id} has no executor`)
  const executor = task.agents[task.owner.agentId]
  if (executor === undefined) throw new Error(`task ${task.id}: executor ${task.owner.agentId} is not recorded`)
  const changes = await changesOf(ctx, task)
  if (role === 'acceptance') return startAcceptance(ctx, task, executor, changes, latestResult(task).at)
  const blocker = blockerOfDiagnosis(task)
  const brief = diagnosisBrief(task, executor, blocker, changes)
  const rule = ruleById(ctx.rules, 'review')
  await spawnAgent(ctx, task, {
    role: 'diagnosis',
    ruleId: rule.id,
    model: rule.model!,
    efforts: await reviewEfforts(ctx, brief),
    selection: { kind: 'rule', reason: `diagnosis of blocker ${blocker.id} again: a Router restart cut off the first one (rule review)` },
    brief,
    name: nextName(task, workerOf(task), 'diag'),
    description: `诊断：${task.title}`,
    worktree: workspaceOf(task),
  })
}

// The acceptance runs under the `review` rule on the model of the subscription with the most of its
// week left (routing rules, `acceptance`), read from Magpie each time a check starts. It checks the
// result recorded at `checks` and stays bound to it while its start waits on quotas, Jev and the spawn.
async function startAcceptance(ctx: Ctx, task: TaskRecord, executor: AgentRecord, changes: ProjectChange[], checks: number): Promise<void> {
  const brief = acceptanceBrief(task, executor, changes)
  const rule = ruleById(ctx.rules, 'review')
  const pick = acceptancePick(ctx.rules, await readQuotas(ctx.io, ctx.opts.gatewayUrl))
  await spawnAgent(ctx, task, {
    role: 'acceptance',
    ruleId: rule.id,
    model: pick.model,
    efforts: await reviewEfforts(ctx, brief),
    selection: { kind: 'rule', reason: `acceptance of ${executor.agentId}'s result (rule review); ${pick.reason}` },
    brief,
    name: nextName(task, workerOf(task), 'acc'),
    description: `验收：${task.title}`,
    worktree: changes[0]?.path ?? null,
    checks,
  })
}

// The task's latest deliverable: the result a check a Router restart cut off is started again for.
function latestResult(task: TaskRecord): TaskRecord['deliverables'][number] {
  const d = task.deliverables[task.deliverables.length - 1]
  if (d === undefined) throw new Error(`task ${task.id}: an acceptance needs a result on record`)
  return d
}

function firstSentence(text: string): string {
  const line = text.split('\n').map(s => s.trim()).find(s => s !== '') ?? ''
  return Array.from(line).slice(0, 120).join('')
}

async function acceptanceDone(ctx: Ctx, task: TaskRecord, agent: AgentRecord, answer: string): Promise<void> {
  const verdict = parseVerdict(answer)
  if (verdict === null) throw new Error(`acceptance agent ${agent.name ?? agent.agentId} ended without a 验收结论 line`)
  const executorId = task.owner.kind === 'agent' ? task.owner.agentId : null
  if (executorId === null) throw new Error(`daily task ${task.id} has no executor`)
  const now = await ctx.io.now()
  const checked = checkedDeliverable(task, agent)
  // The executor went back to work after the checked result (the person wrote to it, stopped it or
  // interrupted it): the verdict stays in this agent's report and the log, and wakes and applies
  // nothing. It is not written to the result, so a later answer is not taken for its fix.
  await ctx.reg.update(task.id, t => {
    const a = t.agents[agent.agentId]!
    a.state = 'done'
    a.reports.push({ at: now, status: 'done', text: answer, verification: [] })
    if (!checked.superseded) t.deliverables[checked.index]!.acceptance = { agentId: agent.agentId, pass: verdict.pass, notes: verdict.notes }
  }, { type: 'acceptance', agentId: agent.agentId, pass: verdict.pass, ...(checked.superseded ? { superseded: true } : {}) })
  if (checked.superseded) return

  if (!verdict.pass) {
    await ctx.reg.update(task.id, t => { t.state = 'running' }, { type: 'state', state: 'running', reason: 'acceptance failed' })
    await wake(ctx, task, executorId, `${ACCEPTANCE_WAKE}${agent.name ?? agent.agentId}) did not pass your result:\n\n${verdict.notes}\n\nFix these problems, verify again, and end with the same report lines (验证： and 状态：). The person has already read your previous answer and your next one is posted after it, so say plainly which of its statements were wrong and what is correct now.`, ['acceptance-failed'])
    return
  }
  await integrateDaily(ctx, (await ctx.reg.get(task.id))!)
}

// Brings a daily task's change into its projects and ends the task: a worktree's change is applied
// to the project main directory, a change made in a project directory itself is recorded as the
// result (integrateTask). `brought` holds the projects that got a change; a task without a working
// directory, or whose working directories hold nothing new, has none. On a conflict the task waits
// for the person instead (plan section 9.11); the projects without a conflict are applied all the
// same. The person is not told of an acceptance that passed or of an integration: the executor is,
// with the next message that reaches it (withOutcome).
export async function integrateDaily(ctx: Ctx, task: TaskRecord): Promise<{ status: 'done'; brought: ProjectOutcome[] } | { status: 'conflict' }> {
  const outcomes = await integrateTask(ctx.io, ctx.reg, task.id)
  const brought = outcomes.filter(o => o.status === 'applied' || o.status === 'in-place')
  const conflicts = outcomes.filter(o => o.status === 'conflict')
  if (conflicts.length > 0) {
    const one = (o: ProjectOutcome) => `涉及文件：${o.files.join('、')}\n${firstSentence(o.conflict!.detail)}\n工作副本保留在 ${o.conflict!.source}。`
    const question = outcomes.length === 1
      ? `「${task.title}」的改动不能直接整合到 ${conflicts[0]!.root}：与项目当前的文件冲突。\n${one(conflicts[0]!)}处理好冲突后回复“整合”重试，或回复“不整合”。`
      : [
          `「${task.title}」的改动有 ${conflicts.length} 个项目不能直接整合：与项目当前的文件冲突。`,
          ...conflicts.map(o => `${o.root}：\n${one(o)}`),
          ...(brought.length > 0 ? [`其余项目的改动已经在项目目录中：${brought.map(o => o.root).join('、')}。`] : []),
          '处理好冲突后回复“整合”重试，或回复“不整合”。',
        ].join('\n')
    await askDecision(ctx, task, {
      kind: 'integration-conflict',
      question,
      options: ['整合', '不整合'],
      data: { files: conflicts.flatMap(o => o.files.map(f => (conflicts.length > 1 ? `${o.root}/${f}` : f))).join('\n'), detail: conflicts.map(o => o.conflict!.detail).join('\n') },
    }, 'waiting-user')
    return { status: 'conflict' }
  }
  const now = await ctx.io.now()
  await ctx.reg.update(task.id, t => {
    t.state = 'done'
    t.completedAt = now
  }, { type: 'state', state: 'done' })
  return { status: 'done', brought }
}

// A message on its way to a daily task's executor, with the note on what became of its last result
// when it has not been told of that; `delivered` records the telling once the message has arrived.
export async function withOutcome(ctx: Ctx, taskId: string, text: string): Promise<{ text: string; delivered: () => Promise<void> }> {
  const task = await ctx.reg.get(taskId)
  const note = task === undefined || task.kind !== 'daily' ? null : outcomeNote(task)
  if (note === null) return { text, delivered: async () => {} }
  const at = task!.deliverables[task!.deliverables.length - 1]!.at
  return {
    text: `${text}\n\n${note.text}`,
    delivered: async () => {
      await ctx.reg.update(taskId, t => {
        const d = t.deliverables[t.deliverables.length - 1]
        if (d !== undefined && d.at === at) d.told = note.key
      }, { type: 'outcome-told', outcome: note.key })
    },
  }
}

// ---- blockers, diagnosis, model change -------------------------------------------------------

// Plan section 9.11 step 1: which recorded blocker a report describes; null for a new one. Needs at
// least one recorded blocker (a task's first report is b1 without a judgment).
export async function matchBlocker(ctx: Ctx, task: TaskRecord, report: string): Promise<{ blockerId: string | null; provider: 'jev' | 'substitute'; confidence: number }> {
  return judgeBlocker(judgeCtx(ctx), Object.values(task.blockers), report)
}

function newBlockerId(task: TaskRecord): string {
  let n = 1
  while (`b${n}` in task.blockers) n++
  return `b${n}`
}

async function blocked(ctx: Ctx, task: TaskRecord, executorId: string, description: string): Promise<void> {
  const now = await ctx.io.now()
  let blockerId: string | null = null
  let match: Blocker['history'][number]['match']
  if (Object.keys(task.blockers).length > 0) {
    const m = await matchBlocker(ctx, task, description)
    blockerId = m.blockerId
    match = { provider: m.provider, confidence: m.confidence }
  }
  const id = blockerId ?? newBlockerId(task)
  const existing = task.blockers[id]
  if (existing !== undefined && existing.diagnoses >= 1) {
    await ctx.reg.update(task.id, t => {
      t.blockers[id]!.history.push({ at: now, step: 'diagnosis', agentId: executorId, note: `reported again, no second diagnosis: ${description}`, ...(match ? { match } : {}) })
    }, { type: 'blocker', blockerId: id, again: true })
    return noProgress(ctx, (await ctx.reg.get(task.id))!, id, `同一个阻碍已经诊断过一次，仍然没有解决：${description}`)
  }
  await ctx.reg.update(task.id, t => {
    const b = t.blockers[id] ?? (t.blockers[id] = { id, description, diagnoses: 0, modelChanges: 0, history: [] })
    b.diagnoses += 1
    b.history.push({ at: now, step: 'diagnosis', agentId: executorId, note: `blocked report: ${description}`, ...(match ? { match } : {}) })
  }, { type: 'blocker', blockerId: id, new: existing === undefined, ...(match ? { match } : {}) })
  const fresh = (await ctx.reg.get(task.id))!
  const brief = diagnosisBrief(fresh, fresh.agents[executorId]!, fresh.blockers[id]!, await changesOf(ctx, fresh))
  const rule = ruleById(ctx.rules, 'review')
  await spawnAgent(ctx, fresh, {
    role: 'diagnosis',
    ruleId: rule.id,
    model: rule.model!,
    efforts: await reviewEfforts(ctx, brief),
    selection: { kind: 'rule', reason: `diagnosis of blocker ${id} reported by ${executorId} (rule review)` },
    brief,
    name: nextName(fresh, workerOf(fresh), 'diag'),
    description: `诊断：${fresh.title}`,
    worktree: workspaceOf(fresh),
  })
}

async function noProgress(ctx: Ctx, task: TaskRecord, blockerId: string, why: string): Promise<void> {
  const b = task.blockers[blockerId]!
  const evidence = b.history.map(h => `· ${h.step}（${h.agentId}）：${h.note}`).join('\n')
  await askDecision(ctx, task, {
    kind: 'no-progress',
    question: `「${task.title}」没有进展，已暂停。${why}\n阻碍 ${b.id}：${b.description}\n${evidence}\n回复这条消息告诉执行者怎样继续。`,
    options: ['回复处理意见'],
    data: { blockerId },
  }, 'paused')
}

// The blocker a diagnosis agent was started for: the latest diagnosis entry (one diagnosis runs at a
// time in a daily task; its executor waits for it).
// The blocker the latest diagnosis looks at, and when the executor's blocked report that started it
// was taken up (the diagnosis entry blocked() wrote).
export function diagnosedBlocker(task: TaskRecord): { blocker: Blocker; at: number } {
  let best: { blocker: Blocker; at: number } | null = null
  for (const b of Object.values(task.blockers)) {
    for (const h of b.history) if (h.step === 'diagnosis' && (best === null || h.at >= best.at)) best = { blocker: b, at: h.at }
  }
  if (best === null) throw new Error(`task ${task.id}: a diagnosis has no blocker on record`)
  return best
}

function blockerOfDiagnosis(task: TaskRecord): Blocker {
  return diagnosedBlocker(task).blocker
}

async function diagnosisDone(ctx: Ctx, task: TaskRecord, agent: AgentRecord, answer: string): Promise<void> {
  const suggestion = parseDiagnosis(answer)
  if (suggestion === null) throw new Error(`diagnosis agent ${agent.name ?? agent.agentId} ended without a 诊断建议 line`)
  if (task.owner.kind !== 'agent') throw new Error(`daily task ${task.id} has no executor`)
  const executor = task.agents[task.owner.agentId]!
  const { blocker, at: reportedAt } = diagnosedBlocker(task)
  const now = await ctx.io.now()
  const line = suggestion.action === 'replace' ? `更换模型 ${suggestion.model} / ${suggestion.effort}` : suggestion.action === 'continue' ? '继续原代理' : '交给用户'
  await ctx.reg.update(task.id, t => {
    const a = t.agents[agent.agentId]!
    a.state = 'done'
    a.reports.push({ at: now, status: 'done', text: answer, verification: [] })
    // The diagnosis entry blocked() wrote now names the diagnosing agent and its suggestion, as the
    // blocker question shows it to Jev ("diagnosis by agent <id>: <note>").
    const entry = [...t.blockers[blocker.id]!.history].reverse().find(h => h.step === 'diagnosis')!
    entry.note = `${entry.note} → 诊断建议：${line}`
    entry.agentId = agent.agentId
  }, { type: 'diagnosis', agentId: agent.agentId, blockerId: blocker.id, action: suggestion.action, ...(suggestion.action === 'replace' ? { model: suggestion.model, effort: suggestion.effort } : {}), ...(resumedSince(task, reportedAt) ? { superseded: true } : {}) })
  // The executor went back to work after the blocked report (the person wrote to it, stopped it or
  // interrupted it): the suggestion stays in the record and wakes or asks nothing.
  if (resumedSince(task, reportedAt)) return

  if (suggestion.action === 'continue') {
    await ctx.reg.update(task.id, t => { t.state = 'running' }, { type: 'state', state: 'running', reason: 'diagnosis: continue' })
    await wake(ctx, task, executor.agentId, `${DIAGNOSIS_WAKE}${agent.name ?? agent.agentId}) looked at blocker ${blocker.id} (${blocker.description}):\n\n${answer}\n\nContinue the task with this in mind and end with the report lines.`, ['diagnosis-redelegate'])
    return
  }
  if (suggestion.action === 'user') {
    await ctx.reg.update(task.id, t => { t.state = 'waiting-user' }, { type: 'state', state: 'waiting-user', reason: 'diagnosis: hand to the person' })
    await tell(ctx, task, `「${task.title}」受阻（${blocker.id}：${blocker.description}），诊断建议由你决定：\n${answer}\n回复这条消息，执行者会收到你的意见。`, { kind: 'magpie', notify: true })
    return
  }

  const same = (x: string, y: string) => sameModel(x, y, ctx.catalog)
  // A model whose ID names its level runs at that level: the redelegation cannot raise it.
  const level = nameLevel(suggestion.model)
  if (blocker.modelChanges >= 1) {
    return noProgress(ctx, task, blocker.id, `诊断建议更换为 ${displayName(suggestion.model, ctx.rules)}/${suggestion.effort}，但这个阻碍已经更换过一次模型。`)
  }
  const sub = executor.ruleId === null ? null : substituteAllowed(ctx.rules, executor.ruleId, suggestion.model, suggestion.effort, same)
  if (sub === null || !isAvailable(suggestion.model, ctx.catalog)) {
    const effort = level ?? raise(suggestion.effort)
    await askDecision(ctx, task, {
      kind: 'model-change-confirm',
      question: `「${task.title}」受阻（${blocker.id}：${blocker.description}）。诊断建议改用 ${displayName(suggestion.model, ctx.rules)}/${suggestion.effort}，这不在规则 ${executor.ruleId ?? 'none'} 的自动替代候选中，需要你确认。\n${answer}`,
      options: [`改用 ${displayName(suggestion.model, ctx.rules)}`, '等待', '回复其他模型名'],
      data: { agentId: executor.agentId, model: canonical(suggestion.model, ctx.catalog), effort, blockerId: blocker.id, diagnosis: agent.agentId },
    }, 'waiting-user')
    return
  }
  const effort = level ?? raise(suggestion.effort)
  await ctx.reg.update(task.id, t => {
    const b = t.blockers[blocker.id]!
    b.modelChanges += 1
    b.history.push({ at: now, step: 'model-change', agentId: agent.agentId, note: `${executor.model}/${executor.effort} → ${canonical(suggestion.model, ctx.catalog)}/${effort} (substitute ${sub.id})` })
    t.state = 'running'
  }, { type: 'blocker', blockerId: blocker.id, modelChange: suggestion.model, effort })
  const fresh = (await ctx.reg.get(task.id))!
  const reasonText = `诊断 ${agent.agentId} 建议：更换模型 ${suggestion.model} / ${suggestion.effort}${sub.id === 'repo-alt' ? '（repo-alt 的档位由诊断建议代替架构师的选择）' : ''}`
  await handOver(ctx, fresh, fresh.agents[executor.agentId]!, {
    model: suggestion.model,
    efforts: [{ from: null, to: suggestion.effort, reason: 'explicit', note: 'diagnosis suggestion' }, { from: suggestion.effort, to: effort, reason: 'diagnosis-redelegate' }],
    selection: { kind: 'diagnosis', reason: reasonText },
    reasonLine: `[model-reason evidence: ${reasonText}]`,
    why: `an independent diagnosis suggested another model for blocker ${blocker.id} (${blocker.description})`,
  })
  await tell(ctx, fresh, `「${fresh.title}」改由 ${displayName(suggestion.model, ctx.rules)}/${effort} 接手：${reasonText}`, { kind: 'magpie', notify: false })
}

// Starts the agent that takes over from `previous` with the same role (plan sections 9.11, 9.16):
// an executor gets the handoff brief, the other plugin agents their own brief rebuilt from the record.
export async function handOver(ctx: Ctx, task: TaskRecord, previous: AgentRecord, a: { model: string; efforts: Omit<EffortChange, 'at'>[]; selection: AgentRecord['selection']; reasonLine: string; why: string }): Promise<void> {
  const worker = workerOf(task)
  const common = { model: a.model, efforts: a.efforts, selection: a.selection, worktree: workspaceOf(task) }
  if (previous.role === 'executor') {
    await spawnAgent(ctx, task, { ...common, role: 'executor', ruleId: previous.ruleId, brief: `${a.reasonLine}\n${handoffBrief(task, { reason: a.why, previous })}`, name: nextName(task, worker, 'x'), description: task.title })
  } else if (previous.role === 'assessment') {
    await spawnAgent(ctx, task, { ...common, role: 'assessment', ruleId: previous.ruleId, brief: `${a.reasonLine}\n${assessmentBrief(task, ctx.rules, task.requestedModel)}`, name: nextName(task, worker, 'x'), description: task.title, worktree: null })
  } else if (previous.role === 'acceptance') {
    if (task.owner.kind !== 'agent') throw new Error(`daily task ${task.id} has no executor`)
    // The replacement checks the result the previous acceptance was checking.
    const checks = previous.checks
    if (checks === undefined) throw new Error(`task ${task.id}: acceptance ${previous.agentId} names no result it checks`)
    const changes = await changesOf(ctx, task)
    const brief = acceptanceBrief(task, task.agents[task.owner.agentId]!, changes)
    await spawnAgent(ctx, task, { ...common, role: 'acceptance', ruleId: previous.ruleId, brief: `${a.reasonLine}\n${brief}`, name: nextName(task, worker, 'acc'), description: `验收：${task.title}`, worktree: changes[0]?.path ?? null, checks })
  } else if (previous.role === 'diagnosis') {
    if (task.owner.kind !== 'agent') throw new Error(`daily task ${task.id} has no executor`)
    const brief = diagnosisBrief(task, task.agents[task.owner.agentId]!, blockerOfDiagnosis(task), await changesOf(ctx, task))
    await spawnAgent(ctx, task, { ...common, role: 'diagnosis', ruleId: previous.ruleId, brief: `${a.reasonLine}\n${brief}`, name: nextName(task, worker, 'diag'), description: `诊断：${task.title}` })
  } else {
    throw new Error(`no takeover for a ${previous.role} agent: its parent agent decides`)
  }
}

// ---- the routing assessment ------------------------------------------------------------------

async function assessmentDone(ctx: Ctx, task: TaskRecord, agent: AgentRecord, answer: string): Promise<void> {
  const confirm = parseRouteConfirm(answer)
  const now = await ctx.io.now()
  await ctx.reg.update(task.id, t => {
    const a = t.agents[agent.agentId]!
    a.state = 'idle'
    a.reports.push({ at: now, status: confirm === null ? 'needs-user' : 'done', text: answer, verification: [] })
  }, { type: 'report', agentId: agent.agentId, role: 'assessment', confirm: confirm === null ? null : confirm === 'cancel' ? 'cancel' : `${confirm.model}/${confirm.effort}` })

  const open = Object.values(task.decisions).find(d => d.kind === 'route-confirm' && d.resolvedAt === undefined)
  if (confirm === null) {
    // The recommendation went to the person through tg-router; their reply resumes this agent.
    if (open === undefined) {
      const decision: Decision = { id: newId('q', now), kind: 'route-confirm', createdAt: now, question: answer, options: ['确认推荐', '指定其他模型', '取消'], data: { agentId: agent.agentId } }
      await ctx.reg.update(task.id, t => {
        t.decisions[decision.id] = decision
        t.state = 'waiting-user'
      }, { type: 'decision', decisionId: decision.id, kind: 'route-confirm', state: 'waiting-user' })
    }
    return
  }
  const words = await lastUserWords(ctx, agent.agentId)
  if (confirm === 'cancel') {
    await ctx.reg.update(task.id, t => {
      if (open !== undefined) Object.assign(t.decisions[open.id]!, { resolvedAt: now, answer: words })
      t.state = 'abandoned'
      t.agents[agent.agentId]!.state = 'done'
    }, { type: 'state', state: 'abandoned', reason: 'the person declined the routing assessment' })
    return
  }
  await ctx.reg.update(task.id, t => {
    if (open !== undefined) Object.assign(t.decisions[open.id]!, { resolvedAt: now, answer: words })
    t.state = 'running'
    t.agents[agent.agentId]!.state = 'done'
  }, { type: 'route-confirmed', agentId: agent.agentId, model: confirm.model, effort: confirm.effort, words })
  const reason = `用户确认了评估推荐：${words}`
  const fresh = (await ctx.reg.get(task.id))!
  await spawnAgent(ctx, fresh, {
    role: 'executor',
    ruleId: null,
    model: confirm.model,
    efforts: [{ from: null, to: confirm.effort, reason: 'explicit', note: 'confirmed by the person after the routing assessment' }],
    selection: { kind: 'assessment-confirmed', reason, userConfirmation: words },
    brief: `[model-reason user: ${reason.replace(/\]/g, '）').replace(/\n+/g, ' ')}]\n${handoffBrief(fresh, { reason: 'the person confirmed the model the routing assessment recommended', previous: fresh.agents[agent.agentId]! })}`,
    name: nextName(fresh, workerOf(fresh), 'x'),
    description: fresh.title,
    worktree: workspaceOf(fresh),
  })
}

// The person's latest words in an agent's conversation: the message that resumed it.
async function lastUserWords(ctx: Ctx, agentId: string): Promise<string> {
  const api = await ctx.host.session.messages({ agentId, as: 'api' })
  if (!Array.isArray(api)) throw new Error(`messages of agent ${agentId}: ${api.deny}`)
  const dialogue = subagentDialogue(api as ApiMessage[])
  for (let i = dialogue.length - 1; i > 0; i--) if (dialogue[i]!.role === 'user') return dialogue[i]!.content
  throw new Error(`agent ${agentId}: no message from the person after its brief`)
}

// ---- open_project ----------------------------------------------------------------------------

// Roles that change files; the others only check and open no project of their own.
const OPENING_ROLES: readonly AgentRole[] = ['executor', 'implementer', 'helper']

export async function onOpenProject(ctx: Ctx, agentId: string, args: { project?: unknown }): Promise<string> {
  const taskId = ctx.st.agents.get(agentId)
  if (taskId === undefined) throw new Error('open_project is for subagents magpie-tasks routed; this agent is not one of them')
  if (typeof args.project !== 'string' || !args.project.startsWith('/')) throw new Error('project must be the absolute path of the project directory')
  const named = args.project.replace(/\/+$/, '') || '/'
  if (!(await ctx.io.exists(named))) throw new Error(`${named} does not exist`)
  const project = (await ctx.io.realPath(named)) ?? named
  // A call reads the task's projects and then adds one or moves one. Calls an agent makes side by
  // side run one after the other, so each answers from what the one before it recorded.
  return placing(ctx.reg, taskId, async () => {
    const task = await ctx.reg.get(taskId)
    if (task === undefined) throw new Error(`task ${taskId} is missing`)
    const agent = task.agents[agentId]
    if (agent === undefined) throw new Error(`agent ${agentId} is not recorded in task ${taskId}`)
    // A directory inside one of the task's working directories names that project; any other names
    // the project whose root is its repository top (the directory itself outside Git).
    const within = workspaces(task).find(w => {
      const p = pathOf(w)
      return p !== null && (project === p || project.startsWith(`${p}/`))
    })
    const top = within?.project.root ?? (await projectDir(ctx.io, project)).dir
    const current = workspaceAt(task, top)
    const before = current === null ? null : pathOf(current.w)
    // The tasks that change the project in place beside this one, or made it take a worktree.
    let others: { id: string; title: string }[]
    if (before !== null) {
      others = (await leaveIfTaken(ctx.io, ctx.reg, ctx.opts, task.id, top))?.others ?? []
    } else {
      if (!OPENING_ROLES.includes(agent.role)) throw new Error(`this task does not change ${top}, and you only check its result: you open no project`)
      const placed = await placeLocked(ctx.io, ctx.reg, ctx.opts, task.id, top)
      await ctx.reg.log(task.id, { type: 'placement', line: placementLine(placed) })
      others = placed.others
    }
    const fresh = (await ctx.reg.get(task.id))!
    const w = workspaceAt(fresh, top)!.w
    const shared = pathOf(w)!
    // The first project an agent opens becomes its working directory; an agent that has one keeps it.
    if (fresh.agents[agentId]!.worktree === null) {
      await ctx.reg.update(task.id, t => { t.agents[agentId]!.worktree = shared; t.agents[agentId]!.cwd = shared }, { type: 'workspace-agent', agentId, path: shared, ...(before !== null ? { existing: true } : {}) })
    }
    const range = writeRange(fresh, { worktree: fresh.agents[agentId]!.worktree ?? shared })
    // An agent with a separate copy of this project works in the copy.
    const path = range.copies[shared] ?? shared
    const sub = subOf(top, before ?? shared, project)
    const also = range.dirs.filter(d => d !== path)
    if (w.worktree !== null || path !== shared) return worktreeText(path, sub, others, also)
    return directText(path, sub, w.direct!.baseRef !== null, others, also)
  })
}

// Where the named directory lies below the project top (or below the workspace, when it names a
// directory inside the task's worktree): '' at the top itself.
function subOf(top: string, workspace: string, project: string): string {
  for (const dir of [workspace, top]) if (project.startsWith(`${dir}/`)) return project.slice(dir.length + 1)
  return ''
}

const alsoLine = (also: string[]) => `This task also changes ${also.map(d => `\`${d}\``).join(', ')}: those directories stay open, and each project's changes are made in its own directory.`

function directText(dir: string, sub: string, git: boolean, others: { id: string; title: string }[], also: string[]): string {
  const where = sub === '' ? dir : `${dir}/${sub}`
  const lines = [`Work directly in the project directory ${where}: change files there and \`cd ${where}\` before Bash commands. No other task changes this project in place now.`]
  if (!git) {
    lines[0] = `Work directly in ${where}: change files there and \`cd ${where}\` before Bash commands. It is not a Git repository, so the plugin keeps no diff: name every file you change in your report.`
    if (others.length > 0) lines.push(`Other tasks also change this directory in place: ${others.map(o => `「${o.title}」 (${o.id})`).join(', ')}. Before editing a file, check that it is not one of theirs in progress, and say in your report which files you changed.`)
  }
  lines.push('Your changes are in the project directory as soon as you make them; an acceptance check, when the result warrants one, comes after. Commit or push only when the person asks.')
  if (also.length > 0) lines.push(alsoLine(also))
  return lines.join('\n')
}

function worktreeText(path: string, sub: string, others: { id: string; title: string }[], also: string[]): string {
  const where = sub === '' ? path : `${path}/${sub}`
  return [
    `Task worktree: ${path}${sub === '' ? '' : ` (the project directory you named is ${where})`}.${others.length > 0 ? ` Another task changes the project directory in place (${others.map(o => `「${o.title}」`).join(', ')}), so this task works in a copy.` : ''}`,
    'It holds a snapshot of the project, including uncommitted and untracked files; files Git ignores (node_modules, build output) are not there, so install dependencies in it when the work needs them.',
    `Change this project's files only in this worktree; \`cd ${where}\` before Bash commands. Do not commit or push in it: the plugin applies the change to the project main directory after your turn ends, where you commit and push when the person asks.`,
    ...(also.length > 0 ? [alsoLine(also)] : []),
  ].join('\n')
}

// ---- the person's answers to a daily task's decisions ----------------------------------------

const APPROVE = {
  instructions: 'How does the person answer the proposal in the previous message: approve it, reject it, or neither?',
  choices: [
    { value: 'approve', description: 'Approves or agrees to the proposal' },
    { value: 'reject', description: 'Rejects or declines the proposal' },
    { value: 'unclear', description: 'Neither, or cannot be read as a yes or no' },
  ],
}
const REPLACE = {
  instructions: 'How does the person answer the question about which model should take the task over?',
  choices: [
    { value: 'suggested', description: 'Accepts the model the question proposes' },
    { value: 'other', description: 'Names a different model to use' },
    { value: 'wait', description: 'Wants to wait before changing anything' },
    { value: 'continue', description: 'Wants the original agent to continue on its own model now' },
    { value: 'unclear', description: 'None of these, or cannot be read as a choice' },
  ],
}

// A model the person named: a model ID or a routing-table name in the text, the longest match first.
export function namedModel(text: string, names: { id: string; name: string }[]): string | null {
  const lower = text.toLowerCase()
  let best: { id: string; len: number } | null = null
  for (const { id, name } of names) {
    for (const key of [id, name]) {
      if (key !== '' && lower.includes(key.toLowerCase()) && (best === null || key.length > best.len)) best = { id, len: key.length }
    }
  }
  return best?.id ?? null
}

async function resolve(ctx: Ctx, task: TaskRecord, decision: Decision, answer: string, state?: TaskRecord['state']): Promise<void> {
  const now = await ctx.io.now()
  await ctx.reg.update(task.id, t => {
    Object.assign(t.decisions[decision.id]!, { resolvedAt: now, answer })
    if (state !== undefined) t.state = state
  }, { type: 'decision', decisionId: decision.id, kind: decision.kind, answer, ...(state !== undefined ? { state } : {}) })
}

// The decisions of a daily task the person's words outside a reply to the decision message may answer,
// newest first: the one asked last is the one they are answering.
const ANSWERABLE: readonly Decision['kind'][] = ['fix-confirm', 'integration-conflict', 'model-change-confirm', 'model-unavailable', 'no-progress']
export function openDailyDecision(task: TaskRecord): Decision | undefined {
  return Object.values(task.decisions)
    .filter(d => d.resolvedAt === undefined && ANSWERABLE.includes(d.kind))
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

// Carries out the person's answer to a daily task's decision and answers what to tell them. `unclear`
// says what happens when the words do not read as an answer: 'ask' (a reply to the decision message)
// answers a request to say it plainly; 'pass' (words that may be meant for the agent) answers null and
// changes nothing.
export async function applyDailyDecision(ctx: Ctx, task: TaskRecord, decision: Decision, text: string, unclear: 'ask' | 'pass'): Promise<string | null> {
  if (task.kind !== 'daily') throw new Error(`applyDailyDecision: task ${task.id} is a long task; its decisions run in the architect session`)
  if (decision.resolvedAt !== undefined) return unclear === 'pass' ? null : `这个问题已经处理过（${decision.answer ?? ''}）。`
  const input = [{ role: 'assistant' as const, content: decision.question }, { role: 'user' as const, content: text }]
  const jc = judgeCtx(ctx)
  const owner = task.owner.kind === 'agent' ? task.owner.agentId : null

  switch (decision.kind) {
    case 'integration-conflict':
    case 'fix-confirm': {
      const c = await choose(jc, APPROVE.instructions, APPROVE.choices, input)
      if (c.choice === 'unclear') return unclear === 'pass' ? null : '没有判断出你的意思，请直接回复“整合”或“不整合”。'
      if (c.choice === 'reject') {
        await resolve(ctx, task, decision, `reject: ${text}`)
        await ctx.reg.update(task.id, t => { t.state = 'paused'; t.pausedByUser = true }, { type: 'state', state: 'paused', reason: `${decision.kind} rejected` })
        const kept = workspaces(task).flatMap(w => (w.worktree !== null ? [w.worktree.path] : []))
        return kept.length > 0 ? `好的，不整合；改动保留在工作副本 ${kept.join('、')}。` : '好的，不接受这个结果；任务已暂停。'
      }
      await resolve(ctx, task, decision, `approve: ${text}`)
      // A question about a fixed answer, asked when the task had changed no files, settles the task alone.
      if (decision.kind === 'fix-confirm' && decision.data['change'] !== 'yes') {
        const now = await ctx.io.now()
        await ctx.reg.update(task.id, t => { t.state = 'done'; t.completedAt = now }, { type: 'state', state: 'done', reason: 'the person accepted the fixed result' })
        return '好的，已接受修复后的结果，任务完成。'
      }
      const r = await integrateDaily(ctx, (await ctx.reg.get(task.id))!)
      if (r.status === 'conflict') return '改动与项目当前的文件冲突，处理办法见刚发出的那条消息。'
      if (r.brought.length === 0) return '好的，任务完成；没有需要整合的改动。'
      return r.brought.length === 1
        ? `好的，已整合到 ${r.brought[0]!.root}：${r.brought[0]!.files.join('、')}`
        : `好的，已整合：${r.brought.map(o => `${o.root}（${o.files.join('、')}）`).join('；')}`
    }
    case 'route-confirm': {
      // Words outside a reply reach the assessment agent as its follow-up anyway: it owns the task.
      if (unclear === 'pass') return null
      const agentId = decision.data['agentId']
      if (agentId === undefined) throw new Error(`decision ${decision.id} names no assessment agent`)
      await wake(ctx, task, agentId, text, [])
      return '已转给评估子代理。'
    }
    case 'no-progress': {
      if (owner === null) throw new Error(`daily task ${task.id} has no executor`)
      await resolve(ctx, task, decision, text, 'running')
      await ctx.reg.update(task.id, t => { t.pausedByUser = false }, { type: 'state', state: 'running', reason: 'the person answered the no-progress report' })
      await wake(ctx, task, owner, `The person answered about the blocked task:\n${text}`, [])
      return '已把你的意见交给执行者，任务继续。'
    }
    case 'model-change-confirm':
    case 'model-unavailable': {
      const c = await choose(jc, REPLACE.instructions, REPLACE.choices, input)
      const agentId = decision.data['agentId']
      if (agentId === undefined) throw new Error(`decision ${decision.id} names no agent`)
      const previous = task.agents[agentId]
      if (previous === undefined) throw new Error(`decision ${decision.id}: agent ${agentId} is not on task ${task.id}`)
      if (c.choice === 'unclear') return unclear === 'pass' ? null : '没有判断出你的意思，请回复要改用的模型名（例如 Sol 6.1），或回复“等待”“继续”。'
      if (c.choice === 'wait') {
        const now = await ctx.io.now()
        await ctx.reg.update(task.id, t => { t.decisions[decision.id]!.answer = `wait: ${text}`; t.state = 'waiting-user' }, { type: 'decision', decisionId: decision.id, answer: 'wait', at: now })
        return '好的，先等待；之后回复“继续”或模型名即可。'
      }
      if (c.choice === 'continue') {
        await resolve(ctx, task, decision, `continue: ${text}`, 'running')
        await wake(ctx, task, agentId, `The person asks you to continue:\n${text}`, [])
        return '好的，原来的子代理继续。'
      }
      let model: string | null
      if (c.choice === 'suggested') {
        model = decision.data['model'] ?? null
        if (model === null) return '这个问题没有建议的模型，请回复要改用的模型名。'
      } else {
        const names = [
          ...Object.entries(ctx.rules.models).map(([id, m]) => ({ id, name: m.name })),
          ...ctx.catalog.picker.map(p => ({ id: canonical(p, ctx.catalog), name: '' })),
        ]
        model = namedModel(text, names)
        if (model === null) return unclear === 'pass' ? null : '没有识别出模型名，请直接回复模型名，例如 Sol 6.1 或 codex/gpt-6.1-sol。'
      }
      const effort = (decision.data['effort'] ?? previous.effort) as Effort
      await resolve(ctx, task, decision, `${model}: ${text}`, 'running')
      const blockerId = decision.kind === 'model-change-confirm' ? decision.data['blockerId'] : undefined
      if (blockerId !== undefined) {
        const now = await ctx.io.now()
        const to = model
        await ctx.reg.update(task.id, t => {
          const b = t.blockers[blockerId]
          if (b === undefined) throw new Error(`decision ${decision.id}: blocker ${blockerId} is not on task ${task.id}`)
          b.modelChanges += 1
          b.history.push({ at: now, step: 'model-change', agentId: decision.data['diagnosis'] ?? agentId, note: `${previous.model}/${previous.effort} → ${canonical(to, ctx.catalog)}/${effort} (confirmed by the person)` })
        }, { type: 'blocker', blockerId, modelChange: to, effort, confirmedBy: 'person' })
      }
      const words = text.replace(/\]/g, '）').replace(/\n+/g, ' ')
      await handOver(ctx, (await ctx.reg.get(task.id))!, previous, {
        model,
        efforts: [{ from: null, to: effort, reason: 'explicit', note: `the person chose ${model}` }],
        selection: { kind: 'user' as SelectionKind, reason: text, userConfirmation: text },
        reasonLine: `[model-reason user: ${words}]`,
        why: decision.kind === 'model-unavailable' ? `the model ${previous.model} was unavailable and the person chose ${model}` : `the person chose ${model} after an independent diagnosis`,
      })
      return `好的，改由 ${displayName(model, ctx.rules)}/${effort} 接手。`
    }
    case 'file-conflict':
    case 'interrupted':
      throw new Error(`a daily task has no ${decision.kind} decision`)
  }
}
