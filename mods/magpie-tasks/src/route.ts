// The architect's delegation tool, mcp__magpie-tasks__model_route (plan section 9.6). Jev judges which
// routing rule fits the brief and whether it needs deep reasoning, and the routing table gives the
// model and effort. The architect may recommend a model with a reason; Jev weighs the recommendation
// against the table's choice, and the table's choice stands unless Jev prefers the recommendation at
// or above `ruleConfidence`. The tool starts the subagent itself through the relay, so the brief Jev
// judged is the brief that runs, and each delegation is judged once.
import type { AgentSpawnInput } from 'claude-code'
import { relay } from './daily'
import { briefForJev } from './dialogue'
import { newId } from './io'
import { judgeRecommendation, judgeSpawn, recommendationQuestion } from './judge'
import { canonical, displayName, isAvailable, sameModel } from './model'
import { ruleById } from './rules'
import { decideSpawn, judgeCtx, ROUTE_ORIGIN, type SpawnDecision } from './spawn'
import type { Ctx } from './state'
import { EFFORTS, type Effort, type TaskRecord } from './types'

export interface RouteRequest {
  description: string
  prompt: string
  recommended?: { model: string; effort?: Effort; reason: string }
}

function text(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  return v.trim()
}

export function parseRouteArgs(args: Record<string, unknown>): RouteRequest {
  const description = text(args, 'description')
  const prompt = text(args, 'prompt')
  if (description === undefined) throw new Error('description is required')
  if (prompt === undefined) throw new Error('prompt is required')
  const model = text(args, 'recommended_model')
  const effort = text(args, 'recommended_effort')
  const reason = text(args, 'reason')
  if (effort !== undefined && !(EFFORTS as readonly string[]).includes(effort)) throw new Error(`recommended_effort must be one of ${EFFORTS.join(', ')}`)
  if (model === undefined) {
    if (effort !== undefined || reason !== undefined) throw new Error('recommended_effort and reason go with recommended_model')
    return { description, prompt }
  }
  if (reason === undefined) throw new Error('recommended_model needs a reason')
  return { description, prompt, recommended: { model, reason, ...(effort !== undefined ? { effort: effort as Effort } : {}) } }
}

// The brief with the control lines that make decideSpawn take the accepted recommendation.
export function recommendedBrief(prompt: string, r: { model: string; effort?: Effort }, why: string): string {
  return [prompt, `[model ${r.model}]`, `[model-reason evidence: ${why.replace(/\n/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')')}]`, ...(r.effort !== undefined ? [`[effort ${r.effort}]`] : [])].join('\n')
}

export async function modelRoute(ctx: Ctx, task: TaskRecord, args: Record<string, unknown>): Promise<string> {
  const req = parseRouteArgs(args)
  const { rules, catalog } = ctx
  const spawnInput = (prompt: string): AgentSpawnInput => ({
    tool_use_id: `model-route-${task.id}`, prompt, description: req.description, subagentType: 'general-purpose',
    provider: { plugin: 'magpie-tasks', tier: 'user' }, parentModel: task.owner.kind === 'session' ? task.owner.model : '', background: true, fork: false,
  } as AgentSpawnInput)
  const decide = (prompt: string, judgment: Awaited<ReturnType<typeof judgeSpawn>>): SpawnDecision => decideSpawn({
    e: spawnInput(prompt), origin: ROUTE_ORIGIN, task, judgment, rules, catalog,
    lookupAgentModel: id => task.agents[id]?.model,
    session: { id: ctx.st.sessionId, cwd: ctx.st.cwd },
  })

  const jc = judgeCtx(ctx)
  const judgment = await judgeSpawn(jc, [{ role: 'user', content: briefForJev(req.prompt) }])
  const table = decide(req.prompt, judgment)
  if (table.action === 'pass') throw new Error('model_route: the routing decision passed the brief through')

  let chosen: SpawnDecision = table
  let note: string
  const rec = req.recommended
  if (rec === undefined) {
    note = 'no recommendation; the routing table chose'
  } else {
    const model = canonical(rec.model, catalog)
    if (!isAvailable(model, catalog)) return `Not started: the recommended model ${rec.model} is not in Magpie's model list. Recommend a listed model, or leave the recommendation out so the routing table chooses.`
    if (table.action === 'route' && sameModel(model, table.agent.model, catalog)) {
      note = `the routing table chose the recommended model ${displayName(model, rules)} itself`
    } else {
      const tableChoice = table.action === 'route' && table.agent.ruleId !== null
        ? { model: table.agent.model, effort: table.agent.effort, ruleId: table.agent.ruleId, condition: ruleById(rules, table.agent.ruleId).condition }
        : null
      const verdict = await judgeRecommendation(jc, recommendationQuestion({ brief: briefForJev(req.prompt), table: tableChoice, recommended: { model, reason: rec.reason, ...(rec.effort ? { effort: rec.effort } : {}) } }, rules))
      const threshold = rules.thresholds.ruleConfidence
      if (!verdict.ok) {
        note = `Jev could not weigh the recommendation (${verdict.error}); the routing table's choice stands`
      } else if (verdict.choice === 'recommended' && verdict.confidence >= threshold) {
        const why = `the architect recommended it: ${rec.reason}; Jev preferred it${tableChoice ? ` to the table's ${displayName(tableChoice.model, rules)}` : ''} with confidence ${verdict.confidence.toFixed(2)}`
        chosen = decide(recommendedBrief(req.prompt, { model, ...(rec.effort ? { effort: rec.effort } : {}) }, why), judgment)
        note = `Jev preferred the recommendation (${verdict.choice}, confidence ${verdict.confidence.toFixed(2)})`
      } else {
        note = `Jev kept ${tableChoice ? 'the routing table\'s choice' : 'no model'} (${verdict.choice}, confidence ${verdict.confidence.toFixed(2)}, threshold ${threshold})`
      }
    }
  }
  if (chosen.action === 'pass') throw new Error('model_route: the routing decision passed the brief through')
  if (chosen.action === 'deny') return `Not started: ${chosen.reason}${rec !== undefined ? ` (${note})` : ''}`

  const now = await ctx.io.now()
  const line = await relay(ctx, {
    id: newId('r', now), taskId: task.id, createdAt: now, kind: 'spawn', role: chosen.agent.role,
    args: { prompt: chosen.rewrite.prompt, description: chosen.rewrite.description, model: chosen.rewrite.model, ...(chosen.rewrite.cwd !== undefined ? { cwd: chosen.rewrite.cwd } : {}) },
    agent: chosen.agent,
  })
  return `${line}\n${chosen.notice}\nRouting: ${note}.`
}
