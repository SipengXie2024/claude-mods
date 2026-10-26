import { isEffort, type Effort } from './effort';
import { DEFAULT_DEADLINE_MS, type ConfidenceMode, type JevClientOptions } from './jev';
import { DEEP_DEFAULTS, normalizeBounds, setAblations, setDeepThresholds, setDissatThreshold, type Bounds } from './policy';

/**
 * The mod's settings, read from jev-opus's own `.env` (same keys, same
 * defaults as jev-opus src/config.ts). Only the file counts: the hooks module
 * reads no other environment for these keys.
 */
export interface ModConfig {
  /** null without an API key or an allowed JEV_BASE_URL: heuristics only */
  jev: JevClientOptions | null;
  /** The stand-in asked when the primary fails (JEV_FALLBACK_*); null when unset or not allowed. */
  jevFallback: JevClientOptions | null;
  /** The refused endpoint's host when a key is set but its base URL is unset or not allowed, so the
   * fallback to heuristics can be reported instead of happening silently. */
  jevRefusedHost: string | null;
  bounds: Bounds;
  deep: { yes: number; no: number };
  followUp: { mode: 'on' | 'shadow' | null; yes: number; advisor: boolean };
  ablate: string[];
  /** probability that a human prompt's start level moves one step for exploration (JEV_OPUS_EXPLORE) */
  explore: number;
}

/** Default JEV_OPUS_EXPLORE. */
export const EXPLORE_DEFAULT = 0.1;
const FALLBACK_DEADLINE_MS = 2_500;

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

/** Hosts that stay on machines we run: loopback and the sub2api Docker bridge. */
export const LOCAL_JEV_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '172.21.0.1'];

/**
 * Whether `url` may receive Jev state (whole prompts and tool output): http(s)
 * to a local host or one listed in `extraHosts` (comma-separated
 * JEV_ALLOWED_HOSTS). Anything else, a missing URL included, keeps Jev off, so
 * a lost or mistyped config never sends a conversation to a hosted API.
 */
export function jevEndpointAllowed(url: string | undefined, extraHosts = ''): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const extra = extraHosts.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...LOCAL_JEV_HOSTS, ...extra].includes(parsed.hostname.toLowerCase());
}

function endpointHost(url: string): string {
  if (!url) return '(unset)';
  try {
    return new URL(url).host;
  } catch {
    return '(invalid)';
  }
}

/**
 * One endpoint's client options from its key set: JEV_BASE_URL / JEV_API_KEY /
 * JEV_MODEL / JEV_DEADLINE_MS for the primary, the same names with a
 * JEV_FALLBACK_ prefix for the stand-in. Breaker and confidence settings are
 * shared. `refusedHost` is set when a key exists but the URL is not allowed.
 */
function endpoint(env: Record<string, string>, prefix: '' | 'FALLBACK_'): { options: JevClientOptions | null; refusedHost: string | null } {
  const apiKey = env[`JEV_${prefix}API_KEY`] || (prefix ? '' : env.TYPESAFE_API_KEY) || '';
  const baseUrl = env[`JEV_${prefix}BASE_URL`] || '';
  const allowed = jevEndpointAllowed(baseUrl, env.JEV_ALLOWED_HOSTS);
  return {
    options: apiKey && allowed
      ? {
        apiKey,
        baseUrl,
        model: env[`JEV_${prefix}MODEL`] || 'jev-latest',
        // Jev sits in the request path, so the budget is small; the fallback is asked only after the primary failed.
        deadlineMs: int(env[`JEV_${prefix}DEADLINE_MS`], prefix ? FALLBACK_DEADLINE_MS : DEFAULT_DEADLINE_MS),
        breakerThreshold: int(env.JEV_BREAKER_THRESHOLD, 3, 1),
        breakerCooldownMs: int(env.JEV_BREAKER_COOLDOWN_MS, 30_000),
        confidence: (env.JEV_CONFIDENCE === 'server' ? 'server' : 'recompute') as ConfidenceMode,
      }
      : null,
    refusedHost: apiKey && !allowed ? endpointHost(baseUrl) : null,
  };
}

export function modConfig(env: Record<string, string>): ModConfig {
  const primary = endpoint(env, '');
  const fallback = endpoint(env, 'FALLBACK_');
  const dissat = (env.JEV_OPUS_DISSATISFACTION ?? '').trim().toLowerCase();
  return {
    jev: primary.options,
    jevFallback: fallback.options,
    jevRefusedHost: primary.refusedHost ?? fallback.refusedHost,
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
