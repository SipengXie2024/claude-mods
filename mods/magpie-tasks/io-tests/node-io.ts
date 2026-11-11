// The Io interface on Node APIs, for bun tests and eval scripts (hooks have no `process`, so they
// use hostIo). It runs the same real commands and file operations as hostIo, and keeps a record
// of the calls made through it so tests can check which primitives a module used.
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Io } from '../src/io'

// The host's per-call limit: $.fs.read/write reject over it, $.process.run keeps only this many bytes
// of each stream (and hostIo throws when it cuts one).
const LIMIT = 4_194_304

export type IoCall =
  | { method: 'run'; argv: string[] }
  | { method: 'sleep'; ms: number }
  | { method: 'fetch'; url: string }

export interface NodeIo extends Io {
  readonly calls: IoCall[]
  readonly logs: string[]
}

export function nodeIo(o?: { echoLog?: boolean }): NodeIo {
  const calls: IoCall[] = []
  const logs: string[] = []
  return {
    calls,
    logs,
    run(argv, init) {
      calls.push({ method: 'run', argv: [...argv] })
      return run(argv, init)
    },
    async read(path) {
      const size = (await stat(path)).size
      if (size > LIMIT) throw new Error(`read ${path}: ${size} bytes is over the 4 MiB limit of $.fs.read`)
      return readFile(path, 'utf8')
    },
    async write(path, text) {
      const size = Buffer.byteLength(text, 'utf8')
      if (size > LIMIT) throw new Error(`write ${path}: ${size} bytes is over the 4 MiB limit of $.fs.write`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    },
    exists: async (path) => existsSync(path),
    async stat(path) {
      const s = await stat(path)
      return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other', size: s.size, mtimeMs: s.mtimeMs }
    },
    async realPath(path) {
      try {
        return await realpath(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async list(path) {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map(e => ({ name: e.name, kind: e.isFile() ? 'file' : e.isDirectory() ? 'dir' : 'other' }))
    },
    now: async () => Date.now(),
    async sleep(ms) {
      calls.push({ method: 'sleep', ms })
      await new Promise(resolve => setTimeout(resolve, ms))
    },
    async fetch(url, init) {
      calls.push({ method: 'fetch', url })
      const r = await fetch(url, init)
      return { status: r.status, ok: r.ok, text: await r.text() }
    },
    env: async (name) => process.env[name],
    async log(line) {
      const text = `magpie-tasks: ${line}`
      logs.push(text)
      if (o?.echoLog) console.error(text)
    },
  }
}

// Same contract as hostIo.run on $.process.run: no shell, any exit code resolves, a signal reads as
// exit 1, rejects when the command cannot start, outlives timeoutMs (default 30 s), or writes more
// than 4 MiB to either stream.
function run(argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [cmd, ...args] = argv
  if (cmd === undefined) return Promise.reject(new Error('run: empty argv'))
  const timeoutMs = init?.timeoutMs ?? 30_000
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: init?.cwd,
      env: { ...process.env, ...init?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => err.push(b))
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error(`${cmd}: still running after ${timeoutMs} ms`))
      const stdout = Buffer.concat(out)
      const stderr = Buffer.concat(err)
      if (stdout.length > LIMIT || stderr.length > LIMIT) {
        return reject(new Error(`${cmd}: output exceeded the 4 MiB limit of $.process.run`))
      }
      resolve({ exitCode: code ?? 1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
    })
    child.stdin.on('error', () => {})   // a child that exits without reading stdin closes the pipe; its exit code tells the outcome
    child.stdin.end(init?.stdin ?? '')
  })
}
