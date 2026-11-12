// The tool limits of section 9.5 over the host's own path resolution (plan section 12.1, gate row:
// symbolic link resolution): placeWith over real paths and repoOfWith over `git rev-parse`, in a
// real project repository with a task worktree made by the plugin's createWorktree and symbolic
// links between them.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { architectDeny, placeWith, repoOfWith, subagentWriteDeny } from '../src/gate'
import { baseRefName, createWorktree } from '../src/git'
import { nodeIo } from './node-io'

const io = nodeIo()
let dir = ''
let project = ''
let wt = ''
let outside = ''

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-gate-')))
  project = join(dir, 'proj')
  outside = join(dir, 'scratch')
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(join(project, '.planning'))
  mkdirSync(outside)
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(project, '.planning', 'findings.md'), '# findings\n')
  writeFileSync(join(project, 'CONTEXT.md'), '# context\n')
  sh(project, 'init', '-q')
  sh(project, 'add', '-A')
  sh(project, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init')
  wt = join(dir, 'wt', 'l-20261109-gate01')
  await createWorktree(io, project, wt, baseRefName('l-20261109-gate01'), project)
  // Links: from outside every repository into the project, from the project into the worktree's
  // .planning, a record name in the project that points at code, and a link to the findings file.
  symlinkSync(project, join(outside, 'proj-link'))
  symlinkSync(join(wt, '.planning'), join(project, 'wt-planning'))
  symlinkSync(join(project, 'src', 'a.ts'), join(project, '.planning', 'plan-link.md'))
  symlinkSync(join(project, '.planning', 'findings.md'), join(project, 'notes-link.md'))
})

afterAll(() => {
  sh(project, 'worktree', 'remove', '--force', wt)
  rmSync(dir, { recursive: true, force: true })
})

test('repoOfWith finds the repository of existing and new paths, and none outside', async () => {
  const repoOf = repoOfWith(io)
  expect(await repoOf(join(project, 'src', 'a.ts'))).toBe(project)
  expect(await repoOf(join(project, 'src', 'new', 'deep', 'b.ts'))).toBe(project)
  expect(await repoOf(project)).toBe(project)
  expect(await repoOf(join(wt, 'src', 'a.ts'))).toBe(wt)
  expect(await repoOf(join(wt, 'brand-new.txt'))).toBe(wt)
  expect(await repoOf(join(outside, 'x.txt'))).toBeNull()
  expect(await repoOf(join(dir, 'missing', 'x.txt'))).toBeNull()
})

test('a subagent write is judged at the real path, through links and missing directories', async () => {
  const place = placeWith(p => io.realPath(p), outside)
  const repoOf = repoOfWith(io)
  const sub = (e: { tool: string; [k: string]: unknown }, worktree: string | null) => subagentWriteDeny(e, { worktree, place, repoOf })
  // No working directory yet: a write into the project asks for open_project, naming the project.
  const before = await sub({ tool: 'Write', file_path: join(project, 'src', 'b.ts') }, null)
  expect(before).toContain('mcp__magpie-tasks__open_project')
  expect(before).toContain(`"project": "${project}"`)
  // The same through a link from outside every repository.
  expect(await sub({ tool: 'Edit', file_path: join(outside, 'proj-link', 'src', 'a.ts') }, null)).toContain('open_project')
  expect(await sub({ tool: 'Write', file_path: join(outside, 'notes.txt') }, null)).toBeNull()
  // With a worktree: inside it passes (new directories too), the project is outside it, and the
  // architect's records are refused even in the worktree.
  expect(await sub({ tool: 'Edit', file_path: join(wt, 'src', 'a.ts') }, wt)).toBeNull()
  expect(await sub({ tool: 'Write', file_path: join(wt, 'src', 'new', 'c.ts') }, wt)).toBeNull()
  expect(await sub({ tool: 'Edit', file_path: join(project, 'src', 'a.ts') }, wt)).toContain('outside it')
  expect(await sub({ tool: 'Edit', file_path: join(outside, 'proj-link', 'src', 'a.ts') }, wt)).toContain('outside it')
  expect(await sub({ tool: 'Write', file_path: join(wt, 'CONTEXT.md') }, wt)).toContain('architect writes')
  expect(await sub({ tool: 'Edit', file_path: join(project, 'wt-planning', 'findings.md') }, wt)).toContain('architect writes')
  expect(await sub({ tool: 'Write', file_path: join(outside, 'notes.txt') }, wt)).toBeNull()
})

test('the architect writes its records at their real paths only', async () => {
  const place = placeWith(p => io.realPath(p), project)
  const deny = (e: { tool: string; [k: string]: unknown }) => architectDeny(e, { projectRoot: project, home: dir, place })
  expect(await deny({ tool: 'Edit', file_path: join(project, '.planning', 'findings.md') })).toBeNull()
  expect(await deny({ tool: 'Write', file_path: '.planning/plan-new.md' })).toBeNull()
  // A link whose target is a record is that record; a record name that links to code is code.
  expect(await deny({ tool: 'Edit', file_path: join(project, 'notes-link.md') })).toBeNull()
  expect(await deny({ tool: 'Edit', file_path: join(project, '.planning', 'plan-link.md') })).toContain('not one of them')
  // A link into the worktree leads there: its findings.md is not the project's.
  expect(await deny({ tool: 'Edit', file_path: join(project, 'wt-planning', 'findings.md') })).toContain('not one of them')
  // `..` is folded before links are followed, as the file tools write: wt-planning/.. is the project.
  expect(await deny({ tool: 'Write', file_path: join(project, 'wt-planning') + '/../CONTEXT.md' })).toBeNull()
  expect(await deny({ tool: 'Write', file_path: join(project, 'wt-planning') + '/../src/a.ts' })).toContain('not one of them')
  expect(await deny({ tool: 'Write', file_path: join(project, 'src') + '/../CONTEXT.md' })).toBeNull()
  // The project reached through a link from outside is the same project.
  expect(await deny({ tool: 'Write', file_path: join(outside, 'proj-link', 'CONTEXT.md') })).toBeNull()
})
