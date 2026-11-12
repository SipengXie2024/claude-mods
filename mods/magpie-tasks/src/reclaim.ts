// Reclaiming what finished tasks still hold: the worktrees and base refs of tasks that are done or
// abandoned, and the background session of a done long task's architect once it sits idle. A daily
// task's worktree goes as soon as the task is done; the Router's timer and its startup recovery sweep
// whatever is left. A later message to the task gets a fresh worktree of the project as it is then
// (open_project for a daily executor, the reopening of a long task for its architect).
import { removeWorktreeAndRef } from './git'
import { listAgents, stopSession, type AgentsRow } from './launch'
import type { Ctx } from './state'
import type { TaskRecord } from './types'

// A done long task's architect may still be finishing its turn or be about to read a reply; it is
// stopped only after it has been idle this long past the task's completion.
export const ARCHITECT_GRACE_MS = 10 * 60_000

// Whether a finished task still holds a worktree that can go: done or abandoned, no open question to
// the person, no agent of it still marked running, and, for a long task, no architect process left.
export function worktreeReclaimable(task: TaskRecord, architect: AgentsRow | undefined): boolean {
  if (task.state !== 'done' && task.state !== 'abandoned') return false
  if (task.project === null || (task.worktree === null && Object.keys(task.extraWorktrees).length === 0)) return false
  if (Object.values(task.decisions).some(d => d.resolvedAt === undefined)) return false
  if (Object.values(task.agents).some(a => a.state === 'running')) return false
  return task.kind === 'daily' || architect === undefined || architect.pid == null
}

// Whether a done long task's architect session is to be stopped: its process runs, idle, and the
// task has been done for ARCHITECT_GRACE_MS.
export function architectToStop(task: TaskRecord, row: AgentsRow | undefined, now: number): boolean {
  return task.kind === 'long' && task.state === 'done' && task.owner.kind === 'session'
    && row !== undefined && row.pid != null && row.status === 'idle'
    && (task.completedAt ?? task.updatedAt) <= now - ARCHITECT_GRACE_MS
}

// Removes the task's worktree and its agents' separate copies with their base refs. Agents that
// worked in them have no working directory afterwards, so a woken one is sent to open_project.
export async function removeTaskWorktrees(ctx: Ctx, task: TaskRecord): Promise<void> {
  if (task.project === null) return
  const repo = task.project.root
  const removed: string[] = []
  for (const x of Object.values(task.extraWorktrees)) {
    await removeWorktreeAndRef(ctx.io, repo, x.path, x.baseRef)
    removed.push(x.path)
  }
  if (task.worktree !== null) {
    await removeWorktreeAndRef(ctx.io, repo, task.worktree.path, task.worktree.baseRef)
    removed.push(task.worktree.path)
  }
  await ctx.reg.update(task.id, t => {
    t.worktree = null
    t.extraWorktrees = {}
    for (const a of Object.values(t.agents)) {
      if (a.worktree !== null && removed.includes(a.worktree)) { a.worktree = null; a.cwd = task.project!.root }
    }
  }, { type: 'worktree-removed', paths: removed })
}

// One sweep over all tasks. A task whose step fails is named in the error thrown at the end; the
// other tasks are still swept.
export async function reclaim(ctx: Ctx): Promise<{ worktrees: string[]; architects: string[] }> {
  const out = { worktrees: [] as string[], architects: [] as string[] }
  const tasks = await ctx.reg.list(t => (t.state === 'done' || t.state === 'abandoned') && (t.worktree !== null || Object.keys(t.extraWorktrees).length > 0 || t.kind === 'long'))
  if (tasks.length === 0) return out
  const rows = tasks.some(t => t.kind === 'long') ? new Map((await listAgents(ctx.io, ctx.opts)).map(r => [r.sessionId, r] as const)) : new Map<string, AgentsRow>()
  const now = await ctx.io.now()
  const failed: string[] = []
  for (const task of tasks) {
    try {
      const row = task.owner.kind === 'session' ? rows.get(task.owner.sessionId) : undefined
      if (architectToStop(task, row, now)) {
        const shortId = task.owner.kind === 'session' ? task.owner.jobShortId ?? row!.id : row!.id
        await stopSession(ctx, shortId)
        await ctx.reg.log(task.id, { type: 'architect-stopped', shortId, reason: 'task done' })
        out.architects.push(task.id)
        continue
      }
      if (worktreeReclaimable(task, row)) {
        await removeTaskWorktrees(ctx, task)
        out.worktrees.push(task.id)
      }
    } catch (error) {
      const line = (error instanceof Error ? error.message : String(error)).split('\n')[0]!
      await ctx.reg.log(task.id, { type: 'error', during: 'reclaim', error: line })
      failed.push(`${task.id}: ${line}`)
    }
  }
  if (failed.length > 0) throw new Error(`reclaiming finished tasks failed for ${failed.length} of ${tasks.length}: ${failed.join('; ')}`)
  return out
}
