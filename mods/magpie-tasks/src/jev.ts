// Jev client for OpenAI's Decisions API (plan section 6.1). magpie-tasks and mods/jev are separate
// plugin roots and cannot import each other, so this is the plugin's own small client.
//
//   POST { model, input: [{ role, content }, ...], questions: [...] }
//   →    { answers: [{ name, type, ... }], usage: { input_tokens, input_tokens_details: { cached_tokens } } }
//
// `input` is always a message array in its original order, newest last: OpenAI reuses the cached
// prefix when messages are appended, and does not when the same text is sent as one string
// (measured 2026-11-09). One request per judgment, no retry and no circuit breaker: a failure goes
// straight to the substitute judgment in judge.ts.
import type { Io } from './io'

export type JevMessage = { role: 'user' | 'assistant'; content: string }
export type JevQuestion =
  | { name: string; type: 'choice'; instructions: string; choices: { value: string; description: string }[] }
  | { name: string; type: 'predicate'; instructions: string }
export type JevAnswer = { kind: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> } | { kind: 'predicate'; p: number }
export type JevResult =
  | { ok: true; answers: Record<string, JevAnswer>; latencyMs: number; inputTokens: number; cachedTokens?: number }
  | { ok: false; error: string; latencyMs: number }
export interface JevConfig { url: string; model: string; keyFile: string; deadlineMs: number }

// A lone surrogate (from a slice upstream) makes the request body invalid JSON for the API.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const wellFormed = (s: string) => s.replace(LONE_SURROGATE, '�')

export function buildRequest(model: string, input: JevMessage[], questions: JevQuestion[]): unknown {
  return {
    model,
    input: input.map(m => ({ role: m.role, content: wellFormed(m.content) })),
    questions: questions.map(q =>
      q.type === 'choice'
        ? { name: q.name, type: 'choice', instructions: wellFormed(q.instructions), choices: q.choices.map(c => ({ value: c.value, description: wellFormed(c.description) })) }
        : { name: q.name, type: 'predicate', instructions: wellFormed(q.instructions) }),
  }
}

const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

// Confidence from the answer distribution, as JEV computes it: (n·pmax − 1)/(n − 1), so a uniform
// distribution over the n options is 0 and a certain answer is 1. An over-full map is normalised;
// a partial one is not inflated, since the options left out still hold the missing mass.
export function recomputedConfidence(probabilities: Record<string, number>, n: number): number {
  if (!Number.isInteger(n) || n < 2) throw new Error(`recomputedConfidence: a choice needs at least 2 options, got ${n}`)
  const values = Object.values(probabilities)
  if (values.length === 0) throw new Error('recomputedConfidence: no probabilities')
  if (values.some(v => !(Number.isFinite(v) && v >= 0))) throw new Error('recomputedConfidence: a probability is negative or not a number')
  const sum = values.reduce((a, v) => a + v, 0)
  if (!(sum > 0)) throw new Error('recomputedConfidence: probabilities sum to 0')
  const pmax = Math.max(...values) / Math.max(sum, 1)
  return Math.min(1, Math.max(0, (n * pmax - 1) / (n - 1)))
}

function invalid(what: string): never {
  throw new Error(`Jev response: ${what}`)
}

function parseChoice(a: Record<string, unknown>, q: Extract<JevQuestion, { type: 'choice' }>): JevAnswer {
  const values = q.choices.map(c => c.value)
  if (typeof a['choice'] !== 'string' || !values.includes(a['choice'])) invalid(`${q.name}: choice ${JSON.stringify(a['choice'])} is not one of the options`)
  const raw = a['probabilities']
  if (!Array.isArray(raw) || raw.length === 0) invalid(`${q.name}: probabilities is not a non-empty list`)
  const probabilities: Record<string, number> = {}
  for (const p of raw as unknown[]) {
    const entry = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>
    const value = entry['value']
    if (typeof value !== 'string' || !values.includes(value)) invalid(`${q.name}: probability for ${JSON.stringify(value)}, which is not an option`)
    if (!isUnit(entry['probability'])) invalid(`${q.name}: probability of ${value} is not a number in [0, 1]`)
    if (Object.hasOwn(probabilities, value)) invalid(`${q.name}: two probabilities for ${value}`)
    probabilities[value] = entry['probability']
  }
  return { kind: 'choice', choice: a['choice'], confidence: recomputedConfidence(probabilities, values.length), probabilities }
}

// The answers of a Decisions response body, one per question; a question without an answer, or with
// one that breaks the question's schema, throws.
export function parseResponse(text: string, questions: JevQuestion[]): { answers: Record<string, JevAnswer>; inputTokens: number; cachedTokens?: number } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    invalid('not JSON')
  }
  if (typeof data !== 'object' || data === null) invalid('not an object')
  const body = data as Record<string, unknown>
  if (!Array.isArray(body['answers'])) invalid('answers is not a list')
  const byName = new Map<string, Record<string, unknown>>()
  for (const a of body['answers'] as unknown[]) {
    if (typeof a !== 'object' || a === null) invalid('an answer is not an object')
    const name = (a as Record<string, unknown>)['name']
    if (typeof name === 'string') byName.set(name, a as Record<string, unknown>)
  }
  const answers: Record<string, JevAnswer> = {}
  for (const q of questions) {
    const a = byName.get(q.name)
    if (a === undefined) invalid(`no answer to ${q.name}`)
    if (a['type'] !== q.type) invalid(`${q.name}: answer type ${JSON.stringify(a['type'])}, asked ${q.type}`)
    if (q.type === 'choice') {
      answers[q.name] = parseChoice(a, q)
    } else {
      if (!isUnit(a['probability'])) invalid(`${q.name}: probability is not a number in [0, 1]`)
      answers[q.name] = { kind: 'predicate', p: a['probability'] }
    }
  }
  const usage = (typeof body['usage'] === 'object' && body['usage'] !== null ? body['usage'] : {}) as Record<string, unknown>
  if (!isCount(usage['input_tokens'])) invalid('usage.input_tokens is missing')
  const details = (typeof usage['input_tokens_details'] === 'object' && usage['input_tokens_details'] !== null ? usage['input_tokens_details'] : {}) as Record<string, unknown>
  const cached = details['cached_tokens']
  if (cached !== undefined && !isCount(cached)) invalid('usage.input_tokens_details.cached_tokens is not a count')
  return { answers, inputTokens: usage['input_tokens'], ...(cached !== undefined ? { cachedTokens: cached } : {}) }
}

// The key of each key file, read on the first ask that uses it. Never logged or put in an error.
const keys = new Map<string, string>()

async function keyFor(io: Io, keyFile: string): Promise<string | { error: string }> {
  const known = keys.get(keyFile)
  if (known !== undefined) return known
  if (!(await io.exists(keyFile))) return { error: 'key file missing' }
  let text: string
  try {
    text = await io.read(keyFile)
  } catch (error) {
    return { error: `key file unreadable: ${(error as Error).message}` }
  }
  const key = text.trim()
  if (key === '') return { error: 'key file missing' }
  keys.set(keyFile, key)
  return key
}

// The error category OpenAI names in an error body (`error.code`, else `error.type`), never its
// message: a message can quote the request.
function errorCategory(text: string): string {
  try {
    const e = (JSON.parse(text) as { error?: { code?: unknown; type?: unknown } }).error
    const c = typeof e?.code === 'string' ? e.code : typeof e?.type === 'string' ? e.type : ''
    return /^[\w.-]{1,80}$/.test(c) ? ` ${c}` : ''
  } catch {
    return ''
  }
}

const TIMEOUT = 'timeout' as const

// One Decisions request. Never throws: a missing key, the deadline, a non-2xx status (429 too) and
// an invalid body all answer `ok: false` with a reason that holds only a status and a category.
export async function ask(io: Io, cfg: JevConfig, input: JevMessage[], questions: JevQuestion[]): Promise<JevResult> {
  const start = await io.now()
  const elapsed = async () => Math.max(0, (await io.now()) - start)
  const key = await keyFor(io, cfg.keyFile)
  if (typeof key !== 'string') return { ok: false, error: key.error, latencyMs: await elapsed() }
  const fetched = io.fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildRequest(cfg.model, input, questions)),
  })
  // A fetch that loses the race may still reject later; nothing waits for it.
  fetched.catch(() => {})
  let res: Awaited<typeof fetched> | typeof TIMEOUT
  try {
    res = await Promise.race([fetched, io.sleep(cfg.deadlineMs).then(() => TIMEOUT)])
  } catch (error) {
    return { ok: false, error: `request failed: ${(error as Error).message}`, latencyMs: await elapsed() }
  }
  if (res === TIMEOUT) return { ok: false, error: `deadline exceeded (${cfg.deadlineMs} ms)`, latencyMs: await elapsed() }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}${errorCategory(res.text)}`, latencyMs: await elapsed() }
  let parsed: ReturnType<typeof parseResponse>
  try {
    parsed = parseResponse(res.text, questions)
  } catch (error) {
    return { ok: false, error: `invalid response: ${(error as Error).message.replace(/^Jev response: /, '')}`, latencyMs: await elapsed() }
  }
  return { ok: true, answers: parsed.answers, latencyMs: await elapsed(), inputTokens: parsed.inputTokens, ...(parsed.cachedTokens !== undefined ? { cachedTokens: parsed.cachedTokens } : {}) }
}
