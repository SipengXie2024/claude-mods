// The band above the prompt while a routed subagent's transcript is in view (plan section 9.7): the
// model its requests name, the efforts they carried and its rule. JEV draws the band of every other
// loop and passes this one on, since this plugin sets that subagent's effort.
import { displayName } from './model'
import type { Rules } from './rules'
import { EFFORTS, type Effort } from './types'

export interface AgentBand {
  // the model of the agent's latest request
  model: string
  // the efforts its requests carried on that model, one entry per change, newest last
  trail: Effort[]
  ruleId: string | null
  // the newest request went out at the engine's effort: this plugin's effort hook failed on it
  engine: boolean
  // the agent's run has ended
  done: boolean
}

// Lines kept at most; a finished agent's is dropped first.
const BAND_AGENTS = 64
const bands = new Map<string, AgentBand>()

export function isEffort(v: unknown): v is Effort {
  return EFFORTS.includes(v as Effort)
}

// One request of a routed agent: its model, the effort it carried (none for a model without one) and
// whether that effort is the engine's. A new model starts a new trail. Returns whether the line changed.
export function noteBandStep(agentId: string, step: { model: string; effort: Effort | undefined; ruleId: string | null; engine: boolean }): boolean {
  const old = bands.get(agentId)
  const trail = old !== undefined && old.model === step.model ? [...old.trail] : []
  if (step.effort !== undefined && trail.at(-1) !== step.effort) trail.push(step.effort)
  const line: AgentBand = { model: step.model, trail, ruleId: step.ruleId, engine: step.engine, done: false }
  if (old !== undefined && JSON.stringify(old) === JSON.stringify(line)) return false
  bands.set(agentId, line)
  for (const [k, b] of bands) {
    if (bands.size <= BAND_AGENTS) break
    if (b.done) bands.delete(k)
  }
  return true
}

// The agent's run ended; its line stays, marked done, for whoever opens its transcript.
export function noteBandDone(agentId: string): boolean {
  const b = bands.get(agentId)
  if (b === undefined || b.done) return false
  bands.set(agentId, { ...b, done: true })
  return true
}

export function agentBand(agentId: string): AgentBand | undefined {
  return bands.get(agentId)
}

export function clearBands(): void {
  bands.clear()
}

// `Opus 5.5 · ◆ magpie-tasks · medium → HIGH · daily-default`: the model, the trail's last six
// efforts with the current one upper-case, the rule; `engine effort` when the newest request went out
// at the engine's effort, `done` once the run has ended.
export function bandText(b: AgentBand, rules: Rules): string {
  const parts = [displayName(b.model, rules)]
  const shown = b.trail.length > 6 ? ['…', ...b.trail.slice(-5)] : b.trail
  parts.push(shown.length > 0 ? `◆ magpie-tasks · ${shown.map((e, i) => (i === shown.length - 1 ? e.toUpperCase() : e)).join(' → ')}` : '◆ magpie-tasks')
  if (b.engine) parts.push('engine effort')
  if (b.ruleId !== null) parts.push(b.ruleId)
  if (b.done) parts.push('done')
  return parts.join(' · ')
}
