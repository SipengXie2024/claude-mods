/**
 * Offline evaluation of the rolling recap: does Jev name the task kind and
 * start level better when it reads the conversation's recap?
 *
 *   bun mods/jev/eval/recap-eval.ts
 *
 * For every session that holds a labeled prompt, the session is replayed in
 * prompt order from its transcript. After each turn the recap is rewritten as
 * the hook does it (Haiku through the claude CLI, the recap fallback endpoint
 * when Haiku gives no text), and each prompt is put to Jev three times:
 *   A  the prompt alone (Jev before the recap),
 *   B  with the previous request and the end of the last reply (no recap yet, or it failed),
 *   C  with the recap, plus the reply's end when the recap has not read it.
 * The journal's own profile for the prompt (as it ran) is a fourth column.
 *
 * Every Haiku, fallback and Jev answer is cached under the Jev config folder
 * (eval/recap-cache.jsonl, keyed by the exact request), so a rerun after more
 * labels are confirmed scores them without new calls. Items come from
 * eval/items.jsonl as `jev-eval.ts extract` wrote it; run that first only when
 * new prompts should join.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyPolicyConfig, modConfig, parseEnvFile } from '../src/config'
import { clampEffort, EFFORT_LEVELS, rank, type Effort } from '../src/effort'
import { isHumanPrompt, type Message } from '../src/followup'
import { hash20 } from '../src/hash'
import { JevClient, JevFallback, type JevIo, type JevSource } from '../src/jev'
import { getDeepThresholds, isDeep, modelScale, policyVersion, setDeepThresholds, taskEffort, typeTrusted, type Bounds } from '../src/policy'
import { TASK_SET_VERSION, TASK_TYPES, type TaskType } from '../src/questions'
import { chatRecap, conversationContext, lastAgentText, RECAP_SYSTEM, recapIncrement, recapPrompt, renderSpan, type Recap } from '../src/recap'
import { EffortRouter, taskState } from '../src/router'
import type { TaskProfile } from '../src/types'
import { isPerson } from './labelers'

const DIR = process.env.JEV_OPUS_CONFIG_DIR || join(homedir(), '.config', 'jev-opus')
const OUT = join(DIR, 'eval')
const CACHE = join(OUT, 'recap-cache.jsonl')
/**
 * Which labeled set: `batch1` (journal prompts, labels.jsonl), `batch2` (the
 * hindsight sample), `recheck` (your batch-1 prompts judged again). Batch 1
 * replays each session's recap turn by turn from the first prompt Jev saw;
 * the other two, drawn from long and older sessions, give each prompt a recap
 * written in one go from the RECAP_WINDOW prompts before it, which stands in
 * for the session-long recap production keeps.
 */
const SET = (process.env.RECAP_EVAL_SET ?? 'batch1') as 'batch1' | 'batch2' | 'recheck'
const FILES = { batch1: ['items.jsonl', 'labels.jsonl'], batch2: ['batch2-items.jsonl', 'batch2-labels.jsonl'], recheck: ['recheck-items.jsonl', 'recheck-labels.jsonl'] }[SET]
const RECAP_WINDOW = 6
const RECAPS = join(OUT, SET === 'batch1' ? 'recaps.jsonl' : `recaps-${SET}.jsonl`)
const REPORT = join(OUT, SET === 'batch1' ? 'recap-report.md' : `recap-report-${SET}.md`)
const PROJECTS = join(homedir(), '.claude', 'projects')
const CLAUDE = process.env.CLAUDE_BIN || 'claude'
/** Generous for the eval: latency is recorded and compared with the production deadline instead. */
const EVAL_DEADLINE_MS = 30_000
const MATCH_WINDOW_MS = 120_000
const SHORT_CHARS = 40
const PARALLEL = 4
const ALL: Bounds = { min: 'low', max: 'max' }

type Row = Record<string, any>
type Condition = 'A' | 'B' | 'C'
interface Item { id: string; session: string; at: number; text: string | null; prompt?: number; effort?: Effort; profile?: TaskProfile | null }
interface Label { id: string; by: string | null; kind: TaskType | null; effort: Effort | null }
interface Judged { kind: TaskType; trusted: boolean; deep: boolean; effort: Effort; unbounded: Effort; latencyMs: number; provider: string | null; error: string | null }

const readJsonl = (path: string): Row[] => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

// ---- cache --------------------------------------------------------------

const cache = new Map<string, Row>(existsSync(CACHE) ? readJsonl(CACHE).map((r) => [r.key, r.value]) : [])
function cached<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined
}
function store(key: string, value: Row): void {
  cache.set(key, value)
  appendFileSync(CACHE, JSON.stringify({ key, value }) + '\n', { mode: 0o600 })
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!)
  }))
}

// ---- transcripts as the hook reads them ---------------------------------

/** Copies of the labeled sessions' transcripts, kept because Claude Code cleans up old ones. */
const KEPT = join(OUT, 'transcripts')

/** The session's transcript: the kept copy first, else Claude Code's own; null once both are gone. */
function findTranscript(session: string): string | null {
  const kept = join(KEPT, `${session}.jsonl`)
  if (existsSync(kept)) return kept
  for (const d of readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const p = join(PROJECTS, d.name, `${session}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}

function transcriptPath(session: string): string {
  const p = findTranscript(session)
  if (!p) throw new Error(`no transcript for session ${session}`)
  return p
}

/**
 * The main thread's user and assistant messages in order, each with its time:
 * an assistant message streamed as several rows (one per block, same message
 * id) joined into one, as `$.session.messages({ as: 'api' })` returns it.
 */
function apiMessages(session: string): Array<{ at: number; m: Message }> {
  const out: Array<{ at: number; m: Message; id?: string }> = []
  for (const r of readJsonl(transcriptPath(session))) {
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isSidechain || !r.message) continue
    const at = Date.parse(r.timestamp)
    const content = r.message.content
    const last = out[out.length - 1]
    if (r.type === 'assistant' && last && last.m.role === 'assistant' && last.id && last.id === r.message.id) {
      last.m = { role: 'assistant', content: [...(last.m.content as unknown[]), ...(Array.isArray(content) ? content : [])] }
      continue
    }
    out.push({ at, m: { role: r.type, content: r.type === 'assistant' && !Array.isArray(content) ? [{ type: 'text', text: String(content) }] : content, ...(r.type === 'assistant' && r.message.model ? { model: r.message.model } : {}) }, id: r.message.id })
  }
  return out.map(({ at, m }) => ({ at, m }))
}

/** Index of the message a prompt row answers: the last human prompt at or before it, within the window. */
function promptIndex(msgs: Array<{ at: number; m: Message }>, at: number): number {
  let k = -1
  for (let i = 0; i < msgs.length; i++) {
    const x = msgs[i]!
    if (x.at <= at && at - x.at <= MATCH_WINDOW_MS && isHumanPrompt(x.m)) k = i
  }
  return k
}

// ---- recap writers --------------------------------------------------------

async function haikuRecap(prompt: string): Promise<{ text: string } | { error: string }> {
  const proc = Bun.spawn([CLAUDE, '-p', '--no-session-persistence', '--model', 'haiku', '--setting-sources', 'user', '--tools', '', '--system-prompt', RECAP_SYSTEM, '--output-format', 'json'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  proc.stdin.write(prompt)
  proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const d = JSON.parse(out) as { is_error?: boolean; result?: string; terminal_reason?: string }
  const text = d.is_error ? '' : (d.result ?? '').trim()
  return text ? { text } : { error: d.terminal_reason ?? 'empty-reply' }
}

async function writeRecap(prompt: string, fallback: ReturnType<typeof modConfig>['recapFallback']): Promise<{ text: string; model: string } | null> {
  const key = `recap:${hash20(prompt)}`
  const hit = cached<{ text: string; model: string } | { failed: true }>(key)
  if (hit) return 'failed' in hit ? null : hit
  const h = await haikuRecap(prompt)
  let result: { text: string; model: string } | null = 'text' in h ? { text: h.text, model: 'haiku' } : null
  if (!result && fallback) {
    const f = await chatRecap((url, init) => fetch(url, init).then(async (r) => ({ status: r.status, ok: r.ok, text: await r.text() })), fallback, prompt)
    if ('text' in f) result = { text: f.text, model: fallback.model }
  }
  store(key, result ?? { failed: true })
  return result
}

// ---- Jev ------------------------------------------------------------------

const io: JevIo = {
  fetch: (url, init) => fetch(url, init).then(async (r) => ({ status: r.status, ok: r.ok, text: await r.text() })),
  now: async () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
  }),
}

/**
 * Jev's task answer for one state, cached under the question-set version: the
 * profile (kind, confidence, deep) is kept and the start level is computed
 * from it here, with the model's table and the current bounds, so a changed
 * table or bound needs no new call.
 */
async function judge(source: JevSource | null, bounds: Bounds, text: string, note: string, model: string | null): Promise<Judged> {
  // The fallback's deep counts since policy.v12: answers cached before that recorded it as unknown.
  const key = `jev:${TASK_SET_VERSION}:fallback-deep:${hash20(taskState(text, note || undefined))}`
  let hit = cached<{ profile: TaskProfile; latencyMs: number; provider: string | null; error: string | null }>(key)
  if (!hit) {
    const router = new EffortRouter({ jev: source ? source.bind(io) : null, bounds })
    const d = await router.routeTask(text || '(continuing an earlier task)', null, note || undefined)
    hit = { profile: d.profile ?? router.lastProfileFallback(text), latencyMs: d.jevLatencyMs, provider: d.jevProvider ?? null, error: d.jevError ?? null }
    store(key, hit as unknown as Row)
  }
  const p = hit.profile
  return {
    kind: p.taskType, trusted: typeTrusted(p), deep: isDeep(p), effort: taskEffort(p, bounds, model).effort, unbounded: taskEffort(p, ALL, model).effort,
    latencyMs: hit.latencyMs, provider: hit.provider, error: hit.error,
  }
}

// ---- run --------------------------------------------------------------------

interface Case { item: Item; label: Label; contexts: Record<Condition, string>; recapModel: string | null; /** the model that answered the prompt */ model: string | null }


async function main(): Promise<void> {
  const cfg = modConfig(parseEnvFile(readFileSync(join(DIR, '.env'), 'utf8')))
  applyPolicyConfig(cfg)
  // A deep threshold to try against the labels; the cached answers keep their deep probability, so no new calls.
  if (process.env.RECAP_EVAL_DEEP_YES) setDeepThresholds({ yes: Number(process.env.RECAP_EVAL_DEEP_YES), no: cfg.deep.no })
  const prodDeadline = cfg.jevFallback?.deadlineMs ?? cfg.jev?.deadlineMs ?? null
  for (const c of [cfg.jev, cfg.jevFallback]) if (c) c.deadlineMs = EVAL_DEADLINE_MS
  const clients = [cfg.jev, cfg.jevFallback].filter((c) => c !== null).map((c) => new JevClient(c!))
  const source: JevSource | null = clients.length === 2 ? new JevFallback(clients[0]!, clients[1]!) : clients[0] ?? null

  const items = readJsonl(join(OUT, FILES[0]!)) as Item[]
  const labels = new Map((readJsonl(join(OUT, FILES[1]!)) as Label[]).filter((l) => l.by && l.kind && l.effort).map((l) => [l.id, l]))
  const sessions = [...new Set(items.filter((i) => labels.has(i.id)).map((i) => i.session))]
    .filter((s) => !process.env.RECAP_EVAL_ONLY || s.startsWith(process.env.RECAP_EVAL_ONLY))
    .slice(0, Number(process.env.RECAP_EVAL_SESSIONS) || undefined)

  // A session whose transcript Claude Code has since cleaned up cannot be replayed: say how many labels that leaves out.
  const gone = sessions.filter((s) => findTranscript(s) === null)
  const skipped = items.filter((i) => gone.includes(i.session) && labels.has(i.id)).length
  sessions.splice(0, sessions.length, ...sessions.filter((s) => !gone.includes(s)))
  const cases: Case[] = []
  const recapRows: Row[] = []
  let recapCalls = 0
  await pool(sessions, PARALLEL, async (session) => {
    const msgs = apiMessages(session)
    let recap: Recap | null = null
    let recapModel: string | null = null
    const own = items.filter((i) => i.session === session).sort((a, b) => a.at - b.at)
    for (const [n, item] of own.entries()) {
      const k = promptIndex(msgs, item.at)
      if (k < 0) continue
      const before = msgs.slice(0, k).map((x) => x.m)
      if (SET !== 'batch1') {
        if (!labels.has(item.id)) continue
        // One recap from the window of prompts before this one.
        let start = k
        for (let seen = 0; start > 0 && seen < RECAP_WINDOW; ) if (isHumanPrompt(msgs[--start]!.m)) seen++
        const span = renderSpan(before.slice(start))
        recap = null
        recapModel = null
        if (span) {
          recapCalls++
          const written = await writeRecap(recapPrompt(null, span), cfg.recapFallback)
          if (written) {
            recap = { text: written.text, coversHash: hash20(lastAgentText(before)), at: item.at }
            recapModel = written.model
          }
        }
      } else if (n > 0) {
        // The recap the hook would hold now: rewritten after every turn since it first saw this session.
        const increment = recapIncrement(before, recap?.coversHash ?? null)
        if (increment) {
          recapCalls++
          const written = await writeRecap(recapPrompt(recap?.text ?? null, increment), cfg.recapFallback)
          if (written) {
            recap = { text: written.text, coversHash: hash20(lastAgentText(before)), at: item.at }
            recapModel = written.model
          }
        }
      }
      const label = labels.get(item.id)
      recapRows.push({ id: item.id, model: recapModel, recap: recap?.text ?? null })
      if (!label || item.text === null) continue
      const answeredBy = (item as Row).model ?? msgs.slice(k + 1).find((x) => x.m.role === 'assistant' && x.m.model)?.m.model ?? null
      cases.push({
        item, label, recapModel, model: answeredBy as string | null,
        contexts: { A: '', B: conversationContext(before, null).text, C: conversationContext(before, recap).text },
      })
    }
  })
  writeFileSync(RECAPS, recapRows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })

  const results = new Map<string, Record<Condition, Judged>>()
  const jobs = cases.flatMap((c) => (['A', 'B', 'C'] as Condition[]).map((cond) => ({ c, cond })))
  await pool(jobs, PARALLEL, async ({ c, cond }) => {
    const j = await judge(source, cfg.bounds, c.item.text!, c.contexts[cond], c.model)
    const r = results.get(c.item.id) ?? ({} as Record<Condition, Judged>)
    r[cond] = j
    results.set(c.item.id, r)
  })

  report(cases, results, cfg.bounds, prodDeadline, recapCalls, { sessions: gone.length, labels: skipped })
}

// ---- report -------------------------------------------------------------------

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-')

function report(cases: Case[], results: Map<string, Record<Condition, Judged>>, bounds: Bounds, prodDeadline: number | null, recapCalls: number, gone: { sessions: number; labels: number }): void {
  const lines: string[] = []
  const say = (s = '') => { lines.push(s); console.log(s) }
  const table = (head: string[], rows: (string | number)[][]) => {
    say(`| ${head.join(' | ')} |`)
    say(`|${head.map(() => '---').join('|')}|`)
    for (const r of rows) say(`| ${r.join(' | ')} |`)
    say()
  }
  const all = [...results.values()].flatMap((r) => Object.values(r))
  const providers = [...new Set(all.map((j) => j.provider ?? 'none'))].join(', ')
  say(`# Rolling recap eval: ${SET} (${policyVersion()})`)
  say()
  say(`Jev answered from: ${providers}. Effort at router level with production bounds ${bounds.min}..${bounds.max}; the hook's acknowledgement floor, follow-up raise and exploration are not applied.`)
  say(`Recap rewrites: ${recapCalls}; prompts with a recap in condition C: ${cases.filter((c) => c.contexts.C.startsWith('RECAP:')).length} of ${cases.length}.`)
  if (gone.labels) say(`Left out: ${gone.labels} labeled prompts from ${gone.sessions} sessions whose transcripts Claude Code has since cleaned up.`)
  say()

  type Col = { name: string; kind: (c: Case) => TaskType | null; effort: (c: Case) => Effort | null }
  const journaled = cases.some((c) => c.item.profile)
  const cols: Col[] = [
    ...(journaled ? [{ name: 'journal (as it ran)', kind: (c: Case) => c.item.profile?.taskType ?? null, effort: (c: Case) => c.item.effort ?? null }] : []),
    ...(['A', 'B', 'C'] as Condition[]).map((cond) => ({ name: { A: 'A prompt only', B: 'B reply end + last turn', C: 'C recap + reply end + last turn' }[cond], kind: (c: Case) => results.get(c.item.id)?.[cond]?.kind ?? null, effort: (c: Case) => results.get(c.item.id)?.[cond]?.effort ?? null })),
    { name: 'C recap, no effort floor', kind: (c: Case) => results.get(c.item.id)?.C?.kind ?? null, effort: (c: Case) => results.get(c.item.id)?.C?.unbounded ?? null },
  ]
  const group = (name: string, cs: Case[]) => {
    say(`## ${name} (n=${cs.length})`)
    say()
    table(['condition', 'kind agrees', 'effort exact', 'too low', 'too high'], cols.map((col) => {
      const eff = cs.map((c) => [col.effort(c), c.label.effort] as const).filter(([g]) => g !== null)
      const d = eff.map(([g, w]) => rank(g!) - rank(w!))
      return [col.name, pct(cs.filter((c) => col.kind(c) === c.label.kind).length, cs.length), pct(d.filter((x) => x === 0).length, d.length), pct(d.filter((x) => x < 0).length, d.length), pct(d.filter((x) => x > 0).length, d.length)]
    }))
  }
  const person = cases.filter((c) => isPerson(c.label.by))
  const agreed = cases.filter((c) => c.label.by === 'opus+sonnet')
  const draft = cases.filter((c) => c.label.by === 'claude-draft')
  if (person.length) {
    group('Your labels', person)
    group(`Your labels, prompts of ${SHORT_CHARS} characters or fewer`, person.filter((c) => c.item.text!.trim().length <= SHORT_CHARS))
  }
  if (agreed.length) {
    group('Both models agreed (Opus and Sonnet, with hindsight)', agreed)
    group(`Both models agreed, prompts of ${SHORT_CHARS} characters or fewer`, agreed.filter((c) => c.item.text!.trim().length <= SHORT_CHARS))
  }
  if (draft.length) group('Draft labels', draft)

  say('## Kind agreement on your labels, by labeled kind')
  say()
  const kinds = Object.keys(TASK_TYPES) as TaskType[]
  table(['kind', 'n', ...cols.map((c) => c.name)], kinds.map((k) => person.filter((c) => c.label.kind === k)).filter((cs) => cs.length)
    .map((cs) => [cs[0]!.label.kind!, cs.length, ...cols.map((col) => pct(cs.filter((c) => col.kind(c) === c.label.kind).length, cs.length))]))

  const lat = all.map((j) => j.latencyMs).filter((x) => x > 0).sort((a, b) => a - b)
  if (lat.length) {
    say(`Jev latency: median ${lat[Math.floor(lat.length / 2)]} ms, 90th percentile ${lat[Math.floor(lat.length * 0.9)]} ms${prodDeadline ? `; ${pct(lat.filter((x) => x > prodDeadline).length, lat.length)} over the production fallback deadline of ${prodDeadline} ms` : ''}. Errors: ${all.filter((j) => j.error).length}.`)
    say()
  }

  const changed = person.filter((c) => {
    const r = results.get(c.item.id)
    return r && r.A.kind !== c.label.kind && r.C.kind === c.label.kind
  })
  say(`## Your labels that the recap fixed (${changed.length})`)
  say()
  for (const c of changed.slice(0, 15)) say(`- ${c.item.id.slice(0, 13)} #${c.item.prompt ?? c.item.id.split('#')[1]} "${c.item.text!.trim().slice(0, 40).replace(/\s+/g, ' ')}": A ${results.get(c.item.id)!.A.kind} → C ${results.get(c.item.id)!.C.kind} (label ${c.label.kind}/${c.label.effort})`)
  say()
  const broke = person.filter((c) => {
    const r = results.get(c.item.id)
    return r && r.A.kind === c.label.kind && r.C.kind !== c.label.kind
  })
  say(`## Your labels that the recap broke (${broke.length})`)
  say()
  for (const c of broke.slice(0, 15)) say(`- ${c.item.id.slice(0, 13)} #${c.item.prompt ?? c.item.id.split('#')[1]} "${c.item.text!.trim().slice(0, 40).replace(/\s+/g, ' ')}": A ${results.get(c.item.id)!.A.kind} → C ${results.get(c.item.id)!.C.kind} (label ${c.label.kind}/${c.label.effort})`)
  say()
  say(`## Start level by model table (${policyVersion()}: Opus 5.5 table, Mythos and earlier Opus table)`)
  say()
  const judgedC = cases.map((c) => results.get(c.item.id)?.C).filter((j): j is Judged => !!j)
  say(`Needs deep reasoning (deep at or above ${getDeepThresholds().yes}) in condition C: ${judgedC.filter((j) => j.deep).length} of ${judgedC.length}.`)
  say()
  const LEVELS4: Effort[] = ['low', 'medium', 'high', 'xhigh']
  const levelRow = (name: string, cs: Case[], got: (c: Case) => Effort | null) => {
    const d = cs.map((c) => [got(c), c.label.effort] as const).filter(([g]) => g !== null).map(([g, w]) => rank(g!) - rank(w!))
    return [name, d.length, pct(d.filter((x) => x === 0).length, d.length), pct(d.filter((x) => x < 0).length, d.length), pct(d.filter((x) => x > 0).length, d.length),
      LEVELS4.map((l) => cs.filter((c) => got(c) === l).length).join('/')]
  }
  const routed = (c: Case) => !!c.model && /opus|mythos/i.test(c.model)
  for (const [name, all] of [['Your labels', person], ['Both models agreed', agreed]] as const) {
    for (const scale of ['medium-default', 'high-default'] as const) {
      const cs = all.filter((c) => routed(c) && modelScale(c.model) === scale)
      if (!cs.length) continue
      say(`### ${name}, ${scale === 'medium-default' ? 'Opus 5.5 table' : 'Mythos / earlier Opus table'} (n=${cs.length})`)
      say()
      table(['condition', 'n', 'exact', 'too low', 'too high', 'low/medium/high/xhigh'], (['A', 'B', 'C'] as Condition[]).map((cond) =>
        levelRow({ A: 'A prompt only', B: 'B previous request + reply end + last turn', C: 'C recap + reply end + last turn' }[cond], cs, (c) => results.get(c.item.id)?.[cond]?.effort ?? null)))
    }
  }
  // Per prompt, for reading examples: the label and the level under each condition.
  const perCase = cases.map((c) => ({
    id: c.item.id, by: c.label.by, model: c.model, text: c.item.text!.trim().slice(0, 80), label: c.label.effort, labelKind: c.label.kind,
    A: results.get(c.item.id)?.A?.effort ?? null, C: results.get(c.item.id)?.C?.effort ?? null, kindC: results.get(c.item.id)?.C?.kind ?? null,
  }))
  writeFileSync(join(OUT, `level-cases-${SET}.jsonl`), perCase.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
  writeFileSync(REPORT, lines.join('\n') + '\n', { mode: 0o600 })
  console.log(`report: ${REPORT}`)
}

await main()
