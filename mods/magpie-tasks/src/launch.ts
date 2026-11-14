// Background sessions (plan sections 9.2 steps 8–10, 9.12, 9.13): starting an architect with
// `claude-magpie --bg` and waiting for it to claim its task, resuming a stopped session under its own
// ID, stopping one, and reading `claude agents --json --all`.
import { expandHome, newId, wait, type Io } from './io'
import { requestId } from './model'
import type { Ctx } from './state'
import type { Claim, Options, TaskRecord } from './types'

const LAUNCH_CLAIM_MS = 10 * 60_000
const CLAIM_WAIT_MS = 60_000
const CLAIM_POLL_MS = 500
const RUN_MS = 60_000

// Environment markers of the hook's own session: a nested `claude` that inherits them takes itself
// for a child of this session. `$.process.run` can add variables but not remove them, hence `env -u`.
const NESTED_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT'] as const

function unnested(argv: string[]): string[] {
  return ['env', ...NESTED_MARKERS.flatMap(name => ['-u', name]), ...argv]
}

// What every architect session starts or resumes with. Claude Code asks for a one-line progress
// summary of each background subagent about every 30 seconds, each request carrying the subagent's
// whole context; under claude-magpie each starts a `claude -p` helper (about 270 MB) that lingers for
// about 200 seconds, some 1.5–1.8 GB per running subagent (measured 2026-11-11). Nobody reads those
// summaries here: the architect reads its subagents' reports. Claude Code hands this variable on to a
// background session it starts.
export const ARCHITECT_ENV: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES: '1' }

// `model` is the ID sent to the engine (requestId of the chosen model). A background session writes
// no debug log unless asked, so the architect gets one per task (debugFile); `claude --bg --resume`
// keeps it as a saved option, and the context-memory archive check (scanDebugLog) reads it.
export function launchArgv(opts: Options, a: { model: string; message: string; pluginDir: string | null; debugFile: string }): string[] {
  return unnested([opts.launcher, '--bg', '--model', a.model, '--debug-file', a.debugFile, ...(a.pluginDir === null ? [] : ['--plugin-dir', a.pluginDir]), a.message])
}

export function debugFile(opts: Options, taskId: string): string {
  return `${opts.stateDir}/debug/${taskId}.txt`
}

// The short ID `claude --bg` prints on success (`backgrounded · e21efae8`), or null.
export function parseBackgrounded(stdout: string): string | null {
  return /backgrounded · ([0-9a-f]{8})\b/.exec(stdout)?.[1] ?? null
}

// `--plugin-dir <root>` is needed when the plugin was loaded from a folder (development) rather than
// installed. Whether it is installed is read from <config dir>/plugins/installed_plugins.json: the
// root does not tell, since a plugin installed from a directory marketplace runs from the marketplace
// folder itself (e2e 2026-11-09: root ~/sipeng/claude-mods/mods/magpie-tasks). An installed plugin is
// loaded by the background session from settings by itself.
export function pluginDirArg(pluginRoot: string, installed: unknown): string | null {
  if (typeof installed !== 'object' || installed === null) throw new Error('installed_plugins.json: not an object')
  const plugins = (installed as { plugins?: unknown }).plugins
  if (typeof plugins !== 'object' || plugins === null) throw new Error('installed_plugins.json: no plugins object')
  return Object.keys(plugins).some(k => k.startsWith('magpie-tasks@')) ? null : pluginRoot
}

async function installedPlugins(io: Io): Promise<unknown> {
  const path = `${await claudeConfigDir(io)}/plugins/installed_plugins.json`
  return (await io.exists(path)) ? JSON.parse(await io.read(path)) as unknown : { plugins: {} }
}

// CLAUDE_CONFIG_DIR, or ~/.claude.
export async function claudeConfigDir(io: Io): Promise<string> {
  const dir = await io.env('CLAUDE_CONFIG_DIR')
  if (dir !== undefined && dir !== '') return dir.replace(/\/+$/, '')
  const home = await io.env('HOME')
  if (home === undefined || home === '') throw new Error('neither CLAUDE_CONFIG_DIR nor HOME is set')
  return expandHome('~/.claude', home)
}

// Why a launch failed: the background session never started (`not-started`), or it started and did
// not claim its task (`not-claimed`; it has been stopped). The task is already in state 'error'.
export class LaunchError extends Error {
  constructor(readonly kind: 'not-started' | 'not-claimed', readonly reason: string, readonly shortId: string | null) {
    super(kind === 'not-started' ? `the background session did not start: ${reason}` : `the architect session ${shortId} did not claim its task: ${reason}`)
    this.name = 'LaunchError'
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

// The architect marker line architectFirstMessage puts after the request. The task ID has the shape
// of a registry file name (Registry.checkId), so a claim lookup by it cannot throw.
const ARCHITECT_MARK = /\[magpie-tasks architect task=([A-Za-z0-9][A-Za-z0-9._-]*) /g

// The task a background session's first prompt names: the last architect marker line, which is the
// one architectFirstMessage puts after the request, so a marker the request itself quotes never
// wins; null when the prompt has none (a background session the person started). The launch claim
// is found by this task and not by a hash of the whole text, because the engine rewrites a prompt on
// its way into a background session: a pasted request arrives with its paste tags escaped
// (`<pasted_content` becomes `<\pasted_content`), and no text the launcher could hash in advance
// stays equal to what the hook reads.
export function architectMarkTask(text: string): string | null {
  let task: string | null = null
  for (const found of text.matchAll(ARCHITECT_MARK)) task = found[1]!
  return task
}

// Writes the launch claim, starts the architect with `<launcher> --bg` in `cwd`, and waits until the
// background session has claimed the task (section 9.3). The session finds the claim by the task ID
// in the architect marker line of `message` (architectFirstMessage). On failure: the session is
// stopped, the leftover claim removed, the task set to 'error', and a LaunchError thrown.
export async function launchArchitect(ctx: Ctx, a: { task: TaskRecord; model: string; message: string; cwd: string }): Promise<{ shortId: string; sessionId: string }> {
  const { io, reg, opts } = ctx
  if (architectMarkTask(a.message) !== a.task.id) throw new Error(`the architect's first message does not name task ${a.task.id} in its last architect marker line`)
  const now = await io.now()
  const claim: Claim = { id: newId('c', now), kind: 'launch', taskId: a.task.id, cwd: a.cwd, createdAt: now, expiresAt: now + LAUNCH_CLAIM_MS }
  await reg.putClaim(claim)
  const pluginDir = pluginDirArg(ctx.host.plugin.root, await installedPlugins(io))
  const debug = debugFile(opts, a.task.id)
  const made = await io.run(['mkdir', '-p', debug.slice(0, debug.lastIndexOf('/'))])
  if (made.exitCode !== 0) throw new Error(`mkdir for ${debug} exited ${made.exitCode}: ${made.stderr.trim()}`)
  const r = await io.run(launchArgv(opts, { model: requestId(a.model, ctx.catalog), message: a.message, pluginDir, debugFile: debug }), { cwd: a.cwd, env: { ...ARCHITECT_ENV }, timeoutMs: RUN_MS })
  const shortId = parseBackgrounded(r.stdout)
  if (r.exitCode !== 0 || shortId === null) {
    const reason = firstLine(r.stderr) || firstLine(r.stdout) || `exit code ${r.exitCode}`
    await fail(ctx, a.task.id, claim.id, `launch failed: ${reason}`)
    throw new LaunchError('not-started', reason, null)
  }
  await reg.log(a.task.id, { type: 'launch', shortId, model: a.model, cwd: a.cwd })
  // Section 9.2 step 10: 60 seconds from the moment the short ID is known.
  const deadline = (await io.now()) + CLAIM_WAIT_MS
  let reason = 'not claimed within 60 seconds'
  for (;;) {
    await wait(io, CLAIM_POLL_MS)
    const t = await reg.get(a.task.id)
    if (t === undefined) throw new Error(`task ${a.task.id} disappeared while waiting for its architect`)
    if (t.owner.kind === 'session' && t.owner.jobShortId === shortId && t.state === 'running') return { shortId, sessionId: t.owner.sessionId }
    if (t.state === 'error') { reason = t.error ?? 'the task was marked as failed'; break }
    if (await io.now() >= deadline) break
  }
  await stopSession(ctx, shortId)
  await fail(ctx, a.task.id, claim.id, `architect ${shortId} did not claim the task: ${reason}`)
  throw new LaunchError('not-claimed', reason, shortId)
}

async function fail(ctx: Ctx, taskId: string, claimId: string, error: string): Promise<void> {
  await ctx.reg.takeClaim(c => c.id === claimId, await ctx.io.now())
  await ctx.reg.update(taskId, t => { t.state = 'error'; t.error = error }, { type: 'claim-failed', error })
}

// The short ID `claude --bg --resume <sessionId>` printed when it is not the session's own (the
// first 8 hex digits of its ID): a copy started instead of continuing the session. Null when it
// continued the session or printed no short ID.
export function resumedCopy(stdout: string, sessionId: string): string | null {
  const printed = parseBackgrounded(stdout)
  return printed !== null && printed !== sessionId.slice(0, 8) ? printed : null
}

// Continues a stopped session under its own ID: plain `claude --bg --resume <full id> "<message>"`
// with no other flag, so the session's saved options apply (a flag, or a session that is still
// running, makes Claude Code start a copy under a new ID instead). Success is the session's own
// short ID on the `backgrounded ·` line; any other printed ID is a copy (resumedCopy), which is
// stopped, and the call throws.
export async function resumeSession(ctx: Ctx, sessionId: string, message: string, cwd: string): Promise<void> {
  const r = await ctx.io.run(unnested([ctx.opts.claudeBin, '--bg', '--resume', sessionId, message]), { cwd, env: { ...ARCHITECT_ENV }, timeoutMs: RUN_MS })
  const copy = resumedCopy(r.stdout, sessionId)
  if (copy !== null) {
    await stopSession(ctx, copy)
    throw new Error(`claude --bg --resume ${sessionId} started ${copy} instead of continuing the session (stopped it): ${firstLine(`${r.stdout}\n${r.stderr}`)}`)
  }
  if (r.exitCode !== 0 || parseBackgrounded(r.stdout) === null) {
    throw new Error(`claude --bg --resume ${sessionId} exited ${r.exitCode}: ${firstLine(r.stderr) || firstLine(r.stdout)}`)
  }
}

export async function stopSession(ctx: Ctx, shortId: string): Promise<void> {
  const r = await ctx.io.run(unnested([ctx.opts.claudeBin, 'stop', shortId]), { timeoutMs: RUN_MS })
  if (r.exitCode !== 0) throw new Error(`claude stop ${shortId} exited ${r.exitCode}: ${firstLine(r.stderr) || firstLine(r.stdout)}`)
}

export interface AgentsRow { id: string; sessionId: string; kind: 'background' | 'interactive'; cwd: string; name: string; startedAt: number; state?: string; status?: string; pid?: number | null }

// Rows of `claude agents --json --all`. Interactive rows carry no `id`; a background row's id is the
// first 8 hex digits of its session ID, and interactive rows get the same. A row without `pid` is a
// session whose process has ended (pid null).
export function parseAgents(stdout: string): AgentsRow[] {
  const raw: unknown = JSON.parse(stdout)
  if (!Array.isArray(raw)) throw new Error('claude agents --json: the output is not an array')
  return raw.map((r: unknown, i: number) => {
    if (typeof r !== 'object' || r === null) throw new Error(`claude agents --json: row ${i} is not an object`)
    const o = r as Record<string, unknown>
    const field = (k: string) => { throw new Error(`claude agents --json: row ${i} has no valid ${k}: ${JSON.stringify(o[k])}`) }
    const sessionId = typeof o['sessionId'] === 'string' && /^[0-9a-f]{8}-/.test(o['sessionId']) ? o['sessionId'] : field('sessionId')
    const kind = o['kind'] === 'background' || o['kind'] === 'interactive' ? o['kind'] : field('kind')
    const id = o['id'] === undefined ? sessionId.slice(0, 8) : typeof o['id'] === 'string' ? o['id'] : field('id')
    const cwd = typeof o['cwd'] === 'string' ? o['cwd'] : field('cwd')
    const name = typeof o['name'] === 'string' ? o['name'] : o['name'] === undefined ? '' : field('name')
    const startedAt = typeof o['startedAt'] === 'number' ? o['startedAt'] : field('startedAt')
    const pid = o['pid'] === undefined || o['pid'] === null ? null : typeof o['pid'] === 'number' ? o['pid'] : field('pid')
    const row: AgentsRow = { id, sessionId, kind, cwd, name, startedAt, pid }
    if (o['state'] !== undefined) row.state = typeof o['state'] === 'string' ? o['state'] : field('state')
    // idle, busy, waiting (seen 2026-11-09 on a session waiting for the person), ...: only idle is acted on.
    if (o['status'] !== undefined && o['status'] !== null) row.status = typeof o['status'] === 'string' ? o['status'] : field('status')
    return row
  })
}

export async function listAgents(io: Io, opts: Options): Promise<AgentsRow[]> {
  const r = await io.run(unnested([opts.claudeBin, 'agents', '--json', '--all']), { timeoutMs: RUN_MS })
  if (r.exitCode !== 0) throw new Error(`claude agents --json --all exited ${r.exitCode}: ${firstLine(r.stderr)}`)
  return parseAgents(r.stdout)
}
