// Where a task changes its projects. A task changes any number of projects, each named once
// (open_project for a routed subagent; the session's project for a long task) and each placed on its
// own: the task works in the project directory itself while no other live task works there directly;
// a task whose project another live task already changes in place gets a Git worktree of it, whose
// change is applied to the project once its result is accepted. Outside Git a task always works in
// place: there is no worktree and no diff, only the files its agents edited.
import { baseRefName, createWorktree, dropBase, repoRoot, snapshotBase } from './git'
import { fnv1a64, type Io } from './io'
import type { Registry } from './registry'
import type { AgentRecord, Options, TaskRecord, Workspace } from './types'

// The project lock of integrate.ts: placing a task and applying a change to the same directory
// never overlap.
export const PROJECT_LOCK = { waitMs: 120_000, staleMs: 600_000 }
export const projectLock = (dir: string) => `project-${fnv1a64(dir)}`

// Runs `fn` as the task's only placement. A project the task has not named yet gets the next number
// among its projects, read before the Git work and written after it, so two projects placed at once
// would take the same number and write the same entry. The lock is taken before a project lock and
// held across the wait for it and the work under it.
const PLACEMENT_LOCK = { waitMs: 2 * PROJECT_LOCK.waitMs, staleMs: PROJECT_LOCK.waitMs + PROJECT_LOCK.staleMs }
export function placing<T>(reg: Registry, taskId: string, fn: () => Promise<T>): Promise<T> {
  return reg.lock(`placement-${taskId}`, fn, PLACEMENT_LOCK)
}

type Placed = Pick<TaskRecord, 'project' | 'direct' | 'worktree' | 'alsoChanged' | 'more'>

// The task's projects in the order it named them. The first is the record itself, which holds the
// fields of a Workspace; changing an entry inside a registry update changes the record.
export function workspaces(task: Placed): Workspace[] {
  return task.project === null ? [] : [task as Workspace, ...(task.more ?? [])]
}

// The directory agents write in for one project: its worktree, the project directory of a direct
// task, or null while the project has neither (its worktree was removed when the task finished).
export function pathOf(w: Pick<Workspace, 'direct' | 'worktree'>): string | null {
  return w.worktree?.path ?? w.direct?.dir ?? null
}

// The task's working directories, in the order of its projects.
export function workspacePaths(task: Placed): string[] {
  return workspaces(task).map(pathOf).filter((p): p is string => p !== null)
}

// The first project of the task that has a working directory: the one its agents start in, and the
// one an agent's separate copy is made from.
export function firstPlaced(task: Placed): Workspace | null {
  return workspaces(task).find(w => pathOf(w) !== null) ?? null
}

// The directory a task's agents start in, or null before the task names a project.
export function workspaceOf(task: Placed): string | null {
  const w = firstPlaced(task)
  return w === null ? null : pathOf(w)
}

// The workspace of the project at `root`, with its number among the task's projects (1 for the first).
export function workspaceAt(task: Placed, root: string): { w: Workspace; n: number } | null {
  const all = workspaces(task)
  const i = all.findIndex(w => w.project.root === root)
  return i < 0 ? null : { w: all[i]!, n: i + 1 }
}

// The names the plugin gives the task's n-th project: its worktree path, its base ref (a task's
// projects may share one ref store, as linked worktrees of one repository do) and its patch file.
export const worktreePath = (opts: Pick<Options, 'worktreeDir'>, taskId: string, n: number) => `${opts.worktreeDir}/${taskId}${n === 1 ? '' : `-p${n}`}`
export const baseRefOf = (taskId: string, n: number) => (n === 1 ? baseRefName(taskId) : baseRefName(taskId, `p${n}`))
export const patchPathOf = (opts: Pick<Options, 'stateDir'>, taskId: string, n: number) => `${opts.stateDir}/tasks/${taskId}${n === 1 ? '' : `.p${n}`}.patch`

// For an agent running in `cwd`: whether that is a project directory the task changes in place, and
// whether it is a Git repository there; null in a worktree or with no working directory.
export function directOf(task: Placed, cwd: string | null): { git: boolean } | null {
  const d = cwd === null ? undefined : workspaces(task).find(w => w.worktree === null && w.direct?.dir === cwd)?.direct
  return d === undefined || d === null ? null : { git: d.baseRef !== null }
}

// Where a routed agent may write inside Git repositories: `dirs` are its own working directory
// first, then the working directories of the task's other projects; `copies` maps a directory it
// must leave alone to the copy it changes instead (a project's main directory to the task worktree
// of it; for an agent with a separate copy, the directory that copy was made from). An agent
// without a working directory has no range until it opens a project.
export function writeRange(task: Pick<TaskRecord, keyof Placed | 'extraWorktrees'>, agent: Pick<AgentRecord, 'worktree'>): { dirs: string[]; copies: Record<string, string> } {
  const dirs: string[] = []
  const copies: Record<string, string> = {}
  if (agent.worktree === null) return { dirs, copies }
  dirs.push(agent.worktree)
  // A helper works in its parent's separate copy.
  const own = Object.values(task.extraWorktrees).find(x => x.path === agent.worktree)
  const shared = workspaceOf(task)
  for (const w of workspaces(task)) {
    const path = pathOf(w)
    if (path === null) continue
    const mine = own !== undefined && path === shared ? own.path : path
    if (!dirs.includes(mine)) dirs.push(mine)
    for (const other of [path, w.project.root]) if (other !== mine) copies[other] = mine
  }
  return { dirs, copies }
}

// A task that still holds its projects: not done and not abandoned.
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

const directAt = (task: Placed, dir: string) => workspaces(task).find(w => w.worktree === null && w.direct?.dir === dir)

// The live tasks other than `exceptId` that change `dir` in place.
export function directHolders(reg: Registry, dir: string, exceptId: string): Promise<TaskRecord[]> {
  return reg.list(t => t.id !== exceptId && isLive(t) && directAt(t, dir) !== undefined)
}

export type Placement = { mode: 'direct' | 'worktree'; path: string; git: boolean; others: Pick<TaskRecord, 'id' | 'title'>[] }

// Places a task on the project at `root`, one it has no working directory for (a new project of the
// task, or one whose worktree was removed when the task finished), and records the outcome on the
// task: in place when no other live task changes that project in place, or when the project is not
// a Git repository; a Git worktree otherwise. A direct task in Git gets a base commit of the
// directory as it is now, so its change can be told from the rest.
export function placeTask(io: Io, reg: Registry, opts: Pick<Options, 'worktreeDir'>, taskId: string, root: string): Promise<Placement> {
  return placing(reg, taskId, () => placeLocked(io, reg, opts, taskId, root))
}

// placeTask for a caller that runs inside `placing` for this task.
export async function placeLocked(io: Io, reg: Registry, opts: Pick<Options, 'worktreeDir'>, taskId: string, root: string): Promise<Placement> {
  const { dir, git } = await projectDir(io, root)
  return reg.lock(projectLock(dir), async () => {
    const task = await reg.get(taskId)
    if (task === undefined) throw new Error(`task ${taskId} does not exist`)
    const known = workspaceAt(task, dir)
    if (known !== null && pathOf(known.w) !== null) throw new Error(`task ${taskId} already works on ${dir} in ${pathOf(known.w)}`)
    const n = known?.n ?? workspaces(task).length + 1
    // The n-th project of the record `t`, made when the task had not named it yet.
    const slot = (t: TaskRecord): Workspace => {
      if (n === 1) {
        t.project ??= { root: dir }
        return t as Workspace
      }
      const more = (t.more ??= [])
      return (more[n - 2] ??= { project: { root: dir }, worktree: null })
    }
    const others = (await directHolders(reg, dir, taskId)).map(t => ({ id: t.id, title: t.title }))
    if (others.length === 0 || !git) {
      const base = git ? await snapshotBase(io, dir, baseRefOf(taskId, n), dir) : null
      await reg.update(taskId, t => {
        const w = slot(t)
        w.direct = { dir, baseRef: base?.baseRef ?? null, baseCommit: base?.baseCommit ?? null }
        w.worktree = null
        w.alsoChanged = []
      }, { type: 'workspace', mode: 'direct', dir, git, ...(base !== null ? { baseCommit: base.baseCommit } : {}), others: others.map(o => o.id) })
      return { mode: 'direct', path: dir, git, others }
    }
    const path = worktreePath(opts, taskId, n)
    const made = await createWorktree(io, dir, path, baseRefOf(taskId, n), dir)
    await reg.update(taskId, t => {
      const w = slot(t)
      w.worktree = { path, baseRef: made.baseRef, baseCommit: made.baseCommit }
      w.direct = null
    }, { type: 'workspace', mode: 'worktree', dir, path, baseCommit: made.baseCommit, others: others.map(o => o.id) })
    return { mode: 'worktree', path, git, others }
  }, PROJECT_LOCK)
}

// A direct task that ended and was then resumed while another live task took its project `dir` over
// in place moves to a worktree of the project as it is now (its earlier change is already there).
// Returns the worktree path, or null when it may go on in place.
export async function leaveIfTaken(io: Io, reg: Registry, opts: Pick<Options, 'worktreeDir'>, taskId: string, dir: string): Promise<{ path: string; others: Pick<TaskRecord, 'id' | 'title'>[] } | null> {
  const first = await reg.get(taskId)
  if (first === undefined || directAt(first, dir)?.direct?.baseRef == null) return null
  return reg.lock(projectLock(dir), async () => {
    const task = await reg.get(taskId)
    const direct = task === undefined ? undefined : directAt(task, dir)?.direct
    if (task === undefined || direct === undefined || direct === null || direct.baseRef === null || direct.baseCommit === null) return null
    if (isLive(task)) return null
    const others = (await directHolders(reg, dir, taskId)).map(t => ({ id: t.id, title: t.title }))
    if (others.length === 0) return null
    const n = workspaces(task).findIndex(w => w.direct === direct) + 1
    await dropBase(io, dir, direct.baseRef, direct.baseCommit)
    const path = worktreePath(opts, taskId, n)
    const made = await createWorktree(io, dir, path, baseRefOf(taskId, n), dir)
    await reg.update(taskId, t => {
      const w = workspaces(t)[n - 1]!
      w.worktree = { path, baseRef: made.baseRef, baseCommit: made.baseCommit }
      w.direct = null
      w.alsoChanged = []
      for (const a of Object.values(t.agents)) {
        if (a.worktree === dir) {
          a.worktree = path
          a.cwd = path
        }
      }
    }, { type: 'workspace', mode: 'worktree', dir, path, baseCommit: made.baseCommit, others: others.map(o => o.id), reason: 'resumed after another task took the project over in place' })
    return { path, others }
  }, PROJECT_LOCK)
}

// The placement placeTask would make now for a new task on `root`, recording nothing; the worktree
// path is the one `taskId` would get.
export async function previewPlacement(io: Io, reg: Registry, opts: Pick<Options, 'worktreeDir'>, taskId: string, root: string): Promise<Placement> {
  const { dir, git } = await projectDir(io, root)
  const others = (await directHolders(reg, dir, taskId)).map(t => ({ id: t.id, title: t.title }))
  if (others.length === 0 || !git) return { mode: 'direct', path: dir, git, others }
  return { mode: 'worktree', path: worktreePath(opts, taskId, 1), git, others }
}

// Records on every other task that works in place in `dir` that `from` changed `files` there, so
// their diffs name those files as not their own.
export async function noteChange(io: Io, reg: Registry, dir: string, from: Pick<TaskRecord, 'id' | 'title'>, files: string[]): Promise<void> {
  if (files.length === 0) return
  const at = await io.now()
  for (const t of await reg.list(x => x.id !== from.id && x.state !== 'abandoned' && directAt(x, dir) !== undefined)) {
    await reg.update(t.id, x => {
      const w = directAt(x, dir)
      if (w !== undefined) w.alsoChanged = [...(w.alsoChanged ?? []), { taskId: from.id, title: from.title, files, at }]
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
