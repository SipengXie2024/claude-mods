// The model-route tool's recommendation question with the real Jev (plan section 9.6). The case is
// E9 step 5 (2026-11-10): the architect gave a one-line edit to Haiku 5.5 at low with its own reason,
// where the routing table's code-change rule names Mythos 5.2 at high. The answer is printed for the
// record; there is no accuracy bar here.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decideRule, judgeRecommendation, judgeSpawn, recommendationQuestion, type JudgeCtx } from '../src/judge'
import { loadRules, ruleById, startEffort } from '../src/rules'
import { PLUGIN_ROOT } from '../eval/rules-eval'
import { nodeIo } from './node-io'

const JEV = { url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', keyFile: join(homedir(), '.config/jev-opus/openai-jev.key'), deadlineMs: 30000 }
const rules = await loadRules(nodeIo(), PLUGIN_ROOT)
const ctx: JudgeCtx = {
  io: nodeIo(), jev: JEV, rules, evaluatorModel: 'claude/claude-opus-5-5',
  complete: async () => { throw new Error('$.model.complete is available only inside a hook; Jev failed in this test') },
}
const BRIEF = readFileSync(join(PLUGIN_ROOT, 'tests/data/brief-hey-a08c611ec43c93282.txt'), 'utf8')
const REASON = 'one-line edit of greet.py plus one fixed shell command, no design decisions'

test('Jev weighs the architect\'s Haiku recommendation for a one-line edit against the table\'s choice', async () => {
  const j = await judgeSpawn(ctx, [{ role: 'user', content: BRIEF }])
  expect(j.provider).toBe('jev')
  const decided = decideRule(j, rules)
  const table = 'ruleId' in decided
    ? (() => { const r = ruleById(rules, decided.ruleId); return { model: r.model!, effort: startEffort(r, j.deep), ruleId: r.id, condition: r.condition } })()
    : null
  const v = await judgeRecommendation(ctx, recommendationQuestion({ brief: BRIEF, table, recommended: { model: 'claude/claude-haiku-5-5', effort: 'low', reason: REASON } }, rules))
  console.log(JSON.stringify({ rule: j.ruleChoice, confidence: j.confidence, deep: j.deep, table: table?.model ?? null, verdict: v }))
  expect(v.ok).toBe(true)
  if (v.ok) expect(table === null ? ['recommended', 'none'] : ['table', 'recommended']).toContain(v.choice)
}, 60000)
