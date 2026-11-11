// Bot API calls for cards, acks and worker answers. Send and edit only: the
// channel server owns getUpdates, and a second poller would steal its updates.

/** The host calls this module needs; register.ts builds it from $. */
export type TgIo = {
  /** TG_ROUTER_STATE_DIR: the launcher's name for the channel's state folder, read by this mod alone */
  routerStateDir: () => Promise<string | undefined>
  /** TELEGRAM_STATE_DIR */
  stateDir: () => Promise<string | undefined>
  home: () => Promise<string | undefined>
  read: (path: string) => Promise<string>
  run: (argv: readonly string[], init: { stdin: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
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

/**
 * The channel's state folder: TG_ROUTER_STATE_DIR, else TELEGRAM_STATE_DIR, else the channel's
 * default. claude-telegram hands TELEGRAM_STATE_DIR to its channel server alone, so the official
 * telegram plugin of the same session never reads the live folder; it names the folder for this mod
 * as TG_ROUTER_STATE_DIR.
 */
export async function stateDir(io: Pick<TgIo, 'routerStateDir' | 'stateDir' | 'home'>): Promise<string> {
  return (await io.routerStateDir()) || (await io.stateDir()) || `${(await io.home()) ?? ''}/.claude/channels/telegram`
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

// A curl configuration value in double quotes: curl's config parser reads \\, \", \n, \r, \t
// and \v inside quotes.
function curlQuoted(value: string): string {
  const escaped = value.replace(/[\\"\n\r\t\v]/g, c => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' })[c]!)
  return `"${escaped}"`
}

/**
 * The curl configuration of one Bot API POST with a JSON body; curl prints the answer, a newline
 * and the HTTP status.
 */
export function botApiCurlConfig(token: string, method: string, body: unknown): string {
  return [
    `url = ${curlQuoted(`https://api.telegram.org/bot${token}/${method}`)}`,
    'header = "content-type: application/json"',
    `data-binary = ${curlQuoted(JSON.stringify(body))}`,
    'silent',
    'show-error',
    'max-time = 30',
    'write-out = "\\n%{http_code}"',
    '',
  ].join('\n')
}

/**
 * One Bot API call. The Bot API takes the token in the URL path, and the engine's debug log
 * records the URL of every $.http.fetch, so the request goes through curl with its configuration
 * on standard input: $.process.run logs the command name and the number of arguments, never the
 * arguments or the input.
 */
async function call(io: TgIo, method: string, body: Record<string, unknown>): Promise<Record<string, any> | null> {
  const t = await token(io)
  if (!t) return null
  try {
    // plain text: no parse_mode, so "_" or "*" never breaks a send
    const r = await io.run(['curl', '--config', '-'], { stdin: botApiCurlConfig(t, method, body), timeoutMs: 60000 })
    if (r.exitCode !== 0) {
      await io.log(`${method} curl exited ${r.exitCode}`)
      return null
    }
    const cut = r.stdout.lastIndexOf('\n')
    const status = Number(r.stdout.slice(cut + 1))
    const text = r.stdout.slice(0, Math.max(cut, 0))
    if (status >= 200 && status <= 299) return JSON.parse(text) as Record<string, any>
    // Telegram answers 400 when an edit would not change the text: not a failure
    if (!text.includes('message is not modified')) await io.log(`${method} ${status}`)
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
