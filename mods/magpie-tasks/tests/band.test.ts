// The band above the prompt for a routed subagent (plan section 9.7): what each request adds to the
// line, when it changes, and the text drawn. The rules are rules/routing-rules.json, carried as a module.
import { expect, test } from 'claude-code/testing'
import { agentBand, bandText, clearBands, noteBandDone, noteBandStep } from '../src/band'
import { parseRules } from '../src/rules'
import { routingRules } from './data/jev-rules'

const rules = parseRules(routingRules, { deepYes: 0.85 })
const OPUS = 'claude/claude-opus-5-5'
const line = (id: string) => bandText(agentBand(id)!, rules)
const step = (id: string, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined, o: { model?: string; ruleId?: string | null; engine?: boolean } = {}) =>
  noteBandStep(id, { model: o.model ?? OPUS, effort, ruleId: o.ruleId === undefined ? 'daily-default' : o.ruleId, engine: o.engine ?? false })

test('a routed agent\'s line names the model by the routing table, the effort sent and the rule; a repeat changes nothing', () => {
  clearBands()
  expect(agentBand('a1')).toBeUndefined()
  expect(step('a1', 'medium')).toBe(true)
  expect(line('a1')).toBe('Opus 5.5 · ◆ magpie-tasks · MEDIUM · daily-default')
  expect(step('a1', 'medium')).toBe(false)
  expect(step('a1', 'medium', { model: `${OPUS}[1m]` })).toBe(true)
  expect(line('a1')).toBe('Opus 5.5 · ◆ magpie-tasks · MEDIUM · daily-default')
})

test('a raise on resume extends the trail; the end of a run marks the line done until the next run', () => {
  clearBands()
  step('a2', 'high', { ruleId: 'code-change' })
  expect(noteBandDone('a2')).toBe(true)
  expect(noteBandDone('a2')).toBe(false)
  expect(line('a2')).toBe('Opus 5.5 · ◆ magpie-tasks · HIGH · code-change · done')
  expect(step('a2', 'xhigh', { ruleId: 'code-change' })).toBe(true)
  expect(line('a2')).toBe('Opus 5.5 · ◆ magpie-tasks · high → XHIGH · code-change')
  expect(noteBandDone('nobody')).toBe(false)
})

test('a request at the engine\'s effort says so; a model outside the rules is named by its ID; a new model starts a new trail', () => {
  clearBands()
  step('a3', 'medium')
  step('a3', 'high', { engine: true })
  expect(line('a3')).toBe('Opus 5.5 · ◆ magpie-tasks · medium → HIGH · engine effort · daily-default')
  step('a3', 'low', { model: 'codex/gpt-6-mini', ruleId: null })
  expect(line('a3')).toBe('codex/gpt-6-mini · ◆ magpie-tasks · LOW')
  step('a4', undefined, { engine: true, ruleId: null })
  expect(line('a4')).toBe('Opus 5.5 · ◆ magpie-tasks · engine effort')
})

test('a long trail shows its last five efforts', () => {
  clearBands()
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max', 'high', 'max'] as const) step('a5', e)
  expect(line('a5')).toBe('Opus 5.5 · ◆ magpie-tasks · … → high → xhigh → max → high → MAX · daily-default')
})

test('past 64 lines a finished agent\'s line goes first; running agents keep theirs', () => {
  clearBands()
  step('old', 'medium')
  noteBandDone('old')
  for (let i = 0; i < 64; i++) step(`run-${i}`, 'medium')
  expect(agentBand('old')).toBeUndefined()
  expect(agentBand('run-0')).toBeDefined()
  step('run-64', 'medium')
  expect(agentBand('run-0')).toBeDefined()
  expect(agentBand('run-64')).toBeDefined()
})
