// Integration (plan section 9.10): applies the change a worktree made since its base to a target
// directory (the project main directory, or the task worktree for an agent's separate copy), one
// integration per project at a time, and moves the base so the next integration applies only what
// came after. Only the target's working tree changes: no index update, no commit, no push.
import { diffToFile, git, gitRun, refLabel, repoRoot, scratchPath, snapshotCommit } from './git'
import { fnv1a64, type Io } from './io'
import type { Registry } from './registry'
import type { TaskRecord } from './types'

export type IntegrationResult = { status: 'applied'; files: string[]; newBase: string } | { status: 'empty' } | { status: 'conflict'; files: string[]; detail: string }

// `git apply` runs a patch from disk; the project lock is held for it, so its wait and staleness
// limits are longer than the defaults (plan section 7.2).
const PROJECT_LOCK = { waitMs: 120_000, staleMs: 600_000 }
const APPLY_MS = 600_000

export async function integrate(io: Io, reg: Registry, a: { taskId: string; repo: string; source: string; target: string; baseRef: string }): Promise<IntegrationResult> {
  const repoReal = await io.realPath(a.repo)
  if (repoReal === null) throw new Error(`integrate: repository ${a.repo} does not exist`)
  return reg.lock(`project-${fnv1a64(repoReal)}`, async () => {
    const base = (await git(io, ['-C', a.repo, 'rev-parse', '--verify', `${a.baseRef}^{commit}`])).trim()
    const tmpIndex = await scratchPath(io, a.source, 'index')
    const patchPath = await scratchPath(io, a.source, 'patch')
    try {
      const { tree, files } = await diffToFile(io, a.source, base, tmpIndex, patchPath)
      const entry = { target: a.target, source: a.source, base, tree, files }
      if (files.length === 0) {
        await record(io, reg, a, { status: 'empty', files: [] }, { type: 'integration', status: 'empty', ...entry })
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
        await record(io, reg, a, { status: 'conflict', files }, { type: 'integration', status: 'conflict', ...entry, detail })
        return { status: 'conflict', files, detail }
      }
      // From here until the 'integration' entry, an interruption leaves an integration-start with
      // no matching integration (same tree), which recovery reports instead of resuming (section 9.13).
      await reg.log(a.taskId, { type: 'integration-start', ...entry })
      await git(io, ['-C', top, 'apply', '--binary', '--whitespace=nowarn', patchPath], { timeoutMs: APPLY_MS })
      const newBase = await snapshotCommit(io, a.repo, tree, base, `magpie-tasks base ${refLabel(a.baseRef)}`)
      // Compare-and-swap: the ref still names the base this patch was made against.
      await git(io, ['-C', a.repo, 'update-ref', a.baseRef, newBase, base])
      await record(io, reg, a, { status: 'applied', files }, { type: 'integration', status: 'applied', ...entry, newBase })
      return { status: 'applied', files, newBase }
    } finally {
      const r = await io.run(['rm', '-f', tmpIndex, patchPath])
      if (r.exitCode !== 0) throw new Error(`rm -f ${tmpIndex} ${patchPath} exited ${r.exitCode}: ${r.stderr.trim()}`)
    }
  }, PROJECT_LOCK)
}

// Writes the outcome to the task log and, for an integration into the project main directory, to
// the task's deliverables. The latest deliverable stays open while it has no integration or its
// integration ended in a conflict (the user may resolve it and integrate again): the outcome goes
// onto it, replacing an earlier conflict. Once it holds an applied or empty integration, an applied
// one gets an entry of its own (the architect integrated without reporting an accepted outcome
// first), and an empty or conflicting one is only logged. Integrations of a separate copy into the
// task worktree are internal to the task and only logged.
async function record(
  io: Io,
  reg: Registry,
  a: { taskId: string; target: string },
  outcome: { status: 'applied' | 'empty' | 'conflict'; files: string[] },
  log: { type: 'integration'; [k: string]: unknown },
): Promise<void> {
  const task = await reg.get(a.taskId)
  if (task === undefined) throw new Error(`integrate: task ${a.taskId} does not exist`)
  if (!(await intoProject(io, task, a.target))) {
    await reg.log(a.taskId, log)
    return
  }
  if (!isOpen(task.deliverables[task.deliverables.length - 1]) && outcome.status !== 'applied') {
    await reg.log(a.taskId, log)
    return
  }
  const at = await io.now()
  const integration = { status: outcome.status, files: outcome.files, at }
  await reg.update(a.taskId, t => {
    const latest = t.deliverables[t.deliverables.length - 1]
    if (latest !== undefined && isOpen(latest)) latest.integration = integration
    else t.deliverables.push({ at, summary: `integration into ${a.target} with no accepted deliverable on record`, verification: [], integration })
  }, log)
}

function isOpen(d: TaskRecord['deliverables'][number] | undefined): boolean {
  return d !== undefined && (d.integration === undefined || d.integration.status === 'conflict')
}

async function intoProject(io: Io, task: TaskRecord, target: string): Promise<boolean> {
  if (task.project === null) return false
  const [projectReal, targetReal] = await Promise.all([io.realPath(task.project.root), io.realPath(target)])
  if (projectReal === null) throw new Error(`integrate: project root ${task.project.root} of task ${task.id} does not exist`)
  return projectReal === targetReal
}

