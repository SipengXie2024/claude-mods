# Design: claude-telegram Router and background workers (approved 2026-11-01)

All four decisions on the design page kept the default.

## Behaviour
1. A new Telegram request: the Router calls `mcp__tg-router__dispatch(message_id, title, ack)`.
   The mod spawns a background subagent (`$.agent.spawn`, model `opus`, name `tg-<message_id>`),
   posts the ack as a reply to the request, and records the task under the worker's name.
   Event agentIds map to names through `$.agent.list()` (the test kit's spawn answers no
   agentId, and SendMessage addresses a worker by name, so the name is the key).
2. A Telegram message that replies to any message of a task (request, ack, card, answer,
   earlier follow-up) goes straight to that task's worker with `$.session.send({ to: <worker name> })`
   and is dropped from the main loop. The forked channel
   (`examples/claude-telegram/tg-channel`, started by the launcher as MCP server `tg-channel`
   through `--mcp-config`) adds `reply_to_message_id` to the inbound meta. A worker hands a follow-up back with
   a line `HANDBACK <message_id>: <reason>` in its answer; at the worker's `turn.complete`
   the mod strips it, stops routing that message to the worker, and resubmits it to the Router.
   (A worker spawned or woken by the mod runs beneath the mod's frame, so the host skips the
   mod's `tool.call` hook for the worker's calls; a registered handback tool went unanswered
   in the live run. `turn.complete` reaches the mod.)
   If the send is not delivered (worker gone after a restart), the mod tells the user and
   passes the message to the Router to dispatch again (decision `lost=router`).
3. At each worker turn end (`turn.complete` with `agentId`) the mod posts `answer` under the
   message that started the run (request or follow-up), unredacted, and records the sent id. Each worker gets a progress card after 30 s (decision `card=yes`), showing elapsed time only
   for the same reason.
4. The main loop may call only: the channel's `reply`/`react`/`edit_message`/`download_attachment`,
   `dispatch`, `TaskStop`, `ToolSearch`, `SendMessage`, Read of a photo in the channel inbox, and
   Bash whose every command starts with `herdr` or `tmux`.
   Router rules and the open task list ride beside each Telegram prompt as `prompt.submit` context
   (`prompt.compose` carries no loop id, so a system-prompt section could reach workers too).
5. Router model: the session's model (decision `router-model=session`).

## Records
`$.store` key `tasks`: `{ tasks: Record<workerName, Task>, byMessage: Record<"chat:msg", workerName> }`.
A task is removed 14 days after its last message (decision `keep=14`).

## Not changing
Other sessions, other mods, herdr use by the Router. No GitHub source, proactive work or watchdog.

## Evidence
- Live run 2026-11-01 (Claude Code 2.1.316, probe channel server): dispatch spawned `tg-10`,
  a reply to the request reached it by name and resumed the finished worker, both answers
  went to `sendMessage`, the completion notice was dropped. Channel messages arrive although
  the banner says `server:tg-channel · no MCP server configured with that name`.
- The development channel asks for one confirmation at each start.
- Live run: a HANDBACK line returned message 51 to the Router, which dispatched it to `tg-51`
  (a Router turn started by the mod's `$.prompt.submit` still runs the mod's gate and dispatch).
- Live run: a reply to a task of an ended session took the lost-worker path ("No agent named
  'tg-20' is reachable"), told the person and went to the Router.
- [NEEDS-EVIDENCE] whether `claude-telegram --resume telegram` brings old workers back; if not,
  the lost path above covers their follow-ups.
