# claude-telegram: one resident Claude you drive from your phone

A single long-running Claude Code session, reachable from a Telegram chat, that
works as a Router: it hands each request to a background worker, so several
requests run at once and a new message never waits for the last one to finish.

```
phone ──Telegram──▶ claude-telegram (resident pane, cwd $HOME)
                      ├─ tg-channel: messages in (with the id of the message they reply to), replies out
                      ├─ tg-router: dispatch, follow-up routing, answers and progress cards
                      │    └─ one background worker (Opus subagent) per request
                      └─ herdr / tmux: look at and steer the other agent panes
```

The design follows DeepSeek's "Super-agent 设计探索" (two layers: a resident
Router that only routes and talks, isolated workers that do the work; events of
a known thread go straight to their worker).

## What it does in the chat

1. **A new request** gets one reply, `收到：<what and what result>`, and a worker
   starts on it. The Router adds no plan: the worker reads your original message.
2. **A reply to any message of a request** (the request, the ack, its card, an
   answer, an earlier follow-up) goes straight to that request's worker. The
   Router never sees it. A finished worker resumes from its transcript.
   A message that replies to nothing is a new request for the Router.
3. **Each worker run ends with its answer** posted under the message that
   started the run (at most 100 words; the result first). A question the worker
   needs you to decide is that answer.
4. **A follow-up that is not about the request** is handed back by the worker:
   a line `HANDBACK <message_id>: <reason>` in its answer, which the mod
   removes before posting and gives to the Router with the reason.
5. **After a restart** a worker may be gone: a reply to its request then says so
   and goes to the Router, which dispatches it to a new worker. That worker gets
   the task's original request with your reply, and replies to any message of
   the old task reach it.

Tasks are kept in the mod's store and dropped 14 days after their last message.

## Typing in the session's own terminal

A message typed in the `claude-telegram` pane (or sent to it through Remote
Control) is a request like a Telegram message: the Router dispatches it to a
worker (`dispatch` with chat_id `tui`; the worker is named `tui-<id>`) and stays
free for the next message. Nothing goes to Telegram for it:

- The worker's answer comes back as a message from the `tg-router` plugin,
  which the terminal shows in full; the Router acknowledges it in one line.
  A worker the mod spawned sends the Router no completion notice of its own
  (its answer reaches the mod's `turn.complete` only), and a `system` notice
  row written with `$.session.append` is kept in the transcript but not drawn
  in the terminal, so the answer travels as a prompt.
- A terminal has no reply button: the Router reads which open terminal task a
  new message continues and forwards it with `SendMessage`; otherwise it
  dispatches a new task. Opening the worker from the task list and typing to
  it directly also works.

## The Router does no work

`tg-router` refuses every main-loop tool call except `dispatch`, the channel's
tools, `TaskStop`, `ToolSearch`, `SendMessage`, Read of a photo in the channel's
inbox, and Bash whose every command is `herdr` or `tmux` (piped only into
`head`, `tail`, `grep`, `wc`, `sort`, `cut`; no `$(…)`, backticks, `>`, `&`,
`sort -o`, or a tmux command that runs a shell command itself: `run-shell`,
`if-shell`, `pipe-pane`, `source-file`).
DeepSeek's ablation saw a single session with a subagent tool keep the work for
itself under a neutral prompt in 5 of 5 runs, so this rule is code, not prompt.
This also holds for what you type in the pane itself. Workers keep every tool.

## Why one dedicated session

- **One poller per bot token.** Telegram serves updates to one `getUpdates`
  poller per token, and each new channel server kills the previous one.
  If every session loads the channel with the token, they fight over it.
- So the token lives only in a separate state folder, `~/.claude/channels/telegram-live/`.
  Ordinary sessions read the default `~/.claude/channels/telegram/`, find no
  token and exit at startup; only the launcher points the channel at `telegram-live/`.
- The launcher turns the official `telegram` plugin off for this session
  (`--settings`), so only `tg-channel` polls the token.
- The resident session runs with `--dangerously-skip-permissions`: nobody is at
  the terminal to answer a permission prompt. Keep the chat allowlist tight.

## The channel (tg-channel)

[`tg-channel/`](tg-channel) is the official plugin's `server.ts` (Apache-2.0,
see its `NOTICE`) with one change: an inbound message also carries
`reply_to_message_id`. The launcher starts it as the MCP server `tg-channel`
through `--mcp-config`. It is not on Claude Code's approved channel list, so it
loads with `--dangerously-load-development-channels server:tg-channel`, and
Claude Code asks for one confirmation in the pane at each start. The startup
banner also says `server:tg-channel · no MCP server configured with that name`;
messages still arrive (checked with Claude Code 2.1.316).

## Setup

1. Create the bot with @BotFather and install the official plugin (its
   `/telegram:access` skill manages pairing):
   `claude plugin install telegram@claude-plugins-official`.
2. Put the token in the dedicated folder only:
   ```
   mkdir -p ~/.claude/channels/telegram-live
   echo 'TELEGRAM_BOT_TOKEN=<token>' > ~/.claude/channels/telegram-live/.env
   chmod 600 ~/.claude/channels/telegram-live/.env
   ```
   Make sure `~/.claude/channels/telegram/.env` does not hold it.
3. Copy [`claude-telegram`](claude-telegram) to a folder on `PATH` (e.g. `~/.local/bin/`).
   Set `CLAUDE_MODS` if this repository is not at `~/claude-mods`. It needs `bun` and `jq`.
4. Pair your account while `claude-telegram` is not running: start an ordinary
   session with `TELEGRAM_STATE_DIR=$HOME/.claude/channels/telegram-live`, send
   the bot a message, and approve the code with `/telegram:access`. That
   session's own telegram server polls the live token, which would stop the
   channel of a running `claude-telegram`; quit it once you are paired.
5. Start it in a pane that stays open (herdr, tmux, screen): `claude-telegram`,
   and confirm the development-channel prompt, then name the session with
   `/rename telegram`.
6. After a restart, pick the same conversation up with `claude-telegram --resume telegram`.

## Progress cards

A Router turn or a worker run that is still going after 30 s gets one card,
sent silently as a reply to the message that started it. A Router turn's card
shows its tools:

```
🔄 已跑 4 分 12 秒 · 23 个工具
当前：Bash · 运行全部单元测试（已 40 秒）
最近：Read parser.rs ✓ · Edit parser.rs ✓
```

It is edited after tool events (at most every 10 s, plus a refresh each quiet
minute) and ends as one line: `✅ 完成 · 14 分 3 秒 · 53 个工具`, `⚠️ 被中断 …`
or `❌ 出错 …`. Short runs and turns typed in the terminal send no card.

A worker's card shows the elapsed time only (`🔄 已跑 3 分 10 秒`, then
`✅ 完成 · 4 分`). The worker runs beneath the mod's own frame, because the mod
spawned or woke it, and Claude Code (2.1.316) then runs none of the mod's
`tool.call` hooks for the worker's calls; `turn.complete` still arrives, so the
answer, the last card line and handbacks are all done there.

The card shows the Bash `description` or a file name, never the command, and
every card line passes a redaction step (key prefixes, `KEY=`/`TOKEN=` values,
long random strings): bot chats are not end-to-end encrypted. A worker's answer
goes out as written, like a reply the channel's own tool sends. The mod
only calls `sendMessage` and `editMessageText`, never `getUpdates`, so it does
not compete with the channel.

## Using it as a commander

Because the session runs in `$HOME` with the herdr (or tmux) CLI on `PATH`, a
message such as "what is the implementer pane doing?" or "rename the pane that
deploys the model to implementer-claude" is answered by the Router itself with
herdr or tmux commands. No worker starts for it.
