// The band above the prompt while a routed subagent's transcript is in view (plan section 9.7): the
// model its requests name, the efforts they carried, its rule, and what its current run is doing (how
// long it has run, how many tool calls it made, the latest one), read from the tool calls the plugin
// sees anyway; the engine's own progress summaries stay off (src/launch.ts ARCHITECT_ENV). JEV draws
// the band of every other loop and passes this one on, since this plugin sets that subagent's effort.
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
  // the current run (from the first request after a finished one): when it began and ended, how many
  // tool calls it has made, and the latest of them
  startedAt: number
  endedAt: number | null
  tools: number
  last: string | null
}

// Lines kept at most; a finished agent's is dropped first.
const BAND_AGENTS = 64
const bands = new Map<string, AgentBand>()

export function isEffort(v: unknown): v is Effort {
  return EFFORTS.includes(v as Effort)
}

// One request of a routed agent: its model, the effort it carried (none for a model without one) and
// whether that effort is the engine's, at `now`. A new model starts a new trail; the first request
// after a finished run starts a new run. Returns whether the line changed.
export function noteBandStep(agentId: string, step: { model: string; effort: Effort | undefined; ruleId: string | null; engine: boolean }, now: number): boolean {
  const old = bands.get(agentId)
  const trail = old !== undefined && old.model === step.model ? [...old.trail] : []
  if (step.effort !== undefined && trail.at(-1) !== step.effort) trail.push(step.effort)
  const run = old !== undefined && !old.done ? { startedAt: old.startedAt, endedAt: null, tools: old.tools, last: old.last } : { startedAt: now, endedAt: null, tools: 0, last: null }
  const line: AgentBand = { model: step.model, trail, ruleId: step.ruleId, engine: step.engine, done: false, ...run }
  if (old !== undefined && JSON.stringify(old) === JSON.stringify(line)) return false
  bands.set(agentId, line)
  for (const [k, b] of bands) {
    if (bands.size <= BAND_AGENTS) break
    if (b.done) bands.delete(k)
  }
  return true
}

// One tool call of a routed agent whose line exists. Returns whether the line changed.
export function noteBandTool(agentId: string, tool: string, input: Record<string, unknown>): boolean {
  const b = bands.get(agentId)
  if (b === undefined) return false
  bands.set(agentId, { ...b, tools: b.tools + 1, last: toolLine(tool, input) })
  return true
}

// The agent's run ended at `now`; its line stays, marked done, for whoever opens its transcript.
export function noteBandDone(agentId: string, now: number): boolean {
  const b = bands.get(agentId)
  if (b === undefined || b.done) return false
  bands.set(agentId, { ...b, done: true, endedAt: now })
  return true
}

// Whether a line's run is still going, so the time on it moves.
export function bandsRunning(): boolean {
  for (const b of bands.values()) if (!b.done) return true
  return false
}

const LAST_MAX = 40

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

// A tool call in a few words: the tool (an MCP tool by its own name) and the one argument that says
// most, cut short: the file's name, the command's first word, the pattern, the subagent's description.
export function toolLine(tool: string, input: Record<string, unknown>): string {
  const name = tool.startsWith('mcp__') ? tool.split('__').pop() ?? tool : tool
  const text = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
  const file = text('file_path') || text('notebook_path')
  const arg = file !== '' ? basename(file)
    : tool === 'Bash' ? basename(text('command').split(/\s+/)[0] ?? '')
    : text('pattern') || text('description') || text('query') || text('url')
  const line = arg === '' ? name : `${name} ${arg.replace(/\s+/g, ' ')}`
  const chars = Array.from(line)
  return chars.length <= LAST_MAX ? line : `${chars.slice(0, LAST_MAX - 1).join('')}…`
}

// `45s`, `3m05s`, `1h02m`.
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const two = (n: number) => String(n).padStart(2, '0')
  if (s < 3600) return `${Math.floor(s / 60)}m${two(s % 60)}s`
  return `${Math.floor(s / 3600)}h${two(Math.floor((s % 3600) / 60))}m`
}

export function agentBand(agentId: string): AgentBand | undefined {
  return bands.get(agentId)
}

export function clearBands(): void {
  bands.clear()
}

// `Opus 5.5 · ◆ magpie-tasks · medium → HIGH · daily-default · 3m05s · 14 tools · Edit gate.ts`: the
// model, the trail's last six efforts with the current one upper-case, the rule, how long the run has
// taken at `now` (to its end once it has ended), its tool calls and the latest one; `engine effort`
// when the newest request went out at the engine's effort, `done` once the run has ended.
export function bandText(b: AgentBand, rules: Rules, now: number): string {
  const parts = [displayName(b.model, rules)]
  const shown = b.trail.length > 6 ? ['…', ...b.trail.slice(-5)] : b.trail
  parts.push(shown.length > 0 ? `◆ magpie-tasks · ${shown.map((e, i) => (i === shown.length - 1 ? e.toUpperCase() : e)).join(' → ')}` : '◆ magpie-tasks')
  if (b.engine) parts.push('engine effort')
  if (b.ruleId !== null) parts.push(b.ruleId)
  parts.push(elapsedText((b.endedAt ?? now) - b.startedAt))
  if (b.tools > 0) parts.push(`${b.tools} ${b.tools === 1 ? 'tool' : 'tools'}`)
  if (b.last !== null) parts.push(b.last)
  if (b.done) parts.push('done')
  return parts.join(' · ')
}
