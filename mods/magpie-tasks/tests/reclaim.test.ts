// What finished and interrupted tasks leave behind, and how the person's words reach an open
// question: when a worktree goes and when a done long task's architect stops (on the real
// `claude agents --json --all` rows of this host), which daily tasks a Router restart cut off, when a
// 'done' is a fix the person confirms or new work to accept, and which open question words outside a
// reply answer. The shapes follow the task records of 2026-11-11 (ydz2kl: an acceptance failed at
// 05:57, then ten fix-confirm questions while the person kept working with the executor).
import { expect, test } from 'claude-code/testing'
import { checkedDeliverable, resultStanding } from '../src/brief'
import { fixPending, openDailyDecision } from '../src/daily'
import { parseAgents } from '../src/launch'
import { ARCHITECT_GRACE_MS, architectToStop, worktreeReclaimable } from '../src/reclaim'
import { directOf, workspaceOf, workspacePaths, writeRange } from '../src/workspace'
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
  const blockers = { b1: { id: 'b1', description: '测试机连不上', diagnoses: 1, modelChanges: 0, history: [{ at: NOW - 120_000, step: 'diagnosis' as const, agentId: 'a1beb54a1ecb3dec9', note: 'blocked report: 测试机连不上' }] } }
  const blockedReport = [{ at: NOW - 120_000, status: 'blocked' as const, text: '受阻', verification: [] }]
  const diagnosing = task('daily', 'running', { blockers, agents: { e: executor(blockedReport), d: agent('d1', 'diagnosis', { startedAt: NOW - 100_000 }) } })
  expect(stalledDaily(diagnosing, ROUTER, none)).toBe('rerun-diagnosis')
  // an executor cut off mid-run, or waiting for its own background command that the restart ended
  const working = [{ at: NOW - 600_000, status: 'working' as const, text: '等测试跑完', verification: [] }]
  expect(stalledDaily(task('daily', 'running', { agents: { e: executor(working) } }), ROUTER, none)).toBe('ask-person')
  // the person wrote to the executor after its result and the restart cut both off: a new check of
  // that result would be superseded, so the person is asked
  expect(stalledDaily(task('daily', 'running', { deliverables: delivered, agents: { e: executor(doneReport), c: agent('ac8e1b35a39748750', 'acceptance', { startedAt: NOW - 500_000 }) } }), ROUTER, none)).toBe('rerun-acceptance')
  const resumed = agent('a1beb54a1ecb3dec9', 'executor', { startedAt: NOW - 7200_000, reports: doneReport, turnAt: NOW - 300_000 })
  expect(stalledDaily(task('daily', 'running', { deliverables: delivered, agents: { e: resumed, c: agent('ac8e1b35a39748750', 'acceptance', { startedAt: NOW - 500_000 }) } }), ROUTER, none)).toBe('ask-person')
  // a finished acceptance: the executor is fixing what it found
  const failed = [{ at: NOW - 600_000, summary: 'ok', verification: [], acceptance: { agentId: 'c', pass: false, notes: 'n' } }]
  expect(stalledDaily(task('daily', 'running', { deliverables: failed, agents: { e: executor(doneReport), c: agent('c', 'acceptance', { state: 'done', startedAt: NOW - 500_000 }) } }), ROUTER, none)).toBe('ask-person')
  // The person stopped the executor while its acceptance ran, and the restart cut off the
  // integration of the stopped result: it is integrated, and the result is never checked.
  const stoppedAt = NOW - 200_000
  const stopTurn = { turnAt: NOW - 250_000, startedAt: NOW - 7200_000 }
  const stopReports = [...doneReport, { at: stoppedAt, status: 'stopped' as const, text: '已停止', verification: [] }]
  const stoppedResult = [...delivered, { at: stoppedAt, summary: '已停止', verification: [], stopped: true as const }]
  const cutStop = task('daily', 'running', { deliverables: stoppedResult, agents: { e: agent('a1beb54a1ecb3dec9', 'executor', { ...stopTurn, reports: stopReports }), c: agent('ac8e1b35a39748750', 'acceptance', { startedAt: NOW - 500_000, checks: NOW - 600_000 }) } })
  expect(stalledDaily(cutStop, ROUTER, none)).toBe('integrate')
  // the same with no acceptance on record, and a result judged to need no check
  expect(stalledDaily(task('daily', 'running', { deliverables: stoppedResult, agents: { e: agent('a1beb54a1ecb3dec9', 'executor', { ...stopTurn, reports: stopReports }) } }), ROUTER, none)).toBe('integrate')
  const unneeded = [{ ...delivered[0]!, check: { needed: false, p: 0.1, provider: 'jev' as const } }]
  expect(stalledDaily(task('daily', 'running', { deliverables: unneeded, agents: { e: executor(doneReport) } }), ROUTER, none)).toBe('integrate')
  // the person stopped the executor during a diagnosis of its blocked report: the stopped result is
  // integrated and the diagnosis is not run again
  const stopDuringDiagnosis = task('daily', 'running', { blockers, deliverables: [{ at: NOW - 50_000, summary: '已停止', verification: [], stopped: true }], agents: { e: agent('a1beb54a1ecb3dec9', 'executor', { startedAt: NOW - 7200_000, turnAt: NOW - 60_000, reports: [...blockedReport, { at: NOW - 50_000, status: 'stopped', text: '已停止', verification: [] }] }), d: agent('d1', 'diagnosis', { startedAt: NOW - 100_000 }) } })
  expect(stalledDaily(stopDuringDiagnosis, ROUTER, none)).toBe('integrate')
  // a message reached the executor after the stopped result, and the restart cut that turn off too
  expect(stalledDaily(task('daily', 'running', { deliverables: stoppedResult, agents: { e: agent('a1beb54a1ecb3dec9', 'executor', { startedAt: NOW - 7200_000, turnAt: NOW - 100_000, reports: stopReports }) } }), ROUTER, none)).toBe('ask-person')
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
  // a task with several projects names the ones whose worktree went; a project changed in place is not one of them
  const more = [
    { project: { root: '/home/ubuntu/sipeng/plans' }, worktree: null, direct: { dir: '/home/ubuntu/sipeng/plans', baseRef: 'refs/magpie-tasks/d-20261111-ydz2kl/p2/base', baseCommit: '1'.repeat(40) } },
    { project: { root: '/home/ubuntu/sipeng/mhot-vm' }, worktree: null, direct: null },
  ]
  expect(worktreeGoneNote(task('daily', 'running', { more }))).toContain('If this message asks for changes to /home/ubuntu/sipeng/mhot-vm, call')
  expect(worktreeGoneNote(task('daily', 'running', { worktree: null, more }))).toContain('changes to /home/ubuntu/sipeng/claude-mods or /home/ubuntu/sipeng/mhot-vm, call mcp__magpie-tasks__open_project for that project again first')
})

test('a task\'s working directories are those of its projects, and an agent writes in its own and the other projects\'', () => {
  const wt = '/home/ubuntu/.local/share/magpie-tasks/worktrees/l-20261111-a1b2c3'
  const plans = '/home/ubuntu/sipeng/plans'
  const more = [
    { project: { root: plans }, worktree: null, direct: { dir: plans, baseRef: 'refs/magpie-tasks/l-20261111-a1b2c3/p2/base', baseCommit: '1'.repeat(40) } },
    { project: { root: '/home/ubuntu/sipeng/mhot-vm' }, worktree: null, direct: null },
  ]
  const t = task('long', 'running', { more })
  expect(workspaceOf(t)).toBe(wt)
  expect(workspacePaths(t)).toEqual([wt, plans])
  expect(workspaceOf(task('long', 'running', { worktree: null, more }))).toBe(plans)
  expect(directOf(t, plans)).toEqual({ git: true })
  expect(directOf(t, wt)).toBeNull()
  // The project main directory is left to the task worktree of it.
  expect(writeRange(t, { worktree: wt })).toEqual({ dirs: [wt, plans], copies: { '/home/ubuntu/sipeng/claude-mods': wt } })
  expect(writeRange(t, { worktree: null })).toEqual({ dirs: [], copies: {} })
  // An agent with a separate copy of the first working directory, and a helper working in that copy:
  // the copy stands in for the shared worktree, the other projects stay shared.
  const copy = `${wt}-a83b0057bf058d018`
  const separate = task('long', 'running', { more, extraWorktrees: { a83b0057bf058d018: { path: copy, baseRef: 'refs/magpie-tasks/l-20261111-a1b2c3/a83b0057bf058d018/base', forAgent: 'a83b0057bf058d018' } } })
  expect(writeRange(separate, { worktree: copy })).toEqual({ dirs: [copy, plans], copies: { [wt]: copy, '/home/ubuntu/sipeng/claude-mods': copy } })
  expect(writeRange(separate, { worktree: wt })).toEqual({ dirs: [wt, plans], copies: { '/home/ubuntu/sipeng/claude-mods': wt } })
})

// The times of d-20261112-yvg26j: the executor answered at 1794470188902, its acceptance was
// recorded as started at 1794470190300, and the person interrupted the executor at 1794470389718.
test('an acceptance verdict acts only while no executor has gone back to work after the result it checks', () => {
  const RESULT = 1794470188902
  const first = { at: RESULT, summary: '没有打满', verification: [] }
  const exec = (over: Partial<AgentRecord> = {}) => agent('a2b424d131b6fc71e', 'executor', { startedAt: 1794469178740, ...over })
  const acc = agent('a7e2daf9cb8040eb7', 'acceptance', { startedAt: 1794470190300, checks: RESULT })
  const of = (deliverables: TaskRecord['deliverables'], e: AgentRecord) => task('daily', 'running', { deliverables, agents: { e, c: acc } })
  // Nothing reached the executor since its result: the verdict acts.
  expect(checkedDeliverable(of([first], exec()), acc)).toEqual({ index: 0, superseded: false })
  // The person's stop reached it while the check was still starting, and it answered 状态：已停止
  // before the acceptance was recorded: the verdict is about the result its brief was written from.
  const stopped = { at: 1794470190000, summary: '已停止', verification: [], stopped: true as const }
  expect(checkedDeliverable(of([first, stopped], exec({ turnAt: 1794470189500 })), acc)).toEqual({ index: 0, superseded: true })
  // A message reached it during the check and the person interrupted that turn: no new result, the
  // verdict is still superseded.
  expect(checkedDeliverable(of([first], exec({ turnAt: 1794470363723 })), acc)).toEqual({ index: 0, superseded: true })
  // Another executor took the task over after the result.
  const handed = task('daily', 'running', { deliverables: [first], agents: { e: exec(), x: agent('ax2', 'executor', { startedAt: RESULT + 60_000 }), c: acc } })
  expect(checkedDeliverable(handed, acc)).toEqual({ index: 0, superseded: true })
  // A check started after a Router restart is bound to the latest result; the executor's earlier turn does not supersede it.
  const later = { at: 1794470400000, summary: '修正后的结论', verification: [] }
  expect(checkedDeliverable(of([first, later], exec({ turnAt: 1794470300000 })), { ...acc, checks: later.at })).toEqual({ index: 1, superseded: false })
  expect(() => checkedDeliverable(of([first], exec()), { ...acc, checks: undefined })).toThrow()
  // Whether to check a result is judged after the turn that produced it; the person stopped the
  // executor while Jev was asked, and its stopped result came in: the judgment starts nothing.
  expect(resultStanding(of([first, stopped], exec({ turnAt: 1794470189500 })), RESULT)).toEqual({ index: 0, superseded: true })
  expect(resultStanding(of([first], exec()), RESULT)).toEqual({ index: 0, superseded: false })
  expect(() => checkedDeliverable(of([first], exec()), { ...acc, checks: RESULT + 1 })).toThrow()
})
