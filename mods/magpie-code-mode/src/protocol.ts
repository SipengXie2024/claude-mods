export const DEFAULT_MAGPIE_GATEWAY = 'http://127.0.0.1:3425'
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
export const OUTPUT_CHAR_CAP = 30_000

export const CODE_TOOL_SHORT = 'code'
export const CODE_TOOL = 'mcp__magpie-code-mode__code'
export const SECTION_ID = 'magpie-code-mode'

/**
 * Built-in tools replaced by the persistent JS REPL in Code Mode.
 * They are hidden from the model's top-level tool list via `tool.offer`
 * while remaining callable inside scripts through `$.tool.call`.
 */
export const HIDDEN_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
])

/**
 * MCP prefixes kept directly offered to the model (our own tool plus
 * context-memory, whose top-level `notes_write` tool_use blocks are
 * scanned in the transcript during compaction).
 */
const KEPT_MCP_PREFIXES: readonly string[] = [
  'mcp__magpie-code-mode__',
  'mcp__context-memory__',
  'mcp__tg-router__',
  'mcp__tg-channel__',
  'mcp__plugin_telegram_',
  'mcp__magpie-tasks__',
]

function normalizeUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1')
}

export function isMagpieGateway(
  baseUrl: string | undefined,
  gatewayUrl: string = DEFAULT_MAGPIE_GATEWAY,
): boolean {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return false
  return normalizeUrl(baseUrl) === normalizeUrl(gatewayUrl)
}

export function isHiddenByCodeMode(toolName: string): boolean {
  if (HIDDEN_BUILTIN_TOOLS.has(toolName)) return true
  if (toolName.startsWith('mcp__')) {
    return !KEPT_MCP_PREFIXES.some(prefix => toolName.startsWith(prefix))
  }
  return false
}

export function clampTimeout(raw: unknown, fallback: number = DEFAULT_TIMEOUT_MS): number {
  const base = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, base))
}

export function summarizeCodeForUi(code: string): string {
  const firstNonEmpty = code
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith('//'))
  if (!firstNonEmpty) return '(empty script)'
  return firstNonEmpty.length > 80 ? `${firstNonEmpty.slice(0, 79)}…` : firstNonEmpty
}

export const CODE_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'JavaScript code to execute in the persistent session REPL. Top-level await is supported; the last expression value and any log() calls are returned.',
    },
    description: {
      type: 'string',
      description: 'Optional short 5-10 word description of what this script does.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Optional timeout in milliseconds (default 120000, max 600000).',
    },
  },
  required: ['code'],
  additionalProperties: false,
} as const

export function buildToolDescription(): string {
  return [
    'Execute JavaScript in a persistent session REPL that bridges all Claude Code file, shell, search, web, and MCP tools.',
    'Batch multi-step reads, searches, edits, shell commands, and parallel Promise.all() calls into a single script.',
    'Globals: $, file(path), edit(path, old, next, opts?), write(path, content), Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch, NotebookEdit, tools.<name>, searchTools(query, max?), describeTool(name), log(...args), console, preview(val, n?), sleep(ms), setTimeout/setInterval, atob/btoa.',
    'Variables and functions persist across calls in the same loop. The last expression value (with top-level Promise properties auto-awaited) and any log() calls are returned.',
  ].join(' ')
}

export const CODE_MODE_DECLARATIONS = `\`\`\`ts
// Persistent JavaScript REPL globals (Code Mode for claude-magpie).
// All file, shell, search, web, and MCP tools run through Claude Code's native tool layer.

/** Tagged shell template (auto POSIX-quotes string interpolations; arrays expand to multiple args; {raw: s} splices unquoted) or plain string command $(cmd, timeoutMs?). Non-zero exit throws ShellError unless .nothrow() is chained (exit 1 from grep/rg/find/diff/test/git diff/git grep is treated as a normal outcome). */
declare function $(strings: TemplateStringsArray, ...values: unknown[]): ShellPromise;
declare function $(cmd: string, timeoutMs?: number): ShellPromise;
declare namespace $ {
  function escape(s: string): string;
  const ShellError: new (out: ShellOutput) => ShellError;
}
interface ShellPromise extends Promise<ShellOutput> {
  nothrow(): ShellPromise;
  throws(on: boolean): ShellPromise;
  quiet(): ShellPromise;
  timeout(ms: number): ShellPromise;
  cwd(dir: string): ShellPromise;
  env(vars: Record<string, string>): ShellPromise;
  text(): Promise<string>;
  lines(): Promise<string[]>;
  json(): Promise<unknown>;
}
interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  file?: string;
  note?: string;
  error?: string;
  text(): string;
  lines(): string[];
  json(): unknown;
}
interface ShellError extends Error {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated?: boolean;
}

/** Exact-string file edit. Single form or batch [[old, next], ...] (batch validates all anchors before writing). Throws on zero or ambiguous matches unless {all: true} or {soft: true}. */
declare function edit(path: string, old: string, next: string, opts?: { all?: boolean; soft?: boolean }): Promise<{ ok: boolean; replacements: number; error?: string }>;
declare function edit(path: string, edits: [old: string, next: string][], opts?: { all?: boolean; soft?: boolean }): Promise<{ ok: boolean; replacements: number; error?: string }>;

/** Writes a whole file; resolves to UTF-8 byte count. */
declare function write(path: string, content: string): Promise<number>;

/** Lazy file handle; relative paths resolve from the session cwd. */
declare function file(path: string): {
  name: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
  lines(): Promise<string[]>;
  exists(): Promise<boolean>;
  slice(offset?: number, limit?: number): Promise<string>;
};

/** Direct async bindings to Claude Code built-in tools and all MCP tools (also via tools[name]). */
declare function Read(input: { file_path: string; offset?: number; limit?: number; pages?: string }): Promise<any>;
declare function Write(input: { file_path: string; content: string }): Promise<any>;
declare function Edit(input: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<any>;
declare function Glob(input: { pattern: string; path?: string }): Promise<any>;
declare function Grep(input: { pattern: string; path?: string; glob?: string; type?: string; output_mode?: 'content' | 'files_with_matches' | 'count'; '-n'?: boolean; '-i'?: boolean; '-C'?: number; head_limit?: number; multiline?: boolean }): Promise<any>;
declare function Bash(input: { command: string; timeout?: number; description?: string; run_in_background?: boolean }): Promise<any>;
declare function WebFetch(input: { url: string; prompt: string }): Promise<any>;
declare function WebSearch(input: { query: string; allowed_domains?: string[]; blocked_domains?: string[] }): Promise<any>;
declare function NotebookEdit(input: Record<string, unknown>): Promise<any>;
declare const tools: Record<string, (input?: Record<string, unknown>) => Promise<any>>;

/** Discover hidden or MCP tools by keyword and inspect a tool's description. */
declare function searchTools(query: string, max?: number): Promise<{ name: string; about: string; mcp: boolean }[] | { error: string }>;
declare function describeTool(name: string): Promise<{ name: string; description: string; mcp: boolean } | { error: string }>;

/** Output & utility globals. */
declare function log(...args: unknown[]): void;
declare const self: typeof globalThis;
declare function preview(value: unknown, n?: number): string;
declare function sleep(ms: number): Promise<void>;
declare var console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  tail(n?: number): string;
  buffer(): string;
  dropped(): number;
};
declare function setTimeout(fn: () => void, ms?: number): number;
declare function clearTimeout(id: number): void;
declare function setInterval(fn: () => void, ms?: number): number;
declare function clearInterval(id: number): void;
declare function atob(data: string): string;
declare function btoa(data: string): string;
\`\`\``

export function buildSystemPromptSection(hiddenTools: readonly string[]): string {
  const hiddenList = hiddenTools.length > 0
    ? hiddenTools.join(', ')
    : 'Bash, Read, Write, Edit, Glob, Grep, NotebookEdit, WebFetch, WebSearch, and MCP tools'
  return [
    '# Code Mode (magpie-code-mode)',
    '',
    `In this \`claude-magpie\` session, Code Mode is active. File, shell, search, web, and external MCP tools (${hiddenList}) are hidden from your top-level tool list and accessed as JavaScript inside \`${CODE_TOOL}\`.`,
    `Always invoke \`${CODE_TOOL}\` using native structured tool calling (function call) — never write \`<${CODE_TOOL}>...\` as raw XML text in your message body, because raw XML tags are not executed by the harness.`,
    'Interactive and orchestration tools that remain directly listed (such as `Agent`, `Skill`, `AskUserQuestion`, `Workflow`, and `mcp__context-memory__notes_write`) are still called directly as normal tools.',
    '',
    'The REPL is one persistent JavaScript context per conversation loop: variables, functions, and classes you define in one call stay defined in later calls. Top-level `await` works. There is no `import`, `require`, or `process` — use the globals below to interact with the workspace and tools.',
    '',
    'Batch multi-step investigation, filtering, editing, and verification into ONE script using `Promise.all(...)` whenever independent calls can run concurrently. Returning large raw text wastes context on every later turn — filter, aggregate, or use `preview(out, 2000)` inside the script, and keep full outputs in REPL variables to inspect later.',
    '',
    'A script returns its last expression value plus anything passed to `log(...)` (wrapped in `<repl-output>`). Promise values on a returned plain object are awaited automatically (e.g. `({ status: $\`git status\`, branches: $\`git branch\` })`). `console.*` writes to an in-memory ring buffer (`console.tail(n)` reads it back) without adding to your context. Each output part is capped at ~30,000 characters (head and tail kept).',
    '',
    'Example:',
    '```js',
    'const [defs, uses] = await Promise.all([',
    '  $`rg -l "function retryPolicy" src`.text(),',
    '  $`rg -lF "retryPolicy(" src test`.text(),',
    ']);',
    "const target = defs.trim().split('\\n')[0];",
    "if (!target) throw new Error('nothing defines retryPolicy');",
    "await edit(target, 'maxAttempts: 3', 'maxAttempts: 5');",
    "({ edited: target, callers: uses.trim().split('\\n').filter(f => f !== target), test: $`bun test`.nothrow() });",
    '```',
    '',
    '## Declarations',
    CODE_MODE_DECLARATIONS,
  ].join('\n')
}
