// The routing rules file against the routing table it comes from (plan section 12.1, rules row):
// the file is loaded through loadRules and compared with .planning/model-routing-table.md as it is
// on disk; model equality comes from the catalog of Magpie's real launch settings.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { catalogFrom, isAvailable, sameModel } from '../src/model'
import { isHardWork, jevChoices, loadRules, parseRules, raise, raiseOnRule, reviewSecondTarget, ruleById, ruleModel, startEffort, substituteAllowed, substituteEffort, RULE_IDS } from '../src/rules'
import { nodeIo } from './node-io'

const PLUGIN_ROOT = join(import.meta.dir, '..')
const TABLE = readFileSync(join(PLUGIN_ROOT, '../../.planning/model-routing-table.md'), 'utf8')
const RULES_JSON = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'rules/routing-rules.json'), 'utf8')) as Record<string, unknown>
const rules = await loadRules(nodeIo(), PLUGIN_ROOT)

const settings = JSON.parse(readFileSync(join(homedir(), '.config/magpie/claude-launch/settings.json'), 'utf8')) as { modelPicker: unknown; env: Record<string, unknown> }
const env: Record<string, unknown> = {}
for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_MODEL_CAPABILITIES']) env[k] = settings.env[k]
const cat = catalogFrom({ modelPicker: settings.modelPicker, env })
const same = (a: string, b: string) => sameModel(a, b, cat)
const available = (id: string) => isAvailable(id, cat)

const OPUS = 'claude/claude-opus-5-5'
const MYTHOS = 'claude/claude-mythos-5-2'
const ARGON = 'antigravity/gemini-4-argon'
const SOL = 'codex/gpt-6.1-sol'
const ASTRA = 'codex/gpt-6-astra'

// Section 2 of the routing table: each `| \`id\` | condition | role | model / effort | acceptance | evidence |` row.
function tableRows(): Map<string, { section: string; cells: string[] }> {
  const body = TABLE.split('\n## 2. ')[1]!.split('\n## 3. ')[0]!
  const rows = new Map<string, { section: string; cells: string[] }>()
  let section = ''
  for (const line of body.split('\n')) {
    const h = /^### (2\.\d) /.exec(line)
    if (h) { section = h[1]!; continue }
    if (!line.startsWith('| `')) continue
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    const id = cells[0]!.replace(/`/g, '')
    expect(rows.has(id)).toBe(false)
    rows.set(id, { section, cells })
  }
  return rows
}

// Section 8 of the routing table: name → Magpie model ID.
function tableModelIds(): Record<string, string> {
  const body = TABLE.split('\n## 8. ')[1]!
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/^\| ([^|`]+?) \| `([^`]+)` \|$/gm)) out[m[1]!] = m[2]!
  return out
}

test('the file holds the 19 rules, each once', () => {
  expect(rules.rules.map(r => r.id).sort()).toEqual([...RULE_IDS].sort())
  expect(rules.rules).toHaveLength(19)
  expect(rules.version).toBe('routing-rules.v7')
})

test('condition, acceptance and evidence are the routing table columns word for word, in the same section', () => {
  const rows = tableRows()
  expect([...rows.keys()].sort()).toEqual([...RULE_IDS].sort())
  for (const rule of rules.rules) {
    const row = rows.get(rule.id)!
    expect({ id: rule.id, section: rule.section, condition: rule.condition, acceptance: rule.acceptance, evidence: rule.evidence })
      .toEqual({ id: rule.id, section: row.section, condition: row.cells[1]!, acceptance: row.cells[4]!, evidence: row.cells[5]! })
  }
})

test('models, efforts and review-second match the table\'s recommendation column and its model ID table', () => {
  const ids = tableModelIds()
  expect(Object.fromEntries(Object.entries(rules.models).map(([id, m]) => [m.name, id]))).toEqual(ids)
  for (const [id, row] of tableRows()) {
    const rule = ruleById(rules, id)
    const rec = row.cells[3]!
    const plain = /^\*\*(.+?) \/ (\w+)\*\*(?:；需要深入推理时 \*\*(.+?) \/ (\w+)\*\*)?(?:；深入推理概率达到 ([\d.]+) 时 \*\*(.+?) \/ (\w+)\*\*)?$/.exec(rec)
    if (plain) {
      expect([id, rule.model, rule.effort]).toEqual([id, ids[plain[1]!]!, plain[2]!])
      // A rule that changes model for deep work names that model and its deep effort.
      expect([id, rule.deepModel, plain[3] === undefined ? null : rule.deepEffort]).toEqual([id, plain[3] === undefined ? null : ids[plain[3]]!, plain[4] ?? null])
      // A rule that changes model for its largest work names the threshold, that model and its deep effort.
      expect([id, rule.hardModel, plain[6] === undefined ? null : rule.deepEffort, plain[5] === undefined ? null : rules.thresholds.hardYes])
        .toEqual([id, plain[6] === undefined ? null : ids[plain[6]]!, plain[7] ?? null, plain[5] === undefined ? null : Number(plain[5])])
    } else if (id === 'architect') {
      expect(rec.startsWith('**Opus 5.5**，用户确认')).toBe(true)
      expect([rule.model, rule.effort, rules.architect.default]).toEqual([ids['Opus 5.5']!, null, ids['Opus 5.5']!])
    } else {
      expect(id).toBe('review-second')
      const m = /^原模型为 \*\*(.+?)\*\* 时推荐 \*\*(.+?) \/ (\w+)\*\*；其他情况推荐 \*\*(.+?) \/ (\w+)\*\*$/.exec(rec)!
      expect(rules.reviewSecond.whenOriginalIncludes).toEqual({ [ids[m[1]!]!]: ids[m[2]!]! })
      expect(rules.reviewSecond.otherwise).toBe(ids[m[4]!]!)
      expect(m[5]).toBe(m[3]!)
      expect(rules.reviewSecond.effort).toBe(m[3]! as typeof rules.reviewSecond.effort)
      expect(rule.model).toBeNull()
      expect(rule.effort).toBe(m[3]! as typeof rules.reviewSecond.effort)
    }
  }
})

test('parseRules refuses a missing, duplicated or unknown rule, a bad effort and an unlisted model', () => {
  const variant = (edit: (j: { rules: Record<string, unknown>[] } & Record<string, unknown>) => void) => {
    const j = structuredClone(RULES_JSON) as { rules: Record<string, unknown>[] } & Record<string, unknown>
    edit(j)
    return () => parseRules(j, { deepYes: 0.85 })
  }
  expect(() => parseRules(structuredClone(RULES_JSON), { deepYes: 0.85 })).not.toThrow()
  expect(variant(j => { j.rules = j.rules.filter(r => r['id'] !== 'lean') })).toThrow('missing lean')
  expect(variant(j => { j.rules.push(structuredClone(j.rules[2]!)) })).toThrow('appears more than once')
  expect(variant(j => { j.rules[2]!['id'] = 'code-chang' })).toThrow('unknown rule "code-chang"')
  expect(variant(j => { j.rules.find(r => r['id'] === 'code-read')!['effort'] = 'ultra' })).toThrow('rule code-read.effort')
  expect(variant(j => { j.rules.find(r => r['id'] === 'code-read')!['effort'] = null })).toThrow('rule code-read.effort')
  expect(variant(j => { j.rules.find(r => r['id'] === 'computer-use')!['deepModel'] = 'codex/gpt-6.1-sol[1m]' })).toThrow('rule computer-use.deepModel')
  expect(variant(j => { j.rules.find(r => r['id'] === 'review')!['model'] = 'claude/claude-opus-5-5[1m]' })).toThrow('is not listed in models')
  expect(variant(j => { j.rules.find(r => r['id'] === 'review-second')!['model'] = OPUS })).toThrow('rule review-second.model')
  expect(variant(j => { j.rules.find(r => r['id'] === 'architect')!['effort'] = 'high' })).toThrow('rule architect.effort')
  expect(variant(j => { j.rules.find(r => r['id'] === 'math')!['jevOption'] = false })).toThrow('14 rules are Jev options, 15 expected')
  expect(variant(j => { (j['reviewSecond'] as Record<string, unknown>)['effort'] = 'medium-high' })).toThrow('reviewSecond.effort')
  expect(variant(j => { delete (j['thresholds'] as Record<string, unknown>)['hardYes'] })).toThrow('thresholds.hardYes')
  expect(variant(j => { j.rules.find(r => r['id'] === 'code-change')!['hardModel'] = 'claude/claude-mythos-5-2[1m]' })).toThrow('rule code-change.hardModel')
  expect(variant(j => { j.rules.find(r => r['id'] === 'code-change')!['hardModel'] = OPUS })).toThrow('rule code-change.hardModel')
  const cells = (j: Record<string, unknown>) => (j['ratingPriority'] as { cells: Record<string, unknown>[] }).cells
  expect(variant(j => { cells(j)[0]!['rule'] = 'architect' })).toThrow('ratingPriority.cells[0].rule')
  expect(variant(j => { cells(j)[0]!['when'] = 'always' })).toThrow('ratingPriority.cells[0].when')
  expect(variant(j => { cells(j)[0]!['rule'] = 'review' })).toThrow('rule review has one model only')
  const drawn = (j: Record<string, unknown>) => (j['ambiguous'] as { candidates: Record<string, unknown>[] }).candidates
  expect(variant(j => { drawn(j)[0]!['model'] = 'claude/claude-mythos-5-2[1m]' })).toThrow('ambiguous.candidates[0].model')
  expect(variant(j => { drawn(j)[1]!['effort'] = 'ultra' })).toThrow('ambiguous.candidates[1].effort')
  expect(variant(j => { drawn(j).splice(1) })).toThrow('needs at least two models to draw from')
  expect(variant(j => { drawn(j)[2]!['model'] = drawn(j)[0]!['model'] })).toThrow('ambiguous.candidates: duplicate model')
  expect(variant(j => { delete j['ambiguous'] })).toThrow('ambiguous')
  const subs = (j: Record<string, unknown>) => (j['acceptance'] as { subscriptions: Record<string, unknown>[] }).subscriptions
  expect(variant(j => { subs(j)[1]!['model'] = 'claude/claude-sonnet-5-5' })).toThrow('one model per subscription')
  expect(variant(j => { subs(j)[0]!['model'] = 'claude/claude-opus-5-5[1m]' })).toThrow('acceptance.subscriptions[0].model')
  expect(variant(j => { subs(j)[0]!['limits'] = ['7 days'] })).toThrow('acceptance.subscriptions[0].limits')
  expect(variant(j => { subs(j).splice(0) })).toThrow('acceptance.subscriptions: empty')
  expect(variant(j => { delete j['acceptance'] })).toThrow('acceptance')
  expect(() => parseRules('not an object', { deepYes: 0.85 })).toThrow('routing rules: file')
})

test('acceptance: Opus 5.5 on the Claude subscription, Sol 6.1 on Codex, both in Magpie\'s model list', () => {
  expect(rules.acceptance.subscriptions).toEqual([
    { provider: 'claude', model: OPUS, week: '7 days', limits: ['5 hours'] },
    { provider: 'codex', model: SOL, week: '7 days', limits: ['5 hours'] },
  ])
  for (const s of rules.acceptance.subscriptions) expect([s.model, available(s.model)]).toEqual([s.model, true])
  // Each is a model the review rule allows: its own model, or review-alt's Sol 6.1 at medium.
  for (const s of rules.acceptance.subscriptions) expect(substituteAllowed(rules, 'review', s.model, 'medium', same)).not.toBeNull()
})

test('jevChoices: the 15 Jev-option rules in file order, then none', () => {
  const choices = jevChoices(rules)
  expect(choices).toHaveLength(16)
  expect(choices.map(c => c.value)).toEqual([...rules.rules.filter(r => r.jevOption).map(r => r.id), 'none'])
  expect(choices.map(c => c.value)).not.toContain('review-second')
  expect(choices.map(c => c.value)).not.toContain('architect')
  expect(choices.map(c => c.value)).not.toContain('route-assessment')
  expect(choices[0]).toEqual({ value: 'code-change', description: ruleById(rules, 'code-change').condition })
  expect(choices.at(-1)).toEqual({ value: 'none', description: '没有一条规则符合：任务条件与上面每一条都不一致' })
})

test('ruleById throws for an unknown rule', () => {
  expect(ruleById(rules, 'lean').model).toBe(OPUS)
  expect(() => ruleById(rules, 'none')).toThrow('no rule "none"')
})

test('raise stops at max; startEffort and raiseOnRule follow each rule\'s deep effort and raise order', () => {
  expect(raise('medium')).toBe('high')
  expect(raise('xhigh')).toBe('max')
  expect(raise('max')).toBe('max')
  expect(raise('high', 3)).toBe('max')
  expect(raise('low', 0)).toBe('low')
  expect(() => raise('low', -1)).toThrow()
  expect(startEffort(ruleById(rules, 'code-change'), false)).toBe('high')
  // Opus 5.5 and Mythos 5.2 start at high when deep too (table section 2.4).
  expect(startEffort(ruleById(rules, 'code-change'), true)).toBe('high')
  expect(startEffort(ruleById(rules, 'science-compute'), true)).toBe('high')
  expect(startEffort(ruleById(rules, 'design-advice'), true)).toBe('high')
  expect(startEffort(ruleById(rules, 'document-analysis'), true)).toBe('high')
  expect(startEffort(ruleById(rules, 'computer-use'), true)).toBe('high')
  expect(startEffort(ruleById(rules, 'machine-ops'), false)).toBe('max')
  // computer-use changes model for deep work: Terra 6.1 for bounded steps, Sol 6.1 when the goal needs understanding.
  expect(ruleModel(ruleById(rules, 'computer-use'), { deep: false, hard: false })).toBe('codex/gpt-6.1-terra')
  expect(ruleModel(ruleById(rules, 'computer-use'), { deep: true, hard: true })).toBe(SOL)
  // code-change changes model for its largest work only: Opus 5.5, Mythos 5.2 from hardYes.
  expect(ruleModel(ruleById(rules, 'code-change'), { deep: true, hard: false })).toBe(OPUS)
  expect(ruleModel(ruleById(rules, 'code-change'), { deep: true, hard: true })).toBe(MYTHOS)
  expect(isHardWork(0.95, rules)).toBe(true)
  expect(isHardWork(0.94, rules)).toBe(false)
  expect(isHardWork(null, rules)).toBe(false)
  expect(ruleModel(ruleById(rules, 'design-advice'), { deep: true, hard: true })).toBe(MYTHOS)
  expect(startEffort(ruleById(rules, 'review-second'), false)).toBe('medium')
  expect(() => startEffort(ruleById(rules, 'architect'), false)).toThrow('no start effort')
  expect(raiseOnRule(ruleById(rules, 'science-compute'), 'high')).toBe('max')
  expect(raiseOnRule(ruleById(rules, 'code-change'), 'high')).toBe('xhigh')
  expect(raiseOnRule(ruleById(rules, 'code-change'), 'medium')).toBe('high')
  expect(raiseOnRule(ruleById(rules, 'math'), 'max')).toBe('max')
})

// Section 2.4 of the routing table: `| rule | start | deep | a → b → c |` rows.
test('each rule\'s start, deep effort and raise order are the table\'s section 2.4 word for word', () => {
  const body = TABLE.split('\n### 2.4 ')[1]!.split('\n## 3. ')[0]!
  const rows = [...body.matchAll(/^\| ([a-z-]+) \| (\w+) \| (\w+) \| ([\w →]+) \|$/gm)].map(m => [m[1], m[2], m[3], m[4]!.split(' → ')])
  expect(rows as unknown).toEqual(rules.rules.filter(r => r.effort !== null).map(r => [r.id, r.effort, r.deepEffort, r.raiseOrder]))
  const variant = (edit: (r: Record<string, unknown>) => void) => {
    const j = structuredClone(RULES_JSON) as { rules: Record<string, unknown>[] }
    edit(j.rules.find(r => r['id'] === 'code-change')!)
    return () => parseRules(j, { deepYes: 0.85 })
  }
  expect(variant(r => { r['raiseOrder'] = ['xhigh', 'max'] })).toThrow('must start at the start effort high')
  expect(variant(r => { r['raiseOrder'] = ['high', 'max', 'xhigh'] })).toThrow('levels must rise strictly')
  expect(variant(r => { r['deepEffort'] = 'medium' })).toThrow('medium is not in raiseOrder')
})

test('the deep threshold is JEV\'s own, read from its .env; the largest-work threshold is the file\'s', () => {
  expect(rules.thresholds.deepYes).toBe(0.85)
  expect(rules.thresholds.hardYes).toBe(0.95)
  expect(() => parseRules(structuredClone(RULES_JSON), { deepYes: 1.5 })).toThrow('JEV_OPUS_DEEP_YES')
})

test('reviewSecondTarget: Sol reviewed → Opus, Opus reviewed → Sol, both reviewed → none', () => {
  expect(reviewSecondTarget(rules, [SOL], available, same)).toEqual({ model: OPUS, effort: 'medium' })
  expect(reviewSecondTarget(rules, [OPUS], available, same)).toEqual({ model: SOL, effort: 'medium' })
  expect(reviewSecondTarget(rules, [ASTRA], available, same)).toEqual({ model: SOL, effort: 'medium' })
  // Opus and Sol both reviewed: Argon, the third candidate.
  expect(reviewSecondTarget(rules, [SOL, 'claude/claude-opus-5-5[1m]'], available, same)).toEqual({ model: ARGON, effort: 'medium' })
  const none = reviewSecondTarget(rules, [SOL, 'claude/claude-opus-5-5[1m]', ARGON], available, same)
  expect('none' in none && none.none).toContain('excluded as reviewed models')
})

test('reviewSecondTarget treats the opus alias and the [1m] variant as Opus', () => {
  expect(reviewSecondTarget(rules, ['opus'], available, same)).toEqual({ model: SOL, effort: 'medium' })
  expect(reviewSecondTarget(rules, ['claude/claude-opus-5-5[1m]'], available, same)).toEqual({ model: SOL, effort: 'medium' })
  expect(reviewSecondTarget(rules, ['opus', 'codex/gpt-6.1-sol'], available, same)).toEqual({ model: ARGON, effort: 'medium' })
})

test('reviewSecondTarget skips a candidate missing from the Magpie model list', () => {
  const withoutSol = (id: string) => available(id) && !same(id, SOL)
  expect(reviewSecondTarget(rules, [ASTRA], withoutSol, same)).toEqual({ model: OPUS, effort: 'medium' })
  expect(reviewSecondTarget(rules, [OPUS], withoutSol, same)).toEqual({ model: ARGON, effort: 'medium' })
  const neither = (id: string) => withoutSol(id) && !same(id, ARGON)
  const r = reviewSecondTarget(rules, [OPUS], neither, same)
  expect('none' in r && r.none).toContain(`not in Magpie's model list: ${SOL}, ${ARGON}`)
})

test('substituteAllowed follows table 4.4', () => {
  const sub = (ruleId: string, model: string, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max') => substituteAllowed(rules, ruleId, model, effort, same)?.id ?? null
  // A model the rule names is automatic at the levels of its raise order: code-change's Opus 5.5 and
  // Mythos 5.2 stand in for each other.
  expect(sub('code-change', OPUS, 'high')).toBe('rule:code-change')
  expect(sub('code-change', OPUS, 'max')).toBe('rule:code-change')
  expect(sub('code-change', MYTHOS, 'xhigh')).toBe('rule:code-change')
  expect(sub('code-change', MYTHOS, 'medium')).toBeNull()
  expect(sub('code-read', OPUS, 'xhigh')).toBe('rule:code-read')
  // repo-alt: Astra at xhigh or max only.
  expect(sub('code-change', ASTRA, 'xhigh')).toBe('repo-alt')
  expect(sub('code-change', ASTRA, 'max')).toBe('repo-alt')
  expect(sub('code-change', ASTRA, 'high')).toBeNull()
  expect(sub('code-change', ASTRA, 'medium')).toBeNull()
  // math-extra: Sol 6 at any effort.
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) expect(sub('math', 'codex/gpt-6-sol', e)).toBe('math-extra')
  expect(sub('science-compute', 'codex/gpt-6-sol', 'high')).toBeNull()
  // science-math-alt: Sol 6.1 at the math rule's effort, Astra at high or max.
  expect(sub('science-compute', SOL, 'max')).toBe('science-math-alt')
  expect(sub('science-compute', SOL, 'high')).toBeNull()
  expect(sub('math', ASTRA, 'high')).toBe('science-math-alt')
  expect(sub('math', ASTRA, 'max')).toBe('science-math-alt')
  expect(sub('math', ASTRA, 'xhigh')).toBeNull()
  // review: its own Opus 5.5 (the alias counts) at its levels; review-alt's Sol 6.1 at medium.
  expect(sub('review', 'opus', 'medium')).toBe('rule:review')
  expect(sub('review', SOL, 'medium')).toBe('review-alt')
  expect(sub('review', SOL, 'high')).toBeNull()
  // auto: false candidates are never automatic.
  expect(sub('explain-write', MYTHOS, 'high')).toBeNull()
  expect(sub('code-read', MYTHOS, 'high')).toBeNull()
  // assessment-alt: Opus 5.5 at xhigh.
  expect(sub('route-assessment', OPUS, 'xhigh')).toBe('assessment-alt')
  expect(sub('explain-write', 'claude/claude-haiku-5-5', 'low')).toBeNull()
})

test('substituteEffort: the takeover effort of section 4.4', () => {
  const byId = (id: string) => rules.substitutes.find(s => s.id === id)!
  expect(substituteEffort(rules, byId('repo-alt'), ASTRA, 'code-change', 'xhigh')).toBe('xhigh')
  expect(substituteEffort(rules, byId('repo-alt'), ASTRA, 'code-change', 'max')).toBe('max')
  expect(substituteEffort(rules, byId('repo-alt'), ASTRA, 'code-change', 'high')).toBe('xhigh')
  expect(substituteEffort(rules, byId('math-extra'), 'codex/gpt-6-sol', 'math', 'max')).toBeNull()
  expect(substituteEffort(rules, byId('science-math-alt'), SOL, 'science-compute', 'high')).toBe('max')
  expect(substituteEffort(rules, byId('science-math-alt'), ASTRA, 'math', 'max')).toBe('max')
  expect(substituteEffort(rules, byId('review-alt'), SOL, 'review', 'medium')).toBe('medium')
  expect(substituteEffort(rules, byId('review-alt'), SOL, 'review', 'high')).toBe('medium')
  expect(() => substituteEffort(rules, byId('repo-alt'), ASTRA, 'review', 'medium')).toThrow('does not cover rule review')
})

test('architect candidates: Opus 5.5 (default), Mythos 5.2, Astra and Sol 6.1', () => {
  expect(rules.architect.candidates.map(c => [c.model, c.name])).toEqual([[OPUS, 'Opus 5.5'], [MYTHOS, 'Mythos 5.2'], [ASTRA, 'Astra'], [SOL, 'Sol 6.1']])
  expect(rules.architect.default).toBe(OPUS)
})
