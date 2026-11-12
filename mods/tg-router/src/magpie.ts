// magpie-tasks' Telegram index, read only (magpie-tasks plan section 10.1). Under claude-magpie the
// magpie-tasks plugin routes each worker's model, may hand a daily task to another executor, may
// turn it into a long task led by an architect session, and sends messages of its own. It records
// all of that in `<state dir>/index/telegram.json`; this mod reads it to send a follow-up to the
// task's current executor, to post a replacement executor's answer under the task, and to leave
// replies to magpie-tasks' messages and to long tasks to magpie-tasks, which sits inside this mod.

/** The Magpie gateway: a session that talks to it was started by claude-magpie. */
export const MAGPIE_GATEWAY = 'http://127.0.0.1:3425'

/**
 * The reason magpie-tasks refuses a follow-up's send with when it took the person's words as their
 * answer to the task's open question (its src/router.ts `DECISION_HANDLED`): the words were handled
 * and the person told, nothing went to the worker. What follows the prefix is what they were told.
 */
export const DECISION_HANDLED = 'magpie-tasks answered a decision: '

export type MessageKind = 'long' | 'magpie' | 'rating' | 'decision'

/** The index as magpie-tasks writes it (its src/types.ts `TelegramIndex`). */
export type MagpieIndex = {
  schema: 1
  /** by `chat:message`: the messages magpie-tasks sent, and those it took to a long task */
  messages: Record<string, { taskId: string; kind: MessageKind; decisionId?: string }>
  /** by this mod's worker name: the task, the agent now answering for it, and whether it became a long task */
  workers: Record<string, { taskId: string; ownerAgentId: string; long: boolean }>
  /** agent id → this mod's worker name, for executors that replaced the worker */
  agents: Record<string, string>
}

/** The host calls reading the index needs; register.ts builds them from $. */
export type MagpieIo = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
}

/** `<MAGPIE_TASKS_STATE_DIR, else ~/.config/magpie-tasks>/index/telegram.json`. */
export function indexPath(home: string, env: string | undefined): string {
  const dir = env !== undefined && env !== '' ? env : `${home.replace(/\/+$/, '')}/.config/magpie-tasks`
  return `${dir.replace(/\/+$/, '')}/index/telegram.json`
}

export function emptyIndex(): MagpieIndex {
  return { schema: 1, messages: {}, workers: {}, agents: {} }
}

/** The index in `text` (the file at `path`); text that is not the index throws. */
export function parseIndex(text: string, path: string): MagpieIndex {
  const raw = JSON.parse(text) as Partial<MagpieIndex> | null
  const isMap = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (raw === null || raw.schema !== 1 || !isMap(raw.messages) || !isMap(raw.workers) || !isMap(raw.agents)) {
    throw new Error(`tg-router: ${path} is not a magpie-tasks Telegram index (schema 1)`)
  }
  return raw as MagpieIndex
}

/** The index at `path`; empty while magpie-tasks has written none. A file that is not the index throws. */
export async function readIndex(io: MagpieIo, path: string): Promise<MagpieIndex> {
  if (!(await io.exists(path))) return emptyIndex()
  return parseIndex(await io.read(path), path)
}

/** magpie-tasks' record of a worker: its task, current executor and whether it is a long task now. */
export function ownerOf(index: MagpieIndex, workerName: string): MagpieIndex['workers'][string] | undefined {
  return index.workers[workerName]
}

/** The worker name an agent answers for, when magpie-tasks made it the worker's executor. */
export function workerOfAgent(index: MagpieIndex, agentId: string): string | undefined {
  return index.agents[agentId]
}

/** The kind of a message magpie-tasks indexed, or undefined for a message it does not know. */
export function messageKind(index: MagpieIndex, chatId: string, messageId: number): MessageKind | undefined {
  return index.messages[`${chatId}:${messageId}`]?.kind
}

/**
 * A score the person gives a task by replying to one of its messages, `评分 N`, which magpie-tasks
 * records; the forms its `parseRating` reads (full-width digits and colon, a trailing 分 or stop).
 */
export const RATING_TEXT = /^\s*评分\s*[:：]?\s*[1-5１-５]\s*分?\s*[。.!！]?\s*$/

/** A channel message's text: what stands between its `<channel …>` tag and `</channel>`. */
export function channelBody(text: string): string {
  const open = /<channel\b[^>]*>/.exec(text)
  if (!open) return text
  const start = open.index + open[0].length
  const close = text.indexOf('</channel>', start)
  return text.slice(start, close < 0 ? text.length : close).trim()
}

/** The context line that tells magpie-tasks which of this mod's workers a reply it hands on belongs to. */
export function workerHintLine(workerName: string): string {
  return `[tg-router worker=${workerName}]`
}

/**
 * The context line beside a message typed in this terminal that gives magpie-tasks the message_id
 * this mod numbered it with, so its forward_long finds that message among several typed ones.
 */
export function terminalHintLine(messageId: number): string {
  return `[tg-router terminal message_id=${messageId}]`
}
