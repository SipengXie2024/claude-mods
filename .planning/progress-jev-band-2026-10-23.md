# Progress: jev effort shown in the band above the prompt (2026-10-23)

User decision (2026-10-23): jev's effort display moves to the AbovePrompt band for every
loop, main and subagent alike. The band draws the loop whose transcript is in view
(`e.props.view.agentId`, absent for the main conversation). The bottom status line's jev
segment goes away, as does the `status/<session>.json` file the mod wrote for it (the
`jc` gateway that also wrote those files is retired: `jc` is now a plain `claude` alias,
gateway.log last written 2026-10-09).

## Task Status Dashboard
- [x] 1. `mods/jev/hooks/register.tsx`: per-loop band status (trail, phase, source, done),
      `ui.render` AbovePrompt hook, `$.ui.invalidate('ui.render')` after each decision,
      subagent marked done on `turn.complete`; drop `writeStatus`.
- [x] 2. `mods/jev/hooks/register.test.tsx`: band tests (main view, subagent view, done, no state → engine).
- [x] 3. `~/.claude/statusline/simple.mjs`: remove the jev segment.
- [x] 4. README jev row.
- [x] 5. Checks: `command claude plugin test mods/jev`, `command claude plugin validate mods/jev`,
      `npx --yes -p typescript tsc -p mods/jev --noEmit`.
- [x] 6. Live check in a tmux pane: fresh session, spawn a subagent, open its view, band shows its trail.

## Baseline (before edits)
191 tests pass, validate passes, tsc clean.

## Checks after edits
tsc clean, validate passes, 195 tests pass (4 new band tests).

## Live check (tmux session `jevband`, Claude Code 2.1.309, 2026-10-23)
- Main view: band `◆ Jev · MEDIUM · explain` after the prompt, `◆ Jev · HIGH · exploring` after the Agent call; the bottom status line has no Jev segment.
- Agent panel below the status line: Down selects a row, Enter opens that subagent's transcript (prompt reads `Message @Explore…`).
- In the Explore view the band read `◆ Jev · HIGH · verifying` while the journal's latest entry for that agent was step 7 verifying and the main loop's last decision was exploring: the band follows the agent in view.
- `/tasks` + Enter opens a detail page, not the transcript; the panel row is the way in.
- After the Explore agent finished, its view read `◆ Jev · HIGH · verifying · done`; back in the main view the band read `◆ Jev · MEDIUM · explain`, the journal agreeing on both (agent: high verifying; main: medium explain).
