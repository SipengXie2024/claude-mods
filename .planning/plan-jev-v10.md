# Plan: jev policy.v10 (2026-10-26)

Decisions settled with the user in a /grill-me session on 2026-10-26. Evidence: the
2026-10-26 journal analysis, the effort-switch experiment (memory
`effort-switch-opus-vs-mythos`), and the bug hunt in `/tmp/jev-bughunt/`.

## Measured facts the design rests on

- Opus 5.5: an effort change after a tool_result-only user turn (new top-level
  `output_config.effort` plus the `role:"system"` marker Claude Code writes) does not act
  until the next user turn with new input. low→max thought like low, max→low like max
  (4 runs each, ranges disjoint).
- Mythos 5.1: only the top-level effort changes, no marker; the change acts on the next
  request. Each change invalidates the message-block cache (2026-10-26: 12 of 15 switches
  rebuilt the cache, ~2.45M tokens).
- On the task.v3 key (200 prompts, `jev-effort-research/eval`), start-level accuracy
  (medium vs high, given the medium floor): StartLux 0.925, lingdt-decision-1.0 0.860,
  heuristics 0.700. A lingdt-specific deep threshold does not survive 5-fold CV
  (precision 0.75, recall 0.04). StartLux answers 89% within 4 s, 95.5% within 8 s.
- 2026-10-26 journal: 27 open issues, 0 cleared, 0 from a real failing test; 13 effort
  changes, all raises; 3 entries into max, all through stuck ≥ 0.9 from lingdt.

## Decisions

1. **Opus: per-prompt decision only.** No step-level routing, no Jev step calls, no
   mid-loop effort change. A repeated check failure at the end of a turn is carried into
   the next prompt (decision 9).
2. **Mythos: raise only, mid-loop.** Raise on the ladder in decision 3, at most twice per
   prompt; never step down mid-loop (the next prompt sets the level afresh).
3. **Ladder.** The first failure of a check opens nothing that raises; a raise happens only
   when the same check fails again after the model changed code since that failure
   (decision 4). Each further repeat failure of that check after a raise raises one more
   level. max is reachable only from xhigh along this path. The stuck bypass is removed;
   Jev takes no part in raising. Fallback answers never raise.
4. **What counts.** A check is a Bash command whose program, after launcher prefixes, is a
   known test/build/lint/typecheck runner (cargo test/build/clippy/check, pytest, go
   test/build/vet, tsc, eslint, ruff, mypy, npm/pnpm/yarn/bun run|test with a script name
   that is a whole word test|build|lint|check|typecheck|verify|ci, or that word before
   `:`), including the remote command inside `ssh … '<cmd>'` and `docker exec … <cmd>`.
   Failure = non-zero exit code only; output text never counts. A command with a pipe or
   `|| true` / `|| :` is not judged. Identity = hash of the full normalized command, never
   the clipped summary. Denied calls, WebFetch, lookups and one-off scripts never affect
   effort. "Changed code since" = an Edit/Write/MultiEdit/NotebookEdit succeeded after the
   failure.
5. **/effort pins until cancelled.** A hand-set /effort holds for the session until the
   person changes it again or writes `[effort auto]`. A /model switch is not a hand-set
   effort: re-baseline the session effort on model change (PostModelSwitch and whenever the
   loop's model differs from the previous request's model).
6. **Endpoint failure.** Primary deadline 6000 ms (`JEV_DEADLINE_MS`). On failure ask the
   fallback, use only its task type to set the start level; ignore its deep and stuck. If the
   fallback also fails, heuristics.
7. **Exploration.** At each human prompt's start decision, with probability 0.10 move the
   start level one step up or down (equal odds, inside medium..max, never on pinned or
   `[effort …]`-tagged prompts, never on non-human turns), journaling `explore: {p, from, to}`
   and the policy's own choice. Configurable via `JEV_OPUS_EXPLORE` (default 0.10).
8. **Non-human turns.** A task-notification turn continues the last human prompt: same
   level, tag range and open checks; no Jev call; no follow-up history record. A slash
   command is a new task judged from its expanded text, without the previous prompt's tag.
   Telegram (`channel` origin) messages are human prompts: unwrap the `<channel …>` wrapper
   before the follow-up and short-acknowledgement checks.
9. **Carry-over (Opus).** If a turn ended with a repeat check failure still failing, the
   next prompt starts one level above its task level (continuing the ladder) only when that
   prompt continues the work: a short acknowledgement, a follow-up judged to be about the last
   turn, or a continuation after the model stopped unfinished. A new task does not carry.

## Also fixed (bugs from 2026-10-26)

- `[effort …]` tag: subagents inherit the current main prompt's tag even when the main
  model is not routed; a tag expires with its prompt (model switch and slash commands do
  not keep it).
- Level arithmetic clamped to the scale; reason text built from the final level.
- Journal: append with `O_APPEND` semantics safe across processes; daily files
  (`mod-journal-YYYY-MM-DD.jsonl`) instead of the 512 KB rotation; per-prompt outcome rows
  (thinking tokens, wait time, cache read/creation, checks run/passed, whether the next human
  prompt was a correction, whether a raise was followed by the check passing).
- Circuit breaker: reset `probing` in a `finally`.
- A rejected `$.clock.sleep` is journaled as its own cause, not `deadline`.
- `.env` parser: quoted value followed by an inline comment.
- WebFetch `code` is an HTTP status, not an exit code.

## Acceptance

- `command claude plugin test mods/jev` passes, existing 200 tests included (adjusted only
  where a test encodes a behavior this plan changes, each such change listed in the commit
  message).
- The bug-hunt reproductions (`/tmp/jev-bughunt/mod/hooks/bughunt.test.tsx`,
  `/tmp/jev-bughunt/repro_pure.ts`) move into `mods/jev/tests` / `hooks` and pass.
- Each decision 1–9 has a test.
- `command claude plugin validate mods/jev` and `npx --yes -p typescript tsc -p mods/jev --noEmit` pass.
- Live check: a fresh Opus session and a fresh Mythos session in a tmux pane; the band shows
  the trail, the journal rows match the decisions above. Child sessions run with
  `TELEGRAM_STATE_DIR` unset and the telegram plugin disabled.
- `policy.v10`; README `jev` row updated. Commit to master (user's choice), no push.
