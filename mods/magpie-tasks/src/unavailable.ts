// A routed subagent whose model is unavailable or out of quota (plan section 9.16): Magpie has
// already retried and switched accounts, and the agent's turn ended on an API error. A substitute
// the routing table supports takes over after the person is told; with none, the person decides.
import type { ClassicHookInputs, TurnCompleteInput } from 'claude-code'
import { askDecision, handOver, tell } from './daily'
import { agentLabel, canonical, displayName, isAvailable, sameModel } from './model'
import { isHardWork, ownModels, ruleById, ruleModel, startEffort, substituteEffort, type Rule, type Rules } from './rules'
import type { Ctx } from './state'
import { EFFORTS, type AgentRecord, type Effort, type TaskRecord } from './types'

export type StopFailureInput = ClassicHookInputs['StopFailure']

export type UnavailableAction =
  | { action: 'substitute'; model: string; effort: Effort; substituteId: string }
  | { action: 'ask-user'; reason: 'user-chosen' | 'no-substitute'; candidates: string[] }

// The error categories after which another model may help; the rest (invalid_request,
// max_output_tokens, unknown, ...) are the request's own problem.
const UNAVAILABLE = new Set(['rate_limit', 'overloaded', 'server_error', 'billing_error', 'model_not_found', 'authentication_failed'])

export function isUnavailableError(kind: string | undefined): boolean {
  return kind !== undefined && UNAVAILABLE.has(kind)
}

// Magpie answers a model it cannot serve with HTTP 400 `invalid_request_error`, which Claude Code
// files as `unknown` (E14, 2026-11-09: "API Error: 400 Codex: The 'gpt-6-magpie-missing' model is
// not supported when using Codex with a ChatGPT account."). Antigravity refuses Claude Code's
// requests with a 429 "Resource has been exhausted" whatever quota is left, which Magpie passes on as
// a 400 (2026-11-12, Opus 5.5 and Argon through Antigravity). A 400 whose text says the model is not
// served, or that the provider's resource is exhausted, counts as `model_not_found`; every other
// category is kept as the engine gave it.
const MODEL_REFUSED = /\b400\b[\s\S]*(\bmodel\b[\s\S]*\b(not supported|not found|does not exist|is not available|unknown model)\b|\bResource has been exhausted\b)/i

export function stopFailureCategory(error: string, text: string | undefined): string {
  return (error === 'unknown' || error === 'invalid_request') && text !== undefined && MODEL_REFUSED.test(text) ? 'model_not_found' : error
}

// Every model the routing table offers for the agent's rule (the models the rule names, then all
// substitutes for the rule, automatic or not), Magpie lists, and that differs from the failed one.
function choices(agent: AgentRecord, rules: Rules, available: (id: string) => boolean, same: (x: string, y: string) => boolean): string[] {
  const out: string[] = []
  const add = (m: string) => {
    if (!same(m, agent.model) && available(m) && !out.some(o => same(o, m))) out.push(m)
  }
  const rule = agent.ruleId === null ? null : ruleById(rules, agent.ruleId)
  if (rule !== null) for (const m of ownModels(rule)) add(m)
  for (const sub of rules.substitutes) {
    if (sub.forRules !== '*' && (agent.ruleId === null || !sub.forRules.includes(agent.ruleId))) continue
    for (const o of sub.options) add(o.model)
  }
  return out
}

// The models the rule names, each with the effort a takeover starts at: first the one the rule
// chooses for the agent's own judgment, then its own model, hardModel and deepModel. The effort is the
// lowest level of the rule's raise order at or above both the model's start (the judgment's start for
// the chosen model, the deep start for a hardModel or deepModel) and the agent's current effort, so a
// takeover keeps the raises the work already needed.
function ownTakeovers(rule: Rule, agent: AgentRecord, rules: Rules): { model: string; effort: Effort }[] {
  const plain = ownModels(rule).map(m => ({ model: m, start: m === rule.model ? rule.effort! : startEffort(rule, true) }))
  const j = agent.judgment
  const chosen = j === null ? null : ruleModel(rule, { deep: j.deep, hard: isHardWork(j.deepP, rules) })
  const ordered = chosen === null ? plain : [{ model: chosen, start: startEffort(rule, j!.deep) }, ...plain.filter(t => t.model !== chosen)]
  const order = rule.raiseOrder!
  const at = (start: Effort) => {
    const floor = Math.max(EFFORTS.indexOf(start), EFFORTS.indexOf(agent.effort))
    return order.find(e => EFFORTS.indexOf(e) >= floor) ?? order[order.length - 1]!
  }
  return ordered.map(t => ({ model: t.model, effort: at(t.start) }))
}

// Plan section 9.16: the person's own choice is never replaced automatically; otherwise the models
// the rule names (ownTakeovers) other than the failed one, then the automatic substitutes for the
// rule, each at the effort the routing table gives for an automatic takeover.
export function unavailableAction(a: { agent: AgentRecord; rules: Rules; available: (id: string) => boolean; same: (x: string, y: string) => boolean }): UnavailableAction {
  const { agent, rules, available, same } = a
  if (agent.selection.kind === 'user') return { action: 'ask-user', reason: 'user-chosen', candidates: choices(agent, rules, available, same) }
  if (agent.ruleId !== null) {
    const rule = ruleById(rules, agent.ruleId)
    if (rule.effort !== null && rule.raiseOrder !== null) {
      for (const t of ownTakeovers(rule, agent, rules)) {
        if (!same(t.model, agent.model) && available(t.model)) return { action: 'substitute', model: t.model, effort: t.effort, substituteId: `rule:${rule.id}` }
      }
    }
    for (const sub of rules.substitutes) {
      if (!sub.auto || (sub.forRules !== '*' && !sub.forRules.includes(rule.id))) continue
      for (const o of sub.options) {
        if (same(o.model, agent.model) || !available(o.model)) continue
        const effort = substituteEffort(rules, sub, o.model, rule.id, agent.effort)
        if (effort === null) continue
        return { action: 'substitute', model: o.model, effort, substituteId: sub.id }
      }
    }
  }
  return { action: 'ask-user', reason: 'no-substitute', candidates: choices(agent, rules, available, same) }
}

export async function onStopFailure(ctx: Ctx, e: StopFailureInput): Promise<void> {
  const id = e.agent_id
  // The main conversation's category is kept under 'main' for the architect's and Router's turn end.
  const kind = stopFailureCategory(e.error, e.error_details ?? e.last_assistant_message)
  if (id === undefined) {
    ctx.st.stopFailures.set('main', kind)
    return
  }
  if (!ctx.st.agents.has(id)) return
  ctx.st.stopFailures.set(id, kind)
}

// The end of a routed agent's turn on an API error (plan section 9.16).
export async function onAgentError(ctx: Ctx, e: TurnCompleteInput): Promise<void> {
  const id = e.agentId
  if (e.reason !== 'error' || id === undefined) return
  const taskId = ctx.st.agents.get(id)
  if (taskId === undefined) return
  const kind = ctx.st.stopFailures.get(id)
  ctx.st.stopFailures.delete(id)
  const task = await ctx.reg.get(taskId)
  if (task === undefined) throw new Error(`task ${taskId} of agent ${id} is missing`)
  const agent = task.agents[id]
  if (agent === undefined) throw new Error(`agent ${id} is not on task ${taskId}`)
  const now = await ctx.io.now()
  const label = agent.name ?? id

  if (!isUnavailableError(kind)) {
    await ctx.reg.update(task.id, t => {
      const a = t.agents[id]!
      a.state = 'failed'
      a.failure = { at: now, kind: 'api-error', error: kind ?? 'unknown' }
    }, { type: 'error', agentId: id, kind: 'api-error', error: kind ?? null })
    if (task.kind === 'long') await appendNote(ctx, `magpie-tasks: the subagent ${label} (${agent.model}) ended on an API error (${kind ?? 'no StopFailure category'}); its model was not changed.`)
    throw new Error(`subagent ${label} (${agent.model}) ended on an API error: ${kind ?? 'no StopFailure category'}`)
  }

  await ctx.reg.update(task.id, t => {
    const a = t.agents[id]!
    a.state = 'failed'
    a.failure = { at: now, kind: 'model-unavailable', error: kind! }
  }, { type: 'unavailable', agentId: id, model: agent.model, error: kind })
  const action = unavailableAction({ agent, rules: ctx.rules, available: m => isAvailable(m, ctx.catalog), same: (x, y) => sameModel(x, y, ctx.catalog) })
  await ctx.reg.log(task.id, { type: 'unavailable', agentId: id, action: action.action, ...(action.action === 'substitute' ? { model: action.model, effort: action.effort, substituteId: action.substituteId } : { reason: action.reason, candidates: action.candidates }) })
  const fresh = (await ctx.reg.get(task.id))!
  const failedName = displayName(agent.model, ctx.rules)
  if (fresh.kind === 'long') return longTask(ctx, fresh, fresh.agents[id]!, kind!, action)
  return dailyTask(ctx, fresh, fresh.agents[id]!, kind!, action, failedName)
}

async function appendNote(ctx: Ctx, text: string): Promise<void> {
  const r = await ctx.host.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  if ('deny' in r && r.deny !== undefined) throw new Error(`session.append was refused: ${r.deny}`)
}

function candidateNames(ctx: Ctx, ids: string[]): string {
  return ids.length === 0 ? '没有' : ids.map(m => displayName(m, ctx.rules)).join('、')
}

async function dailyTask(ctx: Ctx, task: TaskRecord, agent: AgentRecord, kind: string, action: UnavailableAction, failedName: string): Promise<void> {
  if (agent.role === 'helper') {
    // A helper's parent agent sees the failure as its tool result and decides.
    await tell(ctx, task, `${agentLabel(agent, ctx.rules)} 不可用（${kind}），由它的上级子代理处理。`, { kind: 'magpie', notify: false })
    return
  }
  if (action.action === 'substitute') {
    const why = `${canonical(agent.model, ctx.catalog)} unavailable (${kind})`
    await tell(ctx, task, `${failedName} 不可用（${kind}），改由 ${displayName(action.model, ctx.rules)}/${action.effort} 接手。`, { kind: 'magpie', notify: true })
    await handOver(ctx, task, agent, {
      model: action.model,
      efforts: [{ from: null, to: action.effort, reason: 'rule', note: `takeover by ${action.substituteId}` }],
      selection: { kind: 'unavailable-substitute', reason: `${why}; substitute ${action.substituteId}` },
      reasonLine: `[model-reason evidence: ${why}]`,
      why: `its model ${agent.model} is unavailable (${kind})`,
    })
    return
  }
  const lead = action.reason === 'user-chosen'
    ? `「${task.title}」的${roleName(agent)}子代理使用你指定的 ${failedName}，这个模型现在不可用（${kind}）。`
    : `「${task.title}」的${roleName(agent)}子代理使用的 ${failedName} 不可用（${kind}），路由规则中没有可以自动接手的模型。`
  await askDecision(ctx, task, {
    kind: 'model-unavailable',
    question: `${lead}可以等待，或改用其他模型（可选：${candidateNames(ctx, action.candidates)}）。`,
    options: ['等待', ...action.candidates.map(m => `改用 ${displayName(m, ctx.rules)}`)],
    data: { agentId: agent.agentId, error: kind, effort: agent.effort, candidates: action.candidates.join(','), ...(action.candidates.length === 1 ? { model: action.candidates[0]! } : {}) },
  }, 'waiting-user')
}

function roleName(agent: AgentRecord): string {
  return { executor: '执行', implementer: '实施', assessment: '评估', acceptance: '验收', diagnosis: '诊断', helper: '辅助' }[agent.role]
}

// A long task's implementers are the architect's to replace: it is told the failure and the
// routing table's suggestion; the person is told too, and decides when there is no substitute.
async function longTask(ctx: Ctx, task: TaskRecord, agent: AgentRecord, kind: string, action: UnavailableAction): Promise<void> {
  const label = agent.name ?? agent.agentId
  const advice = action.action === 'substitute'
    ? `The routing table's takeover: ${action.model} at effort ${action.effort} (${action.substituteId}). To use it, delegate the remaining work with mcp__magpie-tasks__model_route, recommended_model ${action.model}, recommended_effort ${action.effort} and the reason "${canonical(agent.model, ctx.catalog)} is unavailable (${kind}); the routing table's substitute ${action.substituteId} takes over".`
    : action.reason === 'user-chosen'
      ? `The person chose this model, so it is not replaced automatically; the person decides (candidates: ${action.candidates.join(', ') || 'none'}).`
      : `No automatic substitute exists for rule ${agent.ruleId ?? 'none'}; the person decides (candidates: ${action.candidates.join(', ') || 'none'}).`
  await appendNote(ctx, `magpie-tasks: the subagent ${label} (${agent.model}) stopped because its model is unavailable (${kind}). ${advice}`)
  const failedName = displayName(agent.model, ctx.rules)
  if (action.action === 'substitute') {
    await tell(ctx, task, `「${task.title}」的${agentLabel(agent, ctx.rules)}不可用（${kind}）。路由表建议由 ${displayName(action.model, ctx.rules)}/${action.effort} 接手，由架构师安排。`, { kind: 'long', notify: true })
    return
  }
  await askDecision(ctx, task, {
    kind: 'model-unavailable',
    question: `「${task.title}」的${agentLabel(agent, ctx.rules)}不可用（${kind}）${action.reason === 'user-chosen' ? '，这是你指定的模型' : '，路由规则中没有可以自动接手的模型'}。可以等待，或改用其他模型（可选：${candidateNames(ctx, action.candidates)}）。`,
    options: ['等待', ...action.candidates.map(m => `改用 ${displayName(m, ctx.rules)}`)],
    data: { agentId: agent.agentId, error: kind, effort: agent.effort, candidates: action.candidates.join(',') },
  }, 'waiting-user')
}
