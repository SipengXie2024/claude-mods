// Jev's check judgment (src/judge.ts CHECK_QUESTION) against the acceptance checks that were run:
// every acceptance agent on record in the daily tasks of a state folder, with the turn it checked.
// Run with bun from the plugin folder:
//
//   bun eval/check-eval.ts [--state DIR] [--projects DIR] [--key FILE] [--model gpt-6-luna] [--out FILE]
//
// One Jev request per checked turn, on what daily.ts sends for it: the message that started the turn
// and the turn's tool calls (from the executor's transcript), the executor's answer and the diff the
// acceptance brief quotes. Each row: the task, the acceptance agent, its verdict (fail, pass, or none
// when the record holds no verdict), whether the turn left a change, its tool calls, the length of
// the executor's answer, Jev's probability that a check is worth it, and the answer's first line. The
// summary counts, at CHECK_YES, how many failed and how many passed checks would still have run.
// --out also writes the rows as JSON lines. DIR defaults to ~/.config/magpie-tasks and
// ~/.claude/projects. The key is read from its file and never printed.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OWN_WAKES } from '../src/daily'
import { endedTurn, type ApiMessage } from '../src/dialogue'
import { ask, type JevConfig } from '../src/jev'
import { CHECK_QUESTION, CHECK_YES, checkInput } from '../src/judge'
import type { AgentRecord, TaskRecord } from '../src/types'
import { nodeIo } from '../io-tests/node-io'

interface Case { task: string; agent: string; verdict: 'fail' | 'pass' | 'none'; asked: string; tools: number; answer: string; diffStat: string | null }

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

// A subagent's transcript as the API view `$.session.messages({ agentId, as: 'api' })` gives it, with
// the time of each message. The view carries a message that resumed the subagent twice, wrapped and
// plain; the transcript keeps only the wrapped text, so the plain one is put back. A transcript's
// meta rows are a tool's companion text (a skill's body), left out here, or text the view wraps in
// a reminder (a message the person sent while the subagent worked).
const WRAPPED = /^The coordinator sent a message while you were working:\n([\s\S]*?)(?:\n\nAddress this before completing your current task\.)?\s*$/
function transcript(projects: string, agentId: string): { at: number; message: ApiMessage }[] {
  for (const project of readdirSync(projects)) {
    const dir = join(projects, project)
    for (const session of existsSync(dir) ? readdirSync(dir) : []) {
      const file = join(dir, session, 'subagents', `agent-${agentId}.jsonl`)
      if (!existsSync(file)) continue
      const out: { at: number; message: ApiMessage }[] = []
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const e = JSON.parse(line) as { type?: string; timestamp?: string; isMeta?: boolean; sourceToolUseID?: string; message?: { role?: string; content?: unknown } }
        if ((e.type !== 'user' && e.type !== 'assistant') || e.timestamp === undefined || e.message?.role === undefined) continue
        if (e.isMeta === true && e.sourceToolUseID !== undefined) continue
        const c = e.message.content
        const blocks = (typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []) as { type?: string; text?: unknown }[]
        const content = blocks.flatMap(b => {
          if (b.type !== 'text' || typeof b.text !== 'string') return [b]
          if (e.isMeta === true && !b.text.startsWith('<system-reminder')) return [{ type: 'text', text: `<system-reminder>\n${b.text}\n</system-reminder>` }]
          const m = WRAPPED.exec(b.text)
          return m === null ? [b] : [b, { type: 'text', text: m[1]! }]
        })
        out.push({ at: Date.parse(e.timestamp), message: { role: e.message.role, content } })
      }
      return out
    }
  }
  throw new Error(`no transcript of agent ${agentId} under ${projects}`)
}

// The first text of a transcript: the brief the subagent was started with.
function briefOf(t: { message: ApiMessage }[]): string {
  const first = (t[0]?.message.content as { type?: string; text?: unknown }[] | undefined)?.find(b => b.type === 'text' && typeof b.text === 'string' && !b.text.startsWith('<system-reminder'))
  if (first === undefined) throw new Error('a transcript starts without a brief')
  return String(first.text)
}

// The diff --stat an acceptance brief quotes, or null when the brief says the task changed no files.
function diffStatOf(brief: string): string | null {
  const m = /Its diff against the task's base:\n([\s\S]*?)\nThe full patch is /.exec(brief)
  return m ? m[1]! : null
}

function cases(state: string, projects: string): Case[] {
  const out: Case[] = []
  const dir = join(state, 'tasks')
  for (const f of readdirSync(dir).filter(x => /^d-.*\.json$/.test(x)).sort()) {
    const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as TaskRecord
    const agents = Object.values(t.agents)
    const executors = agents.filter(a => a.role === 'executor')
    for (const acc of agents.filter(a => a.role === 'acceptance').sort((a, b) => a.startedAt - b.startedAt)) {
      // The turn it checked: the latest executor report before it started.
      let report: AgentRecord['reports'][number] | undefined
      for (const e of executors) for (const r of e.reports) if (r.at <= acc.startedAt && (report === undefined || r.at > report.at)) report = r
      if (report === undefined) continue
      const turn = report
      const executor = executors.find(e => e.reports.includes(turn))!
      const d = t.deliverables.find(x => x.acceptance?.agentId === acc.agentId)
      out.push({
        task: t.id,
        agent: acc.name ?? acc.agentId,
        verdict: d?.acceptance === undefined ? 'none' : d.acceptance.pass ? 'pass' : 'fail',
        // The executor's conversation up to the end of the checked turn (its answer is written within 2 s of the report).
        ...endedTurn(transcript(projects, executor.agentId).filter(m => m.at <= turn.at + 2000).map(m => m.message), OWN_WAKES),
        answer: turn.text,
        diffStat: diffStatOf(briefOf(transcript(projects, acc.agentId))),
      })
    }
  }
  return out
}

const state = arg('state', join(homedir(), '.config/magpie-tasks'))
const projects = arg('projects', join(homedir(), '.claude/projects'))
const cfg: JevConfig = { url: 'https://api.openai.com/v1/decisions', model: arg('model', 'gpt-6-luna'), keyFile: arg('key', join(homedir(), '.config/jev-opus/openai-jev.key')), deadlineMs: 20000 }
const io = nodeIo()
const rows: (Omit<Case, 'answer' | 'diffStat'> & { change: boolean; chars: number; p: number; first: string })[] = []
for (const c of cases(state, projects)) {
  const r = await ask(io, cfg, checkInput(c), [{ name: 'check', type: 'predicate', instructions: CHECK_QUESTION }])
  if (!r.ok) throw new Error(`Jev failed on ${c.agent}: ${r.error}`)
  const a = r.answers['check']
  if (a?.kind !== 'predicate') throw new Error(`no predicate answer on ${c.agent}`)
  const first = c.answer.split('\n').map(s => s.trim()).find(s => s !== '') ?? ''
  rows.push({ task: c.task, agent: c.agent, verdict: c.verdict, tools: c.tools, asked: Array.from(c.asked.replace(/\s+/g, ' ')).slice(0, 60).join(''), change: c.diffStat !== null, chars: c.answer.length, p: a.p, first: Array.from(first).slice(0, 48).join('') })
}
for (const r of rows) console.log([r.task, r.agent.padEnd(26), r.verdict.padEnd(4), r.change ? 'change' : 'answer', String(r.tools).padStart(4), String(r.chars).padStart(6), r.p.toFixed(2), r.first].join('  '))
const ran = (v: string) => rows.filter(r => r.verdict === v && r.p >= CHECK_YES).length
const all = (v: string) => rows.filter(r => r.verdict === v).length
console.log(`at CHECK_YES ${CHECK_YES}: ${ran('fail')} of ${all('fail')} failed checks still run, ${ran('pass')} of ${all('pass')} passed checks still run, ${ran('none')} of ${all('none')} without a verdict`)
const out = arg('out', '')
if (out !== '') writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
