/**
 * A second labeled set for Jev, judged with hindsight.
 *
 *   bun mods/jev/eval/batch.ts sample   transcripts → eval/batch2-items.jsonl (new prompts) and
 *                                        eval/recheck-items.jsonl (your labeled batch-1 prompts)
 *   bun mods/jev/eval/batch.ts merge    the two labelers' chunk files → eval/batch2-labels.jsonl
 *                                        and eval/recheck-labels.jsonl
 *
 * Each item carries what a labeler needs to judge a prompt as it really was:
 * what came before (your previous message, the end of the agent's last reply),
 * the prompt in full, and what came after until your next prompt (tools by
 * name, edited files, commands and failures, time, output tokens, the start and
 * end of the agent's final reply, and your next message, which says whether
 * the work landed). Ids are `<session>#t<transcript row>`, apart from batch 1's
 * journal-numbered ids. Everything stays in the Jev config folder.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { isPerson } from './labelers'

const DIR = process.env.JEV_OPUS_CONFIG_DIR || join(homedir(), '.config', 'jev-opus')
const OUT = join(DIR, 'eval')
const PROJECTS = join(homedir(), '.claude', 'projects')
const SEED = 20261030
const TOTAL = 300
const SHORT_SHARE = 0.6
const SHORT_CHARS = 40
const PER_SESSION = 8
/** Sessions left out: this one, where today's jev work happened. */
const SKIP_SESSIONS = new Set((process.env.BATCH_SKIP_SESSIONS ?? '1a1f3b50-aa80-4be8-bd5f-ea7dd638b8ef').split(',').filter(Boolean))
const MATCH_WINDOW_MS = 120_000
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

type Row = Record<string, any>
/** Complete lines only: a live transcript's last line may still be mid-write, so text after the final newline is left out. */
const readJsonl = (path: string): Row[] => {
  const text = readFileSync(path, 'utf8')
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}
const writeJsonl = (path: string, rows: unknown[]) => writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })

export interface After {
  tools: Record<string, number>
  files: string[]
  bash: number
  bashFailed: number
  durationS: number
  outputTokens: number
  replyStart: string
  replyEnd: string
  next: string | null
}

export interface BatchItem {
  id: string
  session: string
  project: string
  at: number
  text: string
  before: { user: string | null; agent: string | null }
  after: After
}

/** A person's typed prompt: not a tool result, injected context, slash command, harness wrapper or interrupt marker. */
function humanText(r: Row): string | null {
  if (r.type !== 'user' || r.isMeta || r.isSidechain || r.isCompactSummary) return null
  const c = r.message?.content
  let t: string
  if (typeof c === 'string') t = c
  else if (Array.isArray(c) && c.length && c.every((b: Row) => b.type === 'text' || b.type === 'image')) t = c.filter((b: Row) => b.type === 'text').map((b: Row) => b.text).join('\n')
  else return null
  t = t.replace(REMINDER, '').trim()
  if (!t || t.startsWith('/') || (t.startsWith('<') && !t.startsWith('<pasted_content')) || t.startsWith('This session is being continued') || t.startsWith('[Request interrupted')) return null
  return t
}

const agentText = (r: Row): string =>
  r.type === 'assistant' && !r.isSidechain && Array.isArray(r.message?.content)
    ? r.message.content.filter((b: Row) => b.type === 'text').map((b: Row) => b.text).join('')
    : ''

const head = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`)
const tail = (s: string, n: number) => (s.length <= n ? s : `…${s.slice(-n)}`)

/** The agent's last message with text before `end`: its rows share one message id. */
function lastReply(rows: Row[], from: number, end: number): string {
  for (let i = end - 1; i >= from; i--) {
    if (!agentText(rows[i]!)) continue
    const id = rows[i]!.message?.id
    let text = ''
    for (let k = i; k >= from && rows[k]!.type === 'assistant' && rows[k]!.message?.id === id; k--) text = agentText(rows[k]!) + text
    return text
  }
  return ''
}

function afterBlock(rows: Row[], i: number, j: number): After | null {
  const tools: Record<string, number> = {}
  const files: string[] = []
  const bashIds = new Set<string>()
  let failed = 0
  const usage = new Map<string, number>()
  let last = i
  for (let k = i + 1; k < j; k++) {
    const r = rows[k]!
    if (r.isSidechain) continue
    if (r.type === 'assistant') {
      last = k
      const id = r.message?.id
      if (id && r.message?.usage?.output_tokens) usage.set(id, Math.max(usage.get(id) ?? 0, r.message.usage.output_tokens))
      for (const b of Array.isArray(r.message?.content) ? r.message.content : []) {
        if (b.type !== 'tool_use') continue
        tools[b.name] = (tools[b.name] ?? 0) + 1
        if (EDIT_TOOLS.has(b.name) && b.input?.file_path && !files.includes(basename(b.input.file_path))) files.push(basename(b.input.file_path))
        if (b.name === 'Bash') bashIds.add(b.id)
      }
    } else if (r.type === 'user' && Array.isArray(r.message?.content)) {
      for (const b of r.message.content) if (b.type === 'tool_result' && b.is_error === true && bashIds.has(b.tool_use_id)) failed++
    }
  }
  if (last === i) return null
  const reply = lastReply(rows, i + 1, j)
  const nextText = j < rows.length ? humanText(rows[j]!) : null
  return {
    tools, files, bash: bashIds.size, bashFailed: failed,
    durationS: Math.round((Date.parse(rows[last]!.timestamp) - Date.parse(rows[i]!.timestamp)) / 1000),
    outputTokens: [...usage.values()].reduce((a, b) => a + b, 0),
    replyStart: head(reply, 400), replyEnd: reply.length > 400 ? tail(reply.slice(400), 400) : '',
    next: nextText === null ? null : head(nextText, 300),
  }
}

/** Every typed prompt of one transcript with its before and after blocks. */
function promptsOf(path: string): BatchItem[] {
  const session = basename(path, '.jsonl')
  const project = basename(join(path, '..'))
  const rows = readJsonl(path)
  const human: number[] = []
  for (let i = 0; i < rows.length; i++) if (humanText(rows[i]!) !== null) human.push(i)
  const out: BatchItem[] = []
  for (const [n, i] of human.entries()) {
    const j = human[n + 1] ?? rows.length
    const after = afterBlock(rows, i, j)
    if (!after) continue
    const prev = n > 0 ? human[n - 1]! : -1
    out.push({
      id: `${session}#t${i}`, session, project, at: Date.parse(rows[i]!.timestamp), text: head(humanText(rows[i]!)!, 6000),
      before: { user: prev >= 0 ? head(humanText(rows[prev]!)!, 600) : null, agent: prev >= 0 ? tail(lastReply(rows, prev + 1, i), 1500) || null : null },
      after,
    })
  }
  return out
}

function transcripts(): string[] {
  return readdirSync(PROJECTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('-tmp'))
    .flatMap((d) => readdirSync(join(PROJECTS, d.name)).filter((n) => n.endsWith('.jsonl')).map((n) => join(PROJECTS, d.name, n)))
    .filter((p) => !SKIP_SESSIONS.has(basename(p, '.jsonl')))
    .sort()
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sample(): void {
  const batch1 = readJsonl(join(OUT, 'items.jsonl'))
  const labels1 = new Map(readJsonl(join(OUT, 'labels.jsonl')).map((l) => [l.id, l]))
  const seen = new Set(batch1.filter((i) => i.text).map((i) => `${i.session}\u0000${String(i.text).trim()}`))
  const all = transcripts().flatMap(promptsOf)
  const pool = all.filter((p) => !seen.has(`${p.session}\u0000${p.text.trim()}`))

  const rand = mulberry32(SEED)
  const shuffled = pool.map((p) => ({ p, r: rand() })).sort((a, b) => a.r - b.r).map((x) => x.p)
  const perSession = new Map<string, number>()
  const pick = (want: number, ok: (p: BatchItem) => boolean): BatchItem[] => {
    const got: BatchItem[] = []
    for (const p of shuffled) {
      if (got.length >= want) break
      if (!ok(p) || (perSession.get(p.session) ?? 0) >= PER_SESSION) continue
      perSession.set(p.session, (perSession.get(p.session) ?? 0) + 1)
      got.push(p)
    }
    return got
  }
  const short = pick(Math.round(TOTAL * SHORT_SHARE), (p) => p.text.length <= SHORT_CHARS)
  const long = pick(TOTAL - short.length, (p) => p.text.length > SHORT_CHARS)
  const batch2 = [...short, ...long].sort((a, b) => a.at - b.at)
  writeJsonl(join(OUT, 'batch2-items.jsonl'), batch2)

  // Your batch-1 labels, matched to their transcript prompt, for the labelers to judge again.
  const byKey = new Map(all.map((p) => [`${p.session}\u0000${p.text.trim()}`, p]))
  const recheck = batch1.flatMap((i) => {
    const l = labels1.get(i.id)
    if (!l || !l.by || l.by === 'claude-draft' || !i.text) return []
    const p = byKey.get(`${i.session}\u0000${String(i.text).trim()}`)
    return p && Math.abs(p.at - i.at) <= MATCH_WINDOW_MS ? [{ ...p, id: i.id }] : []
  })
  writeJsonl(join(OUT, 'recheck-items.jsonl'), recheck)
  const sessions = new Set(batch2.map((p) => p.session)).size
  console.log(`pool ${pool.length} prompts; batch 2: ${batch2.length} (${short.length} short, ${long.length} long) from ${sessions} sessions; recheck: ${recheck.length} of your labeled prompts`)
}

/** The agreed label of both models, or null when they differ in kind or level. */
interface Opinion { kind: string; effort: string; note: string }
const AUDIT_SHARE = 0.1

/**
 * Joins the two labelers' chunk files. Batch 2: both agree → taken (`opus+sonnet`),
 * a random tenth of those held back for your audit; they differ → yours to decide.
 * Recheck: your batch-1 label stands, unless both models agree with each other
 * and not with you, which puts it before you again with all three opinions.
 * Rows you already decided in an earlier merge keep your decision.
 */
function merge(): void {
  const excluded = new Set(Object.keys(JSON.parse(readFileSync(join(OUT, 'batch2-excluded.json'), 'utf8'))))
  const a = new Map<string, Opinion>(), b = new Map<string, Opinion>()
  for (const f of readdirSync(join(OUT, 'label-out'))) {
    const side = f.startsWith('opus-') ? a : f.startsWith('sonnet-') ? b : null
    if (!side) continue
    for (const r of readJsonl(join(OUT, 'label-out', f))) side.set(r.id, { kind: r.kind, effort: r.effort, note: r.note })
  }
  const prior = (path: string) => new Map((existsSync(path) ? readJsonl(path) : []).filter((r) => isPerson(r.by)).map((r) => [r.id, r]))
  const rand = mulberry32(SEED + 1)
  const same = (x: Opinion, y: Opinion) => x.kind === y.kind && x.effort === y.effort
  const missing: string[] = []

  const out2 = join(OUT, 'batch2-labels.jsonl')
  const kept2 = prior(out2)
  const rows2 = readJsonl(join(OUT, 'batch2-items.jsonl')).filter((i) => !excluded.has(i.id)).flatMap((i) => {
    const x = a.get(i.id), y = b.get(i.id)
    if (!x || !y) return (missing.push(i.id), [])
    const base = { id: i.id, a: x, b: y }
    if (kept2.has(i.id)) return [{ ...kept2.get(i.id), ...base }]
    if (same(x, y)) return [rand() < AUDIT_SHARE
      ? { ...base, status: 'audit', by: null, kind: x.kind, effort: x.effort, note: '' }
      : { ...base, status: 'agreed', by: 'opus+sonnet', kind: x.kind, effort: x.effort, note: x.note }]
    return [{ ...base, status: 'disputed', by: null, kind: null, effort: null, note: '' }]
  })
  writeJsonl(out2, rows2)

  const labels1 = new Map(readJsonl(join(OUT, 'labels.jsonl')).map((l) => [l.id, l]))
  const outR = join(OUT, 'recheck-labels.jsonl')
  const keptR = prior(outR)
  const rowsR = readJsonl(join(OUT, 'recheck-items.jsonl')).filter((i) => !excluded.has(i.id)).flatMap((i) => {
    const x = a.get(i.id), y = b.get(i.id), mine = labels1.get(i.id)!
    if (!x || !y) return (missing.push(i.id), [])
    const person = { kind: mine.kind, effort: mine.effort, note: mine.note }
    const base = { id: i.id, a: x, b: y, person }
    if (keptR.has(i.id) && keptR.get(i.id).status === 'reviewed') return [{ ...keptR.get(i.id), ...base }]
    if (same(x, y) && !same(x, person)) return [{ ...base, status: 'challenged', by: null, kind: null, effort: null, note: '' }]
    return [{ ...base, status: same(x, y) ? 'confirmed' : 'split', by: mine.by, kind: mine.kind, effort: mine.effort, note: mine.note }]
  })
  writeJsonl(outR, rowsR)

  const count = (rows: Row[]) => Object.entries(rows.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ')
  console.log(`batch 2: ${rows2.length} rows (${count(rows2)}); recheck: ${rowsR.length} rows (${count(rowsR)}); excluded ${excluded.size}`)
  if (missing.length) throw new Error(`no label from one side for ${missing.length} rows, e.g. ${missing[0]}`)
}

const commands: Record<string, () => void> = { sample, merge }
const cmd = process.argv[2] ?? ''
if (!Object.hasOwn(commands, cmd)) {
  console.error(`usage: bun mods/jev/eval/batch.ts ${Object.keys(commands).join('|')}`)
  process.exit(2)
}
commands[cmd]!()
