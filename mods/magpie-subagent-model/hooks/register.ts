import type { PromptComposeSection, Register } from 'claude-code'
import { EFFORT_LEVELS, renderRoutingTable, type EffortLevel } from '../src/routing-table'

// Under claude-magpie only (ANTHROPIC_BASE_URL matching the Magpie gateway):
// 1. Inject the task-to-model routing table and available Magpie models into
//    the system prompt so the main agent can decide when to handle work directly
//    and when to delegate a subagent with `[model <id>]` and `[effort <level>]`.
// 2. Intercept `agent.spawn` to resolve `[model <id>]` (stripping that line and
//    rewriting `e.model`) and capture `[effort <level>]` (normalized in the
//    prompt for JEV and enforced on `turn.step` for all models, including those
//    JEV does not manage such as Sonnet 5.5, Mythos 5.1, and Terra 6.1).
// Native Claude Code sessions are untouched.

export const SECTION_ID = 'magpie-subagent-model'
export const DEFAULT_MAGPIE_GATEWAY = 'http://127.0.0.1:3425'

const MODEL_LINE = /^[ \t]*\[model(?::|\s+)\s*([A-Za-z0-9][A-Za-z0-9._/-]*(?:\[1m\])?)\s*\][ \t]*$/m
const EFFORT_LINE = /^[ \t]*\[effort(?::|\s+)\s*([A-Za-z0-9._-]+)\s*\][ \t]*$/mi
const MAGPIE_TASKS_MARKER = /^\[magpie-tasks\s+task=/
const ONE_M = /\[1m\]$/i

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1')
}

export function isMagpieGateway(baseUrl: string | undefined, gatewayUrl: string = DEFAULT_MAGPIE_GATEWAY): boolean {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return false
  return normalizeUrl(baseUrl) === normalizeUrl(gatewayUrl)
}

export interface ParsedModelDirective {
  model: string
  prompt: string
}

/** Extract `[model <id>]` or `[model: <id>]` on a line of its own and return the cleaned prompt. */
export function parseModelDirective(prompt: string): ParsedModelDirective | null {
  const m = MODEL_LINE.exec(prompt)
  if (!m) return null
  const model = m[1]!.trim()
  const before = prompt.slice(0, m.index)
  let after = prompt.slice(m.index + m[0].length)
  if (after.startsWith('\r\n')) after = after.slice(2)
  else if (after.startsWith('\n')) after = after.slice(1)
  const cleaned = (before + after).replace(/^\n+/, '')
  return { model, prompt: cleaned }
}

export type ParsedEffortDirective =
  | { ok: true; effort: EffortLevel; rawLine: string; index: number }
  | { ok: false; raw: string }

/** Parse a standalone `[effort <level>]` or `[effort: <level>]` line (does not strip it). */
export function parseEffortDirective(prompt: string): ParsedEffortDirective | null {
  const m = EFFORT_LINE.exec(prompt)
  if (!m) return null
  const raw = m[1]!.trim().toLowerCase()
  if ((EFFORT_LEVELS as readonly string[]).includes(raw)) {
    return { ok: true, effort: raw as EffortLevel, rawLine: m[0], index: m.index }
  }
  return { ok: false, raw: m[1]!.trim() }
}

function replaceEffortLine(prompt: string, effort: EffortLevel): string {
  return prompt.replace(EFFORT_LINE, `[effort ${effort}]`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface ParsedCapabilities {
  ids: string[]
  maxEffort: Record<string, EffortLevel>
}

/** Parse Magpie model IDs and maximum supported effort from `CLAUDE_CODE_MODEL_CAPABILITIES`. */
export function parseCapabilities(caps: string | undefined): ParsedCapabilities {
  const ids: string[] = []
  const maxEffort: Record<string, EffortLevel> = {}
  if (typeof caps !== 'string' || caps.trim() === '') return { ids, maxEffort }
  for (const entry of caps.split(';')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const id = entry.slice(0, eq).trim().replace(ONE_M, '')
    if (id === '') continue
    if (!ids.includes(id)) ids.push(id)
    const flags = entry
      .slice(eq + 1)
      .split(',')
      .map(s => s.trim())
    if (flags.includes('max_effort')) maxEffort[id] = 'max'
    else if (flags.includes('xhigh_effort')) maxEffort[id] = 'xhigh'
    else if (flags.includes('effort')) maxEffort[id] = 'high'
  }
  return { ids, maxEffort }
}

/** Parse Magpie model IDs from `CLAUDE_CODE_MODEL_CAPABILITIES` (`id=cap1,cap2;...`). */
export function parseCapabilitiesIds(caps: string | undefined): string[] {
  return parseCapabilities(caps).ids
}

export interface MagpieCatalog {
  /** Exact IDs offered by Magpie's picker (may include `[1m]` suffix). */
  picker: string[]
  /** Bare IDs from `CLAUDE_CODE_MODEL_CAPABILITIES` (without `[1m]`). */
  capable: string[]
  /** Max supported effort per bare model ID when advertised in capabilities. */
  maxEffort?: Record<string, EffortLevel>
}

export function buildMagpieCatalog(flagSettings: unknown, envCaps: string | undefined): MagpieCatalog {
  const picker: string[] = []
  let caps: string | undefined
  if (isRecord(flagSettings)) {
    const mp = flagSettings['modelPicker']
    if (isRecord(mp) && Array.isArray(mp['options'])) {
      for (const o of mp['options']) {
        if (isRecord(o) && typeof o['model'] === 'string' && o['model'].trim() !== '') {
          picker.push(o['model'].trim())
        }
      }
    }
    const env = flagSettings['env']
    if (isRecord(env) && typeof env['CLAUDE_CODE_MODEL_CAPABILITIES'] === 'string') {
      caps = env['CLAUDE_CODE_MODEL_CAPABILITIES']
    }
  }
  if (caps === undefined) caps = envCaps
  const parsed = parseCapabilities(caps)
  return { picker, capable: parsed.ids, maxEffort: parsed.maxEffort }
}

/** Clamp requested effort to the model's advertised ceiling when known. */
export function clampEffortForModel(
  effort: EffortLevel,
  modelId: string | undefined,
  maxEffort: Record<string, EffortLevel> | undefined,
): EffortLevel {
  if (!modelId || !maxEffort) return effort
  const bare = modelId.trim().replace(ONE_M, '')
  const ceiling = maxEffort[bare]
  if (!ceiling) return effort
  const reqIdx = EFFORT_LEVELS.indexOf(effort)
  const capIdx = EFFORT_LEVELS.indexOf(ceiling)
  return reqIdx > capIdx ? ceiling : effort
}

/**
 * Resolve a requested model ID against Magpie's catalog.
 * Returns `{ ok: true, id }` with the picker's exact ID (preserving `[1m]` when offered),
 * or `{ ok: false, available }` when the catalog is non-empty and does not contain the ID.
 */
export function resolveMagpieModel(
  requested: string,
  catalog: MagpieCatalog,
): { ok: true; id: string } | { ok: false; available: string[] } {
  const trimmed = requested.trim()
  const bare = trimmed.replace(ONE_M, '')
  const allBare = new Set<string>([
    ...catalog.picker.map(id => id.replace(ONE_M, '')),
    ...catalog.capable,
  ])

  // If the session exposes no catalog at all, pass the explicit ID straight through to Magpie.
  if (allBare.size === 0) {
    return { ok: true, id: trimmed }
  }

  // Exact match in picker wins first (e.g. caller explicitly wrote `[1m]` or bare).
  if (catalog.picker.includes(trimmed)) {
    return { ok: true, id: trimmed }
  }
  // If caller wrote bare ID and picker offers `[1m]` variant, prefer the picker ID.
  if (!ONE_M.test(trimmed)) {
    const with1m = catalog.picker.find(id => id.replace(ONE_M, '') === bare)
    if (with1m !== undefined) return { ok: true, id: with1m }
  }
  if (allBare.has(bare)) {
    return { ok: true, id: trimmed }
  }
  return { ok: false, available: [...allBare] }
}

export function buildHintText(catalog: MagpieCatalog): string {
  const models = [...new Set([
    ...catalog.picker.map(id => id.replace(ONE_M, '')),
    ...catalog.capable,
  ])]
  const availableSet = new Set(models)
  const lines = [
    '# Subagent Model Routing & Override (claude-magpie)',
    '',
    'In this `claude-magpie` session you can choose when to work directly and when to delegate to a subagent on any Magpie model:',
    '- Handle straightforward lookups, small edits, or tasks that already match your own model directly.',
    '- When a task clearly fits a stronger specialist model below, benefits from an isolated context, or needs an independent second-model review, delegate via the `Agent` tool.',
    '',
    '## How to target any Magpie model & effort',
    '',
    'Place standalone directive lines at the top of the `Agent` tool `prompt` (omit the `Agent` `model` parameter when using `[model ...]`; do not use `[model ...]` with `subagent_type: "fork"`):',
    '',
    '    [model <magpie-model-id>]',
    '    [effort <low|medium|high|xhigh|max>]',
    '',
    'The plugin strips `[model ...]`, routes the subagent to that Magpie model (keeping `[1m]` when offered), and enforces `[effort ...]` on every turn of that subagent.',
    '',
    '## Task routing table',
    '',
    renderRoutingTable(availableSet),
  ]
  if (models.length > 0) {
    lines.push('', `Available Magpie models: ${models.join(', ')}`)
  }
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const configuredGateway = typeof options?.gatewayUrl === 'string' && options.gatewayUrl.trim() !== ''
    ? options.gatewayUrl.trim()
    : DEFAULT_MAGPIE_GATEWAY

  const agentEfforts = new Map<string, EffortLevel>()

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const baseUrl = await $.env.get('ANTHROPIC_BASE_URL')
    if (!isMagpieGateway(baseUrl, configuredGateway)) return out
    if (out.sections.some(s => s.id === SECTION_ID)) return out
    let flagSettings: unknown
    try {
      flagSettings = await $.settings.read({ source: 'flag' })
    } catch {
      flagSettings = undefined
    }
    const envCaps = await $.env.get('CLAUDE_CODE_MODEL_CAPABILITIES')
    const catalog = buildMagpieCatalog(flagSettings, envCaps)
    const section: PromptComposeSection = {
      id: SECTION_ID,
      text: buildHintText(catalog),
      scope: 'session',
    }
    return { sections: [...out.sections, section] }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.workflow !== undefined || e.resume !== undefined) return next(e)
    if (typeof e.prompt !== 'string' || MAGPIE_TASKS_MARKER.test(e.prompt.trimStart())) return next(e)

    const baseUrl = await $.env.get('ANTHROPIC_BASE_URL')
    if (!isMagpieGateway(baseUrl, configuredGateway)) return next(e)

    const modelDir = parseModelDirective(e.prompt)
    const promptAfterModel = modelDir ? modelDir.prompt : e.prompt
    const effortDir = parseEffortDirective(promptAfterModel)

    if (modelDir === null && effortDir === null) return next(e)

    if (effortDir !== null && !effortDir.ok) {
      return {
        deny: `Unknown effort level "${effortDir.raw}" in [effort ...] directive. Valid levels: ${EFFORT_LEVELS.join(', ')}`,
      }
    }

    let flagSettings: unknown
    try {
      flagSettings = await $.settings.read({ source: 'flag' })
    } catch {
      flagSettings = undefined
    }
    const envCaps = await $.env.get('CLAUDE_CODE_MODEL_CAPABILITIES')
    const catalog = buildMagpieCatalog(flagSettings, envCaps)

    let nextModel = e.model
    if (modelDir !== null) {
      const resolved = resolveMagpieModel(modelDir.model, catalog)
      if (!resolved.ok) {
        return {
          deny: `Unknown Magpie model "${modelDir.model}" in [model ...] directive. Available models: ${resolved.available.join(', ')}`,
        }
      }
      nextModel = resolved.id
    }

    let nextPrompt = promptAfterModel
    let pinnedEffort: EffortLevel | undefined
    if (effortDir !== null && effortDir.ok) {
      pinnedEffort = clampEffortForModel(effortDir.effort, nextModel ?? e.parentModel, catalog.maxEffort)
      nextPrompt = replaceEffortLine(nextPrompt, pinnedEffort)
    }

    const res = await next({
      ...e,
      ...(nextModel !== undefined ? { model: nextModel } : {}),
      prompt: nextPrompt,
    })

    if (pinnedEffort !== undefined && res && 'agentId' in res && typeof res.agentId === 'string' && res.agentId !== '') {
      agentEfforts.set(res.agentId, pinnedEffort)
    }
    return res
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const pinned = e.agentId !== undefined ? agentEfforts.get(e.agentId) : undefined
    return yield* next(pinned !== undefined ? { ...e, effort: pinned } : e)
  })

  on('session.end', ($, e, next) => {
    agentEfforts.clear()
    return next(e)
  })
}
