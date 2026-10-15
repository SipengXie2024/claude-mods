# claude-mods

Personal Claude Code mods (function-hook plugins), one plugin per folder under `mods/`.

| Mod | What it does |
|---|---|
| `subagent-opus` | Under a Fable main loop, Agent-tool subagents start on Opus (forks and workflow agents untouched). |
| `no-bg-poll` | Denies `sleep N && <reader>` polling; background tasks notify on completion. |
| `workflow-opus-guard` | Under a Fable main loop, denies a Workflow script unless every `agent()` call pins `model: 'opus'`. |
| `mode` | `/mode academic\|general` writes the repo's `.claude/settings.local.json` (restart to apply); paper repos get a one-time hint; status line shows academic mode. Both modes reply in the Plain output style; academic mode adds `prompts/academic.md` (academic judgment, submission register, review and rebuttal rules, the `~/.agents/writing/LESSONS.md` reminder) to the system prompt. |
| `jev` | Sets each Opus request's effort per step with Jev (port of jev-opus policy.v8): task level per prompt, raise after failing checks, step down once they pass, raise a prompt that says the last turn went wrong. Reads `~/.config/jev-opus/.env` (`JEV_OPUS_CONFIG_DIR` overrides the folder); journal in `mod-journal.jsonl` there. Jev is only called at loopback, `172.21.0.1` or a `JEV_ALLOWED_HOSTS` host; otherwise heuristics only. |
| `fast-jev-compaction` | At 90% context, asks Jev which old tool calls are still needed and drops the rest verbatim instead of summarising (local fork of tamaratran/fast-jev-compaction e3f262a: self-hosted endpoint, request caps, AskUserQuestion calls always kept). Falls back to the built-in summary when Jev fails, a request passes 60 s, or it saves under 25%. Requests go through the host's `curl` (8.3+), since `$.http.fetch` stops at 30 s. Reads the endpoint from `JEV_*` env or `~/.config/jev-opus/.env`; only loopback, `172.21.0.1` and `JEV_ALLOWED_HOSTS` are called. One line per compaction in `compaction-journal.jsonl` there. |
| `tg-progress` | In a session started from Telegram (`--channels plugin:telegram@…`), a turn that runs 30 s gets one progress card in that chat: elapsed time, tool count, the current tool (Bash description or file name, never the command; every line redacted), edited after tool events at most every 10 s, ending as one line (done / interrupted / error). Not in the marketplace: load it only in that session with `--plugin-dir ~/sipeng/claude-mods/mods/tg-progress`. Bot token from `$TELEGRAM_STATE_DIR/.env`; sends and edits only, never `getUpdates`. |

## Install (this machine)

```
claude plugin marketplace add ~/sipeng/claude-mods
claude plugin install <mod>@sipeng-mods --scope user
```

The marketplace is a local folder, so sessions read each mod straight from `mods/<mod>`:
edit, then `/reload-plugins`.

## Check

```
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
```
