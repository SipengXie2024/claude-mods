# Findings: Super-agent routing for claude-telegram (2026-11-01)

## Goal
The resident Telegram session (`examples/claude-telegram`) becomes a Router that does no work
itself; each request runs in its own worker in parallel; a later message about a request
reaches that request's worker without the Router; results come back under the original message.
Source design: DeepSeek "Super-agent 设计探索" (https://zhuanlan.zhihu.com/p/2099987320443237060)
and its prototype https://github.com/deepseek-ai/dsh-superagent-prototype (clone in /tmp/dsh-study/repo).

## Current setup (High relevance)
- `examples/claude-telegram/claude-telegram`: `claude --dangerously-skip-permissions --channels
  plugin:telegram@claude-plugins-official --plugin-dir mods/tg-progress`, cwd `$HOME`,
  `TELEGRAM_STATE_DIR=~/.claude/channels/telegram-live` (the only poller for the bot token).
  The session is also used as a commander that drives herdr/tmux panes.
- `mods/tg-progress/hooks/register.ts`: `prompt.submit` sees a Telegram prompt as
  `e.origin.kind === 'channel'` with `server` containing `telegram`; `parseChannelTag` reads
  `chat_id` / `message_id` from the `<channel ...>` tag; it sends and edits Telegram messages
  itself through `$.http.fetch` with the bot token (`src/telegram.ts`).
- Official plugin `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/server.ts`
  (Apache-2.0, 1045 lines). Inbound meta: `chat_id`, `message_id`, `user`, `user_id`, `ts`,
  image/attachment fields. **It does not forward `reply_to_message.message_id`** (it reads it
  at line 323 only for group mention detection) and does not forward `message_thread_id`.
  The `reply` tool returns `sent (id: N)` / `sent K parts (ids: …)`.

## Mod surface checked in `mods/jev/.claude-plugin/types/claude-code/index.d.ts`
- `prompt.submit` result may be `{ drop: reason }`: the prompt does not enter the main loop.
- `$.agent.spawn({ prompt, ... })` starts a background subagent, answers `{ agentId }`.
- `$.session.send({ to: { agentId } | { sessionId }, text })`: delivered as a peer message;
  "A finished subagent is resumed from its transcript with the message". `sessionId` reaches
  another running session on this machine; a session not running is not delivered to.
- `$.store` durable per plugin; `tool.call` hook can deny or observe results.
- `$.agent.list()` gives id, description, status, name.

## Open evidence
- [NEEDS-EVIDENCE] whether subagent ids from before `claude-telegram --resume telegram` still
  resolve for `$.session.send` after the restart.

## Prototype ideas carried over
- Gate in code, judgement by model; subscription fast path; worker hands back out-of-scope
  follow-ups; one question at a time; ack once, then silence until result; 100-word chat limit;
  Router never waits (no sleep/poll).
- Paper 7.1: a single session with a subagent tool often does the work itself under a neutral
  prompt (0 of 5 runs delegated); a Router without execution tools fixes that structurally.

## Decisions (user, 2026-11-01)
| Decision | Choice |
|---|---|
| How a follow-up finds its task | Copy the official telegram channel server into claude-mods and add the replied-to message id to inbound meta; a reply to any message of a task goes straight to that task's worker |
| Worker form | Background subagent of the Telegram session (`$.agent.spawn`, `name`, `cwd`); a finished worker is resumed by `$.session.send` |
| Router tools | Bash limited to herdr/tmux commands; Edit/Write/other execution denied by a `tool.call` hook |

## More surface facts
- `AgentSpawnArgs` = `prompt` + optional `description`, `subagentType`, `model`, `name`, `cwd`; a plugin's spawn always runs in the background.
