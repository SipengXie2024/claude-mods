import type { EngineInterface, Register, Timer } from 'claude-code'
import { describeTool, parseChannelTag, renderFinal, renderLive, type ChannelTag, type EndReason, type Turn } from '../src/card'
import * as tg from '../src/telegram'
import type { TgIo } from '../src/telegram'

// A turn started by a Telegram channel message gets one progress card in that
// chat once it has run SHOW_AFTER; the card is edited as tools run and ends as
// one line. Turns started any other way send nothing.

export const SHOW_AFTER = 30_000
export const EDIT_EVERY = 10_000
/** a long single tool shows no events; refresh the elapsed time this often */
export const HEARTBEAT = 60_000
const TICK = 2_000
/** a channel prompt binds to a turn that starts within this */
const PENDING_TTL = 10_000
const SEND_ATTEMPTS = 3
/** a turn whose turn.complete never came is dropped after this */
const STALE = 6 * 3600_000

type Tracked = Turn & { attempts: number; chain: Promise<void> }

const turns = new Map<string, Tracked>()
let pending: (ChannelTag & { at: number }) | null = null
/** the main-loop turn now running, when it is a tracked one */
let active: string | null = null
let ticker: Timer | null = null

/** Runs Telegram work for one turn in order, so the final edit lands after the send. */
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
        await $.ui.log(`tg-progress: ${line}`, { to: 'debug' })
      } catch { /* nothing to report to */ }
    },
  }
}

async function tick($: EngineInterface): Promise<void> {
  const host = io($)
  const now = await $.clock.now()
  for (const [id, t] of turns) {
    if (t.done) continue
    if (now - t.startedAt > STALE) {
      turns.delete(id)
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
      })
    } else if ((t.dirty && now - t.lastEditAt >= EDIT_EVERY) || now - t.lastEditAt >= HEARTBEAT) {
      t.dirty = false
      t.lastEditAt = now
      await enqueue(t, () => tg.edit(host, t.chatId, t.messageId!, renderLive(t, now)))
    }
  }
  if (turns.size === 0 && ticker) {
    ticker.cancel()
    ticker = null
  }
}

export function reset(): void {
  turns.clear()
  pending = null
  active = null
  ticker?.cancel()
  ticker = null
  tg.resetToken()
}

export const register: Register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    const o = e.origin
    // Any other prompt clears a channel prompt that never started a turn of
    // its own (one folded into a running turn), so it cannot arm a later one.
    if (o?.kind === 'channel' && o.server.includes('telegram')) {
      const tag = parseChannelTag(e.text)
      pending = tag ? { ...tag, at: await $.clock.now() } : null
    } else {
      pending = null
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const p = pending
    pending = null
    const now = await $.clock.now()
    if (p && now - p.at <= PENDING_TTL) {
      turns.set(e.turnId, {
        chatId: p.chatId,
        ...(p.messageId ? { replyTo: p.messageId } : {}),
        startedAt: now,
        tools: 0,
        recent: [],
        dirty: false,
        lastEditAt: now,
        done: false,
        attempts: 0,
        chain: Promise.resolve(),
      })
      active = e.turnId
      ticker ??= $.clock.every(TICK, () => void tick($))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const t = active ? turns.get(active) : undefined
    if (!t || t.done) return next(e)
    t.tools++
    t.dirty = true
    if (e.agentId) return next(e) // a subagent's tool: counted, the Agent row stays current
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
  })

  on('turn.complete', async ($, e, next) => {
    const t = turns.get(e.turnId)
    if (t) {
      t.done = true
      turns.delete(e.turnId)
      if (active === e.turnId) active = null
      const host = io($)
      const final = renderFinal(t, e.reason as EndReason, e.durationMs)
      // The edit runs on its own timer dispatch, so the turn never waits on Telegram.
      $.clock.after(0, () => void enqueue(t, async () => {
        if (t.messageId !== undefined) await tg.edit(host, t.chatId, t.messageId, final)
      }))
    }
    return next(e)
  })
}
