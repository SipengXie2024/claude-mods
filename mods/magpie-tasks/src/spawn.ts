// Subagent routing (plan sections 5, 9.6, 9.7): the model, effort and working directory of every
// subagent a managed session starts, the resume check at turn.start and the effort of each request
// at turn.step.
import type { AgentSpawnInput, AgentSpawnResult, Next, TurnStartInput, TurnStepInput } from 'claude-code'
import { parseEffortLine, parseMarker, parseModelLine, parseModelReason, parseRequestHeader, parseReviewOf, placingOf, requestText, withRouting, assessmentBrief, type MarkerInfo } from './brief'
import { subagentDialogue, type ApiMessage } from './dialogue'
import { newId } from './io'
import { delegationInput } from './delegation'
import { decideRule, judgeDeep, judgeSpawn, type JudgeCtx } from './judge'
import { canonical, clampEffort, displayName, isAvailable, nameLevel, requestId, sameModelAnyProvider, type ModelCatalog } from './model'
import { borderPair, isHardWork, raise, raiseOnRule, reviewSecondTarget, ruleById, ruleModel, startEffort, type Rule, type Rules } from './rules'
import type { Ctx } from './state'
import { EFFORTS, type AgentRecord, type AgentRole, type Effort, type EffortChange, type JevJudgment, type RaiseReason, type SelectionKind, type SessionState, type TaskRecord } from './types'
import { noteExecutorTurn, tell } from './daily'
import { workspaceOf } from './workspace'

export type SpawnDecision =
  | { action: 'pass' }
  | { action: 'deny'; reason: string }
  | { action: 'route' | 'assess'; rewrite: { prompt: string; model: string; cwd?: string; description: string }; agent: Omit<AgentRecord, 'agentId' | 'startedAt'>; notice: string; requestedModel?: { model: string; reason: string } }

// A task as routing reads it. A daily task is decided on before its first agent exists, so its
// owner (that agent) is not part of what routing needs.
export type RoutedTask = Omit<TaskRecord, 'owner'>

const MISSING_REASON = 'An explicit model needs the person\'s words: add "[model-reason user: <the person\'s words>]" when the person chose it. To recommend a model yourself, delegate with mcp__magpie-tasks__model_route, where Jev weighs your recommendation against the routing table; or leave the model out so the routing rules choose.'

// The origin decideSpawn gets from the model-route tool (route.ts): the only caller whose brief may
// carry an evidence reason, since the tool has Jev weigh the recommendation first.
export const ROUTE_ORIGIN = 'model-route'
const RECOMMEND_THROUGH_TOOL = 'A model you recommend goes through mcp__magpie-tasks__model_route (recommended_model, reason), where Jev weighs it against the routing table\'s choice. Delegate with that tool, or leave the model out so the routing rules choose.'

export function judgeCtx(ctx: Ctx): JudgeCtx {
  return {
    io: ctx.io,
    jev: { url: ctx.opts.jevUrl, model: ctx.opts.jevModel, keyFile: ctx.opts.jevKeyFile, deadlineMs: ctx.opts.jevDeadlineMs },
    complete: (request, options) => ctx.host.model.complete(request, options),
    evaluatorModel: ctx.opts.evaluatorModel,
    rules: ctx.rules,
  }
}

// subagent-opus rewrites an unnamed model to `opus` under a Fable or Mythos parent (plan section 1);
// without a reason line that is no explicit choice.
function explicitModel(e: AgentSpawnInput): string | undefined {
  const line = parseModelLine(e.prompt)
  if (line !== null) return line
  if (e.model === undefined) return undefined
  if (e.model === 'opus' && /fable|mythos/i.test(e.parentModel) && parseModelReason(e.prompt) === null) return undefined
  return e.model
}

// The outcomes decided before any judgment (plan section 9.6 steps 1–3 and 6): spawns the plugin
// leaves alone, and an explicit model without a reason. Null: the spawn is routed.
export function spawnPrecheck(a: { e: AgentSpawnInput; origin: string; task: RoutedTask | null }): SpawnDecision | null {
  const { e } = a
  if (e.fork || e.workflow !== undefined || e.isTeammate === true || e.resume !== undefined) return { action: 'pass' }
  if (a.origin === 'magpie-tasks') return { action: 'pass' }
  if (a.task === null) return { action: 'pass' }
  if (explicitModel(e) !== undefined && parseModelReason(e.prompt) === null) return { action: 'deny', reason: MISSING_REASON }
  return null
}

function rank(e: Effort): number {
  return EFFORTS.indexOf(e)
}

function ruleChanges(rule: Rule, deep: boolean): Omit<EffortChange, 'at'>[] {
  if (rule.effort === null) throw new Error(`routing rules: rule ${rule.id} has no start effort`)
  const out: Omit<EffortChange, 'at'>[] = [{ from: null, to: rule.effort, reason: 'rule' }]
  const deepStart = startEffort(rule, true)
  if (deep && deepStart !== rule.effort) out.push({ from: rule.effort, to: deepStart, reason: 'deep' })
  return out
}

function jevText(j: JevJudgment): string {
  const by = j.provider === 'jev' ? 'Jev' : `the substitute evaluator (Jev failed: ${j.substituteReason ?? 'unknown'})`
  return `${by}: rule ${j.ruleChoice}, confidence ${j.confidence.toFixed(2)}, deep ${j.deep ? 'yes' : 'no'}${j.deepP === null ? '' : ` (p ${j.deepP.toFixed(2)})`}`
}

function dailyNotice(kind: SelectionKind, a: { name: string; effort: Effort; ruleId: string | null; reason: string; judgment: JevJudgment; hard: boolean; reviewOf?: string[]; border?: NonNullable<ReturnType<typeof borderPair>> }, rules: Rules): string {
  const j = a.judgment
  const sub = j.provider === 'substitute' ? '；由评估模型代为判断' : ''
  if (kind === 'ambiguous' && a.border !== undefined) return `模型：${a.name} · ${a.effort} · 规则拿不准（Jev 在 ${a.border.first.ruleId} ${a.border.first.p.toFixed(2)} 与 ${a.border.second.ruleId} ${a.border.second.p.toFixed(2)} 之间，两条规则用的模型不同），从 ${rules.ambiguous.candidates.map(c => displayName(c.model, rules)).join('、')} 中随机选取`
  if (kind === 'user') return `模型：${a.name} · ${a.effort} · 用户指定：${a.reason}`
  if (kind === 'adjusted') return `模型：${a.name} · ${a.effort} · 依据证据调整：${a.reason}`
  if (kind === 'review-second') return `模型：${a.name} · ${a.effort} · 规则 review-second（复核 ${(a.reviewOf ?? []).map(m => displayName(m, rules)).join('、')}）${sub}`
  if (a.ruleId === 'daily-default') return `模型：${a.name} · ${a.effort} · 没有匹配的路由规则，用日常默认模型（${j.provider === 'jev' ? 'Jev 首选' : '评估模型首选'} ${j.ruleChoice}，置信度 ${j.confidence.toFixed(2)}${j.deep ? '；需要深入推理' : ''}）`
  const largest = a.hard && j.deepP !== null ? `；深入推理概率 ${j.deepP.toFixed(2)}，达到 ${rules.thresholds.hardYes}，属于这类工作中规模最大的` : ''
  return `模型：${a.name} · ${a.effort} · 规则 ${a.ruleId}（Jev 置信度 ${j.confidence.toFixed(2)}${j.deep ? '；需要深入推理' : ''}${largest}${sub}）`
}

// Plan section 9.6 steps 4–10 for one spawn whose brief has been judged.
// `rand` (uniform in [0, 1)) draws the model for work on a rule border (Rules.ambiguous).
export function decideSpawn(a: { e: AgentSpawnInput; origin: string; task: RoutedTask | null; judgment: JevJudgment | null; rules: Rules; catalog: ModelCatalog; lookupAgentModel: (agentId: string) => string | undefined; session: { id: string; cwd: string }; rand: () => number }): SpawnDecision {
  const pre = spawnPrecheck(a)
  if (pre !== null) return pre
  const { e, rules, catalog } = a
  const task = a.task!
  const judgment = a.judgment
  if (judgment === null) throw new Error('decideSpawn: the brief has not been judged')
  const daily = task.kind === 'daily'
  const parent = e.parentAgentId !== undefined ? task.agents[e.parentAgentId] : undefined
  const role: AgentRole = e.parentAgentId !== undefined ? 'helper' : daily ? 'executor' : 'implementer'
  // An independent review needs another model, whichever provider serves the reviewed one.
  const sameAnyProvider = (x: string, y: string) => sameModelAnyProvider(x, y, catalog)
  const available = (id: string) => isAvailable(id, catalog)
  const decided = decideRule(judgment, rules)
  const border = 'none' in decided ? borderPair(judgment, rules) : null
  const deep = judgment.deep
  const hard = isHardWork(judgment.deepP, rules)
  // Whether the rule's hardModel took the work (set in the rule branch).
  let hardUsed = false

  // The task's working directory: a long task's helper works where its parent does (a separate copy
  // when the parent has one), every other agent in the task's working directory (the task worktree,
  // or the project directory of a direct task).
  const worktree = parent?.worktree ?? workspaceOf(task)
  const cwd = worktree ?? e.cwd ?? a.session.cwd

  // The daily task's first agent turns into the routing assessment when routing cannot decide; a
  // long task's architect, or an agent delegating inside a task, is told why and decides itself.
  const refuse = (reason: string, chosen?: { model: string; reason: string }): SpawnDecision => {
    if (role === 'executor') return assess(reason, chosen)
    return { action: 'deny', reason }
  }

  // `chosen`: the model the person asked for, whose effort no rule gives; the assessment recommends
  // its effort, and the person confirms.
  const assess = (why: string, chosen?: { model: string; reason: string }): SpawnDecision => {
    const rule = ruleById(rules, 'route-assessment')
    const model = rule.model!
    const efforts = ruleChanges(rule, deep)
    const effort = efforts[efforts.length - 1]!.to
    const m: MarkerInfo = { taskId: task.id, role: 'assessment', ruleId: rule.id, rulesVersion: rules.version, model: canonical(model, catalog), effort }
    const agent: Omit<AgentRecord, 'agentId' | 'startedAt'> = {
      ...(e.name !== undefined ? { name: e.name } : {}),
    ...(e.description ? { description: e.description } : {}),
      role: 'assessment',
      sessionId: a.session.id,
      ruleId: rule.id,
      rulesVersion: rules.version,
      selection: { kind: 'rule', reason: chosen === undefined
        ? `no routing decision for this daily task (${why}); route-assessment recommends a model for the person to confirm`
        : `the person chose ${chosen.model} (${chosen.reason}) and no rule gives its effort (${why}); route-assessment recommends the effort for the person to confirm` },
      judgment,
      model: m.model,
      effort,
      efforts: efforts.map(c => ({ ...c })) as EffortChange[],
      contextSource: 'brief',
      cwd: e.cwd ?? a.session.cwd,
      worktree: null,
      state: 'running',
      pendingRaises: [],
      filesTouched: [],
      reports: [],
    }
    return {
      action: 'assess',
      rewrite: { prompt: withRouting(assessmentBrief(task, rules, chosen), m, { cwd: null, daily: true, direct: null, also: [] }), model: requestId(model, catalog), description: `${e.description} · ${displayName(model, rules)}/${effort}` },
      agent,
      ...(chosen !== undefined ? { requestedModel: chosen } : {}),
      notice: chosen === undefined
        ? `没有可以直接采用的路由规则（${judgment.provider === 'jev' ? 'Jev' : '评估模型'}首选 ${judgment.ruleChoice}，置信度 ${judgment.confidence.toFixed(2)}），先由评估子代理推荐模型：${displayName(model, rules)} · ${effort}`
        : `用户指定 ${displayName(chosen.model, rules)}：${chosen.reason}。路由规则没有给出这个模型在本任务上的思考强度（${judgment.provider === 'jev' ? 'Jev' : '评估模型'}首选 ${judgment.ruleChoice}，置信度 ${judgment.confidence.toFixed(2)}），先由评估子代理（${displayName(model, rules)} · ${effort}）推荐 ${displayName(chosen.model, rules)} 的思考强度`,
    }
  }

  let model: string
  let ruleId: string | null
  let efforts: Omit<EffortChange, 'at'>[]
  let selection: AgentRecord['selection']
  let reviewOf: string[] | undefined

  const chosen = explicitModel(e)
  const reason = parseModelReason(e.prompt)
  const effortLine = parseEffortLine(e.prompt)
  const review = parseReviewOf(e.prompt)

  if (chosen !== undefined && reason !== null) {
    const kind: SelectionKind = reason.kind === 'user' ? 'user' : 'adjusted'
    if (kind === 'adjusted' && a.origin !== ROUTE_ORIGIN) return { action: 'deny', reason: RECOMMEND_THROUGH_TOOL }
    if (kind === 'adjusted' && !available(chosen)) {
      return { action: 'deny', reason: `The recommended model ${chosen} is not in Magpie's model list; recommend a listed model, or leave the recommendation out so the routing rules choose.` }
    }
    model = canonical(chosen, catalog)
    ruleId = 'ruleId' in decided ? decided.ruleId : null
    const rule = ruleId === null ? null : ruleById(rules, ruleId)
    const level = nameLevel(model)
    if (effortLine !== null) efforts = [{ from: null, to: effortLine, reason: 'explicit' }]
    else if (level !== null) efforts = [{ from: null, to: level, reason: 'explicit', note: atLevel(level) }]
    else if (rule !== null && rule.effort !== null) efforts = ruleChanges(rule, deep)
    else return refuse(`An explicit model with no matching routing rule needs its effort: add "[effort <low|medium|high|xhigh|max>]" to the brief (${'none' in decided ? decided.none : `rule ${ruleId} has no start effort`}).`, kind === 'user' ? { model, reason: reason.text } : undefined)
    selection = { kind, reason: reason.text, ...(kind === 'user' ? { userConfirmation: reason.text } : {}) }
  } else if (review !== null || ('ruleId' in decided && decided.ruleId === 'review-second')) {
    if (review === null) return refuse('Jev matched review-second (an independent second review), which needs the reviewed work named: add "[review-of agent=<agentId>]" or "[review-of model=<id>,<id>]" to the brief.')
    const originals: string[] = review.models.map(m => canonical(m, catalog))
    for (const id of review.agents) {
      const m = a.lookupAgentModel(id)
      if (m === undefined) return { action: 'deny', reason: `[review-of agent=${id}] names no agent of this task on record; name the reviewed model with [review-of model=<id>] instead.` }
      originals.push(canonical(m, catalog))
    }
    if (originals.length === 0) return refuse('The [review-of …] line names no agent or model.')
    const target = reviewSecondTarget(rules, originals, available, sameAnyProvider)
    if ('none' in target) return refuse(`No model is left for an independent second review: ${target.none}. Tell the person and ask how to proceed.`)
    model = target.model
    ruleId = 'review-second'
    efforts = ruleChanges(ruleById(rules, 'review-second'), deep)
    reviewOf = originals
    selection = { kind: 'review-second', reason: `independent second review of ${originals.join(', ')}` }
  } else if ('ruleId' in decided) {
    const rule = ruleById(rules, decided.ruleId)
    const ruleChosen = ruleModel(rule, { deep, hard })
    if (!available(ruleChosen)) return refuse(`Rule ${rule.id} names ${ruleChosen}, which is not in Magpie's model list; recommend a model with mcp__magpie-tasks__model_route, or tell the person.`)
    model = ruleChosen
    ruleId = rule.id
    efforts = ruleChanges(rule, deep)
    hardUsed = rule.hardModel !== null && ruleChosen === rule.hardModel
    selection = { kind: 'rule', reason: `rule ${rule.id}: ${rule.condition}${hardUsed ? `; Jev's deep probability ${judgment.deepP!.toFixed(2)} reaches ${rules.thresholds.hardYes}, the largest work of this rule` : ''}` }
  } else if (border !== null) {
    const pool = rules.ambiguous.candidates.filter(c => available(c.model))
    if (pool.length === 0) return refuse(`Jev hangs between rules ${border.first.ruleId} and ${border.second.ruleId}, and none of the models the routing rules draw from for such work (${rules.ambiguous.candidates.map(c => c.model).join(', ')}) is in Magpie's model list.`)
    const pick = pool[Math.min(pool.length - 1, Math.floor(a.rand() * pool.length))]!
    model = pick.model
    ruleId = null
    efforts = [{ from: null, to: pick.effort, reason: 'rule' }]
    const left = rules.ambiguous.candidates.filter(c => !pool.includes(c)).map(c => c.model)
    selection = { kind: 'ambiguous', reason: `Jev hangs between rule ${border.first.ruleId} (${border.first.p.toFixed(2)}) and rule ${border.second.ruleId} (${border.second.p.toFixed(2)}), whose models differ; ${pick.model} at ${pick.effort} drawn at random from ${pool.map(c => c.model).join(', ')}${left.length > 0 ? ` (not in Magpie's model list: ${left.join(', ')})` : ''}` }
  } else if (role === 'executor') {
    // A daily request no rule fits runs on the general default model, without an assessment or a
    // confirmation (the person's decision, 2026-11-10).
    const rule = ruleById(rules, 'daily-default')
    if (rule.model === null) throw new Error('routing rules: rule daily-default has no model')
    if (!available(rule.model)) return refuse(`Rule daily-default names ${rule.model}, which is not in Magpie's model list.`)
    model = rule.model
    ruleId = rule.id
    efforts = ruleChanges(rule, deep)
    selection = { kind: 'rule', reason: `no routing rule fits (${decided.none}); rule daily-default: ${rule.condition}` }
  } else {
    return refuse(`No routing rule fits this brief (${decided.none}). Add the task's conditions (deliverable, acceptance, capabilities) and delegate again, or recommend a model and its effort with mcp__magpie-tasks__model_route, where Jev judges whether the recommendation suits the task.`)
  }

  efforts = startAtLevel(model, efforts)
  const effort = efforts[efforts.length - 1]!.to
  const m: MarkerInfo = { taskId: task.id, role, ruleId, rulesVersion: rules.version, model, effort }
  const agent: Omit<AgentRecord, 'agentId' | 'startedAt'> = {
    ...(e.name !== undefined ? { name: e.name } : {}),
    ...(e.description ? { description: e.description } : {}),
    role,
    ...(e.parentAgentId !== undefined ? { parentAgentId: e.parentAgentId } : {}),
    sessionId: a.session.id,
    ruleId,
    rulesVersion: rules.version,
    selection,
    judgment,
    model,
    effort,
    efforts: efforts as EffortChange[],
    ...(reviewOf !== undefined ? { reviewOf } : {}),
    contextSource: 'brief',
    cwd,
    worktree,
    state: 'running',
    pendingRaises: [],
    filesTouched: [],
    reports: [],
  }
  const name = displayName(model, rules)
  const notice = daily
    ? dailyNotice(selection.kind, { name, effort, ruleId, reason: selection.reason, judgment, hard: hardUsed, ...(reviewOf ? { reviewOf } : {}), ...(selection.kind === 'ambiguous' && border !== null ? { border } : {}) }, rules)
    : `magpie-tasks routed the subagent "${e.description}" (${role}) to ${name} (${model}) at effort ${effort}; rule ${ruleId ?? 'none'} (${rules.version}); selection ${selection.kind}: ${selection.reason}. ${jevText(judgment)}.`
  return {
    action: 'route',
    rewrite: { prompt: withRouting(e.prompt, m, placingOf(task, worktree)), model: requestId(model, catalog), ...(worktree !== null ? { cwd: worktree } : {}), description: `${e.description} · ${name}/${effort}` },
    agent,
    notice,
  }
}

// The record of a daily task a tg-router request starts (plan section 9.6 step 4), before its first
// agent exists.
export function dailyTaskDraft(a: { prompt: string; description: string; id: string; now: number }): RoutedTask & { header: { chatId: string; messageId: number; worker: string } } {
  const header = parseRequestHeader(a.prompt)
  if (header === null) throw new Error('dailyTaskDraft: the brief has no tg-router request header')
  const request = requestText(a.prompt)
  // tg-router starts the worker with its own short title as the Agent description; it names the
  // whole request, where a cut of the person's words can stop mid-phrase.
  const title = a.description.trim()
  if (title === '') throw new Error('dailyTaskDraft: the worker was started without a title')
  return {
    schema: 1,
    id: a.id,
    kind: 'daily',
    title,
    state: 'running',
    pausedByUser: false,
    createdAt: a.now,
    updatedAt: a.now,
    request,
    followUps: [],
    project: null,
    worktree: null,
    extraWorktrees: {},
    telegram: header.chatId === 'tui' ? null : { chatId: header.chatId, rootMessageId: header.messageId, workerName: header.worker },
    agents: {},
    blockers: {},
    decisions: {},
    deliverables: [],
    feedback: [],
    ratings: [],
    pendingRelays: {},
    header,
  }
}

export async function onAgentSpawn(ctx: Ctx, e: AgentSpawnInput, next: Next<'agent.spawn'>): Promise<AgentSpawnResult> {
  const { st, reg } = ctx
  const origin = next.origin.plugin
  let task: RoutedTask | null = null
  let draft: ReturnType<typeof dailyTaskDraft> | null = null
  if (st.role === 'architect') {
    if (st.taskId === null) throw new Error('architect session without a task id')
    task = await reg.get(st.taskId) ?? null
    if (task === null) throw new Error(`task ${st.taskId} of this architect session is missing`)
  } else if (st.role === 'router') {
    if (e.parentAgentId === undefined && parseRequestHeader(e.prompt) !== null) {
      draft = dailyTaskDraft({ prompt: e.prompt, description: e.description, id: newId('d', await ctx.io.now()), now: await ctx.io.now() })
      task = draft
    } else if (e.parentAgentId !== undefined && st.agents.has(e.parentAgentId)) {
      const id = st.agents.get(e.parentAgentId)!
      task = await reg.get(id) ?? null
      if (task === null) throw new Error(`task ${id} of agent ${e.parentAgentId} is missing`)
    }
  }
  const pre = spawnPrecheck({ e, origin, task })
  if (pre !== null) {
    if (pre.action === 'deny') return { deny: pre.reason }
    // The plugin's own spawn (daily.ts relay) carries no model, since the Agent tool's input takes
    // only aliases; the model decided for it is the one its marker names.
    const own = origin === 'magpie-tasks' && e.resume === undefined ? parseMarker(e.prompt) : null
    return own === null ? next(e) : next({ ...e, model: requestId(own.model, ctx.catalog) })
  }

  let judgment: JevJudgment
  try {
    judgment = await judgeSpawn(judgeCtx(ctx), await delegationInput(ctx, e.prompt, e.parentAgentId))
  } catch (error) {
    return { deny: `magpie-tasks could not judge the routing rule: ${(error as Error).message.split('\n')[0]}` }
  }
  const routed = task!
  const d = decideSpawn({
    e, origin, task: routed, judgment, rules: ctx.rules, catalog: ctx.catalog, rand: Math.random,
    lookupAgentModel: id => routed.agents[id]?.model,
    session: { id: st.sessionId, cwd: st.cwd },
  })
  if (d.action === 'pass') return next(e)
  if (d.action === 'deny') return { deny: d.reason }

  const r = await next({ ...e, prompt: d.rewrite.prompt, model: d.rewrite.model, description: d.rewrite.description, ...(d.rewrite.cwd !== undefined ? { cwd: d.rewrite.cwd } : {}) })
  if (r.deny !== undefined) return r
  if (r.agentId === undefined) throw new Error('agent.spawn settled without an agentId for a routed subagent')
  const agentId = r.agentId
  registerStarted(st, agentId, markerFor(draft?.id ?? routed.id, d.agent))
  const record: AgentRecord = { ...d.agent, agentId, startedAt: await ctx.io.now() }
  const log = { type: 'spawn', agentId, role: record.role, ruleId: record.ruleId, model: record.model, effort: record.effort, selection: record.selection.kind, action: d.action }
  let saved: TaskRecord
  if (draft !== null) {
    const { header, schema: _s, createdAt: _c, updatedAt: _u, ...rest } = draft
    await reg.create({ ...rest, owner: { kind: 'agent', agentId, workerName: header.worker, routerSessionId: st.sessionId }, agents: { [agentId]: record }, ...(d.requestedModel !== undefined ? { requestedModel: d.requestedModel } : {}) })
    await reg.log(draft.id, log)
    saved = (await reg.get(draft.id))!
  } else {
    saved = await reg.update(routed.id, t => {
      t.agents[agentId] = record
      if (d.requestedModel !== undefined) t.requestedModel = d.requestedModel
    }, log)
  }
  unrecorded.delete(agentId)

  if (saved.kind === 'daily') {
    if (draft !== null) {
      const worker = draft.header.worker
      await reg.updateIndex(x => {
        x.workers[worker] = { taskId: saved.id, ownerAgentId: agentId, long: false }
        x.agents[agentId] = worker
      })
      await tell(ctx, saved, d.notice, { kind: 'magpie', notify: false, replyTo: draft.header.messageId })
    }
  } else {
    const shown = await ctx.host.session.append({ message: { type: 'user', content: [{ type: 'text', text: d.notice }] } })
    if ('deny' in shown && shown.deny !== undefined) throw new Error(`the routing note for agent ${agentId} was refused: ${shown.deny}`)
  }
  return r
}

// Routed agents that started in this process but whose record may not be in the registry yet: the
// spawn resolves once the agent started, and its record is written after several awaited steps, so
// the agent's first turn.start and turn.step can come first. Keyed by agentId, with the marker the
// agent's brief starts with.
const unrecorded = new Map<string, MarkerInfo>()
// Agents whose first turn.start arrived before their spawn resolved.
const firstTurnSeen = new Set<string>()

// Registers a routed agent the moment its spawn resolves, before any await (plan sections 9.6 step 11
// and 9.8): its next turn is its first unless turn.start already saw that one.
export function registerStarted(st: SessionState, agentId: string, m: MarkerInfo): void {
  st.agents.set(agentId, m.taskId)
  unrecorded.set(agentId, m)
  if (!firstTurnSeen.delete(agentId)) st.freshSpawn.add(agentId)
}

// The record of a started agent is in the registry.
export function markRecorded(agentId: string): void {
  unrecorded.delete(agentId)
}

// The marker of a routed agent that started in this process and whose record is not in the registry
// yet; undefined once it is (or for an agent this process did not start).
export function startedMarker(agentId: string): MarkerInfo | undefined {
  return unrecorded.get(agentId)
}

// Plan section 9.7: a routed agent's turn that did not start right after its spawn is a resume. An
// agent this process has not registered yet whose run begins with the task marker is a routed agent
// whose spawn has not resolved: this is its first turn.
// Returns whether the turn is a resume.
export function turnStarted(st: SessionState, agentId: string, text: string): boolean {
  if (!st.agents.has(agentId)) {
    const m = parseMarker(text)
    if (m === null) return false
    st.agents.set(agentId, m.taskId)
    unrecorded.set(agentId, m)
    firstTurnSeen.add(agentId)
    return false
  }
  if (st.freshSpawn.delete(agentId)) return false
  st.pendingReask.set(agentId, text)
  return true
}

export async function onTurnStart(ctx: Ctx, e: TurnStartInput): Promise<void> {
  if (e.agentId !== undefined && turnStarted(ctx.st, e.agentId, e.text)) await noteExecutorTurn(ctx, e.agentId)
}

const atLevel = (level: Effort) => `the model runs at ${level}, the level its ID names`

function withNote(c: Omit<EffortChange, 'at'>, note: string): Omit<EffortChange, 'at'> {
  return { ...c, note: c.note === undefined ? note : `${c.note}; ${note}` }
}

// A model whose ID names its level (nameLevel) runs at that level whatever effort it is given: the
// start is the level, noting another one asked for; a deep start changes nothing and is left out; a
// raise stays on record from and to the level, so calibration still counts the failure behind it.
export function startAtLevel(model: string, changes: Omit<EffortChange, 'at'>[]): Omit<EffortChange, 'at'>[] {
  if (changes.length === 0) throw new Error(`no start effort for ${model}`)
  const level = nameLevel(model)
  if (level === null) return changes
  const [first, ...rest] = changes as [Omit<EffortChange, 'at'>, ...Omit<EffortChange, 'at'>[]]
  const start = first.to === level ? first : withNote({ ...first, to: level }, `${first.to} asked; ${atLevel(level)}`)
  return [start, ...rest.filter(c => c.reason !== 'deep' && c.reason !== 'resume-deep').map(c => withNote({ ...c, from: level, to: level }, atLevel(level)))]
}

// Plan section 5. The resume step: max(current, startEffort(rule, new deep judgment)) for an agent
// with a rule that has a start effort; an agent without one keeps its explicit start effort or its
// current one as the base. A resume never lowers the effort. Each raise then adds one level, max at most.
// `level`: the level the agent's model ID names, which neither a resume nor a raise changes.
export function nextEffort(a: { rule: Rule | null; current: Effort; deep: boolean | null; raises: RaiseReason[]; explicit?: Effort; level?: Effort | null }): { effort: Effort; changes: Omit<EffortChange, 'at'>[] } {
  const level = a.level ?? null
  if (level !== null) {
    if (a.current !== level) throw new Error(`an agent on a model that runs at ${level} is recorded at ${a.current}`)
    return { effort: level, changes: a.raises.map(reason => ({ from: level, to: level, reason, note: atLevel(level) })) }
  }
  const changes: Omit<EffortChange, 'at'>[] = []
  let effort = a.current
  if (a.deep !== null) {
    const base = a.rule !== null && a.rule.effort !== null ? startEffort(a.rule, a.deep) : (a.explicit ?? a.current)
    if (rank(base) > rank(effort)) {
      changes.push({ from: effort, to: base, reason: 'resume-deep' })
      effort = base
    }
  }
  for (const reason of a.raises) {
    const to = a.rule !== null && a.rule.raiseOrder !== null ? raiseOnRule(a.rule, effort) : raise(effort)
    changes.push(to === effort ? { from: effort, to, reason, note: 'already at the top of the raise order' } : { from: effort, to, reason })
    effort = to
  }
  return { effort, changes }
}

// The model, effort and rule of each routed agent's requests in this process, set at the first step
// of a turn.
const turnEffort = new Map<string, { model: string; effort: Effort; ruleId: string | null }>()

// The rule a routed agent's requests run under, for the band above the prompt; undefined before its
// first step in this process.
export function turnRule(agentId: string): string | null | undefined {
  return turnEffort.get(agentId)?.ruleId
}

export async function onTurnStep(ctx: Ctx, e: TurnStepInput): Promise<Effort | undefined> {
  const id = e.agentId
  if (id === undefined || !ctx.st.agents.has(id)) return undefined
  const known = turnEffort.get(id)
  if (e.index !== 0 && known !== undefined) return clampEffort(known.model, known.effort, ctx.catalog)

  const found = await ctx.reg.byAgent(id)
  if (found === undefined) {
    // The first turn of an agent whose record is still being written: no resume and no raise can be
    // pending, so it runs at the start effort its marker carries.
    const m = unrecorded.get(id)
    if (m === undefined || ctx.st.pendingReask.has(id) || (ctx.st.pendingRaises.get(id) ?? []).length > 0) throw new Error(`routed agent ${id} has no record`)
    turnEffort.set(id, { model: m.model, effort: m.effort, ruleId: m.ruleId })
    return clampEffort(m.model, m.effort, ctx.catalog)
  }
  unrecorded.delete(id)
  const { task, agent } = found
  if (e.index !== 0) {
    turnEffort.set(id, { model: agent.model, effort: agent.effort, ruleId: agent.ruleId })
    return clampEffort(agent.model, agent.effort, ctx.catalog)
  }

  const reask = ctx.st.pendingReask.get(id)
  const raises = [...agent.pendingRaises]
  for (const r of ctx.st.pendingRaises.get(id) ?? []) if (!raises.includes(r)) raises.push(r)
  let deep: { deep: boolean; p: number | null; provider: 'jev' | 'substitute' } | null = null
  if (reask !== undefined) {
    const api = await ctx.host.session.messages({ agentId: id, as: 'api' })
    if (!Array.isArray(api)) throw new Error(`messages of agent ${id}: ${api.deny}`)
    deep = await judgeDeep(judgeCtx(ctx), subagentDialogue(api as ApiMessage[]))
  }
  const explicit = agent.efforts.find(c => c.reason === 'explicit')?.to
  const rule = agent.ruleId === null ? null : ruleById(ctx.rules, agent.ruleId)
  const next = nextEffort({ rule, current: agent.effort, deep: deep?.deep ?? null, raises, level: nameLevel(agent.model), ...(explicit !== undefined ? { explicit } : {}) })
  if (next.changes.length > 0 || agent.pendingRaises.length > 0 || deep !== null) {
    const at = await ctx.io.now()
    await ctx.reg.update(task.id, t => {
      const a = t.agents[id]!
      a.effort = next.effort
      a.efforts.push(...next.changes.map(c => ({ ...c, at })))
      a.pendingRaises = []
      a.state = 'running'
    }, { type: 'effort', agentId: id, from: agent.effort, to: next.effort, reasons: next.changes.map(c => c.reason), ...(deep !== null ? { deep: deep.deep, deepP: deep.p, provider: deep.provider } : {}) })
  }
  ctx.st.pendingReask.delete(id)
  ctx.st.pendingRaises.delete(id)
  turnEffort.set(id, { model: agent.model, effort: next.effort, ruleId: agent.ruleId })
  return clampEffort(agent.model, next.effort, ctx.catalog)
}

// The marker for an agent record, as the plugin writes it into every routed brief.
export function markerFor(taskId: string, agent: Pick<AgentRecord, 'role' | 'ruleId' | 'rulesVersion' | 'model' | 'effort'>): MarkerInfo {
  return { taskId, role: agent.role, ruleId: agent.ruleId, rulesVersion: agent.rulesVersion, model: agent.model, effort: agent.effort }
}
