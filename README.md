# claude-mods

Personal Claude Code mods (function-hook plugins), one plugin per folder under `mods/`.

| Mod | What it does |
|---|---|
| `subagent-opus` | Under a Fable main loop, Agent-tool subagents start on Opus (forks and workflow agents untouched). |
| `no-bg-poll` | Denies `sleep N && <reader>` polling; background tasks notify on completion. |
| `workflow-opus-guard` | Under a Fable main loop, denies a Workflow script unless every `agent()` call pins `model: 'opus'`. |
| `mode` | `/mode academic\|general` writes the repo's `.claude/settings.local.json` (restart to apply); paper repos get a one-time hint; status line shows academic mode. Both modes reply in the Plain output style; academic mode adds `prompts/academic.md` (academic judgment, submission register, review and rebuttal rules, the `~/.agents/writing/LESSONS.md` reminder) to the system prompt. |
| `jev` | Sets each Opus request's effort per step with Jev (port of jev-opus policy.v8): task level per prompt, raise after failing checks, step down once they pass, raise a prompt that says the last turn went wrong. Reads `~/.config/jev-opus/.env` (`JEV_OPUS_CONFIG_DIR` overrides the folder); journal in `mod-journal.jsonl` there. |
| `fast-jev-compaction` | At 90% context, asks Jev which old tool calls are still needed and drops the rest verbatim instead of summarising (local fork of tamaratran/fast-jev-compaction e3f262a: self-hosted endpoint, request caps, AskUserQuestion calls always kept). Falls back to the built-in summary when Jev fails or saves under 25%. Reads the endpoint from `JEV_*` env or `~/.config/jev-opus/.env`. |

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
