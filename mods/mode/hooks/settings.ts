import { PLANNING, PROFILES, WRITING, type ModeName } from './profiles'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parse settings.local.json text; missing file is {}, broken JSON throws. */
export function parseLocal(text: string | undefined): Json {
  if (text === undefined || text.trim() === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (!isObject(parsed)) throw new Error('settings.local.json is not a JSON object')
  return parsed
}

/** Merge a mode's keys into the file's settings; every other key is kept as is. */
export function mergeProfile(local: Json, mode: ModeName): Json {
  const p = PROFILES[mode]
  const plugins = isObject(local.enabledPlugins) ? local.enabledPlugins : {}
  return {
    ...local,
    enabledPlugins: { ...plugins, ...p.enabledPlugins },
    outputStyle: p.outputStyle,
  }
}

/** Which mode the file sets; `unset` when it names neither plugin, `custom` for any other mix. */
export function detectMode(local: Json): ModeName | 'unset' | 'custom' {
  const plugins = isObject(local.enabledPlugins) ? local.enabledPlugins : {}
  const writing = plugins[WRITING]
  const planning = plugins[PLANNING]
  if (writing === undefined && planning === undefined) return 'unset'
  if (writing === true && planning === false) return 'academic'
  if (writing === false && planning === true) return 'general'
  return 'custom'
}
