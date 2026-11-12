// A subagent's conversation as Jev reads it (plan section 6.3), for the deep judgment when a routed
// subagent is resumed. The rules from `REMINDER_START` to `jevDialogue` are copied unchanged from
// mods/jev/src/dialogue.ts (the reviewed, deployed builder; the two plugins cannot import each
// other), so a subagent's view reads the same here as in JEV. Rules measured on 2026-11-09
// (.planning/research/magpie-tasks-interface-probes-2026-11-09.md, findings "JEV Jev context rework"):
//
// Kept, in order, one Jev message per item:
// - the compaction summary (first block of the first message), without the reminder embedded in it;
// - user-side content that starts a turn: typed text, a channel message's body without its tag,
//   another session's message without its wrapper, a slash command's expanded body, a background
//   task's summary and result (deduplicated on task id, summary and result together);
// - messages that arrived mid-turn (the person's, a channel's, a coordinator's, another session's),
//   found inside tool results and the reminders beside them;
// - what the person typed after interrupting a tool call;
// - every assistant message without tool_use: a turn's final reply.
// Dropped: tool calls and results, intermediate assistant text, thinking, system reminders and hook
// context, interrupt markers, local command blocks, plugin notes, and the coordinator's wrapper
// around a message that resumed a finished subagent.
//
// One item per message, never merged, so a later view starts with the earlier one and OpenAI
// reads that prefix from its cache. The one merge measured, a subagent's view copying a background
// task's notification into its first message, is dropped there when the same event stands later.
import type { JevMessage } from './jev'
import { parseChannelTag } from './telegram'

/** A Messages API message, as `$.session.messages({ agentId, as: 'api' })` answers it. */
export type ApiMessage = { role: string; content: unknown };

type Block = { type?: string; text?: unknown; content?: unknown };

const REMINDER_START = /^<system-reminder(\s[^>]*)?>/;
const REMINDER_SPAN = /<system-reminder(\s[^>]*)?>[\s\S]*?<\/system-reminder(\s[^>]*)?>\n?/g;
const NOTIFICATION = '[SYSTEM NOTIFICATION - NOT USER INPUT]';
const TASK_NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const COMPACTION = 'This session is being continued from a previous conversation';
const CHANNEL = /^<channel\s[^>]*>\n?([\s\S]*?)\n?<\/channel>\s*$/;
/** Blocks of a command the person ran in Claude Code itself: a built-in slash command, or `!` shell input and its output. */
const LOCAL_COMMAND = ['<local-command-caveat>', '<command-name>', '<local-command-stdout>', '<local-command-stderr>', '<bash-input>', '<bash-stdout>', '<bash-stderr>'];
const COMMAND_MESSAGE = '<command-message>';
const COORDINATOR_WRAPPER = 'The coordinator sent a message while you were working:';
const STOP_HOOK = 'Stop hook feedback:';
/** Claude Code's marker of an interrupted turn: `[Request interrupted by user]`, or `… for tool use]`. */
const INTERRUPTED = /^\[Request interrupted by user[^\]\n]*\]\s*/;
/** Another session's (or a subagent's SendMessage) message that starts a turn: its body is group 2. */
const PEER = /^Another Claude session sent a message:\n<(agent-message|cross-session-message)[^>]*>\n([\s\S]*?)\n<\/\1>/;
/** Untagged notes other plugins append to the conversation, from before this module could record them. */
const PLUGIN_NOTES = ['[context-memory checkpoint='];
const OPEN = '<system-reminder(?:\\s[^>]*)?>\\n';
/** Mid-turn input inside a tool result or a reminder: the person's, a channel's, a coordinator's to a running subagent, another session's. */
const MID_TURN: Array<{ re: RegExp; body: (m: RegExpMatchArray) => string }> = [
  { re: new RegExp(`${OPEN}The user sent a new message while you were working:\\n([\\s\\S]*?)\\n\\nThis is how Claude Code surfaces`, 'g'), body: (m) => m[1]! },
  { re: new RegExp(`${OPEN}The coordinator sent a message while you were working:\\n([\\s\\S]*?)\\n\\nAddress this before completing your current task\\.`, 'g'), body: (m) => m[1]! },
  { re: new RegExp(`${OPEN}A message arrived from [^\\n]* while you were working:\\n([\\s\\S]*?)\\n\\nIMPORTANT: This is NOT from your user`, 'g'), body: (m) => unwrapChannel(m[1]!) },
  { re: new RegExp(`${OPEN}Another Claude session sent a message while you were working:\\n<(agent-message|cross-session-message)[^>]*>\\n([\\s\\S]*?)\\n</\\1>`, 'g'), body: (m) => m[2]! },
];

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

const textOf = (b: Block): string => (b.type === 'text' && typeof b.text === 'string' ? b.text : '');

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocks(content).map(textOf).join('\n');
}

const tag = (body: string, name: string): string => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? '';

/** The person's own words of a channel message (Telegram): the body without the tag and its metadata; any other text as given. */
function unwrapChannel(text: string): string {
  const m = CHANNEL.exec(text.trim());
  return m ? m[1]!.trim() : text;
}

interface Item extends JevMessage {
  /** task id, summary and result of a background task's notification */
  notice?: string;
}

/** The background-task events in one reminder block, each as its summary and result. */
function notifications(text: string): Item[] {
  if (!text.includes(NOTIFICATION)) return [];
  const out: Item[] = [];
  for (const m of text.matchAll(TASK_NOTIFICATION)) {
    const summary = tag(m[1]!, 'summary');
    const result = tag(m[1]!, 'result');
    if (!summary && !result) continue;
    out.push({ role: 'user', content: `Background task event: ${summary}${result ? `\n\n${result}` : ''}`, notice: `${tag(m[1]!, 'task-id')}\u0000${summary}\u0000${result}` });
  }
  return out;
}

/** The messages that arrived mid-turn in one text, in the order they appear. */
function midTurn(text: string): Item[] {
  const hits: Array<{ at: number; content: string }> = [];
  for (const { re, body } of MID_TURN) for (const m of text.matchAll(re)) hits.push({ at: m.index!, content: body(m) });
  return hits.sort((a, b) => a.at - b.at).map((h) => ({ role: 'user', content: h.content }));
}

/** A text block of user-side content that starts a turn, as Jev reads it; none for what is not the person's or a sender's own message. */
function turnText(text: string, notes: ReadonlySet<string>): string | null {
  if (LOCAL_COMMAND.some((p) => text.startsWith(p))) return null;
  // The command's name and arguments; its expanded body is the next block, kept as text.
  if (text.startsWith(COMMAND_MESSAGE)) return null;
  if (text.startsWith(COORDINATOR_WRAPPER) || text.startsWith(STOP_HOOK)) return null;
  if (notes.has(text.trim()) || PLUGIN_NOTES.some((p) => text.startsWith(p))) return null;
  const peer = PEER.exec(text);
  if (peer) return peer[2]!;
  const channel = CHANNEL.exec(text);
  return channel ? channel[1]! : text;
}

/**
 * The kept items of one user message, in block order. A message that answers
 * tool calls is inside a turn: only mid-turn messages count, and the text
 * before an interrupt marker (`Tool loaded.`, a skill's body) is tool output;
 * after the marker the person's new input starts a turn.
 */
function userItems(m: ApiMessage, first: boolean, notes: ReadonlySet<string>): Item[] {
  const bs = blocks(m.content);
  let inTurn = bs.some((b) => b.type === 'tool_result');
  const out: Item[] = [];
  bs.forEach((b, i) => {
    if (b.type === 'tool_result') {
      out.push(...midTurn(toolResultText(b.content)));
      return;
    }
    let text = textOf(b);
    if (!text) return;
    if (first && i === 0 && text.startsWith(COMPACTION)) {
      out.push({ role: 'user', content: text.replace(REMINDER_SPAN, '') });
      return;
    }
    if (REMINDER_START.test(text)) {
      // A background task's event starts a turn; one that arrives inside a turn is that turn's tool traffic.
      if (!inTurn) out.push(...notifications(text));
      out.push(...midTurn(text));
      return;
    }
    const interrupt = INTERRUPTED.exec(text);
    if (interrupt) {
      inTurn = false;
      text = text.slice(interrupt[0].length);
      if (!text) return;
    }
    if (inTurn) return;
    const kept = turnText(text, notes);
    if (kept !== null) out.push({ role: 'user', content: kept });
  });
  return out;
}

function assistantItem(m: ApiMessage): Item | null {
  const bs = blocks(m.content);
  if (bs.some((b) => b.type === 'tool_use')) return null;
  const text = bs.map(textOf).map((t) => t.trim()).filter(Boolean).join('\n');
  return text ? { role: 'assistant', content: text } : null;
}

/**
 * The conversation as Jev reads it, oldest first; every item's text is
 * trimmed. `notes` holds the texts other plugins appended as notes
 * (`session.append`, door `note`), which are no one's message.
 * (mods/jev's `jevDialogue`, keeping each item's message index and event key.)
 */
function jevDialogueItems(messages: readonly ApiMessage[], notes: ReadonlySet<string> = new Set()): Array<Item & { message: number }> {
  const items: Array<Item & { message: number }> = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      const a = assistantItem(m);
      if (a) items.push({ ...a, message: i });
    } else if (m.role === 'user') for (const it of userItems(m, i === 0, notes)) items.push({ ...it, message: i });
  });
  // A subagent's view copies a background task's event into its first message; the event's own later message keeps it.
  const later = new Set(items.filter((it) => it.message > 0 && it.notice !== undefined).map((it) => it.notice));
  return items
    .filter((it) => !(it.message === 0 && it.notice !== undefined && later.has(it.notice)))
    .map((it) => ({ ...it, content: it.content.trim() }))
    .filter((it) => it.content.length > 0);
}

// Control lines and tokens the plugin, tg-router and the architect put into a brief: the task marker
// and other `[magpie-tasks …]` lines, tg-router's `[magpie-tasks-request …]` header, `[model-reason
// user|evidence: …]`, `[effort <level>]` and `[review-of agent=…|model=…]`. A mention without the
// closing bracket on the same line (a brief that quotes "`[magpie-tasks task=`") is left alone.
const CONTROL = /\[(?:magpie-tasks(?:-request)?\s[^\]\n]*|model-reason\s+(?:user|evidence)\s*[:：][^\n]*?|effort\s+(?:low|medium|high|xhigh|max)|model\s+[A-Za-z0-9][A-Za-z0-9._/-]*(?:\[1m\])?|review-of\s+(?:agent|model)=[^\]\n]*)\]/g

// tg-router's worker brief ends with the person's message after this line; the lines before it are
// the same instructions for every task plus the Router's title for it.
const ORIGINAL_MESSAGE = /^The original message:[ \t]*$/m

// The brief as Jev judges it: the task it delegates, without the routing control lines. A line
// that held only control tokens goes; every other line keeps its text. For a tg-router worker brief
// it is the person's own words: the Router's title paraphrases them and can turn "see whether this
// can be done" into "do it" (2026-11-10: with the title Jev chose code-change 0.93 for a feasibility
// question, with the words alone code-read 0.79), and the fixed instructions about editing
// repositories pull every task toward code-change.
export function briefForJev(prompt: string): string {
  const lines: string[] = []
  for (const line of prompt.split('\n')) {
    // The task rules magpie-tasks appends to a routed brief (brief.ts TASK_RULES_LINE) end the brief.
    if (line.startsWith('[magpie-tasks task-rules]')) break
    const kept = line.replace(CONTROL, '')
    if (kept !== line && kept.trim() === '') continue
    lines.push(kept === line ? line : kept.replace(/[ \t]+$/, ''))
  }
  const brief = lines.join('\n').trim()
  const m = ORIGINAL_MESSAGE.exec(brief)
  if (m === null) return brief
  const message = brief.slice(m.index + m[0].length).trim()
  return parseChannelTag(message)?.body.trim() ?? message
}

// A routed subagent's conversation, oldest first, the message that resumed it last (it is already in
// the view at the first request of the resumed run). The brief, the first user item of the first
// message that is not a background-task event, goes through briefForJev; a brief left empty is dropped.
export function subagentDialogue(api: ApiMessage[]): JevMessage[] {
  const items = jevDialogueItems(api)
  const brief = items.findIndex(it => it.message === 0 && it.role === 'user' && it.notice === undefined)
  return items
    .map((it, i) => ({ role: it.role, content: i === brief ? briefForJev(it.content) : it.content }))
    .filter(it => it.content.length > 0)
}

// The turn a routed subagent just ended. `asked` is the last message to it that is not a
// background task's event and does not start with one of `own` (the heads of the plugin's own
// messages to it); the brief goes through briefForJev. `tools` counts the tool calls made since the
// last such message that started a turn (one that arrived while the subagent was working is inside it).
export function endedTurn(api: ApiMessage[], own: readonly string[]): { asked: string; tools: number } {
  const items = jevDialogueItems(api)
  const brief = items.find(it => it.message === 0 && it.role === 'user' && it.notice === undefined)
  const said = items.filter(it => it.role === 'user' && it.notice === undefined && !own.some(head => it.content.startsWith(head)))
  const last = said[said.length - 1]
  if (last === undefined) throw new Error('endedTurn: the conversation holds no message to the subagent')
  const answersTools = (i: number) => blocks(api[i]!.content).some(b => b.type === 'tool_result')
  const start = said.reduce((at, it) => (answersTools(it.message) ? at : it.message), 0)
  const tools = api.slice(start + 1).reduce((n, m) => n + (m.role === 'assistant' ? blocks(m.content).filter(b => b.type === 'tool_use').length : 0), 0)
  return { asked: last === brief ? briefForJev(last.content) : last.content, tools }
}

// ---- what Jev reads to route a delegation ------------------------------------------------------
// The conversation the brief comes from, the files the brief names, then the brief. A brief alone
// does not say what its work is part of (writing a paper, studying someone's design, a translation
// project). On 567 delegations of 2026-10-12–11-11 that Jev answered both ways, a confident rule
// (>= 0.5) rose from 90% with the brief alone to 93% with this input; of the 59 briefs that send
// the agent to a brief file still on disk, from 45 to 58.

export const FILE_HEAD = 'File named in the brief:'

// The conversation a brief comes from: the main loop's view, or the delegating subagent's (its own
// brief through briefForJev, as in subagentDialogue).
export function spawningDialogue(api: ApiMessage[], fromSubagent: boolean): JevMessage[] {
  return fromSubagent ? subagentDialogue(api) : jevDialogueItems(api).map(it => ({ role: it.role, content: it.content }))
}

// The absolute and home-relative paths a brief names, first appearance first. A path starts after
// whitespace, a quote or a bracket (so `src/a.ts` and `https://…` name none) and ends at whitespace,
// a quote, a bracket or CJK punctuation; sentence punctuation right after it is not part of it.
const PATH = /(?<![\w./~:-])(~?\/[^\s`'"()<>[\]{}，。；：、（）！？「」]+)/g
export function briefPaths(brief: string): string[] {
  const out: string[] = []
  for (const m of brief.matchAll(PATH)) {
    const path = m[1]!.replace(/[.,;:!?]+$/, '')
    if (path !== '/' && path !== '~/' && !out.includes(path)) out.push(path)
  }
  return out
}

// Jev's input for a delegation, from the spawning conversation, the named files that could be read
// (path and text) and the brief as the delegating agent wrote it.
export function delegationMessages(dialogue: JevMessage[], files: { path: string; text: string }[], prompt: string): JevMessage[] {
  return [
    ...dialogue,
    ...files.map(f => ({ role: 'user' as const, content: `${FILE_HEAD} ${f.path}\n${f.text}` })),
    { role: 'user', content: briefForJev(prompt) },
  ]
}
