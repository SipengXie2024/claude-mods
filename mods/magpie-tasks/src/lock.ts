// Cross-session directory lock (plan section 7.2). `mkdir` is atomic across processes, so the
// session whose `mkdir <name>.lock` succeeds holds the lock until it removes the directory.
import { type Io, wait } from './io'

const DEFAULT_WAIT_MS = 10_000
const DEFAULT_STALE_MS = 30_000

export async function withLock<T>(
  io: Io,
  locksDir: string,
  name: string,
  owner: string,
  fn: () => Promise<T>,
  o?: { waitMs?: number; staleMs?: number },
): Promise<T> {
  const waitMs = o?.waitMs ?? DEFAULT_WAIT_MS
  const staleMs = o?.staleMs ?? DEFAULT_STALE_MS
  const lockPath = `${locksDir}/${name}.lock`
  const token = await acquire(io, locksDir, lockPath, name, owner, waitMs, staleMs)
  try {
    return await fn()
  } finally {
    await release(io, lockPath, name, token)
  }
}

// What a waiter saw at the lock path: the directory's modification time (set when owner.json was
// written) and the holder's token (null while owner.json is not written yet).
interface Seen { mtimeMs: number; token: string | null }

async function acquire(io: Io, locksDir: string, lockPath: string, name: string, owner: string, waitMs: number, staleMs: number): Promise<string> {
  // Without the parent directory every `mkdir` would fail and look like contention.
  await runOk(io, ['mkdir', '-p', locksDir])
  const start = await io.now()
  let logged = false
  for (;;) {
    const made = await io.run(['mkdir', lockPath], { env: { LC_ALL: 'C' } })
    if (made.exitCode === 0) {
      const at = await io.now()
      const token = `${safe(owner)}.${at}.${randomTag()}`
      // Written then renamed, so a waiter reading owner.json never sees a partial file.
      await io.write(`${lockPath}/owner.json.tmp`, JSON.stringify({ owner, at, token }) + '\n')
      await runOk(io, ['mv', '-f', `${lockPath}/owner.json.tmp`, `${lockPath}/owner.json`])
      return token
    }
    if (!/File exists/.test(made.stderr)) {
      throw new Error(`lock ${name}: mkdir ${lockPath} failed: ${made.stderr.trim()}`)
    }
    // A null `seen` means the lock was released between our mkdir and this look: retry after the wait.
    const seen = await look(io, lockPath)
    if (seen !== null) {
      const now = await io.now()
      if (now - seen.mtimeMs > staleMs) {
        // A removed stale lock is progress, so the next mkdir follows at once; every other outcome waits.
        if (await takeOver(io, lockPath, name, owner, seen, staleMs)) continue
      } else if (!logged) {
        await io.log(`lock wait ${name} held by ${await holder(io, lockPath)}`)
        logged = true
      }
    }
    if ((await io.now()) - start > waitMs) {
      throw new Error(`lock ${name} not acquired within ${waitMs} ms; held by ${await holder(io, lockPath)}`)
    }
    await wait(io, 25 + Math.floor(Math.random() * 76))
  }
}

// Removes the stale lock `seen` and returns true, or returns false when this waiter should wait
// (another waiter is taking over, or the lock changed). A rename alone does not prove which lock was
// moved: two waiters can both judge one lock stale, and the later rename would move the fresh lock
// the earlier one has just made. So takeovers run one at a time under `<name>.lock.takeover`, the
// lock is re-checked inside it, and the moved directory's token is compared with the one judged stale.
async function takeOver(io: Io, lockPath: string, name: string, owner: string, seen: Seen, staleMs: number): Promise<boolean> {
  const guard = `${lockPath}.takeover`
  const made = await io.run(['mkdir', guard], { env: { LC_ALL: 'C' } })
  if (made.exitCode !== 0) {
    if (!/File exists/.test(made.stderr)) throw new Error(`lock ${name}: mkdir ${guard} failed: ${made.stderr.trim()}`)
    await clearStaleGuard(io, guard, name, owner, staleMs)
    return false
  }
  try {
    const current = await look(io, lockPath)
    const now = await io.now()
    if (current === null || current.token !== seen.token || now - current.mtimeMs <= staleMs) return false
    const stale = `${lockPath}.stale.${safe(owner)}.${now}`
    const moved = await io.run(['mv', lockPath, stale], { env: { LC_ALL: 'C' } })
    if (moved.exitCode !== 0) {
      // Gone: its holder outlived staleMs and released it after the check above.
      if (!(await io.exists(lockPath))) return false
      throw new Error(`lock ${name}: cannot move the stale lock ${lockPath} aside: ${moved.stderr.trim()}`)
    }
    const movedToken = await ownerToken(io, stale)
    if (movedToken !== seen.token) {
      // A path names the lock and `mv` cannot be made conditional on what is there, so this can still
      // happen: a holder that outlived staleMs released after the check above and a new holder's
      // mkdir took the path before the rename (or the guard was cleared as stale while held). The
      // moved directory is left where it is, since moving it back could land inside a newer lock.
      throw new Error(`lock ${name}: the takeover moved a live lock (token ${movedToken ?? 'none'}, expected ${seen.token ?? 'none'}) to ${stale}; its holder no longer holds ${lockPath}`)
    }
    await io.log(`lock ${name} taken over from ${await holder(io, stale)} (stale ${Math.round(now - current.mtimeMs)} ms)`)
    await runOk(io, ['rm', '-rf', stale])
    return true
  } finally {
    await runOk(io, ['rm', '-rf', guard])
  }
}

// A guard left by a waiter that died during its takeover blocks every later takeover; once older
// than staleMs it is renamed aside and removed, as a stale lock was before the guard existed.
async function clearStaleGuard(io: Io, guard: string, name: string, owner: string, staleMs: number): Promise<void> {
  const mtimeMs = await mtime(io, guard)
  if (mtimeMs === null) return
  const now = await io.now()
  if (now - mtimeMs <= staleMs) return
  const aside = `${guard}.stale.${safe(owner)}.${now}`
  const moved = await io.run(['mv', guard, aside], { env: { LC_ALL: 'C' } })
  if (moved.exitCode !== 0) {
    if (!(await io.exists(guard))) return
    throw new Error(`lock ${name}: cannot move the stale takeover guard ${guard} aside: ${moved.stderr.trim()}`)
  }
  await io.log(`lock ${name} takeover guard cleared (stale ${Math.round(now - mtimeMs)} ms)`)
  await runOk(io, ['rm', '-rf', aside])
}

async function look(io: Io, lockPath: string): Promise<Seen | null> {
  const mtimeMs = await mtime(io, lockPath)
  if (mtimeMs === null) return null
  return { mtimeMs, token: await ownerToken(io, lockPath) }
}

// The directory's modification time, or null when it is gone. Under contention a lock can be removed
// before the stat and made again before the existence check, so a failed stat of a path that exists
// is retried; one that keeps failing is a real error.
async function mtime(io: Io, path: string): Promise<number | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await io.stat(path)).mtimeMs
    } catch (error) {
      if (!(await io.exists(path))) return null
      if (attempt === 3) throw error
    }
  }
}

async function ownerToken(io: Io, lockPath: string): Promise<string | null> {
  const r = await io.run(['cat', `${lockPath}/owner.json`])
  if (r.exitCode !== 0 || r.stdout.trim() === '') return null
  const token = (JSON.parse(r.stdout) as { token?: unknown }).token
  return typeof token === 'string' ? token : null
}

async function release(io: Io, lockPath: string, name: string, token: string): Promise<void> {
  if ((await ownerToken(io, lockPath)) !== token) {
    // Held past staleMs and taken over by another session: its lock is not ours to remove.
    await io.log(`lock ${name} was taken over while held; left in place`)
    return
  }
  await runOk(io, ['rm', '-rf', lockPath])
}

async function holder(io: Io, lockPath: string): Promise<string> {
  const r = await io.run(['cat', `${lockPath}/owner.json`])
  if (r.exitCode !== 0 || r.stdout.trim() === '') return 'unknown (no owner.json yet)'
  const data = JSON.parse(r.stdout) as { owner?: unknown; at?: unknown }
  return `${String(data.owner)} since ${typeof data.at === 'number' ? new Date(data.at).toISOString() : String(data.at)}`
}

async function runOk(io: Io, argv: string[]): Promise<void> {
  const r = await io.run(argv)
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${r.exitCode}: ${r.stderr.trim()}`)
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

function randomTag(): string {
  return Math.random().toString(36).slice(2, 10)
}
