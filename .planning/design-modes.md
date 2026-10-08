# Design: general / academic modes (grill-me, 2026-10-08)

## Decisions
1. Scope: per repository. A mode is written to the repo's `.claude/settings.local.json`;
   takes effect after a session restart. Repos with no mode are general.
2. A mode is a full profile: plugins, mods, output style, mode-only skills.
3. The academic paragraph in `~/.codex/AGENTS.md` stays (shared with Codex, conditional, ~100 tokens).
4. Skills: `academic-writing-context` loads only in academic mode; `de-ai-polish` stays global;
   `academic-setup` is deleted (replaced by `/mode`).
   Implementation: keep the shared source in `~/.agents/writing/` (Codex reads it too). Global
   `skillOverrides["academic-writing-context"] = "off"`, academic profile writes `"on"`. No fork.
5. External academic harnesses: superpower-writing stays the only core; candidates are measured with
   its eval suite and winning ideas are rewritten into its skills. Only non-overlapping tools are
   installed as-is.
6. Detection: at session start, an unconfigured repo that looks like a paper (`.tex`/`.bib` within
   two levels, `main.tex`, `paper/`) gets one notice suggesting `/mode academic`. An explicit
   `/mode general` silences it for that repo.
7. Profiles. General = the global settings (nothing written). Academic writes only the diff:

   | key | academic |
   |---|---|
   | enabledPlugins superpower-writing@superpower-writing | true |
   | enabledPlugins superpower-planning@superpower-planning | false |
   | outputStyle | superpower-writing:Academic Research Assistant |
   | skillOverrides academic-writing-context | on |

   html-plan and sipeng-mods are inherited (on) in both modes.
8. Switcher: new mod `mods/mode` in this repo. `/mode general|academic` merges the keys into
   `.claude/settings.local.json` without a model turn; session start runs detection; the status line
   shows the mode. No engine API reloads plugins, so the command tells the user to restart.
   Explicit general is recorded by writing the general values of the same keys.
9. Phasing. Phase 1: mode mod, skillOverrides, delete academic-setup.
   Phase 2: survey of awesome-academic-skills main projects (overlap vs gaps with superpower-writing),
   then pick candidates for eval-based absorption.
10. Candidate bar (user, 2026-10-08): external harnesses must have very high GitHub stars.
    Working threshold ≥ 5,000 stars and pushed within 6 months. Stars on 2026-10-08:
    Imbad0202/academic-research-skills 50,924 · K-Dense-AI/scientific-agent-skills 48,030 ·
    Orchestra-Research/AI-Research-SKILLs 13,362 qualify. Below the bar: K-Dense claude-scientific-writer
    2,430, lishix520/academic-paper-skills 1,370, andrehuang/academic-writing-agents 213, others < 100.

## Facts checked
- 10 repos already carry academic-setup's three keys (TockIris, MOSAIC, skelot-paper x2,
  blockchain-catchup, vam-paper, octopus/overleaf-paper, hermes MHOT, trace-aot-paper,
  safe-api-gateway/paper-overleaf). They read as academic under the new mod; academic-writing-context
  needs the `on` override added to them.
- Mod API (2.1.294): commands, `$.fs.write`, `skill.prompt`, `prompt.compose`; `$.settings` is
  read-only; no plugin reload or restart call.
