# Plan: claude-telegram Router and background workers (2026-11-01)

Design: `design.md`. Baseline: `claude plugin test mods/tg-progress` 19 pass.

1. `git mv mods/tg-progress mods/tg-router`; rename in `plugin.json`.
2. `mods/tg-channel/`: copy official telegram 0.0.7 (server.ts, package.json, bun.lock, .mcp.json,
   .claude-plugin/plugin.json, skills/, ACCESS.md, README.md, LICENSE) + NOTICE; add
   `reply_to_message_id` to inbound meta (server.ts ~974).
3. `mods/tg-router/src/tasks.ts`: store (create, byMessage, byAgent, addMessage, removeMessage, prune 14 d).
4. `mods/tg-router/src/gate.ts`: `routerDeny(e)`.
5. `mods/tg-router/src/prompts.ts`: worker brief and Router context text.
6. `mods/tg-router/hooks/register.ts`: session.start (register tools), prompt.submit (fast path,
   pending requests, Router context), tool.call (gate, dispatch, handback, cards by agentId),
   turn.complete (post worker answer, card final line).
7. Tests: `card.test.ts` parseChannelTag reply id; `register.test.ts` dispatch, fast path,
   handback, lost worker, answer posting, gate, card per worker.
8. Launcher + README (`examples/claude-telegram`, root README, marketplace if needed).
9. Checks: `claude plugin test mods/tg-router`, `claude plugin validate mods/tg-router`, tsc.
10. Live check in the resident pane (needs the user: restart of the live Telegram session).
