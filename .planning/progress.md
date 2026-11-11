# Progress: model routing implementation interview (2026-11-09)

## Task Status Dashboard
- [x] Telegram launcher through claude-magpie; long-task architects as independent native background sessions; tool-enforced architect role; worktrees per independent task; automatic integration after acceptance; JEV fallback classification; one-time takeover confirmation for existing sessions; automatic recovery after a state check. Recorded in findings.md.
- [x] Verified: `--bg` takes the task prompt as its positional argument; AgentSpawnInput has model, cwd and resume but no effort; hook budgets stop while `$` calls run; Magpie's generated settings list Claude and Codex model IDs with per-model effort capabilities; sessions here run inside herdr panes.
- [x] Gate probe (user-authorized): agent.spawn model rewrite to codex/gpt-6.1-sol was served by gpt-6.1-sol per Magpie usage; JEV's effort rewrite (low) reached Magpie. Evidence: /tmp/magpie-subagent-probe-9eBB.
- [x] User decisions: effort owned by JEV for every role (rule effort is the subagent start); every interactive claude-magpie window is a long task; daily-task changes integrate automatically after verification; Router on Opus 5.5; Telegram notifications for decisions and completions; at most one rating invitation per day; calibration reminder after 3 same-kind problems per rule in two weeks.
- [x] Resolved from interfaces: self-gating new plugin `magpie-tasks` (claude-magpie is Magpie-generated); JEV extended for rule start levels and all table models; Magpie keeps accounts and failover.
- [x] Wrote model-routing-implementation.md; synced model-routing-table.md (effort row, Router model) and model-routing-design.md (open items).
- Deferred by the user: architect write allowlist, pending the context-memory discussion.
- Interview only; no implementation, launcher change or long-running session launch. The single probe session ended after answering.

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

# Progress: model routing table rules (2026-11-09)

## Task Status Dashboard
- [x] Record the user's choices: independent diagnosis can continue daily tasks within existing rules; unmatched daily tasks require user confirmation of the model recommendation.
- [x] Specify daily-to-long-task transition, Router/assessor/diagnostician responsibilities, different-model review selection, and independent implementation context in model-routing-table.md.
- [x] Keep model-routing-design.md consistent with these choices and record task-level retry counts and user decisions.
- [x] Verify 19 unique rules, 11 evidence references, 9 catalog model IDs, 8 main sections, local links and table columns.
- [x] Record six document-level scenario checks in model-routing-table-review.md.
- Current table SHA-256: 4a4db22a860b1bd4039fe84cb7cfd85e0a449aa0470a16ef9684ad98c701ea76.
- Verification concerns document semantics and structure; no runtime routing changes or model experiments were executed. Paragraph anchors use unique starts because the context constraint appears in both the role section and shared rules.

# Progress: model routing benchmark research (2026-11-07)

## Task Status Dashboard
- [x] Confirm current Magpie candidate catalog and read existing JEV benchmark notes.
- [x] Research Anthropic and Codex primary evidence in parallel; inspect the returned official pages, system-card passages, and independent task evidence.
- [x] Verify cross-provider AA comparisons, Cognition FrontierCode, LiveBench, Arena, DesignArena, MathArena/ArXivLean/LeanLean, and CodePanel methods; separate efforts, harnesses, versions and API/subscription economics.
- [x] Produce model-routing-benchmark-report.md and research/model-routing-2026-11-07/ evidence bundle: 863 records, 38 archived primary documents, all 25 catalog entries covered. Data checks verified 56 main AA table values, JSON/CSV record consistency and source existence.
- Research is complete. Recommendations have not been accepted as runtime policy; no live model benchmark experiments or routing implementation were run.
- Data extraction initially encountered a Unicode minus sign in an AA score; numeric normalization was added and the complete bundle validation passed.
- Reproduction scripts: /tmp/model-routing-tools-xyda5hto/{collect.py,parse_evidence.py,build_bundle.py}. Primary retrieval files remain in /tmp/model-routing-research-3bnbvq4u; cited evidence is archived in the research bundle.

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

# Progress: model routing interview (2026-11-07)

## Task Status Dashboard
- [x] Read current JEV effort routing, subagent model interface, Magpie model catalog, and Telegram task routing code.
- [x] Record user decisions in findings.md: quality-first selection; task-local architects; independent implementation contexts; user participation in consequential design changes; Telegram/long-task integration; participatory calibration and occasional ratings.
- [x] Start CONTEXT.md with agreed project vocabulary.
- [x] Investigate Anthropic's official `/code-review` fork mechanism and rationale. Verified official docs plus installed 2.1.319 byte excerpts: skill `context: fork` provides independent context and differs from a conversation fork; the official recipe depends on model and effort. No review, implementation, or configuration change performed.
- [ ] Continue `/grill-me` one question at a time. Preserve official workflow semantics in the routing proposal; remaining design details include calibration readiness/cadence, task registration and recovery, and actual model/recipe compatibility.
- [x] Consolidate agreed behavior in model-routing-design.md, including occasional ratings, two-week evidence checks, one diagnosis plus one replacement for no-progress blockers, and brief new-task routing notices.
- [ ] Resolve the model-selection rules and remaining integration details recorded in model-routing-design.md. No implementation, live Telegram restart, deployment, or benchmark experiment authorized.

## Investigation notes
- Existing .planning files contain other tasks and were preserved; interview decisions are prepended to findings.md.
- A Read offset beyond findings.md's length returned a warning; a subsequent bounded full read covered its 88 lines.
- Broad file discovery included inaccessible unrelated paths and produced excessive output. Focused source reads supplied the needed evidence.
- Guessed `mods/tg-router/src/dispatch.ts` and `store.ts` do not exist; actual definitions are in hooks/register.ts and src/tasks.ts.
- Guessed JEV journal.ts and record.ts do not exist. Outcome fields were verified directly in hooks/register.ts:667–685; future searches should first enumerate actual source files.

# Progress: subscription status line (2026-11-07)

- [x] Locate active script at ~/.claude/statusline/simple.mjs and verify Magpie's real statusline output for this session.
- [x] Integrate Magpie subscription output while preserving directory, Git and context fields. Magpie is selected by ANTHROPIC_BASE_URL matching MAGPIE_ADDR (default 127.0.0.1:3425); direct Claude retains its existing OAuth display.
- [x] Verify with real session data and a live terminal rendering. `node /tmp/check-magpie-statusline.mjs` failed before the edit for missing Codex output and passed after; `node --check` passed; a real direct-Claude invocation retained Anthropic quota output.
- [x] Fresh claude-magpie session in tmux `statusline-verify` completed a real prompt and displayed actual model, both subscriptions, active Codex account and `ctx 3% 28k/872k`. Capture: /tmp/magpie-statusline-live.txt. Sent /exit after verification.
- Skills applied: plugin-authoring (surface discovery), planning-foundation (task record), tdd (real integration verification).
- Discovery searches included inaccessible unrelated directories; focused reads of the active statusline and Magpie CLI succeeded.

# Progress: claude-magpie Codex context (2026-11-06)

- [x] Verify Codex model limits against OpenAI's models-manager/models.json and the local models_cache.json fetched on 2026-11-06: all eight current models have max_context_window=872000.
- [x] Set per-model Magpie context overrides to 872000 for GPT-6 Astra; GPT-6.1 Sol/Terra; GPT-6 Sol/Luna; GPT-5.6 Sol/Terra/Luna. Set `magpie model compact claude off`.
- [x] Verify `magpie model specs` and generated launch settings: CLAUDE_CODE_MAX_CONTEXT_TOKENS=872000, no CLAUDE_CODE_AUTO_COMPACT_WINDOW entry.
- [x] Verify a real fresh Astra session: d242540d-5c9a-4faf-b110-0f88a8f6688f reports contextWindow=872000 and debug effectiveWindow=852000. Artifacts: /tmp/magpie-context-fresh-{result.json,debug.log,stderr.log}.
- Existing session processes retain their 272000 environment values. Restart claude-magpie from the shell to apply both window and compaction settings. Validation launch unset CLAUDECODE, CLAUDE_CODE_AUTO_COMPACT_WINDOW, and CLAUDE_CODE_MAX_CONTEXT_TOKENS before invoking the launcher.

# Progress: claude-magpie JEV coverage (2026-11-06)

## Task Status Dashboard
- [x] Identify launcher, JEV admission gate, existing policy tables, and Magpie model catalog.
- [x] Resolve scope and behavior through `/grill-me`: Astra and Sol 6.1 only; difficult research can start at max; Sol prose/explanation/design default high.
- [x] Implement shared model admission and policy.v14 tables; record public benchmarks in mods/jev/BENCHMARKS.md.
- [x] Verify pure tests (33 pass), production and selected-test type checking, and real Astra/Sol Magpie sessions.
- [x] Verify installed local plugin resolution: ordinary claude-magpie startup loaded jev@sipeng-mods and produced a real policy.v14 JEV high decision on Sol.
- [x] Replay 10 real JEV profiles on both models: 20 expected decisions, including deep research max and configured caps; git diff --check passed.

## Delivery
- Implementation complete in repository source. Current interactive session needs `/reload-plugins` to load edited hooks; fresh claude-magpie sessions already load them.
- Source typecheck passed using /tmp/jev-magpie-source-tsconfig.json. Full-project typecheck retains two existing hook-test API errors (agentId and setTimeout); no mocked hook/service tests were run.
- Default-launch session d0ab9d8f-ed8a-4077-ae0f-24dc8a8211a6 completed successfully. Results: /tmp/jev-magpie-installed-result.json; debug: /tmp/jev-magpie-installed-debug.log.
- Reproduction artifacts: /tmp/jev-magpie-replay.ts, /tmp/jev-magpie-real-profiles.json, /tmp/jev-magpie-replay.log, /tmp/jev-magpie-pure-tests.log.
- Pure-test runner requires a real hooks module within its directory and rejects escaping symlinks. Exact source/test copies were used for test selection.

## Current verification
- Plugin validate passed. Directory publication checks mention absent license/icon; no public publication is requested.
- Real Astra session: 6d1ae8b9-7576-41ae-8664-c36f05d8c6dc; result/debug paths /tmp/jev-magpie-astra-*.
- Real Sol session: c1032efc-9888-41c3-8f6c-4a8da07ab86c; result/debug paths /tmp/jev-magpie-sol-*.
- Pure tests select model.test.ts, policy.test.ts and effort.test.ts with symlinks in a temporary plugin folder; no mocked service or hook tests are included.
- Process ancestry was readable through the session and Magpie; reading /proc/1/environ was denied. No root-process data is needed.
- Legacy installed cache uses policy.v8; local marketplace points to this repository. Actual runtime source resolution still needs verification.

## Session observations
- Scope and implementation are recorded in plan-magpie-jev.md; public benchmark evidence is in mods/jev/BENCHMARKS.md.
- Interactive zsh lookup emitted a gitstatus initialization error; the launcher was located successfully. Direct executable commands work.
- User interrupted one read-only search and then requested continuation.

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
