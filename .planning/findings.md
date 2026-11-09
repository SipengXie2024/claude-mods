# Findings: context-memory summary-input pruning and WAL (2026-11-09)

- Agentix (antcloud ~/agentix 9696a02701, read only) compacts in layers: L2 replaces bodies of re-runnable read/grep/glob results with stubs before any model call (`crates/context/src/prune.rs`) and skips the summary when that suffices; it has no search over original transcript text (`crates/agent/src/tools/read_session.rs:16` defers session_search to v2). Its relic memory engine extracts fact cards with a model call per flush, FTS5 unicode61 plus LIKE, auto-injected up to 2000 chars; not adopted: Claude Code memory and findings.md cover cross-session facts without plugin model requests or unreviewed injected facts.
- context-memory now hands the native summarizer Read/Grep/Glob outputs of 1024+ chars outside the last 10 messages as one-line pointers. On real transcripts these outputs are 4.66 M of 5.81 M input chars (344104e4, 1269 messages) and 0.83 M of 1.51 M (1b505947, 1472 messages). Live: 3 outputs (~30 K chars) replaced, compaction installed, no kept message carried a pointer, and Claude Code re-attached the recently read files after compaction, so the model answered a detail from src/core.ts without a tool call.
- The archive uses journal_mode=WAL with synchronous=NORMAL; the -wal/-shm files are 0600 under the helper's umask.
- Switching to WAL needs the file to itself: with another connection holding a write lock `PRAGMA journal_mode=WAL` fails at once with "database is locked" (0.1 s, no busy wait); with a reader it fails after busy_timeout. The helper skips the switch on that error only and the next connection switches. A live run caught a fork reading a bare `row:<uuid>` it inherited from the parent's context: bare refs resolve against the caller's own transcript, so it failed with "ref not on the active transcript chain"; a subagent now resolves a bare row ref in its own transcript, then its session's main one. Summary-input rewriting is skipped on `precompute`. In the unpacked Claude Code 2.1.299 (~/sipeng/re-test/claude-code-2.1.299, modules/chunk-84yp45y8): precompute runs only when the server flag `tengu_sepia_moth` (default false) is on and `precomputeCompactionEnabled` (default true) is not off (`_D()` in entry.js), which matches its absence from this host's debug logs; a ready result is taken by agent key (`AJe(agentId)`, `Lto`) and a persisted one is checked by transcript uuids (`precomputedAtUuid`, `preserveUuids`, age under 7 days; `HAt` in chunk_Fve.js), not by content; the hook's rewritten messages go straight to the summarizer and its preserved tail is taken from them (chunk_SIr_2.js), so a rewritten precompute input could put pointers into kept messages.

# Findings: context-memory cloud review fixes (2026-11-09)

- Cloud review of the whole plugin (branch context-memory-review, worktree ~/sipeng/claude-mods-review) found 10 issues, fixed in that worktree by its session: unknown root/parent checkpoints are ignored instead of failing every compaction; prune keeps checkpoints still named by a remaining transcript's handoff and their ancestors; undecodable transcript lines are skipped and counted; sync reads and parses outside the write lock and rechecks the cursor under it; transcript ranks pass through json_each; only UUID-named .jsonl files are indexed; a running subagent's transcript path is derived as <session>/subagents/agent-<id>.jsonl; search total comes from count(*) OVER ().
- The review's prune expired only sessions whose indexed main transcript vanished, so sessions that compacted but never used a history tool kept their snapshots forever. Schema version 2 records the session's main transcript on each checkpoint at snapshot time; a checkpoint expires when that file is gone. This host has one config directory (~/.claude-claudex is only plugin folders loaded with --plugin-dir), but the rule needs no guess about where transcripts live either way.

# Findings: context-memory search scope, retention and protocol (2026-11-09)

- A session's own snapshot duplicates its transcript: the active chain crosses the compact boundary through logicalParentUuid, and all 91 plain-text messages sampled from snapshot 43df9c60 were found verbatim in 9a785f87's active rows; 74 of 562 hits for "haichao2" were such duplicates. Search now leaves out the caller's own snapshots once its transcript is indexed.
- Removing the fork snapshot first left a fork with nothing to search (live run: total 0), and the acceptance script passed because it only checked for tool errors. A subagent's default scope now includes its session's main transcript; the live fork found 10 hits and read the parent's first request. The acceptance script now requires a hit.
- `tsc` had been run behind `| head`, so its exit status was never seen; the committed 0.2.0 failed TS2345 on `{ tool }` with a union. The matcher takes an array as one-of: `{ tool: [SEARCH, READ, STATUS, SESSIONS] }`.
- Project scope on claude-mods (44 sessions, ~111 MB main transcripts): first `history_sessions` 1.9 s including indexing; index size is 10–30% of transcript bytes. Literal AND matching misses cross-language wording ("超时" vs "timeout"); the model recovered by changing the query. No semantic search: it needs an embedding model and extra requests.
- Hooks and `storage.py` now exchange PROTOCOL = 2; a mismatch fails with one line naming `/reload-plugins`.
- Two processes syncing the same transcript from one cursor both appended the same lines: 3 of 3 races failed with `UNIQUE constraint failed: transcript_entries...` (pre-existing since the cursor; project scope makes it likely, as does a model calling two history tools at once). `sync_path` now takes `BEGIN IMMEDIATE` before reading the cursor. A first regression test passed even without the lock because `communicate()` serialized the two processes; it now writes both requests before reading either result, and fails on a lockless copy.

# Findings: context-memory storage layout and handoff display (2026-11-09)

- Plugins from the directory marketplace `sipeng-mods` are read from the repository folder (`claude plugin list`: `Read from: /home/ubuntu/sipeng/claude-mods/mods/context-memory`), not from the versioned copy under `~/.claude/plugins/cache`; an open session keeps the hooks module it loaded until `/reload-plugins`, while `storage.py` is spawned from the folder on every call. context-memory is 0.2.0 and enabled since 2026-11-09 06:05 UTC; superpower-planning is disabled, its conventions for `findings.md`, `CONTEXT.md` and plans moved to `~/.codex/AGENTS.md` (Project Records).
- Real archive was 611.8 MB; under 50 MB was text any operation reads. Space went to a pre-cursor transcript index (`transcript_rows`, 360.8 MB), snapshot `items.message` raw JSON never read by any op (92.7 MB), identical rendered/search copies in both snapshots and transcript tables, `observed` message bodies used only for a count, and 14 snapshots of compactions that never installed (120 MB) because the snapshot was written before the native compaction.
- SQLite reads a later column only after walking the overflow pages of earlier ones, so the old `items` row layout made every snapshot search read all three text columns.
- Schema version 1 (`PRAGMA user_version`): text once per row with `search_text` NULL unless it differs; transcript reading and search tables merged; `observed` and the observe hooks removed; snapshot and handoff written in one transaction after `next(e)` succeeds, checkpoint id generated in the hooks module (`crypto.randomUUID`). Legacy archives migrate in place on first contact, then VACUUM; the real archive went 611.8 MB to 48.7 MB in 9.2 s with all kept rows hash-identical.
- 9 of the 10 kept checkpoints are referenced by no transcript: the old order wrote their handoff before the native compaction failed or was cancelled. Deleted with user confirmation; archive is now 40.3 MB with one checkpoint (43df9c60).
- `SessionCompacted.messages` has no hidden/meta field; `isMeta` on append rows is pinned. `ui.render` on `UserMessage` can redraw a row without changing what the model reads; the handoff now draws as one line and expands under ctrl+o (checked in a live tmux session).

# Findings: context-memory 30-second archive timeout (2026-11-09)

- accumulator `/compact` at 03:08:24 UTC failed after 30 s: `$.process.run(python3) aborted`. No new checkpoint was written and the index timestamp stayed at 2026-11-07, so the transcript sync was the step that timed out.
- Old sync re-read the whole 163 MB transcript and replaced every index row for it (4454 rows, 220 MB: an unused raw-JSON column 114 MB, rendered 53 MB, search text 53 MB) in one rollback-journal transaction. On a copy of the real database: 6.4 s with a warm page cache; 37.7 s after evicting the copy from the cache (DELETE alone 34.1 s). Cold-cache search took 29.5 s because it read through the same wide rows.
- Agentix reference (read-only, antcloud `~/agentix`, HEAD 9696a02701): per-stream cursor with byte offset and last-body hash, append-only projection committed with the cursor, rebuild only on mismatch, WAL + synchronous=NORMAL (`crates/storage/src/projection/projector.rs:37-41,140-168,226-234`; `schema.sql:20-42`). The ce_dag plugin's FTS5 unicode61 index cannot match Chinese substrings; it falls back to LIKE.
- Measured alternatives on accumulator search text (warm): FTS5 trigram detail=full 216 MB / 24 s build / 3 ms query; detail=none 70 MB / 20 s / 52 ms; narrow text table 55 MB / 0.1 s / 0.1 s scan. Trigram also misses two-character queries. Chose the narrow table.
- After the change, on a cold copy of the real database: compaction archive 0.24 s for 883 items; first index sync 1.73 s; repeat sync 0.06 s; search 0.90 s cold, 0.29 s warm.
- Compaction no longer syncs the transcript; snapshot parents come from handoff markers in the compaction input. Old `transcript_rows` and `sync_state` tables remain unused in existing databases.

# Findings: context-memory compaction latency (2026-11-09)

- The 20-minute PreCompact wait came from the plugin itself: every compaction split the input into 24,000-character segments and requested Opus for each in sequence (accumulator: 883 items, 59 segments, about 21 s each). The same pipeline also ran after every turn.
- Codex experimental context management avoids this: the working model writes notes during the task and `new_context` installs a fresh window without summarization (`compact_token_budget.rs`, `session/token_budget.rs`).
- New design: notes live in the conversation as `notes_write` calls, so rewinds, resumes and forks use the current branch's note; the latest note goes into the native summarizer's instructions and is appended verbatim in the handoff. No database copy of notes is kept.
- `--system-prompt` sessions do not run `prompt.compose` hooks (0 runs in the debug log); default-prompt sessions do (1 run). Live checks that rely on the guidance must use the default prompt or ask for the tool explicitly.
- Accumulator-scale archive cost: transcript sync 4.21 s, snapshot 0.26 s, handoff 0.05 s.

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
