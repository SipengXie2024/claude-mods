# Plan: Claude Code upgrade (mods + html-plan), 2026-10-08

Decisions (user, 2026-10-08):
- Mods live in this repo, a local folder marketplace installed at user scope.
- html-plan output: file only (no Mac sync, Artifacts stay off).
- html-plan takes over the plan step of superpower-planning's brainstorming.
- Global instructions: delete only the CLAUDE.md section a mod replaces; AGENTS.md untouched.

## Tasks
1. [x] mods/subagent-opus: copy from old session dev-mods (agent.spawn → opus under Fable).
2. [x] mods/no-bg-poll: port ~/.claude/hooks/no-bg-poll.sh to tool.call Bash guard.
3. [x] mods/workflow-opus-guard: port ~/.claude/hooks/workflow-opus-guard.py to tool.call Workflow guard
       (agent.spawn can only deny workflow agents, so the whole-call guard stays at tool.call).
4. [x] validate + tsc + `claude plugin test` for each mod.
5. [x] marketplace add + install (user scope); remove the two settings.json hooks they replace; delete old scripts.
6. [x] Install html-plan@claude-community (anthropics/claude-plugins-community).
7. [x] superpower-planning brainstorming: design/plan review via html-plan page; plan.md still the terminal state.
       Run affected evals (design-exploration-before-code, durable-plan-written-to-disk) before release.
8. [x] ~/.claude/CLAUDE.md: delete "Dynamic Workflow — subagent model" section.

Not touched: herdr hook (managed by herdr), statusline, fast-jev-compaction, settings "model" (stale
claude-opus-4-8, reported to user only).

Task 7 result: released as superpower-planning v4.3.0 (e05a350), installed locally.
Evals: design-exploration A/B 3/6 vs 3/6 on Opus 5.5; durable-plan 0.89/0.89.

# Plan: general/academic modes, phase 1 (approved 2026-10-08 via html-plan response)
Page: https://cc.bbd.sh/plan/claude-modes-2026-10-08.html · design: design-modes.md
Decisions: general writes general values of the 4 keys; any .tex/.bib prompts; status only in academic; migrate 10 repos now.
1. [x] Verify repo-level skillOverrides overrides the global value (headless).
2. [x] mods/mode: profiles.ts, settings.ts, detect.ts, register.ts + tests; validate, tsc, test.
3. [x] marketplace entry + install; live check /mode in a scratch repo.
4. [x] Global skillOverrides academic-writing-context=off; add "on" to the 10 academic repos.
5. [x] Delete ~/.claude/skills/academic-setup (backup first).
