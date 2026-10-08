# Plan: Claude Code upgrade (mods + html-plan), 2026-10-08

Decisions (user, 2026-10-08):
- Mods live in this repo, a local folder marketplace installed at user scope.
- html-plan output: file only (no Mac sync, Artifacts stay off).
- html-plan takes over the plan step of superpower-planning's brainstorming.
- Global instructions: delete only the CLAUDE.md section a mod replaces; AGENTS.md untouched.

## Tasks
1. [ ] mods/subagent-opus: copy from old session dev-mods (agent.spawn → opus under Fable).
2. [ ] mods/no-bg-poll: port ~/.claude/hooks/no-bg-poll.sh to tool.call Bash guard.
3. [ ] mods/workflow-opus-guard: port ~/.claude/hooks/workflow-opus-guard.py to tool.call Workflow guard
       (agent.spawn can only deny workflow agents, so the whole-call guard stays at tool.call).
4. [ ] validate + tsc + `claude plugin test` for each mod.
5. [ ] marketplace add + install (user scope); remove the two settings.json hooks they replace; delete old scripts.
6. [ ] Install html-plan@claude-community (anthropics/claude-plugins-community).
7. [ ] superpower-planning brainstorming: design/plan review via html-plan page; plan.md still the terminal state.
       Run affected evals (design-exploration-before-code, durable-plan-written-to-disk) before release.
8. [ ] ~/.claude/CLAUDE.md: delete "Dynamic Workflow — subagent model" section.

Not touched: herdr hook (managed by herdr), statusline, fast-jev-compaction, settings "model" (stale
claude-opus-4-8, reported to user only).
