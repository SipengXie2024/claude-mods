// One task that changes several projects, against real repositories and the real registry: the
// executor opens each project with open_project (daily.ts onOpenProject), each is placed on its own
// (in place, in a worktree, outside Git), the write gate lets the executor into each working
// directory, the change is taken per project and integrated per project, and the task's worktrees
// go when it is done while its projects stay on the record.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outcomeNote } from '../src/brief'
import { changesOf, onOpenProject } from '../src/daily'
import { placeWith, repoOfWith, subagentWriteDeny } from '../src/gate'
import { integrateTask } from '../src/integrate'
import { reclaim } from '../src/reclaim'
import { Registry } from '../src/registry'
import { worktreeGoneNote } from '../src/router'
import { freshState, type Ctx } from '../src/state'
import type { AgentRecord, Options, TaskRecord } from '../src/types'
import { baseRefOf, placeTask, workspacePaths, workspaces, worktreePath, writeRange } from '../src/workspace'
import { nodeIo } from './node-io'

let root = ''
beforeAll(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-projects-'))) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const TASK = 'd-20261112-severl'
const HOLDER = 'd-20261112-holder'
const EXECUTOR = 'a1c8f3130ed6ea155'
const REVIEWER = 'a9bfebde6931a9eb2'

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
}

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  sh(dir, 'init', '-q')
  writeFileSync(join(dir, 'greet.py'), 'print("hello")\n')
  writeFileSync(join(dir, 'README.md'), `# ${dir.split('/').pop()}\n`)
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-qm', 'init')
  return dir
}

function agent(agentId: string, role: AgentRecord['role']): AgentRecord {
  return { agentId, role, sessionId: 'router-session', ruleId: null, rulesVersion: 'v', selection: { kind: 'rule', reason: 'r' }, judgment: null, model: 'claude/claude-opus-5-5', effort: 'high', efforts: [], contextSource: 'brief', cwd: root, worktree: null, state: 'running', pendingRaises: [], filesTouched: [], reports: [], startedAt: 1 }
}

function daily(id: string, title: string, agents: AgentRecord[]): Omit<TaskRecord, 'schema' | 'createdAt' | 'updatedAt'> {
  return {
    id, kind: 'daily', title, state: 'running', pausedByUser: false, request: title, followUps: [],
    project: null, worktree: null, extraWorktrees: {},
    owner: { kind: 'agent', agentId: agents[0]!.agentId, workerName: `tui-${id}`, routerSessionId: 'router-session' },
    telegram: null, agents: Object.fromEntries(agents.map(a => [a.agentId, a])), blockers: {}, decisions: {}, deliverables: [], feedback: [], ratings: [], pendingRelays: {},
  }
}

async function scenario(name: string) {
  const dir = join(root, name)
  const opts: Options = {
    gatewayUrl: 'http://127.0.0.1:3425', stateDir: join(dir, 'state'), worktreeDir: join(dir, 'wt'),
    jevUrl: 'https://api.openai.com/v1/decisions', jevModel: 'gpt-6-luna', jevKeyFile: join(dir, 'no-key'), jevDeadlineMs: 10_000,
    evaluatorModel: 'claude/claude-opus-5-5', launcher: 'claude-magpie', claudeBin: 'claude',
    telegramStateDir: join(dir, 'telegram'), telegramChatId: '', telegramAfterMinutes: 10, timezone: 'Asia/Shanghai', ratingHour: 21,
  }
  const io = nodeIo()
  const reg = new Registry(io, opts, 'router-session')
  const st = freshState()
  st.role = 'router'
  st.sessionId = 'router-session'
  const ctx = { io, opts, reg, st } as unknown as Ctx
  // Three projects: `mods` is changed in place by another live task, `site` is free, `notes` is not a repository.
  const mods = repo(join(dir, 'mods'))
  const site = repo(join(dir, 'site'))
  const notes = join(dir, 'notes')
  mkdirSync(notes)
  writeFileSync(join(notes, 'todo.md'), '- one\n')
  await reg.create(daily(HOLDER, '另一个任务', [agent('a000000000000000f', 'executor')]))
  await placeTask(io, reg, opts, HOLDER, mods)
  await reg.create(daily(TASK, '三个项目都把 hello 改成 hi', [agent(EXECUTOR, 'executor'), agent(REVIEWER, 'acceptance')]))
  st.agents.set(EXECUTOR, TASK)
  st.agents.set(REVIEWER, TASK)
  const open = (agentId: string, project: string) => onOpenProject(ctx, agentId, { project })
  const task = async () => (await reg.get(TASK))!
  const gate = async (agentId: string, path: string) => {
    const t = await task()
    return subagentWriteDeny({ tool: 'Edit', file_path: path }, { ...writeRange(t, t.agents[agentId]!), place: placeWith(p => io.realPath(p), dir), repoOf: repoOfWith(io) })
  }
  return { dir, opts, io, reg, ctx, mods, site, notes, open, task, gate, wt: join(opts.worktreeDir, TASK) }
}

test('one task opens three projects: a worktree, a project directory in place and a directory outside Git', async () => {
  const s = await scenario('open')
  // Before any project is open, a write into a repository asks for open_project.
  expect(await s.gate(EXECUTOR, join(s.site, 'greet.py'))).toContain(`"project": "${s.site}"`)

  const first = await s.open(EXECUTOR, s.mods)
  expect(first).toContain(`Task worktree: ${s.wt}.`)
  expect(first).toContain('「另一个任务」')
  expect(first).not.toContain('This task also changes')
  // A second and a third project of the same task, each named from a subdirectory or its top.
  mkdirSync(join(s.site, 'pages'))
  const second = await s.open(EXECUTOR, join(s.site, 'pages'))
  expect(second).toContain(`Work directly in the project directory ${s.site}/pages`)
  expect(second).toContain(`This task also changes \`${s.wt}\``)
  const third = await s.open(EXECUTOR, s.notes)
  expect(third).toContain('It is not a Git repository')
  expect(third).toContain(`This task also changes \`${s.wt}\`, \`${s.site}\``)

  const t = await s.task()
  expect(t.project).toEqual({ root: s.mods })
  expect(t.worktree).toMatchObject({ path: s.wt, baseRef: `refs/magpie-tasks/${TASK}/base` })
  expect(t.more).toMatchObject([
    { project: { root: s.site }, worktree: null, direct: { dir: s.site, baseRef: `refs/magpie-tasks/${TASK}/p2/base` } },
    { project: { root: s.notes }, worktree: null, direct: { dir: s.notes, baseRef: null, baseCommit: null } },
  ])
  expect(sh(s.site, 'rev-parse', `refs/magpie-tasks/${TASK}/p2/base`).trim()).toBe(t.more![0]!.direct!.baseCommit!)
  expect(workspacePaths(t)).toEqual([s.wt, s.site, s.notes])
  // The first project the executor opened is its working directory; it writes in all three.
  expect(t.agents[EXECUTOR]).toMatchObject({ worktree: s.wt, cwd: s.wt })
  expect(writeRange(t, t.agents[EXECUTOR]!)).toEqual({ dirs: [s.wt, s.site, s.notes], copies: { [s.mods]: s.wt } })
  expect(await s.gate(EXECUTOR, join(s.wt, 'greet.py'))).toBeNull()
  expect(await s.gate(EXECUTOR, join(s.site, 'greet.py'))).toBeNull()
  expect(await s.gate(EXECUTOR, join(s.site, 'CONTEXT.md'))).toContain('architect writes')
  // The main directory of the project it changes in a worktree stays closed, and so does a repository it has not opened.
  expect(await s.gate(EXECUTOR, join(s.mods, 'greet.py'))).toContain(`Write only inside your working directory ${s.wt}`)
  const fourth = repo(join(s.dir, 'fourth'))
  expect(await s.gate(EXECUTOR, join(fourth, 'greet.py'))).toContain(`"project": "${fourth}"`)

  // Opening a project again, by its main directory or from inside its worktree, answers the same directory.
  expect(await s.open(EXECUTOR, s.mods)).toContain(`Task worktree: ${s.wt}.`)
  expect(await s.open(EXECUTOR, join(s.wt))).toContain(`Task worktree: ${s.wt}.`)
  expect(await s.open(EXECUTOR, s.site)).toContain(`Work directly in the project directory ${s.site}:`)
  expect((await s.task()).more!.length).toBe(2)
  // An agent that only checks gets the task's directories and opens no project of its own.
  expect(await s.open(REVIEWER, s.site)).toContain(`Work directly in the project directory ${s.site}:`)
  expect((await s.task()).agents[REVIEWER]!.worktree).toBe(s.site)
  await expect(s.open(REVIEWER, fourth)).rejects.toThrow('you open no project')
  expect((await s.task()).more!.length).toBe(2)
})

test('the change is taken and integrated project by project; a conflict in one leaves the others applied and a retry completes the record', async () => {
  const s = await scenario('integrate')
  for (const p of [s.mods, s.site, s.notes]) await s.open(EXECUTOR, p)
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi")\n')
  writeFileSync(join(s.site, 'greet.py'), 'print("hi")\n')
  writeFileSync(join(s.notes, 'todo.md'), '- one\n- two\n')
  await s.reg.update(TASK, t => {
    t.agents[EXECUTOR]!.filesTouched = [join(s.wt, 'greet.py'), join(s.site, 'greet.py'), join(s.notes, 'todo.md')]
    t.deliverables.push({ at: 1, summary: '三处都改了', verification: [] })
  }, { type: 'report' })

  const changes = await changesOf(s.ctx, await s.task())
  expect(changes.map(c => [c.path, c.direct, c.patchPath, c.files])).toEqual([
    [s.wt, false, join(s.opts.stateDir, 'tasks', `${TASK}.patch`), ['greet.py']],
    [s.site, true, join(s.opts.stateDir, 'tasks', `${TASK}.p2.patch`), ['greet.py']],
    [s.notes, true, null, ['todo.md']],
  ])
  expect(readFileSync(changes[1]!.patchPath!, 'utf8')).toContain('+print("hi")')

  expect(await integrateTask(s.io, s.reg, TASK)).toEqual([
    { root: s.mods, status: 'applied', files: ['greet.py'] },
    { root: s.site, status: 'in-place', files: ['greet.py'] },
    { root: s.notes, status: 'in-place', files: ['todo.md'] },
  ])
  expect(readFileSync(join(s.mods, 'greet.py'), 'utf8')).toBe('print("hi")\n')
  let t = await s.task()
  expect(t.deliverables[0]!.integration).toMatchObject({
    status: 'applied',
    files: [`${s.mods}/greet.py`, `${s.site}/greet.py`, `${s.notes}/todo.md`],
    parts: [{ root: s.mods, status: 'applied' }, { root: s.site, status: 'in-place' }, { root: s.notes, status: 'in-place' }],
  })
  expect(outcomeNote(t)!.text).toContain(`its change stays where you made it in ${s.site} (greet.py); ${s.notes} (todo.md), and its change was applied to ${s.mods} (greet.py)`)
  // The task that changes the first project in place learns which files there are not its own.
  expect((await s.reg.get(HOLDER))!.alsoChanged).toMatchObject([{ taskId: TASK, files: ['greet.py'] }])
  expect(await changesOf(s.ctx, t)).toEqual([])

  // A second result: the first project's main directory was changed meanwhile, the second project gets a new file.
  writeFileSync(join(s.wt, 'greet.py'), 'print("hi!")\n')
  writeFileSync(join(s.mods, 'greet.py'), 'print("yo")\n')
  writeFileSync(join(s.site, 'NOTES.md'), 'new\n')
  await s.reg.update(TASK, x => { x.deliverables.push({ at: 2, summary: '第二轮', verification: [] }) }, { type: 'report' })
  const round = await integrateTask(s.io, s.reg, TASK)
  expect(round.map(o => [o.root, o.status, o.files])).toEqual([[s.mods, 'conflict', ['greet.py']], [s.site, 'in-place', ['NOTES.md']], [s.notes, 'empty', []]])
  expect(round[0]!.conflict).toMatchObject({ source: s.wt, baseRef: `refs/magpie-tasks/${TASK}/base` })
  expect(readFileSync(join(s.mods, 'greet.py'), 'utf8')).toBe('print("yo")\n')
  t = await s.task()
  expect(t.deliverables[1]!.integration).toMatchObject({ status: 'conflict', files: [`${s.mods}/greet.py`, `${s.site}/NOTES.md`] })
  expect(outcomeNote(t)).toMatchObject({ key: 'conflict' })
  expect(outcomeNote(t)!.text).toContain(`could not be applied to ${s.mods} (greet.py)`)
  // The person restores the file; the retry applies the first project and keeps what the second already got.
  writeFileSync(join(s.mods, 'greet.py'), 'print("hi")\n')
  expect((await integrateTask(s.io, s.reg, TASK)).map(o => o.status)).toEqual(['applied', 'empty', 'empty'])
  expect(readFileSync(join(s.mods, 'greet.py'), 'utf8')).toBe('print("hi!")\n')
  t = await s.task()
  expect(t.deliverables.length).toBe(2)
  expect(t.deliverables[1]!.integration).toMatchObject({
    status: 'applied',
    parts: [{ root: s.mods, status: 'applied', files: ['greet.py'] }, { root: s.site, status: 'in-place', files: ['NOTES.md'] }, { root: s.notes, status: 'empty', files: [] }],
  })
})

test('a done task loses its worktrees and keeps its projects; a project is opened again before the task changes it', async () => {
  const s = await scenario('reclaim')
  // A linked worktree of the first project, which the person keeps beside it: the same ref store.
  const linked = join(s.dir, 'mods-linked')
  sh(s.mods, 'worktree', 'add', '-q', '--detach', linked)
  for (const p of [s.mods, s.site, linked]) await s.open(EXECUTOR, p)
  let t = await s.task()
  expect(workspacePaths(t)).toEqual([s.wt, s.site, linked])
  expect(sh(s.mods, 'for-each-ref', '--format=%(refname)', `refs/magpie-tasks/${TASK}`).trim().split('\n')).toEqual([`refs/magpie-tasks/${TASK}/base`, `refs/magpie-tasks/${TASK}/p3/base`])
  expect(worktreeGoneNote(t)).toBeNull()

  await s.reg.update(TASK, x => { x.state = 'done'; for (const a of Object.values(x.agents)) a.state = 'idle' }, { type: 'state', state: 'done' })
  expect(await reclaim(s.ctx)).toEqual({ worktrees: [TASK], architects: [] })
  expect(existsSync(s.wt)).toBe(false)
  t = await s.task()
  expect(t.project).toEqual({ root: s.mods })
  expect(t.worktree).toBeNull()
  expect(workspacePaths(t)).toEqual([s.site, linked])
  expect(worktreeGoneNote(t)).toContain(`If this message asks for changes to ${s.mods}, call mcp__magpie-tasks__open_project again first`)
  // The executor goes on in the projects the task changes in place, and opens the first project again before changing it.
  expect(t.agents[EXECUTOR]).toMatchObject({ worktree: s.site, cwd: s.site })
  expect(await s.gate(EXECUTOR, join(s.site, 'greet.py'))).toBeNull()
  expect(await s.gate(EXECUTOR, join(s.mods, 'greet.py'))).toContain(`"project": "${s.mods}"`)
  expect(await s.open(EXECUTOR, s.mods)).toContain(`Task worktree: ${s.wt}.`)
  t = await s.task()
  expect(workspacePaths(t)).toEqual([s.wt, s.site, linked])
  expect(t.more!.length).toBe(2)
  expect(await s.gate(EXECUTOR, join(s.wt, 'greet.py'))).toBeNull()
  expect(await s.gate(EXECUTOR, join(s.mods, 'greet.py'))).toContain(`Write only inside your working directory ${s.wt}`)
})

// Every project on the record holds what placeTask gives the project of its number: the working
// directory, the base ref and, in Git, the base commit that ref names in the project's repository.
function expectConsistent(t: TaskRecord, opts: Options): void {
  for (const [i, w] of workspaces(t).entries()) {
    const root = w.project.root
    if (w.worktree !== null) {
      expect(w.worktree).toMatchObject({ path: worktreePath(opts, t.id, i + 1), baseRef: baseRefOf(t.id, i + 1) })
      expect(sh(root, 'rev-parse', w.worktree.baseRef).trim()).toBe(w.worktree.baseCommit)
    } else {
      expect(w.direct!.dir).toBe(root)
      if (w.direct!.baseRef === null) continue
      expect(w.direct!.baseRef).toBe(baseRefOf(t.id, i + 1))
      expect(sh(root, 'rev-parse', w.direct!.baseRef).trim()).toBe(w.direct!.baseCommit!)
    }
  }
}

test('projects opened side by side each get an entry of their own', async () => {
  const s = await scenario('parallel')
  await s.open(EXECUTOR, s.mods)
  const fourth = repo(join(s.dir, 'fourth'))
  // Two new projects at once, one of them named twice.
  const answers = await Promise.all([s.open(EXECUTOR, s.site), s.open(EXECUTOR, fourth), s.open(EXECUTOR, fourth)])
  expect(answers[0]).toContain(`Work directly in the project directory ${s.site}:`)
  for (const a of answers.slice(1)) expect(a).toContain(`Work directly in the project directory ${fourth}:`)
  let t = await s.task()
  expect(workspaces(t).map(w => w.project.root).sort()).toEqual([s.mods, s.site, fourth].sort())
  expectConsistent(t, s.opts)
  expect(writeRange(t, t.agents[EXECUTOR]!).dirs.sort()).toEqual([s.wt, s.site, fourth].sort())
  expect(await s.gate(EXECUTOR, join(s.site, 'greet.py'))).toBeNull()
  expect(await s.gate(EXECUTOR, join(fourth, 'greet.py'))).toBeNull()

  // A task's first projects opened at once: one of them is its first project, and the executor's working directory is one of the three.
  const f = await scenario('first')
  await Promise.all([f.open(EXECUTOR, f.site), f.open(EXECUTOR, f.mods), f.open(EXECUTOR, f.notes)])
  t = await f.task()
  expect(workspaces(t).map(w => w.project.root).sort()).toEqual([f.mods, f.site, f.notes].sort())
  expectConsistent(t, f.opts)
  expect(workspacePaths(t)).toContain(t.agents[EXECUTOR]!.worktree!)
  expect(writeRange(t, t.agents[EXECUTOR]!).dirs.length).toBe(3)

  // placeTask itself, for two projects of one task at once.
  const p = await scenario('place')
  const id = 'd-20261112-placed'
  await p.reg.create(daily(id, '两个项目同时放置', [agent('a00000000000000aa', 'executor')]))
  const placed = await Promise.all([placeTask(p.io, p.reg, p.opts, id, p.site), placeTask(p.io, p.reg, p.opts, id, p.mods)])
  expect(placed.map(x => x.mode)).toEqual(['direct', 'worktree'])
  t = (await p.reg.get(id))!
  expect(workspaces(t).map(w => w.project.root).sort()).toEqual([p.mods, p.site].sort())
  expectConsistent(t, p.opts)
})
