/**
 * Browser review of Jev eval labels, behind the site's login.
 *
 *   bun mods/jev/eval/review-server.ts        listens on 127.0.0.1:7241 (JEV_REVIEW_PORT)
 *
 * Serves review/index.html and a small API over the label sets the eval
 * scripts read (`?set=batch1|batch2|recheck`): GET api/rows lists every label
 * with its prompt, what came before and, for the hindsight sets, what came
 * after and each labeler's opinion; POST api/rows/<id> saves one row as decided
 * by a person (JEV_REVIEWER, default "sipeng"). Jev's own decision is never
 * sent, so the review stays blind. Only listens on loopback: nginx adds the
 * login in front.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isEffort } from '../src/effort'
import { TASK_TYPES } from '../src/questions'

const DIR = process.env.JEV_OPUS_CONFIG_DIR || join(homedir(), '.config', 'jev-opus')
const SETS: Record<string, { items: string; labels: string }> = {
  batch1: { items: 'items.jsonl', labels: 'labels.jsonl' },
  batch2: { items: 'batch2-items.jsonl', labels: 'batch2-labels.jsonl' },
  recheck: { items: 'recheck-items.jsonl', labels: 'recheck-labels.jsonl' },
}
const setFiles = (set: string | null) => {
  const f = SETS[set ?? 'batch1']
  if (!f) throw new Response(`unknown set ${set}`, { status: 400 })
  return { items: join(DIR, 'eval', f.items), labels: join(DIR, 'eval', f.labels) }
}
const PORT = Number(process.env.JEV_REVIEW_PORT || 7241)
const REVIEWER = process.env.JEV_REVIEWER || 'sipeng'
const WEB = join(import.meta.dir, 'review')
const FONTS = join(homedir(), '.local', 'share', 'fonts', 'deck')
/** Start levels a label may name: max is never a start. */
const LEVELS = ['low', 'medium', 'high', 'xhigh']
const TEXT_CHARS = 4000

type Row = Record<string, any>

const readJsonl = (path: string): Row[] =>
  readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

function writeLabels(path: string, rows: Row[]): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

function rows(set: string | null): Row[] {
  const f = setFiles(set)
  const items = new Map(readJsonl(f.items).map((i) => [i.id, i]))
  return readJsonl(f.labels).map((l, n) => {
    const it = items.get(l.id)
    const text = String(it?.text ?? l.excerpt ?? '')
    return {
      id: l.id, n: n + 1, by: l.by, kind: l.kind, effort: l.effort, note: l.note ?? '', status: l.status ?? null,
      text: text.slice(0, TEXT_CHARS), clipped: text.length > TEXT_CHARS,
      model: it?.model ?? null, at: it?.at ?? null, origin: it?.origin ?? null, project: it?.project ?? null,
      before: it?.before ?? { user: null, agent: null }, after: it?.after ?? null,
      a: l.a ?? null, b: l.b ?? null, person: l.person ?? null,
    }
  })
}

function save(set: string | null, id: string, body: Row): Row {
  const { kind, effort, note } = body
  if (!Object.hasOwn(TASK_TYPES, kind)) throw new Response(`unknown kind ${kind}`, { status: 400 })
  if (!isEffort(effort) || !LEVELS.includes(effort)) throw new Response(`unknown level ${effort}`, { status: 400 })
  if (typeof note !== 'string' || note.length > 500) throw new Response('note must be text under 500 characters', { status: 400 })
  const path = setFiles(set).labels
  const all = readJsonl(path)
  const i = all.findIndex((l) => l.id === id)
  if (i < 0) throw new Response(`no label ${id}`, { status: 404 })
  all[i] = { ...all[i], by: REVIEWER, kind, effort, note, ...(all[i].status ? { status: 'reviewed' } : {}) }
  writeLabels(path, all)
  return { id, by: REVIEWER, kind, effort, note, ...(all[i].status ? { status: 'reviewed' } : {}) }
}

const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', ttf: 'font/ttf' }

function file(path: string): Response {
  if (!existsSync(path)) return new Response('not found', { status: 404 })
  const ext = path.slice(path.lastIndexOf('.') + 1)
  return new Response(Bun.file(path), { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' } })
}

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    const set = url.searchParams.get('set')
    try {
      if (req.method === 'GET' && path === '/api/rows') return Response.json({ reviewer: REVIEWER, kinds: TASK_TYPES, rows: rows(set) })
      const m = /^\/api\/rows\/([^/]+)$/.exec(path)
      if (req.method === 'POST' && m) return Response.json(save(set, decodeURIComponent(m[1]!), await req.json()))
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) return file(join(WEB, 'index.html'))
      if (req.method === 'GET' && /^\/(app\.css|app\.js)$/.test(path)) return file(join(WEB, path.slice(1)))
      if (req.method === 'GET' && /^\/fonts\/IBMPlexSans-(Regular|Bold)\.ttf$/.test(path)) return file(join(FONTS, path.slice('/fonts/'.length)))
      if (path === '/favicon.ico') return new Response(null, { status: 204 })
      return new Response('not found', { status: 404 })
    } catch (e) {
      if (e instanceof Response) return e
      throw e
    }
  },
})
console.log(`jev label review on http://127.0.0.1:${PORT}/ (${Object.keys(SETS).join(', ')} in ${join(DIR, 'eval')})`)
