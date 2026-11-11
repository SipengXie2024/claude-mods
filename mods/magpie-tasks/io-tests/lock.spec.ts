// withLock against real directories and processes (plan section 12.1, lock row).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Io } from '../src/io'
import { withLock } from '../src/lock'
import { nodeIo } from './node-io'

const HERE = import.meta.dir
const SRC = resolve(HERE, '../src')
let root = ''

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mt-lock-')) })
afterAll(() => {
  // A failed run of the read-only locks test below can leave a directory without write permission.
  execFileSync('chmod', ['-R', 'u+rwx', root])
  rmSync(root, { recursive: true, force: true })
})

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

test('two concurrent withLock calls run one after the other', async () => {
  const locks = join(root, 'serial')
  const spans: { who: string; start: number; end: number }[] = []
  const hold = (who: string) => withLock(nodeIo(), locks, 'shared', who, async () => {
    const start = Date.now()
    await delay(300)
    spans.push({ who, start, end: Date.now() })
    return who
  })
  const results = await Promise.all([hold('a'), hold('b')])
  expect(results).toEqual(['a', 'b'])
  expect(spans).toHaveLength(2)
  const [first, second] = [...spans].sort((x, y) => x.start - y.start)
  expect(second!.start).toBeGreaterThanOrEqual(first!.end)
  expect(existsSync(join(locks, 'shared.lock'))).toBe(false)
}, 20_000)

test('a lock left by a killed holder is taken over once older than staleMs', async () => {
  const locks = join(root, 'stale')
  const lockDir = join(locks, 'victim.lock')
  const code = [
    `import { withLock } from ${JSON.stringify(join(SRC, 'lock.ts'))}`,
    `import { nodeIo } from ${JSON.stringify(join(HERE, 'node-io.ts'))}`,
    `await withLock(nodeIo(), ${JSON.stringify(locks)}, 'victim', 'victim-proc', async () => {`,
    `  console.log('held')`,
    `  await new Promise(() => setInterval(() => {}, 1000))`,
    `})`,
  ].join('\n')
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolveHeld, rejectHeld) => {
    child.stdout.on('data', (b: Buffer) => { if (b.toString().includes('held')) resolveHeld() })
    child.on('exit', c => rejectHeld(new Error(`holder exited early with ${c}`)))
  })
  const exited = new Promise(r => child.on('exit', r))
  child.kill('SIGKILL')
  await exited
  expect(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).owner).toBe('victim-proc')

  const io = nodeIo()
  const started = Date.now()
  const result = await withLock(io, locks, 'victim', 'taker', async () => {
    expect(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).owner).toBe('taker')
    return 'ok'
  }, { staleMs: 1500, waitMs: 10_000 })
  expect(result).toBe('ok')
  expect(Date.now() - started).toBeGreaterThan(500)   // it waited for the lock to become stale
  expect(io.logs.some(l => l.startsWith('magpie-tasks: lock wait victim held by victim-proc'))).toBe(true)
  expect(io.logs.some(l => l.startsWith('magpie-tasks: lock victim taken over from victim-proc'))).toBe(true)
  expect(readdirSync(locks)).toEqual([])   // neither the lock nor the renamed stale copy is left
}, 30_000)

test('waitMs elapsing throws an error naming the lock and its holder; waits run sleep through io.run', async () => {
  const locks = join(root, 'timeout')
  let releaseHolder = () => {}
  let markHeld = () => {}
  const held = new Promise<void>(r => { markHeld = r })
  const holder = withLock(nodeIo(), locks, 'busy', 'holder-a', async () => {
    markHeld()
    await new Promise<void>(r => { releaseHolder = r })
  })
  await held

  const io = nodeIo()
  const started = Date.now()
  const error = await withLock(io, locks, 'busy', 'waiter-b', async () => 'never', { waitMs: 400 }).then(
    () => { throw new Error('acquired a held lock') },
    (e: Error) => e,
  )
  expect(Date.now() - started).toBeGreaterThanOrEqual(400)
  expect(error.message).toMatch(/^lock busy not acquired within 400 ms; held by holder-a since /)

  const sleeps = io.calls.filter(c => c.method === 'run' && c.argv[0] === 'sleep')
  expect(sleeps.length).toBeGreaterThan(0)
  for (const c of sleeps) {
    if (c.method !== 'run') continue
    const seconds = Number(c.argv[1])
    expect(seconds).toBeGreaterThanOrEqual(0.025)
    expect(seconds).toBeLessThanOrEqual(0.1)
  }
  expect(io.calls.some(c => c.method === 'sleep')).toBe(false)
  expect(io.logs.filter(l => l.startsWith('magpie-tasks: lock wait busy held by holder-a'))).toHaveLength(1)

  releaseHolder()
  await holder
  expect(existsSync(join(locks, 'busy.lock'))).toBe(false)
}, 20_000)

// A lock directory as a holder killed after writing owner.json leaves it, last touched `ageMs` ago.
function crashedLock(locks: string, name: string, ageMs: number): string {
  const dir = join(locks, `${name}.lock`)
  mkdirSync(dir, { recursive: true })
  const at = Date.now() - ageMs
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ owner: 'crashed', at, token: `crashed.${at}.dead0000` }) + '\n')
  utimesSync(dir, at / 1000, at / 1000)
  return dir
}

test('several waiters on one stale lock: one takes it over and they hold it one at a time', async () => {
  const locks = join(root, 'stale-race')
  crashedLock(locks, 'index', 60_000)
  // Waiter A is held up for 300 ms just before it renames the stale lock, as a slow round trip
  // would; without a checked takeover it then moves the fresh lock another waiter has just made.
  const base = nodeIo()
  const slowA: Io = {
    ...base,
    run: async (argv, init) => {
      if (argv[0] === 'mv' && argv[2]?.includes('.lock.stale.')) await delay(300)
      return base.run(argv, init)
    },
  }
  let inside = 0
  let maxInside = 0
  const order: string[] = []
  const hold = (io: Io, who: string) => withLock(io, locks, 'index', who, async () => {
    inside++
    maxInside = Math.max(maxInside, inside)
    expect(JSON.parse(readFileSync(join(locks, 'index.lock', 'owner.json'), 'utf8')).owner).toBe(who)
    await delay(200)
    order.push(who)
    inside--
  })
  await Promise.all([hold(slowA, 'A'), ...['B', 'C', 'D', 'E'].map(who => hold(nodeIo(), who))])
  expect(maxInside).toBe(1)
  expect([...order].sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
  expect(readdirSync(locks)).toEqual([])   // no lock, renamed copy or takeover guard is left
}, 30_000)

test('a stale lock that cannot be removed fails within waitMs and names the lock and the cause', async () => {
  const locks = join(root, 'stuck')
  crashedLock(locks, 'x', 60_000)
  chmodSync(locks, 0o555)   // nothing in the locks directory can be created, renamed or removed
  try {
    const io = nodeIo()
    const started = Date.now()
    const error = await withLock(io, locks, 'x', 'me', async () => 'acquired', { waitMs: 500 }).then(
      () => { throw new Error('acquired a lock it could not take over') },
      (e: Error) => e,
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(error.message).toContain('lock x: ')
    expect(error.message).toContain('Permission denied')
    expect(io.calls.length).toBeLessThan(50)
  } finally {
    chmodSync(locks, 0o755)
  }
}, 20_000)
