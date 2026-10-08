/**
 * TypeSafe Jev System-1 client (port of jev-opus src/jev/client.ts).
 *
 * Wire format:
 *   POST { state, model, questions: { name: { type, instructions, criteria? } } }
 *   →   { model, answers: { name: {...} }, usage: { input_tokens, output_tokens } }
 *
 * Never throws: any transport/validation failure yields `failed: true` with
 * per-question `signals`, so callers can fall back to heuristics. One overall
 * deadline bounds the call; a circuit breaker skips the fetch entirely while
 * Jev is failing repeatedly. The network and clock come from the hook that
 * asks (JevIo), since a hooks module has neither fetch nor timers of its own.
 */

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
}

export interface JevLike {
  readonly enabled: boolean;
  ask(state: string, questions: Record<string, JevQuestion>): Promise<JevResult>;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const num01 = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const SCORE_EPSILON = 1e-6;

export function neutralAnswers(questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'noul') out[name] = { kind: 'noul', p: 0.5 };
    else if (q.type === 'choice') out[name] = { kind: 'choice', choice: Object.keys(q.criteria)[0] ?? '', confidence: 0, probabilities: {} };
    else out[name] = { kind: 'score', score: (q.criteria.length - 1) / 2, confidence: 0, probabilities: {} };
  }
  return out;
}

export function parseAnswers(raw: unknown, questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  const all = (raw ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const neutral = neutralAnswers(questions);
  const out: Record<string, JevAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = all[name];
    if (!a) { out[name] = neutral[name]!; continue; }
    const probabilities = (typeof a.probabilities === 'object' && a.probabilities ? a.probabilities : {}) as Record<string, number>;
    if (q.type === 'noul') {
      out[name] = { kind: 'noul', p: clamp01(Number(a.noul ?? 0.5)) };
    } else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const choice = typeof a.choice === 'string' && keys.includes(a.choice) ? a.choice : keys[0] ?? '';
      out[name] = { kind: 'choice', choice, confidence: clamp01(Number(a.confidence ?? 0)), ...(a.confidence === undefined ? { confidenceMissing: true as const } : {}), probabilities };
    } else {
      const top = q.criteria.length - 1;
      const score = Math.min(top, Math.max(0, Number(a.score ?? top / 2)));
      out[name] = { kind: 'score', score: Number.isFinite(score) ? score : top / 2, confidence: clamp01(Number(a.confidence ?? 0)), ...(a.confidence === undefined ? { confidenceMissing: true as const } : {}), probabilities };
    }
  }
  return out;
}

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

export interface JevClientOptions {
  apiKey: string;
  baseUrl: string;
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

export class JevClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
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
    this.baseUrl = opts.baseUrl;
    this.model = opts.model ?? 'jev-latest';
    this.deadlineMs = opts.deadlineMs ?? 2_500;
    this.breakerThreshold = Math.max(1, opts.breakerThreshold ?? 3);
    this.breakerCooldownMs = opts.breakerCooldownMs ?? 30_000;
    this.confidenceMode = opts.confidence ?? 'recompute';
  }

  get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  /** The client with one hook's I/O bound, as the router asks it. */
  bind(io: JevIo): JevLike {
    return { enabled: this.enabled, ask: (state, questions) => this.ask(state, questions, io) };
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

  async ask(state: string, questions: Record<string, JevQuestion>, io: JevIo): Promise<JevResult> {
    const start = await io.now();
    if (!this.enabled) {
      return { answers: {}, signals: missingSignals(questions), failed: true, error: 'JEV_API_KEY not set', latencyMs: 0, inputTokens: 0 };
    }
    // Circuit breaker: while open, fail without fetching. After the cooldown,
    // the first real call becomes the single recovery probe.
    if (this.breakerOpenUntil > 0 && (start < this.breakerOpenUntil || this.probing)) {
      return { answers: {}, signals: missingSignals(questions), failed: true, error: 'circuit open', circuitOpen: true, latencyMs: 0, inputTokens: 0 };
    }
    if (this.breakerOpenUntil > 0) this.probing = true;

    let lastError = 'request failed';
    let signals = missingSignals(questions);
    // $.http.fetch takes no signal: the deadline is a race, and a fetch that
    // loses it is left to finish on its own, its answer unused.
    const stop = new AbortController();
    const deadline: Promise<typeof TIMEOUT | null> = io.sleep(this.deadlineMs, stop.signal).then(() => TIMEOUT, () => null);
    try {
      const fetched = io.fetch(this.baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model: this.model, questions }),
      });
      fetched.catch(() => {});
      const res = await Promise.race([fetched, deadline]);
      if (res === TIMEOUT || res === null) {
        lastError = 'deadline exceeded';
      } else if (res.status === 429 || res.status >= 500) {
        lastError = `Jev HTTP ${res.status}`;
      } else if (!res.ok) {
        lastError = `Jev HTTP ${res.status}: ${res.text.slice(0, 200)}`;
      } else {
        const data = JSON.parse(res.text) as { answers?: unknown; usage?: { input_tokens?: number } };
        const parsed = validateAnswers(data.answers, questions, { confidence: this.confidenceMode });
        signals = parsed.signals;
        const inputTokens = data.usage?.input_tokens ?? 0;
        const latencyMs = Math.max(0, (await io.now()) - start);
        if (Object.values(signals).includes('valid')) {
          this.noteSuccess();
          return { answers: parsed.answers, signals, failed: false, latencyMs, inputTokens };
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
    return { answers: {}, signals, failed: true, error: lastError, latencyMs: Math.max(0, end - start), inputTokens: 0 };
  }
}
