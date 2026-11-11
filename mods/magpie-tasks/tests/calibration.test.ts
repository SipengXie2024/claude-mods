// Ratings and calibration (plan section 12.1, calibration row): scores in replies, the daily
// invitation at the local hour across a time-zone boundary, the pick among the day's completed tasks
// (settings under review first), and the two-week evidence: the three-task threshold, the 14-day
// window, substitute successes, and the bands of Jev's deep probability. Judgments are a real Jev
// answer (tests/data/jev-responses.ts) with its deep probability set per case.
import { expect, test } from 'claude-code/testing'
import { bandFindings, bandOf, bandStats, calibrationFindings, completionMessageId, localTime, modelOpinions, parseRating, pickRatingTask, ratingDue, ratingFirst, ratingInvitation, reminderText, startEffortOf } from '../src/calibration'
import { parseResponse } from '../src/jev'
import { spawnJudgment } from '../src/judge'
import { parseRules } from '../src/rules'
import { RATING_BUTTONS } from '../src/telegram'
import type { AgentRecord, JevJudgment, TaskRecord } from '../src/types'
import { jevSpawnScheduler } from './data/jev-responses'
import { routingRules } from './data/jev-rules'

const rules = parseRules(routingRules, { deepYes: 0.85 })
const scheduler = parseResponse(jevSpawnScheduler.body, jevSpawnScheduler.request.questions)
const JUDGED: JevJudgment = spawnJudgment(scheduler.answers, { latencyMs: 0, inputTokens: scheduler.inputTokens }, rules)
const judgedAt = (deepP: number): JevJudgment => ({ ...JUDGED, deepP, deep: deepP >= rules.thresholds.deepYes })

const TZ = 'Asia/Shanghai'
const NOW = Date.parse('2026-11-09T14:00:00Z')   // 22:00 in Shanghai
const DAY = 24 * 3600_000

function agent(id: string, over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: id, name: `tg-7051661301-953${id === 'a1' ? '' : `-${id}`}`, role: 'executor', sessionId: 'ea51be77-1737-4bd6-b055-119673529472',
    ruleId: 'code-change', rulesVersion: 'routing-rules.v1', selection: { kind: 'rule', reason: 'Jev code-change 0.82' }, judgment: null,
    model: 'claude/claude-opus-5-5', effort: 'xhigh', efforts: [{ at: NOW - 3 * DAY, from: null, to: 'xhigh', reason: 'rule' }], contextSource: 'brief',
    cwd: '/home/ubuntu', worktree: null, state: 'done', pendingRaises: [], filesTouched: [], reports: [], startedAt: NOW - 3 * DAY,
    ...over,
  }
}

function task(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schema: 1, id, kind: 'daily', title: `任务 ${id}`, state: 'done', pausedByUser: false, createdAt: NOW - 3 * DAY, updatedAt: NOW - 2 * DAY,
    request: '在 ~/repo 里把 greet.py 的 hello 改成 hi', followUps: [], project: null, worktree: null, extraWorktrees: {},
    owner: { kind: 'agent', agentId: 'a1', workerName: 'tg-7051661301-953', routerSessionId: 'ea51be77-1737-4bd6-b055-119673529472' },
    telegram: { chatId: '7051661301', rootMessageId: 953, workerName: 'tg-7051661301-953' },
    agents: { a1: agent('a1') }, blockers: {}, decisions: {}, deliverables: [], feedback: [], ratings: [], pendingRelays: {},
    ...over,
  }
}

test('scores: 评分 N to any message, a bare digit only to an invitation', () => {
  expect(parseRating('评分 4', undefined)).toBe(4)
  expect(parseRating(' 评分：5 ', 'magpie')).toBe(5)
  expect(parseRating('评分３', 'long')).toBe(3)
  expect(parseRating('2', 'rating')).toBe(2)
  expect(parseRating('５分', 'rating')).toBe(5)
  expect(parseRating('2', 'magpie')).toBeNull()
  expect(parseRating('2', undefined)).toBeNull()
  expect(parseRating('评分 6', 'rating')).toBeNull()
  expect(parseRating('0', 'rating')).toBeNull()
  expect(parseRating('给它评分 4 吧', 'rating')).toBeNull()
  expect(parseRating('改成 3 个文件', 'rating')).toBeNull()
})

test('the local day and hour follow the time zone, across UTC midnight', () => {
  expect(localTime(Date.parse('2026-11-09T15:59:00Z'), TZ)).toEqual({ day: '2026-11-09', hour: 23 })
  expect(localTime(Date.parse('2026-11-09T16:00:00Z'), TZ)).toEqual({ day: '2026-11-10', hour: 0 })
  expect(localTime(Date.parse('2026-11-09T16:00:00Z'), 'UTC')).toEqual({ day: '2026-11-09', hour: 16 })
})

test('an invitation is due once a day from the rating hour, local time', () => {
  expect(ratingDue({}, Date.parse('2026-11-09T12:59:00Z'), TZ, 21)).toBe(false)   // 20:59
  expect(ratingDue({}, Date.parse('2026-11-09T13:00:00Z'), TZ, 21)).toBe(true)    // 21:00
  expect(ratingDue({ lastInviteDay: '2026-11-09' }, Date.parse('2026-11-09T15:30:00Z'), TZ, 21)).toBe(false)
  // 00:10 on the 10th in Shanghai is a new day, but before the hour.
  expect(ratingDue({ lastInviteDay: '2026-11-09' }, Date.parse('2026-11-09T16:10:00Z'), TZ, 21)).toBe(false)
  expect(ratingDue({ lastInviteDay: '2026-11-09' }, Date.parse('2026-11-10T13:00:00Z'), TZ, 21)).toBe(true)
  // The same instant is 13:00 UTC: not yet due there.
  expect(ratingDue({}, Date.parse('2026-11-09T13:00:00Z'), 'UTC', 21)).toBe(false)
})

test('the invitation goes under one task completed that local day, with a chat and no score', () => {
  const today = task('d-20261109-aaaaaa', { completedAt: Date.parse('2026-11-09T01:00:00Z') })        // 09:00 local
  const lateUtc = task('d-20261109-bbbbbb', { completedAt: Date.parse('2026-11-08T17:00:00Z') })      // 01:00 local on the 9th
  const yesterday = task('d-20261108-cccccc', { completedAt: Date.parse('2026-11-08T15:00:00Z') })    // 23:00 local on the 8th
  const rated = task('d-20261109-dddddd', { completedAt: Date.parse('2026-11-09T02:00:00Z'), ratings: [{ at: NOW, score: 4, raw: '评分 4', invited: false }] })
  const terminal = task('d-20261109-eeeeee', { completedAt: Date.parse('2026-11-09T02:00:00Z'), telegram: { chatId: 'tui' } })
  const open = task('d-20261109-ffffff', { state: 'running' })
  const all = [today, lateUtc, yesterday, rated, terminal, open]
  expect(pickRatingTask(all, '2026-11-09', () => 0, TZ)?.id).toBe('d-20261109-aaaaaa')
  expect(pickRatingTask(all, '2026-11-09', () => 0.99, TZ)?.id).toBe('d-20261109-bbbbbb')
  expect(pickRatingTask(all, '2026-11-08', () => 0.5, TZ)?.id).toBe('d-20261108-cccccc')
  expect(pickRatingTask(all, '2026-11-07', () => 0.5, TZ)).toBeNull()
})

test('the invitation replies to the completion notice the task log names', () => {
  const long = task('l-20261109-aaaaaa', { kind: 'long', telegram: { chatId: '7051661301' } })
  const log = [
    { at: 1, session: 's', type: 'created', kind: 'long', state: 'starting' },
    { at: 2, session: 's', type: 'notify', kind: 'decision', messageId: 1200 },
    { at: 3, session: 's', type: 'notify', kind: 'done', messageId: 1201 },
    { at: 4, session: 's', type: 'telegram', messageId: 1202, replyTo: 1190, reason: 'answer', targets: 1 },
  ].map(x => JSON.stringify(x)).join('\n') + '\n'
  expect(completionMessageId(log, long)).toBe(1201)
  const daily = task('d-20261109-aaaaaa')
  const dailyLog = [
    { at: 1, session: 's', type: 'telegram', chatId: '7051661301', messageId: 960, kind: 'magpie' },
    { at: 2, session: 's', type: 'telegram', chatId: '7051661301', messageId: 975, kind: 'magpie' },
  ].map(x => JSON.stringify(x)).join('\n')
  expect(completionMessageId(dailyLog, daily)).toBe(975)
  expect(completionMessageId('', daily)).toBe(953)
  expect(completionMessageId('', long)).toBeUndefined()
})

// Three daily tasks under code-change whose executor was raised once for failed acceptance.
function reworked(id: string, at: number): TaskRecord {
  return task(id, { agents: { a1: agent('a1', { efforts: [{ at: at - DAY, from: null, to: 'xhigh', reason: 'rule' }, { at, from: 'xhigh', to: 'max', reason: 'acceptance-failed' }] }) } })
}

test('a problem becomes evidence at three tasks of one rule within 14 days', () => {
  const two = [reworked('d-20261101-aaaaaa', NOW - 5 * DAY), reworked('d-20261102-bbbbbb', NOW - 4 * DAY)]
  expect(calibrationFindings(two, NOW)).toEqual([])
  const three = [...two, reworked('d-20261103-cccccc', NOW - 3 * DAY)]
  expect(calibrationFindings(three, NOW)).toEqual([{ ruleId: 'code-change', kind: 'rework', taskIds: ['d-20261101-aaaaaa', 'd-20261102-bbbbbb', 'd-20261103-cccccc'] }])
  // One of them falls outside the window: two left.
  const old = [...two, reworked('d-20261020-cccccc', NOW - 15 * DAY)]
  expect(calibrationFindings(old, NOW)).toEqual([])
  // A pending raise counts by the task's last change.
  const pending = [...two, task('d-20261103-dddddd', { updatedAt: NOW - DAY, agents: { a1: agent('a1', { pendingRaises: ['acceptance-failed'] }) } })]
  expect(calibrationFindings(pending, NOW).map(f => f.kind)).toEqual(['rework'])
})

test('the invitation carries buttons 1–5 and 跳过; the digit a button press forwards is read as the score', () => {
  expect(ratingInvitation('整理 greet')).toBe('可以给「整理 greet」打个分吗？点下面的分数，或回复 1–5；不想评就点“跳过”。')
  expect(RATING_BUTTONS.flat().map(b => [b.text, b.data])).toEqual([['1', 'rate:1'], ['2', 'rate:2'], ['3', 'rate:3'], ['4', 'rate:4'], ['5', 'rate:5'], ['跳过', 'rate:skip']])
  // The channel server forwards a press of `rate:<n>` as the bare digit in reply to the invitation.
  for (const b of RATING_BUTTONS[0]!) expect(parseRating(b.data.slice('rate:'.length), 'rating')).toBe(Number(b.text))
})

test('scores of 2 or lower and unsuitable feedback count for every routed worker rule of the task', () => {
  const low = (id: string, score: number) => task(id, {
    agents: { a1: agent('a1'), a2: agent('a2', { role: 'acceptance', ruleId: 'review' }), a3: agent('a3', { ruleId: 'terminal-work' }) },
    ratings: [{ at: NOW - DAY, score, raw: `评分 ${score}`, invited: false }],
  })
  const f = calibrationFindings([low('d-20261108-aaaaaa', 2), low('d-20261108-bbbbbb', 1), low('d-20261108-cccccc', 2), low('d-20261108-dddddd', 3)], NOW)
  expect(f).toEqual([
    { ruleId: 'code-change', kind: 'low-rating', taskIds: ['d-20261108-aaaaaa', 'd-20261108-bbbbbb', 'd-20261108-cccccc'] },
    { ruleId: 'terminal-work', kind: 'low-rating', taskIds: ['d-20261108-aaaaaa', 'd-20261108-bbbbbb', 'd-20261108-cccccc'] },
  ])
  const unsuitable = (id: string, yes: boolean | null) => task(id, { feedback: [{ at: NOW - DAY, source: 'telegram', text: '不对，结果没改到点上', unsuitable: yes, modelOpinion: false }] })
  expect(calibrationFindings([unsuitable('d-1', true), unsuitable('d-2', true), unsuitable('d-3', null)].map((t, i) => ({ ...t, id: `d-2026110${i}-aaaaaa` })), NOW)).toEqual([])
  expect(calibrationFindings([unsuitable('d-20261101-aaaaaa', true), unsuitable('d-20261102-aaaaaa', true), unsuitable('d-20261103-aaaaaa', true)], NOW))
    .toEqual([{ ruleId: 'code-change', kind: 'unsuitable', taskIds: ['d-20261101-aaaaaa', 'd-20261102-aaaaaa', 'd-20261103-aaaaaa'] }])
})

// A daily task whose code-change executor was blocked, diagnosed and replaced by Astra after the
// diagnosis; the replacement finished and passed acceptance when `passed`.
function replaced(id: string, passed: boolean): TaskRecord {
  const at = NOW - 2 * DAY
  return task(id, {
    agents: {
      a1: agent('a1', { replacedBy: 'a3', reports: [{ at, status: 'blocked', text: '状态：受阻：pnpm install 失败', verification: [] }] }),
      a2: agent('a2', { role: 'diagnosis', ruleId: 'review', effort: 'medium', startedAt: at + 1000 }),
      a3: agent('a3', { model: 'codex/gpt-6-astra', selection: { kind: 'diagnosis', reason: '诊断 a2 建议：更换模型 codex/gpt-6-astra / xhigh' }, startedAt: at + 2000, reports: [{ at: at + 5000, status: 'done', text: '状态：已完成', verification: ['pnpm test: 12 passed'] }] }),
      a4: agent('a4', { role: 'acceptance', ruleId: 'review', effort: 'medium', startedAt: at + 6000 }),
    },
    blockers: { b1: { id: 'b1', description: 'pnpm install 失败', diagnoses: 1, modelChanges: 1, history: [
      { at: at + 500, step: 'diagnosis', agentId: 'a1', note: 'blocked report: pnpm install 失败', match: { provider: 'jev', confidence: 0.9 } },
      { at: at + 2000, step: 'model-change', agentId: 'a2', note: 'claude/claude-opus-5-5/xhigh → codex/gpt-6-astra/max (substitute repo-alt)' },
    ] } },
    deliverables: [{ at: at + 5000, summary: '状态：已完成', verification: ['pnpm test: 12 passed'], acceptance: { agentId: 'a4', pass: passed, notes: passed ? '通过' : '不通过' } }],
  })
}

test('diagnoses, model changes and substitute successes are counted per rule of the replaced worker', () => {
  const ids = ['d-20261107-aaaaaa', 'd-20261107-bbbbbb', 'd-20261107-cccccc']
  expect(calibrationFindings(ids.map(id => replaced(id, true)), NOW)).toEqual([
    { ruleId: 'code-change', kind: 'diagnosis', taskIds: ids },
    { ruleId: 'code-change', kind: 'model-change', taskIds: ids },
    { ruleId: 'code-change', kind: 'substitute-success', taskIds: ids },
  ])
  // Failed acceptance: the substitute did not succeed.
  expect(calibrationFindings(ids.map(id => replaced(id, false)), NOW).map(f => f.kind)).toEqual(['diagnosis', 'model-change'])
  // A hand-over because the model was unavailable is not a model change for calibration.
  const unavailable = ids.map(id => {
    const t = replaced(id, true)
    t.blockers = {}
    t.agents['a1']!.failure = { at: NOW - 2 * DAY, kind: 'model-unavailable', error: 'rate_limit' }
    t.agents['a3']!.selection = { kind: 'unavailable-substitute', reason: 'claude/claude-opus-5-5 unavailable (rate_limit)' }
    return t
  })
  expect(calibrationFindings(unavailable, NOW)).toEqual([])
})

test('a long task: the architect reports a model change, and a later worker on another model is accepted', () => {
  const at = NOW - 3 * DAY
  const long = (id: string): TaskRecord => task(id, {
    kind: 'long',
    owner: { kind: 'session', sessionId: '455258f7-73cb-4580-a3fb-e7a7cece7995', previousSessionIds: [], model: 'claude/claude-opus-5-5', contextMemoryFingerprint: 'c0ffee00c0ffee00' },
    agents: {
      i1: agent('i1', { role: 'implementer', ruleId: 'science-compute', model: 'codex/gpt-6-astra', effort: 'high', startedAt: at }),
      i2: agent('i2', { role: 'implementer', ruleId: 'science-compute', model: 'codex/gpt-6.1-sol', effort: 'high', selection: { kind: 'adjusted', reason: 'Astra 两次数值发散' }, startedAt: at + 4000, reports: [{ at: at + 9000, status: 'done', text: '状态：已完成', verification: [] }] }),
    },
    blockers: { b1: { id: 'b1', description: '数值发散', diagnoses: 0, modelChanges: 1, history: [{ at: at + 3000, step: 'model-change', agentId: 'i1', note: '换 Sol 6.1', match: { provider: 'architect', confidence: null } }] } },
    deliverables: [{ at: at + 10000, summary: 'accepted the result of i2', verification: [] }],
  })
  const ids = ['l-20261106-aaaaaa', 'l-20261106-bbbbbb', 'l-20261106-cccccc']
  expect(calibrationFindings(ids.map(long), NOW)).toEqual([
    { ruleId: 'science-compute', kind: 'model-change', taskIds: ids },
    { ruleId: 'science-compute', kind: 'substitute-success', taskIds: ids },
  ])
})

test('model opinions are quoted once each, within the window; the reminder names rules, tasks and words', () => {
  const t = task('d-20261108-aaaaaa', { feedback: [
    { at: NOW - DAY, source: 'telegram', text: 'Sol 写这种证明比 Opus 靠谱', unsuitable: false, modelOpinion: true },
    { at: NOW - 20 * DAY, source: 'telegram', text: 'Haiku 太弱', unsuitable: false, modelOpinion: true },
    { at: NOW - DAY, source: 'window', text: '好的', unsuitable: false, modelOpinion: false },
  ] })
  const opinions = modelOpinions([t], NOW)
  expect(opinions.map(o => o.text)).toEqual(['Sol 写这种证明比 Opus 靠谱'])
  const ids = ['d-20261101-aaaaaa', 'd-20261102-bbbbbb', 'd-20261103-cccccc']
  const tasks = ids.map((id, i) => reworked(id, NOW - (5 - i) * DAY))
  const text = reminderText(calibrationFindings(tasks, NOW), opinions, [...tasks, t], rules, { findings: [], stats: [] })
  expect(text).toContain('规则 code-change：验收不通过后返工，3 个任务：「任务 d-20261101-aaaaaa」（d-20261101-aaaaaa）')
  expect(text).toContain('检查这条规则的模型或起始强度')
  expect(text).toContain('“Sol 写这种证明比 Opus 靠谱”')
})

test('Jev\'s deep probability falls in three bands; an agent started at its effort before the first raise', () => {
  const T = rules.thresholds
  expect([bandOf(0.5, T), bandOf(0.85, T), bandOf(0.94, T), bandOf(0.95, T), bandOf(null, T)]).toEqual(['below', 'deep', 'deep', 'hard', null])
  const at = NOW - DAY
  expect(startEffortOf(agent('a1', { effort: 'max', efforts: [{ at, from: null, to: 'medium', reason: 'rule' }, { at, from: 'medium', to: 'high', reason: 'deep' }, { at, from: 'high', to: 'max', reason: 'acceptance-failed' }] }))).toBe('high')
  // A takeover after a diagnosis: the suggested effort, then the raise.
  expect(startEffortOf(agent('a1', { effort: 'xhigh', efforts: [{ at, from: null, to: 'high', reason: 'explicit', note: 'diagnosis suggestion' }, { at, from: 'high', to: 'xhigh', reason: 'diagnosis-redelegate' }] }))).toBe('high')
  expect(startEffortOf(agent('a1', { effort: 'low', efforts: [] }))).toBe('low')
})

// A code-change worker of the current rules, judged at `deepP`, on `model` from high.
function coder(id: string, deepP: number, model: string, raised: boolean, at = NOW - 3 * DAY): TaskRecord {
  const efforts: AgentRecord['efforts'] = [{ at, from: null, to: 'high', reason: 'rule' }]
  if (raised) efforts.push({ at: at + 3600_000, from: 'high', to: 'xhigh', reason: 'acceptance-failed' })
  return task(id, { agents: { a1: agent('a1', { rulesVersion: rules.version, judgment: judgedAt(deepP), model, effort: raised ? 'xhigh' : 'high', efforts, startedAt: at }) } })
}

test('three tasks of one band, model and start that needed a raise make a low start; the reminder lists every cell', () => {
  const OPUS = 'claude/claude-opus-5-5', MYTHOS = 'claude/claude-mythos-5-2'
  const deepRaised = ['d-20261101-aaaaaa', 'd-20261102-bbbbbb', 'd-20261103-cccccc'].map(id => coder(id, 0.9, OPUS, true))
  const others = [coder('d-20261104-dddddd', 0.97, MYTHOS, false), coder('d-20261105-eeeeee', 0.3, OPUS, false), coder('d-20261020-ffffff', 0.9, OPUS, true, NOW - 20 * DAY)]
  const stats = bandStats([...deepRaised, ...others], NOW, rules)
  expect(stats.map(c => [c.ruleId, c.band, c.model, c.start, c.taskIds.length, c.raised.length, c.changed.length])).toEqual([
    ['code-change', 'below', OPUS, 'high', 1, 0, 0],
    ['code-change', 'deep', OPUS, 'high', 3, 3, 0],
    ['code-change', 'hard', MYTHOS, 'high', 1, 0, 0],
  ])
  const low = bandFindings(stats)
  expect(low.map(c => [c.band, c.model])).toEqual([['deep', OPUS]])
  expect(bandFindings(bandStats([...deepRaised.slice(0, 2), ...others], NOW, rules))).toEqual([])
  const text = reminderText([], [], [...deepRaised, ...others], rules, { findings: low, stats })
  expect(text).toContain('· 规则 code-change（深入推理概率 0.85–0.95、Opus 5.5、起步 high）：3 个任务中 3 个需要提高强度或换模型：「任务 d-20261101-aaaaaa」（d-20261101-aaaaaa）')
  expect(text).toContain('建议：考虑把交给 Mythos 5.2 的门槛 hardYes（现在 0.95）往下调，由你确认。')
  expect(text).toContain('· code-change，深入推理概率 0.95 以上、Mythos 5.2、起步 high：1 个任务，提高 0，换模型 0')
  expect(text).toContain('· code-change，深入推理概率低于 0.85、Opus 5.5、起步 high：1 个任务，提高 0，换模型 0')
})

test('the invitation picks a task whose setting is under review first: code-change on Opus 5.5, or deep work with its start held at high', () => {
  const done = Date.parse('2026-11-09T01:00:00Z')
  const onOpus = { ...coder('d-20261109-aaaaaa', 0.3, 'claude/claude-opus-5-5', false), completedAt: done }
  const review = task('d-20261109-bbbbbb', { completedAt: done, agents: { a1: agent('a1', { ruleId: 'review', rulesVersion: rules.version, judgment: judgedAt(0.9), model: 'claude/claude-opus-5-5' }) } })
  expect(ratingFirst(onOpus, rules)).toBe(true)
  expect(ratingFirst(review, rules)).toBe(false)
  expect(pickRatingTask([onOpus, review], '2026-11-09', () => 0.99, TZ, t => ratingFirst(t, rules))?.id).toBe('d-20261109-aaaaaa')
  // Without such a task the pick is among all of the day's tasks.
  expect(pickRatingTask([review], '2026-11-09', () => 0.99, TZ, t => ratingFirst(t, rules))?.id).toBe('d-20261109-bbbbbb')
  // design-advice counts only when judged deep; a worker of an earlier rules version does not count.
  const design = (deepP: number, version = rules.version) => task('d-20261109-cccccc', { agents: { a1: agent('a1', { ruleId: 'design-advice', rulesVersion: version, judgment: judgedAt(deepP), model: 'claude/claude-mythos-5-2' }) } })
  expect([ratingFirst(design(0.9), rules), ratingFirst(design(0.5), rules), ratingFirst(design(0.9, 'routing-rules.v4'), rules)]).toEqual([true, false, false])
})

test('a worker replaced by another model after a blocker counts in its cell; the takeover and recommended models stay out', () => {
  const OPUS = 'claude/claude-opus-5-5', MYTHOS = 'claude/claude-mythos-5-2'
  const at = NOW - 3 * DAY
  const replaced = (id: string): TaskRecord => {
    const t = coder(id, 0.9, OPUS, false)
    const original = { ...t.agents['a1']!, replacedBy: 'a2' }
    // The takeover handOver starts after a diagnosis: no judgment of its own, selection 'diagnosis'.
    const takeover = agent('a2', { rulesVersion: rules.version, selection: { kind: 'diagnosis', reason: '诊断 a3 建议：更换模型' }, model: MYTHOS, effort: 'xhigh', startedAt: at + 7200_000,
      efforts: [{ at: at + 7200_000, from: null, to: 'high', reason: 'explicit', note: 'diagnosis suggestion' }, { at: at + 7200_000, from: 'high', to: 'xhigh', reason: 'diagnosis-redelegate' }] })
    return { ...t, agents: { a1: original, a2: takeover } }
  }
  const recommended = task('d-20261106-gggggg', { agents: { a1: agent('a1', { rulesVersion: rules.version, judgment: judgedAt(0.9), selection: { kind: 'adjusted', reason: 'model_route' }, model: 'codex/gpt-6-astra', startedAt: at }) } })
  const tasks = [...['d-20261101-aaaaaa', 'd-20261102-bbbbbb', 'd-20261103-cccccc'].map(replaced), recommended]
  const stats = bandStats(tasks, NOW, rules)
  expect(stats.map(c => [c.band, c.model, c.start, c.taskIds.length, c.raised.length, c.changed.length])).toEqual([['deep', OPUS, 'high', 3, 0, 3]])
  const text = reminderText([], [], tasks, rules, { findings: bandFindings(stats), stats })
  expect(text).toContain('3 个任务中 3 个需要提高强度或换模型')
  expect(text).toContain('hardYes（现在 0.95）往下调')
  // The cell list comes after the closing line, so clipping a long reminder drops cells, not findings.
  expect(text.indexOf('需要调整时告诉我')).toBeLessThan(text.indexOf('各段起步与提高次数'))
})
