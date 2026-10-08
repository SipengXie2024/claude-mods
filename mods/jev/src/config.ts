import { isEffort, type Effort } from './effort';
import type { ConfidenceMode, JevClientOptions } from './jev';
import { DEEP_DEFAULTS, normalizeBounds, setAblations, setDeepThresholds, setDissatThreshold, type Bounds } from './policy';
import { setStepStateMax, STEP_STATE_DEFAULT, STEP_STATE_MIN } from './router';

/**
 * The mod's settings, read from jev-opus's own `.env` (same keys, same
 * defaults as jev-opus src/config.ts). Only the file counts: the hooks module
 * reads no other environment for these keys.
 */
export interface ModConfig {
  /** null when no API key is configured: heuristics only */
  jev: JevClientOptions | null;
  bounds: Bounds;
  deep: { yes: number; no: number };
  followUp: { mode: 'on' | 'shadow' | null; yes: number; advisor: boolean };
  ablate: string[];
  stepStateMax: number;
}

/** KEY=VALUE lines; `#` comments, `export ` prefixes and matching quotes allowed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]!] = v;
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

export function modConfig(env: Record<string, string>): ModConfig {
  const apiKey = env.JEV_API_KEY || env.TYPESAFE_API_KEY || '';
  const dissat = (env.JEV_OPUS_DISSATISFACTION ?? '').trim().toLowerCase();
  return {
    jev: apiKey
      ? {
        apiKey,
        baseUrl: env.JEV_BASE_URL || 'https://api.typesafe.ai/v1/systemone',
        model: env.JEV_MODEL || 'jev-latest',
        // Jev sits in the request path, so the budget is small.
        deadlineMs: int(env.JEV_DEADLINE_MS, 2_500),
        breakerThreshold: int(env.JEV_BREAKER_THRESHOLD, 3, 1),
        breakerCooldownMs: int(env.JEV_BREAKER_COOLDOWN_MS, 30_000),
        confidence: (env.JEV_CONFIDENCE === 'server' ? 'server' : 'recompute') as ConfidenceMode,
      }
      : null,
    bounds: normalizeBounds({ min: effort(env.JEV_OPUS_MIN_EFFORT, 'low'), max: effort(env.JEV_OPUS_MAX_EFFORT, 'high') }),
    deep: { yes: unit(env.JEV_OPUS_DEEP_YES, DEEP_DEFAULTS.yes), no: unit(env.JEV_OPUS_DEEP_NO, DEEP_DEFAULTS.no) },
    followUp: {
      // 0 = off, shadow = ask and record only, anything else = on.
      mode: dissat === '0' ? null : dissat === 'shadow' ? 'shadow' : 'on',
      yes: unit(env.JEV_OPUS_DISSAT_YES, 0.75),
      advisor: env.JEV_OPUS_DISSAT_ADVISOR !== '0',
    },
    ablate: (env.JEV_OPUS_ABLATE || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    stepStateMax: int(env.JEV_OPUS_STEP_STATE_MAX, STEP_STATE_DEFAULT, STEP_STATE_MIN),
  };
}

/** Set the policy's module-level knobs, as the jev-opus CLI does at startup. */
export function applyPolicyConfig(c: ModConfig): void {
  setDeepThresholds(c.deep);
  setDissatThreshold(c.followUp.yes);
  setAblations(c.ablate);
  setStepStateMax(c.stepStateMax);
}
