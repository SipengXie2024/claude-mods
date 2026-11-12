// The routing rules file (plan section 4): validation, effort arithmetic, the review-second choice,
// substitute candidates and the Jev rule options.
import type { Io } from './io'
import { jevDeepYes } from './jevconfig'
import { nameLevel } from './model'
import { EFFORTS, type Effort } from './types'

// effort: the start; deepEffort: the start when Jev judges the brief deep; raiseOrder: the levels an
// acceptance failure or a re-delegation steps through, from the start (section 2.4 of the table).
// deepModel: the model for a brief judged deep; hardModel: the model once Jev's deep probability
// reaches thresholds.hardYes, the largest work of the rule (section 2.4).
export interface Rule { id: string; section: string; condition: string; role: string; model: string | null; deepModel: string | null; hardModel: string | null; effort: Effort | null; deepEffort: Effort | null; raiseOrder: Effort[] | null; acceptance: string; evidence: string; use: 'subagent' | 'plugin' | 'main'; jevOption: boolean }
export interface ArchitectCandidate { model: string; name: string; when: string; evidence: string; limits: string }
export interface Substitute { id: string; forRules: string[] | '*'; options: { model: string; efforts: Effort[] | 'rule' | null }[]; auto: boolean; note?: string }
// A setting whose results on the person's own tasks are not measured yet (plan section 9.14): the
// rule's work on its base model, or its work Jev judged deep. The daily rating invitation picks
// tasks with such settings first.
export interface RatingCell { rule: string; when: 'base-model' | 'deep' }
// Work on the border of two rules (section 4 of the table): Jev's first rule is below ruleConfidence
// and its two most likely options are rules whose models differ. The model is drawn uniformly from
// `candidates`, each at its own effort, so the person's ratings can compare them on such work.
export interface Ambiguous { condition: string; candidates: { model: string; effort: Effort }[]; evidence: string }
// The model of a daily task's acceptance check (src/quota.ts): the subscription with the largest share
// of its weekly window left, then that subscription's model for the `review` rule. `provider` is the
// model ID's prefix, which is also the `provider` of Magpie's quota entry; `week` names the weekly
// window that is compared, `limits` the other windows of the subscription that stop this model when
// used up. Listed in order of preference, which decides a tie.
export interface AcceptanceSubscription { provider: string; model: string; week: string; limits: string[] }
export interface Rules { version: string; thresholds: { ruleConfidence: number; deepYes: number; hardYes: number; architectConfidence: number }; models: Record<string, { name: string }>; rules: Rule[]; architect: { default: string; candidates: ArchitectCandidate[] }; reviewSecond: { effort: Effort; whenOriginalIncludes: Record<string, string>; otherwise: string; order: string[] }; acceptance: { subscriptions: AcceptanceSubscription[]; evidence: string }; substitutes: Substitute[]; ambiguous: Ambiguous; ratingPriority: { note: string; cells: RatingCell[] } }

// The 19 rules of model-routing-table.md section 2; the file must hold each exactly once.
export const RULE_IDS: readonly string[] = [
  'architect', 'route-assessment', 'daily-default', 'review-second',
  'code-change', 'review', 'code-read', 'design-advice', 'web-research', 'machine-ops', 'batch-judge',
  'explain-write', 'document-analysis', 'visual-build', 'translation',
  'math', 'science-compute', 'lean', 'computer-use',
]
// review-second's model is computed (reviewSecondTarget); the architect's effort is judged by JEV.
const NO_MODEL = new Set(['review-second'])
const NO_EFFORT = new Set(['architect'])
const JEV_OPTIONS = 15

export const NONE_CHOICE = { value: 'none', description: '没有一条规则符合：任务条件与上面每一条都不一致' }

const USES = ['subagent', 'plugin', 'main'] as const

function fail(where: string, what: string): never {
  throw new Error(`routing rules: ${where}: ${what}`)
}
// A model whose ID names its level runs at that level: an effort the file pairs with it is that level.
function atNameLevel(model: string, efforts: Effort[], where: string): void {
  const level = nameLevel(model)
  const other = efforts.filter(e => e !== level)
  if (level !== null && other.length > 0) fail(where, `${model} runs at ${level}, the level its ID names, not ${other.join(', ')}`)
}
function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(where, 'not an object')
  return v as Record<string, unknown>
}
function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(where, 'not a non-empty string')
  return v
}
function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) fail(where, 'not an array')
  return v
}
function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') fail(where, 'not a boolean')
  return v
}
function effort(v: unknown, where: string): Effort {
  if (!EFFORTS.includes(v as Effort)) fail(where, `"${String(v)}" is not one of ${EFFORTS.join(', ')}`)
  return v as Effort
}
function unit(v: unknown, where: string): number {
  if (typeof v !== 'number' || !(v >= 0 && v <= 1)) fail(where, 'not a number in [0, 1]')
  return v
}

// `jev.deepYes` is JEV's deep threshold (src/jevconfig.ts): the rules file holds no copy of it.
export function parseRules(json: unknown, jev: { deepYes: number }): Rules {
  const root = obj(json, 'file')
  const version = str(root['version'], 'version')
  const t = obj(root['thresholds'], 'thresholds')
  const thresholds = {
    ruleConfidence: unit(t['ruleConfidence'], 'thresholds.ruleConfidence'),
    deepYes: unit(jev.deepYes, 'JEV_OPUS_DEEP_YES'),
    hardYes: unit(t['hardYes'], 'thresholds.hardYes'),
    architectConfidence: unit(t['architectConfidence'], 'thresholds.architectConfidence'),
  }

  const models: Record<string, { name: string }> = {}
  for (const [id, m] of Object.entries(obj(root['models'], 'models'))) {
    if (/\[1m\]$/i.test(id)) fail(`models.${id}`, 'IDs are canonical, without [1m]')
    models[id] = { name: str(obj(m, `models.${id}`)['name'], `models.${id}.name`) }
  }
  const model = (v: unknown, where: string): string => {
    const id = str(v, where)
    if (!(id in models)) fail(where, `model "${id}" is not listed in models`)
    return id
  }

  const rules: Rule[] = arr(root['rules'], 'rules').map((raw, i) => {
    const r = obj(raw, `rules[${i}]`)
    const id = str(r['id'], `rules[${i}].id`)
    const at = `rule ${id}`
    const use = r['use']
    if (!USES.includes(use as Rule['use'])) fail(`${at}.use`, `"${String(use)}" is not one of ${USES.join(', ')}`)
    if (NO_MODEL.has(id) && r['model'] !== null) fail(`${at}.model`, 'must be null: the model is computed per review')
    if (NO_EFFORT.has(id) && r['effort'] !== null) fail(`${at}.effort`, 'must be null: JEV judges this effort')
    const m = NO_MODEL.has(id) ? null : model(r['model'], `${at}.model`)
    // deepModel: the model when Jev judges the brief deep, where the evidence names another one.
    const dm = r['deepModel'] === undefined ? null : model(r['deepModel'], `${at}.deepModel`)
    if (dm !== null && m === null) fail(`${at}.deepModel`, 'needs a model')
    const hm = r['hardModel'] === undefined ? null : model(r['hardModel'], `${at}.hardModel`)
    if (hm !== null && m === null) fail(`${at}.hardModel`, 'needs a model')
    if (hm !== null && hm === m) fail(`${at}.hardModel`, 'is the rule\'s own model')
    const e = NO_EFFORT.has(id) ? null : effort(r['effort'], `${at}.effort`)
    if (NO_EFFORT.has(id) && (r['deepEffort'] !== null || r['raiseOrder'] !== null)) fail(`${at}`, 'deepEffort and raiseOrder must be null: JEV judges this effort')
    const deepE = e === null ? null : effort(r['deepEffort'], `${at}.deepEffort`)
    const order = e === null ? null : arr(r['raiseOrder'], `${at}.raiseOrder`).map((v, j) => effort(v, `${at}.raiseOrder[${j}]`))
    if (order !== null) {
      if (order[0] !== e) fail(`${at}.raiseOrder`, `must start at the start effort ${e}`)
      if (order.some((v, j) => j > 0 && EFFORTS.indexOf(v) <= EFFORTS.indexOf(order[j - 1]!))) fail(`${at}.raiseOrder`, 'levels must rise strictly')
      if (!order.includes(deepE!)) fail(`${at}.deepEffort`, `${deepE} is not in raiseOrder`)
    }
    if (m !== null && e !== null) atNameLevel(m, [e, deepE!, ...order!], `${at}`)
    for (const other of [dm, hm]) if (other !== null) atNameLevel(other, [deepE!], `${at}.deepEffort`)
    const jevOption = bool(r['jevOption'], `${at}.jevOption`)
    if (jevOption && use !== 'subagent') fail(`${at}.jevOption`, 'only subagent rules are Jev options')
    return {
      id, section: str(r['section'], `${at}.section`), condition: str(r['condition'], `${at}.condition`), role: str(r['role'], `${at}.role`),
      model: m, deepModel: dm, hardModel: hm, effort: e, deepEffort: deepE, raiseOrder: order, acceptance: str(r['acceptance'], `${at}.acceptance`), evidence: str(r['evidence'], `${at}.evidence`),
      use: use as Rule['use'], jevOption,
    }
  })
  const ids = rules.map(r => r.id)
  for (const id of ids) {
    if (!RULE_IDS.includes(id)) fail('rules', `unknown rule "${id}"`)
    if (ids.indexOf(id) !== ids.lastIndexOf(id)) fail('rules', `rule "${id}" appears more than once`)
  }
  const missing = RULE_IDS.filter(id => !ids.includes(id))
  if (missing.length > 0) fail('rules', `missing ${missing.join(', ')}`)
  const options = rules.filter(r => r.jevOption).length
  if (options !== JEV_OPTIONS) fail('rules', `${options} rules are Jev options, ${JEV_OPTIONS} expected`)

  const a = obj(root['architect'], 'architect')
  const candidates: ArchitectCandidate[] = arr(a['candidates'], 'architect.candidates').map((raw, i) => {
    const c = obj(raw, `architect.candidates[${i}]`)
    const at = `architect.candidates[${i}]`
    return { model: model(c['model'], `${at}.model`), name: str(c['name'], `${at}.name`), when: str(c['when'], `${at}.when`), evidence: str(c['evidence'], `${at}.evidence`), limits: str(c['limits'], `${at}.limits`) }
  })
  if (candidates.length === 0) fail('architect.candidates', 'empty')
  const architect = { default: model(a['default'], 'architect.default'), candidates }
  if (!candidates.some(c => c.model === architect.default)) fail('architect.default', 'not among the candidates')

  const rs = obj(root['reviewSecond'], 'reviewSecond')
  const whenOriginalIncludes: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj(rs['whenOriginalIncludes'], 'reviewSecond.whenOriginalIncludes'))) {
    whenOriginalIncludes[model(k, 'reviewSecond.whenOriginalIncludes key')] = model(v, `reviewSecond.whenOriginalIncludes.${k}`)
  }
  const reviewSecond = {
    effort: effort(rs['effort'], 'reviewSecond.effort'),
    whenOriginalIncludes,
    otherwise: model(rs['otherwise'], 'reviewSecond.otherwise'),
    order: arr(rs['order'], 'reviewSecond.order').map((m, i) => model(m, `reviewSecond.order[${i}]`)),
  }
  for (const m of [reviewSecond.otherwise, ...Object.values(whenOriginalIncludes), ...reviewSecond.order]) atNameLevel(m, [reviewSecond.effort], 'reviewSecond.effort')

  const ac = obj(root['acceptance'], 'acceptance')
  const subscriptions: AcceptanceSubscription[] = arr(ac['subscriptions'], 'acceptance.subscriptions').map((raw, i) => {
    const s = obj(raw, `acceptance.subscriptions[${i}]`)
    const at = `acceptance.subscriptions[${i}]`
    const m = model(s['model'], `${at}.model`)
    const slash = m.indexOf('/')
    if (slash <= 0) fail(`${at}.model`, `"${m}" has no provider prefix`)
    const week = str(s['week'], `${at}.week`)
    const limits = arr(s['limits'], `${at}.limits`).map((w, j) => str(w, `${at}.limits[${j}]`))
    if (limits.includes(week)) fail(`${at}.limits`, `"${week}" is the weekly window itself`)
    return { provider: m.slice(0, slash), model: m, week, limits }
  })
  if (subscriptions.length === 0) fail('acceptance.subscriptions', 'empty')
  const providers = subscriptions.map(s => s.provider)
  if (new Set(providers).size !== providers.length) fail('acceptance.subscriptions', 'one model per subscription: a provider appears twice')
  const acceptance = { subscriptions, evidence: str(ac['evidence'], 'acceptance.evidence') }

  const substitutes: Substitute[] = arr(root['substitutes'], 'substitutes').map((raw, i) => {
    const s = obj(raw, `substitutes[${i}]`)
    const id = str(s['id'], `substitutes[${i}].id`)
    const at = `substitute ${id}`
    const fr = s['forRules']
    const forRules = fr === '*' ? '*' : arr(fr, `${at}.forRules`).map((r, j) => {
      const rid = str(r, `${at}.forRules[${j}]`)
      if (!ids.includes(rid)) fail(`${at}.forRules`, `unknown rule "${rid}"`)
      return rid
    })
    const opts = arr(s['options'], `${at}.options`).map((raw2, j) => {
      const o = obj(raw2, `${at}.options[${j}]`)
      const m = model(o['model'], `${at}.options[${j}].model`)
      const ef = o['efforts']
      let efforts: Effort[] | 'rule' | null
      if (ef === null) efforts = null
      else if (ef === 'rule') {
        if (forRules === '*' || ruleEfforts(rules, forRules, m).length === 0) fail(`${at}.options[${j}]`, `"rule" needs a rule in forRules whose model is ${m}`)
        efforts = 'rule'
      } else {
        efforts = arr(ef, `${at}.options[${j}].efforts`).map((x, k) => effort(x, `${at}.options[${j}].efforts[${k}]`))
        if (efforts.length === 0) fail(`${at}.options[${j}].efforts`, 'empty')
        atNameLevel(m, efforts, `${at}.options[${j}].efforts`)
      }
      return { model: m, efforts }
    })
    if (opts.length === 0) fail(`${at}.options`, 'empty')
    const note = s['note'] === undefined ? undefined : str(s['note'], `${at}.note`)
    return { id, forRules, options: opts, auto: bool(s['auto'], `${at}.auto`), ...(note === undefined ? {} : { note }) }
  })
  const subIds = substitutes.map(s => s.id)
  if (new Set(subIds).size !== subIds.length) fail('substitutes', 'duplicate id')

  const am = obj(root['ambiguous'], 'ambiguous')
  const drawn = arr(am['candidates'], 'ambiguous.candidates').map((raw, i) => {
    const c = obj(raw, `ambiguous.candidates[${i}]`)
    const pick = { model: model(c['model'], `ambiguous.candidates[${i}].model`), effort: effort(c['effort'], `ambiguous.candidates[${i}].effort`) }
    atNameLevel(pick.model, [pick.effort], `ambiguous.candidates[${i}].effort`)
    return pick
  })
  if (drawn.length < 2) fail('ambiguous.candidates', 'needs at least two models to draw from')
  if (new Set(drawn.map(c => c.model)).size !== drawn.length) fail('ambiguous.candidates', 'duplicate model')
  const ambiguous: Ambiguous = { condition: str(am['condition'], 'ambiguous.condition'), candidates: drawn, evidence: str(am['evidence'], 'ambiguous.evidence') }

  const rp = obj(root['ratingPriority'], 'ratingPriority')
  const cells: RatingCell[] = arr(rp['cells'], 'ratingPriority.cells').map((raw, i) => {
    const c = obj(raw, `ratingPriority.cells[${i}]`)
    const at = `ratingPriority.cells[${i}]`
    const rule = rules.find(r => r.id === str(c['rule'], `${at}.rule`))
    if (rule === undefined || rule.use !== 'subagent') fail(`${at}.rule`, `"${String(c['rule'])}" is not a subagent rule`)
    const when = c['when']
    if (when !== 'base-model' && when !== 'deep') fail(`${at}.when`, `"${String(when)}" is not base-model or deep`)
    if (when === 'base-model' && rule.hardModel === null && rule.deepModel === null) fail(`${at}.when`, `rule ${rule.id} has one model only`)
    return { rule: rule.id, when }
  })
  const ratingPriority = { note: str(rp['note'], 'ratingPriority.note'), cells }

  return { version, thresholds, models, rules, architect, reviewSecond, acceptance, substitutes, ambiguous, ratingPriority }
}

export async function loadRules(io: Io, pluginRoot: string): Promise<Rules> {
  const path = `${pluginRoot.replace(/\/+$/, '')}/rules/routing-rules.json`
  const text = await io.read(path)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`routing rules: ${path} is not JSON: ${(error as Error).message}`)
  }
  return parseRules(json, { deepYes: await jevDeepYes(io) })
}

export function ruleById(rules: Rules, id: string): Rule {
  const rule = rules.rules.find(r => r.id === id)
  if (rule === undefined) throw new Error(`routing rules: no rule "${id}"`)
  return rule
}

// The options of Jev's rule question: the Jev-option rules in file order, then none.
export function jevChoices(rules: Rules): { value: string; description: string }[] {
  return [...rules.rules.filter(r => r.jevOption).map(r => ({ value: r.id, description: r.condition })), { ...NONE_CHOICE }]
}

export function raise(e: Effort, steps = 1): Effort {
  if (!Number.isInteger(steps) || steps < 0) throw new Error(`raise: steps must be a non-negative integer, got ${steps}`)
  return EFFORTS[Math.min(EFFORTS.indexOf(e) + steps, EFFORTS.length - 1)]!
}

// Whether Jev's deep probability puts the work among the largest (thresholds.hardYes). A substitute
// judgment has no probability, so its work stays on the rule's base model.
export function isHardWork(deepP: number | null, rules: Rules): boolean {
  return deepP !== null && deepP >= rules.thresholds.hardYes
}

// The two rules a judgment hangs between when its work is on their border (Rules.ambiguous): Jev's
// first choice below ruleConfidence, and its two most likely options both rules whose models for this
// brief differ. Null otherwise, and for a substitute judgment, which has no second option.
export function borderPair(j: { ruleChoice: string; confidence: number; probabilities: Record<string, number>; deep: boolean; deepP: number | null; provider: string }, rules: Rules): { first: { ruleId: string; p: number }; second: { ruleId: string; p: number } } | null {
  if (j.provider !== 'jev' || j.confidence >= rules.thresholds.ruleConfidence) return null
  const ranked = Object.entries(j.probabilities).sort((a, b) => b[1] - a[1])
  if (ranked.length < 2) return null
  const [[a, pa], [b, pb]] = ranked as [[string, number], [string, number]]
  if (a === 'none' || b === 'none') return null
  const flags = { deep: j.deep, hard: isHardWork(j.deepP, rules) }
  if (ruleModel(ruleById(rules, a), flags) === ruleModel(ruleById(rules, b), flags)) return null
  return { first: { ruleId: a, p: pa }, second: { ruleId: b, p: pb } }
}

// The rule's model for a brief: hardModel for the largest work, deepModel for a brief judged deep,
// else the rule's model.
export function ruleModel(rule: Rule, j: { deep: boolean; hard: boolean }): string {
  if (rule.model === null) throw new Error(`routing rules: rule ${rule.id} has no model`)
  if (j.hard && rule.hardModel !== null) return rule.hardModel
  return j.deep && rule.deepModel !== null ? rule.deepModel : rule.model
}

// The models the rule itself names, its own model first.
export function ownModels(rule: Rule): string[] {
  return [rule.model, rule.hardModel, rule.deepModel].filter((m): m is string => m !== null)
}

export function startEffort(rule: Rule, deep: boolean): Effort {
  if (rule.effort === null || rule.deepEffort === null) throw new Error(`routing rules: rule ${rule.id} has no start effort`)
  return deep ? rule.deepEffort : rule.effort
}

// The next level of the rule's raiseOrder above `current`; `current` itself at the top. Levels the
// order skips are ones the evidence shows no better than the level below (Mythos 5.2 science: xhigh).
export function raiseOnRule(rule: Rule, current: Effort): Effort {
  if (rule.raiseOrder === null) throw new Error(`routing rules: rule ${rule.id} has no raise order`)
  return rule.raiseOrder.find(e => EFFORTS.indexOf(e) > EFFORTS.indexOf(current)) ?? current
}

// Section 4.5: prefer Opus when Sol 6.1 is among the reviewed models, Sol 6.1 otherwise; then the rest
// of `order`; drop every candidate equal to a reviewed model and every one Magpie does not list.
export function reviewSecondTarget(rules: Rules, originals: string[], available: (id: string) => boolean, same: (a: string, b: string) => boolean): { model: string; effort: Effort } | { none: string } {
  const rs = rules.reviewSecond
  const hit = Object.keys(rs.whenOriginalIncludes).find(k => originals.some(o => same(o, k)))
  const preferred = hit === undefined ? rs.otherwise : rs.whenOriginalIncludes[hit]!
  const candidates = [preferred, ...rs.order.filter(m => m !== preferred)]
  const distinct = candidates.filter(c => !originals.some(o => same(o, c)))
  const usable = distinct.filter(c => available(c))
  if (usable.length > 0) return { model: usable[0]!, effort: rs.effort }
  const gone = distinct.length === 0 ? '' : `; not in Magpie's model list: ${distinct.join(', ')}`
  return { none: `no model is left for an independent second review: candidates ${candidates.join(', ')}; excluded as reviewed models: ${originals.join(', ')}${gone}` }
}

// Efforts of the forRules rules whose model is `model`: what a "rule" option allows (section 4.4:
// Astra takes science-compute's efforts, Sol 6.1 math's).
function ruleEfforts(rules: Rule[], forRules: string[], model: string): Effort[] {
  const out = new Set<Effort>()
  for (const r of rules) if (forRules.includes(r.id) && r.model === model && r.effort !== null) out.add(r.effort)
  return EFFORTS.filter(e => out.has(e))
}

function allowedEfforts(rules: Rules, sub: Substitute, option: Substitute['options'][number]): Effort[] | null {
  if (option.efforts === 'rule') return ruleEfforts(rules.rules, sub.forRules as string[], option.model)
  return option.efforts
}

function covers(sub: Substitute, ruleId: string): boolean {
  return sub.forRules === '*' || sub.forRules.includes(ruleId)
}

// The automatic substitute that allows `model` at `effort` for a task under `ruleId`, or null. A model
// the rule itself names is allowed at the levels of its raise order, as `rule:<id>`.
export function substituteAllowed(rules: Rules, ruleId: string, model: string, asked: Effort, same: (a: string, b: string) => boolean): Substitute | null {
  // A model whose ID names its level runs at that level, whatever effort was asked for.
  const effort = nameLevel(model) ?? asked
  const rule = ruleById(rules, ruleId)
  if (rule.raiseOrder !== null && rule.raiseOrder.includes(effort) && ownModels(rule).some(m => same(m, model))) {
    return { id: `rule:${rule.id}`, forRules: [rule.id], options: [{ model, efforts: rule.raiseOrder }], auto: true }
  }
  for (const sub of rules.substitutes) {
    if (!sub.auto || !covers(sub, ruleId)) continue
    for (const option of sub.options) {
      if (!same(option.model, model)) continue
      const allowed = allowedEfforts(rules, sub, option)
      if (allowed === null || allowed.includes(effort)) return sub
    }
  }
  return null
}

// Section 4.4: the effort of an automatic takeover after a model failure. Listed efforts give the
// lowest one not below `current`, else the highest; a substitute without efforts cannot take over.
export function substituteEffort(rules: Rules, sub: Substitute, model: string, ruleId: string, current: Effort): Effort | null {
  if (!covers(sub, ruleId)) throw new Error(`routing rules: substitute ${sub.id} does not cover rule ${ruleId}`)
  const option = sub.options.find(o => o.model === model)
  if (option === undefined) throw new Error(`routing rules: substitute ${sub.id} has no option for ${model}`)
  const allowed = allowedEfforts(rules, sub, option)
  if (allowed === null) return null
  const sorted = EFFORTS.filter(e => allowed.includes(e))
  return sorted.find(e => EFFORTS.indexOf(e) >= EFFORTS.indexOf(current)) ?? sorted[sorted.length - 1]!
}
