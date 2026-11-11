// git.ts and integrate.ts against real repositories in temporary directories (plan section 12.1,
// git and integrate row).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseRefName, createWorktree, diffSince, initRepo, projectStats, removeWorktree, repoRoot, scratchPath } from '../src/git'
import { integrate } from '../src/integrate'
import { Registry } from '../src/registry'
import type { Options, TaskRecord } from '../src/types'
import { nodeIo } from './node-io'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mt-git-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function options(stateDir: string, worktreeDir: string): Options {
  return {
    gatewayUrl: 'http://127.0.0.1:3425',
    stateDir,
    worktreeDir,
    jevUrl: 'https://api.openai.com/v1/decisions',
    jevModel: 'gpt-6-luna',
    jevKeyFile: join(process.env.HOME!, '.config/jev-opus/openai-jev.key'),
    jevDeadlineMs: 10_000,
    evaluatorModel: 'claude/claude-opus-5-5',
    launcher: 'claude-magpie',
    claudeBin: 'claude',
    telegramStateDir: join(process.env.HOME!, '.claude/channels/telegram-live'),
    telegramChatId: '',
    timezone: 'Asia/Shanghai',
    ratingHour: 21,
  }
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
}

// A fresh scenario: a project directory, a state directory with a registry, a worktree directory
// outside the project, and a long task whose project root is the project.
async function scenario(name: string) {
  const dir = join(root, name)
  const project = join(dir, 'proj')
  mkdirSync(project, { recursive: true })
  const opts = options(join(dir, 'state'), join(dir, 'wt'))
  const io = nodeIo()
  const reg = new Registry(io, opts, `test-${name}`)
  const taskId = `l-20261109-${name.replace(/[^a-z0-9]/g, '').slice(0, 6).padEnd(6, '0')}`
  const task = async (projectRoot: string) => reg.create(longTask(taskId, projectRoot))
  return { dir, project, opts, io, reg, taskId, task, wt: join(opts.worktreeDir, taskId) }
}

function longTask(id: string, projectRoot: string): Omit<TaskRecord, 'schema' | 'createdAt' | 'updatedAt'> {
  return {
    id,
    kind: 'long',
    title: '把 greet.py 的 hello 改成 hi',
    state: 'running',
    pausedByUser: false,
    request: '把 greet.py 的 hello 改成 hi',
    followUps: [],
    project: { root: projectRoot, gitInitByPlugin: false },
    worktree: null,
    extraWorktrees: {},
    owner: { kind: 'session', sessionId: `s-${id}`, previousSessionIds: [], model: 'claude/claude-opus-5-5', contextMemoryFingerprint: 'absent' },
    telegram: null,
    agents: {},
    blockers: {},
    decisions: {},
    deliverables: [],
    feedback: [],
    ratings: [],
    pendingRelays: {},
  }
}

function logEntries(stateDir: string, taskId: string): { type: string; [k: string]: unknown }[] {
  return readFileSync(join(stateDir, 'tasks', `${taskId}.log.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

// What a snapshot must leave alone in the user's repository.
function userState(project: string) {
  return {
    index: sh(project, 'ls-files', '-s'),
    status: sh(project, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    head: sh(project, 'rev-parse', 'HEAD'),
    branches: sh(project, 'for-each-ref', 'refs/heads'),
  }
}

// A repository with one commit, then uncommitted work: a modified tracked file, a staged new file,
// an untracked file and an ignored file.
function committedRepo(project: string) {
  sh(project, 'init', '-q')
  writeFileSync(join(project, 'greet.py'), 'print("hello")\n')
  writeFileSync(join(project, 'README.md'), '# proj\n')
  writeFileSync(join(project, '.gitignore'), 'node_modules/\n')
  sh(project, 'add', '-A')
  sh(project, 'commit', '-qm', 'init')
  writeFileSync(join(project, 'README.md'), '# proj\n\nuser note\n')
  writeFileSync(join(project, 'staged.txt'), 'staged by the user\n')
  sh(project, 'add', 'staged.txt')
  writeFileSync(join(project, 'untracked.txt'), 'not added\n')
  mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(project, 'node_modules', 'dep', 'index.js'), 'ignored\n')
}

test('repoRoot: the top of the repository from a subdirectory, null outside any repository', async () => {
  const s = await scenario('root')
  committedRepo(s.project)
  mkdirSync(join(s.project, 'sub'))
  expect(await repoRoot(s.io, join(s.project, 'sub'))).toBe(s.project)
  expect(await repoRoot(s.io, s.project)).toBe(s.project)
  const plain = join(s.dir, 'plain')
  mkdirSync(plain)
  expect(await repoRoot(s.io, plain)).toBeNull()
  await expect(repoRoot(s.io, join(s.dir, 'missing'))).rejects.toThrow('does not exist')
})

test('createWorktree: uncommitted and untracked files enter the worktree; the user index, HEAD and branches stay', async () => {
  const s = await scenario('create')
  committedRepo(s.project)
  const before = userState(s.project)
  const ref = baseRefName(s.taskId)
  const r = await createWorktree(s.io, s.project, s.wt, ref, s.project)
  expect(userState(s.project)).toEqual(before)
  expect(r.baseRef).toBe(`refs/magpie-tasks/${s.taskId}/base`)
  expect(sh(s.project, 'rev-parse', ref).trim()).toBe(r.baseCommit)
  expect(sh(s.project, 'log', '-1', '--format=%P%n%s', r.baseCommit)).toBe(`${before.head.trim()}\nmagpie-tasks base ${s.taskId}\n`)
  // The worktree holds the user's working tree, not HEAD.
  expect(readFileSync(join(s.wt, 'README.md'), 'utf8')).toBe('# proj\n\nuser note\n')
  expect(readFileSync(join(s.wt, 'staged.txt'), 'utf8')).toBe('staged by the user\n')
  expect(readFileSync(join(s.wt, 'untracked.txt'), 'utf8')).toBe('not added\n')
  expect(existsSync(join(s.wt, 'node_modules'))).toBe(false)
  // Checked out detached at the base, with nothing to report against it.
  expect(sh(s.wt, 'rev-parse', 'HEAD').trim()).toBe(r.baseCommit)
  expect(sh(s.wt, 'status', '--porcelain=v1', '-z', '--untracked-files=all')).toBe('')
  // No scratch files are left in the git directory.
  expect(sh(s.project, 'rev-parse', '--absolute-git-dir').trim()).toBe(join(s.project, '.git'))
  expect(execFileSync('ls', [join(s.project, '.git')], { encoding: 'utf8' })).not.toContain('magpie-tasks.')
  // The same ref cannot be made twice.
  await expect(createWorktree(s.io, s.project, join(s.opts.worktreeDir, 'again'), ref, s.project)).rejects.toThrow()
})

test('integrate: only the task change is applied, the user change stays; a second integration applies only what is new', async () => {
  const s = await scenario('twice')
  committedRepo(s.project)
  await s.task(s.project)
  const ref = baseRefName(s.taskId)
  const { baseCommit } = await createWorktree(s.io, s.project, s.wt, ref, s.project)
  // The task's change, and an accepted deliverable as report_outcome records it.
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  await s.reg.update(s.taskId, t => { t.deliverables.push({ at: Date.now(), summary: 'hello → hi', verification: ['python3 greet.py'] }) }, { type: 'report', outcome: 'accepted' })
  // The user keeps working in the main directory meanwhile.
  writeFileSync(join(s.project, 'untracked.txt'), 'not added, edited again\n')
  const index = sh(s.project, 'ls-files', '-s')
  const commits = sh(s.project, 'rev-list', '--count', 'HEAD')

  const first = await integrate(s.io, s.reg, { taskId: s.taskId, repo: s.project, source: s.wt, target: s.project, baseRef: ref })
  if (first.status !== 'applied') throw new Error(`expected applied, got ${JSON.stringify(first)}`)
  expect(first.files).toEqual(['greet.py'])
  expect(readFileSync(join(s.project, 'greet.py'), 'utf8')).toBe('print("hi")\n')
  expect(readFileSync(join(s.project, 'README.md'), 'utf8')).toBe('# proj\n\nuser note\n')
  expect(readFileSync(join(s.project, 'untracked.txt'), 'utf8')).toBe('not added, edited again\n')
  expect(sh(s.project, 'ls-files', '-s')).toBe(index)
  expect(sh(s.project, 'rev-list', '--count', 'HEAD')).toBe(commits)
  expect(sh(s.project, 'rev-parse', ref).trim()).toBe(first.newBase)
  expect(sh(s.project, 'log', '-1', '--format=%P', first.newBase).trim()).toBe(baseCommit)

  // The user reworks the integrated file; the task then changes another file only.
  writeFileSync(join(s.project, 'greet.py'), 'print("hi there")\n')
  writeFileSync(join(s.wt, 'farewell.py'), 'print("bye")\n')
  const second = await integrate(s.io, s.reg, { taskId: s.taskId, repo: s.project, source: s.wt, target: s.project, baseRef: ref })
  if (second.status !== 'applied') throw new Error(`expected applied, got ${JSON.stringify(second)}`)
  expect(second.files).toEqual(['farewell.py'])
  expect(readFileSync(join(s.project, 'farewell.py'), 'utf8')).toBe('print("bye")\n')
  expect(readFileSync(join(s.project, 'greet.py'), 'utf8')).toBe('print("hi there")\n')

  const third = await integrate(s.io, s.reg, { taskId: s.taskId, repo: s.project, source: s.wt, target: s.project, baseRef: ref })
  expect(third).toEqual({ status: 'empty' })

  // Records: the accepted deliverable carries the first integration; the second, made with no new
  // deliverable, gets an entry of its own; the empty third is only logged. integration-start and
  // integration pair by tree.
  const t = (await s.reg.get(s.taskId))!
  expect(t.deliverables.map(d => [d.summary.startsWith('integration into') ? 'added' : d.summary, d.integration?.status, d.integration?.files])).toEqual([
    ['hello → hi', 'applied', ['greet.py']],
    ['added', 'applied', ['farewell.py']],
  ])
  const log = logEntries(s.opts.stateDir, s.taskId).filter(e => e.type.startsWith('integration'))
  expect(log.map(e => [e.type, e.status ?? null])).toEqual([
    ['integration-start', null], ['integration', 'applied'],
    ['integration-start', null], ['integration', 'applied'],
    ['integration', 'empty'],
  ])
  expect(log[0]!.tree).toBe(log[1]!.tree)
  expect(log[2]!.tree).toBe(log[3]!.tree)
  expect(log[0]!.tree).not.toBe(log[2]!.tree)
  expect(log[1]!.newBase).toBe(first.newBase)
})

test('integrate: a change that collides with the user change is a conflict and the main directory stays as it was', async () => {
  const s = await scenario('conflict')
  committedRepo(s.project)
  await s.task(s.project)
  const ref = baseRefName(s.taskId)
  const { baseCommit } = await createWorktree(s.io, s.project, s.wt, ref, s.project)
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  writeFileSync(join(s.wt, 'other.py'), 'print("other")\n')
  writeFileSync(join(s.project, 'greet.py'), 'print("hey")\n')
  const files = ['greet.py', 'README.md', 'staged.txt', 'untracked.txt']
  const bytes = Object.fromEntries(files.map(f => [f, readFileSync(join(s.project, f))]))
  const before = userState(s.project)

  const r = await integrate(s.io, s.reg, { taskId: s.taskId, repo: s.project, source: s.wt, target: s.project, baseRef: ref })
  if (r.status !== 'conflict') throw new Error(`expected conflict, got ${JSON.stringify(r)}`)
  expect(r.files).toEqual(['greet.py', 'other.py'])
  expect(r.detail).toContain('greet.py')
  for (const f of files) expect(readFileSync(join(s.project, f)).equals(bytes[f]!)).toBe(true)
  expect(existsSync(join(s.project, 'other.py'))).toBe(false)
  expect(userState(s.project)).toEqual(before)
  expect(sh(s.project, 'rev-parse', ref).trim()).toBe(baseCommit)
  const log = logEntries(s.opts.stateDir, s.taskId).filter(e => e.type.startsWith('integration'))
  expect(log.map(e => [e.type, e.status])).toEqual([['integration', 'conflict']])
  // No deliverable was reported, so the conflict is only logged.
  expect((await s.reg.get(s.taskId))!.deliverables).toEqual([])
})

test('integrate: after a conflict the accepted deliverable stays open, and a retry replaces its integration', async () => {
  const s = await scenario('retry')
  committedRepo(s.project)
  await s.task(s.project)
  const ref = baseRefName(s.taskId)
  await createWorktree(s.io, s.project, s.wt, ref, s.project)
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  await s.reg.update(s.taskId, t => { t.deliverables.push({ at: Date.now(), summary: 'hello → hi', verification: ['python3 greet.py'] }) }, { type: 'report', outcome: 'accepted' })
  const args = { taskId: s.taskId, repo: s.project, source: s.wt, target: s.project, baseRef: ref }
  const outcomes = async () => (await s.reg.get(s.taskId))!.deliverables.map(d => [d.summary, d.integration?.status, d.integration?.files])

  // The user edits the same file: a conflict, recorded on the accepted deliverable.
  writeFileSync(join(s.project, 'greet.py'), 'print("hey")\n')
  expect((await integrate(s.io, s.reg, args)).status).toBe('conflict')
  expect(await outcomes()).toEqual([['hello → hi', 'conflict', ['greet.py']]])
  // A retry before the user resolves it conflicts again and replaces the earlier conflict.
  expect((await integrate(s.io, s.reg, args)).status).toBe('conflict')
  expect(await outcomes()).toEqual([['hello → hi', 'conflict', ['greet.py']]])
  // The user restores the file; the retry applies onto the same deliverable.
  writeFileSync(join(s.project, 'greet.py'), 'print("hello")\n')
  expect((await integrate(s.io, s.reg, args)).status).toBe('applied')
  expect(readFileSync(join(s.project, 'greet.py'), 'utf8')).toBe('print("hi")\n')
  expect(await outcomes()).toEqual([['hello → hi', 'applied', ['greet.py']]])
  // Once applied, a later conflict is only logged.
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi!")\n')
  writeFileSync(join(s.project, 'greet.py'), 'print("yo")\n')
  expect((await integrate(s.io, s.reg, args)).status).toBe('conflict')
  expect(await outcomes()).toEqual([['hello → hi', 'applied', ['greet.py']]])
  const log = logEntries(s.opts.stateDir, s.taskId).filter(e => e.type.startsWith('integration'))
  expect(log.map(e => [e.type, e.status ?? null])).toEqual([
    ['integration', 'conflict'], ['integration', 'conflict'],
    ['integration-start', null], ['integration', 'applied'],
    ['integration', 'conflict'],
  ])
})

test('createWorktree: when worktree add fails the ref is removed, so a retry with the same name works', async () => {
  const s = await scenario('failadd')
  committedRepo(s.project)
  const ref = baseRefName(s.taskId)
  mkdirSync(s.opts.worktreeDir, { recursive: true })
  chmodSync(s.opts.worktreeDir, 0o500)
  try {
    await expect(createWorktree(s.io, s.project, s.wt, ref, s.project)).rejects.toThrow(/worktree add/)
  } finally {
    chmodSync(s.opts.worktreeDir, 0o700)
  }
  expect(sh(s.project, 'for-each-ref', 'refs/magpie-tasks')).toBe('')
  const r = await createWorktree(s.io, s.project, s.wt, ref, s.project)
  expect(sh(s.project, 'rev-parse', ref).trim()).toBe(r.baseCommit)
  expect(readFileSync(join(s.wt, 'greet.py'), 'utf8')).toBe('print("hello")\n')
})

test('initRepo in a directory that is not a repository: a baseline commit of every file, a clean status, then a worktree', async () => {
  const s = await scenario('init')
  writeFileSync(join(s.project, 'greet.py'), 'print("hello")\n')
  mkdirSync(join(s.project, 'data'))
  writeFileSync(join(s.project, 'data', 'notes.txt'), 'abc\n')
  expect(await repoRoot(s.io, s.project)).toBeNull()
  expect(await projectStats(s.io, s.project)).toEqual({ files: 2, bytes: 19 })
  await initRepo(s.io, s.project)
  expect(await repoRoot(s.io, s.project)).toBe(s.project)
  expect(sh(s.project, 'log', '--format=%s')).toBe('magpie-tasks baseline\n')
  expect(sh(s.project, 'ls-files')).toBe('data/notes.txt\ngreet.py\n')
  expect(sh(s.project, 'status', '--porcelain=v1', '-z', '--untracked-files=all')).toBe('')
  await expect(initRepo(s.io, s.project)).rejects.toThrow('already inside the repository')

  await s.task(s.project)
  const ref = baseRefName(s.taskId)
  await createWorktree(s.io, s.project, s.wt, ref, s.project)
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  const r = await integrate(s.io, s.reg, { taskId: s.taskId, repo: s.project, source: s.wt, target: s.project, baseRef: ref })
  expect(r.status).toBe('applied')
  expect(readFileSync(join(s.project, 'greet.py'), 'utf8')).toBe('print("hi")\n')
})

test('initRepo in an empty directory makes an empty baseline', async () => {
  const s = await scenario('initempty')
  expect(await projectStats(s.io, s.project)).toEqual({ files: 0, bytes: 0 })
  await initRepo(s.io, s.project)
  expect(sh(s.project, 'log', '--format=%s')).toBe('magpie-tasks baseline\n')
  expect(sh(s.project, 'ls-files')).toBe('')
})

test('a repository without commits: the base has no parent, and integration works', async () => {
  const s = await scenario('nohead')
  sh(s.project, 'init', '-q')
  writeFileSync(join(s.project, 'greet.py'), 'print("hello")\n')
  writeFileSync(join(s.project, 'a.txt'), 'a\n')
  sh(s.project, 'add', 'a.txt')
  const index = sh(s.project, 'ls-files', '-s')
  await s.task(s.project)
  const ref = baseRefName(s.taskId)
  const { baseCommit } = await createWorktree(s.io, s.project, s.wt, ref, s.project)
  expect(sh(s.project, 'log', '-1', '--format=%P', baseCommit).trim()).toBe('')
  expect(readFileSync(join(s.wt, 'greet.py'), 'utf8')).toBe('print("hello")\n')
  // Still no commit on the branch, and the staged file is still only staged.
  expect(() => sh(s.project, 'rev-parse', '--verify', '-q', 'HEAD')).toThrow()
  expect(sh(s.project, 'ls-files', '-s')).toBe(index)

  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  const r = await integrate(s.io, s.reg, { taskId: s.taskId, repo: s.project, source: s.wt, target: s.project, baseRef: ref })
  expect(r).toMatchObject({ status: 'applied', files: ['greet.py'] })
  expect(readFileSync(join(s.project, 'greet.py'), 'utf8')).toBe('print("hi")\n')
  expect(sh(s.project, 'ls-files', '-s')).toBe(index)
})

test('binary files and non-UTF-8 text arrive byte for byte', async () => {
  const s = await scenario('binary')
  committedRepo(s.project)
  // Binary content: the first 4 KiB of /bin/true (an ELF header with NUL bytes); and Latin-1 text.
  const elf = readFileSync('/bin/true').subarray(0, 4096)
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a])   // "café\nnaïve\n" in ISO-8859-1
  writeFileSync(join(s.project, 'blob.bin'), elf.subarray(0, 2048))
  sh(s.project, 'add', 'blob.bin')
  sh(s.project, 'commit', '-qm', 'blob')
  await s.task(s.project)
  const ref = baseRefName(s.taskId)
  await createWorktree(s.io, s.project, s.wt, ref, s.project)
  writeFileSync(join(s.wt, 'blob.bin'), elf)
  writeFileSync(join(s.wt, 'latin1.txt'), latin1)

  const d = await diffSince(s.io, s.wt, ref, await scratchPath(s.io, s.wt, 'index'))
  expect(d.files).toEqual(['blob.bin', 'latin1.txt'])
  expect(d.patch).toContain('GIT binary patch')
  expect(d.tree).toMatch(/^[0-9a-f]{40}$/)

  const r = await integrate(s.io, s.reg, { taskId: s.taskId, repo: s.project, source: s.wt, target: s.project, baseRef: ref })
  expect(r).toMatchObject({ status: 'applied', files: ['blob.bin', 'latin1.txt'] })
  expect(readFileSync(join(s.project, 'blob.bin')).equals(elf)).toBe(true)
  expect(readFileSync(join(s.project, 'latin1.txt')).equals(latin1)).toBe(true)
})

test('a separate copy made from the task worktree integrates into the task worktree, logged but not a deliverable', async () => {
  const s = await scenario('separate')
  committedRepo(s.project)
  await s.task(s.project)
  await createWorktree(s.io, s.project, s.wt, baseRefName(s.taskId), s.project)
  // Agent A's work in the shared task worktree, not yet integrated.
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  const copy = join(s.opts.worktreeDir, `${s.taskId}-agent-b`)
  const ref = baseRefName(s.taskId, 'agent-b')
  expect(ref).toBe(`refs/magpie-tasks/${s.taskId}/agent-b/base`)
  const { baseCommit } = await createWorktree(s.io, s.project, copy, ref, s.wt)
  expect(sh(s.project, 'log', '-1', '--format=%s', baseCommit)).toBe(`magpie-tasks base ${s.taskId}/agent-b\n`)
  expect(readFileSync(join(copy, 'greet.py'), 'utf8')).toBe('print("hi")\n')
  // Agent B works in its copy while A goes on in the task worktree.
  writeFileSync(join(copy, 'farewell.py'), 'print("bye")\n')
  writeFileSync(join(s.wt, 'README.md'), '# proj\n\nuser note\nby agent A\n')

  const r = await integrate(s.io, s.reg, { taskId: s.taskId, repo: s.project, source: copy, target: s.wt, baseRef: ref })
  expect(r).toMatchObject({ status: 'applied', files: ['farewell.py'] })
  expect(readFileSync(join(s.wt, 'farewell.py'), 'utf8')).toBe('print("bye")\n')
  expect(readFileSync(join(s.wt, 'README.md'), 'utf8')).toBe('# proj\n\nuser note\nby agent A\n')
  expect(existsSync(join(s.project, 'farewell.py'))).toBe(false)
  expect((await s.reg.get(s.taskId))!.deliverables).toEqual([])
  expect(logEntries(s.opts.stateDir, s.taskId).filter(e => e.type.startsWith('integration')).map(e => e.type)).toEqual(['integration-start', 'integration'])

  await removeWorktree(s.io, s.project, copy)
  expect(existsSync(copy)).toBe(false)
  expect(sh(s.project, 'worktree', 'list', '--porcelain')).not.toContain(copy)
  // A worktree whose directory is already gone is pruned.
  rmSync(s.wt, { recursive: true, force: true })
  await removeWorktree(s.io, s.project, s.wt)
  expect(sh(s.project, 'worktree', 'list', '--porcelain')).not.toContain(s.wt)
})
