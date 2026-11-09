# Progress: context-memory 30-second archive timeout (2026-11-09)

- [x] Locate the failing step: accumulator compaction wrote no checkpoint and its index timestamp stayed at 2026-11-07; transcript sync timed out.
- [x] Reproduce on a cold copy of the real database: sync 37.7 s (DELETE 34.1 s); search 29.5 s.
- [x] Read Agentix's stream-cursor projection (read-only, antcloud) and the ce_dag plugin schema for reference.
- [x] Remove transcript sync from compaction and fork snapshots; replace full-rewrite sync with cursor-based appends, a separate search table and small chain/link/handoff tables; lock wait 20 s.
- [x] Checks: 6 core, 20 storage (incremental equivalence, cursor-only reads, rewrite rebuild; mutation and old-implementation runs fail those checks), TypeScript, plugin validate. Real sessions 0e820d32 and 57f6dc1e: four compactions, 0 plugin model requests, notes carried, history search/read and fork retrieval work.
- [x] Cold-copy timings: compaction archive 0.24 s, first sync 1.73 s, repeat sync 0.06 s, search 0.90 s.
- Every open session keeps the previous code until `/reload-plugins`.

# Progress: context-memory notes without plugin model requests (2026-11-09)

## Task Status Dashboard
- [x] Confirm the accumulator compaction was idle and inspect the old serial path: 883 inputs became 59 sequential Opus requests before native compaction.
- [x] Baseline check: verify_compaction.py fails on the old real run with 6 plugin model requests.
- [x] Replace per-turn and pre-compaction note generation with model-kept notes (`notes_write` / `notes_read`), a `prompt.compose` guidance section, note-carrying compaction instructions, and a verbatim handoff appended to the native result. Remove the summarization, candidate and request-format code paths and their checks.
- [x] Checks: 6 core, 17 storage, TypeScript, plugin validate. Real sessions: two manual and two automatic compactions with 0 plugin model requests and matching handoff notes; refused note ignored; resume retrieval and fork retrieval work; unprompted session wrote its own note.
- [x] Accumulator-scale archive overhead measured without model calls: 4.53 s.
- Details: context-memory-verification.md. User still needs `/reload-plugins` in accumulator before `/compact`.

# Progress: context-memory accumulator repair (2026-11-07)

- [x] Locate the failing session and preserve its real 881-item input.
- [x] Reproduce HTTP 429 in an isolated fork and distinguish request format from quota using same-account controls.
- [x] Separate the subscription identity system block and surface actual API errors.
- [x] Pass 12 core/request checks, type checking, and a real direct-subscription compaction/resume/retrieval session.

| Check | Result | Evidence |
|---|---|---|
| Real request before fix | HTTP 429 | accumulator fork debug log |
| Same input with separate identity block | Success | 11319 input / 2512 output tokens |
| Return to combined layout | HTTP 429 | same-account control |
| Core/request regression | 12 passed | Bun test output |
| Direct subscription end-to-end | Passed | session 6fe09413-4b2a-41d8-9d81-f77d9eff0f68 |

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
- [x] 10. Messages typed in the session's terminal (or via Remote Control) are requests too (chat_id `tui`, worker `tui-<id>`); the answer returns as the plugin's prompt, since a plugin-spawned worker sends no completion notice and a `system` notice row is not drawn. Live: a CPU/memory request came back in the pane. 56 tests pass.
