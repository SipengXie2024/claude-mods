// The Decisions response parser on real response bodies saved by io-tests/jev.spec.ts and
// io-tests/judge.spec.ts (plan section 12.1, jev parsing row), the request builder against the
// requests those bodies answered, and the confidence formula.
import { expect, test } from 'claude-code/testing'
import { buildRequest, parseResponse, recomputedConfidence, type JevQuestion } from '../src/jev'
import { jevBlockerNew, jevChoicePredicate, jevSpawnLineCount, jevSpawnScheduler, type SavedDecision } from './data/jev-responses'

const SAVED: Record<string, SavedDecision> = { jevChoicePredicate, jevSpawnScheduler, jevSpawnLineCount, jevBlockerNew }
const body = (s: SavedDecision) => JSON.parse(s.body) as { answers: Record<string, unknown>[]; usage: Record<string, unknown> }

test('the builder writes the request each saved body answered', () => {
  for (const [name, s] of Object.entries(SAVED)) {
    expect([name, buildRequest(s.request.model, s.request.input, s.request.questions)]).toEqual([name, s.request])
  }
})

test('a choice and a predicate are parsed; confidence is recomputed from the probabilities', () => {
  const r = parseResponse(jevChoicePredicate.body, jevChoicePredicate.request.questions)
  const kind = r.answers['kind']!
  const deep = r.answers['deep']!
  if (kind.kind !== 'choice' || deep.kind !== 'predicate') throw new Error('answer kinds')
  expect(kind.choice).toBe('explain')
  expect(kind.probabilities).toEqual({ operate: 0.4, code: 0.01, explain: 0.59 })
  // The server said 0.38; (3 × 0.59 − 1) / 2 = 0.385.
  expect(Math.abs(kind.confidence - 0.385) < 1e-9).toBe(true)
  expect(deep.p).toBe(0.01)
  expect(r.inputTokens).toBe(576)
  expect(r.cachedTokens).toBe(0)
})

test('every saved body parses against the questions it was asked', () => {
  for (const [name, s] of Object.entries(SAVED)) {
    const r = parseResponse(s.body, s.request.questions)
    expect([name, Object.keys(r.answers).sort()]).toEqual([name, s.request.questions.map(q => q.name).sort()])
    expect(r.inputTokens).toBeGreaterThan(0)
  }
})

test('a question without an answer throws', () => {
  const extra: JevQuestion = { name: 'extra', type: 'predicate', instructions: 'Is there more?' }
  expect(() => parseResponse(jevChoicePredicate.body, [...jevChoicePredicate.request.questions, extra])).toThrow('no answer to extra')
})

test('a choice outside the options asked throws', () => {
  // The same body read against a kind question without the option Jev chose.
  const questions = jevChoicePredicate.request.questions.map(q => (q.type === 'choice' ? { ...q, choices: q.choices.filter(c => c.value !== 'explain') } : q))
  expect(() => parseResponse(jevChoicePredicate.body, questions)).toThrow('is not one of the options')
})

test('an answer of another type than asked throws', () => {
  const questions: JevQuestion[] = jevChoicePredicate.request.questions.map(q => (q.name === 'deep' ? q : { name: q.name, type: 'predicate', instructions: q.instructions }))
  expect(() => parseResponse(jevChoicePredicate.body, questions)).toThrow('answer type "choice", asked predicate')
})

test('a cut body, a body without usage, and a probability out of range throw', () => {
  const q = jevChoicePredicate.request.questions
  expect(() => parseResponse(jevChoicePredicate.body.slice(0, 60), q)).toThrow('not JSON')
  const noUsage = body(jevChoicePredicate)
  delete (noUsage as { usage?: unknown }).usage
  expect(() => parseResponse(JSON.stringify(noUsage), q)).toThrow('usage.input_tokens is missing')
  const high = body(jevChoicePredicate)
  high.answers.find(a => a['name'] === 'deep')!['probability'] = 1.5
  expect(() => parseResponse(JSON.stringify(high), q)).toThrow('deep: probability is not a number in [0, 1]')
})

test('recomputedConfidence: uniform is 0, certain is 1, a partial map is not inflated', () => {
  expect(recomputedConfidence({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }, 3) < 1e-12).toBe(true)
  expect(recomputedConfidence({ a: 1, b: 0, c: 0 }, 3)).toBe(1)
  expect(recomputedConfidence({ a: 0.5 }, 2)).toBe(0)
  expect(recomputedConfidence({ a: 1, b: 1 }, 2)).toBe(0)
  expect(Math.abs(recomputedConfidence({ a: 0.9, b: 0.1 }, 2) - 0.8) < 1e-12).toBe(true)
  expect(() => recomputedConfidence({ a: 1 }, 1)).toThrow('at least 2 options')
  expect(() => recomputedConfidence({}, 3)).toThrow('no probabilities')
})
