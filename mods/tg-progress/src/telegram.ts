import type { HttpInit, HttpResponse } from 'claude-code'

// Bot API calls for the card. Send and edit only: the official telegram plugin
// owns getUpdates, and a second poller would steal its updates.

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

/** The bot token from the channel's state folder, read once per module load. */
export function token(io: TgIo): Promise<string | null> {
  tokenP ??= (async () => {
    const dir = (await io.stateDir()) ?? `${(await io.home()) ?? ''}/.claude/channels/telegram`
    try {
      return parseEnvFile(await io.read(`${dir}/.env`)).TELEGRAM_BOT_TOKEN || null
    } catch {
      return null
    }
  })()
  return tokenP
}

/** For tests: forget the cached token. */
export function resetToken(): void {
  tokenP = null
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

/** Sends the card; resolves its message_id, or undefined when Telegram refused. */
export async function send(io: TgIo, chatId: string, text: string, replyTo?: number): Promise<number | undefined> {
  const r = await call(io, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_notification: true,
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  })
  const id = r?.result?.message_id
  return typeof id === 'number' ? id : undefined
}

export async function edit(io: TgIo, chatId: string, messageId: number, text: string): Promise<void> {
  await call(io, 'editMessageText', { chat_id: chatId, message_id: messageId, text })
}
