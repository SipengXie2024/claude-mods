// Integration (plan section 9.10): applies the change a worktree made since its base to a target
// directory (the project main directory, or the task worktree for an agent's separate copy), one
// integration per project at a time, and moves the base so the next integration applies only what
// came after. Only the target's working tree changes: no index update, no commit, no push; commits
// and pushes are made by an agent when the person asks. A project the task changes in the project
// directory itself has nothing to apply: settleDirect takes its change as the result and moves its
// base. integrateTask does this for every project of a task and records the outcome on the task's
// deliverables.
import { diffToFile, git, gitRun, refLabel, repoRoot, scratchPath, snapshotCommit } from './git'
import type { Io } from './io'
import type { Registry } from './registry'
import type { IntegrationPart, TaskRecord } from './types'
import { noteChange, pathOf, PROJECT_LOCK, projectDir, projectLock, workspaceAt, workspaces } from './workspace'

export type IntegrationResult = { status: 'applied'; files: string[]; newBase: string } | { status: 'empty' } | { status: 'conflict'; files: string[]; detail: string }

// `git apply` runs a patch from disk; the project lock is held for it, so its wait and staleness
// limits are longer than the defaults (plan section 7.2).
const APPLY_MS = 600_000

export async function integrate(io: Io, reg: Registry, a: { taskId: string; repo: string; source: string; target: string; baseRef: string }): Promise<IntegrationResult> {
  if (!(await io.exists(a.repo))) throw new Error(`integrate: repository ${a.repo} does not exist`)
  const { dir } = await projectDir(io, a.repo)
  return reg.lock(projectLock(dir), async () => {
    const base = (await git(io, ['-C', a.repo, 'rev-parse', '--verify', `${a.baseRef}^{commit}`])).trim()
    const tmpIndex = await scratchPath(io, a.source, 'index')
    const patchPath = await scratchPath(io, a.source, 'patch')
    try {
      const { tree, files } = await diffToFile(io, a.source, base, tmpIndex, patchPath)
      const entry = { target: a.target, source: a.source, base, tree, files }
      if (files.length === 0) {
        await reg.log(a.taskId, { type: 'integration', status: 'empty', ...entry })
        return { status: 'empty' }
      }
      // Patch paths are relative to the repository top; applied from a subdirectory, git would skip
      // the paths outside it.
      const top = await repoRoot(io, a.target)
      if (top === null) throw new Error(`integrate: target ${a.target} is not inside a Git repository`)
      // Judged by exit code alone: a successful apply can still print whitespace warnings.
      const check = await gitRun(io, ['-C', top, 'apply', '--binary', '--check', '--whitespace=nowarn', patchPath], { timeoutMs: APPLY_MS })
      if (check.exitCode !== 0) {
        const detail = check.stderr.trim()
        await reg.log(a.taskId, { type: 'integration', status: 'conflict', ...entry, detail })
        return { status: 'conflict', files, detail }
      }
      // From here until the 'integration' entry, an interruption leaves an integration-start with
      // no matching integration (same tree), which recovery reports instead of resuming (section 9.13).
      await reg.log(a.taskId, { type: 'integration-start', ...entry })
      await git(io, ['-C', top, 'apply', '--binary', '--whitespace=nowarn', patchPath], { timeoutMs: APPLY_MS })
      const newBase = await snapshotCommit(io, a.repo, tree, base, `magpie-tasks base ${refLabel(a.baseRef)}`)
      // Compare-and-swap: the ref still names the base this patch was made against.
      await git(io, ['-C', a.repo, 'update-ref', a.baseRef, newBase, base])
      await reg.log(a.taskId, { type: 'integration', status: 'applied', ...entry, newBase })
      const task = await reg.get(a.taskId)
      if (task !== undefined && await projectRootOf(io, task, a.target) !== null) await noteChange(io, reg, top, task, files)
      return { status: 'applied', files, newBase }
    } finally {
      const r = await io.run(['rm', '-f', tmpIndex, patchPath])
      if (r.exitCode !== 0) throw new Error(`rm -f ${tmpIndex} ${patchPath} exited ${r.exitCode}: ${r.stderr.trim()}`)
    }
  }, PROJECT_LOCK)
}

export type SettleResult = { status: 'in-place'; files: string[] } | { status: 'empty' }

// The change a task made since its base in the project `root`, which it changes in the project
// directory itself: there is nothing to apply. In Git the base then moves to the directory as it is
// now, so the next result holds only what came after; outside Git the change is the files its
// agents edited with the file tools, which are cleared once taken. The other tasks that work in
// the same directory in place are told which files this one changed (noteChange).
export async function settleDirect(io: Io, reg: Registry, taskId: string, root: string): Promise<SettleResult> {
  const first = await reg.get(taskId)
  const d = first === undefined ? undefined : workspaceAt(first, root)?.w.direct
  if (d === undefined || d === null) throw new Error(`settleDirect: task ${taskId} does not work in the project directory ${root}`)
  return reg.lock(projectLock(d.dir), async () => {
    const task = (await reg.get(taskId))!
    const direct = workspaceAt(task, root)!.w.direct!
    let files: string[]
    if (direct.baseRef === null) {
      files = touchedFiles(task, direct.dir)
      if (files.length > 0) {
        await reg.update(taskId, t => {
          for (const a of Object.values(t.agents)) a.filesTouched = a.filesTouched.filter(p => !p.startsWith(`${direct.dir}/`))
        }, { type: 'touches-recorded', dir: direct.dir, files })
      }
    } else {
      const base = (await git(io, ['-C', direct.dir, 'rev-parse', '--verify', `${direct.baseRef}^{commit}`])).trim()
      const tmpIndex = await scratchPath(io, direct.dir, 'index')
      const patchPath = await scratchPath(io, direct.dir, 'patch')
      try {
        const diff = await diffToFile(io, direct.dir, base, tmpIndex, patchPath)
        files = diff.files
        if (files.length > 0) {
          const newBase = await snapshotCommit(io, direct.dir, diff.tree, base, `magpie-tasks base ${refLabel(direct.baseRef)}`)
          await git(io, ['-C', direct.dir, 'update-ref', direct.baseRef, newBase, base])
          await reg.update(taskId, t => {
            const w = workspaceAt(t, root)!.w
            w.direct!.baseCommit = newBase
            w.alsoChanged = []
          }, { type: 'base-moved', dir: direct.dir, base, newBase })
        }
      } finally {
        const r = await io.run(['rm', '-f', tmpIndex, patchPath])
        if (r.exitCode !== 0) throw new Error(`rm -f ${tmpIndex} ${patchPath} exited ${r.exitCode}: ${r.stderr.trim()}`)
      }
    }
    const status = files.length === 0 ? 'empty' : 'in-place'
    await reg.log(taskId, { type: 'integration', status, target: root, files })
    await noteChange(io, reg, direct.dir, task, files)
    return files.length === 0 ? { status: 'empty' } : { status: 'in-place', files }
  }, PROJECT_LOCK)
}

// The files a task's agents edited with the file tools inside `dir`, relative to it, in the order
// first edited.
export function touchedFiles(task: Pick<TaskRecord, 'agents'>, dir: string): string[] {
  const out: string[] = []
  for (const a of Object.values(task.agents)) {
    for (const p of a.filesTouched) {
      const rel = p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : null
      if (rel !== null && !out.includes(rel)) out.push(rel)
    }
  }
  return out
}

// One project's outcome of integrateTask; a conflict carries what a retry needs.
export type ProjectOutcome = IntegrationPart & { conflict?: { source: string; baseRef: string; detail: string } }

// Brings the change of every project of a task into its project directory, one project after the
// other: a worktree's change is applied (integrate), a change made in place is taken as it is
// (settleDirect). A conflict in one project leaves the others applied. The outcomes, in the order
// of the task's projects, are recorded on its deliverables (recordIntegration).
export async function integrateTask(io: Io, reg: Registry, taskId: string): Promise<ProjectOutcome[]> {
  const task = await reg.get(taskId)
  if (task === undefined) throw new Error(`integrateTask: task ${taskId} does not exist`)
  const out: ProjectOutcome[] = []
  for (const w of workspaces(task)) {
    const root = w.project.root
    if (w.worktree !== null) {
      const { path: source, baseRef } = w.worktree
      const r = await integrate(io, reg, { taskId, repo: root, source, target: root, baseRef })
      if (r.status === 'conflict') out.push({ root, status: 'conflict', files: r.files, conflict: { source, baseRef, detail: r.detail } })
      else out.push({ root, status: r.status, files: r.status === 'applied' ? r.files : [] })
    } else if (pathOf(w) !== null) {
      const r = await settleDirect(io, reg, taskId, root)
      out.push({ root, status: r.status, files: r.status === 'in-place' ? r.files : [] })
    }
  }
  await recordIntegration(io, reg, taskId, out.map(({ root, status, files }) => ({ root, status, files })))
  return out
}

// Writes what became of a result's change, one part per project, onto the task's deliverables. The
// latest deliverable stays open while it has no integration or its integration holds a conflict
// (the person may resolve it and integrate again): the parts go onto it, each replacing the earlier
// part of its project, except that nothing new does not replace a part that brought a change. Once
// it holds an integration without a conflict, parts that brought a change get an entry of their own
// (the architect integrated without reporting an accepted outcome first), and others are dropped.
export async function recordIntegration(io: Io, reg: Registry, taskId: string, parts: IntegrationPart[]): Promise<void> {
  if (parts.length === 0) return
  const at = await io.now()
  await reg.update(taskId, t => {
    const latest = t.deliverables[t.deliverables.length - 1]
    if (latest !== undefined && (latest.integration === undefined || latest.integration.status === 'conflict')) {
      const merged = integrationParts(t, latest.integration)
      for (const p of parts) {
        const i = merged.findIndex(m => m.root === p.root)
        if (i < 0) merged.push(p)
        else if (p.status !== 'empty' || !brought(merged[i]!)) merged[i] = p
      }
      latest.integration = summed(merged, at)
    } else if (parts.some(brought)) {
      t.deliverables.push({ at, summary: `integration into ${parts.filter(brought).map(p => p.root).join(', ')} with no accepted deliverable on record`, verification: [], integration: summed(parts, at) })
    }
  }, { type: 'deliverable-integration', parts: parts.map(p => ({ root: p.root, status: p.status, files: p.files.length })) })
}

const brought = (p: IntegrationPart) => p.status === 'applied' || p.status === 'in-place'

// The parts of a recorded integration, one per project; a record without them holds the task's
// first project alone.
export function integrationParts(task: Pick<TaskRecord, 'project'>, i: TaskRecord['deliverables'][number]['integration']): IntegrationPart[] {
  if (i === undefined) return []
  return i.parts !== undefined ? [...i.parts] : [{ root: task.project?.root ?? '', status: i.status, files: i.files }]
}

// The integration record of `parts`: a conflict anywhere makes it a conflict, else a change applied
// anywhere makes it applied, else a change made in place makes it in-place. `files` are relative to
// the project when one project has files, and absolute when several have.
function summed(parts: IntegrationPart[], at: number): NonNullable<TaskRecord['deliverables'][number]['integration']> {
  const status = (['conflict', 'applied', 'in-place'] as const).find(s => parts.some(p => p.status === s)) ?? 'empty'
  const withFiles = parts.filter(p => p.files.length > 0)
  const files = withFiles.length <= 1 ? withFiles[0]?.files ?? [] : withFiles.flatMap(p => p.files.map(f => `${p.root}/${f}`))
  return { status, files, at, parts }
}

// The root of the task's project whose main directory `target` is, or null when it is none (the
// task worktree, as the target of a separate copy).
export async function projectRootOf(io: Io, task: TaskRecord, target: string): Promise<string | null> {
  const targetReal = await io.realPath(target)
  for (const w of workspaces(task)) {
    const real = await io.realPath(w.project.root)
    if (real === null) throw new Error(`integrate: project root ${w.project.root} of task ${task.id} does not exist`)
    if (real === targetReal) return w.project.root
  }
  return null
}
