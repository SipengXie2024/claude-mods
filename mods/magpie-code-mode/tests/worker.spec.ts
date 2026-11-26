import { describe, test, expect, afterAll } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const workerPath = path.resolve(import.meta.dir, '../src/worker.mjs')
const sockPath = path.join(os.tmpdir(), `magpie-cm-test-${process.pid}-${Date.now()}.sock`)
const token = `tok-${crypto.randomUUID()}`
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cm-work-'))

let proc: ReturnType<typeof Bun.spawn> | null = null

async function startWorker() {
  proc = Bun.spawn(['bun', workerPath, sockPath, token], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (!buf.includes('READY')) {
    const { value, done } = await reader.read()
    if (done) throw new Error('worker exited before READY')
    buf += decoder.decode(value)
  }
  reader.releaseLock()
}

async function req<T>(endpoint: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const res = await fetch(`http://localhost${endpoint}`, {
    method,
    unix: sockPath,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as RequestInit)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

// Real host bridge backed by real filesystem and real Bun.spawnSync for Bash.
async function runWithRealHost(code: string, loopId = 'main', timeoutMs = 15_000) {
  let step: any = await req('/eval', 'POST', {
    loopId,
    code,
    timeoutMs,
    cwd: workDir,
    toolNames: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
  })
  let toolRounds = 0
  let maxBatch = 0
  while (step.status !== 'done') {
    const calls: any[] = step.calls ?? []
    if (calls.length > 0) {
      toolRounds += 1
      if (calls.length > maxBatch) maxBatch = calls.length
    }
    const results = await Promise.all(
      calls.map(async (c: any) => {
        if (c.kind === 'sleep') {
          await Bun.sleep(c.ms ?? 0)
          return { id: c.id, value: { ok: true } }
        }
        if (c.kind === 'fs_exists') {
          return { id: c.id, value: { exists: fs.existsSync(c.path) } }
        }
        if (c.kind === 'tool' && c.tool === 'Read') {
          const fp = c.input.file_path
          if (!fs.existsSync(fp)) return { id: c.id, value: { isError: true, text: `ENOENT: ${fp}` } }
          const allLines = fs.readFileSync(fp, 'utf8').split('\n')
          const start = Math.max(1, c.input.offset ?? 1)
          const limit = c.input.limit ?? 2000
          const slice = allLines.slice(start - 1, start - 1 + limit)
          return {
            id: c.id,
            value: {
              result: {
                type: 'text',
                file: {
                  filePath: fp,
                  content: slice.join('\n'),
                  startLine: start,
                  numLines: slice.length,
                  totalLines: allLines.length,
                },
              },
            },
          }
        }
        if (c.kind === 'tool' && c.tool === 'Write') {
          fs.mkdirSync(path.dirname(c.input.file_path), { recursive: true })
          fs.writeFileSync(c.input.file_path, c.input.content, 'utf8')
          return { id: c.id, value: { result: { filePath: c.input.file_path } } }
        }
        if (c.kind === 'tool' && c.tool === 'Edit') {
          const cur = fs.readFileSync(c.input.file_path, 'utf8')
          if (!cur.includes(c.input.old_string)) {
            return { id: c.id, value: { isError: true, text: 'old_string not found' } }
          }
          const next = c.input.replace_all
            ? cur.split(c.input.old_string).join(c.input.new_string)
            : cur.replace(c.input.old_string, () => c.input.new_string)
          fs.writeFileSync(c.input.file_path, next, 'utf8')
          return { id: c.id, value: { result: { filePath: c.input.file_path } } }
        }
        if (c.kind === 'tool' && c.tool === 'Bash') {
          const r = Bun.spawnSync(['bash', '-c', c.input.command], { cwd: workDir })
          const stdout = new TextDecoder().decode(r.stdout)
          const stderr = new TextDecoder().decode(r.stderr)
          if (r.exitCode !== 0) {
            return {
              id: c.id,
              value: {
                isError: true,
                text: `Exit code ${r.exitCode}\n${stdout}${stderr}`,
                result: { stdout, stderr },
              },
            }
          }
          return { id: c.id, value: { result: { stdout, stderr } } }
        }
        return { id: c.id, error: `unhandled call ${c.kind}/${c.tool}` }
      }),
    )
    step = await req('/resume', 'POST', { execId: step.execId, results })
  }
  return { ...step, toolRounds, maxBatch }
}

afterAll(async () => {
  try {
    await req('/shutdown', 'POST', {})
  } catch {}
  try {
    proc?.kill()
  } catch {}
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {}
  try {
    fs.unlinkSync(sockPath)
  } catch {}
})

describe('magpie-code-mode worker', () => {
  test('starts over Unix socket and persists const/let/destructuring/functions across calls', async () => {
    await startWorker()
    const health = await req<{ ok: boolean }>('/health', 'GET')
    expect(health.ok).toBe(true)

    const r1 = await runWithRealHost(`
      const base = 10;
      let count = 0;
      const { a, b: renamed } = { a: 3, b: 4 };
      function inc(step) { count += step; return count + base; }
      log('init done');
      inc(a + renamed);
    `)
    expect(r1.isError).toBe(false)
    expect(r1.output).toContain('<log>\ninit done\n</log>')
    expect(r1.output).toContain('<result>\n17\n</result>')

    // Second call mutates shared global `count` through closure `inc` without desync!
    const r2 = await runWithRealHost(`
      const after = inc(5);
      ({ count, after, a, renamed });
    `)
    expect(r2.isError).toBe(false)
    expect(r2.output).toContain('count: 12')
    expect(r2.output).toContain('after: 22')
    expect(r2.output).toContain('a: 3')
    expect(r2.output).toContain('renamed: 4')
  })

  test('batches parallel Promise.all calls, supports $, file, write, edit (single & atomic batch), and auto-awaited object properties', async () => {
    const r = await runWithRealHost(`
      await Promise.all([
        write('a.txt', 'alpha 1\\nbeta 2\\n'),
        write('b.txt', JSON.stringify({ ok: true, n: 42 })),
      ]);
      const [aExists, cExists, bJson] = await Promise.all([
        file('a.txt').exists(),
        file('missing.txt').exists(),
        file('b.txt').json(),
      ]);
      // Atomic batch edit rejects missing anchor without modifying a.txt
      const bad = await edit('a.txt', [['alpha 1', 'ALPHA 1'], ['nope', 'x']], { soft: true });
      const stillOriginal = await file('a.txt').text();
      await edit('a.txt', [['alpha 1', 'ALPHA 1'], ['beta 2', 'BETA 2']]);
      const afterEdit = await file('a.txt').lines();
      ({
        aExists,
        cExists,
        bJson,
        badOk: bad.ok,
        stillOriginal,
        afterEdit,
        shellOut: $\`printf %s \${"hello 'world'"}\`.text(),
        grepNoMatch: $\`grep -q ZZZZ a.txt\`,
      });
    `)
    expect(r.isError).toBe(false)
    expect(r.maxBatch).toBeGreaterThanOrEqual(2)
    expect(r.output).toContain('aExists: true')
    expect(r.output).toContain('cExists: false')
    expect(r.output).toContain('badOk: false')
    expect(r.output).toContain('ALPHA 1')
    expect(r.output).toContain('BETA 2')
    expect(r.output).toContain("hello 'world'")
    expect(r.output).toContain('exitCode: 1')
  })

  test('isolates subagent loops, supports console ring buffer & preview, and resets cleanly', async () => {
    const sub = await runWithRealHost(`
      const subOnly = 'isolated';
      console.log('line-1');
      console.warn('line-2');
      ({ hasMainCount: typeof count !== 'undefined', tail: console.tail(2), prev: preview('abcdefghij', 5), subOnly });
    `, 'agent-sub-1')
    expect(sub.isError).toBe(false)
    expect(sub.output).toContain('hasMainCount: false')
    expect(sub.output).toContain('line-1')
    expect(sub.output).toContain('[warn] line-2')
    expect(sub.output).toContain('abcde')

    await req('/reset', 'POST', { loopId: 'main' })
    const afterReset = await runWithRealHost(`typeof count`)
    expect(afterReset.output).toContain('undefined')
  })
})
