import type { EngineInterface, Register } from 'claude-code'
import { applyPolicyConfig, modConfig, parseEnvFile, type ModConfig } from '../src/config'
import { stringifyResult, summarizeToolCall } from '../src/describe'
import { clampEffort, describeBounds, effortTag, isEffort, maxEffort, rank, type Effort } from '../src/effort'
import { followUpSummary, isHumanPrompt, previousPromptIndex, userText, type Message } from '../src/followup'
import { JevClient, JevFallback, type JevIo, type JevSource } from '../src/jev'
import { modelLabel } from '../src/model'
import { normalizeBounds, type Bounds } from '../src/policy'
import { EffortRouter, trajectoryLine, type FollowUpAsk } from '../src/router'
import type { EffortDecision, TaskProfile, ToolCallSummary } from '../src/types'

/**
 * Per-step Jev effort routing (port of jev-opus policy.v8 from its gateway
 * into function hooks). `prompt.submit` makes the task decision, with the
 * follow-up fault signal on a human prompt; `tool.call` classifies each
 * result into the loop's next tool batch; `turn.step` sets each model
 * request's effort: the task decision at step 0, routeStep on the batch since
 * the last step after that. Claude Code itself states each change as a
 * per-message effort, which keeps the prompt cache. Any failure leaves the
 * request as the engine made it. The band above the prompt names the model
 * of the loop whose transcript is in view (the main conversation, or the
 * subagent opened from the tasks list) and, once Jev has decided a step
 * there, that loop's effort trail.
 */

type $ = EngineInterface

const MAIN = 'main'
/** Models the policy's effort table is written for (Opus and Mythos; the same five levels). */
const ROUTED_MODEL = /opus|mythos/i
/** A `jev/…` model belongs to the jev-opus gateway, which routes it itself: two routers would undo each other. */
const GATEWAY_MODEL = /^jev\//i
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Prompt origins that are a person's own message (the follow-up signal asks only on these). */
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/
/** A short acknowledgement starts at the previous prompt's level (borrowed from jev-pilot). */
const ACK = /^(继续|接着|接着做|继续吧|go on|go ahead|continue|proceed|keep going)[\s!！。.~]*$/i
const ACK_MAX_CHARS = 20
/** Fixed text, as jev-opus NOTES['advisor.v1']. */
export const ADVISOR_NOTE = 'The user says the previous attempt got something wrong, and it already ran at the highest available effort. Before continuing, call the advisor tool for a second opinion on the approach.'
const JOURNAL_CAP = 512 * 1024
const STORE_SESSIONS = 200
/** Band lines kept at most, the main loop's and the subagents'; a done subagent's is dropped first. */
const BAND_AGENTS = 64

/** One model loop's routing state: the main conversation or one subagent run. */
interface Loop {
  router: EffortRouter
  prompt: string
  /** the [effort …] range in force until the next prompt: the prompt's own tag, or the main prompt's for a subagent */
  tagged: { bounds: Bounds; inherited: boolean } | null
  /** a subagent loop: the main prompt's tagged range when this loop was started */
  inherited: Bounds | null
  profile: TaskProfile | null
  turn: number
  consecutiveFailures: number
  trajectory: string[]
  /** effort this mod last sent in this loop */
  effort: Effort | null
  /** the session's own effort as last seen: a change is the person's /effort */
  clientEffort: Effort | null
  manual: boolean
  /** this step's tool calls in the order the model made them, filled as they finish */
  pending: Array<{ summary?: ToolCallSummary }>
  /** the visible text of the last response */
  note: string
  edits: Map<string, number>
  trail: Effort[]
  /** task decision prompt.submit made for the turn about to start (main only) */
  task: EffortDecision | null
}

/** What the next prompt's follow-up decision needs of this one, kept per session in $.store. */
interface SessionRecord {
  max: Effort
  last: Effort
  followUp: { yes: boolean; streak: number; hiLosses: number } | null
  at: number
}

/** What the band draws for one loop; a subagent's stays after its loop ends, marked done. */
interface BandStatus {
  /** the model of the loop's latest request, or the main loop's after /model */
  model: string
  /** empty until Jev decides a step on this model */
  trail: Effort[]
  phase: string | null
  source: EffortDecision['source'] | null
  done: boolean
}

const loops = new Map<string, Loop>()
const band = new Map<string, BandStatus>()
let setup: Promise<{ cfg: ModConfig; client: JevSource | null; dir: string }> | null = null
let journalQueue: Promise<void> = Promise.resolve()
let refusedWarned = false

async function configDir($: $): Promise<string> {
  const dir = await $.env.get('JEV_OPUS_CONFIG_DIR')
  if (dir) return dir
  const xdg = await $.env.get('XDG_CONFIG_HOME')
  const home = await $.env.get('HOME')
  return `${xdg || `${home ?? ''}/.config`}/jev-opus`
}

/** Read once per module load: a missing or unreadable .env means heuristics only. */
function load($: $) {
  setup ??= (async () => {
    const dir = await configDir($)
    let env: Record<string, string> = {}
    try {
      env = parseEnvFile(await $.fs.read(`${dir}/.env`))
    } catch { /* no config: heuristics only */ }
    const cfg = modConfig(env)
    applyPolicyConfig(cfg)
    return { cfg, client: jevSource(cfg), dir }
  })()
  return setup
}

/** The configured endpoints as one source: none, one, or a primary with its fallback. */
function jevSource(cfg: ModConfig): JevSource | null {
  const clients = [cfg.jev, cfg.jevFallback].filter((c) => c !== null).map((c) => new JevClient(c))
  if (clients.length === 2) return new JevFallback(clients[0]!, clients[1]!)
  return clients[0] ?? null
}

function io($: $): JevIo {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    now: () => $.clock.now(),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  }
}

function newLoop(cfg: ModConfig, inherited: Bounds | null): Loop {
  return {
    router: new EffortRouter({ jev: null, bounds: cfg.bounds }),
    prompt: '', tagged: null, inherited, profile: null, turn: 0, consecutiveFailures: 0, trajectory: [],
    effort: null, clientEffort: null, manual: false, pending: [], note: '', edits: new Map(), trail: [], task: null,
  }
}

/** A subagent started under a tagged main prompt works inside that prompt's range. */
function loopFor(key: string, cfg: ModConfig): Loop {
  let loop = loops.get(key)
  if (!loop) loops.set(key, (loop = newLoop(cfg, key === MAIN ? null : loops.get(MAIN)?.tagged?.bounds ?? null)))
  return loop
}

/**
 * A new prompt (or subagent run): fresh per-prompt evidence, same router. A
 * `[effort …]` tag in the prompt replaces the configured range for this
 * prompt only; every later decision (task level, raises, step-downs) stays
 * inside it, and the next prompt returns to the configured range. A subagent
 * brief without a tag of its own inherits the main prompt's range.
 */
function startPrompt(loop: Loop, prompt: string, cfg: ModConfig): void {
  loop.prompt = prompt
  // `[effort >=xhigh]` keeps the configured max unless that sits below the asked floor.
  const tag = effortTag(prompt)
  loop.tagged = tag
    ? { bounds: normalizeBounds({ min: tag.min ?? cfg.bounds.min, max: tag.max ?? maxEffort(tag.min ?? cfg.bounds.min, cfg.bounds.max) }), inherited: false }
    : loop.inherited ? { bounds: loop.inherited, inherited: true } : null
  loop.router.bounds = loop.tagged?.bounds ?? cfg.bounds
  loop.turn = 0
  loop.consecutiveFailures = 0
  loop.trajectory = []
  loop.pending = []
  loop.note = ''
  loop.edits = new Map()
  loop.trail = []
}

/** Say in the task decision that the prompt's tag set the range. */
function noteTag(loop: Loop, decision: EffortDecision): void {
  if (loop.tagged) decision.reasons.push(`${loop.tagged.inherited ? 'main prompt tag' : 'prompt tag'} [effort ${describeBounds(loop.tagged.bounds)}]`)
}

/** Journal fields naming the tagged range while it is in force, and whether a subagent inherited it. */
const taggedField = (loop: Loop) => (loop.tagged ? { promptBounds: describeBounds(loop.tagged.bounds), ...(loop.tagged.inherited ? { promptBoundsInherited: true } : {}) } : {})

const storeKey = (session: string) => `session:${session}`

async function readRecord($: $, session: string): Promise<SessionRecord | null> {
  const v = (await $.store.get(storeKey(session))) as Partial<SessionRecord> | undefined
  return v && isEffort(v.max) && isEffort(v.last) ? (v as SessionRecord) : null
}

async function writeRecord($: $, session: string, rec: SessionRecord): Promise<void> {
  await $.store.set(storeKey(session), rec)
  const keys = (await $.store.keys()).filter((k) => k.startsWith('session:'))
  for (const k of keys.slice(0, Math.max(0, keys.length - STORE_SESSIONS))) await $.store.delete(k)
}

async function advisorAvailable($: $): Promise<boolean> {
  try {
    const s = (await $.settings.read()) as { advisorModel?: unknown }
    if (typeof s.advisorModel === 'string' && s.advisorModel) return true
  } catch { /* fall through */ }
  try {
    return (await $.tool.list()).some((t) => t.name.toLowerCase() === 'advisor')
  } catch {
    return false
  }
}

/** Fixed codes only: an evaluator error can quote a URL or a server's text. */
function errorCode(error: string | undefined): string | undefined {
  if (!error) return undefined
  if (error === 'deadline exceeded') return 'deadline'
  if (error === 'circuit open' || error === 'jev circuit open') return 'circuit-open'
  const http = /^Jev HTTP (\d{3})/.exec(error)
  if (http) return `http-${http[1]}`
  if (/no (valid|usable) answers/.test(error)) return 'invalid-answers'
  return 'error'
}

async function journal($: $, dir: string, entry: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify(entry)
  const path = `${dir}/mod-journal.jsonl`
  const write = async () => {
    let text = ''
    try { text = await $.fs.read(path) } catch { /* first line */ }
    if (text.length + line.length + 1 > JOURNAL_CAP) {
      await $.fs.write(`${path}.1`, text)
      text = ''
    }
    await $.fs.write(path, `${text}${line}\n`)
  }
  journalQueue = journalQueue.then(write).catch(() => {})
  await journalQueue
}

function record(d: EffortDecision, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    kind: d.kind,
    effort: d.effort,
    previous: d.previous,
    source: d.source,
    reasons: d.reasons,
    ...(d.profile ? { profile: { taskType: d.profile.taskType, typeConfidence: round(d.profile.typeConfidence), deep: round(d.profile.deep), source: d.profile.source } } : {}),
    ...(d.signals ? { signals: { ...d.signals, phaseConfidence: round(d.signals.phaseConfidence), stepDifficulty: round(d.signals.stepDifficulty), stuck: round(d.signals.stuck) } } : {}),
    jevLatencyMs: d.jevLatencyMs,
    ...(d.jevError ? { jevError: errorCode(d.jevError) } : {}),
    ...(d.jevProvider ? { jevProvider: d.jevProvider } : {}),
    ...(d.jevFallbackFrom ? { jevFallbackFrom: errorCode(d.jevFallbackFrom) } : {}),
    ...(d.followUp ? { followUp: { ...d.followUp, ...(d.followUp.p !== undefined ? { p: round(d.followUp.p) } : {}), error: errorCode(d.followUp.error) } } : {}),
    ...(d.evidence ? { evidence: d.evidence } : {}),
    policy: d.policyVersion,
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000

function pushTrail(loop: Loop, effort: Effort): void {
  if (loop.trail.at(-1) !== effort) loop.trail.push(effort)
}

function setBand($: $, key: string, s: BandStatus): void {
  band.set(key, s)
  for (const [k, old] of band) {
    if (band.size <= BAND_AGENTS) break
    if (old.done) band.delete(k)
  }
  $.ui.invalidate('ui.render')
}

/** The model a loop's request (or /model) names; a trail decided on another model is dropped with it. */
function noteModel($: $, key: string, model: string): void {
  const s = band.get(key)
  if (s?.model === model) return
  setBand($, key, { model, trail: [], phase: null, source: null, done: s?.done ?? false })
}

/** The band's state for this loop after a decision: the prompt's trail, the step phase or task kind, and where the decision came from. */
function noteBand($: $, key: string, model: string, loop: Loop, d: EffortDecision): void {
  setBand($, key, { model, trail: [...loop.trail], phase: d.signals?.phase ?? d.profile?.taskType ?? null, source: d.source, done: false })
}

/**
 * `Opus 5.5 · ◆ Jev · low → HIGH · diagnosing`: the model, then the trail's
 * last six levels, the current one upper-case; the model alone where Jev has
 * decided nothing; `· done` once a subagent has ended.
 */
function bandLine(s: BandStatus): string {
  const parts = [modelLabel(s.model)]
  if (s.trail.length > 0) {
    const shown = s.trail.length > 6 ? ['…', ...s.trail.slice(-5)] : s.trail
    parts.push(`◆ Jev · ${shown.map((e, i) => (i === shown.length - 1 ? e.toUpperCase() : e)).join(' → ')}`)
    if (s.phase) parts.push(s.phase.replaceAll('_', ' '))
    if (s.source === 'heuristic') parts.push('local routing')
  }
  if (s.done) parts.push('done')
  return parts.join(' · ')
}

/** Whether turn.step would act on requests to this model; a prompt for any other model is left alone. */
function routed(model: string): boolean {
  return ROUTED_MODEL.test(model) && !GATEWAY_MODEL.test(model)
}

/** Task decision for a prompt about to start the main loop's turn; null when the session's model is not routed. */
async function routePrompt($: $, text: string, origin: string): Promise<{ decision: EffortDecision; advisor: boolean } | null> {
  const model = await $.session.model()
  if (!routed(model)) return null
  const { cfg, client, dir } = await load($)
  const loop = loopFor(MAIN, cfg)
  const session = await $.session.id()
  const prev = await readRecord($, session)

  let followUp: FollowUpAsk | undefined
  const human = HUMAN_ORIGINS.has(origin) && isHumanPrompt({ role: 'user', content: text })
  if (cfg.followUp.mode && human && prev) {
    const messages = (await $.session.messages({ as: 'api' })) as Message[]
    const all: Message[] = [...messages, { role: 'user', content: text }]
    const lastUser = all.length - 1
    const prevIdx = previousPromptIndex(all, lastUser)
    if (prevIdx >= 0 && all.slice(prevIdx + 1, lastUser).some((m) => m.role === 'assistant')) {
      followUp = {
        summary: followUpSummary(all, prevIdx, lastUser),
        prevMax: prev.max,
        prevDissatisfied: prev.followUp?.yes === true,
        prevStreak: prev.followUp?.streak ?? 0,
        prevHiLosses: prev.followUp?.hiLosses ?? 0,
        shadow: cfg.followUp.mode === 'shadow',
        advisorOption: cfg.followUp.advisor,
        advisorAvailable: cfg.followUp.advisor ? await advisorAvailable($) : false,
      }
    }
  }

  startPrompt(loop, text, cfg)
  loop.router.useJev(client ? client.bind(io($)) : null)
  const decision = await loop.router.routeTask(text || '(continuing an earlier task)', loop.effort, undefined, followUp)
  noteTag(loop, decision)
  loop.profile = decision.profile ?? loop.router.lastProfileFallback(text)

  // A short acknowledgement continues the work at hand: never start it below
  // where the previous prompt ended.
  const trimmed = text.trim()
  const ack = trimmed.length <= ACK_MAX_CHARS && (loop.profile.taskType === 'chat' || ACK.test(trimmed))
  if (ack && prev && decision.source !== 'pinned' && rank(decision.effort) < rank(prev.last)) {
    const effort = clampEffort(prev.last, loop.router.bounds.min, loop.router.bounds.max)
    if (rank(effort) > rank(decision.effort)) {
      decision.reasons.push(`short acknowledgement → stays at ${effort}`)
      decision.effort = effort
      decision.changed = effort !== decision.previous
      loop.router.raiseBase(effort)
    }
  }

  const f = decision.followUp
  await writeRecord($, session, {
    max: decision.effort, last: decision.effort, at: await $.clock.now(),
    followUp: f ? { yes: f.yes, streak: f.streak, hiLosses: f.hiLosses } : null,
  })
  loop.task = decision
  const advisor = f?.advisor === true
  await journal($, dir, record(decision, { at: await $.clock.now(), session, agent: MAIN, event: 'prompt', origin, model, ...taggedField(loop), ...(f ? { advisorAvailable: followUp?.advisorAvailable } : {}), ...(cfg.jevRefusedHost ? { jevRefusedHost: cfg.jevRefusedHost } : {}) }))
  if (cfg.jevRefusedHost && !refusedWarned) {
    refusedWarned = true
    $.ui.toast(`Jev off: endpoint ${cfg.jevRefusedHost} is not local or in JEV_ALLOWED_HOSTS; routing by heuristics`)
  }
  if (f?.raisedTo) $.ui.toast(`Jev: your message says the last turn went wrong → ${f.raisedTo}`)
  if (advisor) $.ui.toast('Jev: asking the model to consult the advisor')
  return { decision, advisor }
}

/** The text a loop's step 0 routes on when no prompt.submit decided it. */
async function loopPrompt($: $, agentId: string | undefined): Promise<string> {
  if (agentId) {
    // A subagent's brief: the first user message of its loop.
    const rows = await $.session.messages({ agentId })
    if (!Array.isArray(rows)) return ''
    return rows.find((r) => r.role === 'user' && r.text)?.text ?? ''
  }
  const messages = (await $.session.messages({ as: 'api' })) as Message[]
  for (let i = messages.length - 1; i >= 0; i--) if (isHumanPrompt(messages[i])) return userText(messages[i])
  return ''
}

async function decideStep($: $, e: { index: number; model: string; effort?: unknown; agentId?: string; turnId: string }): Promise<Effort | undefined> {
  if (!isEffort(e.effort) || !routed(e.model)) return undefined
  const { cfg, client, dir } = await load($)
  const key = e.agentId ?? MAIN
  const loop = loopFor(key, cfg)
  const client0 = e.effort

  // The session's own effort changed since the last request: the person ran
  // /effort. Pin that level for the rest of the prompt, as the gateway did.
  const changedByHand = loop.clientEffort !== null && client0 !== loop.clientEffort
  loop.clientEffort = client0
  const fresh = e.index === 0 || loop.profile === null
  if (changedByHand) loop.manual = true
  else if (fresh) loop.manual = false

  const fromSubmit = fresh && !e.agentId && loop.task !== null
  let decision: EffortDecision
  if (loop.manual) {
    const before = loop.effort ?? client0
    decision = { kind: fresh ? 'task' : 'step', effort: client0, previous: before, changed: client0 !== before, reasons: ['manual override'], source: 'pinned', jevLatencyMs: 0 }
    if (fresh) { startPrompt(loop, loop.prompt, cfg); loop.task = null }
  } else if (fresh) {
    if (!e.agentId && loop.task) {
      decision = loop.task
    } else {
      const text = await loopPrompt($, e.agentId)
      startPrompt(loop, text, cfg)
      loop.router.useJev(client ? client.bind(io($)) : null)
      decision = await loop.router.routeTask(text || '(continuing an earlier task)', loop.effort)
      noteTag(loop, decision)
      loop.profile = decision.profile ?? loop.router.lastProfileFallback(text)
    }
    loop.task = null
  } else {
    const batch = loop.pending.flatMap((s) => (s.summary ? [s.summary] : []))
    loop.pending = []
    loop.turn += 1
    loop.consecutiveFailures = batch.some((c) => c.failed) ? loop.consecutiveFailures + 1 : 0
    const current = loop.effort ?? client0
    loop.router.useJev(client ? client.bind(io($)) : null)
    decision = await loop.router.routeStep({
      prompt: loop.prompt, profile: loop.profile!, turn: loop.turn, current,
      consecutiveFailures: loop.consecutiveFailures, assistantNote: loop.note, lastBatch: batch, trajectory: loop.trajectory,
      fileEdits: Math.max(0, ...loop.edits.values()),
    })
    loop.trajectory.push(trajectoryLine(loop.turn, current, batch))
  }

  const effort = decision.effort
  loop.effort = effort
  pushTrail(loop, effort)
  noteBand($, key, e.model, loop, decision)
  const session = await $.session.id()
  if (key === MAIN) {
    // The session record is the previous prompt's outcome for the next one:
    // a prompt starts it (prompt.submit, or here when none decided the turn),
    // and every step raises its max.
    const rec = await readRecord($, session)
    if (!rec || (fresh && (!fromSubmit || decision.source === 'pinned'))) {
      await writeRecord($, session, { max: effort, last: effort, followUp: fromSubmit ? rec?.followUp ?? null : null, at: await $.clock.now() })
    } else if (rank(effort) > rank(rec.max) || effort !== rec.last) {
      await writeRecord($, session, { ...rec, max: maxEffort(rec.max, effort), last: effort })
    }
  }
  await journal($, dir, record(decision, {
    at: await $.clock.now(), session, agent: e.agentId ?? MAIN, event: 'step', step: e.index, turnId: e.turnId,
    model: e.model, sessionEffort: client0, ...taggedField(loop), ...(loop.manual ? { manual: true } : {}),
  }))
  return effort
}

function noteToolResult(loop: Loop, slot: { summary?: ToolCallSummary }, e: Record<string, unknown>, r: Record<string, unknown>): void {
  const { tool, tool_use_id: id, agentId: _a, consent: _c, ...input } = e
  const name = String(tool)
  const deny = typeof r.deny === 'string' ? r.deny : undefined
  const text = deny ?? (typeof r.text === 'string' ? r.text : stringifyResult(r.result))
  const isError = deny !== undefined || r.isError === true
  slot.summary = { ...summarizeToolCall(name, input, text, isError, typeof id === 'string' ? id : undefined, deny ? undefined : r.result), tool: name }
  if (EDIT_TOOLS.has(name) && !slot.summary.failed) {
    const file = String(input.file_path ?? input.notebook_path ?? '')
    if (file) loop.edits.set(file, (loop.edits.get(file) ?? 0) + 1)
  }
}

export const register: Register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    // A prompt delivered into a running turn joins that turn's steps.
    if (e.turnId !== undefined || SLASH_COMMAND.test(e.text.trim())) return next(e)
    let context = e.context
    try {
      const routed = await routePrompt($, e.text, e.origin.kind)
      if (routed?.advisor) context = [...(e.context ?? []), ADVISOR_NOTE]
    } catch (err) {
      $.ui.log(`jev: prompt routing failed (${(err as Error)?.name ?? 'error'})`, { to: 'debug' })
    }
    return next(context === e.context ? e : { ...e, context })
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const loop = loops.get(e.agentId ?? MAIN)
    const slot: { summary?: ToolCallSummary } = {}
    loop?.pending.push(slot)
    const r = await next(e)
    if (loop) {
      try {
        noteToolResult(loop, slot, e as unknown as Record<string, unknown>, r as unknown as Record<string, unknown>)
      } catch (err) {
        $.ui.log(`jev: tool result not classified (${(err as Error)?.name ?? 'error'})`, { to: 'debug' })
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    noteModel($, e.agentId ?? MAIN, e.model)
    let effort: Effort | undefined
    try {
      effort = await decideStep($, e)
    } catch (err) {
      $.ui.log(`jev: step routing failed (${(err as Error)?.name ?? 'error'})`, { to: 'debug' })
    }
    const result = yield* next(effort ? { ...e, effort } : e)
    const loop = loops.get(e.agentId ?? MAIN)
    // Even when routing failed this step, the next state must pair the
    // tool calls with what the agent said in this step, not an older one.
    if (loop) loop.note = result.answer
    return result
  })

  // /model, or the engine's own fallback, changed the main loop's model: the
  // main line names the new one before its next request.
  on('classic.PostModelSwitch', ($, e, next) => {
    noteModel($, MAIN, e.to_model)
    return next(e)
  })

  // The band above the prompt: the model and trail of the loop whose
  // transcript is in view; the main loop's model is the session's until its
  // first request. Nothing for a subagent before its first request, and
  // nothing over a survey.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const key = e.props.view.agentId ?? MAIN
    const s = band.get(key) ?? (key === MAIN ? { model: await $.session.model(), trail: [], phase: null, source: null, done: false } : undefined)
    if (!s) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text color="warning">{bandLine(s)}</Text>
  })

  // A subagent run's routing state ends with it; its band line stays, marked
  // done, for whoever reads its transcript. The main loop's lives for the session.
  on('turn.complete', ($, e, next) => {
    if (e.agentId) {
      loops.delete(e.agentId)
      const s = band.get(e.agentId)
      if (s) {
        s.done = true
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    loops.clear()
    band.clear()
    return next(e)
  })
}
