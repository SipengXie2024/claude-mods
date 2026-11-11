// Model identifiers under Magpie (plan section 4.6): canonical IDs, alias resolution, the 1M context
// variants the launcher offers, effort capabilities and display names.
import type { Rules } from './rules'
import type { AgentRecord, AgentRole, Effort } from './types'

export interface ModelCatalog { picker: string[]; aliases: Record<string, string>; capabilities: Record<string, Set<string>> }

const ALIAS_ENV = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
} as const

const ONE_M = /\[1m\]$/i

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// `id=effort,xhigh_effort,max_effort;id2=effort;...`
function parseCapabilities(text: string): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {}
  for (const entry of text.split(';')) {
    if (entry.trim() === '') continue
    const eq = entry.indexOf('=')
    if (eq <= 0) throw new Error(`CLAUDE_CODE_MODEL_CAPABILITIES: entry "${entry}" has no "<model>=" part`)
    const id = entry.slice(0, eq).trim().replace(ONE_M, '')
    out[id] = new Set(entry.slice(eq + 1).split(',').map(s => s.trim()).filter(s => s !== ''))
  }
  return out
}

// Built from Magpie's flag settings layer ($.settings.read({ source: 'flag' })). Only the model list,
// the four alias variables and the capability string are kept: the same env object carries credentials.
export function catalogFrom(flagSettings: unknown): ModelCatalog {
  if (!isRecord(flagSettings)) throw new Error('magpie flag settings: not an object')
  const picker = flagSettings['modelPicker']
  if (!isRecord(picker) || !Array.isArray(picker['options'])) throw new Error('magpie flag settings: modelPicker.options is missing')
  const models = picker['options'].map((o: unknown, i: number) => {
    if (!isRecord(o) || typeof o['model'] !== 'string' || o['model'] === '') throw new Error(`magpie flag settings: modelPicker.options[${i}].model is not a model ID`)
    return o['model']
  })
  const env = flagSettings['env']
  if (!isRecord(env)) throw new Error('magpie flag settings: env is missing')
  const caps = env['CLAUDE_CODE_MODEL_CAPABILITIES']
  if (typeof caps !== 'string') throw new Error('magpie flag settings: env.CLAUDE_CODE_MODEL_CAPABILITIES is missing')
  const aliases: Record<string, string> = {}
  for (const [alias, name] of Object.entries(ALIAS_ENV)) {
    const v = env[name]
    if (typeof v === 'string' && v !== '') aliases[alias] = v
  }
  return { picker: models, aliases, capabilities: parseCapabilities(caps) }
}

// Strips the 1M suffix; resolves the opus/sonnet/haiku/fable aliases (bare or with [1m]) through the
// launcher's ANTHROPIC_DEFAULT_*_MODEL values.
export function canonical(id: string, cat: ModelCatalog): string {
  const bare = id.trim().replace(ONE_M, '')
  const key = bare.toLowerCase()
  if (Object.hasOwn(ALIAS_ENV, key)) {
    const target = cat.aliases[key]
    if (target === undefined) throw new Error(`model alias "${bare}": Magpie's settings do not set ${ALIAS_ENV[key as keyof typeof ALIAS_ENV]}`)
    return target.trim().replace(ONE_M, '')
  }
  return bare
}

export function sameModel(a: string, b: string, cat: ModelCatalog): boolean {
  return canonical(a, cat) === canonical(b, cat)
}

// The ID sent to the engine: the picker's 1M context variant when it lists one.
export function requestId(id: string, cat: ModelCatalog): string {
  const c = canonical(id, cat)
  const wide = `${c}[1m]`
  return cat.picker.includes(wide) ? wide : c
}

// Magpie's picker comes from each provider's own model list, which can lag a release the provider
// already serves (Mythos 5.2 on 2026-11-10: requests answered, the list still without it). A model
// the routing rules name counts as listed; one that is then refused ends the agent on an API error,
// which the unavailable-model handling takes over (src/unavailable.ts).
export function withRuleModels(cat: ModelCatalog, ruleModels: string[]): ModelCatalog {
  const extra = ruleModels.filter(m => !cat.picker.some(p => canonical(p, cat) === canonical(m, cat)))
  return { ...cat, picker: [...cat.picker, ...extra] }
}

export function isAvailable(id: string, cat: ModelCatalog): boolean {
  const c = canonical(id, cat)
  return cat.picker.some(p => canonical(p, cat) === c)
}

// Removes xhigh/max the model does not support. A model absent from CLAUDE_CODE_MODEL_CAPABILITIES
// (a user-specified model, or a picker entry the launcher lists without capabilities) keeps the
// effort as given: there is nothing to clamp against, and Magpie answers for that model.
export function clampEffort(id: string, effort: Effort, cat: ModelCatalog): Effort {
  const caps = cat.capabilities[canonical(id, cat)]
  if (caps === undefined) return effort
  let e = effort
  if (e === 'max' && !caps.has('max_effort')) e = 'xhigh'
  if (e === 'xhigh' && !caps.has('xhigh_effort')) e = 'high'
  return e
}

// The routing table's name for a model; the ID itself for models outside the rules file.
export function displayName(id: string, rules: Rules): string {
  const bare = id.trim().replace(ONE_M, '')
  return rules.models[bare]?.name ?? bare
}

const ROLE_NAMES: Record<AgentRole, string> = {
  executor: '执行', implementer: '实施', assessment: '评估', acceptance: '验收', diagnosis: '诊断', helper: '辅助',
}

export function roleName(role: AgentRole): string {
  return ROLE_NAMES[role]
}

// How a message to the person names a subagent: its role, its task and its model. Agent IDs are
// for the architect and the tools; the person cannot tell them apart.
export function agentLabel(a: Pick<AgentRecord, 'role' | 'description' | 'model'>, rules: Rules): string {
  const task = a.description?.replace(/ · [^·]*$/, '').trim()
  return `${ROLE_NAMES[a.role]}子代理${task ? `「${task}」` : ''}（${displayName(a.model, rules)}）`
}
