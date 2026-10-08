import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { ADVISOR_NOTE } from './register'

// The world beneath the mod: config file, journal, Jev, session and model are
// answered by the test's own hooks; the engine's $ drives the mod's hooks.

const DIR = '/cfg/jev-opus'
const NO_KEY = [
  'JEV_OPUS_MIN_EFFORT=medium',
  'JEV_OPUS_MAX_EFFORT=max',
].join('\n')
const ENV = [
  'JEV_BASE_URL=http://jev.test/v1/systemone',
  'JEV_API_KEY=test-key',
  'JEV_DEADLINE_MS=3500',
  'JEV_OPUS_MIN_EFFORT=medium',
  'JEV_OPUS_MAX_EFFORT=max',
  'JEV_OPUS_DISSAT_YES=0.75',
].join('\n')

type Answers = Record<string, unknown>
type Msg = { role: string; content: unknown }

interface World {
  files: Map<string, string>
  asks: Array<{ questions: string[]; state: string; auth: string | undefined }>
  steps: Array<{ index: number; effort: unknown; agentId?: string }>
  contexts: Array<readonly string[] | undefined>
  status: string[]
  toasts: string[]
  messages: Msg[]
  clock: ReturnType<typeof mock.clock>
  /** the next Bash call's outcome */
  fail: boolean
}

interface Opts {
  env?: string | null
  /** Jev's answers for one ask; null from it = never answers */
  jev?: (questions: string[], state: string) => Answers | null
  settings?: Record<string, unknown>
  agentRows?: Record<string, Array<{ role: 'user' | 'assistant'; text: string }>>
  store?: Record<string, unknown>
  /** session.id throws: every routing hook fails */
  brokenSession?: boolean
}

/** Peaked answers, so the recomputed confidence clears every gate. */
const choice = (c: string, keys: string[]) => ({ choice: c, confidence: 0.9, probabilities: Object.fromEntries(keys.map((k) => [k, k === c ? 0.92 : 0.08 / (keys.length - 1)])) })
const PHASES = ['exploring', 'implementing', 'diagnosing', 'verifying', 'finishing']
const TYPES = ['chat', 'explain', 'operate', 'write', 'code', 'research']

/** Deterministic Jev: code task, diagnosing a hard step after a failure, fault on 不对. */
export function stubJev(questions: string[], state: string): Answers {
  if (questions.includes('task_type')) return { task_type: choice('code', TYPES), deep: { noul: 0.3 } }
  if (questions.includes('dissatisfied')) return { dissatisfied: { noul: /不对|wrong/.test(state.split("USER'S LATEST MESSAGE:")[1] ?? '') ? 0.9 : 0.1 } }
  const failed = /→ FAILED/.test(state)
  return {
    phase: choice(failed ? 'diagnosing' : /TOOL CALLS JUST MADE:\n- (Edit|Write)/.test(state) ? 'implementing' : 'finishing', PHASES),
    step_difficulty: { score: failed ? 3.5 : 1, confidence: 0.9 },
    stuck: { noul: 0.1 },
  }
}

function world(on: On, o: Opts = {}): World {
  const w: World = { files: new Map(), asks: [], steps: [], contexts: [], status: [], toasts: [], messages: [], clock: mock.clock(on, { now: 1_000 }), fail: false }
  if (o.env !== null) w.files.set(`${DIR}/.env`, o.env ?? ENV)
  mock.env(on, { HOME: '/home/u', JEV_OPUS_CONFIG_DIR: DIR })
  mock.store(on, o.store ?? {})
  on('fs.read', ($, e) => (w.files.has(e.path) ? { value: w.files.get(e.path)! } : { deny: `ENOENT ${e.path}` }))
  on('fs.write', ($, e) => (w.files.set(e.path, e.text), { value: undefined }))
  const jev = o.jev ?? stubJev
  on('http.fetch', async ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as { state: string; questions: Record<string, unknown> }
    const questions = Object.keys(body.questions)
    w.asks.push({ questions, state: body.state, auth: e.init?.headers?.Authorization })
    const answers = jev(questions, body.state)
    if (!answers) return new Promise(() => {}) // never answers: the deadline decides
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers, usage: { input_tokens: 10 } }) } }
  })
  on('session.id', () => {
    if (o.brokenSession) throw new Error('boom')
    return { value: 'sess-1' }
  })
  on('session.messages', ($, e) => {
    if (e.agentId) return { value: (o.agentRows?.[e.agentId] ?? []).map((r) => ({ ...r, toolUses: [] })) }
    return { value: w.messages as never }
  })
  on('settings.read', () => ({ value: (o.settings ?? {}) as never }))
  on('tool.list', () => ({ value: [] }))
  on('ui.status', ($, e) => (w.status.push(e.text ?? ''), { value: undefined }))
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => (w.contexts.push(e.context), { text: e.text, context: e.context, origin: e.origin }))
  on('turn.step', async function* ($, e) {
    w.steps.push({ index: e.index, effort: e.effort, ...(e.agentId ? { agentId: e.agentId } : {}) })
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'working on it', toolUses: [], stopReason: 'tool_use', usage: null }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') {
      return w.fail
        ? { isError: true as const, result: 'Exit code 1', text: 'not ok 1 - adds\n# tests 1\n# pass 0\n# fail 1\nExit code 1' }
        : { result: { stdout: '# tests 1\n# pass 1\n# fail 0', stderr: '', interrupted: false } as never, text: '# tests 1\n# pass 1\n# fail 0' }
    }
    return { result: { ok: true } as never, text: 'The file has been updated.' }
  })
  return w
}

async function step($: any, index: number, effort: unknown = 'xhigh', extra: Record<string, unknown> = {}): Promise<void> {
  const s = $.turn.step({ turnId: 'turn-1', index, model: 'claude-opus-5-5', effort, messageCount: 3 + index, ...extra })
  for await (const _ of s) { /* drain */ }
}

const submit = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' } })
const bash = (w: World, $: any, command: string, fail = false) => ((w.fail = fail), $.tool.call({ tool: 'Bash', command }))
const edit = ($: any, file: string) => $.tool.call({ tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b' })
const sent = (w: World) => w.steps.map((s) => s.effort)
const journal = (w: World) => (w.files.get(`${DIR}/mod-journal.jsonl`) ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>)

describe('task and step routing', () => {
  test('a code task starts at medium, a failing check raises, a pass steps back down', async ($, on) => {
    const w = world(on)
    await submit($, 'add a unit test for add() and fix the bug')
    await step($, 0)
    await bash(w, $, 'npm test', true)
    await step($, 1)
    await edit($, '/repo/add.js')
    await step($, 2)
    await bash(w, $, 'npm test')
    await step($, 3)
    expect(sent(w)).toEqual(['medium', 'high', 'high', 'medium'])
    const j = journal(w)
    expect(j.map((r) => r.event)).toEqual(['prompt', 'step', 'step', 'step', 'step'])
    expect(j[2]!.source).toBe('jev')
    expect(j[2]!.signals.phase).toBe('diagnosing')
    expect(j[2]!.evidence.observed[0]).toMatchObject({ tool: 'Bash', outcome: 'failed' })
    expect(j[4]!.reasons[0]).toBe('failing check now passes → release hold')
    expect(w.status.at(-1)).toBe('Jev · medium → high → medium')
    expect(w.asks[0]!.auth).toBe('Bearer test-key')
  })

  test('the journal holds no prompt text and no key', async ($, on) => {
    const w = world(on)
    await submit($, 'secret-prompt-words please fix')
    await step($, 0)
    const text = w.files.get(`${DIR}/mod-journal.jsonl`) ?? ''
    expect(text).not.toContain('secret-prompt-words')
    expect(text).not.toContain('test-key')
  })

  test('no config: heuristics only, no network', async ($, on) => {
    const w = world(on, { env: null })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    await bash(w, $, 'npm test', true)
    await step($, 1)
    expect(w.asks.length).toBe(0)
    // default bounds low..high: code → medium, failed check → high
    expect(sent(w)).toEqual(['medium', 'high'])
    expect(journal(w)[0]!.source).toBe('heuristic')
  })

  test('Jev past its deadline: heuristics, the request is not held', async ($, on) => {
    const w = world(on, { jev: () => null })
    const pending = submit($, 'fix the crash in parser.ts')
    await w.clock.advance(3_500)
    await pending
    await step($, 0)
    expect(sent(w)).toEqual(['medium'])
    expect(journal(w)[0]).toMatchObject({ source: 'heuristic', jevError: 'deadline' })
  })

  test('a non-Opus model and a numeric effort pass through untouched', async ($, on) => {
    const w = world(on)
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'xhigh', { model: 'claude-haiku-4-5' })
    await step($, 1, 3)
    expect(sent(w)).toEqual(['xhigh', 3])
  })

  test('a hook failure leaves the request as the engine made it', async ($, on) => {
    const w = world(on, { brokenSession: true })
    await step($, 0, 'xhigh')
    expect(sent(w)).toEqual(['xhigh'])
  })
})

describe('manual override', () => {
  test('a changed session effort (/effort) is pinned for the rest of the prompt', async ($, on) => {
    const w = world(on)
    await submit($, 'fix the crash in parser.ts')
    await step($, 0, 'xhigh')
    await bash(w, $, 'npm test', true)
    await step($, 1, 'low')
    await bash(w, $, 'npm test', true)
    await step($, 2, 'low')
    expect(sent(w)).toEqual(['medium', 'low', 'low'])
    expect(journal(w).at(-1)).toMatchObject({ source: 'pinned', reasons: ['manual override'], manual: true })
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
    expect(sent(w)).toEqual(['medium', 'high', 'xhigh'])
    const prompt = journal(w).filter((r) => r.event === 'prompt').at(-1)!
    expect(prompt.followUp).toMatchObject({ yes: true, prevMax: 'high', raisedTo: 'xhigh', streak: 1, advisor: false })
    expect(w.asks.some((a) => a.questions.includes('dissatisfied') && a.state.includes('PREVIOUS USER REQUEST: add a unit test'))).toBe(true)
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
    expect(sent(w)).toEqual(['medium'])
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
})

describe('borrowed from jev-pilot', () => {
  test('a short acknowledgement never starts below the previous prompt\'s level', async ($, on) => {
    const w = world(on, { env: NO_KEY, store: { 'session:sess-1': { max: 'xhigh', last: 'high', followUp: null, at: 1 } } })
    await submit($, '好的')
    await step($, 0)
    await submit($, '继续')
    await step($, 0)
    expect(sent(w)).toEqual(['high', 'high'])
    expect(journal(w)[0]!.reasons.at(-1)).toBe('short acknowledgement → stays at high')
  })

  test('the same file edited four times with an open failure counts as stuck', async ($, on) => {
    const w = world(on, { env: NO_KEY })
    await submit($, 'fix the crash in parser.ts')
    await step($, 0)
    await bash(w, $, 'npm test', true)
    await step($, 1)
    for (let i = 0; i < 3; i++) await edit($, '/repo/parser.ts')
    await step($, 2)
    await edit($, '/repo/parser.ts')
    await step($, 3)
    const last = journal(w).at(-1)!
    expect(last.reasons.some((r: string) => r.includes('one file edited 4×'))).toBe(true)
    // stuck jumps at least two levels above the task level: medium → xhigh (max only after xhigh fails twice)
    expect(sent(w).at(-1)).toBe('xhigh')
  })
})

describe('subagents', () => {
  test('a subagent routes its own brief and never asks the follow-up question', async ($, on) => {
    const w = world(on, { agentRows: { 'agent-7': [{ role: 'user', text: 'Investigate why the parser crashes on empty input' }] } })
    await step($, 0, 'xhigh', { agentId: 'agent-7' })
    expect(w.steps[0]).toEqual({ index: 0, effort: 'medium', agentId: 'agent-7' })
    expect(w.asks.map((a) => a.questions[0])).toEqual(['task_type'])
    expect(journal(w)[0]).toMatchObject({ agent: 'agent-7', kind: 'task' })
  })
})
