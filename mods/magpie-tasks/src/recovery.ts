// Startup recovery (plan section 9.13): run when a claude-magpie or claude-telegram session starts,
// at most once in 10 minutes across sessions. Reports launches nobody claimed, resumes stopped
// architects of unfinished long tasks under their own session IDs, reports integrations that started
// and may not have finished, hands orphaned daily tasks back to the person, and reloads idle
// architects after a context-memory update. Also the debug-log check for context-memory archive
// failures in architect sessions.
import { resumedSince } from './brief'
import { diagnosedBlocker, integrateDaily, rerunCheck, tell } from './daily'
import { gitRun } from './git'
import { fnv1a64, newId, type Io } from './io'
import { claudeConfigDir, debugFile, listAgents, resumeSession, stopSession, type AgentsRow } from './launch'
import { pathOf, workspaces } from './workspace'
import type { Ctx } from './state'
import { defaultChat, send } from './telegram'
import type { Decision, TaskRecord } from './types'

const RERUN_MS = 10 * 60_000
const NEVER_CLAIMED_MS = 10 * 60_000
// Resuming sessions runs `claude --bg --resume` once per task; the lock must outlive that, and a
// session that finds it held waits, then sees lastRunAt and skips.
const RECOVERY_LOCK = { waitMs: 600_000, staleMs: 600_000 }
const CONTEXT_MEMORY = 'context-memory@sipeng-mods'
export const CONTEXT_MEMORY_RELOADED = 'context-memory 已更新，会话已重新加载，请继续当前任务'
const RECOVERY_HEADER = '[magpie-tasks recovery] This session was interrupted and magpie-tasks has resumed it.'

// Whether a message is one recovery wrote as the first message of `claude --bg --resume`: it arrives
// as if typed in the window, but the words are the plugin's, not the person's.
export function isRecoveryMessage(text: string): boolean {
  return text === CONTEXT_MEMORY_RELOADED || text.startsWith(`${RECOVERY_HEADER}\n`)
}
const ARCHIVE_FAILURE = 'context-memory 归档失败|hook failed closed: context-memory'

// ---- pure decisions ---------------------------------------------------------------------------

export type RecoveryAction =
  | 'none'            // nothing to do: finished, still starting within the claim window, or paused by the person
  | 'never-claimed'   // still 'starting' after the launch claim expired: the launcher is gone
  | 'alive'           // the owner session's process runs
  | 'keep-waiting'    // waits for the person; stays so
  | 'resume'          // stopped and not paused by the person: check the worktree and log, then resume
  | 'orphaned-daily'  // a daily task whose Router is gone

// What recovery does with one task, given the `claude agents --json --all` rows by session ID.
// `routerSessionId` is this session's ID when it is the Router, else null (a claude-magpie window
// then judges daily tasks by whether their Router's process still runs).
export function recoveryAction(task: TaskRecord, rows: Map<string, AgentsRow>, a: { now: number; routerSessionId: string | null }): RecoveryAction {
  if (task.state === 'starting') return task.createdAt < a.now - NEVER_CLAIMED_MS ? 'never-claimed' : 'none'
  if (task.state !== 'running' && task.state !== 'waiting-user' && task.state !== 'paused') return 'none'
  if (task.owner.kind === 'agent') {
    if (task.state !== 'running') return 'none'
    if (a.routerSessionId !== null) return task.owner.routerSessionId === a.routerSessionId ? 'none' : 'orphaned-daily'
    const router = rows.get(task.owner.routerSessionId)
    return router !== undefined && router.pid != null ? 'none' : 'orphaned-daily'
  }
  const row = rows.get(task.owner.sessionId)
  if (row !== undefined && row.pid != null) return 'alive'
  if (task.state === 'waiting-user') return 'keep-waiting'
  if (task.state === 'paused' && task.pausedByUser) return 'none'
  return 'resume'
}

// Whether a running architect should be stopped and resumed to load an updated context-memory: its
// process is idle and the fingerprint it recorded differs. A busy one waits for the next recovery.
export function needsReload(task: TaskRecord, row: AgentsRow | undefined, fingerprint: string): boolean {
  return task.owner.kind === 'session' && row !== undefined && row.pid != null && row.status === 'idle' && task.owner.contextMemoryFingerprint !== fingerprint
}

// The integrations of a task log (the JSONL text of tasks/<id>.log.jsonl) that wrote an
// `integration-start` and no `integration` with the same tree afterwards (section 9.10 step 5).
export function unfinishedIntegrations(logText: string): { target: string; files: string[]; tree: string; at: number }[] {
  const open = new Map<string, { target: string; files: string[]; tree: string; at: number }>()
  for (const [i, line] of logText.split('\n').entries()) {
    if (line.trim() === '') continue
    const entry = JSON.parse(line) as { type?: unknown; tree?: unknown; target?: unknown; files?: unknown; at?: unknown }
    if (entry.type !== 'integration-start' && entry.type !== 'integration') continue
    // A change recorded where it was made in place applied no tree and has no start entry.
    if (entry.type === 'integration' && entry.tree === undefined) continue
    if (typeof entry.tree !== 'string') throw new Error(`task log line ${i + 1}: ${String(entry.type)} without a tree`)
    if (entry.type === 'integration') { open.delete(entry.tree); continue }
    open.set(entry.tree, {
      tree: entry.tree,
      target: typeof entry.target === 'string' ? entry.target : '',
      files: Array.isArray(entry.files) ? entry.files.filter((f): f is string => typeof f === 'string') : [],
      at: typeof entry.at === 'number' ? entry.at : 0,
    })
  }
  return [...open.values()]
}

// The fingerprint of the installed context-memory: FNV-1a of installPath, version, gitCommitSha and
// lastUpdated of each of its entries in installed_plugins.json (user, project and local installs,
// in file order), or 'absent'. Editing the repository changes none of these; an update from any
// source, in any scope, changes at least one.
export function fingerprintOf(installed: unknown): string {
  if (typeof installed !== 'object' || installed === null) throw new Error('installed_plugins.json: not an object')
  const plugins = (installed as { plugins?: unknown }).plugins
  if (typeof plugins !== 'object' || plugins === null) throw new Error('installed_plugins.json: no plugins object')
  const entries = (plugins as Record<string, unknown>)[CONTEXT_MEMORY]
  if (entries === undefined) return 'absent'
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`installed_plugins.json: ${CONTEXT_MEMORY} is not a list of installs`)
  return fnv1a64(JSON.stringify(entries.map((x: unknown, i: number) => {
    if (typeof x !== 'object' || x === null) throw new Error(`installed_plugins.json: install ${i} of ${CONTEXT_MEMORY} is not an object`)
    const e = x as Record<string, unknown>
    return [e['installPath'] ?? null, e['version'] ?? null, e['gitCommitSha'] ?? null, e['lastUpdated'] ?? null]
  })))
}

export async function contextMemoryFingerprint(io: Io, configDir: string): Promise<string> {
  const path = `${configDir.replace(/\/+$/, '')}/plugins/installed_plugins.json`
  if (!(await io.exists(path))) return 'absent'
  return fingerprintOf(JSON.parse(await io.read(path)))
}

// ---- recovery ---------------------------------------------------------------------------------

type Report = { task: TaskRecord; text: string; decisionId?: string }

export async function recover(ctx: Ctx): Promise<{ resumed: string[]; waiting: string[]; reported: string[] }> {
  const result = { resumed: [] as string[], waiting: [] as string[], reported: [] as string[] }
  const reports: Report[] = []
  await ctx.reg.lock('recovery', async () => {
    const now = await ctx.io.now()
    const last = await ctx.reg.readState<{ lastRunAt?: number }>('recovery', {})
    if (last.lastRunAt !== undefined && last.lastRunAt > now - RERUN_MS) return
    const rows = new Map((await listAgents(ctx.io, ctx.opts)).map(r => [r.sessionId, r] as const))
    const fingerprint = await contextMemoryFingerprint(ctx.io, await claudeConfigDir(ctx.io))
    const routerSessionId = ctx.st.role === 'router' ? ctx.st.sessionId : null
    for (const task of await ctx.reg.list()) {
      const action = recoveryAction(task, rows, { now, routerSessionId })
      try {
        await recoverTask(ctx, task, action, rows, fingerprint, result, reports)
      } catch (error) {
        // One task's failure is reported on that task; the others are still recovered.
        const message = error instanceof Error ? error.message : String(error)
        const line = message.split('\n')[0]!
        await ctx.reg.update(task.id, t => { t.state = 'error'; t.error = `recovery: ${line}` }, { type: 'error', during: 'recovery', error: line })
        reports.push({ task, text: `magpie-tasks 启动恢复出错（任务「${task.title}」，${task.id}）：${line}` })
        result.reported.push(task.id)
      }
    }
    await ctx.reg.writeState('recovery', { lastRunAt: now })
  }, RECOVERY_LOCK)
  // Telegram after the lock: nothing that waits on the network runs while a lock is held (section 7.2).
  // Every task's state is already committed, so one failed report must not cost the others theirs.
  const failed: string[] = []
  for (const r of reports) {
    try {
      await report(ctx, r)
    } catch (error) {
      const line = (error instanceof Error ? error.message : String(error)).split('\n')[0]!
      failed.push(`${r.task.id}: ${line}`)
      ctx.host.ui.log(`magpie-tasks 出错（任务 ${r.task.id}）：启动恢复的报告没有发出：${line}\n${r.text}`)
      await ctx.reg.log(r.task.id, { type: 'error', during: 'recovery-report', error: line })
    }
  }
  if (failed.length > 0) throw new Error(`startup recovery could not report ${failed.length} of ${reports.length} tasks: ${failed.join('; ')}`)
  return result
}

async function recoverTask(ctx: Ctx, task: TaskRecord, action: RecoveryAction, rows: Map<string, AgentsRow>, fingerprint: string, result: { resumed: string[]; waiting: string[]; reported: string[] }, reports: Report[]): Promise<void> {
  const { reg } = ctx
  switch (action) {
    case 'none':
      return
    case 'never-claimed': {
      const t = await reg.update(task.id, x => { x.state = 'error'; x.error = 'never claimed' }, { type: 'claim-failed', error: 'never claimed', during: 'recovery' })
      reports.push({ task: t, text: `magpie-tasks：长期任务「${t.title}」（${t.id}）的架构师会话启动后没有完成认领，任务已标为出错。项目：${t.project?.root ?? '无'}` })
      result.reported.push(t.id)
      return
    }
    case 'keep-waiting':
      await reg.log(task.id, { type: 'recovery', action })
      result.waiting.push(task.id)
      return
    case 'orphaned-daily': {
      const t = await reg.update(task.id, x => { x.state = 'waiting-user' }, { type: 'recovery', action })
      reports.push({ task: t, text: `Router 重启，任务「${t.title}」的执行者已不在；回复这条消息可以继续` })
      result.waiting.push(t.id)
      return
    }
    case 'alive': {
      if (task.owner.kind !== 'session') return
      const row = rows.get(task.owner.sessionId)
      if (!needsReload(task, row, fingerprint)) return
      const shortId = task.owner.jobShortId ?? row!.id
      await stopSession(ctx, shortId)
      await resumeSession(ctx, task.owner.sessionId, CONTEXT_MEMORY_RELOADED, task.project?.root ?? await home(ctx))
      await reg.update(task.id, x => { if (x.owner.kind === 'session') x.owner.contextMemoryFingerprint = fingerprint }, { type: 'recovery', action: 'context-memory-reload', shortId, fingerprint })
      result.resumed.push(task.id)
      return
    }
    case 'resume':
      await resumeStopped(ctx, task, result, reports)
      return
  }
}

async function home(ctx: Ctx): Promise<string> {
  const h = await ctx.io.env('HOME')
  if (h === undefined || h === '') throw new Error('HOME is not set')
  return h
}

async function resumeStopped(ctx: Ctx, task: TaskRecord, result: { resumed: string[]; waiting: string[]; reported: string[] }, reports: Report[]): Promise<void> {
  const { io, reg } = ctx
  if (task.owner.kind !== 'session') return
  let problem: string | null = null
  // The working directories, one per project: a task worktree, or the project directory the task
  // changes in place (git status only in Git).
  const dirs: string[] = []
  for (const w of workspaces(task)) {
    const ws = pathOf(w)
    if (ws === null) continue
    const name = w.worktree !== null ? '工作副本' : '项目目录'
    const label = w.worktree !== null ? 'Task worktree' : 'Project directory the subagents work in directly'
    if (!(await io.exists(ws))) problem ??= `${name} ${ws} 不存在`
    else if (w.worktree === null && w.direct!.baseRef === null) dirs.push(`${label}: ${ws} (not a Git repository).`)
    else {
      const r = await gitRun(io, ['-C', ws, 'status', '--short'])
      if (r.exitCode !== 0) problem ??= `${name} ${ws} 的 git status 失败：${r.stderr.trim().split('\n')[0]}`
      else dirs.push(`${label} ${ws}, git status --short:\n${r.stdout.trim() === '' ? '(clean)' : r.stdout.trim()}`)
    }
  }
  const logPath = `${ctx.opts.stateDir}/tasks/${task.id}.log.jsonl`
  const unfinished = (await io.exists(logPath)) ? unfinishedIntegrations(await io.read(logPath)) : []
  if (problem === null && unfinished.length > 0) {
    problem = unfinished.map(u => `一次整合开始后没有完成记录：目标 ${u.target}，文件 ${u.files.join('、') || '（无）'}`).join('；')
  }
  if (problem !== null) {
    const now = await io.now()
    const decision: Decision = {
      id: newId('q', now),
      kind: 'interrupted',
      createdAt: now,
      question: `长期任务「${task.title}」（${task.id}）中断后无法自动恢复：${problem}。请检查后回复“继续”，架构师会话会被恢复并按你的回复处理；回复“暂停”则保持暂停。`,
      options: ['继续', '暂停'],
      data: { reason: problem, ...(unfinished[0] ? { target: unfinished[0].target, tree: unfinished[0].tree, files: unfinished[0].files.join('\n') } : {}) },
    }
    const t = await reg.update(task.id, x => { x.state = 'waiting-user'; x.decisions[decision.id] = decision }, { type: 'decision', decision: decision.id, kind: decision.kind, during: 'recovery' })
    reports.push({ task: t, text: decision.question, decisionId: decision.id })
    result.reported.push(t.id)
    return
  }
  const running = Object.values(task.agents).filter(a => a.state === 'running' || a.state === 'paused')
  const message = [
    RECOVERY_HEADER,
    running.length === 0
      ? 'No subagent was running.'
      : `Subagents that were running or paused when it stopped: ${running.map(a => `${a.agentId}${a.name ? ` (${a.name})` : ''} ${a.model}/${a.effort} ${a.state}`).join('; ')}. Their runs ended with the session; delegate again what is unfinished.`,
    ...(dirs.length === 0 ? ['The task has no working directory.'] : dirs),
    `Check the working ${dirs.length > 1 ? 'directories' : 'directory'} and the subagents\' reports against the task, then continue.`,
  ].join('\n')
  await resumeSession(ctx, task.owner.sessionId, message, task.project?.root ?? await home(ctx))
  await reg.log(task.id, { type: 'recovery', action: 'resume', sessionId: task.owner.sessionId })
  result.resumed.push(task.id)
}

// Long tasks: the message is indexed as 'long', so a reply reaches the architect; a long task with
// no chat reports to the default chat. A daily task's report is a reply to its original message and
// is left out of the index: its executor is gone, and tg-router's handling of a lost worker takes
// the reply. A terminal daily task (no Telegram link, or chat 'tui') reports to this session's
// transcript.
async function report(ctx: Ctx, r: Report): Promise<void> {
  const terminal = r.task.telegram?.chatId === 'tui' || (r.task.kind === 'daily' && r.task.telegram === null)
  if (terminal) {
    ctx.host.ui.log(r.text)
    await ctx.reg.log(r.task.id, { type: 'recovery', reported: 'transcript' })
    return
  }
  const chatId = r.task.telegram?.chatId ?? await defaultChat(ctx.io, ctx.opts)
  const messageId = await send(ctx.io, ctx.opts, chatId, r.text, r.task.telegram?.rootMessageId, true)
  if (r.task.kind === 'long') {
    await ctx.reg.updateIndex(x => { x.messages[`${chatId}:${messageId}`] = { taskId: r.task.id, kind: 'long', ...(r.decisionId ? { decisionId: r.decisionId } : {}) } })
  }
  if (r.decisionId !== undefined) {
    await ctx.reg.update(r.task.id, t => { const d = t.decisions[r.decisionId!]; if (d) d.telegram = { chatId, messageId } }, { type: 'telegram', decision: r.decisionId, messageId })
  } else {
    await ctx.reg.log(r.task.id, { type: 'telegram', messageId, during: 'recovery' })
  }
}

// ---- the Router's own daily tasks after a restart ---------------------------------------------

// `claude-telegram --resume telegram` keeps the Router's session ID, so recoveryAction leaves its daily
// tasks alone; the restart still ended every subagent the old process ran. A task still running whose
// agents are all gone was cut off: a check the plugin started (acceptance, diagnosis) runs again, the
// integration of a result that takes no check is finished, and an executor's or assessment's work
// waits for the person, whose reply resumes that agent here.
export type StalledAction = 'rerun-acceptance' | 'rerun-diagnosis' | 'integrate' | 'ask-person'

export function stalledDaily(task: TaskRecord, routerSessionId: string, alive: ReadonlySet<string>): StalledAction | null {
  if (task.kind !== 'daily' || task.owner.kind !== 'agent' || task.owner.routerSessionId !== routerSessionId) return null
  if (task.state !== 'running') return null
  const agents = Object.values(task.agents)
  if (agents.some(a => alive.has(a.agentId))) return null
  const latest = [...agents].sort((a, b) => b.startedAt - a.startedAt)[0]
  // A diagnosis cut off runs again unless the executor went back to work after the blocked report.
  if (latest?.role === 'diagnosis' && latest.state !== 'done' && !resumedSince(task, diagnosedBlocker(task).at)) return 'rerun-diagnosis'
  const d = task.deliverables[task.deliverables.length - 1]
  const unchecked = d !== undefined && d.acceptance === undefined && d.integration === undefined
  // When an executor went back to work after the latest result, the restart cut that work off too,
  // and a check or integration of the result would be superseded (brief.ts resultStanding): the
  // person is asked.
  const current = unchecked && !resumedSince(task, d.at)
  // A result the person stopped, or one judged to need no check, was being integrated: an acceptance
  // cut off with it was checking an earlier result, and the plugin never checks these.
  if (current && (d.stopped === true || d.check?.needed === false)) return 'integrate'
  // The deliverable waits for an acceptance that was cut off, or that never started.
  if (current && latest !== undefined && (latest.role === 'acceptance' ? latest.state !== 'done' : latest.reports[latest.reports.length - 1]?.status === 'done')) return 'rerun-acceptance'
  return 'ask-person'
}

// Agent statuses of `$.agent.list()` whose loop still runs.
const ALIVE = new Set(['pending', 'running', 'waiting'])
// Once per process: session.start runs once, and a re-run would take an executor waiting for its own
// background command (idle, nothing in the agent list) for one the restart cut off.
let routerRecovered = false

export async function recoverRouter(ctx: Ctx): Promise<{ rerun: string[]; integrated: string[]; asked: string[] }> {
  const out = { rerun: [] as string[], integrated: [] as string[], asked: [] as string[] }
  if (routerRecovered) return out
  routerRecovered = true
  const alive = new Set((await ctx.host.agent.list()).filter(a => ALIVE.has(a.status)).map(a => a.id))
  const failed: string[] = []
  for (const task of await ctx.reg.list(t => t.kind === 'daily')) {
    const action = stalledDaily(task, ctx.st.sessionId, alive)
    if (action === null) continue
    try {
      // Whatever was marked running ended with the old process.
      const cut = await ctx.reg.update(task.id, t => {
        for (const a of Object.values(t.agents)) if (a.state === 'running') a.state = 'idle'
        if (action === 'ask-person') t.state = 'waiting-user'
      }, { type: 'recovery', action, reason: 'the Router restarted' })
      if (action === 'ask-person') {
        await tell(ctx, cut, `Router 重启时「${cut.title}」还在进行，执行者被中断了。回复这条消息（终端里的任务直接说“继续”）它就会接着做。`, { kind: 'magpie', notify: true })
        out.asked.push(task.id)
      } else if (action === 'integrate') {
        // As at the end of the turn, the person is told only of a conflict.
        await integrateDaily(ctx, cut)
        out.integrated.push(task.id)
      } else {
        const role = action === 'rerun-acceptance' ? 'acceptance' : 'diagnosis'
        await rerunCheck(ctx, cut, role)
        await tell(ctx, cut, `「${cut.title}」的${role === 'acceptance' ? '验收' : '诊断'}被 Router 重启中断，已重新开始。`, { kind: 'magpie', notify: false })
        out.rerun.push(task.id)
      }
    } catch (error) {
      const line = (error instanceof Error ? error.message : String(error)).split('\n')[0]!
      await ctx.reg.update(task.id, t => { t.state = 'error'; t.error = `recovery after the Router restart: ${line}` }, { type: 'error', during: 'router-recovery', error: line })
      failed.push(`${task.id}: ${line}`)
    }
  }
  if (failed.length > 0) throw new Error(`recovering the Router's daily tasks failed for ${failed.length}: ${failed.join('; ')}`)
  return out
}

// ---- archive failures ------------------------------------------------------------------------

// The first line after st.debugOffset in this session's debug log that reports a context-memory
// archive failure, or null; the offset moves to the end of what was read. An architect the plugin
// launched writes <stateDir>/debug/<task id>.txt (launchArgv); any other session is read at
// <config dir>/debug/<session id>.txt, which a background session only has when started with a
// debug flag (U4). A session without either has nothing to check, which goes to the debug output once.
let missingLogNoted = false
export async function scanDebugLog(ctx: Ctx): Promise<string | null> {
  const { io, st } = ctx
  const own = st.taskId === null ? null : debugFile(ctx.opts, st.taskId)
  const path = own !== null && await io.exists(own) ? own : `${await claudeConfigDir(io)}/debug/${st.sessionId}.txt`
  if (!(await io.exists(path))) {
    if (!missingLogNoted) { missingLogNoted = true; await io.log(`no debug log at ${path}; context-memory archive failures are not checked`) }
    return null
  }
  const size = (await io.stat(path)).size
  if (size < st.debugOffset) st.debugOffset = 0
  if (size === st.debugOffset) return null
  const r = await io.run(['sh', '-c', 'tail -c +"$1" "$2" | head -c "$3" | grep -m1 -E "$4"', 'sh', String(st.debugOffset + 1), path, String(size - st.debugOffset), ARCHIVE_FAILURE], { timeoutMs: 30_000 })
  if (r.exitCode > 1) throw new Error(`scanning ${path} exited ${r.exitCode}: ${r.stderr.trim()}`)
  st.debugOffset = size
  return r.exitCode === 0 ? r.stdout.trim() : null
}
