// git.ts, integrate.ts and workspace.ts against real repositories in temporary directories (plan
// section 12.1, git and integrate row).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseRefName, createWorktree, diffSince, removeWorktree, removeWorktreeAndRef, repoRoot, scratchPath } from '../src/git'
import { reclaim } from '../src/reclaim'
import type { Ctx } from '../src/state'
import { integrate, integrateTask, settleDirect } from '../src/integrate'
import { Registry } from '../src/registry'
import type { Options, TaskRecord } from '../src/types'
import { leaveIfTaken, placeTask, workspacePaths, workspaces, writeRange } from '../src/workspace'
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
    project: { root: projectRoot },
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

// The task's worktree of its project, made directly and recorded as placeTask records it.
async function taskWorktree(s: Awaited<ReturnType<typeof scenario>>): Promise<{ baseCommit: string; baseRef: string }> {
  const made = await createWorktree(s.io, s.project, s.wt, baseRefName(s.taskId), s.project)
  await s.reg.update(s.taskId, t => { t.worktree = { path: s.wt, baseRef: made.baseRef, baseCommit: made.baseCommit } }, { type: 'worktree' })
  return made
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
  const { baseCommit } = await taskWorktree(s)
  // The task's change, and an accepted deliverable as report_outcome records it.
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  await s.reg.update(s.taskId, t => { t.deliverables.push({ at: Date.now(), summary: 'hello → hi', verification: ['python3 greet.py'] }) }, { type: 'report', outcome: 'accepted' })
  // The user keeps working in the main directory meanwhile.
  writeFileSync(join(s.project, 'untracked.txt'), 'not added, edited again\n')
  const index = sh(s.project, 'ls-files', '-s')
  const commits = sh(s.project, 'rev-list', '--count', 'HEAD')

  expect(await integrateTask(s.io, s.reg, s.taskId)).toEqual([{ root: s.project, status: 'applied', files: ['greet.py'] }])
  const newBase = sh(s.project, 'rev-parse', ref).trim()
  expect(readFileSync(join(s.project, 'greet.py'), 'utf8')).toBe('print("hi")\n')
  expect(readFileSync(join(s.project, 'README.md'), 'utf8')).toBe('# proj\n\nuser note\n')
  expect(readFileSync(join(s.project, 'untracked.txt'), 'utf8')).toBe('not added, edited again\n')
  expect(sh(s.project, 'ls-files', '-s')).toBe(index)
  expect(sh(s.project, 'rev-list', '--count', 'HEAD')).toBe(commits)
  expect(sh(s.project, 'log', '-1', '--format=%P', newBase).trim()).toBe(baseCommit)

  // The user reworks the integrated file; the task then changes another file only.
  writeFileSync(join(s.project, 'greet.py'), 'print("hi there")\n')
  writeFileSync(join(s.wt, 'farewell.py'), 'print("bye")\n')
  expect(await integrateTask(s.io, s.reg, s.taskId)).toEqual([{ root: s.project, status: 'applied', files: ['farewell.py'] }])
  expect(readFileSync(join(s.project, 'farewell.py'), 'utf8')).toBe('print("bye")\n')
  expect(readFileSync(join(s.project, 'greet.py'), 'utf8')).toBe('print("hi there")\n')

  expect(await integrateTask(s.io, s.reg, s.taskId)).toEqual([{ root: s.project, status: 'empty', files: [] }])

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
  expect(log[1]!.newBase).toBe(newBase)
})

test('integrate: a change that collides with the user change is a conflict and the main directory stays as it was', async () => {
  const s = await scenario('conflict')
  committedRepo(s.project)
  await s.task(s.project)
  const ref = baseRefName(s.taskId)
  const { baseCommit } = await taskWorktree(s)
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  writeFileSync(join(s.wt, 'other.py'), 'print("other")\n')
  writeFileSync(join(s.project, 'greet.py'), 'print("hey")\n')
  const files = ['greet.py', 'README.md', 'staged.txt', 'untracked.txt']
  const bytes = Object.fromEntries(files.map(f => [f, readFileSync(join(s.project, f))]))
  const before = userState(s.project)

  const [r] = await integrateTask(s.io, s.reg, s.taskId)
  expect(r).toMatchObject({ root: s.project, status: 'conflict', files: ['greet.py', 'other.py'], conflict: { source: s.wt, baseRef: ref } })
  expect(r!.conflict!.detail).toContain('greet.py')
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
  await taskWorktree(s)
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  await s.reg.update(s.taskId, t => { t.deliverables.push({ at: Date.now(), summary: 'hello → hi', verification: ['python3 greet.py'] }) }, { type: 'report', outcome: 'accepted' })
  const status = async () => (await integrateTask(s.io, s.reg, s.taskId)).map(o => o.status)
  const outcomes = async () => (await s.reg.get(s.taskId))!.deliverables.map(d => [d.summary, d.integration?.status, d.integration?.files])

  // The user edits the same file: a conflict, recorded on the accepted deliverable.
  writeFileSync(join(s.project, 'greet.py'), 'print("hey")\n')
  expect(await status()).toEqual(['conflict'])
  expect(await outcomes()).toEqual([['hello → hi', 'conflict', ['greet.py']]])
  // A retry before the user resolves it conflicts again and replaces the earlier conflict.
  expect(await status()).toEqual(['conflict'])
  expect(await outcomes()).toEqual([['hello → hi', 'conflict', ['greet.py']]])
  // The user restores the file; the retry applies onto the same deliverable.
  writeFileSync(join(s.project, 'greet.py'), 'print("hello")\n')
  expect(await status()).toEqual(['applied'])
  expect(readFileSync(join(s.project, 'greet.py'), 'utf8')).toBe('print("hi")\n')
  expect(await outcomes()).toEqual([['hello → hi', 'applied', ['greet.py']]])
  // Once applied, a later conflict is only logged.
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi!")\n')
  writeFileSync(join(s.project, 'greet.py'), 'print("yo")\n')
  expect(await status()).toEqual(['conflict'])
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

test('placeTask: the first live task on a project works in place, a second one gets a worktree; outside Git every task works in place', async () => {
  const s = await scenario('place')
  committedRepo(s.project)
  const before = userState(s.project)
  await s.task(s.project)
  const first = await placeTask(s.io, s.reg, s.opts, s.taskId, s.project)
  expect(first).toEqual({ mode: 'direct', path: s.project, git: true, others: [] })
  const a = (await s.reg.get(s.taskId))!
  expect(a.worktree).toBeNull()
  expect(a.direct!.dir).toBe(s.project)
  expect(sh(s.project, 'rev-parse', baseRefName(s.taskId)).trim()).toBe(a.direct!.baseCommit!)
  // The base holds the user's uncommitted and untracked files and leaves their repository alone.
  expect(sh(s.project, 'show', `${a.direct!.baseCommit}:README.md`)).toBe('# proj\n\nuser note\n')
  expect(sh(s.project, 'show', `${a.direct!.baseCommit}:untracked.txt`)).toBe('not added\n')
  expect(userState(s.project)).toEqual(before)
  await expect(placeTask(s.io, s.reg, s.opts, s.taskId, s.project)).rejects.toThrow(`already works on ${s.project}`)

  const second = 'l-20261112-second'
  await s.reg.create({ ...longTask(second, s.project), title: '第二个任务' })
  const placed = await placeTask(s.io, s.reg, s.opts, second, join(s.project))
  expect(placed).toEqual({ mode: 'worktree', path: join(s.opts.worktreeDir, second), git: true, others: [{ id: s.taskId, title: a.title }] })
  expect(readFileSync(join(placed.path, 'untracked.txt'), 'utf8')).toBe('not added\n')
  expect((await s.reg.get(second))!.direct).toBeNull()

  // Once the first task is done, the next task works in place again.
  await s.reg.update(s.taskId, t => { t.state = 'done' }, { type: 'state', state: 'done' })
  const third = 'l-20261112-thirdd'
  await s.reg.create(longTask(third, s.project))
  expect((await placeTask(s.io, s.reg, s.opts, third, s.project)).mode).toBe('direct')

  const plain = join(s.dir, 'plain')
  mkdirSync(plain)
  writeFileSync(join(plain, 'notes.txt'), 'abc\n')
  const p1 = 'l-20261112-plain1'
  const p2 = 'l-20261112-plain2'
  await s.reg.create(longTask(p1, plain))
  await s.reg.create(longTask(p2, plain))
  expect(await placeTask(s.io, s.reg, s.opts, p1, plain)).toEqual({ mode: 'direct', path: plain, git: false, others: [] })
  expect((await placeTask(s.io, s.reg, s.opts, p2, plain)).others.map(o => o.id)).toEqual([p1])
  expect((await s.reg.get(p2))!.direct).toEqual({ dir: plain, baseRef: null, baseCommit: null })
  expect(existsSync(join(plain, '.git'))).toBe(false)
})

test('settleDirect: the files changed since the base become the result in place, the base moves, and the other direct tasks are told', async () => {
  const s = await scenario('settle')
  committedRepo(s.project)
  await s.task(s.project)
  await placeTask(s.io, s.reg, s.opts, s.taskId, s.project)
  writeFileSync(join(s.project, 'greet.py'), 'print("hi")\n')
  await s.reg.update(s.taskId, t => { t.deliverables.push({ at: 1, summary: 'accepted', verification: [] }) }, { type: 'outcome' })
  const before = userState(s.project)
  expect(await integrateTask(s.io, s.reg, s.taskId)).toEqual([{ root: s.project, status: 'in-place', files: ['greet.py'] }])
  expect(userState(s.project)).toEqual(before)
  const a = (await s.reg.get(s.taskId))!
  expect(a.deliverables[0]!.integration).toMatchObject({ status: 'in-place', files: ['greet.py'] })
  expect(sh(s.project, 'rev-parse', baseRefName(s.taskId)).trim()).toBe(a.direct!.baseCommit!)
  expect(sh(s.project, 'show', `${a.direct!.baseCommit}:greet.py`)).toBe('print("hi")\n')
  expect(await settleDirect(s.io, s.reg, s.taskId, s.project)).toEqual({ status: 'empty' })

  // A task in a worktree integrates into the project: the direct task learns which files are not its own.
  const other = 'l-20261112-wtwtwt'
  await s.reg.create({ ...longTask(other, s.project), title: '改 README' })
  const placed = await placeTask(s.io, s.reg, s.opts, other, s.project)
  expect(placed.mode).toBe('worktree')
  writeFileSync(join(placed.path, 'README.md'), '# proj\n\nuser note\nmore\n')
  const r = await integrate(s.io, s.reg, { taskId: other, repo: s.project, source: placed.path, target: s.project, baseRef: baseRefName(other) })
  expect(r.status).toBe('applied')
  expect((await s.reg.get(s.taskId))!.alsoChanged).toMatchObject([{ taskId: other, title: '改 README', files: ['README.md'] }])
  // Its own next settle clears that note with the moved base.
  await settleDirect(s.io, s.reg, s.taskId, s.project)
  expect((await s.reg.get(s.taskId))!.alsoChanged).toEqual([])

  // Outside Git the result is the files the agents edited with the file tools.
  const plain = join(s.dir, 'plain')
  mkdirSync(plain)
  const p = 'l-20261112-plainx'
  await s.reg.create(longTask(p, plain))
  await placeTask(s.io, s.reg, s.opts, p, plain)
  await s.reg.update(p, t => {
    t.agents['a1'] = { agentId: 'a1', role: 'implementer', sessionId: 's', ruleId: null, rulesVersion: 'v', selection: { kind: 'rule', reason: 'r' }, judgment: null, model: 'claude/claude-opus-5-5', effort: 'high', efforts: [], contextSource: 'brief', cwd: plain, worktree: plain, state: 'idle', pendingRaises: [], filesTouched: [join(plain, 'a.txt'), '/tmp/elsewhere.txt'], reports: [], startedAt: 1 }
  }, { type: 'spawn' })
  expect(await settleDirect(s.io, s.reg, p, plain)).toEqual({ status: 'in-place', files: ['a.txt'] })
  expect((await s.reg.get(p))!.agents['a1']!.filesTouched).toEqual(['/tmp/elsewhere.txt'])
  expect(await settleDirect(s.io, s.reg, p, plain)).toEqual({ status: 'empty' })
})

test('leaveIfTaken: an ended direct task that resumes while another task works in place moves to a worktree of the project as it is now', async () => {
  const s = await scenario('leave')
  committedRepo(s.project)
  await s.task(s.project)
  await placeTask(s.io, s.reg, s.opts, s.taskId, s.project)
  // Still live, or ended with nobody else in place: it stays.
  expect(await leaveIfTaken(s.io, s.reg, s.opts, s.taskId, s.project)).toBeNull()
  await s.reg.update(s.taskId, t => { t.state = 'done' }, { type: 'state', state: 'done' })
  expect(await leaveIfTaken(s.io, s.reg, s.opts, s.taskId, s.project)).toBeNull()

  const next = 'l-20261112-nextnx'
  await s.reg.create({ ...longTask(next, s.project), title: '下一个任务' })
  expect((await placeTask(s.io, s.reg, s.opts, next, s.project)).mode).toBe('direct')
  writeFileSync(join(s.project, 'greet.py'), 'print("next")\n')
  await s.reg.update(s.taskId, t => {
    t.agents['x1'] = { agentId: 'x1', role: 'executor', sessionId: 's', ruleId: null, rulesVersion: 'v', selection: { kind: 'rule', reason: 'r' }, judgment: null, model: 'claude/claude-opus-5-5', effort: 'high', efforts: [], contextSource: 'brief', cwd: s.project, worktree: s.project, state: 'running', pendingRaises: [], filesTouched: [], reports: [], startedAt: 1 }
  }, { type: 'spawn' })
  const moved = await leaveIfTaken(s.io, s.reg, s.opts, s.taskId, s.project)
  expect(moved).toEqual({ path: s.wt, others: [{ id: next, title: '下一个任务' }] })
  const a = (await s.reg.get(s.taskId))!
  expect(a.direct).toBeNull()
  expect(a.worktree!.path).toBe(s.wt)
  expect(a.agents['x1']).toMatchObject({ worktree: s.wt, cwd: s.wt })
  expect(readFileSync(join(s.wt, 'greet.py'), 'utf8')).toBe('print("next")\n')
  expect(sh(s.project, 'rev-parse', baseRefName(s.taskId)).trim()).toBe(a.worktree!.baseCommit)
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

test('removeWorktreeAndRef: the worktree and its moved base ref go, the user state stays, and the same path and ref can be made again', async () => {
  const s = await scenario('again')
  committedRepo(s.project)
  await s.task(s.project)
  const ref = baseRefName(s.taskId)
  const made = await createWorktree(s.io, s.project, s.wt, ref, s.project)
  await s.reg.update(s.taskId, t => { t.worktree = { path: s.wt, baseRef: ref, baseCommit: made.baseCommit } }, { type: 'worktree' })
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  const r = await integrate(s.io, s.reg, { taskId: s.taskId, repo: s.project, source: s.wt, target: s.project, baseRef: ref })
  expect(r.status).toBe('applied')
  expect(sh(s.project, 'rev-parse', ref).trim()).not.toBe(made.baseCommit)
  const before = userState(s.project)
  await removeWorktreeAndRef(s.io, s.project, s.wt, ref)
  expect(existsSync(s.wt)).toBe(false)
  expect(sh(s.project, 'worktree', 'list', '--porcelain')).not.toContain(s.wt)
  expect(sh(s.project, 'for-each-ref', 'refs/magpie-tasks')).toBe('')
  expect(userState(s.project)).toEqual(before)
  // The person changes the project; a new worktree at the same path holds the project as it is now.
  writeFileSync(join(s.project, 'README.md'), '# proj\n\nlater note\n')
  const again = await createWorktree(s.io, s.project, s.wt, ref, s.project)
  expect(readFileSync(join(s.wt, 'README.md'), 'utf8')).toBe('# proj\n\nlater note\n')
  expect(readFileSync(join(s.wt, 'greet.py'), 'utf8')).toBe('print("hi")\n')
  expect(sh(s.project, 'rev-parse', ref).trim()).toBe(again.baseCommit)
  await expect(removeWorktreeAndRef(s.io, s.project, s.wt, 'refs/heads/main')).rejects.toThrow('not a magpie-tasks base ref')
})

test('reclaim: a done daily task loses its worktree and base ref, a running one keeps them', async () => {
  const s = await scenario('sweep')
  committedRepo(s.project)
  const ctx = { io: s.io, reg: s.reg, opts: s.opts } as unknown as Ctx
  const daily = async (id: string, state: TaskRecord['state']) => {
    const path = join(s.opts.worktreeDir, id)
    const made = await createWorktree(s.io, s.project, path, baseRefName(id), s.project)
    await s.reg.create({
      ...longTask(id, s.project), kind: 'daily', state,
      worktree: { path, baseRef: made.baseRef, baseCommit: made.baseCommit },
      owner: { kind: 'agent', agentId: `a-${id}`, workerName: `tui-${id}`, routerSessionId: 'router' },
    })
    return path
  }
  const done = await daily('d-20261111-donexx', 'done')
  const running = await daily('d-20261111-runxxx', 'running')
  const out = await reclaim(ctx)
  expect(out).toEqual({ worktrees: ['d-20261111-donexx'], architects: [] })
  expect(existsSync(done)).toBe(false)
  expect(existsSync(running)).toBe(true)
  expect((await s.reg.get('d-20261111-donexx'))!.worktree).toBeNull()
  expect(sh(s.project, 'for-each-ref', '--format=%(refname)', 'refs/magpie-tasks')).toBe('refs/magpie-tasks/d-20261111-runxxx/base\n')
  expect(logEntries(s.opts.stateDir, 'd-20261111-donexx').at(-1)).toMatchObject({ type: 'worktree-removed', paths: [done] })
  // A second sweep finds nothing left to do.
  expect(await reclaim(ctx)).toEqual({ worktrees: [], architects: [] })
})
