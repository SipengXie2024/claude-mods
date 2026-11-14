// The tool limits of section 9.5 (plan section 12.1, gate row): the architect's write list (with
// `..`, a symbolic link's resolved target, and same-named files in the worktree), read-only Bash and
// the html-plan commands, and where a routed subagent may write. Paths are this host's layout; the
// path resolution handed to the gates is the plugin's own (placeWith over a lookup that answers
// the given paths as their real paths: no link among them).
import { expect, test } from 'claude-code/testing'
import { architectDeny, isPlanCommand, isReadOnlyBash, isRecordPath, lexicalPath, placeWith, subagentWriteDeny } from '../src/gate'

const HOME = '/home/ubuntu'
const ROOT = '/home/ubuntu/sipeng/claude-mods'
const WT = '/home/ubuntu/.local/share/magpie-tasks/worktrees/l-20261109-a1b2c3'
// Every directory below exists as written (no symbolic link), so its real path is itself; a file
// that does not exist yet resolves through its directory.
const EXISTING = new Set(['/', '/home', HOME, '/home/ubuntu/sipeng', ROOT, `${ROOT}/.planning`, `${ROOT}/mods`, `${ROOT}/mods/jev`, '/home/ubuntu/.local', '/home/ubuntu/.local/share', '/home/ubuntu/.local/share/magpie-tasks', '/home/ubuntu/.local/share/magpie-tasks/worktrees', WT, `${WT}/.planning`, '/tmp'])
const place = placeWith(async p => (EXISTING.has(lexicalPath(p, '/')) ? lexicalPath(p, '/') : null), ROOT)
const deny = (e: { tool: string; [k: string]: unknown }) => architectDeny(e, { projectRoot: ROOT, home: HOME, place })

test('the architect record paths are the four kinds directly under the project root', () => {
  for (const ok of ['.planning/findings.md', 'CONTEXT.md', '.planning/plan-magpie-tasks.md', '.planning/review.html', '.planning/plan-x.html']) {
    expect(isRecordPath(`${ROOT}/${ok}`, ROOT)).toBe(true)
  }
  for (const no of ['.planning/progress.md', '.planning/research/x.html', '.planning/plan-.md', 'mods/CONTEXT.md', 'README.md', '.planning', '.planning/findings.md.bak']) {
    expect(isRecordPath(`${ROOT}/${no}`, ROOT)).toBe(false)
  }
  // The same names inside the task worktree, and a link's resolved target there, are not records.
  expect(isRecordPath(`${WT}/.planning/findings.md`, ROOT)).toBe(false)
  expect(isRecordPath(`${WT}/CONTEXT.md`, ROOT)).toBe(false)
  expect(isRecordPath(`${ROOT}-other/CONTEXT.md`, ROOT)).toBe(false)
})

test('the architect may Edit and Write records, resolved through .. and new files', async () => {
  expect(await deny({ tool: 'Write', file_path: `${ROOT}/.planning/findings.md` })).toBeNull()
  expect(await deny({ tool: 'Edit', file_path: `${ROOT}/mods/jev/../../.planning/plan-new.md` })).toBeNull()
  expect(await deny({ tool: 'MultiEdit', file_path: 'CONTEXT.md' })).toBeNull()
  const code = await deny({ tool: 'Edit', file_path: `${ROOT}/.planning/../mods/jev/src/a.ts` })
  expect(code).toContain('delegate')
  expect(code).toContain('.planning/findings.md')
  expect(await deny({ tool: 'Write', file_path: `${WT}/.planning/findings.md` })).toContain('not one of them')
  expect(await deny({ tool: 'NotebookEdit', notebook_path: `${ROOT}/.planning/n.ipynb` })).toContain('Agent tool')
  expect(await deny({ tool: 'Read', file_path: `${ROOT}/mods/jev/src/a.ts` })).toBeNull()
  expect(await deny({ tool: 'Agent', prompt: 'x' })).toBeNull()
})

test('read-only Bash passes; redirection, substitution, sed beyond print scripts, find -delete and git commit do not', () => {
  for (const ok of [
    'ls -la',
    'git status',
    `git -C ${WT} diff --stat`,
    'git --no-pager log --oneline -5',
    "rg 'parseStatus|parseVerdict' src | head -20",
    "sed -n '1,40p' src/gate.ts",
    "sed -n '$p' README.md",
    "sed -n '/^## 13/,/^## 14/p;=' .planning/plan-magpie-tasks.md",
    "sed -n '10,+5p;20q' a.ts b.ts",
    "find . -name '*.ts' -not -path './node_modules/*'",
    'cat README.md && wc -l src/*.ts',
    'git worktree list; git branch --list',
    'grep -n "a > b" notes.md',
    'jq .version .claude-plugin/plugin.json',
  ]) expect(isReadOnlyBash(ok)).toBe(true)
  for (const no of [
    'ls > files.txt',
    'echo $(rm -rf x)',
    'cat `which ls`',
    "sed -i 's/a/b/' f",
    "sed -n -i 's/a/b/p' f",
    "sed -n '1p;w out' f",
    "sed -n 's/x/y/w out' in.txt",
    "sed -n '1e touch x' in.txt",
    "sed -n 's/.*/date/ep' in.txt",
    "sed -n -e'1e touch x' f",
    "sed -n --expression='w out' f",
    "sed -n -f .planning/plan-x.md f",
    "sed -n '1p' -i f",
    "sed -n '1r /etc/passwd' f",
    "sed -n '1W out' f",
    'find . -name x -delete',
    "find . -exec rm {} ';'",
    'git commit -m x',
    'git -c core.pager=sh log',
    'git diff --output=patch.txt',
    'touch x',
    'ls\nrm -rf x',
    'ls & rm -rf x',
    'diff <(ls a) <(ls b)',
    "cat 'unterminated",
    'ls \\; rm x',
  ]) expect(isReadOnlyBash(no)).toBe(false)
})

test('one leading cd, the redirections 2>/dev/null and 2>&1, and a backslash inside single quotes pass; every other use of them does not', () => {
  for (const ok of [
    'cd /tmp && ls',
    `cd ${WT} && git status && rg -n 'askPerson' src | head -5`,
    'ls 2>/dev/null',
    'ls missing 2>/dev/null || ls',
    'cat a 2>&1',
    'git status 2>&1 | head -3',
    `cd ${WT} && ls 2>/dev/null; cat a 2>&1`,
    String.raw`rg '\('`,
    String.raw`rg -n 'foo\.bar\(' src`,
    String.raw`sed -n '/a\.b/p' f`,
    String.raw`grep -n 'a\\b' "notes file.md"`,
  ]) expect(isReadOnlyBash(ok)).toBe(true)
  for (const no of [
    'cd x && rm y',
    'cd x',
    'cd x; ls',
    'cd x || ls',
    'cd x | ls',
    'cd -P x && ls',
    'ls && cd x && ls',
    'cd x && cd y && ls',
    '> file',
    'ls > file',
    'ls >> file',
    'ls 1>/dev/null',
    'ls >/dev/null',
    'ls 2> /dev/null',
    'ls 2>/dev/nullx',
    'ls 2>/dev/null/x',
    'ls 2>err.txt',
    'ls 2>>/dev/null',
    'ls 2>&2x',
    'ls a2>/dev/null',
    'ls "2">/dev/null',
    'ls &>/dev/null',
    'ls >&2',
    'cat < in.txt',
    String.raw`rg "\("`,
    String.raw`rg \(`,
    String.raw`ls a\ b`,
    String.raw`rg 'a' \; rm x`,
  ]) expect(isReadOnlyBash(no)).toBe(false)
})

test('the html-plan pack and publish-plan commands pass as single commands', () => {
  // The installed html-plan skill's script (~/.claude/plugins/cache/sipeng-mods/html-plan/1.0.0-zh.1).
  const pack = `node ${HOME}/.claude/plugins/cache/sipeng-mods/html-plan/1.0.0-zh.1/skills/html-plan/runtime/pack.mjs ${ROOT}/.planning/plan-magpie.html --root ${ROOT}`
  expect(isPlanCommand(pack, ROOT, HOME)).toBe(true)
  expect(isPlanCommand(`node ~/x/html-plan/runtime/pack.mjs .planning/review.html --root .`, ROOT, HOME)).toBe(true)
  expect(isPlanCommand(`node ~/x/html-plan/runtime/pack.mjs ${ROOT}/docs/review.html --root ${ROOT}`, ROOT, HOME)).toBe(false)
  expect(isPlanCommand(`node ~/x/html-plan/runtime/pack.mjs ${ROOT}/.planning/review.html --root /tmp`, ROOT, HOME)).toBe(false)
  expect(isPlanCommand(`node ~/x/other/pack.mjs ${ROOT}/.planning/review.html --root ${ROOT}`, ROOT, HOME)).toBe(false)
  expect(isPlanCommand(`${pack} && rm -rf ${ROOT}`, ROOT, HOME)).toBe(false)
  expect(isPlanCommand(`~/sipeng/plans/publish-plan ${ROOT}/.planning/plan.packed.html magpie`, ROOT, HOME)).toBe(true)
  expect(isPlanCommand('~/sipeng/plans/publish-plan --remove magpie', ROOT, HOME)).toBe(true)
  expect(isPlanCommand('/home/ubuntu/sipeng/plans/publish-plan --remove magpie', ROOT, HOME)).toBe(true)
  expect(isPlanCommand('~/sipeng/plans/publish-plan --remove magpie > log', ROOT, HOME)).toBe(false)
})

test('architectDeny lets the plan commands, read-only Bash and git add/commit/push in the main directory run and refuses the rest with the role', async () => {
  expect(await deny({ tool: 'Bash', command: '~/sipeng/plans/publish-plan --remove magpie' })).toBeNull()
  expect(await deny({ tool: 'Bash', command: 'git log --oneline -3' })).toBeNull()
  const touch = await deny({ tool: 'Bash', command: 'touch x' })
  expect(touch).toContain('touch is not on the read-only list')
  expect(touch).toContain('Agent tool')
  expect(await deny({ tool: 'Bash', command: 'git add -A && git commit -m "integrate scheduler" && git push origin master' })).toBeNull()
  expect(await deny({ tool: 'Bash', command: `git -C ${WT} commit -am wip` })).toContain('git commit')
  expect(await deny({ tool: 'Bash', command: 'git -c core.pager=sh push' })).toContain('git -c')
  expect(await deny({ tool: 'Bash', command: 'git reset --hard' })).toContain('git reset')
  expect(await deny({ tool: 'Bash', command: 'git commit -m x > log' })).toContain('this command has a redirection other than 2>/dev/null and 2>&1')
  // A leading cd goes with read-only commands only: what follows it is checked as before, and git
  // add, commit and push stay in the project main directory.
  expect(await deny({ tool: 'Bash', command: `cd ${WT} && git diff --stat 2>/dev/null` })).toBeNull()
  expect(await deny({ tool: 'Bash', command: 'cd x && rm y' })).toContain('this command has rm is not on the read-only list')
  expect(await deny({ tool: 'Bash', command: `cd ${WT} && git commit -am wip` })).toContain('this command has git commit')
  expect(await deny({ tool: 'Bash', command: `cd ${ROOT} && ~/sipeng/plans/publish-plan --remove magpie` })).toContain('is not on the read-only list')
  expect(await deny({ tool: 'Bash', command: '> file' })).toContain('a redirection other than 2>/dev/null and 2>&1')
  expect(await deny({ tool: 'Bash', command: String.raw`rg "\("` })).toContain('a backslash outside single quotes')
  expect(await deny({ tool: 'Bash', command: String.raw`rg '\('` })).toBeNull()
  expect(await deny({ tool: 'Bash', command: 'ls 2>/dev/null' })).toBeNull()
  const text = await deny({ tool: 'Bash', command: 'cd x' })
  expect(text).toContain('cd other than one leading `cd <dir> &&`')
  expect(text).toContain('after one leading "cd <dir> &&"')
  expect(text).toContain('the only redirections are 2>/dev/null and 2>&1')
  expect(text).toContain('a backslash goes inside single quotes only')
})

test('a routed subagent writes inside its working directory, outside every repository, and nowhere else', async () => {
  // The two repositories of this layout: the project and the task worktree.
  const repoOf = async (p: string) => (p.startsWith(`${WT}/`) ? WT : p.startsWith(`${ROOT}/`) ? ROOT : null)
  // An agent with one working directory; in the worktree, the project main directory is the one it leaves alone.
  const sub = (e: { tool: string; [k: string]: unknown }, worktree: string | null) => subagentWriteDeny(e, { dirs: worktree === null ? [] : [worktree], copies: worktree === WT ? { [ROOT]: WT } : {}, place, repoOf })
  expect(await sub({ tool: 'Edit', file_path: `${WT}/mods/jev/src/a.ts` }, WT)).toBeNull()
  expect(await sub({ tool: 'Write', file_path: '/tmp/scratch.txt' }, WT)).toBeNull()
  expect(await sub({ tool: 'Edit', file_path: `${ROOT}/mods/jev/src/a.ts` }, WT)).toContain('outside it')
  expect(await sub({ tool: 'Write', file_path: `${WT}/CONTEXT.md` }, WT)).toContain('architect writes')
  expect(await sub({ tool: 'Edit', file_path: `${WT}/.planning/findings.md` }, WT)).toContain('architect writes')
  expect(await sub({ tool: 'NotebookEdit', notebook_path: `${ROOT}/n.ipynb` }, WT)).toContain('outside it')
  const before = await sub({ tool: 'Write', file_path: `${ROOT}/mods/jev/src/a.ts` }, null)
  expect(before).toContain('mcp__magpie-tasks__open_project')
  expect(before).toContain(`"project": "${ROOT}"`)
  expect(await sub({ tool: 'Write', file_path: '/tmp/scratch.txt' }, null)).toBeNull()
  expect(await sub({ tool: 'Bash', command: `echo x > ${ROOT}/a` }, WT)).toBeNull()
  // A task that changes the project in place writes in the project directory itself; the
  // architect's records stay refused there.
  expect(await sub({ tool: 'Edit', file_path: `${ROOT}/mods/jev/src/a.ts` }, ROOT)).toBeNull()
  const unopened = await sub({ tool: 'Edit', file_path: `${WT}/mods/jev/src/a.ts` }, ROOT)
  expect(unopened).toContain('which this task has not opened')
  expect(unopened).toContain(`"project": "${WT}"`)
  expect(await sub({ tool: 'Write', file_path: `${ROOT}/CONTEXT.md` }, ROOT)).toContain('architect writes')
})

test('a routed subagent of a task with several projects writes in each of their working directories', async () => {
  // Three repositories: the first project (changed in a worktree), its worktree, and a second project changed in place.
  const OTHER = '/home/ubuntu/sipeng/mhot-vm'
  const repoOf = async (p: string) => [WT, ROOT, OTHER, '/home/ubuntu/sipeng/plans'].find(r => p.startsWith(`${r}/`)) ?? null
  const sub = (e: { tool: string; [k: string]: unknown }) => subagentWriteDeny(e, { dirs: [WT, OTHER], copies: { [ROOT]: WT }, place, repoOf })
  expect(await sub({ tool: 'Edit', file_path: `${WT}/mods/jev/src/a.ts` })).toBeNull()
  expect(await sub({ tool: 'Edit', file_path: `${OTHER}/src/vm.rs` })).toBeNull()
  expect(await sub({ tool: 'Write', file_path: `${OTHER}/CONTEXT.md` })).toContain('architect writes')
  // The main directory of the project it changes in a worktree: the copy is named.
  const main = await sub({ tool: 'Edit', file_path: `${ROOT}/mods/jev/src/a.ts` })
  expect(main).toContain(`Write only inside your working directory ${WT}`)
  expect(main).not.toContain('open_project')
  // A repository the task has not opened: open_project is named, with the working directories it has.
  const third = await sub({ tool: 'Edit', file_path: '/home/ubuntu/sipeng/plans/publish-plan' })
  expect(third).toContain('"project": "/home/ubuntu/sipeng/plans"')
  expect(third).toContain(`its working directories are ${WT}, ${OTHER}`)
})
