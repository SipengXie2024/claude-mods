// Telegram through the Bot API (plan section 9.12): the bot token and default chat from the channel's
// state folder, sendMessage, clipping to what Telegram accepts, and the channel tag of a message the
// Router receives. Only sendMessage is called: the channel server owns getUpdates, and a second
// poller would take its updates.
import type { Io } from './io'
import type { Options } from './types'

// Telegram refuses a text over 4096 UTF-16 units; the default leaves room for the clipping note.
const MAX_TEXT = 4000
const TELEGRAM_LIMIT = 4096

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

// TELEGRAM_BOT_TOKEN from `<stateDir>/.env`. Background sessions have no TELEGRAM_STATE_DIR, so the
// folder always comes from the plugin's configuration.
export async function botToken(io: Io, stateDir: string): Promise<string> {
  const path = `${stateDir.replace(/\/+$/, '')}/.env`
  if (!(await io.exists(path))) throw new Error(`Telegram: ${path} does not exist; set the plugin option telegramStateDir to the channel's state folder`)
  const token = parseEnvFile(await io.read(path))['TELEGRAM_BOT_TOKEN']
  if (token === undefined || token === '') throw new Error(`Telegram: ${path} has no TELEGRAM_BOT_TOKEN`)
  return token
}

// The text with the token replaced, for errors that may quote the request.
function scrub(text: string, token: string): string {
  return text.split(token).join('<token>')
}

// A curl configuration value in double quotes: curl's config parser reads \\, \", \n, \r, \t
// and \v inside quotes.
function curlQuoted(value: string): string {
  const escaped = value.replace(/[\\"\n\r\t\v]/g, c => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' })[c]!)
  return `"${escaped}"`
}

// The curl configuration of one Bot API POST with a JSON body; curl prints the answer, a newline
// and the HTTP status.
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

// A button under a message; the channel server answers a press of it (callback data at most 64 bytes).
export interface InlineButton { text: string; data: string }

// The rating invitation's buttons. The channel server (examples/claude-telegram/tg-channel) turns a
// press of `rate:<n>` into the person's reply to the invitation carrying the bare digit, and
// `rate:skip` into nothing; both replace the buttons with the choice.
export const RATING_BUTTONS: InlineButton[][] = [
  ['1', '2', '3', '4', '5'].map(n => ({ text: n, data: `rate:${n}` })),
  [{ text: '跳过', data: 'rate:skip' }],
]

// Sends `text` to `chatId` as plain text (no parse_mode, so `_` or `*` never breaks a send), as a
// reply to `replyTo` when given; `notify` makes the phone ring; `buttons` go under the message. Answers the new message's
// message_id; any failure throws, its message naming the HTTP status and Telegram's description.
//
// The Bot API takes the token in the URL path, and the engine's debug log records the URL of every
// $.http.fetch; architect sessions always keep a debug file (section 9.13). The request therefore
// goes through curl with its configuration on standard input: $.process.run logs the command name
// and the number of arguments, never the arguments or the input.
export async function send(io: Io, opts: Options, chatId: string, text: string, replyTo?: number, notify = false, buttons?: InlineButton[][]): Promise<number> {
  if (text.trim() === '') throw new Error('Telegram sendMessage: the text is empty')
  const token = await botToken(io, opts.telegramStateDir)
  const body = {
    chat_id: chatId,
    text: text.length > TELEGRAM_LIMIT ? clip(text) : text,
    disable_notification: !notify,
    ...(replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    ...(buttons !== undefined ? { reply_markup: { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))) } } : {}),
  }
  const r = await io.run(['curl', '--config', '-'], { stdin: botApiCurlConfig(token, 'sendMessage', body), timeoutMs: 60000 })
  if (r.exitCode !== 0) throw new Error(`Telegram sendMessage to ${chatId} failed: curl exited ${r.exitCode}: ${scrub(r.stderr.trim(), token)}`)
  const cut = r.stdout.lastIndexOf('\n')
  const status = Number(r.stdout.slice(cut + 1))
  let answer: { ok?: unknown; description?: unknown; result?: { message_id?: unknown } } = {}
  try {
    answer = JSON.parse(r.stdout.slice(0, Math.max(cut, 0))) as typeof answer
  } catch {
    throw new Error(`Telegram sendMessage to ${chatId}: HTTP ${status}, the answer is not JSON`)
  }
  const id = answer.result?.message_id
  if (status < 200 || status > 299 || answer.ok !== true || typeof id !== 'number') {
    const why = typeof answer.description === 'string' ? `: ${scrub(answer.description, token)}` : ''
    throw new Error(`Telegram sendMessage to ${chatId}: HTTP ${status}${why}`)
  }
  return id
}

// At most `max` characters (code points, so a surrogate pair is never cut), with a note of how many
// were left out.
export function clip(text: string, max = MAX_TEXT): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, max).join('')}…（后面还有 ${chars.length - max} 字，见终端）`
}

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

// `<channel source="tg-channel" chat_id="…" message_id="…" reply_to_message_id="…" image_path="…" …>`
// at the start of a channel prompt, and the message's text between the tag and `</channel>`. Null
// for a text with no such tag or one without chat_id and message_id.
export function parseChannelTag(text: string): { chatId: string; messageId: number; replyTo?: number; imagePath?: string; body: string } | null {
  const open = /<channel\b[^>]*>/.exec(text)
  if (!open) return null
  const tag = open[0]
  const attr = (name: string) => {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
    return m ? unescapeAttr(m[1]!) : undefined
  }
  const chatId = attr('chat_id')
  const messageId = attr('message_id')
  if (chatId === undefined || !/^-?\d+$/.test(chatId) || messageId === undefined || !/^\d+$/.test(messageId)) return null
  const replyTo = attr('reply_to_message_id')
  const imagePath = attr('image_path')
  const start = open.index + tag.length
  const close = text.indexOf('</channel>', start)
  const body = text.slice(start, close < 0 ? text.length : close).replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  return {
    chatId,
    messageId: Number(messageId),
    ...(replyTo !== undefined && /^\d+$/.test(replyTo) ? { replyTo: Number(replyTo) } : {}),
    ...(imagePath !== undefined && imagePath !== '' ? { imagePath } : {}),
    body,
  }
}

// The chat for notifications of a task started in a window: the option telegramChatId, else the
// only entry of `allowFrom` in the channel's access.json.
export async function defaultChat(io: Io, opts: Options): Promise<string> {
  if (opts.telegramChatId.trim() !== '') return opts.telegramChatId.trim()
  const path = `${opts.telegramStateDir.replace(/\/+$/, '')}/access.json`
  if (!(await io.exists(path))) throw new Error(`Telegram: ${path} does not exist; set the plugin option telegramChatId`)
  const access = JSON.parse(await io.read(path)) as { allowFrom?: unknown }
  const allow = Array.isArray(access.allowFrom) ? access.allowFrom.map(String) : []
  if (allow.length !== 1) throw new Error(`Telegram: ${path} lists ${allow.length} entries in allowFrom; set the plugin option telegramChatId to the chat for notifications`)
  return allow[0]!
}
