// The band above the prompt for a routed subagent (plan section 9.7): what each request and tool call
// adds to the line, when it changes, and the text drawn at a given time. The rules are
// rules/routing-rules.json, carried as a module. Times are milliseconds on the plugin's clock; T0 is
// 2026-11-13 04:00:00 UTC.
import { expect, test } from 'claude-code/testing'
import { agentBand, bandsRunning, bandText, clearBands, elapsedText, noteBandDone, noteBandStep, noteBandTool, toolLine } from '../src/band'
import { parseRules } from '../src/rules'
import { routingRules } from './data/jev-rules'

const rules = parseRules(routingRules, { deepYes: 0.85 })
const OPUS = 'claude/claude-opus-5-5'
const T0 = 1794542400000
const line = (id: string, now = T0) => bandText(agentBand(id)!, rules, now)
const step = (id: string, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined, o: { model?: string; ruleId?: string | null; engine?: boolean; now?: number } = {}) =>
  noteBandStep(id, { model: o.model ?? OPUS, effort, ruleId: o.ruleId === undefined ? 'daily-default' : o.ruleId, engine: o.engine ?? false }, o.now ?? T0)

test('a routed agent\'s line names the model by the routing table, the effort sent and the rule; a repeat changes nothing', () => {
  clearBands()
  expect(agentBand('a1')).toBeUndefined()
  expect(step('a1', 'medium')).toBe(true)
  expect(line('a1')).toBe('Opus 5.5 · ◆ magpie-tasks · MEDIUM · daily-default · 0s')
  expect(step('a1', 'medium')).toBe(false)
  expect(step('a1', 'medium', { model: `${OPUS}[1m]` })).toBe(true)
  expect(line('a1')).toBe('Opus 5.5 · ◆ magpie-tasks · MEDIUM · daily-default · 0s')
})

test('a raise on resume extends the trail; the end of a run marks the line done until the next run', () => {
  clearBands()
  step('a2', 'high', { ruleId: 'code-change' })
  expect(noteBandDone('a2', T0)).toBe(true)
  expect(noteBandDone('a2', T0)).toBe(false)
  expect(line('a2')).toBe('Opus 5.5 · ◆ magpie-tasks · HIGH · code-change · 0s · done')
  expect(step('a2', 'xhigh', { ruleId: 'code-change' })).toBe(true)
  expect(line('a2')).toBe('Opus 5.5 · ◆ magpie-tasks · high → XHIGH · code-change · 0s')
  expect(noteBandDone('nobody', T0)).toBe(false)
})

test('a request at the engine\'s effort says so; a model outside the rules is named by its ID; a new model starts a new trail', () => {
  clearBands()
  step('a3', 'medium')
  step('a3', 'high', { engine: true })
  expect(line('a3')).toBe('Opus 5.5 · ◆ magpie-tasks · medium → HIGH · engine effort · daily-default · 0s')
  step('a3', 'low', { model: 'codex/gpt-6-mini', ruleId: null })
  expect(line('a3')).toBe('codex/gpt-6-mini · ◆ magpie-tasks · LOW · 0s')
  step('a4', undefined, { engine: true, ruleId: null })
  expect(line('a4')).toBe('Opus 5.5 · ◆ magpie-tasks · engine effort · 0s')
})

test('a long trail shows its last five efforts', () => {
  clearBands()
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max', 'high', 'max'] as const) step('a5', e)
  expect(line('a5')).toBe('Opus 5.5 · ◆ magpie-tasks · … → high → xhigh → max → high → MAX · daily-default · 0s')
})

test('past 64 lines a finished agent\'s line goes first; running agents keep theirs', () => {
  clearBands()
  step('old', 'medium')
  noteBandDone('old', T0)
  for (let i = 0; i < 64; i++) step(`run-${i}`, 'medium')
  expect(agentBand('old')).toBeUndefined()
  expect(agentBand('run-0')).toBeDefined()
  step('run-64', 'medium')
  expect(agentBand('run-0')).toBeDefined()
  expect(agentBand('run-64')).toBeDefined()
})

test('a run\'s line counts its tool calls, names the latest and shows the time it has taken; the next run starts over', () => {
  clearBands()
  expect(noteBandTool('a6', 'Bash', { command: 'ls' })).toBe(false)
  expect(bandsRunning()).toBe(false)
  step('a6', 'high', { ruleId: 'code-change' })
  expect(bandsRunning()).toBe(true)
  expect(noteBandTool('a6', 'Read', { file_path: '/home/ubuntu/sipeng/claude-mods/mods/magpie-tasks/src/gate.ts' })).toBe(true)
  expect(line('a6', T0 + 42_000)).toBe('Opus 5.5 · ◆ magpie-tasks · HIGH · code-change · 42s · 1 tool · Read gate.ts')
  noteBandTool('a6', 'Bash', { command: 'bunx tsc -p mods/magpie-tasks/tsconfig.json', description: 'Type-check the mod' })
  // A later request of the same run keeps the run's start and its count.
  step('a6', 'high', { ruleId: 'code-change', now: T0 + 100_000 })
  noteBandTool('a6', 'Edit', { file_path: 'src/band.ts', old_string: 'a', new_string: 'b' })
  expect(line('a6', T0 + 185_000)).toBe('Opus 5.5 · ◆ magpie-tasks · HIGH · code-change · 3m05s · 3 tools · Edit band.ts')
  // The time stops at the end of the run.
  expect(noteBandDone('a6', T0 + 200_000)).toBe(true)
  expect(bandsRunning()).toBe(false)
  expect(line('a6', T0 + 999_000)).toBe('Opus 5.5 · ◆ magpie-tasks · HIGH · code-change · 3m20s · 3 tools · Edit band.ts · done')
  step('a6', 'xhigh', { ruleId: 'code-change', now: T0 + 1_000_000 })
  expect(line('a6', T0 + 1_004_000)).toBe('Opus 5.5 · ◆ magpie-tasks · high → XHIGH · code-change · 4s')
})

test('a tool call is named by its tool and its most telling argument, cut to forty characters', () => {
  expect(toolLine('Bash', { command: 'cd /tmp && ls' })).toBe('Bash cd')
  expect(toolLine('Bash', { command: '/usr/bin/python3 -I x.py' })).toBe('Bash python3')
  expect(toolLine('Grep', { pattern: 'askPerson|telegramReport', path: 'src' })).toBe('Grep askPerson|telegramReport')
  expect(toolLine('NotebookEdit', { notebook_path: '/tmp/a/n.ipynb' })).toBe('NotebookEdit n.ipynb')
  expect(toolLine('mcp__magpie-tasks__open_project', { project: '/tmp/proj' })).toBe('open_project')
  expect(toolLine('Agent', { description: 'Review the gate\nchange', prompt: 'x' })).toBe('Agent Review the gate change')
  expect(toolLine('TodoWrite', {})).toBe('TodoWrite')
  const long = toolLine('Grep', { pattern: 'a-very-long-pattern-that-goes-on-and-on-and-on-for-ever' })
  expect(Array.from(long).length).toBe(40)
  expect(long.endsWith('…')).toBe(true)
  expect(elapsedText(0)).toBe('0s')
  expect(elapsedText(59_999)).toBe('59s')
  expect(elapsedText(60_000)).toBe('1m00s')
  expect(elapsedText(3_725_000)).toBe('1h02m')
})
