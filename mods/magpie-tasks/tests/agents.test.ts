// The session_agents tool's answer, on the agents of the Router session of 2026-11-12: worker
// tui-1794452787458 started at 03:06:30 with the engine's reminder naming tui-1794452345662 (whose
// last turn had ended at 03:05:33) and its acceptance check (ended 03:06:40), and at 03:23:16 its
// answer called both still running.
import { expect, test } from 'claude-code/testing'
import { sessionAgentsText, type Routed } from '../src/agents'
import { TOOL_NAMES, TOOL_SPECS, toolOwner } from '../src/tools'

const NOW = Date.parse('2026-11-12T03:23:16Z')
const SELF = 'ac7562adabd35e397'
const worker = { id: 'a6cf6cee9f8e535c2', name: 'tui-1794452345662', description: '整合后台回收修复并重装插件 · Opus 5.5/medium' }
const check = { id: 'acb8d2954d44b20b9', name: 'tui-1794452345662-acc1', description: '验收：好的，需要 · Opus 5.5/high' }
const self = { id: SELF, name: 'tui-1794452787458', description: '验收改用周剩余额度最少的订阅里最合适的模型 · Opus 5.5/xhigh', status: 'running' as const }
const task = { id: 'd-20261112-6zeoxd', title: '好的，需要' }
const records: Record<string, Routed> = {
  [worker.id]: { task, agent: { role: 'executor', reports: [{ at: 1794452734030, status: 'done', text: 'ok', verification: [] }] } },
  [check.id]: { task, agent: { role: 'acceptance', reports: [{ at: 1794452800244, status: 'done', text: 'ok', verification: [] }] } },
}
const routed = (id: string) => records[id]

test('agents whose last turn ended are listed as not running, with their task and how the last answer ended', () => {
  const text = sessionAgentsText([{ ...worker, status: 'idle' }, { ...check, status: 'completed' }, self], SELF, routed, NOW)
  const lines = text.split('\n')
  expect(lines[0]).toBe('The agents of this session other than you, at 2026-11-12 03:23:16 UTC: 0 of 2 running.')
  expect(lines[1]).toBe('- tui-1794452345662 (整合后台回收修复并重装插件 · Opus 5.5/medium): not running, between turns: its last turn ended, and a message can continue it. The executor of task d-20261112-6zeoxd 「好的，需要」. Its last answer, 18 min ago, ended with 状态：已完成.')
  expect(lines[2]).toBe('- tui-1794452345662-acc1 (验收：好的，需要 · Opus 5.5/high): not running, ended: its work is finished, and a message can continue it. The acceptance of task d-20261112-6zeoxd 「好的，需要」. Its last answer came 17 min ago.')
  expect(lines.length).toBe(4)
  expect(text.includes('tui-1794452787458')).toBe(false)
})

test('running agents come first and are counted; an agent the plugin did not route is listed by what the engine knows', () => {
  const helper = { id: 'a0000000000000001', description: 'Explore the gate module', status: 'waiting' as const }
  const text = sessionAgentsText([{ ...worker, status: 'idle' }, { ...check, status: 'running' }, helper, self], SELF, routed, NOW)
  const lines = text.split('\n')
  expect(lines[0]).toBe('The agents of this session other than you, at 2026-11-12 03:23:16 UTC: 2 of 3 running.')
  expect(lines[1]!.startsWith('- tui-1794452345662-acc1 (验收：好的，需要 · Opus 5.5/high): RUNNING, running a turn.')).toBe(true)
  expect(lines[2]).toBe('- a0000000000000001 (Explore the gate module): RUNNING, waiting on background work or a subagent it started.')
  expect(lines[3]!.includes('not running')).toBe(true)
})

test('an idle executor whose last answer waits on its own background work is named as such', () => {
  const waiting: Routed = { task, agent: { role: 'executor', reports: [{ at: NOW - 20_000, status: 'working', text: '', verification: [] }] } }
  const text = sessionAgentsText([{ ...worker, status: 'idle' }, self], SELF, () => waiting, NOW)
  expect(text.includes('Its last answer, less than a minute ago, ended with 状态：进行中, so background work it started may still run.')).toBe(true)
})

test('an executor the engine no longer lists, whose last answer waits on its background work, is still named', () => {
  const waiting = { task, agent: { role: 'executor' as const, reports: [{ at: NOW - 240_000, status: 'working' as const, text: '', verification: [] }] }, label: 'tui-1794452345662' }
  const lines = sessionAgentsText([{ ...check, status: 'completed' }, self], SELF, routed, NOW, [waiting]).split('\n')
  expect(lines[0]).toBe('The agents of this session other than you, at 2026-11-12 03:23:16 UTC: 0 of 1 running.')
  expect(lines[2]).toBe("- tui-1794452345662: not in the engine's list of agents, but its last answer, 4 min ago, ended with 状态：进行中, so background work it started may still run. The executor of task d-20261112-6zeoxd 「好的，需要」.")
  expect(sessionAgentsText([self], SELF, routed, NOW, [waiting]).split('\n').length).toBe(3)
})

test('a session with no other agent says so', () => {
  expect(sessionAgentsText([self], SELF, routed, NOW)).toBe('At 2026-11-12 03:23:16 UTC this session has no agent other than you: nothing else runs in it.')
})

test('the main conversation gets every agent of the session', () => {
  const lines = sessionAgentsText([{ ...worker, status: 'idle' }, self], undefined, routed, NOW).split('\n')
  expect(lines[0]).toBe('The agents of this session other than you, at 2026-11-12 03:23:16 UTC: 1 of 2 running.')
  expect(lines[1]!.startsWith('- tui-1794452787458 (验收改用周剩余额度最少的订阅里最合适的模型 · Opus 5.5/xhigh): RUNNING, running a turn.')).toBe(true)
})

test('session_agents is a tool of the main conversation and of subagents, and takes no arguments', () => {
  expect(toolOwner('mcp__magpie-tasks__session_agents')).toEqual({ name: 'session_agents', kind: 'session' })
  expect(toolOwner('mcp__magpie-tasks__open_project')).toEqual({ name: 'open_project', kind: 'subagent' })
  expect(TOOL_NAMES.includes('mcp__magpie-tasks__session_agents')).toBe(true)
  expect(TOOL_SPECS.session_agents.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false })
})
