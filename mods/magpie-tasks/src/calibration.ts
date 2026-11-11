// Rating invitations and calibration reminders (plan section 9.14). The Router's 15-minute timer
// calls `tick`: at most one invitation a day, sent at `ratingHour` local time under one task that was
// completed that day; and every 14 days a look at the last 14 days of records for evidence that a
// routing rule needs a calibration discussion. Scores reach the plugin as replies (router.ts).
import { displayName } from './model'
import { ruleById, type Rules } from './rules'
import type { Ctx } from './state'
import { defaultChat, RATING_BUTTONS, send } from './telegram'
import type { AgentRecord, Effort, TaskRecord } from './types'

const DAY_MS = 24 * 3600_000
const WINDOW_MS = 14 * DAY_MS
const CHECK_EVERY_MS = 14 * DAY_MS
// A rule's problem counts as evidence when this many tasks show it, or a substitute model succeeds this often.
const MIN_EVIDENCE = 3
const LOW_SCORE = 2

export type FindingKind = 'rework' | 'diagnosis' | 'model-change' | 'low-rating' | 'unsuitable' | 'substitute-success'
const KINDS: readonly FindingKind[] = ['rework', 'diagnosis', 'model-change', 'low-rating', 'unsuitable', 'substitute-success']

interface RatingState { lastInviteDay?: string; invites: { day: string; taskId: string; chatId: string; messageId: number; at: number }[] }
interface CalibrationState { lastCheckAt?: number; reminded: string[] }

// ---- local time --------------------------------------------------------------------------------

// The local date (YYYY-MM-DD) and hour (0–23) of `now` in the time zone `tz`.
export function localTime(now: number, tz: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now))
  const get = (type: string) => {
    const p = parts.find(x => x.type === type)
    if (p === undefined) throw new Error(`localTime: no ${type} for ${tz}`)
    return p.value
  }
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}

// Whether an invitation is due: the local hour has reached `hour` and none went out today.
export function ratingDue(state: { lastInviteDay?: string }, now: number, tz: string, hour: number): boolean {
  const local = localTime(now, tz)
  return local.hour >= hour && state.lastInviteDay !== local.day
}

// One task completed on `day` (local date in `tz`) with a Telegram chat and no score yet, picked by
// `rand` among those `first` accepts when there are any, else among all; null when there is none.
export function pickRatingTask(tasks: TaskRecord[], day: string, rand: () => number, tz: string, first: (t: TaskRecord) => boolean = () => false): TaskRecord | null {
  const all = tasks.filter(t =>
    t.completedAt !== undefined
    && localTime(t.completedAt, tz).day === day
    && t.telegram !== null && t.telegram.chatId !== 'tui'
    && t.ratings.length === 0)
  const preferred = all.filter(first)
  const candidates = preferred.length > 0 ? preferred : all
  if (candidates.length === 0) return null
  return candidates[Math.min(candidates.length - 1, Math.floor(rand() * candidates.length))]!
}

// Whether a worker of the task ran on a setting of the current rules whose results on the person's
// own tasks are not measured yet (rules.ratingPriority): the rule's base model, work judged deep, or a
// model drawn for work on a rule border (rules.ambiguous), whose scores compare the drawn models.
export function ratingFirst(t: TaskRecord, rules: Rules): boolean {
  return Object.values(t.agents).some(a => a.rulesVersion === rules.version && (
    (a.selection.kind === 'ambiguous' && (a.role === 'executor' || a.role === 'implementer'))
    || (a.ruleId !== null && isWorker(a) && rules.ratingPriority.cells.some(c => c.rule === a.ruleId
      && (c.when === 'deep' ? a.judgment?.deep === true : a.model === ruleById(rules, c.rule).model)))))
}

// ---- scores ------------------------------------------------------------------------------------

const FULL_WIDTH_DIGIT = /[０-９]/g

function normalized(text: string): string {
  return text.replace(FULL_WIDTH_DIGIT, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).trim()
}

// The score in a reply: `评分 N` in reply to any message of a task, or a bare 1–5 in reply to an
// invitation (`replyKind` 'rating'). Null when the text is not a score.
export function parseRating(text: string, replyKind: string | undefined): number | null {
  const s = normalized(text)
  const named = /^评分\s*[:：]?\s*([1-5])\s*分?\s*[。.!！]?$/.exec(s)
  if (named) return Number(named[1])
  if (replyKind === 'rating') {
    const bare = /^([1-5])\s*分?\s*[。.!！]?$/.exec(s)
    if (bare) return Number(bare[1])
  }
  return null
}

// ---- calibration evidence ----------------------------------------------------------------------

function isWorker(a: AgentRecord): boolean {
  return (a.role === 'executor' || a.role === 'implementer') && a.ruleId !== null
}

// The rule-routed workers of a task, for evidence about the task as a whole (a score, feedback).
function workerRules(t: TaskRecord): string[] {
  return [...new Set(Object.values(t.agents).filter(isWorker).map(a => a.ruleId!))]
}

// When agent `y` finished work its task accepted: a 'done' report followed by an accepted deliverable
// or the task's completion. A daily deliverable is accepted once its acceptance check passed; a long
// task's deliverables are the architect's accepted outcomes and integrations. Null otherwise.
function succeededAt(t: TaskRecord, y: AgentRecord): number | null {
  const done = y.reports.filter(r => r.status === 'done').map(r => r.at)
  if (done.length === 0) return null
  const first = Math.min(...done)
  const accepted = t.deliverables
    .filter(d => d.at >= first && (t.kind === 'daily' ? d.acceptance?.pass === true : d.acceptance?.pass !== false))
    .map(d => d.at)
  if (t.completedAt !== undefined && t.completedAt >= first) accepted.push(t.completedAt)
  return accepted.length === 0 ? null : Math.min(...accepted)
}

// Section 9.14's evidence over the 14 days before `now`, per routing rule: the problem kinds once at
// least three tasks show them, and substitute successes once a substitute model finished, at least
// three times, work the rule's model had not finished.
//   rework        a worker's effort was raised for failed acceptance (or that raise is pending)
//   diagnosis     a blocker of a worker was diagnosed, or a worker was re-delegated after diagnosis
//   model-change  a worker was replaced by another model after a blocker (not for unavailability),
//                 or the architect reported a model change for it
//   low-rating    the task was scored 2 or lower
//   unsuitable    the person said the result does not suit them or is wrong
// An event belongs to the rule of the worker it concerns; a score or feedback to every rule-routed
// worker of its task.
export function calibrationFindings(tasks: TaskRecord[], now: number): { ruleId: string; kind: FindingKind; taskIds: string[] }[] {
  const from = now - WINDOW_MS
  const inWindow = (at: number) => at >= from && at <= now
  const hits = new Map<string, { ruleId: string; kind: FindingKind; taskIds: string[]; count: number }>()
  const hit = (ruleId: string, kind: FindingKind, taskId: string) => {
    const key = `${ruleId}\u0000${kind}`
    const h = hits.get(key) ?? { ruleId, kind, taskIds: [], count: 0 }
    h.count++
    if (!h.taskIds.includes(taskId)) h.taskIds.push(taskId)
    hits.set(key, h)
  }

  for (const t of tasks) {
    const agents = Object.values(t.agents)
    for (const a of agents.filter(isWorker)) {
      const rule = a.ruleId!
      const raised = (reason: 'acceptance-failed' | 'diagnosis-redelegate') =>
        a.efforts.some(e => e.reason === reason && inWindow(e.at)) || (a.pendingRaises.includes(reason) && inWindow(t.updatedAt))
      if (raised('acceptance-failed')) hit(rule, 'rework', t.id)
      if (raised('diagnosis-redelegate')) hit(rule, 'diagnosis', t.id)
      const next = a.replacedBy !== undefined ? t.agents[a.replacedBy] : undefined
      if (next !== undefined && a.failure?.kind !== 'model-unavailable' && next.selection.kind !== 'unavailable-substitute') {
        if (inWindow(next.startedAt)) hit(rule, 'model-change', t.id)
        const ok = succeededAt(t, next)
        if (ok !== null && inWindow(ok)) hit(rule, 'substitute-success', t.id)
      }
    }
    for (const b of Object.values(t.blockers)) {
      for (const h of b.history) {
        const a = t.agents[h.agentId]
        if (a === undefined || !isWorker(a) || !inWindow(h.at)) continue
        if (h.step === 'diagnosis') hit(a.ruleId!, 'diagnosis', t.id)
        if (h.step !== 'model-change' || a.replacedBy !== undefined) continue
        // The architect reported the change and delegated anew: the first later worker on another model.
        hit(a.ruleId!, 'model-change', t.id)
        const next = agents
          .filter(y => y.agentId !== a.agentId && (y.role === 'executor' || y.role === 'implementer') && y.startedAt >= h.at && y.model !== a.model)
          .sort((x, y) => x.startedAt - y.startedAt)[0]
        const ok = next === undefined ? null : succeededAt(t, next)
        if (ok !== null && inWindow(ok)) hit(a.ruleId!, 'substitute-success', t.id)
      }
    }
    const rules = workerRules(t)
    if (t.ratings.some(r => r.score <= LOW_SCORE && inWindow(r.at))) for (const rule of rules) hit(rule, 'low-rating', t.id)
    if (t.feedback.some(f => f.unsuitable === true && inWindow(f.at))) for (const rule of rules) hit(rule, 'unsuitable', t.id)
  }

  return [...hits.values()]
    .filter(h => (h.kind === 'substitute-success' ? h.count : h.taskIds.length) >= MIN_EVIDENCE)
    .sort((x, y) => x.ruleId.localeCompare(y.ruleId) || KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind))
    .map(h => ({ ruleId: h.ruleId, kind: h.kind, taskIds: h.taskIds }))
}

// ---- bands of Jev's deep probability ---------------------------------------------------------------

// Section 9.14: below deepYes the rule's start effort, from deepYes its deep start, from hardYes the
// largest work (code-change's Mythos 5.2). A substitute judgment has no probability and no band.
export type Band = 'below' | 'deep' | 'hard'
export function bandOf(deepP: number | null, t: { deepYes: number; hardYes: number }): Band | null {
  if (deepP === null) return null
  return deepP >= t.hardYes ? 'hard' : deepP >= t.deepYes ? 'deep' : 'below'
}

// The effort an agent started at: its last start change (rule, deep, explicit) before the first raise.
const RAISES = new Set(['resume-deep', 'acceptance-failed', 'diagnosis-redelegate'])
export function startEffortOf(a: AgentRecord): Effort {
  const first = a.efforts.findIndex(e => RAISES.has(e.reason))
  const starts = first === -1 ? a.efforts : a.efforts.slice(0, first)
  return starts.at(-1)?.to ?? a.effort
}

// One cell: the workers a rule chose (selection 'rule', so takeovers and recommended or person-chosen
// models stay out) of one rule, band, model and start effort that started within the 14 days before
// `now`; `raised` had their effort raised for failed acceptance or after a diagnosis, `changed` were
// replaced by another model after a blocker (not for unavailability).
export interface BandStat { ruleId: string; band: Band; model: string; start: Effort; taskIds: string[]; raised: string[]; changed: string[] }

export function bandStats(tasks: TaskRecord[], now: number, rules: Rules): BandStat[] {
  const from = now - WINDOW_MS
  const inWindow = (at: number) => at >= from && at <= now
  const cells = new Map<string, BandStat>()
  const add = (list: string[], id: string) => { if (!list.includes(id)) list.push(id) }
  for (const t of tasks) {
    for (const a of Object.values(t.agents).filter(isWorker)) {
      if (a.selection.kind !== 'rule') continue
      const band = a.judgment === null ? null : bandOf(a.judgment.deepP, rules.thresholds)
      if (band === null || !inWindow(a.startedAt)) continue
      const start = startEffortOf(a)
      const key = [a.ruleId, band, a.model, start].join('\u0000')
      const c = cells.get(key) ?? { ruleId: a.ruleId!, band, model: a.model, start, taskIds: [], raised: [], changed: [] }
      add(c.taskIds, t.id)
      const failed = (r: string) => r === 'acceptance-failed' || r === 'diagnosis-redelegate'
      if (a.efforts.some(e => failed(e.reason)) || a.pendingRaises.some(failed)) add(c.raised, t.id)
      const next = a.replacedBy !== undefined ? t.agents[a.replacedBy] : undefined
      const replaced = next !== undefined && a.failure?.kind !== 'model-unavailable' && next.selection.kind !== 'unavailable-substitute'
      const reported = Object.values(t.blockers).some(b => b.history.some(h => h.step === 'model-change' && h.agentId === a.agentId))
      if (replaced || reported) add(c.changed, t.id)
      cells.set(key, c)
    }
  }
  const bandOrder: Band[] = ['below', 'deep', 'hard']
  const ruleOrder = rules.rules.map(r => r.id)
  return [...cells.values()].sort((x, y) => ruleOrder.indexOf(x.ruleId) - ruleOrder.indexOf(y.ruleId) || bandOrder.indexOf(x.band) - bandOrder.indexOf(y.band) || x.model.localeCompare(y.model) || x.start.localeCompare(y.start))
}

// Cells where at least MIN_EVIDENCE tasks needed a raise or another model: their start looks too low.
export function bandFindings(stats: BandStat[]): BandStat[] {
  return stats.filter(c => new Set([...c.raised, ...c.changed]).size >= MIN_EVIDENCE)
}

export function bandKey(c: BandStat): string {
  return `band:${c.ruleId}:${c.band}:${c.model}:${c.start}:${[...new Set([...c.raised, ...c.changed])].sort().join(',')}`
}

function bandText(band: Band, t: { deepYes: number; hardYes: number }): string {
  return band === 'below' ? `深入推理概率低于 ${t.deepYes}` : band === 'deep' ? `深入推理概率 ${t.deepYes}–${t.hardYes}` : `深入推理概率 ${t.hardYes} 以上`
}

// ---- work on rule borders ----------------------------------------------------------------------

// Section 6 of the table: the agents whose model was drawn for work on a rule border, per model the
// current rules draw from, over every task on record (the comparison builds up across checks): the
// tasks, the last score of each scored task, the tasks whose agent was raised after a failed
// acceptance or a diagnosis, and those whose agent was replaced by another model after a blocker.
export interface BorderStat { model: string; effort: Effort; taskIds: string[]; scores: number[]; raised: string[]; changed: string[] }

export function borderStats(tasks: TaskRecord[], rules: Rules): BorderStat[] {
  const stats: BorderStat[] = rules.ambiguous.candidates.map(c => ({ model: c.model, effort: c.effort, taskIds: [], scores: [], raised: [], changed: [] }))
  const add = (list: string[], id: string) => { if (!list.includes(id)) list.push(id) }
  for (const t of tasks) {
    for (const a of Object.values(t.agents)) {
      if (a.selection.kind !== 'ambiguous') continue
      const s = stats.find(x => x.model === a.model)
      if (s === undefined) continue
      if (!s.taskIds.includes(t.id)) {
        s.taskIds.push(t.id)
        const last = t.ratings.at(-1)
        if (last !== undefined) s.scores.push(last.score)
      }
      const failed = (r: string) => r === 'acceptance-failed' || r === 'diagnosis-redelegate'
      if (a.efforts.some(e => failed(e.reason)) || a.pendingRaises.some(failed)) add(s.raised, t.id)
      const next = a.replacedBy !== undefined ? t.agents[a.replacedBy] : undefined
      const replaced = next !== undefined && a.failure?.kind !== 'model-unavailable' && next.selection.kind !== 'unavailable-substitute'
      const reported = Object.values(t.blockers).some(b => b.history.some(h => h.step === 'model-change' && h.agentId === a.agentId))
      if (replaced || reported) add(s.changed, t.id)
    }
  }
  return stats
}

// The comparison is worth a reminder once every drawn model has MIN_EVIDENCE scored tasks; the key
// changes with every new score, so each later check with new scores reminds again.
export function borderReady(stats: BorderStat[]): boolean {
  return stats.length > 0 && stats.every(s => s.scores.length >= MIN_EVIDENCE)
}

export function borderKey(stats: BorderStat[]): string {
  return `border:${stats.map(s => `${s.model}=${s.scores.length}`).join(',')}`
}

// The person's own words that judge how a model suits a kind of work, from the last 14 days.
export function modelOpinions(tasks: TaskRecord[], now: number): { taskId: string; title: string; at: number; text: string }[] {
  const out: { taskId: string; title: string; at: number; text: string }[] = []
  for (const t of tasks) {
    for (const f of t.feedback) if (f.modelOpinion === true && f.at >= now - WINDOW_MS && f.at <= now) out.push({ taskId: t.id, title: t.title, at: f.at, text: f.text })
  }
  return out.sort((a, b) => a.at - b.at)
}

const KIND_TEXT: Record<FindingKind, string> = {
  'rework': '验收不通过后返工',
  'diagnosis': '受阻后需要诊断',
  'model-change': '受阻后更换了模型',
  'low-rating': '评分不高于 2',
  'unsuitable': '反馈结果不合适或有错',
  'substitute-success': '替代模型完成了原模型没有完成的工作',
}

export function findingKey(f: { ruleId: string; kind: FindingKind; taskIds: string[] }): string {
  return `${f.ruleId}:${f.kind}:${[...f.taskIds].sort().join(',')}`
}

export function opinionKey(o: { taskId: string; at: number }): string {
  return `opinion:${o.taskId}:${o.at}`
}

// The reminder the person reads on Telegram: findings per rule, cells whose start looks too low, the
// person's words about models, then every cell of the window with its counts.
export function reminderText(findings: { ruleId: string; kind: FindingKind; taskIds: string[] }[], opinions: { taskId: string; title: string; text: string }[], tasks: TaskRecord[], rules: Rules, bands: { findings: BandStat[]; stats: BandStat[] }, border: BorderStat[]): string {
  const title = (id: string) => `「${tasks.find(t => t.id === id)?.title ?? id}」（${id}）`
  const cell = (c: BandStat) => `${bandText(c.band, rules.thresholds)}、${displayName(c.model, rules)}、起步 ${c.start}`
  const lines = [`路由校准提醒（最近 14 天，规则版本 ${rules.version}）：`]
  for (const f of findings) {
    lines.push(`· 规则 ${f.ruleId}：${KIND_TEXT[f.kind]}，${f.taskIds.length} 个任务：${f.taskIds.map(title).join('、')}`)
    lines.push(f.kind === 'substitute-success'
      ? '  建议：在校准讨论中考虑把替代模型用于这条规则，由你确认。'
      : '  建议：检查这条规则的模型或起始强度，在校准讨论中由你确认。')
  }
  for (const c of bands.findings) {
    const hit = [...new Set([...c.raised, ...c.changed])]
    lines.push(`· 规则 ${c.ruleId}（${cell(c)}）：${c.taskIds.length} 个任务中 ${hit.length} 个需要提高强度或换模型：${hit.map(title).join('、')}`)
    const rule = ruleById(rules, c.ruleId)
    lines.push(rule.hardModel !== null && c.model === rule.model && c.band === 'deep'
      ? `  建议：考虑把交给 ${displayName(rule.hardModel, rules)} 的门槛 hardYes（现在 ${rules.thresholds.hardYes}）往下调，由你确认。`
      : '  建议：考虑把这一段的起步提高一档，由你确认。')
  }
  for (const o of opinions) lines.push(`· 你对模型的看法（${title(o.taskId)}）：“${o.text.trim()}”`)
  if (border.some(s => s.taskIds.length > 0)) {
    lines.push(`规则拿不准、随机分配的任务（累计${borderReady(border) ? `；每个模型都已有至少 ${MIN_EVIDENCE} 个评过分的任务，可以比较` : ''}）：`)
    for (const s of border) {
      const mean = s.scores.length === 0 ? '' : `，平均 ${(s.scores.reduce((x, y) => x + y, 0) / s.scores.length).toFixed(1)}`
      lines.push(`· ${displayName(s.model, rules)} · ${s.effort}：${s.taskIds.length} 个任务，评分 ${s.scores.length} 个${mean}，提高强度 ${s.raised.length}，换模型 ${s.changed.length}`)
    }
  }
  lines.push('需要调整时告诉我，我们一起过一遍证据再改规则。')
  // Last, so a reminder over Telegram's length limit loses cells of this list, not findings.
  if (bands.stats.length > 0) {
    lines.push('各段起步与提高次数（零次的也列出，起步可能偏高时供你判断）：')
    for (const c of bands.stats) lines.push(`· ${c.ruleId}，${cell(c)}：${c.taskIds.length} 个任务，提高 ${c.raised.length}，换模型 ${c.changed.length}`)
  }
  return lines.join('\n')
}

// ---- the timer ---------------------------------------------------------------------------------

// The message an invitation replies to: the task's completion notice when its log names one (the
// architect's notify_user done, else the last Telegram message about the task), else its first message.
export function completionMessageId(logText: string, task: TaskRecord): number | undefined {
  let notified: number | undefined
  let last: number | undefined
  for (const line of logText.split('\n')) {
    if (line.trim() === '') continue
    const entry = JSON.parse(line) as { type?: unknown; kind?: unknown; messageId?: unknown; chatId?: unknown }
    if (typeof entry.messageId !== 'number') continue
    if (entry.type === 'notify' && entry.kind === 'done') notified = entry.messageId
    if (entry.type === 'telegram' && (entry.chatId === undefined || entry.chatId === task.telegram?.chatId)) last = entry.messageId
  }
  return notified ?? last ?? task.telegram?.rootMessageId
}

export function ratingInvitation(title: string): string {
  return `可以给「${title}」打个分吗？点下面的分数，或回复 1–5；不想评就点“跳过”。`
}

async function inviteRating(ctx: Ctx): Promise<void> {
  const { io, reg, opts } = ctx
  const now = await io.now()
  const empty: RatingState = { invites: [] }
  if (!ratingDue(await reg.readState('rating', empty), now, opts.timezone, opts.ratingHour)) return
  const { day } = localTime(now, opts.timezone)
  const tasks = await reg.list()
  // The day is taken under the lock, so two Routers never both invite; the send happens outside it.
  const task = await reg.lock('schedule', async () => {
    const state = await reg.readState('rating', empty)
    if (!ratingDue(state, now, opts.timezone, opts.ratingHour)) return null
    const picked = pickRatingTask(tasks, day, Math.random, opts.timezone, t => ratingFirst(t, ctx.rules))
    if (picked === null) return null
    await reg.writeState('rating', { ...state, lastInviteDay: day })
    return picked
  })
  if (task === null) return
  const chatId = task.telegram!.chatId
  const logPath = `${opts.stateDir}/tasks/${task.id}.log.jsonl`
  const replyTo = completionMessageId((await io.exists(logPath)) ? await io.read(logPath) : '', task)
  let messageId: number
  try {
    messageId = await send(io, opts, chatId, ratingInvitation(task.title), replyTo, false, RATING_BUTTONS)
  } catch (err) {
    // The day stays open for the next tick.
    await reg.lock('schedule', async () => {
      const state = await reg.readState('rating', empty)
      if (state.lastInviteDay === day) await reg.writeState('rating', { invites: state.invites })
    })
    throw err
  }
  await reg.updateIndex(x => { x.messages[`${chatId}:${messageId}`] = { taskId: task.id, kind: 'rating' } })
  await reg.lock('schedule', async () => {
    const state = await reg.readState('rating', empty)
    await reg.writeState('rating', { ...state, invites: [...state.invites, { day, taskId: task.id, chatId, messageId, at: now }] })
  })
  await reg.log(task.id, { type: 'rating', stage: 'invite', chatId, messageId, replyTo: replyTo ?? null })
}

async function checkCalibration(ctx: Ctx): Promise<void> {
  const { io, reg, opts } = ctx
  const now = await io.now()
  const empty: CalibrationState = { reminded: [] }
  const due = (s: CalibrationState) => s.lastCheckAt === undefined || now - s.lastCheckAt >= CHECK_EVERY_MS
  if (!due(await reg.readState('calibration', empty))) return
  const previous = await reg.lock('schedule', async () => {
    const state = await reg.readState('calibration', empty)
    if (!due(state)) return null
    await reg.writeState('calibration', { ...state, lastCheckAt: now })
    return state
  })
  if (previous === null) return
  const tasks = await reg.list()
  const findings = calibrationFindings(tasks, now).filter(f => !previous.reminded.includes(findingKey(f)))
  const opinions = modelOpinions(tasks, now).filter(o => !previous.reminded.includes(opinionKey(o)))
  const stats = bandStats(tasks, now, ctx.rules)
  const lowStarts = bandFindings(stats).filter(c => !previous.reminded.includes(bandKey(c)))
  const border = borderStats(tasks, ctx.rules)
  const borderNew = borderReady(border) && !previous.reminded.includes(borderKey(border))
  if (findings.length === 0 && opinions.length === 0 && lowStarts.length === 0 && !borderNew) {
    await io.log(`calibration check at ${now}: no evidence for a reminder`)
    return
  }
  try {
    await send(io, opts, await defaultChat(io, opts), reminderText(findings, opinions, tasks, ctx.rules, { findings: lowStarts, stats }, border), undefined, true)
  } catch (err) {
    // The check runs again on the next tick.
    await reg.lock('schedule', async () => {
      const state = await reg.readState('calibration', empty)
      await reg.writeState('calibration', { reminded: state.reminded, ...(previous.lastCheckAt !== undefined ? { lastCheckAt: previous.lastCheckAt } : {}) })
    })
    throw err
  }
  await reg.lock('schedule', async () => {
    const state = await reg.readState('calibration', empty)
    await reg.writeState('calibration', { ...state, reminded: [...state.reminded, ...findings.map(findingKey), ...opinions.map(opinionKey), ...lowStarts.map(bandKey), ...(borderNew ? [borderKey(border)] : [])] })
  })
  await io.log(`calibration reminder sent: ${findings.length} findings, ${lowStarts.length} low starts, ${opinions.length} model opinions${borderNew ? ', border comparison' : ''}`)
}

// One run of the Router's timer: the day's rating invitation, then the two-weekly calibration check.
export async function tick(ctx: Ctx): Promise<void> {
  await inviteRating(ctx)
  await checkCalibration(ctx)
}
