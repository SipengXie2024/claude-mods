/**
 * Jev's view of a conversation: the messages a person and the agent exchanged,
 * rebuilt on every ask from Claude Code's own context
 * (`$.session.messages({ as: 'api' })`, a subagent's with its agentId), so it
 * follows Claude Code's compaction. Rules measured on 2026-11-09
 * (.planning/research/magpie-tasks-interface-probes-2026-11-09.md, api-messages):
 *
 * Kept, in order, one Jev message per item:
 * - the compaction summary (first block of the first message), without the
 *   reminder embedded in it;
 * - user-side content that starts a turn: typed text, a channel message's body
 *   without its tag, another session's message without its wrapper, a slash
 *   command's expanded body, a background task's summary and result;
 * - messages that arrived mid-turn (the person's, a channel's, a coordinator's,
 *   another session's), found inside tool results and the reminders beside them;
 * - what the person typed after interrupting a tool call: Claude Code puts it
 *   in the message that answers the interrupted call, after the interrupt
 *   marker, and it starts a new turn;
 * - every assistant message without tool_use: a turn's final reply.
 * Dropped: tool calls and results, intermediate assistant text, thinking,
 * system reminders and hook context (a Stop hook's feedback too), interrupt
 * markers, local command blocks (slash commands and `!` shell commands with
 * their output), plugin notes.
 *
 * One item per message, never merged: a later block merged into an earlier
 * API message would otherwise rewrite an earlier Jev message and lose
 * OpenAI's prefix cache. The one such merge measured, a subagent's view
 * copying a background task's notification into its first message, is
 * dropped from the first message when the same event also stands later.
 */

/** A Messages API message, as `$.session.messages({ as: 'api' })` answers it. */
export type ApiMessage = { role: string; content: unknown };

/** One message of the Decisions API's `input`. */
export interface JevMessage {
  role: 'user' | 'assistant';
  content: string;
}

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
export function unwrapChannel(text: string): string {
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
 */
export function jevDialogue(messages: readonly ApiMessage[], notes: ReadonlySet<string> = new Set()): JevMessage[] {
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
    .map((it) => ({ role: it.role, content: it.content.trim() }))
    .filter((it) => it.content.length > 0);
}

/**
 * The dialogue with the prompt about to start a turn as its newest message.
 * The prompt is not in Claude Code's context yet when `prompt.submit` runs;
 * should it already be the last message, it is not added twice.
 */
export function withPrompt(dialogue: readonly JevMessage[], prompt: string): JevMessage[] {
  const text = prompt.trim();
  if (!text) return [...dialogue];
  const last = dialogue.at(-1);
  if (last?.role === 'user' && last.content === text) return [...dialogue];
  return [...dialogue, { role: 'user', content: text }];
}

/** The newest user-side message: what the task decision is about. */
export function latestUserText(dialogue: readonly JevMessage[]): string {
  for (let i = dialogue.length - 1; i >= 0; i--) if (dialogue[i]!.role === 'user') return dialogue[i]!.content;
  return '';
}

/** The marker magpie-tasks writes as the first line of a brief it routes: JEV leaves such a subagent's effort alone. */
const MAGPIE_TASKS_MARKER = /^\[magpie-tasks task=[^\]\s]+[^\]\n]*\]/;

/** A subagent's brief (the first user message of its view) opens with the magpie-tasks marker; the string quoted elsewhere is not one. */
export function isMagpieTask(brief: string): boolean {
  return MAGPIE_TASKS_MARKER.test(brief.trimStart());
}
