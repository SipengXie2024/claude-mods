# claude-telegram: one resident Claude you drive from your phone

A single long-running Claude Code session, reachable from a Telegram chat, that
works as a Router: it hands each request to a background worker, so several
requests run at once and a new message never waits for the last one to finish.
It starts through `claude-magpie` and runs on Opus 5.5; the
[magpie-tasks](../../mods/magpie-tasks) plugin picks each worker's model and
thinking effort, checks and integrates its result, and connects the chat to the
long tasks that run in their own architect sessions.

```
phone ──Telegram──▶ claude-telegram (resident pane, cwd $HOME, claude-magpie, Opus 5.5)
                      ├─ tg-channel: messages in (with the id of the message they reply to), replies out
                      ├─ tg-router: dispatch, follow-up routing, answers and progress cards
                      │    └─ magpie-tasks (inside tg-router): model per worker by routing rules,
                      │         acceptance and integration, decisions, scores
                      │         └─ one background worker (subagent) per request, plus its checkers
                      ├─ long tasks: messages go to each task's architect session (claude --bg),
                      │    its answers come back as replies
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
   started the run (at most 100 词, Chinese words; the result first). A question the worker
   needs you to decide is that answer.
4. **A follow-up that is not about the request** is handed back by the worker:
   a line `HANDBACK <message_id>: <reason>` in its answer, which the mod
   removes before posting and gives to the Router with the reason.
5. **After a restart** a worker may be gone: a reply to its request then says so
   and goes to the Router, which dispatches it to a new worker. That worker gets
   the task's original request with your reply, and replies to any message of
   the old task reach it.

Tasks are kept in the mod's store and dropped 14 days after their last message.

## Models, checks and integration (magpie-tasks)

The Router's main loop runs on Opus 5.5 at low effort. DeepSeek's article found
that the Router layer's work (routing and talking: long input, short output) is
simpler than it looks; the launcher passes `--effort low` and sets
`JEV_MAIN_EFFORT=low`, so JEV keeps every Router request at low without asking
Jev or raising it after a fault. A `/effort` typed in the pane still wins.
A worker's model is not fixed: magpie-tasks asks Jev which routing rule the
request fits and starts the worker on that rule's model and effort, and tells
you in one silent reply, e.g. `模型：Opus 5.5 · xhigh · 规则 code-change（Jev 置信度 0.82；需要深入推理）`.
When you ask for a model yourself ("用 Sol 6.1 做"), the Router passes it to
`dispatch` with your words as the reason, and that model is used as given. A
request that no rule fits with enough confidence runs on the daily default,
Opus 5.5 at medium (rule `daily-default`), without asking you first.

A worker that changes a project first asks magpie-tasks for a worktree
(`open_worktree`) and works only there. It ends each answer with a status line.
When it reports done, an independent acceptance worker reruns its verification
and checks the result against your request once; on a pass the change is
applied to the project's working tree (no commit, no push) and you get the
files and the verification under your request. A failed check goes back to the
worker once, and the fixed result waits for your yes before it is applied. A
worker that reports itself blocked gets one independent diagnosis, which may
continue it, move it to another model, or ask you. Replies to magpie-tasks'
own messages reach whichever agent now answers for the task.

## Long tasks

Every interactive `claude-magpie` window becomes a long task with an architect
session of its own (see magpie-tasks). From the chat:

- **A reply to a long task's message** goes straight to its architect, and the
  architect's answer comes back as a reply. A message that replies to nothing
  but continues a long task is forwarded by the Router (`forward_long`); the
  Router's context lists the open long tasks. A stopped architect session is
  resumed with the message.
- **Questions a long task needs you to decide** (a file conflict between two of
  its workers, an integration conflict, no progress, an interruption) arrive as
  messages; your reply is read as an answer and carried out in the architect's
  session before the architect reads it.
- **A daily task that turns into design work**: the Router asks magpie-tasks
  for an architect recommendation (`recommend_architect`), discusses it with
  you, and after you confirm a model turns the task into a long task
  (`promote_task`), keeping its ID, messages and worktree. You get
  `已转为长期任务，架构师 <model>：claude attach <id>`.

## Scores

Once a day, at 21:00 local time, one task completed that day gets an
invitation under its completion message, with buttons 1–5 and 跳过:
`可以给「…」打个分吗？点下面的分数，或回复 1–5；不想评就点“跳过”。`
Tap a score or reply with a digit; 跳过 or no answer skips it. You can also score any task at any time
by replying `评分 N` to one of its messages. Every two weeks magpie-tasks looks
at the last two weeks of records and sends a calibration reminder only when a
routing rule shows the same problem in at least three tasks (rework after a
failed check, diagnosis or a model change, a score of 2 or lower, a result you
called unsuitable), when a substitute model succeeded at least three times
where the rule's model had not, or when you stated an opinion about a model.

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

`tg-router` refuses every main-loop tool call except `dispatch`, `forward`,
magpie-tasks' `forward_long`, `recommend_architect` and `promote_task`, the channel's
tools, `TaskStop`, `ToolSearch`, `SendMessage`, Read of a photo in the channel's
inbox, and Bash whose every command is `herdr` or `tmux` (piped only into
`head`, `tail`, `grep`, `wc`, `sort`, `cut`; no `$(…)`, backticks, `>`, `&`,
`sort -o`, or a tmux command that runs a shell command itself: `run-shell`,
`if-shell`, `pipe-pane`, `source-file`).
DeepSeek's ablation saw a single session with a subagent tool keep the work for
itself under a neutral prompt in 5 of 5 runs, so this rule is code, not prompt.
This also holds for what you type in the pane itself. Workers keep every tool
except the Router's own (`dispatch`, `forward` and magpie-tasks' three).

## Why one dedicated session

- **One poller per bot token.** Telegram serves updates to one `getUpdates`
  poller per token, and each new channel server kills the previous one.
  If every session loads the channel with the token, they fight over it.
- So the token lives only in a separate state folder, `~/.claude/channels/telegram-live/`.
  Ordinary sessions read the default `~/.claude/channels/telegram/`, find no
  token and exit at startup; only the launcher points the channel at `telegram-live/`.
- The launcher hands `TELEGRAM_STATE_DIR` to `tg-channel` alone, through the
  MCP config's `env`, and names the same folder for tg-router as
  `TG_ROUTER_STATE_DIR`. It passes no `--settings`: `claude-magpie` passes its
  gateway settings that way, and of several `--settings` only the last applies.
  The official `telegram` plugin therefore stays enabled in this session, reads
  the default folder, finds no token and exits, as in any other session.
- The resident session runs with `--dangerously-skip-permissions`: nobody is at
  the terminal to answer a permission prompt. Keep the chat allowlist tight.

## The channel (tg-channel)

[`tg-channel/`](tg-channel) is the official plugin's `server.ts` (Apache-2.0,
see its `NOTICE`) with two changes: an inbound message also carries
`reply_to_message_id`, and a press of a rating button (`rate:<1-5>`, `rate:skip`)
replaces the buttons with the choice and reaches the session as the digit,
replying to the invitation. The launcher starts it as the MCP server `tg-channel`
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
3. Install magpie-tasks after jev and subagent-opus, so it is the innermost of
   the three (`claude plugin install` appends a plugin to `enabledPlugins`, and
   the innermost plugin decides a subagent's model and effort):
   ```
   claude plugin install jev@sipeng-mods
   claude plugin install subagent-opus@sipeng-mods
   claude plugin install magpie-tasks@sipeng-mods
   ```
   An installed magpie-tasks that comes before either of them reports the order
   at startup and stays off; uninstall and install it again to fix that.
4. Copy [`claude-telegram`](claude-telegram) to a folder on `PATH` (e.g. `~/.local/bin/`).
   Set `CLAUDE_MODS` if this repository is not at `~/claude-mods`. It needs
   `claude-magpie`, `bun` and `jq`.
5. Pair your account while `claude-telegram` is not running: start an ordinary
   session with `TELEGRAM_STATE_DIR=$HOME/.claude/channels/telegram-live`, send
   the bot a message, and approve the code with `/telegram:access`. That
   session's own telegram server polls the live token, which would stop the
   channel of a running `claude-telegram`; quit it once you are paired.
6. Start it in a pane that stays open (herdr, tmux, screen): `claude-telegram`,
   and confirm the development-channel prompt, then name the session with
   `/rename telegram`.
7. After a restart, pick the same conversation up with `claude-telegram --resume telegram`.

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
