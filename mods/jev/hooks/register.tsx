import type { EngineInterface, Register } from 'claude-code'
import { applyPolicyConfig, modConfig, parseEnvFile, type ModConfig } from '../src/config'
import { checkId, editPlan, editTargets, type EditTarget } from '../src/describe'
import { clampEffort, describeBounds, effortAuto, effortTag, isEffort, maxEffort, rank, shift, type Effort } from '../src/effort'
import { followUpSummary, isHumanPrompt, previousPromptIndex, unwrapChannel, userText, type Message } from '../src/followup'
import { JevClient, JevFallback, type JevIo, type JevSource } from '../src/jev'
import { Ladder } from '../src/ladder'
import { modelLabel } from '../src/model'
import { exploreStart, ladderRaise, MAX_RAISES, normalizeBounds, policyVersion, taskEffort, type Bounds } from '../src/policy'
import { EffortRouter, FALLBACK_IGNORED, type FollowUpAsk } from '../src/router'
import type { EffortDecision, TaskProfile } from '../src/types'

/**
 * Jev effort routing per prompt (policy.v10). `prompt.submit` decides a
 * human prompt's start level: the task level from Jev (or heuristics), the
 * follow-up fault raise, a short acknowledgement's floor, the carry-over of a
 * check that kept failing, and exploration. `turn.step` sends that level on
 * every request of the turn. `tool.call` feeds each check's exit code to the
 * ladder: a check that fails again after the model changed code raises one
 * level, mid-loop on Mythos (at most twice per prompt), into the next prompt
 * on Opus, which acts on an effort change only at the next user turn with
 * new input. Nothing ever steps down mid-loop. A /effort the person runs
 * pins the session's own level until `[effort auto]`. Any failure leaves the
 * request as the engine made it. The band above the prompt names the model
 * of the loop whose transcript is in view (the main conversation, or the
 * subagent opened from the tasks list) and that loop's effort trail.
 */

type $ = EngineInterface

const MAIN = 'main'
/** Models the policy's effort table is written for (Opus and Mythos; the same five levels). */
const ROUTED_MODEL = /opus|mythos/i
/** Models whose effort change acts on the next request; on the others (Opus) it waits for the next user turn. */
const MID_LOOP_MODEL = /mythos/i
/** A `jev/…` model belongs to the jev-opus gateway, which routes it itself: two routers would undo each other. */
const GATEWAY_MODEL = /^jev\//i
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Prompt origins that are a person's own message: follow-up, acknowledgement, carry-over and exploration apply to these. */
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'channel'])
/** Prompt origins whose turn continues the last human prompt. */
const CONTINUING_ORIGINS = new Set(['task-notification'])
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/
/** A short acknowledgement starts at the previous prompt's level (borrowed from jev-pilot). */
const ACK = /^(继续|接着|接着做|继续吧|go on|go ahead|continue|proceed|keep going)[\s!！。.~]*$/i
const ACK_MAX_CHARS = 20
/** Stop reasons that leave the work unfinished. */
const UNFINISHED_STOPS = new Set(['max_tokens', 'model_context_window_exceeded'])
/** Fixed text, as jev-opus NOTES['advisor.v1']. */
export const ADVISOR_NOTE = 'The user says the previous attempt got something wrong, and it already ran at the highest available effort. Before continuing, call the advisor tool for a second opinion on the approach.'
const STORE_SESSIONS = 200
/** Band lines kept at most, the main loop's and the subagents'; a done subagent's is dropped first. */
const BAND_AGENTS = 64

/** What one turn did, for its outcome row. */
interface Tally {
  checks: number
  passed: number
  failed: number
  raises: number
  /** passes of a check a raise was made for */
  raisesPassed: number
  jevMs: number
  lastStop: string | null
}

/** One model loop's routing state: the main conversation or one subagent run. */
interface Loop {
  router: EffortRouter
  prompt: string
  /** the [effort …] range in force until the next prompt: the prompt's own tag, or the main prompt's for a subagent */
  tagged: { bounds: Bounds; inherited: boolean } | null
  /** a subagent loop: the main prompt's tagged range when this loop was started */
  inherited: Bounds | null
  profile: TaskProfile | null
  /** effort this mod sends in this loop */
  effort: Effort | null
  /** the model of the loop's previous request */
  model: string | null
  /** the session's own effort as last seen on that model: a change is the person's /effort */
  clientEffort: Effort | null
  ladder: Ladder
  /** ladder raises made in this prompt */
  raises: number
  /** a check that just failed again after a change: the next step may raise */
  repeat: string | null
  trail: Effort[]
  /** what starts the next turn (main only): a decided prompt, a continuation, or a slash command */
  next: { kind: 'prompt'; task: EffortDecision | null } | { kind: 'continue' } | { kind: 'command' } | null
  tally: Tally
}

/** What the next prompt needs of this one, kept per session in $.store. */
interface SessionRecord {
  max: Effort
  last: Effort
  followUp: { yes: boolean; streak: number; hiLosses: number } | null
  at: number
  /** prompts started so far: the journal's prompt number */
  prompt: number
  /** the last turn ended with a check that failed again after a change and has not passed since */
  carry: boolean
  /** the last turn stopped unfinished (interrupted, an API error, out of tokens) */
  unfinished: boolean
  /** a /effort pin holds */
  pinned: boolean
}

/** What the band draws for one loop; a subagent's stays after its loop ends, marked done. */
interface BandStatus {
  /** the model of the loop's latest request, or the main loop's after /model */
  model: string
  /** empty until a level is set on this model */
  trail: Effort[]
  phase: string | null
  source: EffortDecision['source'] | null
  done: boolean
}

const loops = new Map<string, Loop>()
const band = new Map<string, BandStatus>()
let setup: Promise<{ cfg: ModConfig; client: JevSource | null; dir: string }> | null = null
let refusedWarned = false
/** The session's /effort pin; null until read from the store. */
let pinned: boolean | null = null
/** The [effort …] range of the main prompt in force, which subagents inherit; every new prompt sets it, routed or not. */
let mainTag: Bounds | null = null

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

const newTally = (): Tally => ({ checks: 0, passed: 0, failed: 0, raises: 0, raisesPassed: 0, jevMs: 0, lastStop: null })

function newLoop(cfg: ModConfig, inherited: Bounds | null): Loop {
  return {
    router: new EffortRouter({ jev: null, bounds: cfg.bounds }),
    prompt: '', tagged: null, inherited, profile: null, effort: null, model: null, clientEffort: null,
    ladder: new Ladder(), raises: 0, repeat: null, trail: [], next: null, tally: newTally(),
  }
}

/** A subagent started under a tagged main prompt works inside that prompt's range. */
function loopFor(key: string, cfg: ModConfig): Loop {
  let loop = loops.get(key)
  if (!loop) loops.set(key, (loop = newLoop(cfg, key === MAIN ? null : mainTag)))
  return loop
}

/** The range a prompt's `[effort …]` tag sets; `[effort >=xhigh]` keeps the configured max unless that sits below the asked floor. */
function tagBounds(text: string, cfg: ModConfig): Bounds | null {
  const tag = effortTag(text)
  if (!tag) return null
  const min = tag.min ?? cfg.bounds.min
  return normalizeBounds({ min, max: tag.max ?? maxEffort(min, cfg.bounds.max) })
}

/**
 * A new prompt (or subagent run): fresh per-prompt state, same router. A
 * `[effort …]` tag in the prompt replaces the configured range for this
 * prompt only; every later decision (task level, raises) stays inside it,
 * and the next prompt returns to the configured range. A subagent brief
 * without a tag of its own inherits the main prompt's range.
 */
function startPrompt(loop: Loop, prompt: string, cfg: ModConfig): void {
  loop.prompt = prompt
  const own = tagBounds(prompt, cfg)
  loop.tagged = own ? { bounds: own, inherited: false } : loop.inherited ? { bounds: loop.inherited, inherited: true } : null
  loop.router.bounds = loop.tagged?.bounds ?? cfg.bounds
  loop.ladder = new Ladder()
  loop.raises = 0
  loop.repeat = null
  loop.trail = []
}

/** Say in the task decision that a tag set the range. */
function noteTag(loop: Loop, decision: EffortDecision): void {
  if (loop.tagged) decision.reasons.push(`${loop.tagged.inherited ? 'main prompt tag' : 'prompt tag'} [effort ${describeBounds(loop.tagged.bounds)}]`)
}

/** Journal fields naming the tagged range while it is in force, and whether a subagent inherited it. */
const taggedField = (loop: Loop) => (loop.tagged ? { promptBounds: describeBounds(loop.tagged.bounds), ...(loop.tagged.inherited ? { promptBoundsInherited: true } : {}) } : {})

const storeKey = (session: string) => `session:${session}`

async function readRecord($: $, session: string): Promise<SessionRecord | null> {
  const v = (await $.store.get(storeKey(session))) as Partial<SessionRecord> | undefined
  if (!v || !isEffort(v.max) || !isEffort(v.last)) return null
  return {
    max: v.max, last: v.last, followUp: v.followUp ?? null, at: v.at ?? 0,
    prompt: typeof v.prompt === 'number' ? v.prompt : 0, carry: v.carry === true, unfinished: v.unfinished === true, pinned: v.pinned === true,
  }
}

async function writeRecord($: $, session: string, rec: SessionRecord): Promise<void> {
  await $.store.set(storeKey(session), rec)
  const keys = (await $.store.keys()).filter((k) => k.startsWith('session:'))
  for (const k of keys.slice(0, Math.max(0, keys.length - STORE_SESSIONS))) await $.store.delete(k)
}

/** A fresh record for a new prompt that starts at `effort`. */
const freshRecord = (prev: SessionRecord | null, effort: Effort, at: number, followUp: SessionRecord['followUp']): SessionRecord => ({
  max: effort, last: effort, followUp, at, prompt: (prev?.prompt ?? 0) + 1, carry: false, unfinished: false, pinned: pinned === true,
})

/** The session's pin as the store holds it, read once per module load. */
async function loadPin($: $, session: string): Promise<boolean> {
  pinned ??= (await readRecord($, session))?.pinned ?? false
  return pinned
}

async function savePin($: $, session: string, value: boolean): Promise<void> {
  pinned = value
  const rec = await readRecord($, session)
  if (rec) await writeRecord($, session, { ...rec, pinned: value })
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
  if (error === 'clock sleep rejected') return 'sleep-rejected'
  if (error === 'circuit open' || error === 'jev circuit open') return 'circuit-open'
  if (error === FALLBACK_IGNORED) return 'fallback-ignored'
  const http = /^Jev HTTP (\d{3})/.exec(error)
  if (http) return `http-${http[1]}`
  if (/no (valid|usable) answers/.test(error)) return 'invalid-answers'
  return 'error'
}

/**
 * Append one row to the day's journal, `mod-journal-YYYY-MM-DD.jsonl` (UTC).
 * Sessions in other processes append to the same file, so each row is one
 * write through an O_APPEND descriptor (`>>`): rows never overwrite each other.
 */
async function journal($: $, dir: string, entry: Record<string, unknown> & { at: number }): Promise<void> {
  const path = `${dir}/mod-journal-${new Date(entry.at).toISOString().slice(0, 10)}.jsonl`
  const r = await $.process.run(['sh', '-c', 'mkdir -p "$1" && cat >> "$2"', 'sh', dir, path], { stdin: `${JSON.stringify(entry)}\n` })
  if (r.exitCode !== 0) throw new Error(`journal append exited ${r.exitCode}`)
}

function record(d: EffortDecision, extra: Record<string, unknown> & { at: number }): Record<string, unknown> & { at: number } {
  return {
    ...extra,
    kind: d.kind,
    effort: d.effort,
    previous: d.previous,
    source: d.source,
    reasons: d.reasons,
    ...(d.profile ? { profile: { taskType: d.profile.taskType, typeConfidence: round(d.profile.typeConfidence), deep: round(d.profile.deep), source: d.profile.source } } : {}),
    jevLatencyMs: d.jevLatencyMs,
    ...(d.jevError ? { jevError: errorCode(d.jevError) } : {}),
    ...(d.jevProvider ? { jevProvider: d.jevProvider } : {}),
    ...(d.jevFallbackFrom ? { jevFallbackFrom: errorCode(d.jevFallbackFrom) } : {}),
    ...(d.followUp ? { followUp: { ...d.followUp, ...(d.followUp.p !== undefined ? { p: round(d.followUp.p) } : {}), error: errorCode(d.followUp.error) } } : {}),
    ...(d.explore ? { explore: d.explore } : {}),
    ...(d.carry ? { carry: d.carry } : {}),
    policy: d.policyVersion ?? policyVersion(),
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

/** The band's state for this loop after a decision: the prompt's trail, the task kind (or the ladder step), and where the decision came from. */
function noteBand($: $, key: string, model: string, loop: Loop, d: EffortDecision): void {
  const phase = d.kind === 'step' && d.source === 'local' ? 'check failed again' : d.profile?.taskType ?? loop.profile?.taskType ?? null
  setBand($, key, { model, trail: [...loop.trail], phase, source: d.source, done: false })
}

/**
 * `Opus 5.5 · ◆ Jev · high → XHIGH · code`: the model, then the trail's
 * last six levels, the current one upper-case; the model alone where Jev has
 * set nothing; `· done` once a subagent has ended.
 */
function bandLine(s: BandStatus): string {
  const parts = [modelLabel(s.model)]
  if (s.trail.length > 0) {
    const shown = s.trail.length > 6 ? ['…', ...s.trail.slice(-5)] : s.trail
    parts.push(`◆ Jev · ${shown.map((e, i) => (i === shown.length - 1 ? e.toUpperCase() : e)).join(' → ')}`)
    if (s.phase) parts.push(s.phase.replaceAll('_', ' '))
    if (s.source === 'heuristic') parts.push('local routing')
    if (s.source === 'pinned') parts.push('/effort')
  }
  if (s.done) parts.push('done')
  return parts.join(' · ')
}

/** Whether turn.step would act on requests to this model; a prompt for any other model is left alone. */
function routed(model: string): boolean {
  return ROUTED_MODEL.test(model) && !GATEWAY_MODEL.test(model)
}

/** The follow-up ask for a human prompt after a turn in which the agent replied; undefined otherwise. */
async function followUpAsk($: $, text: string, prev: SessionRecord, cfg: ModConfig): Promise<FollowUpAsk | undefined> {
  const messages = (await $.session.messages({ as: 'api' })) as Message[]
  const all: Message[] = [...messages, { role: 'user', content: text }]
  const lastUser = all.length - 1
  const prevIdx = previousPromptIndex(all, lastUser)
  if (prevIdx < 0 || !all.slice(prevIdx + 1, lastUser).some((m) => m.role === 'assistant')) return undefined
  return {
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

/** Set a decision's level after the router's, with the reason that moved it there. */
function moveTo(d: EffortDecision, effort: Effort, reason: string): void {
  d.reasons.push(reason)
  d.effort = effort
  d.changed = effort !== d.previous
}

/**
 * Start decision for a prompt about to start the main loop's turn; null when
 * the session's model is not routed or a /effort pin holds. A human prompt
 * gets the follow-up raise, the acknowledgement floor, the carry-over (Opus)
 * and exploration on top of its task level.
 */
async function routePrompt($: $, raw: string, origin: string): Promise<{ advisor: boolean } | null> {
  const { cfg, client, dir } = await load($)
  const human = HUMAN_ORIGINS.has(origin)
  const text = origin === 'channel' ? unwrapChannel(raw) : raw
  // The tag goes with this prompt, whichever model runs it: a subagent may run on a routed one.
  mainTag = tagBounds(text, cfg)
  const loop = loopFor(MAIN, cfg)
  loop.next = null
  const session = await $.session.id()
  const prev = await readRecord($, session)
  if ((await loadPin($, session)) && human && effortAuto(text)) {
    await savePin($, session, false)
    loop.clientEffort = null
  }
  const model = await $.session.model()
  if (!routed(model)) return null

  const continued = loop.ladder
  startPrompt(loop, text, cfg)
  if (pinned) {
    loop.next = { kind: 'prompt', task: null }
    await writeRecord($, session, freshRecord(prev, loop.effort ?? prev?.last ?? cfg.bounds.min, await $.clock.now(), null))
    return null
  }

  const followUp = human && cfg.followUp.mode && prev ? await followUpAsk($, text, prev, cfg) : undefined
  loop.router.useJev(client ? client.bind(io($)) : null)
  const decision = await loop.router.routeTask(text || '(continuing an earlier task)', loop.effort, undefined, followUp)
  noteTag(loop, decision)
  loop.profile = decision.profile ?? loop.router.lastProfileFallback(text)
  const bounds = loop.router.bounds
  const f = decision.followUp

  if (human && prev) {
    const trimmed = text.trim()
    // A short acknowledgement continues the work at hand: never start it below where the previous prompt ended.
    const ack = trimmed.length <= ACK_MAX_CHARS && (loop.profile.taskType === 'chat' || ACK.test(trimmed))
    let level = taskEffort(loop.profile, bounds).effort
    if (ack && rank(level) < rank(prev.last)) {
      level = clampEffort(prev.last, bounds.min, bounds.max)
      if (rank(level) > rank(decision.effort)) moveTo(decision, level, `short acknowledgement → stays at ${level}`)
    }
    const continues = ack || (f?.yes === true && !f.shadow) || (prev.unfinished && trimmed.length <= ACK_MAX_CHARS)
    if (continues) loop.ladder = continued
    // Opus did not act on the failing check mid-loop: the prompt that continues the work starts one rung up.
    if (continues && prev.carry && !MID_LOOP_MODEL.test(model)) {
      const to = clampEffort(shift(level, 1), bounds.min, bounds.max)
      if (rank(to) > rank(level)) {
        const carried = loop.ladder.repeatFailing()
        decision.carry = { from: level, to, checks: carried.length }
        for (const id of carried) loop.ladder.markRaised(id)
        if (rank(to) > rank(decision.effort)) moveTo(decision, to, `check still failing after a change → ${to}`)
        else decision.reasons.push(`check still failing after a change → ${to}, already ${decision.effort}`)
      }
    }
  }

  if (human && !loop.tagged) {
    const from = decision.effort
    const to = exploreStart(from, bounds, cfg.explore, Math.random(), Math.random())
    if (to) {
      decision.explore = { p: cfg.explore, from, to }
      moveTo(decision, to, `explore: ${from} → ${to}`)
    }
  }

  const at = await $.clock.now()
  const rec = freshRecord(prev, decision.effort, at, f ? { yes: f.yes, streak: f.streak, hiLosses: f.hiLosses } : null)
  await writeRecord($, session, rec)
  loop.next = { kind: 'prompt', task: decision }
  const advisor = f?.advisor === true
  if (cfg.jevRefusedHost && !refusedWarned) {
    refusedWarned = true
    $.ui.toast(`Jev off: endpoint ${cfg.jevRefusedHost} is not local or in JEV_ALLOWED_HOSTS; routing by heuristics`)
  }
  if (f?.raisedTo) $.ui.toast(`Jev: your message says the last turn went wrong → ${f.raisedTo}`)
  if (decision.carry) $.ui.toast(`Jev: a check still fails after a change → ${decision.effort}`)
  if (advisor) $.ui.toast('Jev: asking the model to consult the advisor')
  await journal($, dir, record(decision, {
    at, session, agent: MAIN, event: 'prompt', prompt: rec.prompt, origin, model, ...taggedField(loop),
    ...(f ? { correction: f.yes, advisorAvailable: followUp?.advisorAvailable } : {}),
    ...(cfg.jevRefusedHost ? { jevRefusedHost: cfg.jevRefusedHost } : {}),
  }))
  return { advisor }
}

/** What starts the main loop's next turn when no human prompt does: a continuation, or a slash command. */
async function markTurn($: $, kind: 'continue' | 'command', text: string): Promise<void> {
  const { cfg } = await load($)
  // A slash command is a new task: the previous prompt's tag does not reach its subagents.
  if (kind === 'command') mainTag = tagBounds(text, cfg)
  loopFor(MAIN, cfg).next = { kind }
}

/** The user messages after the last assistant reply: a slash command's expansion as the model reads it. */
async function commandText($: $): Promise<string> {
  const messages = (await $.session.messages({ as: 'api' })) as Message[]
  let i = messages.length
  while (i > 0 && messages[i - 1]!.role === 'user') i--
  return messages.slice(i).map(userText).filter(Boolean).join('\n')
}

/** The text a loop's first step routes on when no prompt.submit decided it. */
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

const continuation = (loop: Loop): EffortDecision => ({
  kind: 'task', effort: loop.effort!, previous: loop.effort, changed: false, reasons: ['continues the last prompt'], source: 'local',
  jevLatencyMs: 0, ...(loop.profile ? { profile: loop.profile } : {}), policyVersion: policyVersion(),
})

/** The level a turn starts at: the prompt's decision, the last prompt's level for a continuation, or a new task's from its own text. */
async function startOfTurn($: $, loop: Loop, key: string, cfg: ModConfig, client: JevSource | null, agentId: string | undefined): Promise<EffortDecision> {
  const next = loop.next
  loop.next = null
  if (key === MAIN && next?.kind === 'prompt' && next.task) return next.task
  // A background task's report (or a turn no prompt started) continues the last prompt: same level, range and open checks.
  if (key === MAIN && next?.kind !== 'command' && loop.effort !== null) return continuation(loop)
  const text = key === MAIN && next?.kind === 'command' ? await commandText($) : await loopPrompt($, agentId)
  if (key === MAIN && next?.kind === 'command') mainTag = tagBounds(text, cfg)
  startPrompt(loop, text, cfg)
  loop.router.useJev(client ? client.bind(io($)) : null)
  const d = await loop.router.routeTask(text || '(continuing an earlier task)', loop.effort)
  noteTag(loop, d)
  loop.profile = d.profile ?? loop.router.lastProfileFallback(text)
  if (key === MAIN) {
    const session = await $.session.id()
    await writeRecord($, session, freshRecord(await readRecord($, session), d.effort, await $.clock.now(), null))
  }
  return d
}

/**
 * A step after a check failed again following a change: on Mythos, one rung
 * up, at most MAX_RAISES per prompt; on Opus nothing until the turn ends.
 */
function ladderStep(loop: Loop, model: string): EffortDecision | null {
  const id = loop.repeat!
  loop.repeat = null
  if (!MID_LOOP_MODEL.test(model)) return null
  const current = loop.effort!
  const step = {
    kind: 'step' as const, previous: current, source: 'local' as const, jevLatencyMs: 0,
    ...(loop.profile ? { profile: loop.profile } : {}), policyVersion: policyVersion(),
  }
  if (loop.raises >= MAX_RAISES) return { ...step, effort: current, changed: false, reasons: [`check failed again after a change; ${MAX_RAISES} raises this prompt already → stays ${current}`] }
  const to = ladderRaise(current, loop.router.bounds)
  if (!to) return { ...step, effort: current, changed: false, reasons: [`check failed again after a change; ${current} is the top of the range`] }
  loop.raises += 1
  loop.tally.raises += 1
  loop.ladder.markRaised(id)
  return { ...step, effort: to, changed: true, reasons: [`check failed again after a change → ${to}`] }
}

async function decideStep($: $, e: { index: number; model: string; effort?: unknown; agentId?: string; turnId: string }): Promise<Effort | undefined> {
  if (!isEffort(e.effort) || !routed(e.model)) return undefined
  const { cfg, client, dir } = await load($)
  const key = e.agentId ?? MAIN
  const loop = loopFor(key, cfg)
  const session = await $.session.id()
  await loadPin($, session)

  // The session's own effort changed between two requests on the same model:
  // the person ran /effort. A new model (/model, a subagent's first request)
  // only sets the baseline.
  const sameModel = loop.model === e.model
  loop.model = e.model
  if (!sameModel || loop.clientEffort === null) loop.clientEffort = e.effort
  else if (e.effort !== loop.clientEffort) {
    loop.clientEffort = e.effort
    if (!pinned) await savePin($, session, true)
  }

  let decision: EffortDecision | null = null
  if (pinned) {
    // The person's own level holds: the engine sends it as it is.
    if (e.index === 0) loop.next = null
    loop.repeat = null
    if (e.index === 0 || loop.effort !== e.effort) {
      decision = { kind: e.index === 0 ? 'task' : 'step', effort: e.effort, previous: loop.effort, changed: loop.effort !== e.effort, reasons: ['/effort pin'], source: 'pinned', jevLatencyMs: 0, policyVersion: policyVersion() }
    }
  } else if (e.index === 0 || loop.effort === null) {
    decision = await startOfTurn($, loop, key, cfg, client, e.agentId)
    loop.tally.jevMs += decision.jevLatencyMs
  } else if (loop.repeat !== null) {
    decision = ladderStep(loop, e.model)
  }

  if (decision) {
    loop.effort = decision.effort
    pushTrail(loop, decision.effort)
    noteBand($, key, e.model, loop, decision)
    if (key === MAIN && decision.kind === 'step') {
      const rec = await readRecord($, session)
      if (rec) await writeRecord($, session, { ...rec, max: maxEffort(rec.max, decision.effort), last: decision.effort })
    }
    await journal($, dir, record(decision, {
      at: await $.clock.now(), session, agent: key, event: 'step', step: e.index, turnId: e.turnId,
      model: e.model, sessionEffort: e.effort, ...taggedField(loop), ...(pinned ? { manual: true } : {}),
    }))
  }
  return pinned ? undefined : loop.effort ?? undefined
}

/** A Bash call that may edit files: what it names, and its start time and directory, read before it ran. */
interface BashCall {
  targets: EditTarget[]
  at: number
  cwd: string
  root: string
}

/**
 * Whether a Bash command edited a file. After a success: some edit counts
 * without a look (remote, a file it cannot name, mv), or one of its files is
 * missing, not a regular file (a directory's time misses files changed inside
 * it), or modified since the call started. After a failure only the edits
 * chained by `&&` into a check count (`sed -i … && npm test`: the failure is
 * the edit's or the check's), and only when every one of their files is a
 * regular file modified since the start; any it cannot look at leaves the
 * failure unexplained, so nothing counts. cp/mv/install count only into the
 * session's project root or the directory the command ran in.
 */
async function bashEdited($: $, call: BashCall, failed: boolean): Promise<boolean> {
  const plan = editPlan(failed ? call.targets.filter((t) => t.beforeCheck) : call.targets, call.cwd, [call.root, call.cwd])
  if (!plan) return false
  if (plan.unchecked) return !failed
  // Whole seconds: a file system that keeps only those, or the kernel's coarse clock, can stamp a write made after the start a little before it.
  const since = Math.floor(call.at / 1000) * 1000
  for (const path of plan.files) {
    const stat = await $.fs.stat(path).catch(() => null)
    const changed = stat?.kind === 'file' && stat.mtimeMs >= since
    if (!failed && (changed || stat?.kind !== 'file')) return true
    if (failed && !changed) return false
  }
  return failed
}

/** Feed one finished tool call to the loop's ladder: code changes, and each check's exit code. */
async function noteToolResult($: $, loop: Loop, key: string, e: Record<string, unknown>, r: Record<string, unknown>, bash: BashCall | null): Promise<void> {
  // A denied call ran nothing.
  if (typeof r.deny === 'string') return
  const tool = String(e.tool)
  if (EDIT_TOOLS.has(tool)) {
    if (r.isError !== true) loop.ladder.noteEdit()
    return
  }
  if (tool !== 'Bash' || typeof e.command !== 'string') return
  const out = (r.result ?? {}) as { interrupted?: unknown; backgroundTaskId?: unknown; timedOutAfterMs?: unknown }
  // No exit code to judge: interrupted, or moved to the background.
  if (out.interrupted === true || out.backgroundTaskId !== undefined || out.timedOutAfterMs !== undefined) return
  const failed = r.isError === true
  // The change comes before the check it was chained into: `npm test` failing, then `sed -i … && npm test` failing, is a repeat.
  if (bash && (await bashEdited($, bash, failed))) loop.ladder.noteEdit()
  const id = checkId(e.command)
  if (!id) return
  const note = loop.ladder.noteCheck(id, failed)
  loop.tally.checks += 1
  if (failed) loop.tally.failed += 1
  else loop.tally.passed += 1
  if (note.passedAfterRaise) loop.tally.raisesPassed += 1
  if (note.outcome === 'repeat-failure') loop.repeat = id
  const { dir } = await load($)
  await journal($, dir, {
    at: await $.clock.now(), session: await $.session.id(), agent: key, event: 'check', check: id.slice(0, 8), outcome: note.outcome,
    failures: note.failures, ...(note.passedAfterRaise ? { passedAfterRaise: true } : {}), effort: loop.effort, model: loop.model, ...taggedField(loop),
  })
}

/** A loop's turn ended: what the next prompt carries, and the turn's outcome row. */
async function endTurn($: $, e: { turnId: string; agentId?: string; reason: string; durationMs: number; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } }): Promise<void> {
  const key = e.agentId ?? MAIN
  const loop = loops.get(key)
  if (!loop || loop.effort === null) return
  const { dir } = await load($)
  const session = await $.session.id()
  const carry = loop.ladder.repeatFailing().length
  const unfinished = e.reason === 'aborted' || e.reason === 'error' || UNFINISHED_STOPS.has(loop.tally.lastStop ?? '')
  const rec = key === MAIN ? await readRecord($, session) : null
  if (rec) await writeRecord($, session, { ...rec, carry: carry > 0, unfinished })
  const t = loop.tally
  loop.tally = newTally()
  await journal($, dir, {
    at: await $.clock.now(), session, agent: key, event: 'outcome', turnId: e.turnId, ...(rec ? { prompt: rec.prompt } : {}),
    model: loop.model, effort: loop.effort, trail: [...loop.trail], reason: e.reason, durationMs: e.durationMs, jevWaitMs: t.jevMs,
    ...(e.usage ? { outputTokens: e.usage.output_tokens, inputTokens: e.usage.input_tokens, cacheReadTokens: e.usage.cache_read_input_tokens, cacheCreationTokens: e.usage.cache_creation_input_tokens } : {}),
    checks: { run: t.checks, passed: t.passed, failed: t.failed }, raises: t.raises, raisesPassed: t.raisesPassed,
    carry, unfinished, ...(pinned ? { manual: true } : {}), policy: policyVersion(),
  })
}

export const register: Register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    // A prompt delivered into a running turn joins that turn's steps.
    if (e.turnId !== undefined) return next(e)
    let context = e.context
    try {
      if (CONTINUING_ORIGINS.has(e.origin.kind)) await markTurn($, 'continue', e.text)
      else if (e.command !== undefined || SLASH_COMMAND.test(e.text.trim())) await markTurn($, 'command', e.text)
      else {
        const routed = await routePrompt($, e.text, e.origin.kind)
        if (routed?.advisor) context = [...(e.context ?? []), ADVISOR_NOTE]
      }
    } catch (err) {
      $.ui.log(`jev: prompt routing failed (${(err as Error)?.name ?? 'error'})`, { to: 'debug' })
    }
    return next(context === e.context ? e : { ...e, context })
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const key = e.agentId ?? MAIN
    const command = (e as { command?: unknown }).command
    const targets = e.tool === 'Bash' && typeof command === 'string' && loops.get(key)?.effort ? editTargets(command) : []
    // Read before the call runs: what it edits is modified after its start, and a `cd` in it moves the session's directory.
    const bash = targets.length ? { targets, at: await $.clock.now(), cwd: await $.session.cwd(), root: await $.session.root() } : null
    const r = await next(e)
    const loop = loops.get(key)
    if (loop && loop.effort !== null) {
      try {
        await noteToolResult($, loop, key, e as unknown as Record<string, unknown>, r as unknown as Record<string, unknown>, bash)
      } catch (err) {
        $.ui.log(`jev: tool result not noted (${(err as Error)?.name ?? 'error'})`, { to: 'debug' })
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
    if (loop) loop.tally.lastStop = result.stopReason
    return result
  })

  // /model, or the engine's own fallback, changed the main loop's model: the
  // main line names the new one before its next request, whose effort is a
  // new baseline (a model's own default is no /effort), and the last prompt's
  // tag no longer reaches subagents.
  on('classic.PostModelSwitch', ($, e, next) => {
    noteModel($, MAIN, e.to_model)
    const loop = loops.get(MAIN)
    if (loop) loop.clientEffort = null
    mainTag = null
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

  // A turn's outcome is journaled; a subagent run's routing state ends with
  // it, while its band line stays, marked done, for whoever reads its
  // transcript. The main loop's lives for the session.
  on('turn.complete', async ($, e, next) => {
    try {
      await endTurn($, e)
    } catch (err) {
      $.ui.log(`jev: turn outcome not recorded (${(err as Error)?.name ?? 'error'})`, { to: 'debug' })
    }
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
    pinned = null
    mainTag = null
    return next(e)
  })
}
