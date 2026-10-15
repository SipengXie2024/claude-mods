// Pure parts of the card: the channel tag, tool labels, the card text and
// the redaction every outgoing text passes through.

/** One Telegram-started turn, in memory only. */
export type Turn = {
  chatId: string
  /** message_id of the request the card replies to */
  replyTo?: number
  /** the card, once sent */
  messageId?: number
  startedAt: number
  /** main loop and subagents */
  tools: number
  current?: { label: string; since: number }
  /** the last labels, with ✓ or ✗ */
  recent: string[]
  /** a tool event since the last send or edit */
  dirty: boolean
  lastEditAt: number
  done: boolean
}

export type ChannelTag = { chatId: string; messageId?: number }

/** chat_id and message_id from `<channel source="…telegram…" chat_id="…" message_id="…">`. */
export function parseChannelTag(text: string): ChannelTag | null {
  const tag = /<channel\b[^>]*>/.exec(text)?.[0]
  if (!tag) return null
  const chatId = /\bchat_id="(-?\d+)"/.exec(tag)?.[1]
  if (!chatId) return null
  const mid = /\bmessage_id="(\d+)"/.exec(tag)?.[1]
  return { chatId, ...(mid ? { messageId: Number(mid) } : {}) }
}

const basename = (p: unknown) => (typeof p === 'string' ? p.split('/').pop() || p : '')

/** What the card says about a tool call: never the raw command or arguments. */
export function describeTool(e: { tool: string } & Record<string, unknown>): string {
  const desc = typeof e.description === 'string' ? e.description.trim() : ''
  switch (e.tool) {
    case 'Bash':
      return `Bash · ${desc || '(无描述)'}`
    case 'Read':
    case 'Edit':
    case 'Write':
      return `${e.tool} ${basename(e.file_path)}`
    case 'NotebookEdit':
      return `NotebookEdit ${basename(e.notebook_path)}`
    case 'Agent':
      return desc ? `Agent · ${desc}` : 'Agent'
    default:
      return e.tool // MCP and the rest: the name only
  }
}

const SECRET: RegExp[] = [
  /\b(?:sk-|ghp_|gho_|ghs_|github_pat_|xox[abpr]-|AKIA)[A-Za-z0-9_\-]{8,}/g,
  /\bBearer\s+\S+/gi,
  /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*=\S+/gi,
  /[A-Za-z0-9+/_\-]{32,}={0,2}/g, // long random-looking strings
]

export function redact(s: string): string {
  return SECRET.reduce(
    (acc, re) => acc.replace(re, (m) => (/^[A-Za-z0-9_]+=/.test(m) && !/^Bearer/i.test(m) ? `${m.split('=')[0]}=***` : '***')),
    s,
  )
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h} 小时 ${m} 分`
  if (m) return sec ? `${m} 分 ${sec} 秒` : `${m} 分`
  return `${sec} 秒`
}

/** The live card. */
export function renderLive(t: Turn, now: number): string {
  const lines = [`🔄 已跑 ${fmtDuration(now - t.startedAt)} · ${t.tools} 个工具`]
  if (t.current) lines.push(`当前：${t.current.label}（已 ${fmtDuration(now - t.current.since)}）`)
  if (t.recent.length) lines.push(`最近：${t.recent.slice(-2).join(' · ')}`)
  return redact(lines.join('\n'))
}

export type EndReason = 'answer' | 'aborted' | 'refusal' | 'error'

/** The one line the card keeps after the turn. */
export function renderFinal(t: Turn, reason: EndReason, durationMs: number): string {
  const d = fmtDuration(durationMs)
  const last = t.current?.label ?? t.recent.at(-1)?.replace(/ [✓✗]$/, '')
  const where = last ? ` · 最后在：${last}` : ''
  const line =
    reason === 'answer'
      ? `✅ 完成 · ${d} · ${t.tools} 个工具`
      : reason === 'aborted'
        ? `⚠️ 被中断 · ${d}${where}`
        : `❌ 出错 · ${d} · ${reason === 'refusal' ? '模型拒绝' : 'API error'}${where}`
  return redact(line)
}
