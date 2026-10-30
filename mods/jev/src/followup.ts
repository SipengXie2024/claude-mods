import { describeToolInput, stringifyResult } from './describe';
import { clip } from './router';

/**
 * Pure helpers that summarize the previous turn for the follow-up
 * (dissatisfaction) question. The summary carries only what the user saw and
 * what the agent did — never an effort level, so the evaluator cannot key on it.
 */

/** A Messages API message, as `$.session.messages({ as: 'api' })` answers it. */
export type Message = { role: string; content: unknown; [key: string]: unknown };

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

// Transcript helpers, from jev-opus src/gateway/transcript.ts.
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Human-authored text of a user message, without Claude Code's injected reminders. */
export function userText(m: Message | undefined): string {
  if (!m || m.role !== 'user') return '';
  return blocks(m.content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!.replace(REMINDER, '').trim())
    .filter(Boolean)
    .join('\n');
}

export function hasToolResults(m: Message | undefined): boolean {
  return !!m && m.role === 'user' && blocks(m.content).some((b) => b.type === 'tool_result');
}

/** Claude Code's forked side queries (next-prompt suggestion) announce themselves in the appended user turn. */
const SIDE_QUERY_MARKERS = ['[SUGGESTION MODE:'];

export function isSideQuery(m: Message | undefined): boolean {
  if (!m || m.role !== 'user') return false;
  const text = typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : '';
  return SIDE_QUERY_MARKERS.some((marker) => text.includes(marker));
}

export function lastIndexOfRole(messages: readonly Message[], role: string): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === role) return i;
  return -1;
}

/** The last path segment (node:path's basename for the file names the summary lists). */
const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

const INTERRUPT = '[Request interrupted by user';
const INTERRUPT_LINE = /^\[Request interrupted by user[^\]]*\]\s*$/gm;
const COMPACTION = 'This session is being continued from a previous conversation';
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_FILES = 5;

/** A message relayed by a channel server (Telegram, Slack): `<channel source=… …>text</channel>`. */
const CHANNEL = /^<channel\s[^>]*>\s*([\s\S]*?)\s*<\/channel>\s*$/;

/** The person's own words of a channel message; any other text as given. */
export function unwrapChannel(text: string): string {
  const m = CHANNEL.exec(text.trim());
  return m ? m[1]! : text;
}

/** User text without interrupt markers (Claude Code may merge a marker into the next prompt's message) or a channel wrapper. */
export function promptText(m: Message | undefined): string {
  return unwrapChannel(userText(m).replace(INTERRUPT_LINE, '').trim());
}

// A typed slash command ("/compact"); a path such as /home/... is a prompt.
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/;

/**
 * Whether a user message is something the human typed: not a tool result, an
 * interrupt marker, a suggestion fork, a compaction summary, or a harness
 * wrapper such as <task-notification> or <command-name> (pasted content counts).
 * Mirrors eval/extract_followups.py so offline labels match what the gateway sees.
 */
export function isHumanPrompt(m: Message | undefined): boolean {
  if (!m || m.role !== 'user' || hasToolResults(m) || isSideQuery(m)) return false;
  const text = promptText(m);
  if (!text || text.startsWith(COMPACTION) || SLASH_COMMAND.test(text)) return false;
  return !text.startsWith('<') || text.startsWith('<pasted_content');
}

/** Index of the human prompt before `before` (see isHumanPrompt); -1 if none. */
export function previousPromptIndex(messages: readonly Message[], before: number): number {
  for (let i = Math.min(before, messages.length) - 1; i >= 0; i--) {
    if (isHumanPrompt(messages[i])) return i;
  }
  return -1;
}

export function assistantText(m: Message): string {
  return blocks(m.content).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text!.trim()).filter(Boolean).join('\n');
}

/**
 * What the agent did across `span`: tool calls, edited files, commands and
 * their failures, and whether the user interrupted. Tool results may sit in
 * `also` too (the latest user message, e.g. an interrupted tool call).
 */
export function turnActions(span: readonly Message[], also?: Message): string {
  const results = new Map<string, Block>();
  let interrupted = false;
  for (const m of [...span, also]) {
    if (m?.role !== 'user') continue;
    for (const b of blocks(m.content)) {
      if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, b);
      const text = b.type === 'text' ? b.text ?? '' : b.type === 'tool_result' ? stringifyResult(b.content) : '';
      if (text.includes(INTERRUPT)) interrupted = true;
    }
  }

  let calls = 0, commands = 0, failed = 0;
  const files: string[] = [];
  for (const m of span) {
    if (m.role !== 'assistant') continue;
    for (const b of blocks(m.content)) {
      if (b.type !== 'tool_use') continue;
      calls++;
      const name = b.name ?? '';
      if (EDIT_TOOLS.has(name)) {
        const file = describeToolInput(name, b.input);
        if (file && !files.includes(basename(file))) files.push(basename(file));
      }
      if (name === 'Bash') {
        commands++;
        const r = b.id ? results.get(b.id) : undefined;
        if (r?.is_error === true) failed++;
      }
    }
  }

  const actions = [`${calls} tool calls`];
  if (files.length) {
    const extra = files.length - MAX_FILES;
    actions.push(`edited ${files.slice(0, MAX_FILES).join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`);
  }
  if (commands) actions.push(`ran ${commands} commands (${failed} failed)`);
  if (interrupted) actions.push('interrupted by user');
  return actions.join('; ');
}

/**
 * Three-line summary of the turn between the previous prompt and the latest
 * user message: the previous request, the start of the agent's last reply, and
 * what the agent did (tool calls, edited files, commands and failures).
 */
export function followUpSummary(messages: readonly Message[], prevIdx: number, lastUser: number): string {
  const span = messages.slice(prevIdx + 1, lastUser);

  const nearest = lastIndexOfRole(span, 'assistant');
  let reply = nearest >= 0 ? assistantText(span[nearest]!) : '';
  if (!reply) {
    for (let i = span.length - 1; i >= 0 && !reply; i--) if (span[i]!.role === 'assistant') reply = assistantText(span[i]!);
  }

  return [
    `PREVIOUS USER REQUEST: ${clip(promptText(messages[prevIdx]), 300)}`,
    `AGENT'S LAST REPLY (start): ${reply ? clip(reply, 500) : '(no text)'}`,
    `AGENT ACTIONS: ${turnActions(span, messages[lastUser])}`,
  ].join('\n');
}
