// Task registry (plan sections 7.1, 7.3–7.6): task records and logs, claims, the Telegram index,
// the session index and small state files, all under opts.stateDir and shared across sessions.
// Writes are atomic (temporary file + mv) and read-modify-write happens under directory locks;
// reads take no lock. Lock order is always task-<id> before index.
import type { Io } from './io'
import { withLock } from './lock'
import type { AgentRecord, Claim, Options, TaskRecord, TelegramIndex } from './types'

type LogEntry = { type: string; [k: string]: unknown }
type LockOptions = { waitMs?: number; staleMs?: number }

const TASK_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/

export class Registry {
  private readonly agentTasks = new Map<string, string>()   // agentId → taskId, filled by byAgent
  private tmpSeq = 0

  constructor(private readonly io: Io, private readonly opts: Options, private readonly owner: string) {}

  private get tasksDir() { return `${this.opts.stateDir}/tasks` }
  private get claimsDir() { return `${this.opts.stateDir}/claims` }
  private get locksDir() { return `${this.opts.stateDir}/locks` }
  private taskPath(id: string) { return `${this.tasksDir}/${checkId(id)}.json` }
  private logPath(id: string) { return `${this.tasksDir}/${checkId(id)}.log.jsonl` }
  private get telegramPath() { return `${this.opts.stateDir}/index/telegram.json` }
  private get sessionsPath() { return `${this.opts.stateDir}/index/sessions.json` }
  private statePath(name: string) { return `${this.opts.stateDir}/state/${checkId(name)}.json` }

  async create(t: Omit<TaskRecord, 'schema' | 'createdAt' | 'updatedAt'>): Promise<TaskRecord> {
    return this.lock(`task-${checkId(t.id)}`, async () => {
      const path = this.taskPath(t.id)
      if (await this.io.exists(path)) throw new Error(`task ${t.id} already exists`)
      const now = await this.io.now()
      const record: TaskRecord = { schema: 1, ...t, createdAt: now, updatedAt: now }
      await this.writeAtomic(path, json(record))
      await this.appendLog(t.id, { type: 'created', kind: record.kind, state: record.state })
      await this.syncSessions(t.id, [], sessionIds(record))
      return record
    })
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    const path = this.taskPath(id)
    if (!(await this.io.exists(path))) return undefined
    return parseTask(await this.io.read(path), path)
  }

  async update(id: string, change: (t: TaskRecord) => void, log: LogEntry): Promise<TaskRecord> {
    return this.lock(`task-${checkId(id)}`, async () => {
      const path = this.taskPath(id)
      if (!(await this.io.exists(path))) throw new Error(`task ${id} does not exist`)
      const t = parseTask(await this.io.read(path), path)
      const before = sessionIds(t)
      change(t)
      if (t.id !== id || t.schema !== 1) throw new Error(`task ${id}: update must not change id or schema`)
      t.updatedAt = await this.io.now()
      await this.writeAtomic(path, json(t))
      await this.appendLog(id, log)
      await this.syncSessions(id, before, sessionIds(t))
      return t
    })
  }

  async list(filter?: (t: TaskRecord) => boolean): Promise<TaskRecord[]> {
    if (!(await this.io.exists(this.tasksDir))) return []
    const tasks: TaskRecord[] = []
    for (const entry of await this.io.list(this.tasksDir)) {
      if (entry.kind !== 'file' || !TASK_FILE.test(entry.name)) continue
      const path = `${this.tasksDir}/${entry.name}`
      const t = parseTask(await this.io.read(path), path)
      if (!filter || filter(t)) tasks.push(t)
    }
    return tasks.sort((a, b) => a.createdAt - b.createdAt)
  }

  // Resolves both the current owner session and earlier ones (previousSessionIds); a caller that
  // needs the current owner compares t.owner.sessionId itself.
  async bySession(sessionId: string): Promise<TaskRecord | undefined> {
    const sessions = await this.readJson<Record<string, string>>(this.sessionsPath, {})
    const taskId = sessions[sessionId]
    return taskId === undefined ? undefined : this.get(taskId)
  }

  async byAgent(agentId: string): Promise<{ task: TaskRecord; agent: AgentRecord } | undefined> {
    const cached = this.agentTasks.get(agentId)
    if (cached !== undefined) {
      const task = await this.get(cached)
      const agent = task?.agents[agentId]
      if (task && agent) return { task, agent }
    }
    let found: { task: TaskRecord; agent: AgentRecord } | undefined
    for (const task of await this.list()) {
      for (const [id, agent] of Object.entries(task.agents)) {
        this.agentTasks.set(id, task.id)
        if (id === agentId) found = { task, agent }
      }
    }
    return found
  }

  async log(id: string, entry: LogEntry): Promise<void> {
    await this.lock(`task-${checkId(id)}`, async () => {
      if (!(await this.io.exists(this.taskPath(id)))) throw new Error(`task ${id} does not exist`)
      await this.appendLog(id, entry)
    })
  }

  async putClaim(c: Claim): Promise<void> {
    await this.lock('claims', () => this.writeAtomic(`${this.claimsDir}/${checkId(c.id)}.json`, json(c)))
  }

  // Finds the oldest unexpired claim that matches, removes it and returns it; expired claims are
  // removed on the way.
  async takeClaim(match: (c: Claim) => boolean, now: number): Promise<Claim | undefined> {
    return this.lock('claims', async () => {
      if (!(await this.io.exists(this.claimsDir))) return undefined
      const claims: { c: Claim; path: string }[] = []
      for (const entry of await this.io.list(this.claimsDir)) {
        if (entry.kind !== 'file' || !TASK_FILE.test(entry.name)) continue
        const path = `${this.claimsDir}/${entry.name}`
        claims.push({ c: JSON.parse(await this.io.read(path)) as Claim, path })
      }
      claims.sort((a, b) => a.c.createdAt - b.c.createdAt)
      let taken: Claim | undefined
      for (const { c, path } of claims) {
        if (c.expiresAt <= now) {
          await this.remove(path)
        } else if (taken === undefined && match(c)) {
          await this.remove(path)
          taken = c
        }
      }
      return taken
    })
  }

  async readIndex(): Promise<TelegramIndex> {
    const index = await this.readJson<TelegramIndex>(this.telegramPath, { schema: 1, messages: {}, workers: {}, agents: {} })
    if (index.schema !== 1) throw new Error(`${this.telegramPath}: unknown schema ${String(index.schema)}`)
    return index
  }

  async updateIndex(change: (x: TelegramIndex) => void): Promise<void> {
    await this.lock('index', async () => {
      const index = await this.readIndex()
      change(index)
      await this.writeAtomic(this.telegramPath, json(index))
    })
  }

  async readState<T>(name: string, empty: T): Promise<T> {
    return this.readJson(this.statePath(name), empty)
  }

  async writeState(name: string, value: unknown): Promise<void> {
    await this.writeAtomic(this.statePath(name), json(value))
  }

  lock<T>(name: string, fn: () => Promise<T>, o?: LockOptions): Promise<T> {
    return withLock(this.io, this.locksDir, name, this.owner, fn, o)
  }

  // Unlocked append; callers hold task-<id>.
  private async appendLog(id: string, entry: LogEntry): Promise<void> {
    const line = JSON.stringify({ at: await this.io.now(), session: this.owner, ...entry }) + '\n'
    const r = await this.io.run(['sh', '-c', 'cat >> "$1"', 'sh', this.logPath(id)], { stdin: line })
    if (r.exitCode !== 0) throw new Error(`append to ${this.logPath(id)} failed: ${r.stderr.trim()}`)
  }

  // Keeps index/sessions.json (session ID → task ID) in step with the record's owner sessions.
  private async syncSessions(taskId: string, before: string[], after: string[]): Promise<void> {
    const added = after.filter(id => !before.includes(id))
    const dropped = before.filter(id => !after.includes(id))
    if (added.length === 0 && dropped.length === 0) return
    await this.lock('index', async () => {
      const sessions = await this.readJson<Record<string, string>>(this.sessionsPath, {})
      for (const id of dropped) if (sessions[id] === taskId) delete sessions[id]
      for (const id of added) sessions[id] = taskId
      await this.writeAtomic(this.sessionsPath, json(sessions))
    })
  }

  private async readJson<T>(path: string, empty: T): Promise<T> {
    if (!(await this.io.exists(path))) return empty
    return JSON.parse(await this.io.read(path)) as T
  }

  private async writeAtomic(path: string, text: string): Promise<void> {
    const tmp = `${path}.tmp.${this.owner.replace(/[^A-Za-z0-9._-]/g, '_')}.${await this.io.now()}.${this.tmpSeq++}`
    await this.io.write(tmp, text)
    const r = await this.io.run(['mv', '-f', tmp, path])
    if (r.exitCode !== 0) throw new Error(`mv ${tmp} ${path} failed: ${r.stderr.trim()}`)
  }

  private async remove(path: string): Promise<void> {
    const r = await this.io.run(['rm', '-f', path])
    if (r.exitCode !== 0) throw new Error(`rm ${path} failed: ${r.stderr.trim()}`)
  }
}

function sessionIds(t: TaskRecord): string[] {
  return t.owner.kind === 'session' ? [t.owner.sessionId, ...t.owner.previousSessionIds] : []
}

function parseTask(text: string, path: string): TaskRecord {
  const t = JSON.parse(text) as TaskRecord
  if (t.schema !== 1) throw new Error(`${path}: unknown schema ${String(t.schema)}`)
  return t
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

// IDs become file names; refuse anything that could leave its directory.
function checkId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`invalid ID for a file name: ${JSON.stringify(id)}`)
  return id
}
