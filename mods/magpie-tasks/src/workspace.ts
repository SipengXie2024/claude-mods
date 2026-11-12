// Where a task changes its project. A task works in the project directory itself while no other live
// task works there directly; a task whose project another live task already changes in place gets a
// Git worktree, whose change is applied to the project once its result is accepted. Outside Git a
// task always works in place: there is no worktree and no diff, only the files its agents edited.
import { baseRefName, createWorktree, dropBase, repoRoot, snapshotBase } from './git'
import { fnv1a64, type Io } from './io'
import type { Registry } from './registry'
import type { Options, TaskRecord } from './types'

// The project lock of integrate.ts: placing a task and applying a change to the same directory
// never overlap.
export const PROJECT_LOCK = { waitMs: 120_000, staleMs: 600_000 }
export const projectLock = (dir: string) => `project-${fnv1a64(dir)}`

// The directory a task's agents write in: its worktree, the project directory of a direct task, or
// null before it names a project.
export function workspaceOf(task: Pick<TaskRecord, 'worktree' | 'direct'>): string | null {
  return task.worktree?.path ?? task.direct?.dir ?? null
}

// For an agent running in `cwd`: whether that is the project directory of a direct task, and whether
// it is a Git repository there; null in a worktree or with no working directory.
export function directOf(task: Pick<TaskRecord, 'direct'>, cwd: string | null): { git: boolean } | null {
  const d = task.direct
  return d === undefined || d === null || cwd === null || cwd !== d.dir ? null : { git: d.baseRef !== null }
}

// A task that still holds its project: not done and not abandoned.
export function isLive(task: Pick<TaskRecord, 'state'>): boolean {
  return task.state !== 'done' && task.state !== 'abandoned'
}

// The directory of a project: the top of its repository, or the project directory itself (real
// path) outside Git.
export async function projectDir(io: Io, root: string): Promise<{ dir: string; git: boolean }> {
  const top = await repoRoot(io, root)
  if (top !== null) return { dir: top, git: true }
  const real = await io.realPath(root)
  if (real === null) throw new Error(`${root} does not exist`)
  return { dir: real, git: false }
}

// The live tasks other than `exceptId` that change `dir` in place.
export function directHolders(reg: Registry, dir: string, exceptId: string): Promise<TaskRecord[]> {
  return reg.list(t => t.id !== exceptId && isLive(t) && t.worktree === null && t.direct?.dir === dir)
}

export type Placement = { mode: 'direct' | 'worktree'; path: string; git: boolean; others: Pick<TaskRecord, 'id' | 'title'>[] }

// Places a task with no workspace yet on the project at `root` (recorded as the task's project
// root) and records the outcome on the task: in place when no other live task changes that project
// in place, or when the project is not a Git repository; a Git worktree otherwise. A direct task in
// Git gets a base commit of the directory as it is now, so its change can be told from the rest.
export async function placeTask(io: Io, reg: Registry, opts: Pick<Options, 'worktreeDir'>, taskId: string, root: string): Promise<Placement> {
  const { dir, git } = await projectDir(io, root)
  return reg.lock(projectLock(dir), async () => {
    const task = await reg.get(taskId)
    if (task === undefined) throw new Error(`task ${taskId} does not exist`)
    if (workspaceOf(task) !== null) throw new Error(`task ${taskId} already works in ${workspaceOf(task)}`)
    const others = (await directHolders(reg, dir, taskId)).map(t => ({ id: t.id, title: t.title }))
    if (others.length === 0 || !git) {
      const base = git ? await snapshotBaseOf(io, dir, taskId) : null
      await reg.update(taskId, t => {
        t.project = { root }
        t.direct = { dir, baseRef: base?.baseRef ?? null, baseCommit: base?.baseCommit ?? null }
        t.worktree = null
        t.alsoChanged = []
      }, { type: 'workspace', mode: 'direct', dir, git, ...(base !== null ? { baseCommit: base.baseCommit } : {}), others: others.map(o => o.id) })
      return { mode: 'direct', path: dir, git, others }
    }
    const path = `${opts.worktreeDir}/${taskId}`
    const made = await createWorktree(io, dir, path, baseRefName(taskId), dir)
    await reg.update(taskId, t => {
      t.project = { root }
      t.worktree = { path, baseRef: made.baseRef, baseCommit: made.baseCommit }
      t.direct = null
    }, { type: 'workspace', mode: 'worktree', dir, path, baseCommit: made.baseCommit, others: others.map(o => o.id) })
    return { mode: 'worktree', path, git, others }
  }, PROJECT_LOCK)
}

// A direct task that ended and was then resumed while another live task took over its project in
// place moves to a worktree of the project as it is now (its earlier change is already there).
// Returns the worktree path, or null when it may go on in place.
export async function leaveIfTaken(io: Io, reg: Registry, opts: Pick<Options, 'worktreeDir'>, taskId: string): Promise<{ path: string; others: Pick<TaskRecord, 'id' | 'title'>[] } | null> {
  const first = await reg.get(taskId)
  const d = first?.direct
  if (first === undefined || d === undefined || d === null || d.baseRef === null || first.worktree !== null) return null
  return reg.lock(projectLock(d.dir), async () => {
    const task = await reg.get(taskId)
    const direct = task?.direct
    if (task === undefined || direct === undefined || direct === null || direct.baseRef === null || direct.baseCommit === null || task.worktree !== null) return null
    if (isLive(task)) return null
    const others = (await directHolders(reg, direct.dir, taskId)).map(t => ({ id: t.id, title: t.title }))
    if (others.length === 0) return null
    await dropBase(io, direct.dir, direct.baseRef, direct.baseCommit)
    const path = `${opts.worktreeDir}/${taskId}`
    const made = await createWorktree(io, direct.dir, path, baseRefName(taskId), direct.dir)
    await reg.update(taskId, t => {
      t.worktree = { path, baseRef: made.baseRef, baseCommit: made.baseCommit }
      t.direct = null
      t.alsoChanged = []
      for (const a of Object.values(t.agents)) {
        if (a.worktree === direct.dir) {
          a.worktree = path
          a.cwd = path
        }
      }
    }, { type: 'workspace', mode: 'worktree', dir: direct.dir, path, baseCommit: made.baseCommit, others: others.map(o => o.id), reason: 'resumed after another task took the project over in place' })
    return { path, others }
  }, PROJECT_LOCK)
}

function snapshotBaseOf(io: Io, dir: string, taskId: string): Promise<{ baseRef: string; baseCommit: string }> {
  return snapshotBase(io, dir, baseRefName(taskId), dir)
}

// The placement placeTask would make now for a new task on `root`, recording nothing; the worktree
// path is the one `taskId` would get.
export async function previewPlacement(io: Io, reg: Registry, opts: Pick<Options, 'worktreeDir'>, taskId: string, root: string): Promise<Placement> {
  const { dir, git } = await projectDir(io, root)
  const others = (await directHolders(reg, dir, taskId)).map(t => ({ id: t.id, title: t.title }))
  if (others.length === 0 || !git) return { mode: 'direct', path: dir, git, others }
  return { mode: 'worktree', path: `${opts.worktreeDir}/${taskId}`, git, others }
}

// Records on every other task that works in place in `dir` that `from` changed `files` there, so
// their diffs name those files as not their own.
export async function noteChange(io: Io, reg: Registry, dir: string, from: Pick<TaskRecord, 'id' | 'title'>, files: string[]): Promise<void> {
  if (files.length === 0) return
  const at = await io.now()
  for (const t of await reg.list(x => x.id !== from.id && x.state !== 'abandoned' && x.worktree === null && x.direct?.dir === dir)) {
    await reg.update(t.id, x => {
      x.alsoChanged = [...(x.alsoChanged ?? []), { taskId: from.id, title: from.title, files, at }]
    }, { type: 'also-changed', taskId: from.id, files })
  }
}

// How a placement reads to the person, in Chinese, for the long-task question and Telegram notes.
export function placementLine(p: Pick<Placement, 'mode' | 'path' | 'git' | 'others'>): string {
  const names = p.others.map(o => `「${o.title}」`).join('、')
  if (p.mode === 'worktree') return `工作副本：${p.path}（${names}正在直接修改这个项目）`
  if (!p.git) return p.others.length === 0 ? `直接修改：${p.path}（不是 Git 仓库，没有差异记录）` : `直接修改：${p.path}（不是 Git 仓库，${names}也在直接修改这个目录）`
  return `直接修改：${p.path}`
}
