// The tasks the Router dispatched, kept in the plugin's store so a reply to any
// message of a task still finds its worker after a restart.

export const STORE_KEY = 'tasks'
/** A task leaves the store this long after its last message in or out. */
export const KEEP_MS = 14 * 24 * 3600_000

export type TaskState = 'running' | 'idle' | 'lost'

export type Task = {
  /** the worker's name, `tg-<request message_id>`: where `$.session.send` delivers follow-ups */
  name: string
  /** the worker's loop id, once an event or the spawn named it */
  agentId?: string
  title: string
  chatId: string
  /** the request the task started from; answers reply to it */
  rootId: number
  /** the request as the worker was first given it */
  request: string
  /** the follow-ups sent to the worker, by message_id, so a handback can return the text */
  followUps: Record<string, string>
  /** request, ack, card, answers and follow-ups: a reply to any of them routes here */
  messageIds: number[]
  state: TaskState
  /** how the worker's last run ended, once one has: a restart's notice about an answered run is wrong */
  lastEnd?: 'answer' | 'aborted' | 'refusal' | 'error'
  createdAt: number
  lastAt: number
}

/** tasks by worker name; `byMessage` maps `chat:message` to a worker name */
export type Tasks = { tasks: Record<string, Task>; byMessage: Record<string, string> }

export type Kv = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}

const msgKey = (chatId: string, messageId: number) => `${chatId}:${messageId}`

export async function load(kv: Kv): Promise<Tasks> {
  const v = (await kv.get(STORE_KEY)) as Tasks | undefined
  return v ?? { tasks: {}, byMessage: {} }
}

let writes: Promise<unknown> = Promise.resolve()

/**
 * Loads, changes and saves the store as one step. Hooks run concurrently (two
 * workers ending at once, a card sent while a follow-up arrives), and two
 * read-modify-writes of the one key that overlap would drop one change.
 */
function update<T>(kv: Kv, change: (t: Tasks) => T): Promise<T> {
  const run = writes.then(async () => {
    const t = await load(kv)
    const out = change(t)
    await kv.set(STORE_KEY, t)
    return out
  })
  writes = run.catch(() => {}) // the caller gets the error; the next write still runs
  return run
}

function taskOf(t: Tasks, name: string): Task {
  const task = t.tasks[name]
  if (!task) throw new Error(`tg-router: no task ${name}`)
  return task
}

export function create(kv: Kv, task: Omit<Task, 'state' | 'lastAt' | 'followUps'>): Promise<Task> {
  return update(kv, (t) => {
    const full: Task = { ...task, followUps: {}, state: 'running', lastAt: task.createdAt }
    t.tasks[full.name] = full
    for (const id of full.messageIds) t.byMessage[msgKey(full.chatId, id)] = full.name
    return full
  })
}

export async function byMessage(kv: Kv, chatId: string, messageId: number): Promise<Task | undefined> {
  const t = await load(kv)
  const name = t.byMessage[msgKey(chatId, messageId)]
  return name ? t.tasks[name] : undefined
}

export async function byName(kv: Kv, name: string): Promise<Task | undefined> {
  return (await load(kv)).tasks[name]
}

export async function byAgent(kv: Kv, agentId: string): Promise<Task | undefined> {
  return Object.values((await load(kv)).tasks).find((t) => t.agentId === agentId)
}

export function setAgent(kv: Kv, name: string, agentId: string): Promise<void> {
  return update(kv, (t) => {
    taskOf(t, name).agentId = agentId
  })
}

/** Records a message of the task (sent or received) and moves its clock. */
export function addMessage(kv: Kv, name: string, messageId: number, now: number): Promise<void> {
  return update(kv, (t) => {
    const task = taskOf(t, name)
    if (!task.messageIds.includes(messageId)) task.messageIds.push(messageId)
    task.lastAt = now
    t.byMessage[msgKey(task.chatId, messageId)] = name
  })
}

/** Records a follow-up sent to the task's worker, with its text. */
export function addFollowUp(kv: Kv, name: string, messageId: number, text: string, now: number): Promise<void> {
  return update(kv, (t) => {
    const task = taskOf(t, name)
    if (!task.messageIds.includes(messageId)) task.messageIds.push(messageId)
    task.followUps[messageId] = text
    task.lastAt = now
    t.byMessage[msgKey(task.chatId, messageId)] = name
  })
}

/** A handed-back or undelivered follow-up stops routing to the task; answers its text. */
export function removeMessage(kv: Kv, name: string, messageId: number): Promise<string | undefined> {
  return update(kv, (t) => {
    const task = taskOf(t, name)
    const text = task.followUps[messageId]
    task.messageIds = task.messageIds.filter((id) => id !== messageId)
    delete task.followUps[messageId]
    delete t.byMessage[msgKey(task.chatId, messageId)]
    return text
  })
}

export function setState(kv: Kv, name: string, state: TaskState, now: number): Promise<void> {
  return update(kv, (t) => {
    const task = taskOf(t, name)
    task.state = state
    task.lastAt = now
  })
}

/** The worker's run ended: the task is idle, and how the run ended is kept. */
export function ended(kv: Kv, name: string, end: NonNullable<Task['lastEnd']>, now: number): Promise<void> {
  return update(kv, (t) => {
    const task = taskOf(t, name)
    task.state = 'idle'
    task.lastEnd = end
    task.lastAt = now
  })
}

/** Drops a task whose worker never started. */
export function remove(kv: Kv, name: string): Promise<void> {
  return update(kv, (t) => {
    const task = taskOf(t, name)
    for (const id of task.messageIds) delete t.byMessage[msgKey(task.chatId, id)]
    delete t.tasks[name]
  })
}

/**
 * Moves the messages of a task whose worker is gone to the task that took its
 * work over. Two replies to one gone task make two new tasks; the first takes
 * the messages, so the old task is already gone for the second.
 */
export function absorb(kv: Kv, into: string, from: string): Promise<void> {
  return update(kv, (t) => {
    const old = t.tasks[from]
    if (!old) return
    const task = taskOf(t, into)
    for (const id of old.messageIds) {
      if (!task.messageIds.includes(id)) task.messageIds.push(id)
      t.byMessage[msgKey(task.chatId, id)] = into
    }
    delete t.tasks[from]
  })
}

/** Drops tasks whose last message is older than KEEP_MS; answers how many went. */
export function prune(kv: Kv, now: number): Promise<number> {
  return update(kv, (t) => {
    let n = 0
    for (const [name, task] of Object.entries(t.tasks)) {
      if (now - task.lastAt <= KEEP_MS) continue
      for (const id of task.messageIds) delete t.byMessage[msgKey(task.chatId, id)]
      delete t.tasks[name]
      n++
    }
    return n
  })
}

/** Open tasks of one chat for the Router's context, newest first. */
export async function openTasks(kv: Kv, chatId: string, limit = 8): Promise<Task[]> {
  const t = await load(kv)
  return Object.values(t.tasks)
    .filter((x) => x.chatId === chatId && x.state !== 'lost')
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit)
}
