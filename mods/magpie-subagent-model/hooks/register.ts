import type { PromptComposeSection, Register } from 'claude-code'

// Under claude-magpie only (ANTHROPIC_BASE_URL matching the Magpie gateway),
// allow any Agent subagent to run on an arbitrary Magpie model ID by placing
// `[model <magpie-model-id>]` (or `[model: <magpie-model-id>]`) on its own
// line in the subagent prompt. Native Claude Code sessions are untouched.

export const SECTION_ID = 'magpie-subagent-model'
export const DEFAULT_MAGPIE_GATEWAY = 'http://127.0.0.1:3425'

const MODEL_LINE = /^[ \t]*\[model(?::|\s+)\s*([A-Za-z0-9][A-Za-z0-9._/-]*(?:\[1m\])?)\s*\][ \t]*$/m
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse Magpie model IDs from `CLAUDE_CODE_MODEL_CAPABILITIES` (`id=cap1,cap2;...`). */
export function parseCapabilitiesIds(caps: string | undefined): string[] {
  if (typeof caps !== 'string' || caps.trim() === '') return []
  const ids: string[] = []
  for (const entry of caps.split(';')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const id = entry.slice(0, eq).trim()
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

export interface MagpieCatalog {
  /** Exact IDs offered by Magpie's picker (may include `[1m]` suffix). */
  picker: string[]
  /** Bare IDs from `CLAUDE_CODE_MODEL_CAPABILITIES` (without `[1m]`). */
  capable: string[]
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
  const capable = parseCapabilitiesIds(caps).map(id => id.replace(ONE_M, ''))
  return { picker, capable }
}

/**
 * Resolve a requested model ID against Magpie's catalog.
 * Returns `{ ok: true, id }` with the picker's exact ID (preserving `[1m]` when offered),
 * or `{ ok: false, available }` when the catalog is non-empty and does not contain the ID.
 */
export function resolveMagpieModel(requested: string, catalog: MagpieCatalog): { ok: true; id: string } | { ok: false; available: string[] } {
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
  const lines = [
    '# Subagent Model Override (claude-magpie)',
    '',
    'The `Agent` tool `model` parameter only accepts `sonnet`, `opus`, `haiku`, or `fable`. In this `claude-magpie` session, you can target any Magpie model directly by placing a standalone line at the top of the subagent `prompt`:',
    '',
    '    [model <magpie-model-id>]',
    '',
    'Omit the `model` parameter when using this line (the plugin strips the line and routes the subagent to `<magpie-model-id>`). Do not use this with `subagent_type: "fork"`.',
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

    const directive = parseModelDirective(e.prompt)
    if (directive === null) return next(e)

    let flagSettings: unknown
    try {
      flagSettings = await $.settings.read({ source: 'flag' })
    } catch {
      flagSettings = undefined
    }
    const envCaps = await $.env.get('CLAUDE_CODE_MODEL_CAPABILITIES')
    const catalog = buildMagpieCatalog(flagSettings, envCaps)
    const resolved = resolveMagpieModel(directive.model, catalog)
    if (!resolved.ok) {
      return {
        deny: `Unknown Magpie model "${directive.model}" in [model ...] directive. Available models: ${resolved.available.join(', ')}`,
      }
    }

    return next({
      ...e,
      model: resolved.id,
      prompt: directive.prompt,
    })
  }).catch(($, e, next) => next(e))
}
