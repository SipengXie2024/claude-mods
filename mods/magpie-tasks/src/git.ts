// Git operations behind task worktrees (plan section 9.9): repository detection, `git init` with a
// baseline, snapshot trees taken through a temporary index, base commits under refs/magpie-tasks/,
// worktree creation and removal, and diffs against a base.
//
// The user's index, branches and working tree are never touched by a snapshot: every snapshot goes
// through a temporary index file (GIT_INDEX_FILE) and every commit the plugin makes hangs only off
// its own refs. Commands that format output use explicit flags, so a user's diff, color or hook
// configuration cannot change what the plugin reads or applies.
import type { Io } from './io'

const REF_PREFIX = 'refs/magpie-tasks/'
const LONG_MS = 600_000   // the longest $.process.run allows; `add -A` and checkouts of large trees need it

export type GitResult = { exitCode: number; stdout: string; stderr: string }

// Runs git with messages in English (callers match stderr) and without terminal prompts; resolves
// with any exit code.
export function gitRun(io: Io, args: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<GitResult> {
  return io.run(['git', ...args], { ...init, env: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...init?.env } })
}

// Runs git and throws with the command and its stderr when it exits non-zero.
export async function git(io: Io, args: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<string> {
  const r = await gitRun(io, args, init)
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${r.exitCode}: ${firstLines(r.stderr || r.stdout)}`)
  return r.stdout
}

// The base ref of a task worktree, or of an agent's separate worktree within the task.
export function baseRefName(taskId: string, agentId?: string): string {
  return agentId === undefined ? `${REF_PREFIX}${taskId}/base` : `${REF_PREFIX}${taskId}/${agentId}/base`
}

// A path for a temporary index or patch inside the git directory of `dir`: absolute (git resolves
// GIT_INDEX_FILE against the command's directory) and outside the work tree (so `add -A` never
// picks it up). The file does not exist yet.
export async function scratchPath(io: Io, dir: string, suffix: string): Promise<string> {
  const gitDir = (await git(io, ['-C', dir, 'rev-parse', '--absolute-git-dir'])).trim()
  return `${gitDir}/magpie-tasks.${await io.now()}.${Math.random().toString(36).slice(2, 10)}.${suffix}`
}

// The top directory of the repository containing `dir` (real path), or null when `dir` is in none.
export async function repoRoot(io: Io, dir: string): Promise<string | null> {
  if (!(await io.exists(dir))) throw new Error(`repoRoot: ${dir} does not exist`)
  const r = await gitRun(io, ['-C', dir, 'rev-parse', '--show-toplevel'])
  if (r.exitCode !== 0) {
    if (/not a git repository/i.test(r.stderr)) return null
    throw new Error(`git -C ${dir} rev-parse --show-toplevel exited ${r.exitCode}: ${firstLines(r.stderr)}`)
  }
  const top = r.stdout.trim()
  // A directory inside .git has no work tree: there is nothing to snapshot there.
  if (top === '') return null
  const real = await io.realPath(top)
  if (real === null) throw new Error(`repoRoot: ${top} reported by git does not exist`)
  return real
}

// Files and total bytes `git init` plus a baseline would record in a directory that is not a
// repository: regular files and symbolic links, the size of a link being that of its target text.
// Counted by find and summed by awk in one pipeline, so the count does not pass the 4 MiB output limit.
export async function projectStats(io: Io, dir: string): Promise<{ files: number; bytes: number }> {
  const script = 'set -o pipefail; find "$1" -name .git -prune -o \\( -type f -o -type l \\) -printf "%s\\n" | awk \'{ n++; b += $1 } END { printf "%d %d\\n", n, b }\''
  const r = await io.run(['bash', '-c', script, 'bash', dir], { env: { LC_ALL: 'C' }, timeoutMs: LONG_MS })
  if (r.exitCode !== 0) throw new Error(`counting files under ${dir} exited ${r.exitCode}: ${firstLines(r.stderr)}`)
  const m = /^(\d+) (\d+)$/.exec(r.stdout.trim())
  if (!m) throw new Error(`counting files under ${dir}: unexpected output ${JSON.stringify(r.stdout)}`)
  return { files: Number(m[1]), bytes: Number(m[2]) }
}

// `git init` in a directory outside any repository and a baseline commit 'magpie-tasks baseline' of
// every file in it, on the default branch. The commit is made with plumbing (no hooks, no signing,
// works for an empty directory); the real index is then set to the baseline so `git status` is clean.
export async function initRepo(io: Io, dir: string): Promise<void> {
  const existing = await repoRoot(io, dir)
  if (existing !== null) throw new Error(`initRepo: ${dir} is already inside the repository ${existing}`)
  await git(io, ['-C', dir, 'init', '-q'])
  const tmpIndex = await scratchPath(io, dir, 'index')
  const tree = await snapshotTree(io, dir, tmpIndex)
  const commit = await snapshotCommit(io, dir, tree, null, 'magpie-tasks baseline')
  await git(io, ['-C', dir, 'update-ref', 'HEAD', commit])
  await git(io, ['-C', dir, 'read-tree', 'HEAD'])
  // read-tree leaves no stat data; refreshing it saves the next `git status` from rehashing every file.
  await git(io, ['-C', dir, 'update-index', '-q', '--refresh'], { timeoutMs: LONG_MS })
}

// The tree of everything in the working tree of `dir`'s repository: tracked files as they are on
// disk, plus untracked files that are not ignored. Built in the temporary index `tmpIndex` (an
// absolute path that must not be inside the work tree; see scratchPath), which is removed afterwards.
export async function snapshotTree(io: Io, dir: string, tmpIndex: string): Promise<string> {
  if (!tmpIndex.startsWith('/')) throw new Error(`snapshotTree: the temporary index must be an absolute path, got ${tmpIndex}`)
  const env = { GIT_INDEX_FILE: tmpIndex }
  await removeFile(io, tmpIndex)
  try {
    if (await hasHead(io, dir)) await git(io, ['-C', dir, 'read-tree', 'HEAD'], { env })
    await git(io, ['-C', dir, 'add', '-A'], { env, timeoutMs: LONG_MS })
    return (await git(io, ['-C', dir, 'write-tree'], { env })).trim()
  } finally {
    await removeFile(io, tmpIndex)
  }
}

// A commit of `tree` with the given parent, by the user's Git identity, made without hooks or signing.
export async function snapshotCommit(io: Io, repo: string, tree: string, parent: string | null, message: string): Promise<string> {
  const args = ['-C', repo, 'commit-tree', '--no-gpg-sign', tree, ...(parent === null ? [] : ['-p', parent]), '-m', message]
  return (await git(io, args)).trim()
}

// A worktree at `path` holding a snapshot of `from` (the project directory, or a task worktree when
// making an agent's separate copy). The snapshot becomes base commit B (parent: HEAD of `from`, none
// in a repository without commits), `ref` is set to B, and the worktree is checked out detached at B.
// `ref` is refs/magpie-tasks/<taskId>/base or refs/magpie-tasks/<taskId>/<agentId>/base (baseRefName).
export async function createWorktree(io: Io, repo: string, path: string, ref: string, from: string): Promise<{ baseCommit: string; baseRef: string }> {
  const label = refLabel(ref)
  if (await io.exists(path)) throw new Error(`createWorktree: ${path} already exists`)
  const tree = await snapshotTree(io, from, await scratchPath(io, from, 'index'))
  const parent = await hasHead(io, from) ? (await git(io, ['-C', from, 'rev-parse', '--verify', 'HEAD^{commit}'])).trim() : null
  const baseCommit = await snapshotCommit(io, repo, tree, parent, `magpie-tasks base ${label}`)
  // The ref must not exist yet: an existing one belongs to another worktree of the same name.
  await git(io, ['-C', repo, 'update-ref', ref, baseCommit, ''])
  try {
    const parentDir = path.replace(/\/+[^/]+\/*$/, '')
    if (parentDir !== '' && parentDir !== path) {
      const made = await io.run(['mkdir', '-p', parentDir])
      if (made.exitCode !== 0) throw new Error(`mkdir -p ${parentDir} exited ${made.exitCode}: ${firstLines(made.stderr)}`)
    }
    // No hooks: a user's post-checkout hook has no business running in the plugin's copy.
    await git(io, ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', path, baseCommit], { timeoutMs: LONG_MS })
  } catch (e) {
    // A ref left behind would make every later attempt with this name fail on update-ref and hide
    // this cause.
    const del = await gitRun(io, ['-C', repo, 'update-ref', '-d', ref, baseCommit])
    if (del.exitCode !== 0) throw new Error(`${e instanceof Error ? e.message : String(e)}; removing ${ref} afterwards also failed: ${firstLines(del.stderr)}`)
    throw e
  }
  return { baseCommit, baseRef: ref }
}

// Removes the worktree at `path` with whatever changes it holds. A worktree whose directory is
// already gone is pruned from the repository's list instead.
export async function removeWorktree(io: Io, repo: string, path: string): Promise<void> {
  if (!(await io.exists(path))) {
    await git(io, ['-C', repo, 'worktree', 'prune'])
    return
  }
  await git(io, ['-C', repo, 'worktree', 'remove', '--force', path], { timeoutMs: LONG_MS })
}

// The change in `dir` since `base` (a commit or a ref naming one): the current snapshot tree, the
// binary patch from base to it, and the files the patch touches (old and new names of a rename
// both listed, since renames are not detected). The patch text is for reading; integrate applies
// the patch file itself, which keeps non-UTF-8 bytes exact and has no size limit.
export async function diffSince(io: Io, dir: string, base: string, tmpIndex: string): Promise<{ patch: string; tree: string; files: string[] }> {
  const patchPath = await scratchPath(io, dir, 'patch')
  try {
    const { tree, files } = await diffToFile(io, dir, base, tmpIndex, patchPath)
    const patch = files.length === 0 ? '' : await io.read(patchPath)
    return { patch, tree, files }
  } finally {
    await removeFile(io, patchPath)
  }
}

// diffSince with the patch written to `patchPath` (an absolute path; an empty file when nothing changed).
export async function diffToFile(io: Io, dir: string, base: string, tmpIndex: string, patchPath: string): Promise<{ tree: string; files: string[] }> {
  const tree = await snapshotTree(io, dir, tmpIndex)
  const baseCommit = (await git(io, ['-C', dir, 'rev-parse', '--verify', `${base}^{commit}`])).trim()
  // diff-tree is plumbing: diff.noprefix, diff.external, color.ui, textconv and diff.relative do not apply.
  const names = await git(io, ['-C', dir, 'diff-tree', '-r', '--no-renames', '--name-only', '-z', baseCommit, tree])
  const files = names.split('\0').filter(name => name !== '')
  await git(io, ['-C', dir, 'diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', `--output=${patchPath}`, baseCommit, tree], { timeoutMs: LONG_MS })
  return { tree, files }
}

// The label of a plugin base ref: <taskId> or <taskId>/<agentId>.
export function refLabel(ref: string): string {
  const m = /^refs\/magpie-tasks\/(.+)\/base$/.exec(ref)
  if (!m) throw new Error(`not a magpie-tasks base ref: ${ref}`)
  return m[1]!
}

async function hasHead(io: Io, dir: string): Promise<boolean> {
  const r = await gitRun(io, ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  if (r.exitCode === 0) return true
  if (r.exitCode === 1 && r.stderr.trim() === '') return false
  throw new Error(`git -C ${dir} rev-parse --verify HEAD exited ${r.exitCode}: ${firstLines(r.stderr)}`)
}

async function removeFile(io: Io, path: string): Promise<void> {
  const r = await io.run(['rm', '-f', path])
  if (r.exitCode !== 0) throw new Error(`rm -f ${path} exited ${r.exitCode}: ${firstLines(r.stderr)}`)
}

function firstLines(text: string): string {
  return text.trim().split('\n').slice(0, 5).join(' | ')
}
