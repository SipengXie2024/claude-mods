# Progress: claude-telegram Router + background workers (2026-11-01)

## Task Status Dashboard
- [x] 1. Read the Super-agent article and dsh-superagent prototype; check mod surface and the telegram plugin (findings.md).
- [x] 2. User decisions: fork channel for reply ids; workers are background subagents; Router keeps herdr/tmux only.
- [x] 3. Design page `.planning/plan.html` → published https://cc.bbd.sh/plan/tg-router.html (4 decisions open).
- [x] 4. User kept all four defaults; `design.md` and `plan.md` written.
- [x] 5. Implemented: `mods/tg-router` (renamed from tg-progress), `examples/claude-telegram/tg-channel`,
      launcher, READMEs. 43 tests pass, tsc clean, validate passes. Live probe runs (fake channel
      server, fake token) passed: dispatch, follow-up by reply, lost worker, HANDBACK line, dropped
      completion notice. Test store file and temp dirs removed.
- [x] 6. Live session restarted in herdr pane w3S:p1 with the new launcher (2026-11-01 07:51 UTC); tg-channel holds bot.pid. Plan page unpublished, plan.html removed.
- [x] 7. First real Telegram message (953, 07:56 UTC): dispatched to tg-953, ack 954, card 955, answer 956; all four route to the worker.
- [x] 8. Worker brief asks for plain text (the answer used ** marks); `dispatch` re-registers on the first Telegram message after a reload of the mod (hot reload drops it without a new session.start). 44 tests pass; live session reloaded with /reload-plugins.

## Session log
- 2026-11-01: old `plan.md` / `progress.md` (finished jev and upgrade work) renamed to `plan-upgrade-2026-10-08.md` / `progress-jev-band-2026-10-23.md`.
- [x] 9. /code-review max --fix: 13 of 15 findings fixed (gate `&` and tmux shell subcommands, refused spawn, serialized store writes, chat-scoped keys, attachments in follow-ups, refused answers to the Router, re-dispatch with the original request, handbacks through the Router path). 53 tests pass; the live session reloaded the code. Task tg-953 predates the `request` field: a reply to it reaches the Router unrouted until it is pruned.
