// The model-route tool's pure parts (plan section 9.6): its arguments, the control lines it writes
// for an accepted recommendation, and the question Jev weighs the recommendation with.
import { expect, test } from 'claude-code/testing'
import { parseEffortLine, parseModelLine, parseModelReason } from '../src/brief'
import { modelNotes, recommendationQuestion, RECOMMENDATION_QUESTION } from '../src/judge'
import { parseRules } from '../src/rules'
import { parseRouteArgs, recommendedBrief } from '../src/route'
import { briefHey } from './data/briefs'
import { routingRules } from './data/jev-rules'

const rules = parseRules(routingRules, { deepYes: 0.85 })
// The architect's own words when it gave subagent B Haiku 5.5 (E9 step 5).
const REASON = 'one-line edit of greet.py plus one fixed shell command, no design decisions'

test('arguments: a brief alone, or a recommendation with its reason', () => {
  expect(parseRouteArgs({ description: 'Change greet output', prompt: briefHey })).toEqual({ description: 'Change greet output', prompt: briefHey })
  expect(parseRouteArgs({ description: 'd', prompt: briefHey, recommended_model: 'claude/claude-haiku-5-5', recommended_effort: 'low', reason: REASON }))
    .toEqual({ description: 'd', prompt: briefHey, recommended: { model: 'claude/claude-haiku-5-5', effort: 'low', reason: REASON } })
  expect(() => parseRouteArgs({ description: 'd', prompt: briefHey, recommended_model: 'claude/claude-haiku-5-5' })).toThrow('recommended_model needs a reason')
  expect(() => parseRouteArgs({ description: 'd', prompt: briefHey, reason: REASON })).toThrow('recommended_effort and reason go with recommended_model')
  expect(() => parseRouteArgs({ description: 'd', prompt: briefHey, recommended_model: 'x', recommended_effort: 'huge', reason: REASON })).toThrow('recommended_effort must be one of')
  expect(() => parseRouteArgs({ prompt: briefHey })).toThrow('description is required')
})

test('an accepted recommendation becomes the control lines decideSpawn reads', () => {
  const b = recommendedBrief(briefHey, { model: 'claude/claude-haiku-5-5', effort: 'low' }, `the architect recommended it: ${REASON}; Jev preferred it [0.71]`)
  expect(b.startsWith(briefHey)).toBe(true)
  expect(parseModelLine(b)).toBe('claude/claude-haiku-5-5')
  expect(parseModelReason(b)).toEqual({ kind: 'evidence', text: `the architect recommended it: ${REASON}; Jev preferred it (0.71)` })
  expect(parseEffortLine(b)).toBe('low')
})

test('Jev weighs the recommendation against the table\'s choice with the table\'s notes on both models', () => {
  const table = { model: 'claude/claude-mythos-5-2', effort: 'high', ruleId: 'code-change', condition: ruleById('code-change') }
  const q = recommendationQuestion({ brief: briefHey, table, recommended: { model: 'claude/claude-haiku-5-5', effort: 'low', reason: REASON } }, rules)
  expect(q.question.type === 'choice' && q.question.choices.map(c => c.value)).toEqual(['table', 'recommended'])
  expect(q.question.instructions).toBe(RECOMMENDATION_QUESTION)
  const text = q.input[0]!.content as string
  expect(text.includes(briefHey) && text.includes(REASON)).toBe(true)
  // Haiku's only entry in the table is the small-tasks substitute, with its limit; Mythos's include code-change.
  expect(modelNotes(rules, 'claude/claude-haiku-5-5')).toEqual([expect.stringContaining('substitute small-tasks for any rule: only when the person asks for it')])
  expect(text.includes('only when the person asks for it')).toBe(true)
  expect(modelNotes(rules, 'claude/claude-mythos-5-2').some(n => n.startsWith('rule code-change'))).toBe(true)
  // No rule fits: the recommendation, or neither.
  const none = recommendationQuestion({ brief: briefHey, table: null, recommended: { model: 'claude/claude-haiku-5-5', reason: REASON } }, rules)
  expect(none.question.type === 'choice' && none.question.choices.map(c => c.value)).toEqual(['recommended', 'none'])
})

function ruleById(id: string): string {
  return rules.rules.find(r => r.id === id)!.condition
}
