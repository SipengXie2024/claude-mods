export type OfferTag = 'Heads up' | 'You should know'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const EFFORT_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && EFFORT_LEVELS.has(value)
}

export const DEFAULT_MAGPIE_GATEWAY = 'http://127.0.0.1:3425'
export const DEFAULT_CHECK_EVERY = 6
export const CLEAR_AFTER_PROMPTS = 2
export const SEEN_MAX = 50
export const SESSIONS_MAX = 32
export const TYPED_PAST_FREE = 2
export const LOOKS_TO_SKIP_MAX = 16
export const MAX_LINE_LENGTH = 240

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1')
}

export function isMagpieGateway(baseUrl: string | undefined, gatewayUrl: string = DEFAULT_MAGPIE_GATEWAY): boolean {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return false
  return normalizeUrl(baseUrl) === normalizeUrl(gatewayUrl)
}

/** Exponential backoff after consecutive ignored offers: 0, 0, 1, 2, 4, 8, 16. */
export function looksToSkipAfter(typedPastInARow: number): number {
  if (typedPastInARow <= TYPED_PAST_FREE) return 0
  return Math.min(LOOKS_TO_SKIP_MAX, 2 ** (typedPastInARow - TYPED_PAST_FREE - 1))
}

export function lineKey(line: string): string {
  return line.trim().toLowerCase().replace(/[.。]+$/, '')
}

const SIDE_REQUEST_FRAME = `<system-reminder>This is a side request from the user (via the "Heads up" observer). Answer it directly in this single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight observer spawned to answer this one request.
- The main agent is NOT interrupted and continues working independently.
- You share the conversation context but are a completely separate instance.

CRITICAL CONSTRAINTS:
- You have NO tools available — do not attempt to call tools.
- This is a one-off response with no follow-up turns.
- Base your answer only on the conversation context you already see.
- Never reproduce secrets, credentials, tokens, keys, or personal data from the conversation.
- Follow the output format below exactly.</system-reminder>`

function formatList(items: readonly string[]): string {
  return items.length > 0 ? items.map(s => `- ${s}`).join('\n') : '(none)'
}

export function buildProposePrompt(seen: readonly string[], known: readonly string[]): string {
  return [
    SIDE_REQUEST_FRAME,
    '',
    '## Goal',
    'Pause and reflect on this session so far. Is there ONE thing the user really needs to know right now that they might otherwise miss, with a concrete consequence if missed? Most of the time the answer is nothing — output `learn: none` when nothing is worth interrupting for.',
    '',
    '## Output format (strictly one of the two)',
    'Option 1 (nothing worth interrupting for):',
    'learn: none',
    '',
    'Option 2 (one concrete, high-value note):',
    'learn: <1 concise sentence (at most 2 clauses) stating what to know or watch out for>',
    'tag: <Heads up or You should know>',
    'explain:',
    '**<short readable title>**',
    '<plain-language explanation in 3-5 short bullets or sentences: what it is, the concrete trade-off or consequence with real names/numbers from this session, and what action or choice the user has. At most 160 words.>',
    '',
    '## Tag rules',
    '- `Heads up`: about the active work in this session — a decision or trade-off the agent made, a hidden assumption, a subtle risk, or a result that may be off, where missing it has an immediate cost.',
    '- `You should know`: an underlying system behavior, constraint, or design concept that deeply matters for the user\'s ongoing work.',
    '',
    '## Language & calibration',
    '- Write the `learn` sentence, title, and explanation in the language the session\'s Language instruction names (Chinese if the user writes in Chinese). Keep the exact English keywords `learn:`, `tag:`, `explain:`, `none`, `Heads up`, `You should know`.',
    '- Do not teach basics the user clearly already knows. Do not repeat anything already listed below.',
    '',
    'Already surfaced earlier (do not repeat):',
    formatList(seen),
    '',
    'Already marked known by the user (avoid these topics):',
    formatList(known),
  ].join('\n')
}

export function buildExplainPrompt(line: string): string {
  return [
    SIDE_REQUEST_FRAME,
    '',
    `The user clicked "Learn more" on this note: "${line}"`,
    '',
    'Write a clear, standalone explanation for someone who is context-switching:',
    '1. Start with `**<short plain title>**`.',
    '2. State what the thing is and what happened in this session, using the concrete file names, configs, or numbers already seen.',
    '3. State the concrete consequence if missed, and the specific choice or next step the user has.',
    '4. At most 160 words. Write in the language of the session (Chinese if the user writes in Chinese). Output only the explanation.',
  ].join('\n')
}

const LEARN_RE = /^learn\s*:\s*/i
const TAG_RE = /^[\s>*_"'`]*tag[\s*_"'`]*(?::\s*|[-–—]\s+)/i
const EXPLAIN_RE = /^explain\s*:\s*/i
const HEADS_UP_RE = /^\W*heads[\s-]*up\W*$/i
const NONE_RE = /^none\s*(?:[.!?()[\]:;,\-。！？]|$)/i
const INLINE_TAG_RE = /[.\s—–-]*\s*\**tag\**\s*:\s*\**\s*(heads[\s-]*up|you should know)\W*$/i

function stripOuterQuotes(s: string): string {
  const t = s.trim()
  const pairs: readonly [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['`', '`'],
  ]
  for (const [open, close] of pairs) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close) && !t.slice(1, -1).includes(close)) {
      return t.slice(1, -1).trim()
    }
  }
  return t
}

export function normalizeTag(raw: string): OfferTag {
  return HEADS_UP_RE.test(raw.trim()) ? 'Heads up' : 'You should know'
}

export type ParsedProposal =
  | { kind: 'none' }
  | { kind: 'offer'; line: string; tag: OfferTag; explanation?: string }
  | { kind: 'unparsable' }

export function parseProposal(raw: string): ParsedProposal {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const trimmed = lines.map(l => l.trimStart())
  const learnIdx = trimmed.findIndex(l => LEARN_RE.test(l.replace(/^[-*•]\s+/, '')))
  if (learnIdx === -1) return { kind: 'unparsable' }

  const relExplainIdx = trimmed.slice(learnIdx + 1).findIndex(l => EXPLAIN_RE.test(l))
  const explainIdx = relExplainIdx === -1 ? -1 : learnIdx + 1 + relExplainIdx

  let explanation: string | undefined
  if (explainIdx !== -1) {
    const first = trimmed[explainIdx]!.replace(EXPLAIN_RE, '').trim()
    const rest = lines.slice(explainIdx + 1).join('\n').trim()
    const combined = [first, rest].filter(Boolean).join('\n').trim()
    if (combined !== '') explanation = combined
  }

  const headLines = (explainIdx === -1 ? trimmed : trimmed.slice(0, explainIdx))
    .map(l => l.trim().replace(/^[-*•]\s+/, ''))

  const tagLine = headLines.find(l => TAG_RE.test(l)) ?? ''
  let tag: OfferTag = tagLine !== '' ? normalizeTag(tagLine.replace(TAG_RE, '')) : 'You should know'

  let learnText = headLines[learnIdx]!.replace(LEARN_RE, '').trim()
  if (learnText === '' || NONE_RE.test(stripOuterQuotes(learnText))) {
    return { kind: 'none' }
  }
  for (const nextLine of headLines.slice(learnIdx + 1)) {
    if (nextLine === '' || LEARN_RE.test(nextLine) || TAG_RE.test(nextLine) || EXPLAIN_RE.test(nextLine)) break
    learnText += ` ${nextLine}`
  }

  let cleaned = stripOuterQuotes(learnText)
  const inlineMatch = INLINE_TAG_RE.exec(cleaned)
  if (inlineMatch !== null) {
    if (tagLine === '') tag = normalizeTag(inlineMatch[1] ?? '')
    cleaned = stripOuterQuotes(cleaned.slice(0, inlineMatch.index))
  }
  if (cleaned === '' || NONE_RE.test(cleaned)) return { kind: 'none' }
  if (cleaned.length > MAX_LINE_LENGTH) {
    cleaned = `${cleaned.slice(0, MAX_LINE_LENGTH - 1).trimEnd()}…`
  }
  return { kind: 'offer', line: cleaned, tag, explanation }
}

export function buildDiscussDraft(tag: OfferTag, line: string, explanation?: string): string {
  const quoteLines = [`> ${tag} · ${line}`]
  if (explanation) {
    quoteLines.push('>')
    for (const l of explanation.trim().split('\n')) {
      quoteLines.push(l.trim() === '' ? '>' : `> ${l}`)
    }
  }
  return `Here is a note offered by a side observer:\n\n${quoteLines.join('\n')}\n\n`
}
