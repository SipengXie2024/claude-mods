# Plan: jev-opus as a Claude Code mod (`mods/jev`)

Approved by the user 2026-10-08: port jev-opus's routing into a function-hook mod, then replace the
`jc` gateway once verified (keep the gateway code for a while as fallback). Scope: policy.v8 in
full, the follow-up fault signal + advisor nudge, and two small ideas from jev-pilot.

## Why it works (verified 2026-10-08, Claude Code 2.1.294, evidence in jev-effort-research/.planning/progress.md)
- `turn.step` fires before every model request (main and subagents, `e.agentId`); `next({ ...e, effort })`
  changes that request's effort.
- Claude Code encodes each change as a per-message `{role:'system', output_config:{effort}}` at that point
  and keeps earlier ones; alternating medium/high every step kept the prompt cache (cache_read grew every
  request, ~126 tokens written per step). So the gateway's insertion/byte-replay/journal machinery is not needed.

## Source to port
jev-opus fork: /home/ubuntu/sipeng/jev-effort-research/jev-opus (branch selfhost, HEAD a0cbe01 = policy.v8 +
upstream 0.4.8). Port the pure logic, adapting only I/O:
- src/router/policy.ts (taskEffort, stepTarget, followUpEffort, thresholds, ablations, policyVersion)
- src/router/questions.ts (TASK_QUESTIONS task.v3, STEP_QUESTIONS, FOLLOWUP_QUESTIONS = v4)
- src/router/state.ts (issue reducer: fingerprints, xhighAttempts once per batch, environment blockers, since/audit)
- src/router/router.ts (EffortRouter: routeTask / routeStep, Jev answer validation, taskState / stepState /
  followUpState with full evaluator content, hysteresis, step-state caps)
- src/router/heuristics.ts, src/effort.ts, src/router/types.ts
- src/claude/describe.ts (upstream 0.4.8 tool-result classifier: classifyToolResult / summarizeToolCall / shell parsing)
- src/gateway/followup.ts (isHumanPrompt, previousPromptIndex, followUpSummary)
- src/jev/client.ts (systemone request/validation, confidence recompute, circuit breaker) — replace fetch with
  `$.http.fetch` and timers with `$.clock`; deadline via a race.
Drop: gateway server, transcript insertion/replay, journal replay, launch/claude spawning, SDK session driver.

## Mod design
- Location `/home/ubuntu/sipeng/claude-mods/mods/jev/` (plugin.json, hooks/hooks.json → ./register.ts,
  src/*.ts ported modules, types/index.d.ts if `$.state` is used, *.test.ts). Add it to the marketplace manifest
  and README table like the other mods.
- Config: read `~/.config/jev-opus/.env` (same keys as today: JEV_BASE_URL, JEV_API_KEY, JEV_DEADLINE_MS,
  JEV_OPUS_MIN/MAX_EFFORT, JEV_OPUS_DEEP_YES/NO, JEV_OPUS_DISSATISFACTION, JEV_OPUS_DISSAT_YES,
  JEV_OPUS_DISSAT_ADVISOR, JEV_OPUS_ABLATE, JEV_OPUS_STEP_STATE_MAX) through `$.fs`; never log secrets.
  Missing key → heuristics only.
- Events:
  - `prompt.submit` (main session, human prompt): task decision = Jev task ask, in parallel with the follow-up ask
    on followUpState(summary of the previous prompt's span from `$.session.messages()`, prompt) when there was a
    previous human prompt; apply followUpEffort (prevMax = highest effort used in the previous prompt, tracked by
    the mod; streak/hiLosses carried in mod state). Store the decision as the base for this prompt.
  - `tool.call`: `await next(e)`, classify the result with the ported classifier, feed the reducer for the agent's
    loop (main or `agentId`).
  - `turn.step`: for index 0 use the task decision; for later steps run routeStep on the tool batch since the last
    step (ask Jev only when the local gate says it matters, as router.ts does) and set `effort`. Subagents: their own
    router keyed by agentId, task decision from the subagent's first request/brief (agent.spawn or the first
    user message of its loop); no follow-up signal for subagents.
  - Manual override: if the session's own effort setting (`e.effort` before our rewrite) changes from what the
    person last set (they ran `/effort`), pin that level for the rest of the prompt, as the gateway did.
  - Advisor nudge: when followUpEffort says advisor and an advisor tool is available, add a one-turn instruction
    the model sees (prefer a context/attachment/section hook for this turn over editing the person's text; check
    the types file for the right event). Fixed text, as NOTES['advisor.v1'].
- Borrowed from jev-pilot: (a) the same file edited ≥ 4 times within a prompt counts as stuck evidence for
  stepTarget (local, no Jev call); (b) a short acknowledgement prompt (chat kind, e.g. 好的/继续/ok) never starts
  below the previous prompt's level.
- Observability: `$.ui.status` shows the effort trail for the current prompt (e.g. `Jev · medium → high`);
  `$.ui.toast` on a feedback raise or advisor nudge; append decisions (numbers/enums only, no prompt text) to
  `~/.config/jev-opus/mod-journal.jsonl` via `$.fs` (rotate/cap size).
- Failure behaviour: Jev timeout/failure/circuit open → heuristics, never block the request; any hook error →
  `next(e)` unchanged.

## Verification
- `claude plugin validate mods/jev`, `tsc` per the types header, `claude plugin test mods/jev` with ported unit
  tests (policy, state, classifier, followup, router with a stub Jev) plus mod-level tests of the hooks.
- Live (headless): `claude -p --plugin-dir mods/jev` direct to Anthropic (unset ANTHROPIC_BASE_URL) on a small
  multi-step task with a failing then passing test; check via a logging proxy that efforts change per step, the
  cache holds, the status/journal entries are right. With the Mac offline, run against a local stub
  /v1/systemone server; repeat against the real Jev when the Mac is back.
- Do not install it user-wide yet and do not touch `jc`; the switch happens after the user sees the results.
