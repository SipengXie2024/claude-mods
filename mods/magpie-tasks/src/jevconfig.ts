// JEV's settings that routing shares with it (plan section 5): the deep threshold JEV applies to
// its own `deep` question, which judge.ts asks about a delegated task. One value, kept in JEV's
// .env, so recalibrating JEV moves both. Read the way mods/jev reads it (hooks/register.tsx
// configDir, src/config.ts parseEnvFile and unit): a missing file, key or invalid value gives
// JEV's own default (policy.ts DEEP_DEFAULTS.yes).
import type { Io } from './io'

export const JEV_DEEP_DEFAULT = 0.5

export async function jevConfigDir(io: Io): Promise<string> {
  const dir = await io.env('JEV_OPUS_CONFIG_DIR')
  if (dir) return dir
  const xdg = await io.env('XDG_CONFIG_HOME')
  const home = await io.env('HOME')
  return `${xdg || `${home ?? ''}/.config`}/jev-opus`
}

// KEY=VALUE lines; `#` comments, `export ` prefixes and matching quotes, as mods/jev parseEnvFile.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(m[2]!)
    out[m[1]!] = quoted ? quoted[2]! : m[2]!.replace(/\s+#.*$/, '').trim()
  }
  return out
}

export function deepYesFrom(env: Record<string, string>): number {
  const raw = env['JEV_OPUS_DEEP_YES']
  if (!raw) return JEV_DEEP_DEFAULT
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : JEV_DEEP_DEFAULT
}

export async function jevDeepYes(io: Io): Promise<number> {
  const path = `${await jevConfigDir(io)}/.env`
  return (await io.exists(path)) ? deepYesFrom(parseEnvFile(await io.read(path))) : JEV_DEEP_DEFAULT
}
