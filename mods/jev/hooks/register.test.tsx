import type { On, Register } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { ADVISOR_NOTE } from './register'
import { jevDialogue } from '../src/dialogue'
import { mainBeforeChannel } from '../tests/api-messages'

// The world beneath the mod: config file, journal, Jev, session and model are
// answered by the test's own hooks; the engine's $ drives the mod's hooks.
// Jev's replies are scripted in the shape OpenAI's Decisions API answers.

const DIR = '/cfg/jev-opus'
/** The clock starts at 1000 ms after the epoch: every row lands in that day's journal. */
const JOURNAL = `${DIR}/mod-journal-1970-01-01.jsonl`
const NO_KEY = [
  'JEV_OPUS_MIN_EFFORT=medium',
  'JEV_OPUS_MAX_EFFORT=max',
  'JEV_OPUS_EXPLORE=0',
].join('\n')
const DECISIONS_URL = 'https://api.openai.com/v1/decisions'
/** Where these tests' .env points JEV_API_KEY_FILE; world() writes the key there. */
const KEY_FILE = '/keys/openai-jev.key'
const ENV = [
  `JEV_API_KEY_FILE=${KEY_FILE}`,
  'JEV_DEADLINE_MS=3500',
  // Starts at high or above: these tests drive the ladder, carry-over and pins from a fixed start; the per-model tables have tests of their own.
  'JEV_OPUS_MIN_EFFORT=high',
  'JEV_OPUS_MAX_EFFORT=max',
  'JEV_OPUS_DISSAT_YES=0.75',
  'JEV_OPUS_EXPLORE=0',
].join('\n')

/** No Jev key and default bounds; exploration off, so a heuristic start is what the test sees. */
const NO_JEV = 'JEV_OPUS_EXPLORE=0'

type Answers = Record<string, unknown>
type Msg = { role: string; content: unknown }
type JevInput = Array<{ role: string; content: string }>

interface World {
  files: Map<string, string>
  /** the journal appends, as `$.process.run` received them */
  appends: Array<{ argv: readonly string[] }>
  asks: Array<{ url: string; questions: string[]; input: JevInput; model: string; auth: string | undefined }>
  steps: Array<{ index: number; effort: unknown; agentId?: string }>
  contexts: Array<readonly string[] | undefined>
  status: string[]
  toasts: string[]
  /** `$.ui.invalidate` calls: the band asked to redraw */
  invalidates: number
  messages: Msg[]
  clock: ReturnType<typeof mock.clock>
  /** the next Bash call's outcome */
  fail: boolean
  /** files on disk, by absolute path: their modification time */
  mtimes: Map<string, number>
  /** the paths `$.fs.stat` was asked about */
  stats: string[]
}

interface Opts {
  env?: string | null
  /** Jev's answers for one ask, per question; null from it = never answers */
  jev?: (questions: string[], input: JevInput) => Answers | null
  /** Jev answers with this HTTP status */
  down?: number
  settings?: Record<string, unknown>
  /** each subagent's conversation, oldest first: its brief, its replies, the messages that resumed it */
  agentRows?: Record<string, Array<{ role: 'user' | 'assistant'; text: string }>>
  store?: Record<string, unknown>
  /** session.id throws: every routing hook fails */
  brokenSession?: boolean
  /** the session's model as $.session.model() reports it */
  model?: string
  /** answers a tool call before the world's own handler; undefined falls through */
  tool?: (e: any) => any
  /** extra files, by absolute path */
  files?: Record<string, string>
}

/** Peaked answers, so the recomputed confidence clears every gate. */
const choice = (c: string, keys: string[]) => ({ choice: c, confidence: 0.9, probabilities: Object.fromEntries(keys.map((k) => [k, k === c ? 0.92 : 0.08 / (keys.length - 1)])) })
const TYPES = ['chat', 'explain', 'operate', 'write', 'design', 'code', 'research']

/** The newest message of a Jev input: what the decision is about. */
const latest = (input: JevInput) => input.at(-1)?.content ?? ''

/** Deterministic Jev: a code task; the newest message faults the last turn on 不对 or wrong. */
export function stubJev(questions: string[], input: JevInput): Answers {
  const out: Answers = {}
  if (questions.includes('task_type')) Object.assign(out, { task_type: choice('code', TYPES), deep: { noul: 0.3 } })
  if (questions.includes('dissatisfied')) out.dissatisfied = { noul: /不对|wrong/.test(latest(input)) ? 0.9 : 0.1 }
  return out
}

/** Per-question answers as the Decisions API's `answers` array. */
function decisionsAnswers(answers: Answers): unknown[] {
  return Object.entries(answers).map(([name, a]: [string, any]) => ('noul' in a ? { type: 'predicate', name, probability: a.noul } : { type: 'choice', name, ...a }))
}

const apiText = (r: { role: string; text: string }): Msg => ({ role: r.role, content: [{ type: 'text', text: r.text }] })

function world(on: On, o: Opts = {}): World {
  const w: World = { files: new Map(Object.entries({ [KEY_FILE]: 'test-key\n', ...o.files })), appends: [], asks: [], steps: [], contexts: [], status: [], toasts: [], invalidates: 0, messages: [], clock: mock.clock(on, { now: 1_000 }), fail: false, mtimes: new Map(), stats: [] }
  if (o.env !== null) w.files.set(`${DIR}/.env`, o.env ?? ENV)
  mock.env(on, { HOME: '/home/u', JEV_OPUS_CONFIG_DIR: DIR })
  mock.store(on, o.store ?? {})
  on('fs.read', ($, e) => (w.files.has(e.path) ? { value: w.files.get(e.path)! } : { deny: `ENOENT ${e.path}` }))
  on('fs.write', ($, e) => (w.files.set(e.path, e.text), { value: undefined }))
  on('fs.stat', ($, e) => {
    w.stats.push(e.path)
    const mtimeMs = w.mtimes.get(e.path)
    return mtimeMs === undefined ? { deny: `ENOENT ${e.path}` } : { value: { kind: 'file' as const, size: 1, mtimeMs, isLink: false } }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  // The journal's append: `sh -c 'mkdir -p "$1" && cat >> "$2"' sh <dir> <file>` with the row on stdin.
  on('process.run', ($, e) => {
    w.appends.push({ argv: e.argv })
    const path = e.argv[5]!
    w.files.set(path, (w.files.get(path) ?? '') + (e.init?.stdin ?? ''))
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  const jev = o.jev ?? stubJev
  on('http.fetch', async ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as { model: string; input: JevInput; questions: Array<{ name: string }> }
    const questions = body.questions.map((q) => q.name)
    w.asks.push({ url: e.url, questions, input: body.input, model: body.model, auth: e.init?.headers?.Authorization })
    if (o.down) return { value: { status: o.down, ok: false, headers: {}, text: 'down' } }
    const answers = jev(questions, body.input)
    if (!answers) return new Promise(() => {}) // never answers: the deadline decides
    const usage = { input_tokens: 4000 + 100 * body.input.length, input_tokens_details: { cached_tokens: w.asks.length > 1 ? 4000 : 0 } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: body.model, answers: decisionsAnswers(answers), usage }) } }
  })
  on('session.id', () => {
    if (o.brokenSession) throw new Error('boom')
    return { value: 'sess-1' }
  })
  on('session.model', () => ({ value: o.model ?? 'claude-opus-5-5' }))
  on('session.messages', ($, e) => {
    if (e.agentId) {
      const rows = o.agentRows?.[e.agentId] ?? []
      return { value: (e.as === 'api' ? rows.map(apiText) : rows.map((r) => ({ ...r, toolUses: [] }))) as never }
    }
    return { value: w.messages as never }
  })
  on('settings.read', () => ({ value: (o.settings ?? {}) as never }))
  on('tool.list', () => ({ value: [] }))
  on('ui.status', ($, e) => (w.status.push(e.text ?? ''), { value: undefined }))
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ((w.invalidates += 1), { value: undefined }))
  // The engine's own drawing, where the mod leaves the band to it.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.PostModelSwitch', () => ({}))
  on('prompt.submit', ($, e) => (w.contexts.push(e.context), { text: e.text, context: e.context, origin: e.origin }))
  on('turn.step', async function* ($, e) {
    w.steps.push({ index: e.index, effort: e.effort, ...(e.agentId ? { agentId: e.agentId } : {}) })
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'working on it', toolUses: [], stopReason: 'tool_use', usage: null }
  })
  on('tool.call', ($, e) => {
    const own = o.tool?.(e)
    if (own !== undefined) return own
    if (e.tool === 'Bash') {
      return w.fail
        ? { isError: true as const, result: 'Exit code 1', text: 'not ok 1 - adds\n# tests 1\n# pass 0\n# fail 1\nExit code 1' }
        : { result: { stdout: '# tests 1\n# pass 1\n# fail 0', stderr: '', interrupted: false } as never, text: '# tests 1\n# pass 1\n# fail 0' }
    }
    return { result: { ok: true } as never, text: 'The file has been updated.' }
  })
  return w
}

const OPUS = 'claude-opus-5-5'
const MYTHOS = 'claude-mythos-5-1'

async function step($: any, index: number, effort: unknown = 'xhigh', extra: Record<string, unknown> = {}): Promise<void> {
  const s = $.turn.step({ turnId: 'turn-1', index, model: OPUS, effort, messageCount: 3 + index, ...extra })
  for await (const _ of s) { /* drain */ }
}

const submit = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' } })
const submitAs = ($: any, text: string, kind: string) => $.prompt.submit({ text, wait: false, origin: kind === 'channel' ? { kind, server: 'plugin:telegram:telegram' } : { kind } })
const bash = (w: World, $: any, command: string, fail = false) => ((w.fail = fail), $.tool.call({ tool: 'Bash', command }))
const edit = ($: any, file: string) => $.tool.call({ tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b' })
const sent = (w: World) => w.steps.map((s) => s.effort)
const journal = (w: World) => (w.files.get(JOURNAL) ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>)
const rows = (w: World, event: string) => journal(w).filter((r) => r.event === event)
const complete = ($: any, agentId?: string, extra: Record<string, unknown> = {}) => $.turn.complete({ turnId: 'turn-1', answer: 'done', durationMs: 1_000, isAborted: false, reason: 'answer', ...(agentId ? { agentId } : {}), ...extra })
const say = (w: World, role: 'user' | 'assistant', text: string) => w.messages.push({ role, content: role === 'user' ? text : [{ type: 'text', text }] })

/** One loop of a failing check, a code change and the same check failing again, each followed by the next request (session effort high). */
async function failEditFail($: any, w: World, from: number, model = OPUS, command = 'npm test'): Promise<number> {
  await bash(w, $, command, true)
  await step($, from, 'high', { model })
  await edit($, '/repo/add.js')
  await step($, from + 1, 'high', { model })
  await bash(w, $, command, true)
  await step($, from + 2, 'high', { model })
  return from + 3
}

const BAND = { plugin: 'jev', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const
/** The band's line for the transcript in view (the main conversation unless an agent is named); `engine` where the mod left the band to the engine. */
async function bandText($: any, view: { agentId?: string } = {}, surface: 'terminal' | 'desktop' = 'terminal', hasSurvey = false): Promise<string | undefined> {
  const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, hasSurvey, view } })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return text
}

describe('task routing', () => {
  test('decision 1: on Opus the prompt\'s level holds for the whole turn; failing checks, a change and a repeat failure change nothing mid-loop', async ($, on) => {
    const w = world(on)
    await submit($, 'add a unit test for add() and fix the bug')
    await step($, 0, 'high')
    const next = await failEditFail($, w, 1)
    await bash(w, $, 'npm test')
    await step($, next, 'high')
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high', 'high'])
    expect(journal(w).map((r) => r.event)).toEqual(['prompt', 'step', 'check', 'check', 'check'])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'repeat-failure', 'pass'])
    expect(rows(w, 'step')[0]).toMatchObject({ model: OPUS, sessionEffort: 'high', effort: 'high', policy: 'policy.v17' })
    // Jev is asked once, for the task: no step questions.
    expect(w.asks.map((a) => a.questions)).toEqual([['task_type', 'deep']])
    expect(w.status).toEqual([])
    expect(w.asks[0]!.auth).toBe('Bearer test-key')
    expect(w.asks[0]!.url).toBe(DECISIONS_URL)
    expect(w.asks[0]!.model).toBe('gpt-6-luna')
    expect(await bandText($)).toBe('Opus 5.5 · ◆ Jev · HIGH · code')
  })

  test('the journal holds no prompt text and no key', async ($, on) => {
    const w = world(on)
    await submit($, 'secret-prompt-words please fix')
    await step($, 0)
    await bash(w, $, 'npm test -- --grep secret-command-words', true)
    const text = w.files.get(JOURNAL) ?? ''
    expect(text).toContain('"event":"check"')
    expect(text).not.toContain('secret-prompt-words')
    expect(text).not.toContain('secret-command-words')
    expect(text).not.toContain('test-key')
  })

  test('the journal is a daily file, each row one append through `>>`', async ($, on) => {
    const w = world(on)
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    expect(w.appends.length).toBe(2)
    expect(w.appends[0]!.argv).toEqual(['sh', '-c', 'mkdir -p "$1" && cat >> "$2"', 'sh', DIR, JOURNAL])
    expect([...w.files.keys()].some((k) => k.endsWith('/mod-journal.jsonl'))).toBe(false)
  })

  test('no config: heuristics only, no network', async ($, on) => {
    const w = world(on, { env: NO_JEV })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    await bash(w, $, 'npm test', true)
    await step($, 1)
    expect(w.asks.length).toBe(0)
    // default bounds low..high: code on Opus 5.5 starts low
    expect(sent(w)).toEqual(['low', 'low'])
    expect(journal(w)[0]!.source).toBe('heuristic')
  })

  test('the key comes from JEV_API_KEY_FILE; ~/ is the home folder', async ($, on) => {
    const w = world(on, { env: `${ENV}\nJEV_API_KEY_FILE=~/.config/jev-opus/openai-jev.key`, files: { '/home/u/.config/jev-opus/openai-jev.key': 'sk-from-file\n' } })
    await submit($, 'fix the crash in parser.ts')
    expect(w.asks.map((a) => a.auth)).toEqual(['Bearer sk-from-file'])
    expect(journal(w)[0]).toMatchObject({ source: 'jev', jevProvider: 'api.openai.com' })
    expect(w.files.get(JOURNAL)).not.toContain('sk-from-file')
  })

  test('JEV_API_KEY without JEV_API_KEY_FILE (the jev-opus .env of a local service): Jev off, nothing sent, every decision row and one toast say why', async ($, on) => {
    // The keys of the .env jev-opus used with its own service; the value must reach no one.
    const env = ['JEV_API_KEY=local-service-key', 'JEV_BASE_URL=http://127.0.0.1:18016', 'JEV_FALLBACK_FORMAT=openai-decisions', 'JEV_FALLBACK_API_KEY=fallback-key', 'JEV_OPUS_EXPLORE=0'].join('\n')
    const w = world(on, { env, files: { [KEY_FILE]: '' } })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    await complete($)
    await submit($, 'now the lexer')
    expect(w.asks).toHaveLength(0)
    expect(rows(w, 'prompt').map((r) => [r.source, r.jevError])).toEqual([['heuristic', 'stale-key'], ['heuristic', 'stale-key']])
    expect(w.toasts.filter((t) => t.includes('JEV_API_KEY is not read'))).toHaveLength(1)
    expect(w.files.get(JOURNAL)).not.toContain('local-service-key')
  })

  test('OpenAI refusing the key (HTTP 401): heuristics, the journal says why, and one toast for the session', async ($, on) => {
    const w = world(on, { down: 401 })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    await complete($)
    await submit($, 'now the lexer')
    expect(w.asks).toHaveLength(2)
    expect(rows(w, 'prompt').map((r) => [r.source, r.jevError])).toEqual([['heuristic', 'http-401'], ['heuristic', 'http-401']])
    expect(w.toasts.filter((t) => t.includes('OpenAI refused the key (HTTP 401)'))).toHaveLength(1)
  })

  test('an unreadable key file: heuristics only, nothing leaves the machine, every decision row says why and one toast', async ($, on) => {
    const w = world(on, { env: `${ENV}\nJEV_API_KEY_FILE=/keys/missing.key` })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    await complete($)
    await submit($, 'now the lexer')
    expect(w.asks.length).toBe(0)
    expect(rows(w, 'prompt').map((r) => [r.source, r.jevError])).toEqual([['heuristic', 'key-file'], ['heuristic', 'key-file']])
    expect(w.toasts.filter((t) => t.includes('JEV_API_KEY_FILE'))).toHaveLength(1)
  })

  test('Jev past its deadline: heuristics, the request is not held', async ($, on) => {
    const w = world(on, { jev: () => null })
    const pending = submit($, 'fix the crash in parser.ts')
    await w.clock.advance(3_500)
    await pending
    await step($, 0)
    expect(sent(w)).toEqual(['high'])
    expect(w.asks).toHaveLength(1)
    expect(journal(w)[0]).toMatchObject({ source: 'heuristic', jevError: 'deadline', jevProvider: 'api.openai.com' })
  })

  test('without JEV_DEADLINE_MS Jev is waited for 10000 ms', async ($, on) => {
    const w = world(on, { env: ENV.replace('JEV_DEADLINE_MS=3500\n', ''), jev: () => null })
    let done = false
    const pending = submit($, 'fix the crash in parser.ts').then(() => { done = true })
    await w.clock.advance(9_999)
    expect(done).toBe(false)
    await w.clock.advance(1)
    await pending
    expect(journal(w)[0]).toMatchObject({ source: 'heuristic', jevError: 'deadline' })
  })

  test('an HTTP error from Jev (OpenAI refusing, e.g. a rate limit): heuristics, and the journal says why', async ($, on) => {
    const w = world(on, { down: 429 })
    await submit($, 'add a unit test for add() and fix the bug')
    await step($, 0)
    expect(sent(w)).toEqual(['high'])
    expect(w.asks).toHaveLength(1)
    expect(journal(w)[0]).toMatchObject({ source: 'heuristic', jevError: 'http-429', jevProvider: 'api.openai.com' })
  })

  test('a deep 0.95 starts code at xhigh on Mythos', async ($, on) => {
    const deep = (q: string[], input: JevInput) => ({ ...stubJev(q, input), deep: { noul: 0.95 } })
    const healthy = world(on, { jev: deep, model: MYTHOS })
    await submit($, 'rewrite the scheduler')
    expect(journal(healthy)[0]!.effort).toBe('xhigh')
  })

  test('an unsure kind starts at high on Opus 5.5 and on Mythos alike', async ($, on) => {
    const flat = { choice: 'explain', confidence: 0.2, probabilities: Object.fromEntries(TYPES.map((k) => [k, k === 'explain' ? 0.25 : 0.75 / (TYPES.length - 1)])) }
    const unsure = (q: string[], input: JevInput) => ({ ...stubJev(q, input), task_type: flat })
    const opus = world(on, { jev: unsure })
    await submit($, 'what about the other one')
    expect(journal(opus)[0]).toMatchObject({ model: OPUS, effort: 'high' })
    expect(journal(opus)[0]!.reasons[0]).toMatch(/^kind unsure \(0\.\d\d\) → high$/)
  })

  test('an unsure kind on Mythos starts at high too', async ($, on) => {
    const flat = { choice: 'explain', confidence: 0.2, probabilities: Object.fromEntries(TYPES.map((k) => [k, k === 'explain' ? 0.25 : 0.75 / (TYPES.length - 1)])) }
    const w = world(on, { model: MYTHOS, jev: (q, input) => ({ ...stubJev(q, input), task_type: flat }) })
    await submit($, 'what about the other one')
    expect(journal(w)[0]).toMatchObject({ model: MYTHOS, effort: 'high' })
  })

  test('a non-Opus model and a numeric effort pass through untouched', async ($, on) => {
    const w = world(on)
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'xhigh', { model: 'claude-haiku-4-5' })
    await step($, 1, 3)
    expect(sent(w)).toEqual(['xhigh', 3])
  })

  test('a Fable session: the prompt is not routed either, so Jev is never asked', async ($, on) => {
    const w = world(on, { model: 'claude-fable-5-1' })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'high', { model: 'claude-fable-5-1' })
    expect(w.asks.length).toBe(0)
    expect(journal(w)).toEqual([])
    expect(sent(w)).toEqual(['high'])
  })

  test('a jev/ model is left to the jev-opus gateway', async ($, on) => {
    const w = world(on)
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'xhigh', { model: 'jev/claude-opus-5-5[1m]' })
    expect(sent(w)).toEqual(['xhigh'])
  })

  test('a hook failure leaves the request as the engine made it', async ($, on) => {
    const w = world(on, { brokenSession: true })
    await step($, 0, 'xhigh')
    expect(sent(w)).toEqual(['xhigh'])
  })
})

describe('the ladder', () => {
  test('on Mythos, as on Opus, the level holds through repeat failures; the next prompt that continues the work starts one level up', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'high', { model: MYTHOS })
    let n = await failEditFail($, w, 1, MYTHOS)
    await edit($, '/repo/add.js')
    await bash(w, $, 'npm test', true)
    await step($, n++, 'high', { model: MYTHOS })
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high', 'high'])
    expect(rows(w, 'step').filter((r) => r.kind === 'step')).toEqual([])
    expect(await bandText($)).toBe('Mythos 5.1 · ◆ Jev · HIGH · code')
    await complete($)
    expect(rows(w, 'outcome')[0]).toMatchObject({ carry: 1, checks: { run: 3, passed: 0, failed: 3 } })
    expect(rows(w, 'outcome')[0]!.raises).toBeUndefined()
    say(w, 'user', 'fix the crash in parser.ts'); say(w, 'assistant', 'still failing')
    await submit($, '继续')
    await step($, 0, 'high', { model: MYTHOS, turnId: 'turn-2' })
    expect(sent(w).at(-1)).toBe('xhigh')
    expect(rows(w, 'prompt').at(-1)).toMatchObject({ effort: 'xhigh', carry: { from: 'high', to: 'xhigh', checks: 1 } })
    await bash(w, $, 'npm test')
    await complete($, undefined, { turnId: 'turn-2' })
    expect(rows(w, 'outcome').at(-1)).toMatchObject({ raisesPassed: 1, carry: 0 })
  })

  test('decision 3: a first failure and a rerun without a change raise nothing; there is no stuck bypass', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'high', { model: MYTHOS })
    await bash(w, $, 'npm test', true)
    await step($, 1, 'high', { model: MYTHOS })
    await bash(w, $, 'npm test', true)
    await step($, 2, 'high', { model: MYTHOS })
    // the same file edited four times with the failure open: no longer a raise by itself
    for (let i = 0; i < 4; i++) await edit($, '/repo/parser.ts')
    await step($, 3, 'high', { model: MYTHOS })
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high'])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'rerun-failure'])
  })

  test('decision 4: a piped run, `|| true`, a lookup, a one-off script and a denied call never move the ladder', async ($, on) => {
    const w = world(on, { model: MYTHOS, tool: (e) => (e.tool === 'Bash' && e.command.startsWith('denied') ? { deny: 'not allowed' } : undefined) })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'high', { model: MYTHOS })
    let n = 1
    for (const command of ['npm test 2>&1 | tail -30', 'npm test || true', 'ls /missing', 'bun run scripts/precision.ts', 'denied npm test']) {
      n = await failEditFail($, w, n, MYTHOS, command)
    }
    expect(sent(w).every((e) => e === 'high')).toBe(true)
    expect(rows(w, 'check')).toEqual([])
  })

  test('decision 4: the verdict is the exit code; a pass with failure text is a pass, an interrupted or backgrounded run is no verdict', async ($, on) => {
    const w = world(on, { model: MYTHOS, tool: (e) => {
      if (e.command === 'pytest -q') return { result: { stdout: 'FAILED test_a.py::test_x\nTraceback (most recent call last)', stderr: '', interrupted: false }, text: 'FAILED test_a.py::test_x' }
      if (e.command === 'cargo test') return { isError: true, result: { stdout: '', stderr: '', interrupted: true }, text: 'interrupted' }
      if (e.command === 'go test ./...') return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: 'moved to the background' }
      return undefined
    } })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'high', { model: MYTHOS })
    await bash(w, $, 'pytest -q')
    await bash(w, $, 'cargo test')
    await bash(w, $, 'go test ./...')
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['pass'])
  })

  test('B9: words in a failing check\'s command or output ("invalid credentials", "connection refused") do not make it an environment blocker', async ($, on) => {
    const w = world(on, { model: MYTHOS, tool: (e) => (e.tool === 'Bash' && w.fail
      ? { isError: true, result: 'Exit code 1', text: 'not ok 1 - rejects a bad password: connection refused\n# fail 1\nExit code 1' }
      : undefined) })
    await submit($, 'fix the login test')
    await step($, 0, 'high', { model: MYTHOS })
    await failEditFail($, w, 1, MYTHOS, 'npm test -- --grep "invalid credentials"')
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'repeat-failure'])
    await complete($)
    expect(rows(w, 'outcome')[0]).toMatchObject({ carry: 1 })
  })

  test('B1: WebFetch never counts, whatever its HTTP status', async ($, on) => {
    const w = world(on, { model: MYTHOS, tool: (e) => (e.tool === 'WebFetch'
      ? { result: { bytes: 4, code: 200, codeText: 'OK', result: 'docs', durationMs: 5, url: e.url }, text: 'docs' }
      : undefined) })
    await submit($, 'fix the parser crash')
    await step($, 0, 'high', { model: MYTHOS })
    await $.tool.call({ tool: 'WebFetch', url: 'https://docs.example/a', prompt: 'read' })
    await step($, 1, 'high', { model: MYTHOS })
    await $.tool.call({ tool: 'WebFetch', url: 'https://docs.example/b', prompt: 'read' })
    await step($, 2, 'high', { model: MYTHOS })
    await bash(w, $, 'npm test', true)
    await step($, 3, 'high', { model: MYTHOS })
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high'])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure'])
  })

  test('B3: a denied Write is no change and no failure', async ($, on) => {
    const w = world(on, { model: MYTHOS, tool: (e) => (e.tool === 'Write' ? { deny: 'Subagents should return findings as text, not write report files' } : undefined) })
    await submit($, 'add a helper to util.ts and test it')
    await step($, 0, 'high', { model: MYTHOS })
    await bash(w, $, 'npm test', true)
    const r = await $.tool.call({ tool: 'Write', file_path: '/repo/REPORT.md', content: 'x' })
    expect(r.deny).toBeDefined()
    await step($, 1, 'high', { model: MYTHOS })
    await bash(w, $, 'npm test', true)
    await step($, 2, 'high', { model: MYTHOS })
    expect(sent(w)).toEqual(['high', 'high', 'high'])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'rerun-failure'])
  })
})

describe('code changes by Bash', () => {
  const SED = "sed -i 's/return a - b;/return a * b;/' add.js"
  /** sed rewrites add.js whenever it runs, as `sed -i … add.js missing.js` does before it fails on the missing file. */
  const sedWrites = (w: World, e: any) => {
    if (e.tool === 'Bash' && e.command.startsWith('sed -i')) w.mtimes.set('/repo/add.js', w.clock.now())
    return undefined
  }

  /** A prompt, then npm test failing, the command, and npm test failing again, each followed by the next request. */
  async function failRunFail($: any, w: World, command: string, model: string, fail = false): Promise<void> {
    w.mtimes.set('/repo/add.js', 0)
    await submit($, 'fix add() so its test passes')
    await step($, 0, 'high', { model })
    await bash(w, $, 'npm test', true)
    await step($, 1, 'high', { model })
    await bash(w, $, command, fail)
    await step($, 2, 'high', { model })
    await bash(w, $, 'npm test', true)
    await step($, 3, 'high', { model })
  }

  test('npm test fails, a sed -i rewrites add.js, npm test fails again: a repeat failure, the level holds, the turn ends carrying the check, and the next "继续" starts at xhigh', async ($, on) => {
    const w = world(on, { tool: (e) => sedWrites(w, e) })
    await failRunFail($, w, SED, OPUS)
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'repeat-failure'])
    expect(w.stats).toEqual(['/repo/add.js'])
    // A code change writes no journal row, from the Edit tool or from Bash.
    expect(journal(w).map((r) => r.event)).toEqual(['prompt', 'step', 'check', 'check'])
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high'])
    await complete($)
    expect(rows(w, 'outcome')[0]).toMatchObject({ carry: 1, checks: { run: 2, passed: 0, failed: 2 } })
    say(w, 'user', 'fix add() so its test passes'); say(w, 'assistant', 'still failing')
    await submit($, '继续')
    expect(rows(w, 'prompt').at(-1)).toMatchObject({ effort: 'xhigh', carry: { from: 'high', to: 'xhigh', checks: 1 } })
  })

  test('a sed that exits non-zero is no change, though it rewrote add.js before failing', async ($, on) => {
    const w = world(on, { model: MYTHOS, tool: (e) => sedWrites(w, e) })
    await failRunFail($, w, `${SED} missing.js`, MYTHOS, true)
    expect(w.mtimes.get('/repo/add.js')).toBe(1_000)
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high'])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'rerun-failure'])
    expect(w.stats).toEqual([])
  })

  test('a successful command whose files kept their old time is no change', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await failRunFail($, w, 'git checkout -- add.js', MYTHOS)
    expect(w.stats).toEqual(['/repo/add.js'])
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high'])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'rerun-failure'])
  })

  test('a file the stat cannot find (moved by the same command) counts; relative paths follow the command\'s cd', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await failRunFail($, w, "cd lib && sed -i 's/x/y/' old.js && git mv old.js add.js", MYTHOS)
    expect(w.stats).toEqual(['/repo/lib/old.js'])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'repeat-failure'])
  })

  test('a remote edit counts with no stat', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await failRunFail($, w, `ssh box "sed -i 's/return a - b;/return a * b;/' /srv/app/add.js"`, MYTHOS)
    expect(w.stats).toEqual([])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'repeat-failure'])
  })

  test('npm test fails, then `sed -i … && npm test` fails with add.js rewritten: the sed ran, so the failure is a repeat', async ($, on) => {
    const w = world(on, { model: MYTHOS, tool: (e) => sedWrites(w, e) })
    await failRunFail($, w, "sed -i 's/a - b/a * b/' add.js && npm test", MYTHOS, true)
    expect(w.mtimes.get('/repo/add.js')).toBe(1_000)
    // the plain rerun after it changed nothing more is no second repeat
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'repeat-failure', 'rerun-failure'])
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high'])
  })

  test('the same with add.js unchanged (the sed failed, npm test never ran): no change, a rerun', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await failRunFail($, w, "sed -i 's/a - b/a * b/' add.js && npm test", MYTHOS, true)
    expect(w.stats).toEqual(['/repo/add.js'])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'rerun-failure', 'rerun-failure'])
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high'])
  })

  test('a failed `sed -i … && npm test` whose file cannot be named is no change: nothing tells who failed', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await failRunFail($, w, `sed -i 's/a - b/a * b/' "$F" && npm test`, MYTHOS, true)
    expect(w.stats).toEqual([])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'rerun-failure', 'rerun-failure'])
  })

  test('a check that writes its output to a file is no change', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await failRunFail($, w, 'npm run build > build.log 2>&1', MYTHOS)
    expect(w.stats).toEqual([])
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high'])
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'pass', 'rerun-failure'])
  })
})

describe('carry-over (Opus)', () => {
  const firstTurn = async ($: any, w: World, model = OPUS) => {
    await submit($, 'add a unit test for add() and fix the bug')
    await step($, 0, 'high', { model })
    await failEditFail($, w, 1, model)
    await complete($)
    say(w, 'user', 'add a unit test for add() and fix the bug'); say(w, 'assistant', 'still failing')
  }

  test('decision 9: a repeat failure still failing at the turn\'s end starts a continuing prompt one level up', async ($, on) => {
    const w = world(on)
    await firstTurn($, w)
    expect(rows(w, 'outcome')[0]).toMatchObject({ carry: 1, effort: 'high', checks: { run: 2, passed: 0, failed: 2 }, unfinished: false })
    await submit($, '继续')
    await step($, 0, 'high', { turnId: 'turn-2' })
    expect(sent(w).at(-1)).toBe('xhigh')
    const p = rows(w, 'prompt').at(-1)!
    expect(p).toMatchObject({ effort: 'xhigh', carry: { from: 'high', to: 'xhigh', checks: 1 } })
    expect(p.reasons.at(-1)).toBe('check still failing after a change → xhigh')
    // the check carried on: its pass after the raise is counted
    await bash(w, $, 'npm test')
    await complete($)
    expect(rows(w, 'outcome').at(-1)).toMatchObject({ raisesPassed: 1, carry: 0 })
  })

  test('decision 9: a fault-yes follow-up continues the work; the higher of the two raises wins', async ($, on) => {
    const w = world(on)
    await firstTurn($, w)
    await submit($, '不对，还是报错')
    expect(rows(w, 'prompt').at(-1)).toMatchObject({ effort: 'xhigh', carry: { from: 'high', to: 'xhigh' }, followUp: { yes: true, raisedTo: 'xhigh' }, correction: true })
  })

  test('decision 9: a new task does not carry', async ($, on) => {
    const w = world(on)
    await firstTurn($, w)
    await submit($, 'now write the changelog entry for the release')
    expect(rows(w, 'prompt').at(-1)).toMatchObject({ effort: 'high', correction: false })
    expect(rows(w, 'prompt').at(-1)!.carry).toBeUndefined()
  })

  test('decision 9: a short prompt after an interrupted turn continues the work', async ($, on) => {
    const w = world(on)
    await submit($, 'add a unit test for add() and fix the bug')
    await step($, 0, 'high')
    await failEditFail($, w, 1)
    await complete($, undefined, { reason: 'aborted', isAborted: true })
    expect(rows(w, 'outcome')[0]).toMatchObject({ unfinished: true, carry: 1 })
    await submit($, '换个思路试试')
    expect(rows(w, 'prompt').at(-1)!.effort).toBe('xhigh')
  })

  test('decision 9: on Mythos the turn holds its level and a continuing prompt starts one level up, as on Opus', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await firstTurn($, w, MYTHOS)
    expect(sent(w).at(-1)).toBe('high')
    await submit($, '继续')
    await step($, 0, 'high', { model: MYTHOS, turnId: 'turn-2' })
    const p = rows(w, 'prompt').at(-1)!
    expect(p).toMatchObject({ effort: 'xhigh', carry: { from: 'high', to: 'xhigh', checks: 1 } })
    expect(sent(w).at(-1)).toBe('xhigh')
  })
})

describe('/effort pin', () => {
  test('decision 5: a /effort holds across prompts until [effort auto]', async ($, on) => {
    const w = world(on)
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'xhigh')
    await step($, 1, 'low')
    await step($, 2, 'low')
    expect(sent(w)).toEqual(['high', 'low', 'low'])
    expect(journal(w).at(-1)).toMatchObject({ source: 'pinned', reasons: ['/effort pin'], manual: true })
    await complete($)
    await submit($, 'now fix the lexer too')
    await step($, 0, 'low', { turnId: 'turn-2' })
    expect(sent(w).at(-1)).toBe('low')
    expect(w.asks.length).toBe(1)
    expect(await bandText($)).toBe('Opus 5.5 · ◆ Jev · LOW · code · /effort')
    await complete($)
    await submit($, '[effort auto] and the tokenizer')
    await step($, 0, 'low', { turnId: 'turn-3' })
    expect(sent(w).at(-1)).toBe('high')
    await step($, 1, 'low', { turnId: 'turn-3' })
    expect(sent(w).at(-1)).toBe('high')
  })

  test('decision 5: the pin survives a restart through the store', async ($, on) => {
    const w = world(on, { store: { 'session:sess-1': { max: 'low', last: 'low', followUp: null, at: 1, prompt: 3, carry: false, unfinished: false, pinned: true } } })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'medium')
    expect(sent(w)).toEqual(['medium'])
    expect(w.asks.length).toBe(0)
  })

  test('B2: switching Mythos (effort high) to Opus (xhigh) with /model is no /effort pin', async ($, on) => {
    const w = world(on)
    await submit($, 'fix the parser bug')
    await step($, 0, 'high', { model: MYTHOS })
    await step($, 1, 'high', { model: MYTHOS })
    await complete($)
    await submit($, 'now fix the lexer bug')
    await step($, 0, 'xhigh', { model: OPUS, turnId: 'turn-2' })
    await bash(w, $, 'npm test', true)
    await step($, 1, 'xhigh', { model: OPUS, turnId: 'turn-2' })
    expect(rows(w, 'step').every((r) => r.manual === undefined)).toBe(true)
    expect(sent(w)).toEqual(['high', 'high', 'high', 'high'])
  })

  test('decision 5: after /model the next request\'s own effort is the new baseline', async ($, on) => {
    const w = world(on)
    await submit($, 'fix the parser bug')
    await step($, 0, 'xhigh')
    await complete($)
    await $.classic.PostModelSwitch({
      from_model: OPUS, to_model: MYTHOS, requested_model: 'mythos', source: 'command',
      context_tokens: 0, prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0, pricing: 'catalog',
    })
    await submit($, 'now fix the lexer bug')
    await step($, 0, 'high', { model: OPUS, turnId: 'turn-2' })
    expect(sent(w)).toEqual(['high', 'high'])
    expect(rows(w, 'step').every((r) => r.manual === undefined)).toBe(true)
  })
})

describe('follow-up signal', () => {
  const history = (w: World) => {
    w.messages = [
      { role: 'user', content: 'add a unit test for add() and fix the bug' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done: the test passes.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '# fail 0' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'All tests pass.' }] },
    ]
  }

  test('a fault raises the next prompt one level above the previous prompt\'s highest', async ($, on) => {
    const w = world(on)
    await submit($, 'add a unit test for add() and fix the bug')
    await step($, 0)
    await bash(w, $, 'npm test', true)
    await step($, 1)
    history(w)
    await submit($, '不对，你做错了')
    await step($, 0)
    expect(sent(w)).toEqual(['high', 'high', 'xhigh'])
    const prompt = rows(w, 'prompt').at(-1)!
    expect(prompt.followUp).toMatchObject({ yes: true, prevMax: 'high', raisedTo: 'xhigh', streak: 1, advisor: false })
    expect(prompt).toMatchObject({ prompt: 2, correction: true })
    // One request asks the task and the follow-up questions over the conversation: the turn's final reply, the new message last.
    expect(w.asks.at(-1)!.questions).toEqual(['task_type', 'deep', 'dissatisfied', 'continues'])
    expect(w.asks.at(-1)!.input).toEqual([
      { role: 'user', content: 'add a unit test for add() and fix the bug' },
      { role: 'assistant', content: 'All tests pass.' },
      { role: 'user', content: '不对，你做错了' },
    ])
    expect(w.toasts.some((t) => t.includes('xhigh'))).toBe(true)
  })

  test('the previous prompt\'s outcome survives a restart through the store', async ($, on) => {
    const w = world(on, { store: { 'session:sess-1': { max: 'high', last: 'medium', followUp: null, at: 1 } } })
    history(w)
    await submit($, '不对，你做错了')
    await step($, 0)
    expect(sent(w)).toEqual(['xhigh'])
  })

  test('no fault: the task level stands', async ($, on) => {
    const w = world(on, { store: { 'session:sess-1': { max: 'high', last: 'high', followUp: null, at: 1 } } })
    history(w)
    await submit($, 'now add a README section for add()')
    await step($, 0)
    expect(sent(w)).toEqual(['high'])
    expect(journal(w)[0]!.followUp).toMatchObject({ yes: false })
  })

  test('a fault after the previous prompt already ran at max adds the advisor note', async ($, on) => {
    const w = world(on, { settings: { advisorModel: 'fable' }, store: { 'session:sess-1': { max: 'max', last: 'max', followUp: { yes: true, streak: 1, hiLosses: 1 }, at: 1 } } })
    history(w)
    await submit($, '不对，还是错的')
    await step($, 0)
    expect(w.contexts.at(-1)).toEqual([ADVISOR_NOTE])
    expect(journal(w)[0]!.followUp).toMatchObject({ yes: true, advisor: true, streak: 2 })
  })

  test('no advisor configured: no note', async ($, on) => {
    const w = world(on, { store: { 'session:sess-1': { max: 'max', last: 'max', followUp: { yes: true, streak: 1, hiLosses: 1 }, at: 1 } } })
    history(w)
    await submit($, '不对，还是错的')
    expect(w.contexts.at(-1)).toBeUndefined()
  })

  test('a short acknowledgement never starts below the previous prompt\'s level', async ($, on) => {
    const w = world(on, { env: NO_KEY, store: { 'session:sess-1': { max: 'xhigh', last: 'high', followUp: null, at: 1 } } })
    await submit($, '好的')
    await step($, 0)
    await submit($, '继续')
    await step($, 0)
    expect(sent(w)).toEqual(['high', 'high'])
    expect(journal(w)[0]!.reasons.at(-1)).toBe('short acknowledgement → stays at high')
  })
})

describe('non-human turns', () => {
  /** Two prompts, the second a fault, each completed; optionally a background report in between and after. */
  const run = async ($: any, w: World, withNotification: boolean) => {
    await submit($, '修复 parser 的 bug')
    await step($, 0)
    await bash(w, $, 'npm test', true)
    await step($, 1)
    await complete($)
    say(w, 'user', '修复 parser 的 bug'); say(w, 'assistant', '修好了')
    await submit($, '不对，还是报错')
    await step($, 0, 'xhigh', { turnId: 'turn-2' })
    await complete($)
    say(w, 'user', '不对，还是报错'); say(w, 'assistant', '这次修好了')
    if (withNotification) {
      const note = '<task-notification><task-id>b1</task-id><status>completed</status><summary>Background command finished</summary></task-notification>'
      await submitAs($, note, 'task-notification')
      await step($, 0, 'xhigh', { turnId: 'turn-3' })
      await complete($)
      say(w, 'user', note); say(w, 'assistant', '后台任务完成了')
    }
    await submit($, '还是不对')
    await step($, 0, 'xhigh', { turnId: 'turn-4' })
    return rows(w, 'prompt').at(-1)!
  }

  test('B4 / decision 8: a background report between two faults neither resets the follow-up history nor asks Jev', async ($, on) => {
    const control = world(on)
    const p = await run($, control, false)
    expect(p.followUp).toMatchObject({ yes: true, streak: 2, hiLosses: 1, prevMax: 'xhigh' })
  })

  test('B4 / decision 8: the same two faults with a background report in between', async ($, on) => {
    const w = world(on)
    const p = await run($, w, true)
    expect(p.followUp).toMatchObject({ yes: true, streak: 2, hiLosses: 1, prevMax: 'xhigh' })
    // the report's turn: no Jev ask, no prompt row, the last prompt's level
    expect(rows(w, 'prompt').length).toBe(3)
    expect(rows(w, 'step').find((r) => r.turnId === 'turn-3')).toMatchObject({ effort: 'xhigh', reasons: ['continues the last prompt'], source: 'local' })
  })

  test('B4b / decision 8: a background report keeps the tagged range and the open checks', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await submit($, '[effort high..xhigh] start the benchmark in the background and fix whatever fails')
    await step($, 0, 'high', { model: MYTHOS })
    await bash(w, $, 'npm test', true)
    await edit($, '/repo/a.js')
    await step($, 1, 'high', { model: MYTHOS })
    await complete($)
    await submitAs($, '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>', 'task-notification')
    await step($, 0, 'high', { model: MYTHOS, turnId: 'turn-2' })
    expect(rows(w, 'step').at(-1)).toMatchObject({ promptBounds: 'high..xhigh', effort: 'high' })
    // the check that failed before the report repeats after it: the ladder goes on
    await bash(w, $, 'npm test', true)
    await step($, 1, 'high', { model: MYTHOS, turnId: 'turn-2' })
    expect(sent(w).at(-1)).toBe('high')
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'repeat-failure'])
    await complete($, undefined, { turnId: 'turn-2' })
    expect(rows(w, 'outcome').at(-1)).toMatchObject({ carry: 1 })
  })

  test('decision 8: a slash command is a new task judged from its expanded text, without the previous prompt\'s tag (B5)', async ($, on) => {
    const w = world(on)
    await submit($, '[effort max] dig into the race')
    await step($, 0)
    await complete($)
    say(w, 'user', '[effort max] dig into the race'); say(w, 'assistant', 'found it')
    await submit($, '/simplify')
    // As Claude Code holds a command: its name and arguments, then the expanded body.
    w.messages.push({ role: 'user', content: [
      { type: 'text', text: '<command-message>simplify</command-message>\n<command-name>/simplify</command-name>\n' },
      { type: 'text', text: 'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes.\n' },
    ] })
    await step($, 0, 'xhigh', { turnId: 'turn-2' })
    const r = rows(w, 'step').at(-1)!
    expect(r.promptBounds).toBeUndefined()
    expect(r.effort).toBe('high')
    expect(latest(w.asks.at(-1)!.input)).toBe('Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes.')
    expect(w.asks.at(-1)!.input.some((m) => m.content.includes('<command-'))).toBe(false)
  })

  test('B6 / decision 8: a Telegram message is a human prompt: the follow-up is asked on its own words', async ($, on) => {
    const w = world(on)
    await submit($, 'fix the parser bug')
    await step($, 0)
    await complete($)
    say(w, 'user', 'fix the parser bug'); say(w, 'assistant', 'fixed')
    await submitAs($, '<channel source="plugin:telegram:telegram" chat_id="1" message_id="2" user="u" user_id="1" ts="2026-10-26T00:00:00.000Z">\n不对，还是报错\n</channel>', 'channel')
    const p = rows(w, 'prompt').at(-1)!
    expect(p).toMatchObject({ origin: 'channel', effort: 'xhigh', followUp: { yes: true } })
    expect(latest(w.asks.at(-1)!.input)).toBe('不对，还是报错')
  })
})

describe('exploration', () => {
  // Floor medium, so a high start can move either way.
  const EXPLORE = ENV.replace('JEV_OPUS_EXPLORE=0', 'JEV_OPUS_EXPLORE=1').replace('JEV_OPUS_MIN_EFFORT=high', 'JEV_OPUS_MIN_EFFORT=medium')
  const deepCode = (q: string[], input: JevInput) => ({ ...stubJev(q, input), deep: { noul: 0.95 } })

  test('decision 7: with p 1 every human prompt\'s start moves one level, journaled with the policy\'s own choice', async ($, on) => {
    // A deep code task starts at high on Opus 5.5.
    const w = world(on, { env: EXPLORE, jev: deepCode })
    for (let i = 0; i < 6; i++) await submit($, 'fix the crash in parser.ts')
    for (const p of rows(w, 'prompt')) {
      expect(p.explore.p).toBe(1)
      expect(p.explore.from).toBe('high')
      expect(['medium', 'xhigh']).toContain(p.explore.to)
      expect(p.effort).toBe(p.explore.to)
      expect(p.reasons.at(-1)).toBe(`explore: high → ${p.explore.to}`)
    }
  })

  test('decision 7: never on a tagged or pinned prompt, a subagent, or a background report', async ($, on) => {
    const w = world(on, { env: EXPLORE, agentRows: { a1: [{ role: 'user', text: 'Investigate why the parser crashes' }] } })
    await submit($, '[effort high] fix the crash in parser.ts')
    expect(rows(w, 'prompt')[0]).toMatchObject({ effort: 'high' })
    expect(rows(w, 'prompt')[0]!.explore).toBeUndefined()
    await step($, 0, 'xhigh')
    await step($, 0, 'xhigh', { agentId: 'a1' })
    expect(rows(w, 'step').at(-1)).toMatchObject({ agent: 'a1', effort: 'high' })
    await complete($)
    await submitAs($, '<task-notification><status>completed</status></task-notification>', 'task-notification')
    await step($, 0, 'xhigh', { turnId: 'turn-2' })
    expect(rows(w, 'step').at(-1)).toMatchObject({ effort: 'high', reasons: ['continues the last prompt'] })
    await step($, 1, 'low', { turnId: 'turn-2' })
    await submit($, 'fix the crash in parser.ts')
    expect(rows(w, 'prompt').length).toBe(1)
    expect(journal(w).some((r) => r.explore)).toBe(false)
  })
})

describe('prompt effort tag', () => {
  test('[effort xhigh..max]: the task starts at xhigh and holds through a repeat failure, the next prompt is back to the configured range', async ($, on) => {
    const w = world(on, { model: MYTHOS })
    await submit($, '[effort xhigh..max] add a unit test for add() and fix the bug')
    await step($, 0, 'high', { model: MYTHOS })
    const n = await failEditFail($, w, 1, MYTHOS)
    await bash(w, $, 'npm test')
    await step($, n, 'high', { model: MYTHOS })
    expect(sent(w)).toEqual(['xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh'])
    const j = journal(w)
    expect(j[0]).toMatchObject({ kind: 'task', effort: 'xhigh', promptBounds: 'xhigh..max' })
    expect(j[0]!.reasons).toContain('prompt tag [effort xhigh..max]')
    expect(rows(w, 'step').at(-1)).toMatchObject({ kind: 'task', effort: 'xhigh', promptBounds: 'xhigh..max' })
    // the tag goes to the model and to Jev as written
    expect(latest(w.asks[0]!.input)).toContain('[effort xhigh..max]')

    await complete($)
    await submit($, 'add a unit test for add() and fix the bug')
    await step($, 0, 'high', { model: MYTHOS, turnId: 'turn-2' })
    expect(sent(w).at(-1)).toBe('high')
    expect(journal(w).at(-1)!.promptBounds).toBeUndefined()
  })

  test('[effort >=xhigh] keeps the configured max; [effort low] overrides the configured floor', async ($, on) => {
    const w = world(on)
    await submit($, 'add a unit test for add() and fix the bug [effort >=xhigh]')
    expect(journal(w)[0]).toMatchObject({ effort: 'xhigh', promptBounds: 'xhigh..max' })
    await submit($, '[effort low] add a unit test for add() and fix the bug')
    expect(journal(w)[1]).toMatchObject({ effort: 'low', promptBounds: 'low' })
  })

  test('[effort >=xhigh] above a configured max of high still runs at xhigh', async ($, on) => {
    const w = world(on, { env: ENV.replace('JEV_OPUS_MAX_EFFORT=max', 'JEV_OPUS_MAX_EFFORT=high') })
    await submit($, 'add a unit test for add() and fix the bug [effort >=xhigh]')
    expect(journal(w)[0]).toMatchObject({ effort: 'xhigh', promptBounds: 'xhigh' })
  })

  test('a /effort pin beats the prompt tag', async ($, on) => {
    const w = world(on)
    await submit($, '[effort max] add a unit test for add() and fix the bug')
    await step($, 0, 'xhigh')
    await step($, 1, 'medium')
    await step($, 2, 'medium')
    expect(sent(w)).toEqual(['max', 'medium', 'medium'])
    expect(journal(w).at(-1)).toMatchObject({ source: 'pinned', manual: true })
  })

  test('a subagent brief with a tag is bounded the same way', async ($, on) => {
    const w = world(on, { agentRows: { 'agent-7': [{ role: 'user', text: '[effort max] Investigate why the parser crashes on empty input' }] } })
    await step($, 0, 'xhigh', { agentId: 'agent-7' })
    expect(w.steps[0]).toEqual({ index: 0, effort: 'max', agentId: 'agent-7' })
    expect(journal(w)[0]).toMatchObject({ agent: 'agent-7', promptBounds: 'max' })
    expect(journal(w)[0]!.promptBoundsInherited).toBeUndefined()
  })

  test('a subagent started under a tagged main prompt inherits its range; its own tag wins; the next main prompt starts subagents unbounded', async ($, on) => {
    const w = world(on, { agentRows: {
      'agent-1': [{ role: 'user', text: 'Investigate why the parser crashes on empty input' }],
      'agent-2': [{ role: 'user', text: '[effort high] Investigate why the parser crashes on empty input' }],
      'agent-3': [{ role: 'user', text: 'Investigate why the parser crashes on empty input' }],
    } })
    await submit($, '[effort xhigh..max] find and fix the parser crash')
    await step($, 0)
    await step($, 0, 'xhigh', { agentId: 'agent-1' })
    await step($, 0, 'xhigh', { agentId: 'agent-2' })
    expect(w.steps.slice(1)).toEqual([{ index: 0, effort: 'xhigh', agentId: 'agent-1' }, { index: 0, effort: 'high', agentId: 'agent-2' }])
    const j = journal(w)
    expect(j[2]).toMatchObject({ agent: 'agent-1', effort: 'xhigh', promptBounds: 'xhigh..max', promptBoundsInherited: true })
    expect(j[2]!.reasons).toContain('main prompt tag [effort xhigh..max]')
    expect(j[3]).toMatchObject({ agent: 'agent-2', effort: 'high', promptBounds: 'high' })
    expect(j[3]!.promptBoundsInherited).toBeUndefined()

    await submit($, 'now write the changelog entry')
    await step($, 0)
    await step($, 0, 'xhigh', { agentId: 'agent-3' })
    expect(w.steps.at(-1)).toEqual({ index: 0, effort: 'high', agentId: 'agent-3' })
    expect(journal(w).at(-1)!.promptBounds).toBeUndefined()
  })

  test('B5: under a Fable main loop an Opus subagent still inherits the main prompt\'s tag', async ($, on) => {
    const w = world(on, { model: 'claude-fable-5-1', agentRows: { a1: [{ role: 'user', text: 'review parser.ts' }] } })
    await submit($, '[effort max] review the parser with a subagent')
    await step($, 0, 'high', { model: 'claude-fable-5-1' })
    await step($, 0, 'high', { agentId: 'a1', turnId: 'sub-1' })
    expect(rows(w, 'step').at(-1)).toMatchObject({ agent: 'a1', effort: 'max', promptBounds: 'max', promptBoundsInherited: true })
  })

  test('B5: after /model fable, a later untagged prompt\'s Opus subagent no longer runs inside the old tag', async ($, on) => {
    const o: any = { model: OPUS, agentRows: { a2: [{ role: 'user', text: 'summarize notes.md' }] } }
    const w = world(on, o)
    await submit($, '[effort max] dig into the race')
    await step($, 0)
    await complete($)
    o.model = 'claude-fable-5-1'
    await $.classic.PostModelSwitch({
      from_model: OPUS, to_model: 'claude-fable-5-1', requested_model: 'fable', source: 'command',
      context_tokens: 0, prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0, pricing: 'catalog',
    })
    await submit($, 'now summarize the notes with a subagent')
    await step($, 0, 'high', { model: 'claude-fable-5-1', turnId: 'turn-2' })
    await step($, 0, 'high', { agentId: 'a2', turnId: 'sub-2' })
    const r = rows(w, 'step').at(-1)!
    expect(r.promptBounds).toBeUndefined()
    expect(r.effort).not.toBe('max')
  })
})

describe('subagents', () => {
  test('a subagent routes its own brief, never asks the follow-up question, and on Opus keeps its level', async ($, on) => {
    const w = world(on, { agentRows: { 'agent-7': [{ role: 'user', text: 'Investigate why the parser crashes on empty input' }] } })
    await step($, 0, 'xhigh', { agentId: 'agent-7' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'agent-7' })
    await step($, 1, 'xhigh', { agentId: 'agent-7' })
    expect(w.steps).toEqual([{ index: 0, effort: 'high', agentId: 'agent-7' }, { index: 1, effort: 'high', agentId: 'agent-7' }])
    expect(w.asks.map((a) => a.questions[0])).toEqual(['task_type'])
    expect(journal(w)[0]).toMatchObject({ agent: 'agent-7', kind: 'task' })
    await complete($, 'agent-7')
    expect(rows(w, 'outcome')[0]).toMatchObject({ agent: 'agent-7', checks: { run: 1, passed: 1, failed: 0 } })
  })

  test('a resumed subagent is decided from the message that resumed it, with its earlier run as context', async ($, on) => {
    const conversation: Array<{ role: 'user' | 'assistant'; text: string }> = [{ role: 'user', text: 'Investigate why the parser crashes on empty input' }]
    const w = world(on, { agentRows: { 'agent-7': conversation } })
    await step($, 0, 'xhigh', { agentId: 'agent-7' })
    await complete($, 'agent-7')
    conversation.push({ role: 'assistant', text: 'lex() indexes past the end of an empty buffer.' }, { role: 'user', text: '[effort max] Now fix lex() so empty input returns []' })
    await step($, 0, 'xhigh', { agentId: 'agent-7', turnId: 'turn-2' })
    expect(w.asks.at(-1)!.input).toEqual([
      { role: 'user', content: 'Investigate why the parser crashes on empty input' },
      { role: 'assistant', content: 'lex() indexes past the end of an empty buffer.' },
      { role: 'user', content: '[effort max] Now fix lex() so empty input returns []' },
    ])
    expect(w.asks.at(-1)!.questions).toEqual(['task_type', 'deep'])
    // The new message's own tag sets the range: it was read, not the brief.
    expect(rows(w, 'step').at(-1)).toMatchObject({ agent: 'agent-7', effort: 'max', promptBounds: 'max' })
  })

  test('a check that fails again after a change and still fails at the end of a subagent\'s run starts its next run one level up', async ($, on) => {
    const conversation: Array<{ role: 'user' | 'assistant'; text: string }> = [{ role: 'user', text: 'Make the date tests pass' }]
    const w = world(on, { agentRows: { 'agent-9': conversation } })
    const agent = { agentId: 'agent-9' }
    await step($, 0, 'high', agent)
    w.fail = true
    await $.tool.call({ tool: 'Bash', command: 'npm test', ...agent } as any)
    await step($, 1, 'high', agent)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/dates.js', old_string: 'a', new_string: 'b', ...agent } as any)
    await $.tool.call({ tool: 'Bash', command: 'npm test', ...agent } as any)
    await step($, 2, 'high', agent)
    expect(sent(w)).toEqual(['high', 'high', 'high'])
    await complete($, 'agent-9')
    expect(rows(w, 'outcome').at(-1)).toMatchObject({ agent: 'agent-9', carry: 1 })

    conversation.push({ role: 'assistant', text: 'npm test still fails on leap years.' }, { role: 'user', text: 'Keep going until npm test passes' })
    await step($, 0, 'high', { ...agent, turnId: 'turn-2' })
    const start = rows(w, 'step').at(-1)!
    expect(start).toMatchObject({ agent: 'agent-9', effort: 'xhigh', carry: { from: 'high', to: 'xhigh', checks: 1 } })
    expect(start.reasons.at(-1)).toBe('check still failing after a change in the last run → xhigh')
    // The carried check passes in the new run: the raise is credited.
    w.fail = false
    await $.tool.call({ tool: 'Bash', command: 'npm test', ...agent } as any)
    expect(rows(w, 'check').at(-1)).toMatchObject({ agent: 'agent-9', outcome: 'pass', passedAfterRaise: true })
    await complete($, 'agent-9', { turnId: 'turn-2' })
    expect(rows(w, 'outcome').at(-1)).toMatchObject({ agent: 'agent-9', raisesPassed: 1, carry: 0 })
  })

  test('a subagent\'s open check carries into its next run: a failure there after a change is a repeat', async ($, on) => {
    const conversation: Array<{ role: 'user' | 'assistant'; text: string }> = [{ role: 'user', text: 'Make the date tests pass' }]
    const w = world(on, { agentRows: { 'agent-9': conversation } })
    const agent = { agentId: 'agent-9' }
    await step($, 0, 'high', agent)
    w.fail = true
    await $.tool.call({ tool: 'Bash', command: 'npm test', ...agent } as any)
    await complete($, 'agent-9')
    conversation.push({ role: 'assistant', text: 'npm test fails on leap years.' }, { role: 'user', text: 'Fix it' })
    await step($, 0, 'high', { ...agent, turnId: 'turn-2' })
    expect(rows(w, 'step').at(-1)).toMatchObject({ effort: 'high' })
    expect(rows(w, 'step').at(-1)!.carry).toBeUndefined()
    await $.tool.call({ tool: 'Edit', file_path: '/repo/dates.js', old_string: 'a', new_string: 'b', ...agent } as any)
    await $.tool.call({ tool: 'Bash', command: 'npm test', ...agent } as any)
    expect(rows(w, 'check').map((r) => r.outcome)).toEqual(['first-failure', 'repeat-failure'])
  })

  test('a subagent whose brief opens with the magpie-tasks marker is left alone: no Jev ask, its effort as sent, no /effort pin, one skip row per run', async ($, on) => {
    const conversation: Array<{ role: 'user' | 'assistant'; text: string }> = [{ role: 'user', text: '[magpie-tasks task=t-7 role=implementer rule=code-main rules=3 model=claude-opus-5-5 effort=high]\nImplement the parser fix described below.' }]
    const w = world(on, { agentRows: { 'agent-m': conversation } })
    const agent = { agentId: 'agent-m' }
    await step($, 0, 'low', agent)
    await step($, 1, 'xhigh', agent)
    w.fail = true
    await $.tool.call({ tool: 'Bash', command: 'npm test', ...agent } as any)
    await complete($, 'agent-m')
    conversation.push({ role: 'assistant', text: 'done' }, { role: 'user', text: 'also update the README' })
    await step($, 0, 'medium', { ...agent, turnId: 'turn-2' })
    expect(sent(w)).toEqual(['low', 'xhigh', 'medium'])
    expect(w.asks).toHaveLength(0)
    expect(rows(w, 'skip')).toEqual([
      expect.objectContaining({ agent: 'agent-m', reason: 'magpie-tasks', step: 0, turnId: 'turn-1', model: OPUS }),
      expect.objectContaining({ agent: 'agent-m', reason: 'magpie-tasks', step: 0, turnId: 'turn-2' }),
    ])
    expect(rows(w, 'check')).toHaveLength(0)
    expect(rows(w, 'outcome')).toHaveLength(0)
    // The main loop is still routed: the subagent's changing effort was no /effort.
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'xhigh')
    expect(rows(w, 'step').at(-1)).toMatchObject({ agent: 'main', source: 'jev', effort: 'high' })
  })

  test('a brief that only quotes the magpie-tasks marker is routed as any other', async ($, on) => {
    const brief = 'Reply with the single word PONG. (Background for you: our task scheduler marks the briefs it sends with a first line such as [magpie-tasks task=<id>]; this brief does not come from it.)'
    const w = world(on, { agentRows: { 'agent-q': [{ role: 'user', text: brief }] } })
    await step($, 0, 'xhigh', { agentId: 'agent-q' })
    expect(rows(w, 'skip')).toHaveLength(0)
    expect(w.asks).toHaveLength(1)
    expect(w.asks[0]!.input).toEqual([{ role: 'user', content: brief }])
    expect(rows(w, 'step')).toEqual([expect.objectContaining({ agent: 'agent-q', source: 'jev', effort: 'high' })])
  })
})

describe('Jev context', () => {
  test('a real conversation reaches Jev as messages, newest last, with the task and follow-up questions in one request', async ($, on) => {
    const w = world(on, { store: { 'session:sess-1': { max: 'high', last: 'high', followUp: null, at: 1, prompt: 7 } } })
    w.messages = mainBeforeChannel.api
    await submitAs($, '<channel source="chkchan" chat_id="900" message_id="501" user="chkuser" user_id="11" reply_to_message_id="499">\nCHK-CHANNEL-BODY-1: reply with the single word cherry.\n</channel>', 'channel')
    expect(w.asks).toHaveLength(1)
    expect(w.asks[0]!.questions).toEqual(['task_type', 'deep', 'dissatisfied', 'continues'])
    expect(w.asks[0]!.input).toEqual([...jevDialogue(mainBeforeChannel.api), { role: 'user', content: 'CHK-CHANNEL-BODY-1: reply with the single word cherry.' }])
    expect(w.asks[0]!.input.at(-2)).toEqual({ role: 'assistant', content: mainBeforeChannel.answer })
  })

  /** A plugin that appends a note to the conversation when its `AppendNote` tool is called, as context-memory and magpie-tasks do. */
  const noteWriter = {
    name: 'note-writer',
    register: ((on) => {
      on('tool.call', async ($, e, next) => {
        if ((e.tool as string) !== 'AppendNote') return next(e)
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: String((e as { text?: unknown }).text) }] } })
        return { result: { ok: true } as never, text: 'appended' }
      })
    }) as Register,
  }

  test('a note another plugin appended never reaches Jev; the prompt beside it does', { plugins: [noteWriter] }, async ($, on) => {
    const w = world(on, { store: { 'session:sess-1': { max: 'high', last: 'high', followUp: null, at: 1, prompt: 7 } } })
    const appended = mock.session(on)
    const note = 'RECHECK-PLUGIN-APPENDED-NOTE xyz'
    await $.tool.call({ tool: 'AppendNote', text: note } as any)
    expect(appended.appended().map((r) => [r.door, r.origin])).toEqual([['note', { kind: 'plugin', name: 'note-writer' }]])
    w.messages = mainBeforeChannel.api
    await submit($, 'one more question')
    const input = w.asks[0]!.input
    expect(input.some((m) => m.content.includes(note))).toBe(false)
    expect(input).toEqual([...jevDialogue(mainBeforeChannel.api, new Set([note])), { role: 'user', content: 'one more question' }])
    expect(input.some((m) => m.content === 'APPENDNOTE: reply with the single word: grape')).toBe(true)
  })

  test('each decision row records what Jev read: the message count, input tokens and the tokens OpenAI read from its cache', async ($, on) => {
    const w = world(on)
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    await complete($)
    say(w, 'user', 'fix the crash in parser.ts'); say(w, 'assistant', 'Fixed: the parser no longer indexes past the end.')
    await submit($, 'now the lexer')
    expect(rows(w, 'prompt').map((r) => r.jevUsage)).toEqual([
      { messages: 1, inputTokens: 4100, cachedTokens: 0 },
      { messages: 3, inputTokens: 4300, cachedTokens: 4000 },
    ])
    expect(w.asks[1]!.input.slice(0, 1)).toEqual(w.asks[0]!.input)
  })

  test('the first prompt of a session and a prompt after no agent reply ask only the task questions', async ($, on) => {
    const w = world(on, { store: { 'session:sess-1': { max: 'high', last: 'high', followUp: null, at: 1 } } })
    await submit($, 'fix the crash in parser.ts')
    expect(w.asks[0]!.questions).toEqual(['task_type', 'deep'])
  })
})

describe('band above the prompt', () => {
  const BRIEF = { 'agent-7': [{ role: 'user' as const, text: 'Investigate why the parser crashes on empty input' }] }

  test('before any request the main line names the session\'s model; over a survey the band is the engine\'s', async ($, on) => {
    const w = world(on)
    expect(await bandText($)).toBe('Opus 5.5')
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    expect(w.invalidates).toBe(2)
    expect(await bandText($)).toBe('Opus 5.5 · ◆ Jev · HIGH · code')
    expect(await bandText($, {}, 'terminal', true)).toBe('engine')
  })

  test('the subagent view draws that subagent\'s model and trail and the main view the main loop\'s, on terminal and desktop', async ($, on) => {
    const w = world(on, { agentRows: BRIEF, model: MYTHOS })
    await step($, 0, 'xhigh', { agentId: 'agent-7' })
    expect(await bandText($, { agentId: 'agent-7' })).toBe('Opus 5.5 · ◆ Jev · HIGH · code')
    expect(await bandText($)).toBe('Mythos 5.1')
    await submit($, 'add a unit test for add() and fix the bug')
    await step($, 0, 'high', { model: MYTHOS })
    await failEditFail($, w, 1, MYTHOS)
    expect(await bandText($)).toBe('Mythos 5.1 · ◆ Jev · HIGH · code')
    expect(await bandText($, {}, 'desktop')).toBe('Mythos 5.1 · ◆ Jev · HIGH · code')
    expect(await bandText($, { agentId: 'agent-7' })).toBe('Opus 5.5 · ◆ Jev · HIGH · code')
  })

  test('a Fable main loop and a Haiku subagent: the model alone, since Jev decides nothing for them', async ($, on) => {
    const w = world(on, { model: 'claude-fable-5-1', agentRows: BRIEF })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'high', { model: 'claude-fable-5-1' })
    await step($, 0, 'xhigh', { agentId: 'agent-7' })
    await step($, 0, 'high', { agentId: 'agent-8', model: 'claude-haiku-4-5-20251001' })
    await complete($, 'agent-8')
    expect(await bandText($)).toBe('Fable 5.1')
    expect(await bandText($, { agentId: 'agent-7' })).toBe('Opus 5.5 · ◆ Jev · HIGH · code')
    expect(await bandText($, { agentId: 'agent-8' })).toBe('Haiku 4.5 · done')
    expect(w.asks.every((a) => !a.input.some((m) => m.content.includes('fix the crash')))).toBe(true)
  })

  test('/model names the new model at once and drops the trail decided on the old one', async ($, on) => {
    world(on)
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    await $.classic.PostModelSwitch({
      from_model: OPUS, to_model: 'claude-fable-5-1[1m]', requested_model: 'fable[1m]', source: 'command',
      context_tokens: 0, prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0, pricing: 'catalog',
    })
    expect(await bandText($)).toBe('Fable 5.1 (1M)')
  })

  test('a subagent magpie-tasks routes is passed on, on any model: while it runs, after it ends and when it is resumed', async ($, on) => {
    const brief = '[magpie-tasks task=d-7 role=executor rule=daily-default rules=routing-rules.v5 model=claude/claude-opus-5-5 effort=medium]\nLog in to codex on the Mac.'
    const w = world(on, { agentRows: { 'agent-m': [{ role: 'user', text: brief }], 'agent-s': [{ role: 'user', text: brief }] } })
    await step($, 0, 'medium', { agentId: 'agent-m', model: 'claude/claude-opus-5-5' })
    expect(await bandText($, { agentId: 'agent-m' })).toBe('engine')
    await complete($, 'agent-m')
    expect(await bandText($, { agentId: 'agent-m' })).toBe('engine')
    await step($, 0, 'high', { agentId: 'agent-m', turnId: 'turn-2', model: 'claude/claude-opus-5-5' })
    expect(await bandText($, { agentId: 'agent-m' })).toBe('engine')
    await step($, 0, 'high', { agentId: 'agent-s', model: 'claude/claude-sonnet-5-5' })
    expect(await bandText($, { agentId: 'agent-s' })).toBe('engine')
    expect(sent(w)).toEqual(['medium', 'high', 'high'])
    expect(w.invalidates).toBe(0)
    expect(await bandText($)).toBe('Opus 5.5')
  })

  test('a finished subagent keeps its line, marked done; an unknown agent gets the engine\'s', async ($, on) => {
    const w = world(on, { agentRows: BRIEF })
    await step($, 0, 'xhigh', { agentId: 'agent-7' })
    await complete($, 'agent-7')
    expect(w.invalidates).toBe(3)
    expect(await bandText($, { agentId: 'agent-7' })).toBe('Opus 5.5 · ◆ Jev · HIGH · code · done')
    expect(await bandText($, { agentId: 'agent-9' })).toBe('engine')
  })

  test('heuristic routing says so; a long trail of /effort changes shows its last five levels', async ($, on) => {
    const w = world(on, { env: NO_JEV })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    expect(await bandText($)).toBe('Opus 5.5 · ◆ Jev · LOW · code · local routing')
    for (const effort of ['high', 'low', 'medium', 'high', 'xhigh', 'max', 'low']) await step($, w.steps.length, effort)
    expect(await bandText($)).toBe('Opus 5.5 · ◆ Jev · … → medium → high → xhigh → max → LOW · code · /effort')
  })
})

describe('outcome rows', () => {
  test('each turn ends with its outcome: tokens, wait, checks, raises, and the prompt it belongs to', async ($, on) => {
    const w = world(on)
    await submit($, 'add a unit test for add() and fix the bug')
    await step($, 0)
    await bash(w, $, 'npm test', true)
    await step($, 1)
    await bash(w, $, 'npm test')
    await complete($, undefined, { durationMs: 42_000, usage: { input_tokens: 10, output_tokens: 900, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 300, model: OPUS } })
    expect(rows(w, 'outcome')).toEqual([{
      at: 1_000, session: 'sess-1', agent: 'main', event: 'outcome', turnId: 'turn-1', prompt: 1, model: OPUS, effort: 'high', trail: ['high'],
      reason: 'answer', durationMs: 42_000, jevWaitMs: 0, outputTokens: 900, inputTokens: 10, cacheReadTokens: 5_000, cacheCreationTokens: 300,
      checks: { run: 2, passed: 1, failed: 1 }, raisesPassed: 0, carry: 0, unfinished: false, policy: 'policy.v17',
    }])
  })
})

describe('task continuation', () => {
  // Jev's follow-up answers: the fault question says no; the same-task question says `continues`.
  const reads = (continues: number) => (q: string[], input: JevInput) =>
    q.includes('continues') ? { ...stubJev(q, input), dissatisfied: { noul: 0.1 }, continues: { noul: continues } } : stubJev(q, input)
  const record = (taskMax: string) => ({ 'session:sess-1': { max: 'high', last: 'high', followUp: null, at: 1, prompt: 3, carry: false, unfinished: false, pinned: false, taskMax } })
  const turn = (w: World) => {
    w.messages = [
      { role: 'user', content: 'fix the crash in parser.ts' },
      { role: 'assistant', content: [{ type: 'text', text: '改了一版，第三个函数还没看。要我继续看第三个函数吗？' }] },
    ]
  }

  test('a prompt that carries on the task starts at the highest level the task reached, and the record keeps it', async ($, on) => {
    const w = world(on, { jev: reads(0.9), store: record('xhigh') })
    turn(w)
    await submit($, '再看看第三个函数')
    await step($, 0)
    expect(sent(w)).toEqual(['xhigh'])
    const prompt = rows(w, 'prompt').at(-1)!
    expect(prompt.followUp).toMatchObject({ continues: 0.9, yes: false })
    expect(prompt.reasons).toContain('same task (0.90) → stays at xhigh')
    expect(w.asks[0]!.questions).toEqual(['task_type', 'deep', 'dissatisfied', 'continues'])
    // The next message on the same task still holds it.
    await submit($, '那第四个呢')
    await step($, 0)
    expect(sent(w)).toEqual(['xhigh', 'xhigh'])
  })

  test('a new task starts from the table, and the level it reached no longer holds', async ($, on) => {
    let continues = 0.1
    const w = world(on, { jev: (q, input) => reads(continues)(q, input), store: record('xhigh') })
    turn(w)
    await submit($, '换个事：README 里加一段安装说明')
    await step($, 0)
    // code on Opus 5.5 starts low; these tests' floor is high
    expect(sent(w)).toEqual(['high'])
    expect(rows(w, 'prompt').at(-1)!.reasons.some((r: string) => r.startsWith('same task'))).toBe(false)
    continues = 0.9
    await submit($, '再补一句 bun 的装法')
    await step($, 0)
    expect(sent(w)).toEqual(['high', 'high'])
  })

  test('magpie-tasks\' relay prompt changes nothing: no Jev ask, no prompt row, and the next message continues the record the last prompt left', async ($, on) => {
    const w = world(on, { jev: reads(0.9), store: record('xhigh') })
    turn(w)
    await $.prompt.submit({ text: '[magpie-tasks spawn req-42]', wait: false, origin: { kind: 'plugin', name: 'magpie-tasks' } })
    expect(w.asks).toHaveLength(0)
    expect(rows(w, 'prompt')).toHaveLength(0)
    await submit($, '再看看第三个函数')
    await step($, 0)
    expect(sent(w)).toEqual(['xhigh'])
    // The record the relay left alone: the person's message is the session's fourth prompt, on the task that reached xhigh.
    expect(rows(w, 'prompt').at(-1)).toMatchObject({ prompt: 4, origin: 'sdk' })
    expect(rows(w, 'prompt').at(-1)!.reasons).toContain('same task (0.90) → stays at xhigh')
  })

  test('on Mythos a level carried into the next prompt becomes the task\'s level for the prompts after it', async ($, on) => {
    let continues = 0.9
    const w = world(on, { model: MYTHOS, jev: (q, input) => reads(continues)(q, input) })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'high', { model: MYTHOS })
    const n = await failEditFail($, w, 1, MYTHOS)
    await step($, n, 'high', { model: MYTHOS })
    expect(sent(w).at(-1)).toBe('high')
    await complete($)
    turn(w)
    await submit($, '继续看第三个函数')
    await step($, 0, 'high', { model: MYTHOS })
    expect(sent(w).at(-1)).toBe('xhigh')
    await bash(w, $, 'npm test')
    await complete($)
    await submit($, '那第四个呢')
    await step($, 0, 'high', { model: MYTHOS })
    expect(sent(w).at(-1)).toBe('xhigh')
    continues = 0.1
    await submit($, '另一个问题：CI 为什么这么慢')
    await step($, 0, 'high', { model: MYTHOS })
    expect(sent(w).at(-1)).toBe('high')
  })
})
