import type { EngineInterface, Register, Timer } from 'claude-code'
import { describeTool, parseChannelTag, renderFinal, renderLive, type EndReason, type Turn } from '../src/card'
import { CHANNEL_SERVER, DISPATCH, routerDeny } from '../src/gate'
import { answerNotPosted, followUp, handedBack, lostWorker, routerContext, takeOver, workerBrief } from '../src/prompts'
import * as tasks from '../src/tasks'
import * as tg from '../src/telegram'
import type { TgIo } from '../src/telegram'

// The Telegram session is a Router: a new request becomes a background worker
// (a subagent this mod spawns), a reply to any message of a task goes straight
// to that task's worker, and each worker's answer is posted under the message
// that started its run. Every run that lasts SHOW_AFTER gets a progress card.
//
// A worker this mod spawned or woke runs beneath this mod's own frame, so the
// host skips this mod's tool.call hook for the worker's calls (re-entry; checked
// with Claude Code 2.1.316). turn.complete still reaches this mod, so everything
// about a worker happens there: its answer, its card's last line, its handbacks.

export const SHOW_AFTER = 30_000
export const EDIT_EVERY = 10_000
/** a long single tool shows no events; refresh the elapsed time this often */
export const HEARTBEAT = 60_000
const TICK = 2_000
/** a channel prompt binds to a Router turn that starts within this */
const PENDING_TTL = 10_000
const SEND_ATTEMPTS = 3
/** a run whose end never came is dropped after this */
const STALE = 6 * 3600_000
/** Telegram refuses a text over 4096 characters */
const MAX_TEXT = 4000
export const WORKER_MODEL = 'opus'
/** this plugin's name: the origin of the prompts it submits */
const PLUGIN = 'tg-router'

type Tracked = Turn & { attempts: number; chain: Promise<void> }
/**
 * A Telegram message that reached the Router and may be dispatched; `replaces`
 * names the task whose worker is gone when the message replied to it.
 */
type Request = { chatId: string; messageId: number; text: string; replaces?: string }

/** Router turns by turnId, worker runs by `w:<worker name>` */
const runs = new Map<string, Tracked>()
/** the channel prompt that will start the next Router turn */
let armed: (Request & { at: number }) | null = null
/** the Router turn now running, when it is tracked */
let active: string | null = null
let ticker: Timer | null = null
/** requests the Router may dispatch, by `chat:message` (message ids count per chat) */
const requests = new Map<string, Request>()
const reqKey = (chatId: string, messageId: number) => `${chatId}:${messageId}`
/** workers whose last answer Telegram refused: their completion notice reaches the Router */
const unposted = new Set<string>()
/** subagent ids that belong to no task (a worker's own helpers), so they are looked up once */
const notWorkers = new Set<string>()
/** the channel's inbox, for the photo rule of the gate; set at session.start */
let inbox: string | undefined
/** a worker's line that hands a follow-up back: `HANDBACK <message_id>: <reason>` */
const HANDBACK_LINE = /^HANDBACK\s+(\d+)\s*[:：]\s*(.*)$/gm

function enqueue(t: Tracked, op: () => Promise<void>): Promise<void> {
  t.chain = t.chain.then(op, op).catch(() => {})
  return t.chain
}

function io($: EngineInterface): TgIo {
  return {
    stateDir: () => $.env.get('TELEGRAM_STATE_DIR'),
    home: () => $.env.get('HOME'),
    read: async (path) => String(await $.fs.read(path)),
    fetch: (url, init) => $.http.fetch(url, init),
    log: async (line) => {
      try {
        await $.ui.log(`tg-router: ${line}`, { to: 'debug' })
      } catch { /* nothing to report to */ }
    },
  }
}

const kv = ($: EngineInterface): tasks.Kv => ({ get: (k) => $.store.get(k), set: (k, v) => $.store.set(k, v) })

function clip(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}…（后面还有 ${text.length - MAX_TEXT} 字，见终端）`
}

async function inboxDir($: EngineInterface): Promise<string> {
  return `${await tg.stateDir(io($))}/inbox`
}

function track($: EngineInterface, key: string, chatId: string, replyTo: number | undefined, now: number): void {
  runs.set(key, {
    chatId,
    ...(replyTo ? { replyTo } : {}),
    startedAt: now,
    tools: 0,
    recent: [],
    dirty: false,
    lastEditAt: now,
    done: false,
    attempts: 0,
    chain: Promise.resolve(),
  })
  ticker ??= $.clock.every(TICK, () => void tick($))
}

async function tick($: EngineInterface): Promise<void> {
  const host = io($)
  const now = await $.clock.now()
  for (const [id, t] of runs) {
    if (t.done) continue
    if (now - t.startedAt > STALE) {
      runs.delete(id)
      continue
    }
    if (t.messageId === undefined) {
      if (now - t.startedAt < SHOW_AFTER || t.attempts >= SEND_ATTEMPTS) continue
      t.attempts++
      t.dirty = false
      t.lastEditAt = now
      await enqueue(t, async () => {
        if (t.messageId !== undefined) return
        t.messageId = await tg.send(host, t.chatId, renderLive(t, now), t.replyTo)
        // a reply to a worker's card reaches the worker too
        if (t.messageId !== undefined && id.startsWith('w:')) await tasks.addMessage(kv($), id.slice(2), t.messageId, now)
      })
    } else if ((t.dirty && now - t.lastEditAt >= EDIT_EVERY) || now - t.lastEditAt >= HEARTBEAT) {
      t.dirty = false
      t.lastEditAt = now
      await enqueue(t, () => tg.edit(host, t.chatId, t.messageId!, renderLive(t, now)))
    }
  }
  if (runs.size === 0 && ticker) {
    ticker.cancel()
    ticker = null
  }
}

/** Ends a run's card: the final line replaces the live text. Answers whether a card was shown. */
function endCard($: EngineInterface, key: string, reason: EndReason, durationMs: number): boolean {
  const t = runs.get(key)
  if (!t) return false
  t.done = true
  runs.delete(key)
  const shown = t.messageId !== undefined
  const final = renderFinal(t, reason, durationMs)
  // The edit runs on its own timer dispatch, so the turn never waits on Telegram.
  $.clock.after(0, () => void enqueue(t, async () => {
    if (t.messageId !== undefined) await tg.edit(io($), t.chatId, t.messageId, final)
  }))
  return shown
}

/** The task whose worker runs loop `agentId`: by the id once known, else by the loop's name. */
async function taskFor($: EngineInterface, agentId: string): Promise<tasks.Task | undefined> {
  if (notWorkers.has(agentId)) return undefined
  const known = await tasks.byAgent(kv($), agentId)
  if (known) return known
  const row = (await $.agent.list()).find((a) => a.id === agentId)
  const task = row?.name ? await tasks.byName(kv($), row.name) : undefined
  if (!task) {
    notWorkers.add(agentId)
    return undefined
  }
  await tasks.setAgent(kv($), task.name, agentId)
  return { ...task, agentId }
}

type DispatchArgs = { chat_id?: unknown; message_id?: unknown; title?: unknown; ack?: unknown }

async function dispatch($: EngineInterface, a: DispatchArgs): Promise<string> {
  const messageId = Number(a.message_id)
  const title = typeof a.title === 'string' ? a.title.trim() : ''
  const ack = typeof a.ack === 'string' ? a.ack.trim() : ''
  if (!title || !ack) throw new Error('dispatch 需要 title 和 ack')
  const key = reqKey(String(a.chat_id), messageId)
  const req = requests.get(key)
  if (!req) throw new Error(`没有等待派活的 Telegram 消息 ${key}（只能派发本次会话收到、还没派过的消息）`)
  const name = `tg-${req.chatId}-${messageId}`
  const now = await $.clock.now()
  // the task exists before the worker starts, so even a first run that ends at once finds it
  await tasks.create(kv($), { name, title, chatId: req.chatId, rootId: messageId, request: req.text, messageIds: [messageId], createdAt: now })
  const spawned = await $.agent
    .spawn({ prompt: workerBrief(title, req.text), description: title, name, model: WORKER_MODEL })
    .catch(async (err) => {
      await tasks.remove(kv($), name)
      throw err
    })
  if (spawned.deny !== undefined) {
    await tasks.remove(kv($), name)
    throw new Error(`worker 没有启动：${spawned.deny}`)
  }
  requests.delete(key)
  if (spawned.agentId) await tasks.setAgent(kv($), name, spawned.agentId)
  // a reply to any message of the gone worker's task now reaches this one
  if (req.replaces) await tasks.absorb(kv($), name, req.replaces)
  track($, `w:${name}`, req.chatId, messageId, now)
  const ackId = await tg.send(io($), req.chatId, clip(ack), messageId, true)
  if (ackId !== undefined) await tasks.addMessage(kv($), name, ackId, now)
  return `已派给 worker ${name}（${title}）。它的回答会由 host 发到 Telegram，你不用再回复。`
}

/**
 * Gives the follow-ups a worker's answer hands back to the Router, and answers
 * the rest of the answer. A line names a follow-up of this task, never its request.
 */
async function handBack($: EngineInterface, task: tasks.Task, answer: string): Promise<string> {
  const back = [...answer.matchAll(HANDBACK_LINE)].map((m) => ({ messageId: Number(m[1]), reason: m[2]!.trim() || '（没有写理由）' }))
  for (const h of back) {
    if (!(h.messageId in task.followUps)) continue
    const text = (await tasks.removeMessage(kv($), task.name, h.messageId))!
    const key = reqKey(task.chatId, h.messageId)
    requests.set(key, { chatId: task.chatId, messageId: h.messageId, text })
    // queued for the Router, which may be mid-turn: the worker's end does not wait on it
    void $.prompt.submit({ text: handedBack(h.reason, text) }).catch(async (err) => {
      // the Router never got it: the follow-up stays the worker's
      requests.delete(key)
      await tasks.addFollowUp(kv($), task.name, h.messageId, text, await $.clock.now())
      await io($).log(`handback ${String(err)}`)
    })
  }
  return answer.replace(HANDBACK_LINE, '').trim()
}

/**
 * Registers `dispatch`. session.start does it; a reload of this mod (the
 * launcher's --plugin-dir is watched) drops the registration without a new
 * session.start, so the next Telegram message registers it again.
 */
let toolsReady = false
async function ensureTools($: EngineInterface): Promise<void> {
  if (toolsReady) return
    await $.tool.register({
      name: 'dispatch',
      description:
        'Hand one Telegram request to a new background worker. The host starts the worker with the original message, '
        + 'posts `ack` as a reply to that message, and later posts the worker\'s answers. Call once per message.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'chat_id of the Telegram message that holds the request' },
          message_id: { type: 'string', description: 'message_id of the Telegram message that holds the request' },
          title: { type: 'string', description: 'a short Chinese title, a few words' },
          ack: { type: 'string', description: 'one Chinese sentence for the person: the object and the expected result' },
        },
        required: ['chat_id', 'message_id', 'title', 'ack'],
      },
      isDeferred: false,
    })
  toolsReady = true
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    await ensureTools($)
    inbox = await inboxDir($)
    await tasks.prune(kv($), await $.clock.now())
    return out
  })

  on('prompt.submit', async ($, e, next) => {
    const o = e.origin
    // A worker's completion notice: its answer is already in Telegram.
    if (o?.kind === 'task-notification') {
      const open = await tasks.load(kv($))
      const mine = Object.values(open.tasks).find(
        (t) => new RegExp(`\\b${t.name}\\b`).test(e.text) || (t.agentId && e.text.includes(t.agentId)),
      )
      if (mine && !unposted.delete(mine.name)) return { drop: 'tg-router: 这个 worker 的回答已经发到 Telegram' }
      armed = null
      if (!mine) return next(e)
      return next({ ...e, context: [...(e.context ?? []), answerNotPosted(mine.chatId, mine.rootId)] })
    }
    // a follow-up a worker handed back, resubmitted by handBack below
    const handed = o?.kind === 'plugin' && o.name === PLUGIN
    if (!(handed || (o?.kind === 'channel' && o.server === CHANNEL_SERVER))) {
      armed = null
      return next(e)
    }
    const tag = parseChannelTag(e.text)
    if (!tag || tag.messageId === undefined) {
      armed = null
      return next(e)
    }
    await ensureTools($)
    const now = await $.clock.now()
    const req: Request = { chatId: tag.chatId, messageId: tag.messageId, text: e.text }

    // a handed-back follow-up still replies to its task's message: it must not go back to that worker
    const owner = !handed && tag.replyTo !== undefined ? await tasks.byMessage(kv($), tag.chatId, tag.replyTo) : undefined
    if (owner) {
      await tasks.addFollowUp(kv($), owner.name, tag.messageId, e.text, now)
      const sent = await $.session.send({ to: owner.name, text: followUp(tag.messageId, e.text) })
      if (sent.isDelivered) {
        await tasks.setState(kv($), owner.name, 'running', now)
        if (!runs.has(`w:${owner.name}`)) track($, `w:${owner.name}`, tag.chatId, tag.messageId, now)
        return { drop: `tg-router: 已转给 worker（${owner.title}）` }
      }
      await tasks.setState(kv($), owner.name, 'lost', now)
      await tasks.removeMessage(kv($), owner.name, tag.messageId)
      await tg.send(io($), tag.chatId, `这件事（${owner.title}）原来的 worker 已经不在了，可能是会话重启过。已转给前台重新派活。`, tag.messageId, true)
      const lost: Request = { ...req, text: takeOver(owner.request, e.text), replaces: owner.name }
      requests.set(reqKey(tag.chatId, tag.messageId), lost)
      armed = { ...lost, at: now }
      return next({ ...e, context: [...(e.context ?? []), routerContext(await tasks.openTasks(kv($), tag.chatId), now), lostWorker(owner.title)] })
    }

    // handBack already holds the follow-up's own text for dispatch
    if (!handed) requests.set(reqKey(tag.chatId, tag.messageId), req)
    armed = { ...req, at: now }
    return next({ ...e, context: [...(e.context ?? []), routerContext(await tasks.openTasks(kv($), tag.chatId), now)] })
  })

  on('turn.start', async ($, e, next) => {
    // a subagent's turn: the armed channel prompt belongs to the Router's next turn
    if (e.agentId) return next(e)
    const p = armed
    armed = null
    const now = await $.clock.now()
    if (p && now - p.at <= PENDING_TTL) {
      track($, e.turnId, p.chatId, p.messageId, now)
      active = e.turnId
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const deny = routerDeny(e as never, inbox ?? (await inboxDir($)))
    if (deny) return { deny }
    // registered tools: the engine's types list built-in names only
    const tool: string = e.tool
    if (tool === DISPATCH) {
      try {
        return { result: await dispatch($, e as DispatchArgs) }
      } catch (err) {
        return { deny: err instanceof Error ? err.message : String(err) }
      }
    }
    // a worker's own calls never reach here in a live session (see the top)
    const t = !e.agentId && active ? runs.get(active) : undefined
    if (!t || t.done) return next(e)
    t.tools++
    t.dirty = true
    const label = describeTool(e as never)
    t.current = { label, since: await $.clock.now() }
    let ok = false
    try {
      const r = await next(e)
      ok = !(r as { isError?: boolean }).isError
      return r
    } finally {
      if (t.current?.label === label) delete t.current
      t.recent = [...t.recent, `${label} ${ok ? '✓' : '✗'}`].slice(-2)
      t.dirty = true
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'tg-router 的工具检查出错，这次调用没有执行' }))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const task = await taskFor($, e.agentId)
      if (!task) return next(e)
      const answer = await handBack($, task, e.answer)
      const key = `w:${task.name}`
      const run = runs.get(key)
      const replyTo = run?.replyTo ?? task.rootId
      const reason = e.reason as EndReason
      // a card send still in flight lands before the final edit endCard queues behind it
      await run?.chain
      const carded = endCard($, key, reason, e.durationMs)
      const now = await $.clock.now()
      await tasks.setState(kv($), task.name, 'idle', now)
      // an answer of HANDBACK lines alone posts nothing: those messages are the Router's now
      const onlyHandBacks = reason === 'answer' && !answer && e.answer.trim() !== ''
      // the answer goes out as written, as the channel's reply tool would send it:
      // card redaction would also blank the paths and commit ids it reports
      const text = reason === 'answer' && answer
        ? clip(answer)
        : carded || onlyHandBacks
          ? null
          : renderFinal({ chatId: task.chatId, startedAt: 0, tools: 0, recent: [], dirty: false, lastEditAt: 0, done: true }, reason, e.durationMs)
      if (text) {
        const id = await tg.send(io($), task.chatId, text, replyTo, true)
        if (id !== undefined) await tasks.addMessage(kv($), task.name, id, now)
        else unposted.add(task.name)
      }
      return next(e)
    }
    if (runs.has(e.turnId)) {
      endCard($, e.turnId, e.reason as EndReason, e.durationMs)
      if (active === e.turnId) active = null
    }
    return next(e)
  })
}
