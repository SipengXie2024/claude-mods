/**
 * Jev client for OpenAI's Decisions API (POST https://api.openai.com/v1/decisions).
 *
 *   POST { model, input: [{ role, content }, ...], questions: [{ name, type, ... }] }
 *   →   { model, answers: [{ name, type, ... }], usage: { input_tokens, input_tokens_details: { cached_tokens } } }
 *
 * `input` is the conversation as a message array, newest last: OpenAI reuses
 * the cached prefix when messages are appended, and does not when the same
 * text is sent as one string (measured 2026-11-09). decisionsAnswers turns
 * the answers into the per-question shape validateAnswers checks.
 *
 * Never throws: any transport/validation failure yields `failed: true` with
 * per-question `signals`, so callers keep their heuristics. One overall
 * deadline bounds the call; a circuit breaker skips the fetch entirely while
 * Jev is failing repeatedly. The network and clock come from the hook that
 * asks (JevIo), since a hooks module has neither fetch nor timers of its own.
 */

import type { JevMessage } from './dialogue';

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: readonly string[] };

export type JevAnswer =
  | { kind: 'noul'; p: number }
  // Some Jev responses omit confidence. Preserve that distinction from an
  // explicit low-confidence answer while keeping the numeric legacy field.
  | { kind: 'choice'; choice: string; confidence: number; confidenceMissing?: true; probabilities: Record<string, number> }
  | { kind: 'score'; score: number; confidence: number; confidenceMissing?: true; probabilities: Record<string, number> };

/** Per-question outcome of validating one Jev response. */
export type JevSignal = 'valid' | 'missing' | 'invalid';

export interface JevResult {
  answers: Record<string, JevAnswer>;
  /** Validity per question. Optional only so older scripted JevLike stubs still satisfy the interface. */
  signals?: Record<string, JevSignal>;
  failed: boolean;
  error?: string;
  /** Set when the circuit breaker returned without calling Jev. */
  circuitOpen?: boolean;
  latencyMs: number;
  inputTokens: number;
  /** input tokens OpenAI read from its prompt cache */
  cachedTokens: number;
  /** The endpoint that produced this result (JevClientOptions.label). */
  provider?: string;
}

export interface JevLike {
  readonly enabled: boolean;
  ask(input: readonly JevMessage[], questions: Record<string, JevQuestion>): Promise<JevResult>;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const num01 = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const SCORE_EPSILON = 1e-6;

export type ConfidenceMode = 'recompute' | 'server';

/**
 * Confidence from the answer distribution, rescaled so uniform → 0 and
 * certain → 1: (n·pmax − 1)/(n − 1). Self-hosted servers report confidence
 * on different scales (e.g. 1 − entropy), while the router's gates were tuned
 * against one; recomputing keeps them comparable. Null when the map can't
 * support it, so the caller falls back to the server's value.
 */
function confidenceFromProbabilities(probabilities: Record<string, number>, n: number): number | null {
  const values = Object.values(probabilities);
  if (n < 2 || values.length === 0 || values.some((v) => v < 0)) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  if (!(sum > 0)) return null;
  // Normalize an over-full map, but never inflate a partial one: the options a
  // server left out still hold the missing probability mass.
  const pmax = Math.max(...values) / Math.max(sum, 1);
  return clamp01((n * pmax - 1) / (n - 1));
}

function validateAnswer(a: Record<string, unknown>, q: JevQuestion, mode: ConfidenceMode): JevAnswer | null {
  // Optional fields must still be well-formed when present — a malformed
  // response is rejected, never silently clamped into high confidence.
  if (a.confidence !== undefined && !num01(a.confidence)) return null;
  const probabilities: Record<string, number> = {};
  if (a.probabilities !== undefined) {
    if (a.probabilities === null || typeof a.probabilities !== 'object' || Array.isArray(a.probabilities)) return null;
    for (const [k, v] of Object.entries(a.probabilities)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      probabilities[k] = v;
    }
  }
  const options = q.type === 'choice' ? Object.keys(q.criteria).length : q.type === 'score' ? q.criteria.length : 0;
  const recomputed = mode === 'recompute' ? confidenceFromProbabilities(probabilities, options) : null;
  const confidence = recomputed ?? (num01(a.confidence) ? a.confidence : 0);
  if (q.type === 'noul') {
    return num01(a.noul) ? { kind: 'noul', p: a.noul } : null;
  }
  if (q.type === 'choice') {
    if (typeof a.choice !== 'string' || !Object.hasOwn(q.criteria, a.choice)) return null;
    return { kind: 'choice', choice: a.choice, confidence, ...(a.confidence === undefined ? { confidenceMissing: true as const } : {}), probabilities };
  }
  const top = q.criteria.length - 1;
  if (typeof a.score !== 'number' || !Number.isFinite(a.score)) return null;
  // Snap float32 noise (4.00000002) onto the bound; real violations stay invalid.
  const score = a.score < 0 && a.score >= -SCORE_EPSILON ? 0
    : a.score > top && a.score <= top + SCORE_EPSILON ? top
      : a.score;
  return score >= 0 && score <= top ? { kind: 'score', score, confidence, ...(a.confidence === undefined ? { confidenceMissing: true as const } : {}), probabilities } : null;
}

/**
 * Validate a raw Jev `answers` object against the question set. A question with
 * no entry is 'missing'; an entry that violates the schema is 'invalid'. Only
 * 'valid' questions appear in `answers` — no neutral stand-ins, no clamping
 * (beyond snapping sub-1e-6 float noise at the score bounds),
 * no manufactured first-category choices.
 */
export function validateAnswers(
  raw: unknown,
  questions: Record<string, JevQuestion>,
  opts: { confidence?: ConfidenceMode } = {},
): { answers: Record<string, JevAnswer>; signals: Record<string, JevSignal> } {
  const mode = opts.confidence ?? 'recompute';
  const all = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const answers: Record<string, JevAnswer> = {};
  const signals: Record<string, JevSignal> = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = all[name];
    if (a === undefined || a === null) {
      signals[name] = 'missing';
      continue;
    }
    const parsed =
      typeof a === 'object' && !Array.isArray(a) ? validateAnswer(a as Record<string, unknown>, q, mode) : null;
    if (parsed) {
      answers[name] = parsed;
      signals[name] = 'valid';
    } else {
      signals[name] = 'invalid';
    }
  }
  return { answers, signals };
}

/** Lone surrogates (e.g. from a naive slice upstream) make a request body invalid; replace them. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (s: string) => s.replace(LONE_SURROGATE, '\uFFFD');

/**
 * An ask as an OpenAI Decisions request: noul becomes a predicate, a choice's
 * criteria become its choices in the order the question set lists them (the
 * order shifts the probabilities), a score's criteria its levels.
 */
export function decisionsRequest(input: readonly JevMessage[], model: string, questions: Record<string, JevQuestion>): unknown {
  return {
    model,
    input: input.map((m) => ({ role: m.role, content: wellFormed(m.content) })),
    questions: Object.entries(questions).map(([name, q]) =>
      q.type === 'noul' ? { name, type: 'predicate', instructions: q.instructions }
        : q.type === 'choice' ? { name, type: 'choice', instructions: q.instructions, choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description })) }
          : { name, type: 'score', instructions: q.instructions, levels: q.criteria.map((c) => ({ label: c, description: c })) }),
  };
}

/** `[{ value, probability }]` as `{ value: probability }`; anything else is passed on for validateAnswers to reject. */
function probabilityMap(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return Object.fromEntries(raw.map((p: { value?: unknown; probability?: unknown }) => [String(p?.value), p?.probability]));
}

/**
 * OpenAI Decisions answers (an array, one entry per question) in the
 * per-question shape validateAnswers checks. A refusal or an unknown answer type is
 * left out, so its question counts as missing.
 */
export function decisionsAnswers(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(raw)) return out;
  for (const a of raw as Array<Record<string, unknown> | null>) {
    if (!a || typeof a.name !== 'string') continue;
    if (a.type === 'predicate') out[a.name] = { noul: a.probability };
    else if (a.type === 'choice') out[a.name] = { choice: a.choice, confidence: a.confidence, probabilities: probabilityMap(a.probabilities) };
    else if (a.type === 'score') out[a.name] = { score: a.score, confidence: a.confidence, probabilities: probabilityMap(a.probabilities) };
  }
  return out;
}

function missingSignals(questions: Record<string, JevQuestion>): Record<string, JevSignal> {
  return Object.fromEntries(Object.keys(questions).map((k) => [k, 'missing' as const]));
}

/** What one ask needs from the hook that makes it: `$.http.fetch`, `$.clock.now`, `$.clock.sleep`. */
export interface JevIo {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; ok: boolean; text: string }>;
  now(): Promise<number>;
  /** Resolves after ms; rejects once `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** The one Jev service: OpenAI's Decisions API. */
export const DECISIONS_URL = 'https://api.openai.com/v1/decisions';
export const DEFAULT_MODEL = 'gpt-6-luna';

export interface JevClientOptions {
  apiKey: string;
  /** Decisions model (JEV_MODEL, default gpt-6-luna). */
  model?: string;
  /** Overall deadline for one ask(). */
  deadlineMs?: number;
  /** Consecutive failures before the circuit opens. */
  breakerThreshold?: number;
  /** How long the circuit stays open before one probe is allowed. */
  breakerCooldownMs?: number;
  /** Where answer confidence comes from (JEV_CONFIDENCE). */
  confidence?: ConfidenceMode;
}

const TIMEOUT = 'timeout' as const;
const SLEEP_REJECTED = 'sleep-rejected' as const;

/**
 * The deadline of one ask (JEV_DEADLINE_MS). Measured on gpt-6-luna
 * (2026-11-09): 54K input tokens 0.45 s, 214K 1.2 s, 422K 3.2 s, 861K 8.3 s;
 * Jev's input is a part of Claude Code's context (at most 872K tokens under
 * claude-magpie), so 10 s covers the largest one.
 */
export const DEFAULT_DEADLINE_MS = 10_000;

/** Recorded on each result: which service answered. */
const PROVIDER = new URL(DECISIONS_URL).host;

export class JevClient {
  private readonly apiKey: string;
  readonly label = PROVIDER;
  private readonly model: string;
  private readonly deadlineMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly confidenceMode: ConfidenceMode;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private probing = false;

  constructor(opts: JevClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.breakerThreshold = Math.max(1, opts.breakerThreshold ?? 3);
    this.breakerCooldownMs = opts.breakerCooldownMs ?? 30_000;
    this.confidenceMode = opts.confidence ?? 'recompute';
  }

  get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  /** The client with one hook's I/O bound, as the router asks it. */
  bind(io: JevIo): JevLike {
    return { enabled: this.enabled, ask: (input, questions) => this.ask(input, questions, io) };
  }

  private noteSuccess(): void {
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
    this.probing = false;
  }

  private noteFailure(now: number): void {
    this.consecutiveFailures++;
    // A failed probe re-opens immediately; otherwise open at the threshold.
    if (this.probing || this.consecutiveFailures >= this.breakerThreshold) {
      this.breakerOpenUntil = now + this.breakerCooldownMs;
    }
    this.probing = false;
  }

  private failure(questions: Record<string, JevQuestion>, error: string, latencyMs: number, extra: Partial<JevResult> = {}): JevResult {
    return { answers: {}, signals: missingSignals(questions), failed: true, error, latencyMs, inputTokens: 0, cachedTokens: 0, provider: this.label, ...extra };
  }

  async ask(input: readonly JevMessage[], questions: Record<string, JevQuestion>, io: JevIo): Promise<JevResult> {
    if (!this.enabled) return this.failure(questions, 'no key', 0);
    const start = await io.now();
    // Circuit breaker: while open, fail without fetching. After the cooldown,
    // the first real call becomes the single recovery probe.
    if (this.breakerOpenUntil > 0 && (start < this.breakerOpenUntil || this.probing)) {
      return this.failure(questions, 'circuit open', 0, { circuitOpen: true });
    }
    const probe = this.breakerOpenUntil > 0;
    if (probe) this.probing = true;
    // A probe that ends without noteSuccess or noteFailure (its hook's clock
    // rejected) must not leave the breaker probing, and so open, for good.
    try {
      return await this.attempt(input, questions, io, start);
    } finally {
      if (probe) this.probing = false;
    }
  }

  private async attempt(input: readonly JevMessage[], questions: Record<string, JevQuestion>, io: JevIo, start: number): Promise<JevResult> {
    let lastError = 'request failed';
    let signals = missingSignals(questions);
    // $.http.fetch takes no signal: the deadline is a race, and a fetch that
    // loses it is left to finish on its own, its answer unused.
    const stop = new AbortController();
    const deadline: Promise<typeof TIMEOUT | typeof SLEEP_REJECTED> = io.sleep(this.deadlineMs, stop.signal).then(() => TIMEOUT, () => SLEEP_REJECTED);
    try {
      const fetched = io.fetch(DECISIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(decisionsRequest(input, this.model, questions)),
      });
      fetched.catch(() => {});
      const res = await Promise.race([fetched, deadline]);
      if (res === TIMEOUT) {
        lastError = 'deadline exceeded';
      } else if (res === SLEEP_REJECTED) {
        lastError = 'clock sleep rejected';
      } else if (res.status === 429 || res.status >= 500) {
        lastError = `Jev HTTP ${res.status}`;
      } else if (!res.ok) {
        lastError = `Jev HTTP ${res.status}: ${res.text.slice(0, 200)}`;
      } else {
        const data = JSON.parse(res.text) as { answers?: unknown; usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number } } };
        const parsed = validateAnswers(decisionsAnswers(data.answers), questions, { confidence: this.confidenceMode });
        signals = parsed.signals;
        const inputTokens = data.usage?.input_tokens ?? 0;
        const cachedTokens = data.usage?.input_tokens_details?.cached_tokens ?? 0;
        const latencyMs = Math.max(0, (await io.now()) - start);
        if (Object.values(signals).includes('valid')) {
          this.noteSuccess();
          return { answers: parsed.answers, signals, failed: false, latencyMs, inputTokens, cachedTokens, provider: this.label };
        }
        lastError = 'no valid answers in response';
      }
    } catch (err) {
      lastError = (err as Error)?.message || 'request failed';
    } finally {
      stop.abort();
    }
    const end = await io.now();
    this.noteFailure(end);
    return { ...this.failure(questions, lastError, Math.max(0, end - start)), signals };
  }
}
