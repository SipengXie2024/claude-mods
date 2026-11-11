import { isEffort, type Effort } from './effort';
import { DEFAULT_DEADLINE_MS, DEFAULT_MODEL, type ConfidenceMode, type JevClientOptions } from './jev';
import { DEEP_DEFAULTS, normalizeBounds, setAblations, setDeepThresholds, setDissatThreshold, type Bounds } from './policy';

/**
 * The mod's settings, read from jev-opus's `.env`. Only the file counts: the
 * hooks module reads no other environment for these keys.
 */
export interface ModConfig {
  /** Jev's client options except the key (OpenAI's Decisions API is the one service) */
  jev: Omit<JevClientOptions, 'apiKey'>;
  /** JEV_API_KEY_FILE: the path of the file that holds the OpenAI key; null without one: heuristics only */
  jevKeyFile: string | null;
  /** JEV_API_KEY is set: a key of the service jev-opus used before, never read and never sent */
  staleKey: boolean;
  bounds: Bounds;
  deep: { yes: number; no: number };
  followUp: { mode: 'on' | 'shadow' | null; yes: number; advisor: boolean };
  ablate: string[];
  /** probability that a human prompt's start level moves one step for exploration (JEV_OPUS_EXPLORE) */
  explore: number;
}

/** Default JEV_OPUS_EXPLORE. */
export const EXPLORE_DEFAULT = 0.1;

/** KEY=VALUE lines; `#` comments, `export ` prefixes and matching quotes (an inline comment may follow them) allowed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(m[2]!);
    out[m[1]!] = quoted ? quoted[2]! : m[2]!.replace(/\s+#.*$/, '').trim();
  }
  return out;
}

function unit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

function int(raw: string | undefined, fallback: number, min = 0): number {
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min ? Math.floor(v) : fallback;
}

function effort(raw: string | undefined, fallback: Effort): Effort {
  return isEffort(raw) ? raw : fallback;
}

/**
 * The key file's absolute path: `~/` is the home folder, a relative path is
 * taken from the config folder.
 */
export function keyFilePath(path: string, home: string, configDir: string): string {
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`;
  return path.startsWith('/') ? path : `${configDir}/${path}`;
}

export function modConfig(env: Record<string, string>): ModConfig {
  const dissat = (env.JEV_OPUS_DISSATISFACTION ?? '').trim().toLowerCase();
  return {
    jev: {
      model: env.JEV_MODEL?.trim() || DEFAULT_MODEL,
      // Jev sits in the prompt's path: the deadline bounds how long a prompt waits for it.
      deadlineMs: int(env.JEV_DEADLINE_MS, DEFAULT_DEADLINE_MS),
      breakerThreshold: int(env.JEV_BREAKER_THRESHOLD, 3, 1),
      breakerCooldownMs: int(env.JEV_BREAKER_COOLDOWN_MS, 30_000),
      confidence: (env.JEV_CONFIDENCE === 'server' ? 'server' : 'recompute') as ConfidenceMode,
    },
    // The key is read from its file only: JEV_API_KEY in jev-opus's .env belongs to the service it used before.
    jevKeyFile: env.JEV_API_KEY_FILE?.trim() || null,
    staleKey: Boolean(env.JEV_API_KEY?.trim()),
    bounds: normalizeBounds({ min: effort(env.JEV_OPUS_MIN_EFFORT, 'low'), max: effort(env.JEV_OPUS_MAX_EFFORT, 'high') }),
    deep: { yes: unit(env.JEV_OPUS_DEEP_YES, DEEP_DEFAULTS.yes), no: unit(env.JEV_OPUS_DEEP_NO, DEEP_DEFAULTS.no) },
    followUp: {
      // 0 = off, shadow = ask and record only, anything else = on.
      mode: dissat === '0' ? null : dissat === 'shadow' ? 'shadow' : 'on',
      yes: unit(env.JEV_OPUS_DISSAT_YES, 0.75),
      advisor: env.JEV_OPUS_DISSAT_ADVISOR !== '0',
    },
    ablate: (env.JEV_OPUS_ABLATE || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    explore: unit(env.JEV_OPUS_EXPLORE, EXPLORE_DEFAULT),
  };
}

/** Set the policy's module-level knobs, as the jev-opus CLI does at startup. */
export function applyPolicyConfig(c: ModConfig): void {
  setDeepThresholds(c.deep);
  setDissatThreshold(c.followUp.yes);
  setAblations(c.ablate);
}
