import type { EngineInterface, Next, PromptSubmitInput, Register, Timer } from 'claude-code'
import { describeTool, parseChannelTag, renderFinal, renderLive, type EndReason, type Turn } from '../src/card'
import { CHANNEL_SERVER, DISPATCH, FORWARD, FORWARD_LONG, routerDeny, TERMINAL_CHAT } from '../src/gate'
import { channelBody, indexPath, MAGPIE_GATEWAY, messageKind, ownerOf, RATING_TEXT, readIndex, terminalHintLine, workerHintLine, workerOfAgent, type MagpieIndex } from '../src/magpie'
import { answerNotPosted, followUp, handedBack, lostWorker, routerContext, takeOver, terminalAnswer, terminalContext, workerBrief } from '../src/prompts'
import * as tasks from '../src/tasks'
import * as tg from '../src/telegram'
import type { TgIo } from '../src/telegram'

// The Telegram session is a Router: a new request becomes a background worker
// (a subagent this mod spawns), a reply to any message of a task goes straight
// to that task's worker, a message that replies to nothing but continues an open
// task goes there through the Router's `forward`, and each worker's answer is posted under the message
// that started its run. Every run that lasts SHOW_AFTER gets a progress card.
//
// A worker this mod spawned or woke runs beneath this mod's own frame, so the
// host skips this mod's tool.call hook for the worker's calls (re-entry; checked
// with Claude Code 2.1.316). turn.complete still reaches this mod, so everything
// about a worker happens there: its answer, its card's last line, its handbacks.
//
// A message typed in this session's terminal (or sent through Remote Control) is a
// request too, in the chat TERMINAL_CHAT: the Router dispatches it the same way,
// and turn.complete hands its worker's answer to the Router as a prompt from this
// mod, which the terminal shows. A worker this mod spawned sends the Router no
// completion notice (its answer is its turn.complete); only a run woken later
// does, and that notice is dropped. (A `system` notice row from
// $.session.append is kept in the transcript but not drawn in the terminal.)
//
// Under claude-magpie (ANTHROPIC_BASE_URL is the Magpie gateway) the magpie-tasks plugin sits inside
// this mod: workers start without a fixed model and with a request header magpie-tasks routes by;
// follow-ups go to the executor magpie-tasks' index names for the task; replies to magpie-tasks'
// own messages, to tasks it turned into long tasks, and scores (评分 N) are handed on to it.

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
    routerStateDir: () => $.env.get('TG_ROUTER_STATE_DIR'),
    stateDir: () => $.env.get('TELEGRAM_STATE_DIR'),
    home: () => $.env.get('HOME'),
    read: async (path) => String(await $.fs.read(path)),
    run: (argv, init) => $.process.run(argv, init),
    log: async (line) => {
      try {
        await $.ui.log(`tg-router: ${line}`, { to: 'debug' })
      } catch { /* nothing to report to */ }
    },
  }
}

const kv = ($: EngineInterface): tasks.Kv => ({ get: (k) => $.store.get(k), set: (k, v) => $.store.set(k, v) })

/** Whether this session runs under claude-magpie; set at session.start, or on first use after a reload. */
let magpie: boolean | null = null
async function magpieActive($: EngineInterface): Promise<boolean> {
  magpie ??= (await $.env.get('ANTHROPIC_BASE_URL')) === MAGPIE_GATEWAY
  return magpie
}

/** magpie-tasks' Telegram index, read afresh: magpie-tasks writes it from other hooks and sessions. */
async function magpieIndex($: EngineInterface): Promise<MagpieIndex> {
  const path = indexPath((await $.env.get('HOME')) ?? '', await $.env.get('MAGPIE_TASKS_STATE_DIR'))
  return readIndex({ exists: (p) => $.fs.exists(p), read: async (p) => String(await $.fs.read(p)) }, path)
}

/** Whether magpie-tasks turned the task of worker `name` into a long task, led by an architect session. */
async function isLong($: EngineInterface, name: string): Promise<boolean> {
  return (await magpieActive($)) && ownerOf(await magpieIndex($), name)?.long === true
}

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
    // an executor magpie-tasks put in the worker's place answers under the worker's task; the
    // task keeps the worker's own loop id
    const worker = (await magpieActive($)) ? workerOfAgent(await magpieIndex($), agentId) : undefined
    const replaced = worker ? await tasks.byName(kv($), worker) : undefined
    if (replaced) return { ...replaced, agentId }
    notWorkers.add(agentId)
    return undefined
  }
  await tasks.setAgent(kv($), task.name, agentId)
  return { ...task, agentId }
}

type DispatchArgs = { chat_id?: unknown; message_id?: unknown; title?: unknown; ack?: unknown; model?: unknown; model_reason?: unknown }

async function dispatch($: EngineInterface, a: DispatchArgs): Promise<string> {
  const messageId = Number(a.message_id)
  const title = typeof a.title === 'string' ? a.title.trim() : ''
  const ack = typeof a.ack === 'string' ? a.ack.trim() : ''
  if (!title || !ack) throw new Error('dispatch 需要 title 和 ack')
  const model = typeof a.model === 'string' ? a.model.trim() : ''
  // one line, no closing bracket: magpie-tasks reads the reason up to the first "]"
  const reason = typeof a.model_reason === 'string' ? a.model_reason.replace(/\s+/g, ' ').replace(/]/g, '）').trim() : ''
  if (Boolean(model) !== Boolean(reason)) throw new Error('dispatch 的 model 和 model_reason 要一起给（model_reason 写用户要求这个模型的原话），或者都不给')
  const magpieMode = await magpieActive($)
  // outside claude-magpie every worker runs on WORKER_MODEL; a chosen model exists only there
  if (model && !magpieMode) throw new Error('dispatch 的 model 只在 claude-magpie 下可用；不给 model，worker 用默认模型')
  const key = reqKey(String(a.chat_id), messageId)
  const req = requests.get(key)
  if (!req) throw new Error(`没有等待派活的 Telegram 消息 ${key}（只能派发本次会话收到、还没派过的消息）`)
  const name = req.chatId === TERMINAL_CHAT ? `tui-${messageId}` : `tg-${req.chatId}-${messageId}`
  const now = await $.clock.now()
  // the task exists before the worker starts, so even a first run that ends at once finds it
  await tasks.create(kv($), { name, title, chatId: req.chatId, rootId: messageId, request: req.text, messageIds: [messageId], createdAt: now })
  const terminal = req.chatId === TERMINAL_CHAT
  // under claude-magpie, magpie-tasks routes the model by the header; a model the person named
  // travels in the brief as [model <id>] (the Agent input takes only aliases) with their words as the reason
  const prompt = magpieMode
    ? [
        `[magpie-tasks-request daily chat=${req.chatId} message=${messageId} worker=${name}]`,
        ...(model ? [`[model ${model}]`, `[model-reason user: ${reason}]`] : []),
        workerBrief(title, req.text, terminal, true),
      ].join('\n')
    : workerBrief(title, req.text, terminal)
  const spawned = await $.agent
    .spawn({ prompt, description: title, name, ...(magpieMode ? {} : { model: WORKER_MODEL }) })
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
  if (terminal) return `已派给 worker ${name}（${title}）。把 ack 告诉用户；它做完后 host 会把回答作为一条消息送到这里。`
  track($, `w:${name}`, req.chatId, messageId, now)
  const ackId = await tg.send(io($), req.chatId, clip(ack), messageId, true)
  if (ackId !== undefined) await tasks.addMessage(kv($), name, ackId, now)
  return `已派给 worker ${name}（${title}）。它的回答会由 host 发到 Telegram，你不用再回复。`
}

/**
 * Sends a follow-up to its task's worker. Answers false when the worker is
 * gone: the task is then lost and the message becomes a request the Router
 * dispatches, carrying the task's original request.
 */
async function deliver($: EngineInterface, owner: tasks.Task, req: Request, now: number): Promise<boolean> {
  await tasks.addFollowUp(kv($), owner.name, req.messageId, req.text, now)
  // magpie-tasks may have put another executor in the worker's place
  const current = (await magpieActive($)) ? ownerOf(await magpieIndex($), owner.name) : undefined
  const to = current && current.ownerAgentId !== owner.agentId ? { agentId: current.ownerAgentId } : owner.name
  const sent = await $.session.send({ to, text: followUp(req.messageId, req.text) })
  if (sent.isDelivered) {
    requests.delete(reqKey(req.chatId, req.messageId))
    await tasks.setState(kv($), owner.name, 'running', now)
    if (!runs.has(`w:${owner.name}`)) track($, `w:${owner.name}`, req.chatId, req.messageId, now)
    return true
  }
  await tasks.setState(kv($), owner.name, 'lost', now)
  await tasks.removeMessage(kv($), owner.name, req.messageId)
  requests.set(reqKey(req.chatId, req.messageId), { ...req, text: takeOver(owner.request, req.text), replaces: owner.name })
  return false
}

type ForwardArgs = { chat_id?: unknown; message_id?: unknown; worker?: unknown }

/** The Router judged a message that replies to nothing to continue an open task. */
async function forward($: EngineInterface, a: ForwardArgs): Promise<string> {
  const key = reqKey(String(a.chat_id), Number(a.message_id))
  const req = requests.get(key)
  if (!req) throw new Error(`没有等待处理的 Telegram 消息 ${key}`)
  const owner = typeof a.worker === 'string' ? await tasks.byName(kv($), a.worker.trim()) : undefined
  if (!owner || owner.chatId !== req.chatId || owner.state === 'lost') throw new Error(`这个聊天里没有名为 ${String(a.worker)} 的未结束任务`)
  if (await isLong($, owner.name)) {
    const taskId = ownerOf(await magpieIndex($), owner.name)!.taskId
    throw new Error(`「${owner.title}」已转为长期任务，消息要交给它的架构师：调用 ${FORWARD_LONG}，task 为 ${taskId}`)
  }
  const now = await $.clock.now()
  if (!(await deliver($, owner, req, now))) {
    return `${lostWorker(owner.title)} Call ${DISPATCH} with chat_id ${req.chatId} and message_id ${req.messageId}.`
  }
  const noteId = await tg.send(io($), req.chatId, `已转给「${owner.title}」的 worker。`, req.messageId, true)
  if (noteId !== undefined) await tasks.addMessage(kv($), owner.name, noteId, now)
  return `已转给 worker ${owner.name}（${owner.title}），host 已告诉用户；你不用再回复。`
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
        'Hand one request (a Telegram message, or a message typed in this terminal with chat_id "tui") to a new background '
        + 'worker. The host starts the worker with the original message; for Telegram it posts `ack` as a reply to that '
        + 'message and later posts the worker\'s answers. Call once per message.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'chat_id of the Telegram message that holds the request' },
          message_id: { type: 'string', description: 'message_id of the Telegram message that holds the request' },
          title: { type: 'string', description: 'a short Chinese title, a few words' },
          ack: { type: 'string', description: 'one Chinese sentence for the person: the object and the expected result' },
          // a chosen model exists only under claude-magpie (magpie-tasks routes it)
          ...((await magpieActive($)) ? {
            model: { type: 'string', description: 'only when the person explicitly asks for a model: its model ID; give model_reason with it' },
            model_reason: { type: 'string', description: 'with model: the person\'s own words asking for that model' },
          } : {}),
        },
        required: ['chat_id', 'message_id', 'title', 'ack'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'forward',
      description:
        'Send a Telegram message that continues an open task to that task\'s worker, when the message does not reply to '
        + 'one of the task\'s messages. The host delivers it, tells the person under the message, and posts the worker\'s answer.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'chat_id of the Telegram message' },
          message_id: { type: 'string', description: 'message_id of the Telegram message' },
          worker: { type: 'string', description: 'the worker name of the open task, as the open-task list shows it' },
        },
        required: ['chat_id', 'message_id', 'worker'],
      },
      isDeferred: false,
    })
  toolsReady = true
}

/**
 * Leaves a channel message to magpie-tasks, inside this mod: a reply to one of its messages, a reply
 * to a task it turned into a long task, or a score. `worker` names this mod's task the message
 * replies to, for magpie-tasks to find it. Should magpie-tasks pass the message on rather than drop
 * it, the Router reads it as any other request, with its context, and may dispatch it.
 */
async function handOn($: EngineInterface, e: PromptSubmitInput, next: Next<'prompt.submit'>, req: Request, now: number, worker: string | undefined) {
  const key = reqKey(req.chatId, req.messageId)
  requests.set(key, req)
  armed = { ...req, at: now }
  const context = [
    ...(e.context ?? []),
    routerContext(await tasks.openTasks(kv($), req.chatId), now, true),
    ...(worker ? [workerHintLine(worker)] : []),
  ]
  const r = await next({ ...e, context })
  if (r.drop !== undefined) {
    requests.delete(key)
    if (armed?.chatId === req.chatId && armed.messageId === req.messageId) armed = null
  }
  return r
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    magpie = (await $.env.get('ANTHROPIC_BASE_URL')) === MAGPIE_GATEWAY
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
      armed = null
      if (mine && !unposted.delete(mine.name)) return { drop: 'tg-router: 这个 worker 的回答已经发到 Telegram' }
      if (!mine) return next(e)
      return next({ ...e, context: [...(e.context ?? []), answerNotPosted(mine.chatId, mine.rootId)] })
    }
    // typed in this terminal, or through Remote Control: a request like a Telegram message
    if (o?.kind === 'composer' || o?.kind === 'bridge') {
      armed = null
      await ensureTools($)
      const now = await $.clock.now()
      let messageId = now
      while (requests.has(reqKey(TERMINAL_CHAT, messageId))) messageId++
      requests.set(reqKey(TERMINAL_CHAT, messageId), { chatId: TERMINAL_CHAT, messageId, text: e.text })
      const open = await tasks.openTasks(kv($), TERMINAL_CHAT)
      const magpieMode = await magpieActive($)
      return next({ ...e, context: [...(e.context ?? []), terminalContext(messageId, open, now, magpieMode), ...(magpieMode ? [terminalHintLine(messageId)] : [])] })
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
    if (!handed && (await magpieActive($))) {
      const index = await magpieIndex($)
      const kind = tag.replyTo !== undefined ? messageKind(index, tag.chatId, tag.replyTo) : undefined
      const long = owner !== undefined && ownerOf(index, owner.name)?.long === true
      if (kind !== undefined || long || RATING_TEXT.test(channelBody(e.text))) return handOn($, e, next, req, now, owner?.name)
    }
    if (owner) {
      if (await deliver($, owner, req, now)) return { drop: `tg-router: 已转给 worker（${owner.title}）` }
      await tg.send(io($), tag.chatId, `这件事（${owner.title}）原来的 worker 已经不在了，可能是会话重启过。已转给前台重新派活。`, tag.messageId, true)
      armed = { ...requests.get(reqKey(tag.chatId, tag.messageId))!, at: now }
      return next({ ...e, context: [...(e.context ?? []), routerContext(await tasks.openTasks(kv($), tag.chatId), now, await magpieActive($)), lostWorker(owner.title)] })
    }

    // handBack already holds the follow-up's own text for dispatch
    if (!handed) requests.set(reqKey(tag.chatId, tag.messageId), req)
    armed = { ...req, at: now }
    return next({ ...e, context: [...(e.context ?? []), routerContext(await tasks.openTasks(kv($), tag.chatId), now, await magpieActive($))] })
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
    // magpie-tasks starts the acceptance, diagnosis and hand-over subagents of daily tasks itself;
    // its $.agent.spawn reaches this hook as an Agent call of the main conversation.
    if (e.tool === 'Agent' && next.origin.plugin === 'magpie-tasks') return next(e)
    const deny = routerDeny(e as never, inbox ?? (await inboxDir($)))
    if (deny) return { deny }
    // registered tools: the engine's types list built-in names only
    const tool: string = e.tool
    if (tool === DISPATCH || tool === FORWARD) {
      try {
        return { result: tool === DISPATCH ? await dispatch($, e as DispatchArgs) : await forward($, e as ForwardArgs) }
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
      if (task.chatId === TERMINAL_CHAT) {
        await tasks.setState(kv($), task.name, 'idle', await $.clock.now())
        const body = e.reason === 'answer' && e.answer.trim()
          ? e.answer.trim()
          : renderFinal({ chatId: task.chatId, startedAt: 0, tools: 0, recent: [], dirty: false, lastEditAt: 0, done: true }, e.reason as EndReason, e.durationMs)
        // queued for the Router, which may be mid-turn: the worker's end does not wait on it
        void $.prompt.submit({ text: terminalAnswer(task.title, task.name, body) }).catch((err) => io($).log(`terminal answer ${String(err)}`))
        return next(e)
      }
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
