// What finished and interrupted tasks leave behind, and how the person's words reach an open
// question: when a worktree goes and when a done long task's architect stops (on the real
// `claude agents --json --all` rows of this host), which daily tasks a Router restart cut off, when a
// 'done' is a fix the person confirms or new work to accept, and which open question words outside a
// reply answer. The shapes follow the task records of 2026-11-11 (ydz2kl: an acceptance failed at
// 05:57, then ten fix-confirm questions while the person kept working with the executor).
import { expect, test } from 'claude-code/testing'
import { fixPending, openDailyDecision } from '../src/daily'
import { parseAgents } from '../src/launch'
import { ARCHITECT_GRACE_MS, architectToStop, worktreeReclaimable } from '../src/reclaim'
import { stalledDaily } from '../src/recovery'
import { followUpBody, worktreeGoneNote } from '../src/router'
import type { AgentRecord, Decision, TaskRecord } from '../src/types'
import { agentsAll20261109 } from './data/agents'

const rows = new Map(parseAgents(agentsAll20261109).map(r => [r.sessionId, r] as const))
const BG_RUNNING_IDLE = '455258f7-73cb-4580-a3fb-e7a7cece7995'   // background, idle, pid
const BG_DONE = '9c0bfc0e-0b69-4110-8ef7-f1c6ae54e901'           // background, ended, no pid
const ROUTER = 'ea51be77-1737-4bd6-b055-119673529472'
const NOW = Date.parse('2026-11-11T12:00:00Z')

function agent(agentId: string, role: AgentRecord['role'], over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId, role, sessionId: ROUTER, ruleId: 'review', rulesVersion: 'routing-rules.v6', selection: { kind: 'rule', reason: 'r' }, judgment: null,
    model: 'claude/claude-opus-5-5', effort: 'high', efforts: [], contextSource: 'brief', cwd: '/w', worktree: '/w', state: 'idle',
    pendingRaises: [], filesTouched: [], reports: [], startedAt: NOW - 3600_000, ...over,
  }
}

function task(kind: TaskRecord['kind'], state: TaskRecord['state'], over: Partial<TaskRecord> = {}): TaskRecord {
  const id = kind === 'long' ? 'l-20261111-a1b2c3' : 'd-20261111-ydz2kl'
  return {
    schema: 1, id, kind, title: '调研 jev 做 router', state, pausedByUser: false, createdAt: NOW - 7200_000, updatedAt: NOW - 3600_000,
    request: '可以调研一下拿 jev 做 router 的工作是怎么构建上下文的', followUps: [], project: { root: '/home/ubuntu/sipeng/claude-mods' },
    worktree: { path: `/home/ubuntu/.local/share/magpie-tasks/worktrees/${id}`, baseRef: `refs/magpie-tasks/${id}/base`, baseCommit: '0'.repeat(40) }, extraWorktrees: {},
    owner: kind === 'long'
      ? { kind: 'session', sessionId: BG_RUNNING_IDLE, jobShortId: '455258f7', previousSessionIds: [], model: 'claude/claude-opus-5-5', contextMemoryFingerprint: 'c0ffee00c0ffee00' }
      : { kind: 'agent', agentId: 'a1beb54a1ecb3dec9', workerName: 'tui-1794376290888', routerSessionId: ROUTER },
    telegram: null, agents: {}, blockers: {}, decisions: {}, deliverables: [], feedback: [], ratings: [], pendingRelays: {},
    ...over,
  }
}

function decision(id: string, kind: Decision['kind'], createdAt: number, resolved = false): Decision {
  return { id, kind, createdAt, question: 'q', options: ['整合', '不整合'], data: {}, ...(resolved ? { resolvedAt: createdAt + 1, answer: 'approve' } : {}) }
}

test('a done or abandoned task\'s worktree goes once nothing waits on it; a long task\'s only after its architect stopped', () => {
  expect(worktreeReclaimable(task('daily', 'done'), undefined)).toBe(true)
  expect(worktreeReclaimable(task('daily', 'abandoned'), undefined)).toBe(true)
  for (const s of ['running', 'waiting-user', 'paused', 'error'] as const) expect(worktreeReclaimable(task('daily', s), undefined)).toBe(false)
  expect(worktreeReclaimable(task('daily', 'done', { decisions: { q1: decision('q1', 'fix-confirm', NOW) } }), undefined)).toBe(false)
  expect(worktreeReclaimable(task('daily', 'done', { agents: { x: agent('x', 'executor', { state: 'running' }) } }), undefined)).toBe(false)
  expect(worktreeReclaimable(task('daily', 'done', { worktree: null }), undefined)).toBe(false)
  expect(worktreeReclaimable(task('long', 'done'), rows.get(BG_RUNNING_IDLE))).toBe(false)
  expect(worktreeReclaimable(task('long', 'done'), rows.get(BG_DONE))).toBe(true)
  expect(worktreeReclaimable(task('long', 'done'), undefined)).toBe(true)
})

test('a done long task\'s idle architect is stopped after the grace period, never a busy, gone or open one', () => {
  const done = (completedAt: number) => task('long', 'done', { completedAt })
  expect(architectToStop(done(NOW - ARCHITECT_GRACE_MS), rows.get(BG_RUNNING_IDLE), NOW)).toBe(true)
  expect(architectToStop(done(NOW - ARCHITECT_GRACE_MS + 1), rows.get(BG_RUNNING_IDLE), NOW)).toBe(false)
  expect(architectToStop(done(NOW - 3600_000), rows.get(BG_DONE), NOW)).toBe(false)
  expect(architectToStop(done(NOW - 3600_000), { ...rows.get(BG_RUNNING_IDLE)!, status: 'busy' }, NOW)).toBe(false)
  expect(architectToStop(task('long', 'running', { completedAt: NOW - 3600_000 }), rows.get(BG_RUNNING_IDLE), NOW)).toBe(false)
})

test('a Router restart cut off a running task whose agents are all gone: checks rerun, other work asks the person', () => {
  const none = new Set<string>()
  const executor = (reports: AgentRecord['reports']) => agent('a1beb54a1ecb3dec9', 'executor', { startedAt: NOW - 7200_000, reports })
  const doneReport = [{ at: NOW - 600_000, status: 'done' as const, text: 'ok', verification: [] }]
  const delivered = [{ at: NOW - 600_000, summary: 'ok', verification: [] }]
  // f4lzgi on 2026-11-11: the acceptance started 08:27:51 and was aborted at 08:31:25 by the restart
  const cutAcceptance = task('daily', 'running', { deliverables: delivered, agents: { e: executor(doneReport), c: agent('ac8e1b35a39748750', 'acceptance', { startedAt: NOW - 500_000 }) } })
  expect(stalledDaily(cutAcceptance, ROUTER, none)).toBe('rerun-acceptance')
  expect(stalledDaily(cutAcceptance, ROUTER, new Set(['ac8e1b35a39748750']))).toBeNull()
  // the executor reported done, and the acceptance never started
  expect(stalledDaily(task('daily', 'running', { deliverables: delivered, agents: { e: executor(doneReport) } }), ROUTER, none)).toBe('rerun-acceptance')
  const diagnosing = task('daily', 'running', { agents: { e: executor([]), d: agent('d1', 'diagnosis', { startedAt: NOW - 100_000 }) } })
  expect(stalledDaily(diagnosing, ROUTER, none)).toBe('rerun-diagnosis')
  // an executor cut off mid-run, or waiting for its own background command that the restart ended
  const working = [{ at: NOW - 600_000, status: 'working' as const, text: '等测试跑完', verification: [] }]
  expect(stalledDaily(task('daily', 'running', { agents: { e: executor(working) } }), ROUTER, none)).toBe('ask-person')
  // a finished acceptance: the executor is fixing what it found
  const failed = [{ at: NOW - 600_000, summary: 'ok', verification: [], acceptance: { agentId: 'c', pass: false, notes: 'n' } }]
  expect(stalledDaily(task('daily', 'running', { deliverables: failed, agents: { e: executor(doneReport), c: agent('c', 'acceptance', { state: 'done', startedAt: NOW - 500_000 }) } }), ROUTER, none)).toBe('ask-person')
  // tasks that wait for the person, are finished, or belong to another Router are left alone
  for (const s of ['waiting-user', 'paused', 'done', 'error'] as const) expect(stalledDaily(task('daily', s, { agents: { e: executor([]) } }), ROUTER, none)).toBeNull()
  expect(stalledDaily(task('daily', 'running', { agents: { e: executor([]) } }), 'another-router', none)).toBeNull()
  expect(stalledDaily(task('long', 'running'), ROUTER, none)).toBeNull()
})

test('after a failed acceptance, one fix goes to the person; once the person has spoken again, a done is new work', () => {
  const failed = { at: NOW - 3600_000, summary: 's', verification: [], acceptance: { agentId: 'c', pass: false, notes: 'n' } }
  expect(fixPending(task('daily', 'running', { deliverables: [failed] }))).toBe(true)
  // the fix was reported; the executor reports it again without any word from the person
  const fixed = { ...failed, acceptance: { ...failed.acceptance, fixed: { at: NOW - 3000_000 } } }
  expect(fixPending(task('daily', 'running', { deliverables: [fixed], followUps: [{ at: NOW - 3500_000, source: 'telegram', text: '先别整合' }] }))).toBe(true)
  // ydz2kl at 06:30: the person went on with the executor after the fix report
  expect(fixPending(task('daily', 'running', { deliverables: [fixed], followUps: [{ at: NOW - 2000_000, source: 'telegram', text: '再加上上下文长度的对比' }] }))).toBe(false)
  expect(fixPending(task('daily', 'running', { deliverables: [{ ...failed, acceptance: { agentId: 'c', pass: true, notes: 'n' } }] }))).toBe(false)
  expect(fixPending(task('daily', 'running', { deliverables: [{ ...failed, integration: { status: 'applied', files: ['a'], at: NOW } }] }))).toBe(false)
  expect(fixPending(task('daily', 'running'))).toBe(false)
})

test('words outside a reply answer the newest open question the person can answer that way', () => {
  const open = task('daily', 'waiting-user', {
    decisions: {
      old: decision('q-old', 'fix-confirm', NOW - 3000_000),
      newer: decision('q-new', 'no-progress', NOW - 1000_000),
      done: decision('q-done', 'model-change-confirm', NOW - 500_000, true),
      assess: decision('q-route', 'route-confirm', NOW - 100_000),
    },
  })
  expect(openDailyDecision(open)?.id).toBe('q-new')
  expect(openDailyDecision(task('daily', 'running', { decisions: { a: decision('q-route', 'route-confirm', NOW) } }))).toBeUndefined()
  expect(openDailyDecision(task('daily', 'running'))).toBeUndefined()
})

test('a terminal follow-up is read like a Telegram one, and a finished task\'s follow-up says its worktree must be made again', () => {
  expect(followUpBody('终端 追问（message_id=1794388364703）：\n整合')).toEqual({ messageId: 1794388364703, body: '整合' })
  const gone = worktreeGoneNote(task('daily', 'running', { worktree: null }))
  expect(gone).toContain('mcp__magpie-tasks__open_project')
  expect(gone).toContain('/home/ubuntu/sipeng/claude-mods')
  expect(worktreeGoneNote(task('daily', 'running'))).toBeNull()
  expect(worktreeGoneNote(task('daily', 'running', { worktree: null, project: null }))).toBeNull()
  expect(worktreeGoneNote(task('long', 'running', { worktree: null }))).toBeNull()
  // a task that changed the project directory in place never had a worktree to lose
  expect(worktreeGoneNote(task('daily', 'running', { worktree: null, direct: { dir: '/home/ubuntu/sipeng/claude-mods', baseRef: null, baseCommit: null } }))).toBeNull()
})
