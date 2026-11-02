import type { HttpInit, HttpResponse } from 'claude-code'

// Bot API calls for cards, acks and worker answers. Send and edit only: the
// channel server owns getUpdates, and a second poller would steal its updates.

/** The host calls this module needs; register.ts builds it from $. */
export type TgIo = {
  stateDir: () => Promise<string | undefined>
  home: () => Promise<string | undefined>
  read: (path: string) => Promise<string>
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  log: (line: string) => Promise<void>
}

let tokenP: Promise<string | null> | null = null

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/** The channel's state folder: TELEGRAM_STATE_DIR, else the channel's default. */
export async function stateDir(io: Pick<TgIo, 'stateDir' | 'home'>): Promise<string> {
  return (await io.stateDir()) ?? `${(await io.home()) ?? ''}/.claude/channels/telegram`
}

/** The bot token from the channel's state folder, read once per module load. */
export function token(io: TgIo): Promise<string | null> {
  tokenP ??= (async () => {
    const dir = await stateDir(io)
    try {
      return parseEnvFile(await io.read(`${dir}/.env`)).TELEGRAM_BOT_TOKEN || null
    } catch {
      return null
    }
  })()
  return tokenP
}

async function call(io: TgIo, method: string, body: Record<string, unknown>): Promise<Record<string, any> | null> {
  const t = await token(io)
  if (!t) return null
  try {
    const r = await io.fetch(`https://api.telegram.org/bot${t}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), // plain text: no parse_mode, so "_" or "*" never breaks a send
    })
    if (r.ok) return JSON.parse(r.text) as Record<string, any>
    // Telegram answers 400 when an edit would not change the text: not a failure
    if (!r.text.includes('message is not modified')) await io.log(`${method} ${r.status}`)
  } catch (err) {
    await io.log(`${method} ${err instanceof Error ? err.name : 'error'}`).catch(() => {})
  }
  return null
}

/**
 * Sends a message; resolves its message_id, or undefined when Telegram refused.
 * A card goes out silent; an ack or an answer (`notify`) makes the phone ring.
 */
export async function send(io: TgIo, chatId: string, text: string, replyTo?: number, notify = false): Promise<number | undefined> {
  const r = await call(io, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_notification: !notify,
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  })
  const id = r?.result?.message_id
  return typeof id === 'number' ? id : undefined
}

export async function edit(io: TgIo, chatId: string, messageId: number, text: string): Promise<void> {
  await call(io, 'editMessageText', { chat_id: chatId, message_id: messageId, text })
}
