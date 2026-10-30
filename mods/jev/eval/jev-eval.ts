/**
 * Offline evaluation of Jev's start levels against the journal.
 *
 *   bun mods/jev/eval/jev-eval.ts extract   journal + transcripts → eval/items.jsonl
 *   bun mods/jev/eval/jev-eval.ts sheet     add unlabeled items to eval/labels.jsonl
 *   bun mods/jev/eval/jev-eval.ts score     replay the current policy against the labels, plus outcome tables
 *
 * Everything is read from and written to the Jev config folder
 * (JEV_OPUS_CONFIG_DIR, default ~/.config/jev-opus): items and labels hold
 * the person's own prompts, so they never go into this repository.
 *
 * A label is the start level the prompt really needed and the task kind it
 * really was. `by` says who judged it: a person's name, or `claude-draft`
 * for a model's draft that still needs a person's pass. The score reports
 * the two groups separately, since a wrong label is the most common way an
 * eval misleads.
 *
 * The replay feeds each journaled profile (Jev's answers as recorded) to the
 * current taskEffort under unbounded effort, with the deep thresholds from
 * the same .env the hook reads. It measures the policy's mapping, not Jev's
 * classification: a changed question set needs a fresh journal.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyPolicyConfig, modConfig, parseEnvFile } from '../src/config'
import { EFFORT_LEVELS, isEffort, rank, type Effort } from '../src/effort'
import { policyVersion, taskEffort, typeTrusted, type Bounds } from '../src/policy'
import { TASK_TYPES, type TaskType } from '../src/questions'
import type { TaskProfile } from '../src/types'
import { isPerson } from './labelers'

const DIR = process.env.JEV_OPUS_CONFIG_DIR || join(homedir(), '.config', 'jev-opus')
const OUT = join(DIR, 'eval')
const ITEMS = join(OUT, 'items.jsonl')
const LABELS = join(OUT, 'labels.jsonl')
const PROJECTS = join(homedir(), '.claude', 'projects')
const ALL: Bounds = { min: 'low', max: 'max' }
/** A prompt's journal row is written after Jev answered; its transcript message is at most this much older. */
const MATCH_WINDOW_MS = 120_000
const EXCERPT_CHARS = 600
/** The end of the agent's last reply is where it proposes or asks what comes next. */
const AGENT_TAIL_CHARS = 1500
const PREV_USER_CHARS = 600

type Row = Record<string, any>

export interface Item {
  id: string
  session: string
  prompt: number
  at: number
  model: string
  origin: string
  /** the start level the hook chose, after follow-up, acknowledgement and exploration */
  effort: Effort
  policy: string
  profile: TaskProfile | null
  reasons: string[]
  explore: { from: Effort; to: Effort } | null
  /** this prompt said the previous turn got it wrong (and the signal was acted on) */
  fault: boolean
  /** the next prompt in the session said this one got it wrong */
  nextFault: boolean
  turns: number
  outputTokens: number
  durationMs: number
  checksFailed: number
  unfinished: boolean
  text: string | null
  /** what came right before: the person's previous message and the tail of the agent's last reply */
  before: { user: string | null; agent: string | null }
}

export interface Label {
  id: string
  by: string | null
  kind: TaskType | null
  effort: Effort | null
  note: string
  excerpt: string
}

const readJsonl = (path: string): Row[] =>
  readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

const writeJsonl = (path: string, rows: unknown[]): void =>
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })

function journalRows(): Row[] {
  const files = readdirSync(DIR).filter((f) => /^mod-journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  if (files.length === 0) throw new Error(`no mod-journal-YYYY-MM-DD.jsonl in ${DIR}`)
  return files.flatMap((f) => readJsonl(join(DIR, f)))
}

/** session id → transcript path, across every project folder; a kept copy (eval/transcripts) wins, since Claude Code cleans up old ones. */
function transcriptIndex(): Map<string, string> {
  const index = new Map<string, string>()
  const kept = join(OUT, 'transcripts')
  if (existsSync(kept)) for (const n of readdirSync(kept)) if (n.endsWith('.jsonl')) index.set(n.slice(0, -'.jsonl'.length), join(kept, n))
  for (const project of readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const dir = join(PROJECTS, project.name)
    for (const n of readdirSync(dir)) if (n.endsWith('.jsonl') && !index.has(n.slice(0, -'.jsonl'.length))) index.set(n.slice(0, -'.jsonl'.length), join(dir, n))
  }
  return index
}

/** A person's message in a transcript: its text, or null for tool results and injected context. */
function humanText(r: Row): string | null {
  if (r.type !== 'user' || r.isMeta || r.isCompactSummary) return null
  const c = r.message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c) || c.length === 0 || c.some((b: Row) => b.type !== 'text' && b.type !== 'image')) return null
  const text = c.filter((b: Row) => b.type === 'text').map((b: Row) => b.text).join('\n')
  return text || null
}

/** The visible text of an agent reply record, or null for tool calls and thinking. */
function agentText(r: Row): string | null {
  if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) return null
  const text = r.message.content.filter((b: Row) => b.type === 'text').map((b: Row) => b.text).join('')
  return text.trim() ? text : null
}

interface Found { text: string; before: Item['before'] }

/**
 * The person's message each prompt row answers (the last one at or before the
 * row, within the window), with the person's previous message and the end of
 * the agent's last reply before it.
 */
function promptTexts(prompts: Row[]): Map<string, Found> {
  const index = transcriptIndex()
  const bySession = new Map<string, Row[]>()
  for (const p of prompts) bySession.set(p.session, [...(bySession.get(p.session) ?? []), p])
  const found = new Map<string, Found>()
  for (const [session, rows] of bySession) {
    const path = index.get(session)
    if (!path) continue
    const messages = readJsonl(path)
      .map((r) => {
        const human = humanText(r)
        return { at: Date.parse(r.timestamp), who: human !== null ? 'user' : 'agent', text: human ?? agentText(r) }
      })
      .filter((m): m is { at: number; who: string; text: string } => m.text !== null && Number.isFinite(m.at))
    for (const p of rows) {
      let i = -1
      for (let j = 0; j < messages.length; j++) {
        const m = messages[j]!
        if (m.who === 'user' && m.at <= p.at && p.at - m.at <= MATCH_WINDOW_MS) i = j
      }
      if (i < 0) continue
      const earlier = messages.slice(0, i)
      const agent = earlier.findLast((m) => m.who === 'agent')?.text ?? null
      const user = earlier.findLast((m) => m.who === 'user')?.text ?? null
      found.set(`${session}#${p.prompt}`, {
        text: messages[i]!.text,
        before: { user: user && user.slice(0, PREV_USER_CHARS), agent: agent && agent.slice(-AGENT_TAIL_CHARS) },
      })
    }
  }
  return found
}

function extract(): void {
  const rows = journalRows()
  const prompts = rows.filter((r) => r.event === 'prompt' && r.agent === 'main' && typeof r.prompt === 'number')
  const outcomes = new Map<string, Row[]>()
  for (const o of rows) {
    if (o.event !== 'outcome' || o.agent !== 'main' || typeof o.prompt !== 'number') continue
    const id = `${o.session}#${o.prompt}`
    outcomes.set(id, [...(outcomes.get(id) ?? []), o])
  }
  const texts = promptTexts(prompts)
  const items: Item[] = prompts.map((p) => {
    const id = `${p.session}#${p.prompt}`
    const os = outcomes.get(id) ?? []
    return {
      id, session: p.session, prompt: p.prompt, at: p.at, model: p.model, origin: p.origin,
      effort: p.effort, policy: p.policy, profile: p.profile ?? null, reasons: p.reasons ?? [],
      explore: p.explore ? { from: p.explore.from, to: p.explore.to } : null,
      fault: p.followUp?.yes === true && p.followUp?.shadow !== true,
      nextFault: false,
      turns: os.length,
      outputTokens: os.reduce((s, o) => s + (o.outputTokens ?? 0), 0),
      durationMs: os.reduce((s, o) => s + (o.durationMs ?? 0), 0),
      checksFailed: os.reduce((s, o) => s + (o.checks?.failed ?? 0), 0),
      unfinished: os.some((o) => o.unfinished === true),
      text: texts.get(id)?.text ?? null,
      before: texts.get(id)?.before ?? { user: null, agent: null },
    }
  })
  const bySession = new Map<string, Item[]>()
  for (const it of items) bySession.set(it.session, [...(bySession.get(it.session) ?? []), it])
  for (const list of bySession.values()) {
    list.sort((a, b) => a.prompt - b.prompt)
    for (let i = 0; i + 1 < list.length; i++) list[i]!.nextFault = list[i + 1]!.fault
  }
  mkdirSync(OUT, { recursive: true, mode: 0o700 })
  writeJsonl(ITEMS, items)
  const withText = items.filter((i) => i.text !== null).length
  console.log(`${items.length} prompts from ${bySession.size} sessions → ${ITEMS} (${withText} with their text)`)
}

const loadItems = (): Item[] => readJsonl(ITEMS) as Item[]
const loadLabels = (): Label[] => (existsSync(LABELS) ? (readJsonl(LABELS) as Label[]) : [])

function sheet(): void {
  const items = loadItems()
  const labels = loadLabels()
  const known = new Set(labels.map((l) => l.id))
  const added: Label[] = items
    .filter((i) => i.text !== null && !known.has(i.id))
    .map((i) => ({ id: i.id, by: null, kind: null, effort: null, note: '', excerpt: i.text!.slice(0, EXCERPT_CHARS) }))
  writeJsonl(LABELS, [...labels, ...added])
  console.log(`${added.length} new rows, ${labels.length + added.length} in ${LABELS}`)
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : '-')
const median = (xs: number[]) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

function table(head: string[], rows: (string | number)[][]): void {
  const w = head.map((h, c) => Math.max(h.length, ...rows.map((r) => String(r[c]).length)))
  const line = (r: (string | number)[]) => r.map((x, c) => String(x).padEnd(w[c]!)).join('  ')
  console.log(line(head))
  for (const r of rows) console.log(line(r))
  console.log()
}

/** Agreement of a start rule with the labels: exact, one or more levels low, one or more levels high, mean distance. */
function agreement(pairs: { got: Effort; want: Effort }[]): (string | number)[] {
  const d = pairs.map((p) => rank(p.got) - rank(p.want))
  const mean = d.length ? d.reduce((s, x) => s + Math.abs(x), 0) / d.length : 0
  return [pairs.length, pct(d.filter((x) => x === 0).length, d.length), pct(d.filter((x) => x < 0).length, d.length), pct(d.filter((x) => x > 0).length, d.length), mean.toFixed(2)]
}

function score(): void {
  const envFile = join(DIR, '.env')
  if (!existsSync(envFile)) throw new Error(`${envFile} is missing: the replay needs the deep thresholds the hook runs with`)
  applyPolicyConfig(modConfig(parseEnvFile(readFileSync(envFile, 'utf8'))))
  const items = loadItems()
  const byId = new Map(items.map((i) => [i.id, i]))
  const labeled = loadLabels()
    .filter((l) => l.by && isEffort(l.effort) && l.kind && Object.hasOwn(TASK_TYPES, l.kind))
    .map((l) => ({ l, it: byId.get(l.id) }))
    .filter((x): x is { l: Label; it: Item } => x.it !== undefined && x.it.profile !== null)

  console.log(`policy ${policyVersion()} · ${items.length} prompts · ${labeled.length} labeled\n`)

  if (labeled.length) {
    const head = ['labels', 'n', 'exact', 'too low', 'too high', 'mean |Δ|']
    const groups = new Map<string, typeof labeled>()
    for (const x of labeled) {
      const g = isPerson(x.l.by) ? 'person' : x.l.by!
      groups.set(g, [...(groups.get(g) ?? []), x])
    }
    console.log('Current policy, replayed start vs label (unbounded)')
    table(head, [...groups].map(([g, xs]) => [g, ...agreement(xs.map(({ l, it }) => ({ got: taskEffort(it.profile!, ALL).effort, want: l.effort! })))]))

    console.log('Recorded start (as it ran, bounds and adjustments included) vs label')
    table(head, [...groups].map(([g, xs]) => [g, ...agreement(xs.map(({ l, it }) => ({ got: it.effort, want: l.effort! })))]))

    console.log('By labeled kind, current policy')
    const kinds = Object.keys(TASK_TYPES) as TaskType[]
    table(['kind', 'n', 'exact', 'too low', 'too high', 'mean |Δ|', 'Jev kind agrees'], kinds
      .map((k) => labeled.filter((x) => x.l.kind === k))
      .filter((xs) => xs.length)
      .map((xs) => [xs[0]!.l.kind!, ...agreement(xs.map(({ l, it }) => ({ got: taskEffort(it.profile!, ALL).effort, want: l.effort! }))),
        pct(xs.filter(({ l, it }) => it.profile!.taskType === l.kind && typeTrusted(it.profile!)).length, xs.length)]))

    const unsure = labeled.filter(({ it }) => !typeTrusted(it.profile!))
    console.log('Prompts whose kind Jev was unsure of: which start fits the labels')
    table(['start rule', 'n', 'exact', 'too low', 'too high', 'mean |Δ|'], [
      ['always high', ...agreement(unsure.map(({ l }) => ({ got: 'high' as Effort, want: l.effort! })))],
      ['always medium', ...agreement(unsure.map(({ l }) => ({ got: 'medium' as Effort, want: l.effort! })))],
      ['current policy', ...agreement(unsure.map(({ l, it }) => ({ got: taskEffort(it.profile!, ALL).effort, want: l.effort! })))],
    ])

    console.log('Labeled level distribution')
    table(['by', ...EFFORT_LEVELS], [...groups].map(([g, xs]) => [g, ...EFFORT_LEVELS.map((e) => xs.filter((x) => x.l.effort === e).length)]))
  }

  console.log('Outcomes by recorded start (all prompts, no labels needed)')
  table(['start', 'n', 'median out tokens', 'median minutes', 'next prompt says wrong', 'unfinished'], EFFORT_LEVELS
    .map((e) => items.filter((i) => i.effort === e))
    .filter((xs) => xs.length)
    .map((xs) => [xs[0]!.effort, xs.length, median(xs.map((i) => i.outputTokens)), (median(xs.map((i) => i.durationMs)) / 60_000).toFixed(1),
      pct(xs.filter((i) => i.nextFault).length, xs.length), pct(xs.filter((i) => i.unfinished).length, xs.length)]))

  const explored = items.filter((i) => i.explore)
  console.log(`Exploration: ${explored.length} prompts (too few to compare outcomes; counts only)`)
  const moves = new Map<string, number>()
  for (const i of explored) moves.set(`${i.explore!.from} → ${i.explore!.to}`, (moves.get(`${i.explore!.from} → ${i.explore!.to}`) ?? 0) + 1)
  table(['move', 'n'], [...moves].sort())
}

const commands: Record<string, () => void> = { extract, sheet, score }
const cmd = process.argv[2] ?? ''
if (!Object.hasOwn(commands, cmd)) {
  console.error('usage: bun mods/jev/eval/jev-eval.ts extract|sheet|score')
  process.exit(2)
}
commands[cmd]!()
