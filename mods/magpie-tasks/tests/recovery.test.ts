// Startup recovery decisions (plan section 12.1, recovery row) on the real `claude agents --json
// --all` output of this host: running, idle, stopped and failed sessions; launches nobody claimed;
// integrations that started without finishing; and the context-memory fingerprint, which only the
// four fields of installed_plugins.json's entry decide (the real files of ~/.claude and of a probe
// config without context-memory).
import { expect, test } from 'claude-code/testing'
import { fnv1a64 } from '../src/io'
import { parseAgents } from '../src/launch'
import { CONTEXT_MEMORY_RELOADED, fingerprintOf, isRecoveryMessage, needsReload, recoveryAction, unfinishedIntegrations } from '../src/recovery'
import type { TaskRecord } from '../src/types'
import { agentsAll20261109 } from './data/agents'
import { installedPluginsHome, installedPluginsProbe } from './data/installed-plugins'

const rows = new Map(parseAgents(agentsAll20261109).map(r => [r.sessionId, r] as const))
// Sessions of that output, by shape.
const BG_RUNNING_IDLE = '455258f7-73cb-4580-a3fb-e7a7cece7995'   // background, state working, status idle, pid
const BG_DONE = '9c0bfc0e-0b69-4110-8ef7-f1c6ae54e901'           // background, done, no pid
const BG_FAILED = '2d248fb8-203d-4d0b-9539-99d20ddc82a5'         // background, failed, no pid
const ROUTER = 'ea51be77-1737-4bd6-b055-119673529472'            // interactive claude-telegram, busy, pid
const INTERACTIVE_IDLE = '9a785f87-61f8-455c-af23-2ba52301feb8'  // interactive, idle, pid
const GONE = '0d1e2f30-4a5b-4c6d-8e7f-9a0b1c2d3e4f'              // in no row

const NOW = Date.parse('2026-11-09T12:00:00Z')
const FP = 'c0ffee00c0ffee00'

function long(sessionId: string, state: TaskRecord['state'], over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schema: 1, id: 'l-20261109-a1b2c3', kind: 'long', title: '整理 greet', state, pausedByUser: false, createdAt: NOW - 3600_000, updatedAt: NOW - 60_000,
    request: '检查 greet.py', followUps: [], project: { root: '/tmp/mt/proj' },
    worktree: { path: '/tmp/mt/wt/l-20261109-a1b2c3', baseRef: 'refs/magpie-tasks/l-20261109-a1b2c3/base', baseCommit: '0'.repeat(40) }, extraWorktrees: {},
    owner: { kind: 'session', sessionId, jobShortId: sessionId.slice(0, 8), previousSessionIds: [], model: 'claude/claude-opus-5-5', contextMemoryFingerprint: FP },
    architect: { model: 'claude/claude-opus-5-5', recommendation: { model: 'claude/claude-opus-5-5', reason: 'r', limits: 'l', judgment: null }, userChoice: 'Opus 5.5（推荐）', confirmedAt: NOW - 3600_000, source: 'new' },
    telegram: { chatId: '123456789' }, agents: {}, blockers: {}, decisions: {}, deliverables: [], feedback: [], ratings: [], pendingRelays: {},
    ...over,
  }
}

function daily(routerSessionId: string, state: TaskRecord['state']): TaskRecord {
  return { ...long(routerSessionId, state), id: 'd-20261109-d4e5f6', kind: 'daily', owner: { kind: 'agent', agentId: 'a83b0057bf058d018', workerName: 'greet-hi', routerSessionId } }
}

const as = { now: NOW, routerSessionId: null }

test('long tasks: a running process is left alone, a stopped or failed one is resumed', () => {
  expect(recoveryAction(long(BG_RUNNING_IDLE, 'running'), rows, as)).toBe('alive')
  expect(recoveryAction(long(BG_RUNNING_IDLE, 'paused'), rows, as)).toBe('alive')
  expect(recoveryAction(long(BG_DONE, 'running'), rows, as)).toBe('resume')
  expect(recoveryAction(long(BG_FAILED, 'running'), rows, as)).toBe('resume')
  expect(recoveryAction(long(GONE, 'running'), rows, as)).toBe('resume')
  expect(recoveryAction(long(BG_DONE, 'paused'), rows, as)).toBe('resume')
  expect(recoveryAction(long(BG_DONE, 'paused', { pausedByUser: true }), rows, as)).toBe('none')
  expect(recoveryAction(long(BG_DONE, 'waiting-user'), rows, as)).toBe('keep-waiting')
  for (const s of ['done', 'abandoned', 'error'] as const) expect(recoveryAction(long(BG_DONE, s), rows, as)).toBe('none')
})

test('the messages recovery resumes an architect with are the plugin\'s, not the person\'s', () => {
  // The first message of the resumed architect 203a0aff, as its transcript stored it (2026-11-10).
  const resumed = '[magpie-tasks recovery] This session was interrupted and magpie-tasks has resumed it.\nNo subagent was running.\nTask worktree /home/ubuntu/.local/share/magpie-tasks/worktrees/l-20261109-5vf47x, git status --short:\n(clean)\nCheck the worktree and the subagents\' reports against the task, then continue.'
  expect(isRecoveryMessage(resumed)).toBe(true)
  expect(isRecoveryMessage(CONTEXT_MEMORY_RELOADED)).toBe(true)
  expect(isRecoveryMessage('greet.py 现在输出什么？')).toBe(false)
})

test('a task still starting after the 10-minute claim window was never claimed', () => {
  expect(recoveryAction(long(GONE, 'starting', { createdAt: NOW - 11 * 60_000 }), rows, as)).toBe('never-claimed')
  expect(recoveryAction(long(GONE, 'starting', { createdAt: NOW - 9 * 60_000 }), rows, as)).toBe('none')
})

test('daily tasks are orphaned when their Router is gone, judged by the Router itself or by its process', () => {
  expect(recoveryAction(daily(ROUTER, 'running'), rows, as)).toBe('none')
  expect(recoveryAction(daily(BG_DONE, 'running'), rows, as)).toBe('orphaned-daily')
  expect(recoveryAction(daily(GONE, 'running'), rows, as)).toBe('orphaned-daily')
  expect(recoveryAction(daily(GONE, 'waiting-user'), rows, as)).toBe('none')
  expect(recoveryAction(daily(ROUTER, 'running'), rows, { now: NOW, routerSessionId: ROUTER })).toBe('none')
  expect(recoveryAction(daily(INTERACTIVE_IDLE, 'running'), rows, { now: NOW, routerSessionId: ROUTER })).toBe('orphaned-daily')
})

test('only an idle running architect with another fingerprint is reloaded', () => {
  expect(needsReload(long(BG_RUNNING_IDLE, 'running'), rows.get(BG_RUNNING_IDLE), 'feedfacefeedface')).toBe(true)
  expect(needsReload(long(BG_RUNNING_IDLE, 'running'), rows.get(BG_RUNNING_IDLE), FP)).toBe(false)
  expect(needsReload(long(INTERACTIVE_IDLE, 'running', { architect: { ...long(INTERACTIVE_IDLE, 'running').architect!, source: 'takeover' } }), rows.get(INTERACTIVE_IDLE), 'feedfacefeedface')).toBe(true)
  expect(needsReload(long(ROUTER, 'running'), rows.get(ROUTER), 'feedfacefeedface')).toBe(false)
  expect(needsReload(long(BG_DONE, 'running'), rows.get(BG_DONE), 'feedfacefeedface')).toBe(false)
  expect(needsReload(long(GONE, 'running'), rows.get(GONE), 'feedfacefeedface')).toBe(false)
})

// Task log lines as Registry appends them ({ at, session, type, ... }) with integrate.ts's entries.
const entry = (type: string, tree: string, extra: Record<string, unknown> = {}) => JSON.stringify({ at: NOW, session: BG_DONE, type, target: '/tmp/mt/proj', source: '/tmp/mt/wt/l-20261109-a1b2c3', base: 'a'.repeat(40), tree, files: ['greet.py'], ...extra })

test('an integration-start without an integration of the same tree is unfinished', () => {
  const done = [entry('integration-start', 't1'), entry('integration', 't1', { status: 'applied', newBase: 'b'.repeat(40) })].join('\n') + '\n'
  expect(unfinishedIntegrations(done)).toEqual([])
  const cut = done + JSON.stringify({ at: NOW, session: BG_DONE, type: 'report', agentId: 'a1' }) + '\n' + entry('integration-start', 't2') + '\n'
  expect(unfinishedIntegrations(cut)).toEqual([{ tree: 't2', target: '/tmp/mt/proj', files: ['greet.py'], at: NOW }])
  expect(unfinishedIntegrations(cut + entry('integration', 't2', { status: 'conflict', detail: 'x' }) + '\n')).toEqual([])
  expect(unfinishedIntegrations('')).toEqual([])
  // A change recorded where a direct task made it applied no tree: it has no start entry and closes none.
  const inPlace = JSON.stringify({ at: NOW, session: BG_DONE, type: 'integration', status: 'in-place', target: '/tmp/mt/proj', files: ['greet.py'] }) + '\n'
  expect(unfinishedIntegrations(done + inPlace)).toEqual([])
  expect(unfinishedIntegrations(cut + inPlace).map(u => u.tree)).toEqual(['t2'])
  expect(() => unfinishedIntegrations(JSON.stringify({ type: 'integration-start' }))).toThrow('without a tree')
})

test('the context-memory fingerprint is the hash of its installs\' four fields, or absent', () => {
  type Installed = { plugins: Record<string, Record<string, unknown>[]> }
  const entries = (installedPluginsHome as Installed).plugins['context-memory@sipeng-mods']!
  const user = entries.find(x => x['scope'] === 'user')!
  const fp = fingerprintOf(installedPluginsHome)
  expect(fp).toBe(fnv1a64(JSON.stringify([[user['installPath'], user['version'], user['gitCommitSha'], user['lastUpdated']]])))
  expect(fp).toMatch(/^[0-9a-f]{16}$/)
  expect(fingerprintOf(installedPluginsProbe)).toBe('absent')
  const changed = (field: string, value: unknown, plugin = 'context-memory@sipeng-mods') => {
    const copy = structuredClone(installedPluginsHome) as Installed
    copy.plugins[plugin]![0]![field] = value
    return fingerprintOf(copy)
  }
  expect(changed('installedAt', '2026-11-10T00:00:00.000Z')).toBe(fp)
  expect(changed('lastUpdated', '2026-11-10T00:00:00.000Z', 'jev@sipeng-mods')).toBe(fp)
  for (const f of ['installPath', 'version', 'gitCommitSha', 'lastUpdated']) expect(changed(f, 'x')).not.toBe(fp)
  // A local-scope install, shaped as this host's local entries are (superpower-planning's for
  // /home/ubuntu/sipeng), with context-memory's install fields: alone it has a fingerprint, and
  // beside the user install it changes the fingerprint when it is updated.
  const local = { ...(installedPluginsHome as Installed).plugins['superpower-planning@superpower-planning']!.find(x => x['scope'] === 'local')!, ...user, scope: 'local', projectPath: '/home/ubuntu/sipeng' }
  const only = structuredClone(installedPluginsHome) as Installed
  only.plugins['context-memory@sipeng-mods'] = [local]
  expect(fingerprintOf(only)).toBe(fp)
  const both = structuredClone(installedPluginsHome) as Installed
  both.plugins['context-memory@sipeng-mods'] = [user, local]
  const fpBoth = fingerprintOf(both)
  both.plugins['context-memory@sipeng-mods'] = [user, { ...local, version: '0.4.0' }]
  expect(fingerprintOf(both)).not.toBe(fpBoth)
})
