// The pure parts of judge.ts (plan section 12.1, judge and blocker rows): the rule threshold, the
// substitute evaluator's JSON, and the low-confidence blocker rule. Jev answers are real responses
// saved by io-tests/judge.spec.ts; the evaluator reply is a real claude-magpie -p answer to the
// substitute prompt; the rules are rules/routing-rules.json, carried as a module.
import { expect, test } from 'claude-code/testing'
import { parseResponse } from '../src/jev'
import { blockerPick, decideRule, parseSubstitute, rankedBlockers, spawnJudgment, spawnQuestions, substitutePrompt } from '../src/judge'
import { parseRules, type Rules } from '../src/rules'
import { jevBlockerNew, jevBlockerSame, jevSpawnBatchJudge, jevSpawnLineCount, jevSpawnNoRule, jevSpawnScheduler, jevSubstituteSpawn, type SavedDecision } from './data/jev-responses'
import { routingRules } from './data/jev-rules'

const rules = parseRules(routingRules, { deepYes: 0.85 })
const withThresholds = (t: Partial<Rules['thresholds']>): Rules => ({ ...rules, thresholds: { ...rules.thresholds, ...t } })
const judgment = (s: SavedDecision, r: Rules = rules) => {
  const p = parseResponse(s.body, s.request.questions)
  return spawnJudgment(p.answers, { latencyMs: 0, inputTokens: p.inputTokens, ...(p.cachedTokens !== undefined ? { cachedTokens: p.cachedTokens } : {}) }, r)
}

test('the saved spawn requests asked the current rule and deep questions', () => {
  expect(jevSpawnScheduler.request.questions).toEqual(spawnQuestions(rules))
  expect(jevSpawnLineCount.request.questions).toEqual(spawnQuestions(rules))
  const rule = spawnQuestions(rules)[0]!
  expect(rule.type === 'choice' ? rule.choices.map(c => c.value).at(-1) : rule.type).toBe('none')
})

test('a rule Jev chose at or above ruleConfidence routes; below it, the reason names choice, confidence and threshold', () => {
  const j = judgment(jevSpawnScheduler)
  expect(j.provider).toBe('jev')
  expect(j.ruleChoice).toBe('code-change')
  expect(j.questionSet).toBe('rules-q.v5')
  expect(decideRule(j, rules)).toEqual({ ruleId: 'code-change' })
  expect(decideRule(j, withThresholds({ ruleConfidence: j.confidence }))).toEqual({ ruleId: 'code-change' })
  // The batch-judge brief, where Jev is less sure: a threshold above its confidence leaves no rule.
  const unsure = judgment(jevSpawnBatchJudge)
  expect(unsure.confidence).toBeLessThan(0.9)
  const below = decideRule(unsure, withThresholds({ ruleConfidence: 0.9 }))
  expect(below).toEqual({ none: `Jev's first choice was ${unsure.ruleChoice} with confidence ${unsure.confidence.toFixed(2)}, below the threshold 0.9` })
})

test('Jev\'s none never routes, whatever the threshold', () => {
  const j = judgment(jevSpawnNoRule)
  expect(j.ruleChoice).toBe('none')
  expect('none' in decideRule(j, withThresholds({ ruleConfidence: 0 }))).toBe(true)
})

test('a rule Jev cannot choose throws instead of routing', () => {
  expect(() => decideRule({ ...judgment(jevSpawnScheduler), ruleChoice: 'route-assessment' }, rules)).toThrow('route-assessment is not a rule Jev can choose')
  expect(() => decideRule({ ...judgment(jevSpawnScheduler), ruleChoice: 'no-such-rule' }, rules)).toThrow('no rule "no-such-rule"')
})

test('deep is Jev\'s probability at or above deepYes', () => {
  const j = judgment(jevSpawnScheduler)
  expect(j.deepP).toBe(0.29)
  expect(j.deep).toBe(false)
  expect(judgment(jevSpawnScheduler, withThresholds({ deepYes: 0.29 })).deep).toBe(true)
})

test('the substitute prompt is the one the saved evaluator reply answered, and the reply parses', () => {
  expect(substitutePrompt(spawnQuestions(rules), jevSpawnScheduler.request.input)).toBe(jevSubstituteSpawn.prompt)
  const a = parseSubstitute(jevSubstituteSpawn.reply, spawnQuestions(rules))
  expect(a.choice).toEqual({ rule: 'code-change' })
  expect(a.confidence).toBe(0.95)
  expect(a.yes).toEqual({ deep: false })
  // The same reply inside a ```json fence.
  expect(parseSubstitute('```json\n' + jevSubstituteSpawn.reply.trim() + '\n```', spawnQuestions(rules)).choice).toEqual({ rule: 'code-change' })
})

test('a substitute reply that is not JSON, empty, or missing a field throws', () => {
  const q = spawnQuestions(rules)
  const reply = JSON.parse(jevSubstituteSpawn.reply) as Record<string, unknown>
  expect(() => parseSubstitute('The task fits code-change.', q)).toThrow('the answer is not JSON')
  expect(() => parseSubstitute('  \n', q)).toThrow('the evaluator gave no answer')
  expect(() => parseSubstitute('["code-change"]', q)).toThrow('not a JSON object')
  const { deep: _deep, ...noDeep } = reply
  expect(() => parseSubstitute(JSON.stringify(noDeep), q)).toThrow('"deep" is undefined, not true or false')
  const { confidence: _c, ...noConfidence } = reply
  expect(() => parseSubstitute(JSON.stringify(noConfidence), q)).toThrow('"confidence" is undefined')
  expect(() => parseSubstitute(JSON.stringify({ ...reply, rule: 'route-assessment' }), q)).toThrow('"rule" is "route-assessment", not one of')
})

test('blocker: an existing blocker stands; new stands at or above the threshold, else the most likely existing one', () => {
  const pick = (s: SavedDecision, threshold: number) => {
    const a = parseResponse(s.body, s.request.questions).answers['blocker']!
    if (a.kind !== 'choice') throw new Error('blocker answer kind')
    return blockerPick(a.choice, a.confidence, rankedBlockers(a.probabilities, ['b1']), threshold)
  }
  expect(jevBlockerSame.request.questions[0]!.type === 'choice' && jevBlockerSame.request.questions[0]!.choices.map(c => c.value)).toEqual(['b1', 'new'])
  expect(pick(jevBlockerSame, rules.thresholds.ruleConfidence)).toBe('b1')
  expect(pick(jevBlockerSame, 1)).toBe('b1')
  expect(pick(jevBlockerNew, rules.thresholds.ruleConfidence)).toBeNull()
  expect(pick(jevBlockerNew, 0.999)).toBe('b1')
})

test('rankedBlockers orders by probability, ties in blocker order; blockerPick needs an earlier blocker to fall back on', () => {
  expect(rankedBlockers({ b1: 0.2, b2: 0.5, b3: 0.2, new: 0.1 }, ['b1', 'b2', 'b3'])).toEqual(['b2', 'b1', 'b3'])
  expect(rankedBlockers({ new: 1 }, ['b1', 'b2'])).toEqual(['b1', 'b2'])
  expect(() => blockerPick('new', 0.1, [], 0.5)).toThrow('no earlier blocker')
})
