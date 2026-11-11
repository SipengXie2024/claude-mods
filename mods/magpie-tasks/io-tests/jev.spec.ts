// The Decisions client against the real OpenAI endpoint (plan section 12.1, jev row). The key is read
// from its file by the client (and by the saving step below) and never printed. Inputs are real text:
// a subagent view from the probe dumps and the routing table as it is on disk.
//
// SAVE_JEV_DATA=1 also saves the raw response of the first request to tests/data/jev-choice-predicate.json
// for tests/jev.test.ts; regenerate the test modules afterwards with `bun eval/rules-eval.ts data`.
import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { subagentDialogue, type ApiMessage } from '../src/dialogue'
import { ask, buildRequest, recomputedConfidence, type JevConfig, type JevMessage, type JevQuestion } from '../src/jev'
import { DEEP_QUESTION } from '../src/judge'
import { dataModules, PLUGIN_ROOT } from '../eval/rules-eval'
import { nodeIo } from './node-io'

const KEY_FILE = join(homedir(), '.config/jev-opus/openai-jev.key')
const CFG: JevConfig = { url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', keyFile: KEY_FILE, deadlineMs: 30000 }
const DATA = join(PLUGIN_ROOT, 'tests/data')
const dump = (name: string) => (JSON.parse(readFileSync(join(DATA, `api-${name}.json`), 'utf8')) as { api: ApiMessage[] }).api

// The subagent view of probe dump 048: brief, coordinator message, reply, event, final answer.
const VIEW = subagentDialogue(dump('048-sub-a83b0057bf058d018-complete'))
const QUESTIONS: JevQuestion[] = [
  {
    name: 'kind', type: 'choice', instructions: 'What kind of work does the latest user message ask the agent to do?',
    choices: [
      { value: 'operate', description: 'Running commands or acting on the environment without changing program logic' },
      { value: 'code', description: 'Writing, changing or debugging source code' },
      { value: 'explain', description: 'Explaining something that already exists' },
    ],
  },
  { name: 'deep', type: 'predicate', instructions: DEEP_QUESTION },
]

test('a message list with one choice and one predicate comes back parsed', async () => {
  const io = nodeIo()
  const r = await ask(io, CFG, VIEW, QUESTIONS)
  if (!r.ok) throw new Error(`Jev failed: ${r.error}`)
  const kind = r.answers['kind']!
  const deep = r.answers['deep']!
  expect(kind.kind).toBe('choice')
  expect(deep.kind).toBe('predicate')
  if (kind.kind !== 'choice' || deep.kind !== 'predicate') return
  expect(['operate', 'code', 'explain']).toContain(kind.choice)
  expect(Object.keys(kind.probabilities).sort()).toEqual(['code', 'explain', 'operate'])
  expect(kind.confidence).toBe(recomputedConfidence(kind.probabilities, 3))
  expect(deep.p).toBeGreaterThanOrEqual(0)
  expect(deep.p).toBeLessThanOrEqual(1)
  expect(r.inputTokens).toBeGreaterThan(0)
  expect(io.calls.filter(c => c.method === 'fetch')).toHaveLength(1)
  console.log(`kind ${kind.choice} ${kind.confidence.toFixed(2)}, deep ${deep.p}, ${r.inputTokens} input tokens, ${r.latencyMs} ms`)

  if (process.env['SAVE_JEV_DATA'] === '1') {
    // The same request once more, raw, for the parser tests.
    const key = readFileSync(KEY_FILE, 'utf8').trim()
    const request = buildRequest(CFG.model, VIEW, QUESTIONS)
    const res = await fetch(CFG.url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
    const body = await res.text()
    expect(res.status).toBe(200)
    writeFileSync(join(DATA, 'jev-choice-predicate.json'), JSON.stringify({ kind: 'decisions', at: new Date().toISOString(), request, status: res.status, body }, null, 2) + '\n')
  }
}, 60000)

test('a message appended to the list reads the earlier messages from the cache', async () => {
  // Over 1,024 tokens of prefix is needed for any cache hit: the routing table opens the list.
  const table = readFileSync(join(PLUGIN_ROOT, '../../.planning/model-routing-table.md'), 'utf8')
  const full: JevMessage[] = [{ role: 'user', content: table }, ...VIEW]
  const first = await ask(nodeIo(), CFG, full.slice(0, -1), QUESTIONS)
  const second = await ask(nodeIo(), CFG, full, QUESTIONS)
  if (!first.ok || !second.ok) throw new Error(`Jev failed: ${!first.ok ? first.error : ''} ${!second.ok ? second.error : ''}`)
  console.log(`first ${first.inputTokens} input (${first.cachedTokens ?? 0} cached), second ${second.inputTokens} input (${second.cachedTokens ?? 0} cached)`)
  expect(second.inputTokens).toBeGreaterThan(first.inputTokens)
  expect(second.cachedTokens ?? 0).toBeGreaterThan(0)
}, 60000)

test('a model the API does not know gives ok: false with the status and category only', async () => {
  const r = await ask(nodeIo(), { ...CFG, model: 'gpt-6-luna-no-such-model' }, VIEW, QUESTIONS)
  expect(r.ok).toBe(false)
  if (r.ok) return
  console.log(`error: ${r.error}`)
  expect(r.error).toMatch(/^HTTP 4\d\d( [\w.-]+)?$/)
}, 60000)

test('a 1 ms deadline gives a timeout', async () => {
  const io = nodeIo()
  const r = await ask(io, { ...CFG, deadlineMs: 1 }, VIEW, QUESTIONS)
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error).toBe('deadline exceeded (1 ms)')
  expect(io.calls.some(c => c.method === 'sleep' && c.ms === 1)).toBe(true)
}, 60000)

test('a missing key file gives ok: false without a request', async () => {
  const io = nodeIo()
  const r = await ask(io, { ...CFG, keyFile: join(homedir(), '.config/jev-opus/no-such-key-file') }, VIEW, QUESTIONS)
  expect(r).toMatchObject({ ok: false, error: 'key file missing' })
  expect(io.calls.filter(c => c.method === 'fetch')).toHaveLength(0)
})

test('the test data modules are the JSON files in tests/data, unchanged', () => {
  for (const [path, text] of Object.entries(dataModules())) expect(readFileSync(path, 'utf8')).toBe(text)
})
