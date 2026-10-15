# claude-telegram: one resident Claude you drive from your phone

A single long-running Claude Code session, reachable from a Telegram chat, that
also shows a live progress card (the `tg-progress` mod) while it works.

```
phone ──Telegram──▶ claude-telegram (resident pane, cwd $HOME)
                      ├─ official telegram plugin: messages in, replies out
                      ├─ tg-progress: one card per long turn, edited as tools run
                      └─ herdr / tmux: look at and steer the other agent panes
```

## Why one dedicated session

- **One poller per bot token.** Telegram serves updates to one `getUpdates`
  poller per token, and each new telegram plugin server kills the previous one.
  If every session loads the plugin with the token, they fight over it.
- So the token lives only in a separate state folder, `~/.claude/channels/telegram-live/`.
  Ordinary sessions read the default `~/.claude/channels/telegram/`, find no
  token and exit at startup; only the launcher points the plugin at `telegram-live/`.
- The resident session runs with `--dangerously-skip-permissions`: nobody is at
  the terminal to answer a permission prompt. Keep the chat allowlist tight.

## Setup

1. Create the bot with @BotFather and install the official plugin:
   `claude plugin install telegram@claude-plugins-official`.
2. Put the token in the dedicated folder only:
   ```
   mkdir -p ~/.claude/channels/telegram-live
   echo 'TELEGRAM_BOT_TOKEN=<token>' > ~/.claude/channels/telegram-live/.env
   chmod 600 ~/.claude/channels/telegram-live/.env
   ```
   Make sure `~/.claude/channels/telegram/.env` does not hold it.
3. Copy [`claude-telegram`](claude-telegram) to a folder on `PATH` (e.g. `~/.local/bin/`).
   Set `CLAUDE_MODS` if this repository is not at `~/claude-mods`.
4. Start it in a pane that stays open (herdr, tmux, screen): `claude-telegram`.
   Pair your account with the plugin's `/telegram:access` skill, then name the
   session with `/rename telegram`.
5. After a restart, pick the same conversation up with `claude-telegram --resume telegram`.

## The progress card (tg-progress)

A turn started by a Telegram message that is still running after 30 s gets one
card, sent as a reply to that message:

```
🔄 已跑 4 分 12 秒 · 23 个工具
当前：Bash · 运行全部单元测试（已 40 秒）
最近：Read parser.rs ✓ · Edit parser.rs ✓
```

It is edited after tool events (at most every 10 s, plus a refresh each quiet
minute) and ends as one line: `✅ 完成 · 14 分 3 秒 · 53 个工具`, `⚠️ 被中断 …`
or `❌ 出错 …`. Short turns and turns typed in the terminal send nothing.

The card shows the Bash `description` or a file name, never the command, and
every line passes a redaction step (key prefixes, `KEY=`/`TOKEN=` values, long
random strings): bot chats are not end-to-end encrypted. The mod only calls
`sendMessage` and `editMessageText`, never `getUpdates`, so it does not compete
with the plugin.

## Using it as a commander

Because the session runs in `$HOME` with the herdr (or tmux) CLI on `PATH`, a
message such as "what is the implementer pane doing?" or "rename the pane that
deploys the model to implementer-claude" is answered by the session reading and
driving the other panes. No extra bridge is needed.
