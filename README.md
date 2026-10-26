# claude-mods

Personal Claude Code mods (function-hook plugins), one plugin per folder under `mods/`.

| Mod | What it does |
|---|---|
| `subagent-opus` | Under a Fable or Mythos main loop, Agent-tool subagents start on Opus (forks and workflow agents untouched). |
| `no-bg-poll` | Denies `sleep N && <reader>` polling; background tasks notify on completion. |
| `workflow-opus-guard` | Under a Fable or Mythos main loop, denies a Workflow script unless every `agent()` call pins `model: 'opus'`. |
| `mode` | `/mode academic\|general` writes the repo's `.claude/settings.local.json` (restart to apply); paper repos get a one-time hint; status line shows academic mode. Both modes reply in the Plain output style; academic mode adds `prompts/academic.md` (academic judgment, submission register, review and rebuttal rules, the `~/.agents/writing/LESSONS.md` reminder) to the system prompt. |
| `jev` | Sets each Opus or Mythos request's effort per step with Jev (policy.v9): task level per prompt from the five-level effort table (chat and operate low, explain and write medium, research and code high, one level up when Jev says the task needs something worked out), raise after failing checks, step down once they pass, raise a prompt that says the last turn went wrong; max only after xhigh fails twice. Other session models (Fable, Haiku) are left alone, prompt included. The band above the prompt names the model of the loop whose transcript is in view, the main conversation or a subagent opened from the tasks list, and once Jev has decided a step there, its effort trail (`Opus 5.5 · ◆ Jev · high → XHIGH · diagnosing`; the model alone, `Fable 5.1`, for a loop Jev leaves alone; `· local routing` without Jev, `· done` once a subagent has ended); `/model` renames the main line at once. A prompt may carry its own range, `[effort xhigh..max]`, `[effort >=xhigh]` or `[effort max]`: that prompt's task level, raises and step-downs stay inside it, and the next prompt returns to the configured range (`/effort` pins still win); a subagent started under that prompt inherits the range unless its brief carries a tag of its own; the journal records it as `promptBounds` (`promptBoundsInherited` on a subagent). Reads `~/.config/jev-opus/.env` (`JEV_OPUS_CONFIG_DIR` overrides the folder); journal in `mod-journal.jsonl` there. Jev is only called at loopback, `172.21.0.1` or a `JEV_ALLOWED_HOSTS` host; otherwise heuristics only. `JEV_FALLBACK_BASE_URL` / `JEV_FALLBACK_API_KEY` / `JEV_FALLBACK_MODEL` / `JEV_FALLBACK_DEADLINE_MS` name a second endpoint asked only when the primary fails (deadline, HTTP error, no valid answers, circuit open); the journal records `jevProvider` and, after a fallback, `jevFallbackFrom`. |
| `tg-progress` | In a session started from Telegram (`--channels plugin:telegram@…`), a turn that runs 30 s gets one progress card in that chat: elapsed time, tool count, the current tool (Bash description or file name, never the command; every line redacted), edited after tool events at most every 10 s, ending as one line (done / interrupted / error). Not in the marketplace: load it only in that session with `--plugin-dir` (see `examples/claude-telegram`). Bot token from `$TELEGRAM_STATE_DIR/.env`; sends and edits only, never `getUpdates`. |
| `html-plan` | The community `html-plan` skill (anthropics/claude-plugins-community, html-plan 1.0.0) with Chinese prose: `pack.mjs` reads `。？！` as sentence ends and counts two CJK characters as one word, and under `<html lang="zh">` the page buttons, badges and the copied response are Chinese. Upstream changes: re-copy `skills/` and re-run the edits listed in `mods/html-plan/CHANGES.md`. |
| `math-render` | Draws the TeX math in assistant replies as Unicode in the terminal; the stored message and what the model reads keep the TeX. Inline math (`$…$`, `\(…\)`) becomes one line (`∑ᵢ₌₁ⁿ xᵢ²`, `(a + b)/2`, a script with no Unicode form written `x^q`); display math (`$$…$$`, `\[…\]`, a bare `equation`/`align` environment) on its own line becomes a fenced block of character art: stacked fractions, limits above and below, integrals and brackets stretched to their content, matrices, `cases`, `aligned`. Code spans, fenced code, prices (`$5 or $10`) and a display block still streaming stay as written; display art wider than the reply, or inside a table row, is written on one line. Characters only: the terminal draws no formula images here. |

## Examples

- [`examples/claude-telegram`](examples/claude-telegram): one resident Claude driven from a Telegram chat, with the `tg-progress` card; launcher script and setup.

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
