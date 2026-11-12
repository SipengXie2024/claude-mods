// Tool limits (plan section 9.5): what an architect's main conversation may run and write, and where
// a routed subagent may write. Every check here is a function of the call and of path resolutions
// the caller supplies (`place`: the real path of a file, or of its nearest existing ancestor joined
// with the rest when the file does not exist yet; `repoOf`: the top of the Git repository holding a
// real path, or null), so the rules are tested on their own. `placeWith` and `repoOfWith` build
// those two resolutions over the host.
import { repoRoot } from './git'
import type { Io } from './io'

type ToolEvent = { tool: string; [k: string]: unknown }

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const SUBAGENT_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const RECORD_PATHS = '.planning/findings.md, CONTEXT.md, .planning/plan-*.md and .planning/*.html (direct children of .planning) in the project main directory'

// ---- paths ------------------------------------------------------------------------------------

// `path` with `.` and `..` resolved lexically and repeated slashes removed; relative paths are taken
// from `cwd`. No symbolic link is followed: that is what `place` adds after folding.
export function lexicalPath(path: string, cwd: string): string {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

function relativeTo(path: string, dir: string): string | null {
  const d = dir.replace(/\/+$/, '')
  if (path === d) return ''
  return path.startsWith(`${d}/`) ? path.slice(d.length + 1) : null
}

// Whether a real path is one of the design records the architect writes itself: .planning/findings.md,
// CONTEXT.md, .planning/plan-<name>.md or .planning/<name>.html, directly under the project root.
// Both arguments are real paths.
export function isRecordPath(realPath: string, projectRoot: string): boolean {
  const rel = relativeTo(realPath, projectRoot)
  if (rel === null) return false
  if (rel === 'CONTEXT.md' || rel === '.planning/findings.md') return true
  const m = /^\.planning\/([^/]+)$/.exec(rel)
  if (!m) return false
  const name = m[1]!
  return (/^plan-.+\.md$/.test(name)) || (/^.+\.html$/.test(name))
}

// ---- shell commands ---------------------------------------------------------------------------

type Parsed = { commands: string[][] } | { refused: string }

// Splits a command line into simple commands (words with quotes removed) at `&&`, `||`, `;`, `|`,
// `&` and newlines outside quotes. Refuses what a read-only check cannot see through: output
// redirection, command and process substitution, backticks, unterminated quotes, and escapes
// (a backslash can hide any of these from a scanner this small).
function parseShell(command: string): Parsed {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false }
  const endCommand = () => { endWord(); if (words.length > 0) commands.push(words); words = [] }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    const next = command[i + 1]
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
      continue
    }
    if (c === '\\') return { refused: 'a backslash escape' }
    if (c === '`') return { refused: 'a backtick command substitution' }
    if (c === '$' && next === '(') return { refused: 'a $( ) command substitution' }
    if (quote === '"') {
      if (c === '"') quote = null
      else word += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue }
    if (c === '>') return { refused: 'an output redirection' }
    if (c === '<' && next === '(') return { refused: 'a <( ) process substitution' }
    if (c === '<') return { refused: 'an input redirection' }
    if (c === '(' || c === ')' || c === '{' || c === '}') return { refused: 'a subshell or group' }
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      endCommand()
      if ((c === '|' || c === '&') && next === c) i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue }
    word += c
    inWord = true
  }
  if (quote !== null) return { refused: 'an unterminated quote' }
  endCommand()
  return { commands }
}

const READ_PROGRAMS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'find', 'stat', 'du', 'file', 'pwd', 'tree', 'jq'])
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'blame'])
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])

// Why one simple command is not read-only, or null when it is.
function notReadOnly(words: string[]): string | null {
  const [program, ...args] = words
  if (program === undefined) return 'an empty command'
  if (program === 'sed') return sedNotReadOnly(args)
  if (program === 'git') return gitNotReadOnly(args)
  if (!READ_PROGRAMS.has(program)) return `${program} is not on the read-only list`
  if (program === 'find') {
    const action = args.find(a => FIND_ACTIONS.has(a))
    if (action !== undefined) return `find ${action}`
  }
  if (program === 'rg' && args.some(a => a === '--pre' || a.startsWith('--pre='))) return 'rg --pre'
  if (program === 'tree' && args.some(a => a === '-o' || a.startsWith('-o'))) return 'tree -o'
  return null
}

// One sed print command: an optional address or range (line number, `$`, `first~step`, `/regex/`
// with an optional I, `addr,+N`, `addr,~N`), an optional `!`, then p, = or q. GNU sed also has
// commands that write files (w, W, the s///w flag) or run programs (e, s///e), and options that
// read a script from elsewhere (-e, -f, --expression, --file); only this grammar can rule them out.
const SED_ADDR = String.raw`(?:\d+(?:~\d+)?|\$|/[^/]*/I?)`
const SED_COMMAND = String.raw`\s*(?:${SED_ADDR}(?:\s*,\s*(?:${SED_ADDR}|[+~]\d+))?)?\s*!?\s*[p=q]\s*`
const SED_SCRIPT = new RegExp(String.raw`^${SED_COMMAND}(?:;${SED_COMMAND})*;?\s*$`)

// `sed -n '<print script>' [file…]`: the leading -n, one script of print commands, then file names.
function sedNotReadOnly(args: string[]): string | null {
  const [flag, script, ...files] = args
  if (flag !== '-n') return 'sed without a leading -n'
  if (script === undefined) return 'sed -n without a script'
  if (script.startsWith('-')) return `sed -n followed by the option ${script}`
  if (!SED_SCRIPT.test(script)) return `a sed script other than addresses with p, = or q (${script})`
  const option = files.find(f => f.startsWith('-'))
  if (option !== undefined) return `the sed option ${option}`
  return null
}

// `git [-C <dir>] [--no-pager] <read subcommand>`: -C lets the architect read the task worktree by
// its absolute path; -c is refused (a config value such as core.pager runs a program).
function gitNotReadOnly(args: string[]): string | null {
  let i = 0
  while (i < args.length) {
    const a = args[i]!
    if (a === '-C') { if (args[i + 1] === undefined) return 'git -C without a directory'; i += 2; continue }
    if (a === '--no-pager') { i++; continue }
    break
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (sub === undefined) return 'git without a subcommand'
  if (rest.some(a => a === '--output' || a.startsWith('--output='))) return `git ${sub} --output`
  if (GIT_READ.has(sub)) return null
  if (sub === 'worktree' && rest[0] === 'list') return null
  if (sub === 'branch' && rest[0] === '--list') return null
  return `git ${[sub, ...rest.slice(0, 1)].join(' ')}`
}

// Whether every part of the command line is a read-only command from section 9.5's list.
export function isReadOnlyBash(command: string): boolean {
  return readOnlyRefusal(command) === null
}

function readOnlyRefusal(command: string, allow: (words: string[]) => boolean = () => false): string | null {
  const parsed = parseShell(command)
  if ('refused' in parsed) return parsed.refused
  if (parsed.commands.length === 0) return 'an empty command'
  for (const words of parsed.commands) {
    if (allow(words)) continue
    const why = notReadOnly(words)
    if (why !== null) return why
  }
  return null
}

function expandTilde(word: string, home: string): string {
  if (word === '~') return home
  if (word.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${word.slice(2)}`
  if (word.startsWith('$HOME/')) return `${home.replace(/\/+$/, '')}/${word.slice(6)}`
  return word
}

// The html-plan commands of section 9.5, each a single command: `node <…>/html-plan/runtime/pack.mjs
// <project>/.planning/<name>.html --root <project>` and `~/sipeng/plans/publish-plan …` (including
// `--remove <name>`). Relative paths are taken from the project root, where the architect runs.
export function isPlanCommand(command: string, projectRoot: string, home: string): boolean {
  const parsed = parseShell(command)
  if ('refused' in parsed || parsed.commands.length !== 1) return false
  const words = parsed.commands[0]!.map(w => expandTilde(w, home))
  const root = lexicalPath(projectRoot, '/')
  if (lexicalPath(words[0]!, root) === lexicalPath(`${home}/sipeng/plans/publish-plan`, '/')) return true
  if (words[0] !== 'node' || words.length !== 5) return false
  const [, script, page, flag, rootArg] = words as [string, string, string, string, string]
  if (!/(^|\/)html-plan\/runtime\/pack\.mjs$/.test(script)) return false
  if (flag !== '--root' || lexicalPath(rootArg, root) !== root) return false
  const rel = relativeTo(lexicalPath(page, root), root)
  return rel !== null && /^\.planning\/[^/]+\.html$/.test(rel)
}

// ---- the two gates ------------------------------------------------------------------------------

function filePath(e: ToolEvent): string | null {
  const field = e.tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
  const v = e[field]
  return typeof v === 'string' && v !== '' ? v : null
}

// `git add|commit|push …` with the subcommand right after `git`: the architect commits and pushes
// in the project main directory, where it runs, when the person asks. No -C (a commit in the task
// worktree would sit on the plugin's snapshot commits, which carry the person's uncommitted files)
// and no -c (a config value such as core.pager runs a program).
const ARCHITECT_GIT = new Set(['add', 'commit', 'push'])
function isArchitectGit(words: string[]): boolean {
  return words[0] === 'git' && words[1] !== undefined && ARCHITECT_GIT.has(words[1])
}

const ARCHITECT_ROLE = 'You are the architect of this long task: you discuss goals and design with the person, delegate implementation to subagents with the Agent tool (they work in the task worktree), and accept their results.'

// The refusal for a tool call of the architect's main conversation, or null to let it run.
// `projectRoot` is the project main directory; it goes through `place` as the written path does.
export async function architectDeny(e: ToolEvent, a: { projectRoot: string; home: string; place: (path: string) => Promise<string | null> }): Promise<string | null> {
  if (e.tool === 'NotebookEdit') return `${ARCHITECT_ROLE} Notebook edits are implementation work: delegate them to a subagent with the Agent tool.`
  if (EDIT_TOOLS.has(e.tool)) {
    const path = filePath(e)
    if (path === null) return `${e.tool} without a file_path. ${ARCHITECT_ROLE}`
    const [real, root] = await Promise.all([a.place(path), a.place(a.projectRoot)])
    if (real === null || root === null) return `${e.tool} on ${path}: the path could not be resolved. The architect writes only ${RECORD_PATHS}.`
    if (isRecordPath(real, root)) return null
    return `${ARCHITECT_ROLE} The architect writes only ${RECORD_PATHS}; ${path} is not one of them. Delegate code and other file changes to an implementation subagent with the Agent tool.`
  }
  if (e.tool === 'Bash') {
    const command = typeof e['command'] === 'string' ? e['command'] : ''
    const root = await a.place(a.projectRoot)
    if (root === null) return `Bash: the project root ${a.projectRoot} could not be resolved.`
    if (isPlanCommand(command, root, a.home)) return null
    const why = readOnlyRefusal(command, isArchitectGit)
    if (why === null) return null
    return `${ARCHITECT_ROLE} The architect runs only read-only commands (ls, cat, head, tail, wc, rg, grep, find, stat, du, file, pwd, tree, jq, sed -n with a print script such as '1,40p', git status/diff/log/show/ls-files/rev-parse/blame/worktree list/branch --list, joined by &&, ||, ; or | and without redirection or substitution), git add/commit/push in the project main directory (without -C or -c) when the person asks, and the html-plan pack and publish-plan commands; this command has ${why}. Delegate commands that change files or run builds and tests to a subagent with the Agent tool.`
  }
  return null
}

// The refusal for a routed subagent's write, or null. A write into a Git repository must land in the
// agent's working directory (`worktree`: the task worktree, or the project directory of a direct
// task; null: the agent has none yet); writes outside every repository (/tmp and the like) pass;
// CONTEXT.md and .planning/findings.md are the architect's even there.
export async function subagentWriteDeny(e: ToolEvent, a: { worktree: string | null; place: (path: string) => Promise<string | null>; repoOf: (path: string) => Promise<string | null> }): Promise<string | null> {
  if (!SUBAGENT_WRITE_TOOLS.has(e.tool)) return null
  const path = filePath(e)
  if (path === null) return null
  const real = await a.place(path)
  if (real === null) return `${e.tool} on ${path}: the path could not be resolved, so it cannot be checked against your worktree.`
  const repo = await a.repoOf(real)
  if (repo === null) return null
  if (a.worktree === null) {
    return `${path} is inside the Git repository ${repo}, and you have no working directory for it yet. Call mcp__magpie-tasks__open_project with { "project": "${repo}" } first, then make every change in the directory it returns (cd there before running commands).`
  }
  const wt = await a.place(a.worktree)
  if (wt === null) return `Your working directory ${a.worktree} does not exist; report this and end your turn.`
  const rel = relativeTo(real, wt)
  if (rel === null) return `Write only inside your working directory ${wt}; ${path} is outside it (in ${repo}). Make the change in the copy of the file there instead.`
  if (rel === 'CONTEXT.md' || rel === '.planning/findings.md') return `${rel} is a design record the architect writes in the project main directory. Put what you found in your report instead.`
  return null
}

// A `place` over a real-path lookup: the real path of `path`, or, when it does not exist, the real
// path of its nearest existing ancestor joined with the remaining components. `.` and `..` are
// folded before any link is followed, as Claude Code's file tools do with the path they write
// (measured 2026-11-09: Write to <d>/c/l/../y.txt, l a link to <d>/a/b, created <d>/c/y.txt, and
// $.fs.stat's realPath of <d>/c/l/../x is <d>/c/x), so the place is where the tool writes.
export function placeWith(realPath: (path: string) => Promise<string | null>, cwd: string): (path: string) => Promise<string | null> {
  return async (path: string) => {
    const rest: string[] = []
    let dir = lexicalPath(path, cwd)
    for (;;) {
      const real = await realPath(dir)
      if (real !== null) return rest.length === 0 ? real : lexicalPath(rest.reverse().join('/'), real)
      if (dir === '/') return null
      const cut = dir.lastIndexOf('/')
      rest.push(dir.slice(cut + 1))
      dir = cut === 0 ? '/' : dir.slice(0, cut)
    }
  }
}

// A `repoOf` over the host: the top of the Git repository holding a real path that may not exist
// yet, asked of its nearest existing directory; null outside every repository.
export function repoOfWith(io: Io): (realPath: string) => Promise<string | null> {
  return async (realPath: string) => {
    let dir = realPath.replace(/\/+$/, '') || '/'
    for (;;) {
      if (await io.exists(dir) && (await io.stat(dir)).kind === 'dir') return repoRoot(io, dir)
      if (dir === '/') return null
      const cut = dir.lastIndexOf('/')
      dir = cut <= 0 ? '/' : dir.slice(0, cut)
    }
  }
}
