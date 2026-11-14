import type { EngineInterface, Register } from 'claude-code'
import { applyPolicyConfig, keyFilePath, modConfig, parseEnvFile, type ModConfig } from '../src/config'
import { checkId, editPlan, editTargets, type EditTarget } from '../src/describe'
import { isMagpieTask, jevDialogue, latestUserText, unwrapChannel, withPrompt, type ApiMessage } from '../src/dialogue'
import { clampEffort, describeBounds, effortAuto, effortTag, isEffort, maxEffort, rank, shift, type Effort } from '../src/effort'
import { JevClient, type JevIo } from '../src/jev'
import { Ladder } from '../src/ladder'
import { isRoutedModel as routed, modelLabel } from '../src/model'
import { exploreStart, normalizeBounds, policyVersion, taskEffort, type Bounds } from '../src/policy'
import { EffortRouter, type FollowUpAsk } from '../src/router'
import type { EffortDecision, TaskProfile } from '../src/types'

/**
 * Jev effort routing per prompt (policy.v17). `prompt.submit` decides a
 * human prompt's start level: the task level from Jev (or heuristics), the
 * follow-up fault raise, a short acknowledgement's floor, the carry-over of a
 * check that kept failing, and exploration. Jev reads the conversation as
 * Claude Code holds it (src/dialogue.ts), newest message last, and answers the
 * task and follow-up questions in one request. `turn.step` sends that level on
 * every request of the turn; a subagent's run is decided at its first request
 * from its newest message (its brief, or the message that resumed it), and a
 * subagent whose brief opens with the magpie-tasks marker is left alone, as
 * is magpie-tasks' relay prompt. Notes other plugins append are recorded
 * (`session.append`) and kept out of Jev's view.
 * `tool.call` feeds each check's exit code to the ladder: a check that fails
 * again after the model changed code and still fails when the turn ends starts
 * the next prompt that continues the work, or the subagent's next run, one
 * level up. The level never moves within a turn. A /effort the person runs
 * pins the session's own level until `[effort auto]`. A session started with
 * JEV_MAIN_EFFORT in its environment (the claude-telegram Router) runs its
 * main loop at that level: Jev is not asked and the ladder does not raise it;
 * a /effort the person runs still wins. Any failure leaves the
 * request as the engine made it. The band above the prompt names the model
 * of the loop whose transcript is in view (the main conversation, or the
 * subagent opened from the tasks list) and that loop's effort trail; for a
 * subagent magpie-tasks routes it passes the band on to that plugin, which
 * sets the subagent's effort and draws its line.
 */

type $ = EngineInterface

const MAIN = 'main'
/** The environment variable that fixes the main loop's level for the whole session. */
export const MAIN_EFFORT_ENV = 'JEV_MAIN_EFFORT'
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Prompt origins that are a person's own message: follow-up, acknowledgement, carry-over and exploration apply to these. */
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'channel'])
/** Prompt origins whose turn continues the last human prompt. */
const CONTINUING_ORIGINS = new Set(['task-notification'])
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/
/** A short acknowledgement starts at the previous prompt's level (borrowed from jev-pilot). */
const ACK = /^(继续|接着|接着做|继续吧|go on|go ahead|continue|proceed|keep going)[\s!！。.~]*$/i
const ACK_MAX_CHARS = 20
/** Jev's probability at or above which a prompt carries on the previous turn's task. */
const CONTINUE_YES = 0.5
/** Stop reasons that leave the work unfinished. */
const UNFINISHED_STOPS = new Set(['max_tokens', 'model_context_window_exceeded'])
/** Fixed text, as jev-opus NOTES['advisor.v1']. */
export const ADVISOR_NOTE = 'The user says the previous attempt got something wrong, and it already ran at the highest available effort. Before continuing, call the advisor tool for a second opinion on the approach.'
const STORE_SESSIONS = 200
/** Band lines kept at most, the main loop's and the subagents'; a done subagent's is dropped first. */
const BAND_AGENTS = 64
/** Subagents whose open checks are kept for their next run, at most. */
const HELD_AGENTS = 64
/** Subagent ids whose brief was read for the magpie-tasks marker, kept at most; a dropped one is read again at its next request. */
const OWNER_AGENTS = 256
/** Why Jev is off although a key was configured: the key file could not be read. */
const KEY_FILE_UNREADABLE = 'key file unreadable'
/** Why Jev is off: .env names JEV_API_KEY, a key of the service jev-opus used before, and no JEV_API_KEY_FILE. */
const STALE_KEY = 'JEV_API_KEY is not read'
/** Notes other plugins appended, kept at most: Jev's view drops them by their text. */
const NOTES_KEPT = 500
/** A magpie-tasks relay prompt: that plugin drops it and starts a subagent; it is no one's prompt. */
const MAGPIE_TASKS_RELAY = '[magpie-tasks spawn '

/** What one turn did, for its outcome row. */
interface Tally {
  checks: number
  passed: number
  failed: number
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
  trail: Effort[]
  /** what starts the next turn (main only): a decided prompt, a continuation, or a slash command */
  next: { kind: 'prompt'; task: EffortDecision | null } | { kind: 'continue' } | { kind: 'command' } | null
  tally: Tally
  /** a subagent run whose brief opens with the magpie-tasks marker: its effort is left alone; null until its first request */
  skip: boolean | null
}

/** What a subagent's next run needs of the last one: the level it ran at, its open checks, and whether one still failed after a change. */
interface Held {
  effort: Effort
  ladder: Ladder
  carry: boolean
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
  /** the highest level the task in hand has reached, across its prompts: a continuing prompt starts no lower */
  taskMax: Effort
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
/** Per subagent id, kept from the end of one run to the start of the next (SendMessage resumes the same id). */
const held = new Map<string, Held>()
/** Per subagent id, whether its brief opens with the magpie-tasks marker: that plugin sets its effort and draws its band line. */
const magpieOwned = new Map<string, boolean>()
let setup: Promise<{ cfg: ModConfig; client: JevClient | null; keyError: string | null; dir: string; mainEffort: Effort | null }> | null = null
let keyWarned = false
let authWarned = false
/** Texts of the notes other plugins appended to this session's conversations (`session.append`, door `note`). */
const notes = new Set<string>()
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

/**
 * Read once per module load: a missing or unreadable .env means heuristics
 * only. The OpenAI key comes from JEV_API_KEY_FILE alone; a key file that
 * cannot be read (or is empty), or a JEV_API_KEY without the file, also leaves
 * Jev off, and every decision's journal row says so.
 */
function load($: $) {
  setup ??= (async () => {
    const dir = await configDir($)
    let env: Record<string, string> = {}
    try {
      env = parseEnvFile(await $.fs.read(`${dir}/.env`))
    } catch { /* no config: heuristics only */ }
    const cfg = modConfig(env)
    applyPolicyConfig(cfg)
    let apiKey = ''
    let keyError: string | null = null
    if (cfg.jevKeyFile) {
      const path = keyFilePath(cfg.jevKeyFile, (await $.env.get('HOME')) ?? '', dir)
      try {
        apiKey = (await $.fs.read(path)).trim()
      } catch { /* reported below */ }
      if (!apiKey) keyError = KEY_FILE_UNREADABLE
    } else if (cfg.staleKey) keyError = STALE_KEY
    return { cfg, client: apiKey ? new JevClient({ apiKey, ...cfg.jev }) : null, keyError, dir, mainEffort: fixedEffort(await $.env.get('JEV_MAIN_EFFORT')) }
  })()
  return setup
}

/** JEV_MAIN_EFFORT as a level; unset or empty is none, anything else that is no level is a setup error. */
export function fixedEffort(raw: string | undefined): Effort | null {
  const v = raw?.trim() ?? ''
  if (v === '') return null
  if (!isEffort(v)) throw new Error(`${MAIN_EFFORT_ENV}=${v} is not an effort level (low, medium, high, xhigh, max)`)
  return v
}

function io($: $): JevIo {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    now: () => $.clock.now(),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  }
}

const newTally = (): Tally => ({ checks: 0, passed: 0, failed: 0, raisesPassed: 0, jevMs: 0, lastStop: null })

function newLoop(cfg: ModConfig, inherited: Bounds | null): Loop {
  return {
    router: new EffortRouter({ jev: null, bounds: cfg.bounds }),
    prompt: '', tagged: null, inherited, profile: null, effort: null, model: null, clientEffort: null,
    ladder: new Ladder(), trail: [], next: null, tally: newTally(), skip: null,
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
 * prompt only; every later decision (task level, carried raise) stays inside it,
 * and the next prompt returns to the configured range. A subagent brief
 * without a tag of its own inherits the main prompt's range.
 */
function startPrompt(loop: Loop, prompt: string, cfg: ModConfig): void {
  loop.prompt = prompt
  const own = tagBounds(prompt, cfg)
  loop.tagged = own ? { bounds: own, inherited: false } : loop.inherited ? { bounds: loop.inherited, inherited: true } : null
  loop.router.bounds = loop.tagged?.bounds ?? cfg.bounds
  loop.ladder = new Ladder()
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
    taskMax: isEffort(v.taskMax) ? v.taskMax : v.max,
  }
}

async function writeRecord($: $, session: string, rec: SessionRecord): Promise<void> {
  await $.store.set(storeKey(session), rec)
  const keys = (await $.store.keys()).filter((k) => k.startsWith('session:'))
  for (const k of keys.slice(0, Math.max(0, keys.length - STORE_SESSIONS))) await $.store.delete(k)
}

/** A fresh record for a new prompt that starts at `effort`; `taskMax` carries a continuing task's highest level, else the start. */
const freshRecord = (prev: SessionRecord | null, effort: Effort, at: number, followUp: SessionRecord['followUp'], taskMax: Effort = effort): SessionRecord => ({
  max: effort, last: effort, followUp, at, prompt: (prev?.prompt ?? 0) + 1, carry: false, unfinished: false, pinned: pinned === true, taskMax: maxEffort(taskMax, effort),
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
  if (error === KEY_FILE_UNREADABLE) return 'key-file'
  if (error === STALE_KEY) return 'stale-key'
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
    ...(d.jevUsage ? { jevUsage: d.jevUsage } : {}),
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

/** The band's state for this loop after a decision: the prompt's trail, the task kind, and where the decision came from. */
function noteBand($: $, key: string, model: string, loop: Loop, d: EffortDecision): void {
  const phase = d.profile?.taskType ?? loop.profile?.taskType ?? null
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
    if (s.source === 'fixed') parts.push(MAIN_EFFORT_ENV)
  }
  if (s.done) parts.push('done')
  return parts.join(' · ')
}

/** The follow-up questions' history for a human prompt that comes after an agent turn. */
async function followUpAsk($: $, prev: SessionRecord, cfg: ModConfig): Promise<FollowUpAsk> {
  return {
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
  const { cfg, client, keyError, dir, mainEffort } = await load($)
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
  if (pinned || mainEffort) {
    loop.next = { kind: 'prompt', task: null }
    await writeRecord($, session, freshRecord(prev, pinned ? loop.effort ?? prev?.last ?? cfg.bounds.min : mainEffort!, await $.clock.now(), null))
    return null
  }

  const messages = (await $.session.messages({ as: 'api' })) as ApiMessage[]
  const dialogue = withPrompt(jevDialogue(messages, notes), text)
  // The follow-up questions need an agent turn before the prompt to judge.
  const followUp = human && cfg.followUp.mode && prev && messages.some((m) => m.role === 'assistant') ? await followUpAsk($, prev, cfg) : undefined
  loop.router.useJev(client ? client.bind(io($)) : null, keyError)
  loop.router.useModel(model)
  const decision = await loop.router.routeTask(dialogue, loop.effort, followUp)
  noteTag(loop, decision)
  loop.profile = decision.profile ?? loop.router.lastProfileFallback(text)
  const bounds = loop.router.bounds
  const f = decision.followUp

  // The level a continuing task has reached, handed to the new record; null for a new task.
  let taskCarry: Effort | null = null
  if (human && prev) {
    const trimmed = text.trim()
    // A short acknowledgement continues the work at hand: never start it below where the previous prompt ended.
    const ack = trimmed.length <= ACK_MAX_CHARS && (loop.profile.taskType === 'chat' || ACK.test(trimmed))
    let level = taskEffort(loop.profile, bounds, model).effort
    if (ack && rank(level) < rank(prev.last)) {
      level = clampEffort(prev.last, bounds.min, bounds.max)
      if (rank(level) > rank(decision.effort)) moveTo(decision, level, `short acknowledgement → stays at ${level}`)
    }
    // Start low, raise on failure: a level a task was raised to holds while the task goes on, so the next
    // message does not drop back and fail its way up again. Jev reads whether the message carries on the task.
    const sameTask = f?.continues !== undefined && f.continues >= CONTINUE_YES
    if (sameTask && rank(level) < rank(prev.taskMax)) {
      level = clampEffort(prev.taskMax, bounds.min, bounds.max)
      if (rank(level) > rank(decision.effort)) moveTo(decision, level, `same task (${f!.continues!.toFixed(2)}) → stays at ${level}`)
    }
    const continues = sameTask || ack || (f?.yes === true && !f.shadow) || (prev.unfinished && trimmed.length <= ACK_MAX_CHARS)
    if (continues) {
      loop.ladder = continued
      taskCarry = prev.taskMax
    }
    // The level held through the turn while a check kept failing: the prompt that continues the work starts one rung up.
    if (continues && prev.carry) {
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
  const rec = freshRecord(prev, decision.effort, at, f ? { yes: f.yes, streak: f.streak, hiLosses: f.hiLosses } : null, taskCarry ?? decision.effort)
  await writeRecord($, session, rec)
  loop.next = { kind: 'prompt', task: decision }
  const advisor = f?.advisor === true
  warnKey($, keyError)
  warnAuth($, decision)
  if (f?.raisedTo) $.ui.toast(`Jev: your message says the last turn went wrong → ${f.raisedTo}`)
  if (decision.carry) $.ui.toast(`Jev: a check still fails after a change → ${decision.effort}`)
  if (advisor) $.ui.toast('Jev: asking the model to consult the advisor')
  await journal($, dir, record(decision, {
    at, session, agent: MAIN, event: 'prompt', prompt: rec.prompt, origin, model, ...taggedField(loop),
    ...(f ? { correction: f.yes, advisorAvailable: followUp?.advisorAvailable } : {}),
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

/** Say once per module load why Jev is off although a key was configured. */
function warnKey($: $, keyError: string | null): void {
  if (!keyError || keyWarned) return
  keyWarned = true
  $.ui.toast(keyError === STALE_KEY
    ? 'Jev off: JEV_API_KEY is not read; set JEV_API_KEY_FILE to the OpenAI key file. Routing by heuristics'
    : 'Jev off: JEV_API_KEY_FILE could not be read; routing by heuristics')
}

/** Say once per module load that OpenAI refused the key (HTTP 401 or 403): each such decision falls back to heuristics. */
function warnAuth($: $, d: EffortDecision): void {
  if (authWarned) return
  const code = [errorCode(d.jevError), errorCode(d.followUp?.error)].find((c) => c === 'http-401' || c === 'http-403')
  if (!code) return
  authWarned = true
  $.ui.toast(`Jev: OpenAI refused the key (${code.replace('-', ' ').toUpperCase()}); routing by heuristics`)
}

/**
 * Whether a subagent's brief opens with the magpie-tasks marker. The brief is
 * the first user row of the plain view: that view keeps every row through a
 * compaction (measured on the main loop, 2026-11-09), while the api view then
 * opens with the summary. A subagent's brief never changes, so each id is read
 * until its brief is there, then not again.
 */
async function magpieTask($: $, agentId: string): Promise<boolean> {
  const known = magpieOwned.get(agentId)
  if (known !== undefined) return known
  const rows = await $.session.messages({ agentId })
  if (!Array.isArray(rows)) throw new Error(`subagent conversation not readable: ${rows.deny}`)
  const brief = rows.find((r) => r.role === 'user' && r.text)?.text
  if (brief === undefined) return false
  const owned = isMagpieTask(brief)
  magpieOwned.set(agentId, owned)
  for (const k of magpieOwned.keys()) {
    if (magpieOwned.size <= OWNER_AGENTS) break
    magpieOwned.delete(k)
  }
  return owned
}

const continuation = (loop: Loop): EffortDecision => ({
  kind: 'task', effort: loop.effort!, previous: loop.effort, changed: false, reasons: ['continues the last prompt'], source: 'local',
  jevLatencyMs: 0, ...(loop.profile ? { profile: loop.profile } : {}), policyVersion: policyVersion(),
})

/**
 * A subagent's run that follows a run whose check still failed after a change
 * starts one level above the higher of its own decision and the level the
 * last run held; its open checks carry over either way.
 */
function resumeSubagent(loop: Loop, d: EffortDecision, h: Held): void {
  loop.ladder = h.ladder
  if (!h.carry) return
  const bounds = loop.router.bounds
  const from = clampEffort(maxEffort(d.effort, h.effort), bounds.min, bounds.max)
  const to = clampEffort(shift(from, 1), bounds.min, bounds.max)
  if (rank(to) <= rank(from)) {
    d.reasons.push(`check still failing after a change in the last run, already ${from}`)
    return
  }
  const carried = loop.ladder.repeatFailing()
  d.carry = { from, to, checks: carried.length }
  for (const id of carried) loop.ladder.markRaised(id)
  moveTo(d, to, `check still failing after a change in the last run → ${to}`)
}

/** The level a turn starts at: the prompt's decision, the last prompt's level for a continuation, or a new task's from the conversation's newest message. */
async function startOfTurn($: $, loop: Loop, key: string, cfg: ModConfig, client: JevClient | null, keyError: string | null, agentId: string | undefined): Promise<EffortDecision> {
  const next = loop.next
  loop.next = null
  if (key === MAIN && next?.kind === 'prompt' && next.task) return next.task
  // A background task's report (or a turn no prompt started) continues the last prompt: same level, range and open checks.
  if (key === MAIN && next?.kind !== 'command' && loop.effort !== null) return continuation(loop)
  // A slash command's expanded body, a subagent's brief, or the message that resumed it: the newest user-side message.
  const messages = agentId ? await $.session.messages({ agentId, as: 'api' }) : await $.session.messages({ as: 'api' })
  if (!Array.isArray(messages)) throw new Error(`subagent conversation not readable: ${messages.deny}`)
  const dialogue = jevDialogue(messages, notes)
  const text = latestUserText(dialogue)
  if (key === MAIN && next?.kind === 'command') mainTag = tagBounds(text, cfg)
  startPrompt(loop, text, cfg)
  loop.router.useJev(client ? client.bind(io($)) : null, keyError)
  loop.router.useModel(loop.model)
  const d = await loop.router.routeTask(dialogue, loop.effort)
  noteTag(loop, d)
  loop.profile = d.profile ?? loop.router.lastProfileFallback(text)
  const h = agentId ? held.get(agentId) : undefined
  if (h) {
    held.delete(agentId!)
    resumeSubagent(loop, d, h)
  }
  warnKey($, keyError)
  warnAuth($, d)
  if (key === MAIN) {
    const session = await $.session.id()
    await writeRecord($, session, freshRecord(await readRecord($, session), d.effort, await $.clock.now(), null))
  }
  return d
}

async function decideStep($: $, e: { index: number; model: string; effort?: unknown; agentId?: string; turnId: string }): Promise<Effort | undefined> {
  if (!isEffort(e.effort) || !routed(e.model)) return undefined
  const { cfg, client, keyError, dir, mainEffort } = await load($)
  const key = e.agentId ?? MAIN
  const loop = loopFor(key, cfg)
  const session = await $.session.id()

  // A subagent magpie-tasks routes: its effort is that plugin's, so this one
  // neither sets a level nor reads a change of it as the person's /effort.
  if (e.agentId && loop.skip === null) {
    loop.skip = await magpieTask($, e.agentId)
    if (loop.skip) {
      await journal($, dir, { at: await $.clock.now(), session, agent: key, event: 'skip', reason: 'magpie-tasks', step: e.index, turnId: e.turnId, model: e.model, policy: policyVersion() })
    }
  }
  if (loop.skip) return undefined
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
    if (e.index === 0 || loop.effort !== e.effort) {
      decision = { kind: e.index === 0 ? 'task' : 'step', effort: e.effort, previous: loop.effort, changed: loop.effort !== e.effort, reasons: ['/effort pin'], source: 'pinned', jevLatencyMs: 0, policyVersion: policyVersion() }
    }
  } else if (key === MAIN && mainEffort) {
    // The session's fixed level: no Jev, no ladder, no exploration.
    if (e.index === 0) loop.next = null
    if (e.index === 0 || loop.effort !== mainEffort) {
      decision = { kind: e.index === 0 ? 'task' : 'step', effort: mainEffort, previous: loop.effort, changed: loop.effort !== mainEffort, reasons: [MAIN_EFFORT_ENV], source: 'fixed', jevLatencyMs: 0, policyVersion: policyVersion() }
    }
  } else if (e.index === 0 || loop.effort === null) {
    decision = await startOfTurn($, loop, key, cfg, client, keyError, e.agentId)
    loop.tally.jevMs += decision.jevLatencyMs
  }

  if (decision) {
    loop.effort = decision.effort
    pushTrail(loop, decision.effort)
    noteBand($, key, e.model, loop, decision)
    if (key === MAIN && decision.kind === 'step') {
      const rec = await readRecord($, session)
      if (rec) await writeRecord($, session, { ...rec, max: maxEffort(rec.max, decision.effort), last: decision.effort, taskMax: maxEffort(rec.taskMax, decision.effort) })
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
  // A subagent's open checks wait for its next run (SendMessage resumes the same id).
  if (key !== MAIN) holdSubagent(key, loop, carry > 0)
  const t = loop.tally
  loop.tally = newTally()
  await journal($, dir, {
    at: await $.clock.now(), session, agent: key, event: 'outcome', turnId: e.turnId, ...(rec ? { prompt: rec.prompt } : {}),
    model: loop.model, effort: loop.effort, trail: [...loop.trail], reason: e.reason, durationMs: e.durationMs, jevWaitMs: t.jevMs,
    ...(e.usage ? { outputTokens: e.usage.output_tokens, inputTokens: e.usage.input_tokens, cacheReadTokens: e.usage.cache_read_input_tokens, cacheCreationTokens: e.usage.cache_creation_input_tokens } : {}),
    checks: { run: t.checks, passed: t.passed, failed: t.failed }, raisesPassed: t.raisesPassed,
    carry, unfinished, ...(pinned ? { manual: true } : {}), policy: policyVersion(),
  })
}

function holdSubagent(agentId: string, loop: Loop, carry: boolean): void {
  held.delete(agentId)
  if (loop.ladder.open === 0 || loop.effort === null) return
  held.set(agentId, { effort: loop.effort, ladder: loop.ladder, carry })
  for (const k of held.keys()) {
    if (held.size <= HELD_AGENTS) break
    held.delete(k)
  }
}

export const register: Register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    // A prompt delivered into a running turn joins that turn's steps.
    if (e.turnId !== undefined) return next(e)
    // magpie-tasks' relay: the session's record and the next turn's start stay as the last prompt left them.
    if (e.origin.kind === 'plugin' && e.origin.name === 'magpie-tasks' && e.text.startsWith(MAGPIE_TASKS_RELAY)) return next(e)
    let context = e.context
    try {
      if (CONTINUING_ORIGINS.has(e.origin.kind)) await markTurn($, 'continue', e.text)
      else if (SLASH_COMMAND.test(e.text.trim())) await markTurn($, 'command', e.text)
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
    let effort: Effort | undefined
    try {
      // A subagent magpie-tasks routes has its band line from that plugin, whatever its model.
      if (!e.agentId || !(await magpieTask($, e.agentId))) noteModel($, e.agentId ?? MAIN, e.model)
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
  // first request. Nothing for a subagent before its first request or for one
  // magpie-tasks routes (that plugin, inside this one, draws its line), and
  // nothing over a survey. The line sits on top of what the hooks beneath
  // draw: where the engine nests every plugin's hook in one chain (2.1.322 and
  // earlier), user plugins wrap the built-in ones, so a band that skipped
  // next() would hide the built-in You should know plugin's Heads up offers.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const key = e.props.view.agentId ?? MAIN
    const s = band.get(key) ?? (key === MAIN ? { model: await $.session.model(), trail: [], phase: null, source: null, done: false } : undefined)
    if (!s) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="warning">{bandLine(s)}</Text>
        {below}
      </Box>
    )
  })

  // A turn's outcome is journaled; a subagent run's routing state ends with
  // it (its open checks wait in `held` for a resumed run), while its band
  // line stays, marked done, for whoever reads its transcript. The main
  // loop's lives for the session.
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

  // Another plugin's note is no one's message: Jev's view drops it by its text.
  on('session.append', { door: 'note' }, ($, e, next) => {
    if (e.origin.kind === 'plugin') {
      for (const b of e.message.content) {
        const text = b.type === 'text' && typeof b.text === 'string' ? b.text.trim() : ''
        if (!text) continue
        notes.delete(text)
        notes.add(text)
      }
      for (const old of notes) {
        if (notes.size <= NOTES_KEPT) break
        notes.delete(old)
      }
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    loops.clear()
    notes.clear()
    band.clear()
    held.clear()
    magpieOwned.clear()
    pinned = null
    mainTag = null
    return next(e)
  })
}
