// Host input/output (plan section 3.4): the Io interface every module does I/O through, its
// implementation on the plugin interface `$`, and small helpers (home expansion, FNV-1a, IDs).
import type { EngineInterface } from 'claude-code'

export interface Io {
  run(argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>
  read(path: string): Promise<string>                  // rejects when the file is missing
  write(path: string, text: string): Promise<void>     // creates missing directories
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<{ kind: string; size: number; mtimeMs: number }>
  realPath(path: string): Promise<string | null>       // $.fs.stat(path, { resolve: true }).realPath; null when the path leads nowhere
  list(path: string): Promise<{ name: string; kind: string }[]>
  now(): Promise<number>
  // $.clock.sleep: counts against the hook's 10 s budget. Use it only to race another `$` call that is
  // in flight (the budget is already paused by that call); repeated waits go through `wait`.
  sleep(ms: number): Promise<void>
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; ok: boolean; text: string }>
  env(name: string): Promise<string | undefined>
  log(line: string): Promise<void>                     // $.ui.log(..., { to: 'debug' }), prefixed 'magpie-tasks: '
}

export function hostIo($: EngineInterface): Io {
  return {
    async run(argv, init) {
      const r = await $.process.run(argv, init)
      // A cut stream would hand a caller a partial patch or listing; stop here instead.
      if (r.isStdoutTruncated || r.isStderrTruncated) {
        throw new Error(`${argv[0]}: output exceeded the 4 MiB limit of $.process.run`)
      }
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    },
    read: (path) => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: (path) => $.fs.exists(path),
    async stat(path) {
      const s = await $.fs.stat(path)
      return { kind: s.kind, size: s.size, mtimeMs: s.mtimeMs }
    },
    async realPath(path) {
      const s = await $.fs.stat(path, { resolve: true }).catch(async (error: unknown) => {
        if (await $.fs.exists(path)) throw error
        return undefined
      })
      return s?.realPath ?? null
    },
    async list(path) {
      const entries = await $.fs.list(path)
      return entries.map(entry => ({ name: entry.name, kind: entry.kind }))
    },
    now: () => $.clock.now(),
    sleep: (ms) => $.clock.sleep(ms),
    async fetch(url, init) {
      const r = await $.http.fetch(url, init)
      return { status: r.status, ok: r.ok, text: r.text }
    },
    env: (name) => hostEnv($, name),
    async log(line) {
      $.ui.log(`magpie-tasks: ${line}`, { to: 'debug' })
    },
  }
}

// `$.env.get` takes only a literal name (claude plugin validate refuses a computed one), so every
// variable the plugin reads is listed here; reading another one is a programming error.
function hostEnv($: EngineInterface, name: string): Promise<string | undefined> {
  switch (name) {
    case 'HOME': return $.env.get('HOME')
    case 'ANTHROPIC_BASE_URL': return $.env.get('ANTHROPIC_BASE_URL')
    case 'MAGPIE_TASKS_ROLE': return $.env.get('MAGPIE_TASKS_ROLE')
    case 'CLAUDE_JOB_DIR': return $.env.get('CLAUDE_JOB_DIR')
    case 'CLAUDE_BG_SOURCE': return $.env.get('CLAUDE_BG_SOURCE')
    case 'CLAUDE_CONFIG_DIR': return $.env.get('CLAUDE_CONFIG_DIR')
    case 'CLAUDE_CODE_SESSION_KIND': return $.env.get('CLAUDE_CODE_SESSION_KIND')
    case 'JEV_OPUS_CONFIG_DIR': return $.env.get('JEV_OPUS_CONFIG_DIR')
    case 'XDG_CONFIG_HOME': return $.env.get('XDG_CONFIG_HOME')
    default: throw new Error(`io.env: ${name} is not among the variables src/io.ts reads; add a case for it`)
  }
}

// Waits by running `sleep`: while a `$` call is in flight the hook budget stops counting, so lock
// retries and claim polling inside a hook do not exhaust its 10 s budget.
export async function wait(io: Io, ms: number): Promise<void> {
  const r = await io.run(['sleep', String(ms / 1000)], { timeoutMs: ms + 30000 })
  if (r.exitCode !== 0) throw new Error(`sleep ${ms / 1000} exited ${r.exitCode}: ${r.stderr.trim()}`)
}

export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${path.slice(2)}`
  return path
}

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

// FNV-1a 64 over the UTF-8 bytes of `text`, as 16 lowercase hex digits. The hook environment's
// library is ES2023 without TextEncoder, so the UTF-8 encoding is done here.
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET
  const mix = (byte: number) => {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK_64
  }
  for (let i = 0; i < text.length; i++) {
    let cp = text.codePointAt(i)!
    if (cp > 0xffff) i++
    // A lone surrogate is encoded as U+FFFD, as TextEncoder does.
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd
    if (cp < 0x80) {
      mix(cp)
    } else if (cp < 0x800) {
      mix(0xc0 | (cp >> 6)); mix(0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      mix(0xe0 | (cp >> 12)); mix(0x80 | ((cp >> 6) & 0x3f)); mix(0x80 | (cp & 0x3f))
    } else {
      mix(0xf0 | (cp >> 18)); mix(0x80 | ((cp >> 12) & 0x3f)); mix(0x80 | ((cp >> 6) & 0x3f)); mix(0x80 | (cp & 0x3f))
    }
  }
  return hash.toString(16).padStart(16, '0')
}

// `<prefix>-YYYYMMDD-<6 base36>`; the date is the UTC date of `now`.
export function newId(prefix: 'l' | 'd' | 'c' | 'r' | 'q', now: number): string {
  const d = new Date(now)
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  let suffix = ''
  for (let i = 0; i < 6; i++) suffix += Math.floor(Math.random() * 36).toString(36)
  return `${prefix}-${day}-${suffix}`
}
