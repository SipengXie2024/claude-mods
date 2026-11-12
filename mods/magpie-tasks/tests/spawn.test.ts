// spawn.ts and unavailable.ts (plan section 12.1, spawn row): every branch of decideSpawn, nextEffort
// (plan section 5) and unavailableAction (plan section 9.16). Inputs: rules/routing-rules.json (as
// tests/data/jev-rules.ts), the model fields of Magpie's launcher settings (MAGPIE_FLAG below), and real Jev judgments of two
// briefs (tests/data/jev-responses.ts): jevSpawnScheduler chose code-change, and jevSpawnNoRule (a
// Telegram question about the person's own discussions, tests/data/brief-deeper-question.txt) chose none.
import type { AgentSpawnInput } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { acceptanceBrief, parseMarker, parseStatus, parseVerdict } from '../src/brief'
import { parseResponse } from '../src/jev'
import { spawnJudgment } from '../src/judge'
import { catalogFrom, isAvailable, nameLevel, sameModel, withRuleModels, type ModelCatalog } from '../src/model'
import { borderPair, parseRules, ruleById } from '../src/rules'
import { dailyTaskDraft, decideSpawn, ROUTE_ORIGIN, markerFor, markRecorded, nextEffort, registerStarted, spawnPrecheck, startAtLevel, startedMarker, turnStarted, type RoutedTask, type SpawnDecision } from '../src/spawn'
import { freshState } from '../src/state'
import type { AgentRecord, JevJudgment } from '../src/types'
import { unavailableAction } from '../src/unavailable'
import { jevSpawnBorder, jevSpawnNoRule, jevSpawnScheduler, type SavedDecision } from './data/jev-responses'
import { briefBorderFormalize, briefDeeperQuestion } from './data/briefs'
import { channelPlain953 } from './data/channel-blocks'
import { routingRules } from './data/jev-rules'

// tg-router's worker briefs (mods/tg-router/src/prompts.ts workerBrief, generated 2026-11-09 for the
// two saved briefs); in claude-magpie tg-router puts the request header above them (plan 10.1).
const WORKER_BRIEFS: { telegram: string; terminal: string } = {
  "telegram": "You are a worker for one task that came from a Telegram chat: \"实现调度逻辑\".\nThe person's original message is at the end of this prompt; read it, not only the title.\n\n- Your final answer of each turn is posted, as written, as a Telegram reply under that message.\n  Write it in Chinese, at most 100 words: the result first, then paths, links or commit ids.\n  Plain text only: Telegram shows Markdown marks such as ** and backquotes as typed.\n  Do not send or edit Telegram messages yourself; the host sends your answer. A file the\n  message carries as attachment_file_id is fetched with the channel's download_attachment tool.\n- If you need a decision from the person, end the turn with one concrete question and stop.\n- A later Telegram message about this task reaches you as a message in this conversation.\n  If one is not about this task, do not work on it: put a line\n  HANDBACK <its message_id>: <one-sentence reason>\n  in your final answer. The host gives it back to the Router and removes the line.\n- Before you edit a git repository that another task or a person may also be editing,\n  work in your own worktree and branch.\n- Do the whole task and verify it. Report failures as failures.\n\nThe original message:\n实现并验证调度逻辑：按 .planning/plan-scheduler.md 中已确认的设计，在 src/scheduler.ts 实现优先级队列调度（同一优先级按到达顺序执行），补充单元测试，运行 bun test 确认全部通过，报告修改的文件与测试结果。",
  "terminal": "You are a worker for one task the person typed in the terminal of the Router session: \"统计 greet.py 行数\".\nThe person's original message is at the end of this prompt; read it, not only the title.\n\n- Your final answer of each turn is shown to the person in that terminal. Write it in Chinese:\n  the result first, then paths, links or commit ids. Markdown is fine.\n- If you need a decision from the person, end the turn with one concrete question and stop.\n- A later message about this task reaches you as a message in this conversation.\n- Before you edit a git repository that another task or a person may also be editing,\n  work in your own worktree and branch.\n- Do the whole task and verify it. Report failures as failures.\n\nThe original message:\n统计 greet.py 有几行，只回答数字。"
}
const HEADER = '[magpie-tasks-request daily chat=7051661301 message=878 worker=tg-7051661301-878]'
const NOW = 1762650000000
// A real executor answer (claude-magpie -p, claude/claude-opus-5-5, session 5b92fcdf-e255-4c06-aa20-04b656038433) to a brief withRouting wrote.
const EXECUTOR_DONE = "`/tmp/f-gen/work/greet.py` 共有 6 行。文件末尾带换行符，所以 `wc -l` 统计的数字就是实际行数。\n\n验证：\n`wc -l /tmp/f-gen/work/greet.py`：输出 6\n`tail -c1 /tmp/f-gen/work/greet.py | xxd`：最后一个字节是 0a，即换行符\n状态：已完成"

const rules = parseRules(routingRules, { deepYes: 0.85 })
const SCHEDULER = jevSpawnScheduler.request.input[0]!.content
// The no-rule request: what Jev was asked (the person's words), and the brief tg-router wrote for it.
const NO_RULE = jevSpawnNoRule.request.input[0]!.content
const NO_RULE_HEADER = '[magpie-tasks-request daily chat=7051661301 message=1181 worker=tg-7051661301-1181]'

// The model fields of ~/.config/magpie/claude-launch/settings.json (read 2026-11-09): modelPicker.options[].model
// and the four alias variables and capability string of env; the rest of env (credentials) is left out.
const MAGPIE_FLAG = {
  "modelPicker": {
    "options": [
      {
        "model": "claude/claude-haiku-5-5[1m]"
      },
      {
        "model": "claude/claude-sonnet-5-5[1m]"
      },
      {
        "model": "claude/claude-opus-5-5[1m]"
      },
      {
        "model": "claude/claude-fable-5-1[1m]"
      },
      {
        "model": "claude/claude-opus-5[1m]"
      },
      {
        "model": "claude/claude-sonnet-5[1m]"
      },
      {
        "model": "claude/claude-fable-5[1m]"
      },
      {
        "model": "claude/claude-opus-4-8[1m]"
      },
      {
        "model": "claude/claude-opus-4-7[1m]"
      },
      {
        "model": "claude/claude-sonnet-4-6[1m]"
      },
      {
        "model": "claude/claude-opus-4-6[1m]"
      },
      {
        "model": "claude/claude-opus-4-5"
      },
      {
        "model": "claude/claude-opus-4-5-20251101"
      },
      {
        "model": "claude/claude-haiku-4-5"
      },
      {
        "model": "claude/claude-haiku-4-5-20251001"
      },
      {
        "model": "claude/claude-sonnet-4-5"
      },
      {
        "model": "claude/claude-sonnet-4-5-20250929"
      },
      {
        "model": "codex/gpt-6.1-sol"
      },
      {
        "model": "codex/gpt-6-astra"
      },
      {
        "model": "codex/gpt-6.1-terra"
      },
      {
        "model": "codex/gpt-6-sol"
      },
      {
        "model": "codex/gpt-6-luna"
      },
      {
        "model": "codex/gpt-5.6-sol"
      },
      {
        "model": "codex/gpt-5.6-terra"
      },
      {
        "model": "codex/gpt-5.6-luna"
      }
    ]
  },
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude/claude-opus-5-5[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude/claude-sonnet-5-5[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "codex/gpt-6-astra",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude/claude-fable-5-1[1m]",
    "CLAUDE_CODE_MODEL_CAPABILITIES": "claude/claude-sonnet-5-5=effort,xhigh_effort,max_effort;claude/claude-opus-5-5=effort,xhigh_effort,max_effort;claude/claude-fable-5-1=effort,xhigh_effort,max_effort;codex/gpt-6-astra=effort,xhigh_effort,max_effort;claude/claude-haiku-5-5=effort,xhigh_effort,max_effort;claude/claude-opus-5=effort,xhigh_effort,max_effort;claude/claude-sonnet-5=effort,xhigh_effort,max_effort;claude/claude-fable-5=effort,xhigh_effort,max_effort;claude/claude-opus-4-8=effort,xhigh_effort,max_effort;claude/claude-opus-4-7=effort,xhigh_effort,max_effort;claude/claude-sonnet-4-6=effort,max_effort;claude/claude-opus-4-6=effort,max_effort;claude/claude-opus-4-5=effort;claude/claude-opus-4-5-20251101=effort;codex/gpt-6.1-sol=effort,xhigh_effort,max_effort;codex/gpt-6.1-terra=effort,xhigh_effort,max_effort;codex/gpt-6-sol=effort,xhigh_effort,max_effort;codex/gpt-6-luna=effort,xhigh_effort,max_effort;codex/gpt-5.6-sol=effort,xhigh_effort,max_effort;codex/gpt-5.6-terra=effort,xhigh_effort,max_effort;codex/gpt-5.6-luna=effort,xhigh_effort,max_effort"
  }
}

// As hooks/register.ts builds it: Magpie's picker plus the models the routing rules name.
const cat = withRuleModels(catalogFrom(MAGPIE_FLAG), Object.keys(rules.models))

function judged(s: SavedDecision): JevJudgment {
  const p = parseResponse(s.body, s.request.questions)
  return spawnJudgment(p.answers, { latencyMs: 0, inputTokens: p.inputTokens, ...(p.cachedTokens !== undefined ? { cachedTokens: p.cachedTokens } : {}) }, rules)
}

function spawn(prompt: string, more: Partial<AgentSpawnInput> = {}): AgentSpawnInput {
  return {
    tool_use_id: 'toolu_01', prompt, description: 'scheduler', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude/claude-opus-5-5[1m]', background: true, fork: false, ...more,
  }
}

const daily = (): RoutedTask => {
  const { header: _h, ...t } = dailyTaskDraft({ prompt: `${HEADER}\n${WORKER_BRIEFS.telegram}`, description: '实现调度逻辑', id: 'd-20261109-k3x9q2', now: NOW })
  return t
}
const WT = '/home/ubuntu/.local/share/magpie-tasks/worktrees/l-20261109-p7m2c4'
const long = (): RoutedTask => ({ ...daily(), id: 'l-20261109-p7m2c4', kind: 'long', telegram: { chatId: '7051661301' }, project: { root: '/home/ubuntu/proj' }, worktree: { path: WT, baseRef: 'refs/magpie-tasks/l-20261109-p7m2c4/base', baseCommit: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' } })

// `rand` draws the model for work on a rule border; other decisions never call it.
function decide(e: AgentSpawnInput, task: RoutedTask | null, j: JevJudgment, agents: Record<string, string> = {}, origin = 'engine', rand: () => number = () => { throw new Error('no draw expected') }): SpawnDecision {
  return decideSpawn({ e, origin, task, judgment: j, rules, catalog: cat, lookupAgentModel: id => agents[id], session: { id: 'sess-1', cwd: '/home/ubuntu' }, rand })
}

function routed(d: SpawnDecision): Extract<SpawnDecision, { action: 'route' | 'assess' }> {
  if (d.action !== 'route' && d.action !== 'assess') throw new Error(`expected a routed spawn, got ${JSON.stringify(d)}`)
  return d
}

test('fork, workflow, teammate, resume, the plugin\'s own relay and spawns outside a task pass', () => {
  const j = judged(jevSpawnScheduler)
  const task = long()
  for (const e of [
    spawn(SCHEDULER, { fork: true }),
    spawn(SCHEDULER, { workflow: { runId: 'wf_1', agentIndex: 1 } }),
    spawn(SCHEDULER, { isTeammate: true }),
    spawn(SCHEDULER, { resume: { agentId: 'a1' } }),
  ]) expect(decide(e, task, j)).toEqual({ action: 'pass' })
  expect(decideSpawn({ e: spawn(SCHEDULER), origin: 'magpie-tasks', task, judgment: j, rules, catalog: cat, lookupAgentModel: () => undefined, session: { id: 's', cwd: '/' }, rand: Math.random })).toEqual({ action: 'pass' })
  expect(decide(spawn(SCHEDULER), null, j)).toEqual({ action: 'pass' })
  // Decided before any judgment, so onAgentSpawn asks Jev only when routing needs it.
  expect(spawnPrecheck({ e: spawn(SCHEDULER, { fork: true }), origin: 'engine', task })).toEqual({ action: 'pass' })
  expect(spawnPrecheck({ e: spawn(SCHEDULER), origin: 'engine', task })).toBe(null)
})

test('a rule match routes to the rule\'s model at its start effort, in the task worktree', () => {
  const d = routed(decide(spawn(SCHEDULER), long(), judged(jevSpawnScheduler)))
  expect(d.action).toBe('route')
  expect(d.rewrite.model).toBe('claude/claude-opus-5-5[1m]')
  expect(d.rewrite.cwd).toBe(WT)
  expect(d.rewrite.description).toBe('scheduler · Opus 5.5/high')
  expect(parseMarker(d.rewrite.prompt)).toEqual({ taskId: 'l-20261109-p7m2c4', role: 'implementer', ruleId: 'code-change', rulesVersion: rules.version, model: 'claude/claude-opus-5-5', effort: 'high' })
  expect(d.rewrite.prompt.includes(SCHEDULER)).toBe(true)
  expect(d.agent).toMatchObject({ role: 'implementer', ruleId: 'code-change', model: 'claude/claude-opus-5-5', effort: 'high', worktree: WT, cwd: WT, sessionId: 'sess-1', selection: { kind: 'rule' } })
  expect(d.agent.efforts).toEqual([{ from: null, to: 'high', reason: 'rule' }])
  expect(d.notice.includes('code-change')).toBe(true)
  // Jev judged deep: a deep effort above the start is recorded as its own change (review: medium, then high).
  const review = rules.rules.find(r => r.id === 'review')!
  const reviewDeep = routed(decide(spawn(SCHEDULER), long(), { ...judged(jevSpawnScheduler), ruleChoice: review.id, deep: true, deepP: 0.9 }))
  expect(reviewDeep.agent.efforts).toEqual([{ from: null, to: 'medium', reason: 'rule' }, { from: 'medium', to: 'high', reason: 'deep' }])
  // code-change starts at high when judged deep too (section 2.4): no deep change.
  const deep = routed(decide(spawn(SCHEDULER), long(), { ...judged(jevSpawnScheduler), deep: true, deepP: 0.9 }))
  expect([deep.agent.model, deep.agent.effort]).toEqual(['claude/claude-opus-5-5', 'high'])
  expect(deep.agent.efforts).toEqual([{ from: null, to: 'high', reason: 'rule' }])
  // The largest work, Jev's deep probability at or above hardYes (0.95), goes to code-change's hardModel.
  const hard = routed(decide(spawn(SCHEDULER), long(), { ...judged(jevSpawnScheduler), deep: true, deepP: 0.97 }))
  expect([hard.agent.model, hard.agent.effort, hard.rewrite.model]).toEqual(['claude/claude-mythos-5-2', 'high', 'claude/claude-mythos-5-2'])
  expect(hard.agent.selection.reason).toContain("Jev's deep probability 0.97 reaches 0.95, the largest work of this rule")
  expect(routed(decide(spawn(SCHEDULER), long(), { ...judged(jevSpawnScheduler), deep: true, deepP: 0.95 })).agent.model).toBe('claude/claude-mythos-5-2')
  // A substitute judgment has no probability: the rule's own model.
  const sub = routed(decide(spawn(SCHEDULER), long(), { ...judged(jevSpawnScheduler), provider: 'substitute', substituteReason: 'key file missing', deep: true, deepP: null }))
  expect(sub.agent.model).toBe('claude/claude-opus-5-5')
})

test('a daily task\'s first agent is its executor; the routing note is the Telegram line', () => {
  const d = routed(decide(spawn(`${HEADER}\n${WORKER_BRIEFS.telegram}`, { name: 'tg-7051661301-878' }), daily(), judged(jevSpawnScheduler)))
  expect(d.action).toBe('route')
  expect(d.agent).toMatchObject({ role: 'executor', name: 'tg-7051661301-878', worktree: null, cwd: '/home/ubuntu' })
  expect(d.rewrite.cwd).toBe(undefined)
  expect(d.rewrite.prompt.includes('mcp__magpie-tasks__open_project')).toBe(true)
  const c = judged(jevSpawnScheduler).confidence.toFixed(2)
  expect(d.notice).toBe(`模型：Opus 5.5 · high · 规则 code-change（Jev 置信度 ${c}）`)
  const sub = routed(decide(spawn(`${HEADER}\n${WORKER_BRIEFS.telegram}`), daily(), { ...judged(jevSpawnScheduler), provider: 'substitute', substituteReason: 'key file missing' }))
  expect(sub.notice).toBe(`模型：Opus 5.5 · high · 规则 code-change（Jev 置信度 ${c}；由评估模型代为判断）`)
  const hard = routed(decide(spawn(`${HEADER}\n${WORKER_BRIEFS.telegram}`), daily(), { ...judged(jevSpawnScheduler), deep: true, deepP: 0.97 }))
  expect(hard.notice).toBe(`模型：Mythos 5.2 · high · 规则 code-change（Jev 置信度 ${c}；需要深入推理；深入推理概率 0.97，达到 0.95，属于这类工作中规模最大的）`)
})

test('an explicit model needs the person\'s words; a recommendation only through model_route, and it must name a listed model', () => {
  const j = judged(jevSpawnScheduler)
  const bare = decide(spawn(SCHEDULER, { model: 'codex/gpt-6.1-sol' }), long(), j)
  expect(bare.action).toBe('deny')
  expect(bare).toEqual({ action: 'deny', reason: 'An explicit model needs the person\'s words: add "[model-reason user: <the person\'s words>]" when the person chose it. To recommend a model yourself, delegate with mcp__magpie-tasks__model_route, where Jev weighs your recommendation against the routing table; or leave the model out so the routing rules choose.' })
  expect(spawnPrecheck({ e: spawn(SCHEDULER, { model: 'haiku' }), origin: 'engine', task: long() })!.action).toBe('deny')

  const user = routed(decide(spawn(`${SCHEDULER}\n[model-reason user: 测试不可用模型]`, { model: 'codex/gpt-6-magpie-missing' }), long(), j))
  expect(user.rewrite.model).toBe('codex/gpt-6-magpie-missing')
  expect(user.agent).toMatchObject({ model: 'codex/gpt-6-magpie-missing', effort: 'high', selection: { kind: 'user', reason: '测试不可用模型', userConfirmation: '测试不可用模型' } })

  // A model the Agent tool's input cannot carry is named by a [model <id>] line in the brief.
  const line = routed(decide(spawn(`${SCHEDULER}\n[model codex/gpt-6-magpie-missing]\n[model-reason user: 测试不可用模型]`), long(), j))
  expect(line.rewrite.model).toBe('codex/gpt-6-magpie-missing')
  expect(line.agent).toMatchObject({ model: 'codex/gpt-6-magpie-missing', selection: { kind: 'user' } })
  expect(spawnPrecheck({ e: spawn(`${SCHEDULER}\n[model codex/gpt-6.1-sol]`), origin: 'engine', task: long() })!.action).toBe('deny')

  // The Agent tool cannot carry the architect's own recommendation; model_route (ROUTE_ORIGIN) can.
  const viaAgent = decide(spawn(`${SCHEDULER}\n[model-reason evidence: 诊断 a1 建议换 Sol]\n[effort high]`, { model: 'codex/gpt-6.1-sol' }), long(), j)
  expect(viaAgent.action === 'deny' && viaAgent.reason.startsWith('A model you recommend goes through mcp__magpie-tasks__model_route')).toBe(true)
  const missing = decide(spawn(`${SCHEDULER}\n[model-reason evidence: 诊断建议]`, { model: 'codex/gpt-6-magpie-missing' }), long(), j, {}, ROUTE_ORIGIN)
  expect(missing.action).toBe('deny')
  const adjusted = routed(decide(spawn(`${SCHEDULER}\n[model-reason evidence: 诊断 a1 建议换 Sol]\n[effort high]`, { model: 'codex/gpt-6.1-sol' }), long(), j, {}, ROUTE_ORIGIN))
  expect(adjusted.agent).toMatchObject({ model: 'codex/gpt-6.1-sol', effort: 'high', ruleId: 'code-change', selection: { kind: 'adjusted' } })
  expect(adjusted.agent.efforts).toEqual([{ from: null, to: 'high', reason: 'explicit' }])
  expect(adjusted.rewrite.model).toBe('codex/gpt-6.1-sol')

  // No rule and no [effort]: the architect is asked for one; a daily task goes to the assessment.
  const noRule = decide(spawn(`${NO_RULE}\n[model-reason user: 用 Sol]`, { model: 'codex/gpt-6.1-sol' }), long(), judged(jevSpawnNoRule))
  expect(noRule.action === 'deny' && noRule.reason.includes('[effort')).toBe(true)
  const withEffort = routed(decide(spawn(`${NO_RULE}\n[model-reason user: 用 Sol]\n[effort low]`, { model: 'codex/gpt-6.1-sol' }), long(), judged(jevSpawnNoRule)))
  expect(withEffort.agent).toMatchObject({ ruleId: null, effort: 'low', selection: { kind: 'user' } })
})

test('under a Fable parent, subagent-opus\'s `opus` without a reason line is routed by the rules', () => {
  const j = judged(jevSpawnScheduler)
  const e = spawn(SCHEDULER, { model: 'opus', parentModel: 'claude/claude-fable-5-1[1m]', parentAgentId: 'afable01' })
  const d = routed(decide(e, long(), j))
  expect(d.agent).toMatchObject({ role: 'helper', parentAgentId: 'afable01', selection: { kind: 'rule' }, ruleId: 'code-change' })
  expect(d.rewrite.model).toBe('claude/claude-opus-5-5[1m]')
  // The same `opus` under an Opus parent is an explicit model and needs its reason.
  expect(decide(spawn(SCHEDULER, { model: 'opus' }), long(), j).action).toBe('deny')
})

test('review-second excludes the reviewed models; with none left the architect is told, a daily task is assessed', () => {
  const j = judged(jevSpawnScheduler)
  const sol = routed(decide(spawn(`${SCHEDULER}\n[review-of model=codex/gpt-6.1-sol]`), long(), j))
  expect(sol.agent).toMatchObject({ ruleId: 'review-second', model: 'claude/claude-opus-5-5', effort: 'medium', reviewOf: ['codex/gpt-6.1-sol'], selection: { kind: 'review-second' } })
  const byAgent = routed(decide(spawn(`${SCHEDULER}\n[review-of agent=a83b0057bf058d018]`), long(), j, { a83b0057bf058d018: 'claude/claude-opus-5-5' }))
  expect(byAgent.agent).toMatchObject({ model: 'codex/gpt-6.1-sol', reviewOf: ['claude/claude-opus-5-5'] })
  expect(byAgent.rewrite.model).toBe('codex/gpt-6.1-sol')
  const unknown = decide(spawn(`${SCHEDULER}\n[review-of agent=anobody]`), long(), j)
  expect(unknown.action).toBe('deny')
  // Opus and Sol both reviewed: Argon, the third candidate, at the same medium.
  const both = routed(decide(spawn(`${SCHEDULER}\n[review-of model=codex/gpt-6.1-sol,opus]`), long(), j))
  expect(both.agent).toMatchObject({ ruleId: 'review-second', model: 'hakimi/gemini-4-argon-medium', effort: 'medium' })
  const all = `${SCHEDULER}\n[review-of model=codex/gpt-6.1-sol,opus,hakimi/gemini-4-argon-medium]`
  const none = decide(spawn(all), long(), j)
  expect(none.action === 'deny' && none.reason.startsWith('No model is left for an independent second review')).toBe(true)
  const dailyNone = routed(decide(spawn(`${HEADER}\n${WORKER_BRIEFS.telegram}\n[review-of model=codex/gpt-6.1-sol,claude/claude-opus-5-5[1m],hakimi/gemini-4-argon-medium]`), daily(), j))
  expect(dailyNone.action).toBe('assess')
})

test('no matching rule: the architect gets the reason, a daily request runs on the daily default', () => {
  const j = judged(jevSpawnNoRule)
  const arch = decide(spawn(NO_RULE), long(), j)
  expect(arch.action).toBe('deny')
  expect(arch.action === 'deny' && arch.reason.includes(`choice none, confidence ${j.confidence.toFixed(2)}`)).toBe(true)
  const tg = `${NO_RULE_HEADER}\n${briefDeeperQuestion}`
  const { header: _h, ...task } = dailyTaskDraft({ prompt: tg, description: '一直没问出口的深层问题', id: 'd-20261108-r8t1w0', now: NOW })
  expect(task.telegram).toEqual({ chatId: '7051661301', rootMessageId: 1181, workerName: 'tg-7051661301-1181' })
  expect(task.title).toBe('一直没问出口的深层问题')
  const d = routed(decide(spawn(tg, { name: 'tg-7051661301-1181' }), task, j))
  expect(d.action).toBe('route')
  expect(d.agent).toMatchObject({ role: 'executor', name: 'tg-7051661301-1181', ruleId: 'daily-default', model: 'claude/claude-opus-5-5' })
  expect(d.agent.selection.reason.slice(0, 22)).toBe('no routing rule fits (')
  expect(d.notice).toBe(`模型：Opus 5.5 · medium · 没有匹配的路由规则，用日常默认模型（Jev 首选 none，置信度 ${j.confidence.toFixed(2)}）`)
  expect(parseMarker(d.rewrite.prompt)).toMatchObject({ role: 'executor', ruleId: 'daily-default', effort: 'medium' })
  // A helper inside a daily task is refused like the architect: its executor decides.
  const helper = decide(spawn(NO_RULE, { parentAgentId: 'aexec' }), task, j)
  expect(helper.action).toBe('deny')
})

test('work on the border of two rules whose models differ: a model drawn from rules.ambiguous at its own effort', () => {
  // A real brief (formalize-and-substitute, blockchain-catchup) Jev splits between math (Sol 6.1)
  // and explain-write (Argon), its first choice below ruleConfidence.
  const j = judged(jevSpawnBorder)
  expect(j.confidence).toBeLessThan(rules.thresholds.ruleConfidence)
  expect(borderPair(j, rules)).toEqual({ first: { ruleId: 'math', p: 0.41 }, second: { ruleId: 'explain-write', p: 0.16 } })
  const draws = [0, 0.3, 0.6, 0.99].map(r => routed(decide(spawn(briefBorderFormalize), long(), j, {}, 'engine', () => r)))
  expect(draws.map(d => [d.agent.model, d.agent.effort, d.agent.ruleId, d.agent.selection.kind])).toEqual([
    ['claude/claude-mythos-5-2', 'high', null, 'ambiguous'],
    ['hakimi/gemini-4-carbon-high', 'high', null, 'ambiguous'],
    ['claude/claude-opus-5-5', 'xhigh', null, 'ambiguous'],
    ['codex/gpt-6-astra', 'max', null, 'ambiguous'],
  ])
  expect(draws[0]!.agent.selection.reason).toContain('between rule math (0.41) and rule explain-write (0.16), whose models differ')
  expect(draws[3]!.agent.efforts).toEqual([{ from: null, to: 'max', reason: 'rule' }])
  expect(parseMarker(draws[3]!.rewrite.prompt)).toMatchObject({ role: 'implementer', ruleId: null, model: 'codex/gpt-6-astra', effort: 'max' })
  // A daily task's executor is drawn the same way; the Telegram line names the two rules.
  const d = routed(decide(spawn(briefBorderFormalize, { name: 'tg-7051661301-953' }), daily(), j, {}, 'engine', () => 0.5))
  expect(d.agent).toMatchObject({ role: 'executor', model: 'claude/claude-opus-5-5', effort: 'xhigh', ruleId: null })
  expect(d.notice).toBe('模型：Opus 5.5 · xhigh · 规则拿不准（Jev 在 math 0.41 与 explain-write 0.16 之间，两条规则用的模型不同），从 Mythos 5.2、Carbon high、Opus 5.5、Astra 中随机选取')
  // The substitute evaluator gives one choice and no second option: no border, the usual no-rule path.
  expect(borderPair({ ...j, provider: 'substitute' }, rules)).toBeNull()
  // A border agent raised after a failed acceptance steps one level up, as an agent without a rule.
  expect(nextEffort({ rule: null, current: 'high', deep: null, raises: ['acceptance-failed'] }).effort).toBe('xhigh')
})

test('a Telegram request is the channel block; the daily task title is the one tg-router gave it', () => {
  const brief = WORKER_BRIEFS.telegram.replace(/The original message:\n[\s\S]*$/, `The original message:\n${channelPlain953}`)
  const { header: _h, ...task } = dailyTaskDraft({ prompt: `${HEADER}\n${brief}`, description: ' 实现调度逻辑 ', id: 'd-20261110-vghxca', now: NOW })
  expect(task.request).toBe(channelPlain953)
  expect(task.title).toBe('实现调度逻辑')
  expect(() => dailyTaskDraft({ prompt: `${HEADER}\n${brief}`, description: ' ', id: 'd-20261110-vghxca', now: NOW })).toThrow('started without a title')
})

test('a daily task whose person-chosen model has no rule effort: the assessment recommends the effort for that model', () => {
  const j = judged(jevSpawnNoRule)
  // tg-router's dispatch under claude-magpie: request header, the person's reason line, then the worker brief.
  const words = '这个用 Sol 6.1 做'
  const prompt = `${NO_RULE_HEADER}\n[model-reason user: ${words}]\n${briefDeeperQuestion}`
  const { header: _h, ...task } = dailyTaskDraft({ prompt, description: '一直没问出口的深层问题', id: 'd-20261108-r8t1w0', now: NOW })
  const d = routed(decide(spawn(prompt, { name: 'tg-7051661301-1181', model: 'codex/gpt-6.1-sol' }), task, j))
  expect(d.action).toBe('assess')
  expect(d.agent).toMatchObject({ role: 'assessment', ruleId: 'route-assessment' })
  expect(d.agent.selection.reason.includes(`the person chose codex/gpt-6.1-sol (${words})`)).toBe(true)
  expect(d.rewrite.prompt.includes(`The person asked for the model Sol 6.1 (codex/gpt-6.1-sol) in their own words: "${words}"`)).toBe(true)
  expect(d.rewrite.prompt.includes('recommend the reasoning effort the chosen model should run at')).toBe(true)
  expect(d.notice.startsWith(`用户指定 Sol 6.1：${words}。`)).toBe(true)
  expect(d.notice.endsWith('先由评估子代理（Mythos 5.2 · high）推荐 Sol 6.1 的思考强度')).toBe(true)
  // The decision carries the choice; onAgentSpawn records it so a substitute assessment is briefed with it too.
  expect(d.requestedModel).toEqual({ model: 'codex/gpt-6.1-sol', reason: words })
  // Without the person's choice the assessment recommends the model itself.
  const plain = routed(decide(spawn(`${NO_RULE_HEADER}\n${briefDeeperQuestion}`, { name: 'tg-7051661301-1181' }), task, j))
  expect(plain.rewrite.prompt.includes('The person asked for the model')).toBe(false)
  expect(plain.requestedModel).toBe(undefined)
})

test('a routed agent\'s first turn is its first whether turn.start comes before or after its spawn resolves', () => {
  const task = daily()
  const d = routed(decide(spawn(`${HEADER}\n${WORKER_BRIEFS.telegram}`, { name: 'tg-7051661301-878' }), task, judged(jevSpawnScheduler)))
  const m = markerFor(task.id, d.agent)
  const text = d.rewrite.prompt
  const wake = 'The person answered about the blocked task:\n继续'

  // The spawn resolves first, then the agent's first turn starts: the second turn is a resume.
  const a = freshState()
  registerStarted(a, 'aspawnfirst01', m)
  expect(a.agents.get('aspawnfirst01')).toBe(task.id)
  expect(startedMarker('aspawnfirst01')).toEqual(m)
  turnStarted(a, 'aspawnfirst01', text)
  expect(a.freshSpawn.has('aspawnfirst01')).toBe(false)
  expect(a.pendingReask.has('aspawnfirst01')).toBe(false)
  turnStarted(a, 'aspawnfirst01', wake)
  expect(a.pendingReask.get('aspawnfirst01')).toBe(wake)
  markRecorded('aspawnfirst01')
  expect(startedMarker('aspawnfirst01')).toBe(undefined)

  // The agent's first turn starts before its spawn resolves: the marker identifies it, and the late
  // registration does not mark its next turn as a first one.
  const b = freshState()
  turnStarted(b, 'astartfirst02', text)
  expect(b.agents.get('astartfirst02')).toBe(task.id)
  expect(startedMarker('astartfirst02')).toEqual(m)
  expect(b.pendingReask.has('astartfirst02')).toBe(false)
  registerStarted(b, 'astartfirst02', m)
  expect(b.freshSpawn.has('astartfirst02')).toBe(false)
  turnStarted(b, 'astartfirst02', wake)
  expect(b.pendingReask.get('astartfirst02')).toBe(wake)
  markRecorded('astartfirst02')

  // A subagent whose brief has no marker is not this plugin's.
  const c = freshState()
  turnStarted(c, 'aplain03', WORKER_BRIEFS.terminal)
  expect(c.agents.has('aplain03')).toBe(false)
})

test('nextEffort follows section 5: the rule\'s deep effort and raise order', () => {
  const code = ruleById(rules, 'code-change')
  expect(nextEffort({ rule: code, current: 'high', deep: false, raises: [] })).toEqual({ effort: 'high', changes: [] })
  // code-change's deep start is high (section 2.4): a resume judged deep stays at high.
  expect(nextEffort({ rule: code, current: 'high', deep: true, raises: [] })).toEqual({ effort: 'high', changes: [] })
  expect(nextEffort({ rule: ruleById(rules, 'review'), current: 'medium', deep: true, raises: [] })).toEqual({ effort: 'high', changes: [{ from: 'medium', to: 'high', reason: 'resume-deep' }] })
  // A resume never lowers the effort.
  expect(nextEffort({ rule: ruleById(rules, 'review'), current: 'xhigh', deep: false, raises: [] })).toEqual({ effort: 'xhigh', changes: [] })
  expect(nextEffort({ rule: ruleById(rules, 'review'), current: 'medium', deep: null, raises: ['acceptance-failed'] }))
    .toEqual({ effort: 'high', changes: [{ from: 'medium', to: 'high', reason: 'acceptance-failed' }] })
  expect(nextEffort({ rule: code, current: 'xhigh', deep: true, raises: ['diagnosis-redelegate', 'acceptance-failed'] }))
    .toEqual({ effort: 'max', changes: [{ from: 'xhigh', to: 'max', reason: 'diagnosis-redelegate' }, { from: 'max', to: 'max', reason: 'acceptance-failed', note: 'already at the top of the raise order' }] })
  // Mythos 5.2 science starts at high when deep too, and a failure skips xhigh (Terminal-Bench-Science high 70.0, xhigh 67.6, max 73.3).
  const science = ruleById(rules, 'science-compute')
  expect(nextEffort({ rule: science, current: 'high', deep: true, raises: [] })).toEqual({ effort: 'high', changes: [] })
  expect(nextEffort({ rule: science, current: 'high', deep: false, raises: ['acceptance-failed'] }))
    .toEqual({ effort: 'max', changes: [{ from: 'high', to: 'max', reason: 'acceptance-failed' }] })
  // An explicit start effort is a start reason only: on resume a matching rule's start effort applies.
  expect(nextEffort({ rule: code, current: 'low', deep: true, raises: [], explicit: 'low' }))
    .toEqual({ effort: 'high', changes: [{ from: 'low', to: 'high', reason: 'resume-deep' }] })
  expect(nextEffort({ rule: code, current: 'low', deep: false, raises: [], explicit: 'low' }))
    .toEqual({ effort: 'high', changes: [{ from: 'low', to: 'high', reason: 'resume-deep' }] })
  expect(nextEffort({ rule: null, current: 'high', deep: true, raises: [] })).toEqual({ effort: 'high', changes: [] })
  expect(nextEffort({ rule: null, current: 'high', deep: true, raises: [], explicit: 'low' })).toEqual({ effort: 'high', changes: [] })
  expect(nextEffort({ rule: null, current: 'high', deep: null, raises: ['acceptance-failed'] })).toEqual({ effort: 'xhigh', changes: [{ from: 'high', to: 'xhigh', reason: 'acceptance-failed' }] })
})

test('a model whose ID names its level runs at that level: its start, a resume and a raise keep it, and the record says so', () => {
  const at = (level: string) => `the model runs at ${level}, the level its ID names`
  const j = judged(jevSpawnScheduler)
  // review-second's third candidate on a brief judged deep: Argon medium starts at medium, and the
  // deep start (high) is not recorded, since the model cannot run at it.
  const review = routed(decide(spawn(`${SCHEDULER}\n[review-of model=codex/gpt-6.1-sol,opus]`), long(), { ...j, deep: true }))
  expect(review.agent).toMatchObject({ model: 'hakimi/gemini-4-argon-medium', effort: 'medium', efforts: [{ from: null, to: 'medium', reason: 'rule' }] })
  expect(parseMarker(review.rewrite.prompt)).toMatchObject({ model: 'hakimi/gemini-4-argon-medium', effort: 'medium' })
  // The person's model with no matching rule needs no effort line; an effort line asking for another
  // level is kept in the note.
  const noRule = judged(jevSpawnNoRule)
  const chosen = routed(decide(spawn(`${NO_RULE}\n[model-reason user: 用 Carbon high]`, { model: 'hakimi/gemini-4-carbon-high' }), long(), noRule))
  expect(chosen.agent).toMatchObject({ model: 'hakimi/gemini-4-carbon-high', effort: 'high', efforts: [{ from: null, to: 'high', reason: 'explicit', note: at('high') }] })
  const asked = routed(decide(spawn(`${NO_RULE}\n[model-reason user: 用 Carbon high]\n[effort xhigh]`, { model: 'hakimi/gemini-4-carbon-high' }), long(), noRule))
  expect(asked.agent).toMatchObject({ effort: 'high', efforts: [{ from: null, to: 'high', reason: 'explicit', note: `xhigh asked; ${at('high')}` }] })
  const tg = `${NO_RULE_HEADER}\n${briefDeeperQuestion}\n[model-reason user: 用 Carbon high]`
  const { header: _h, ...task } = dailyTaskDraft({ prompt: tg, description: '一直没问出口的深层问题', id: 'd-20261112-c4rb0n', now: NOW })
  const executor = routed(decide(spawn(tg, { name: 'tg-7051661301-1181', model: 'hakimi/gemini-4-carbon-high' }), task, noRule))
  expect([executor.action, executor.agent.model, executor.agent.effort]).toEqual(['route', 'hakimi/gemini-4-carbon-high', 'high'])

  // A takeover's start list (spawnAgent) and a diagnosis redelegation: the start is the level, the raise
  // is recorded from and to it.
  expect(startAtLevel('hakimi/gemini-4-carbon-medium', [{ from: null, to: 'medium', reason: 'explicit', note: 'diagnosis suggestion' }, { from: 'medium', to: 'high', reason: 'diagnosis-redelegate' }]))
    .toEqual([{ from: null, to: 'medium', reason: 'explicit', note: 'diagnosis suggestion' }, { from: 'medium', to: 'medium', reason: 'diagnosis-redelegate', note: at('medium') }])
  const plain = [{ from: null, to: 'high' as const, reason: 'rule' as const }, { from: 'high' as const, to: 'xhigh' as const, reason: 'deep' as const }]
  expect(startAtLevel('claude/claude-opus-5-5', plain)).toEqual(plain)

  // Carbon medium takes over document-analysis from Sol 6.1 (document-alt) and Carbon high
  // machine-ops from Sonnet 5.5 (ops-alt), each at its level ...
  const available = (id: string) => isAvailable(id, cat)
  const same = (x: string, y: string) => sameModel(x, y, cat)
  const base = agentOf(decide(spawn(SCHEDULER), long(), j), 'a1')
  const docs = { ...base, ruleId: 'document-analysis', model: 'codex/gpt-6.1-sol', effort: 'high' as const, selection: { kind: 'rule' as const, reason: 'rule document-analysis' } }
  const noSol = (id: string) => available(id) && !same(id, 'codex/gpt-6.1-sol')
  expect(unavailableAction({ agent: docs, rules, available: noSol, same })).toEqual({ action: 'substitute', model: 'hakimi/gemini-4-carbon-medium', effort: 'medium', substituteId: 'document-alt' })
  const ops = { ...base, ruleId: 'machine-ops', model: 'claude/claude-sonnet-5-5', effort: 'max' as const, selection: { kind: 'rule' as const, reason: 'rule machine-ops' } }
  const noSonnet = (id: string) => available(id) && !same(id, 'claude/claude-sonnet-5-5')
  expect(unavailableAction({ agent: ops, rules, available: noSonnet, same })).toEqual({ action: 'substitute', model: 'hakimi/gemini-4-carbon-high', effort: 'high', substituteId: 'ops-alt' })
  // ... and stays there on a resume below its rule's start, and on a raise after a failed acceptance.
  const document = ruleById(rules, 'document-analysis')
  expect(nextEffort({ rule: document, current: 'medium', deep: true, raises: [], level: nameLevel('hakimi/gemini-4-carbon-medium') })).toEqual({ effort: 'medium', changes: [] })
  expect(nextEffort({ rule: ruleById(rules, 'machine-ops'), current: 'high', deep: false, raises: [], level: nameLevel('hakimi/gemini-4-carbon-high') })).toEqual({ effort: 'high', changes: [] })
  expect(nextEffort({ rule: document, current: 'medium', deep: null, raises: ['acceptance-failed'], level: 'medium' }))
    .toEqual({ effort: 'medium', changes: [{ from: 'medium', to: 'medium', reason: 'acceptance-failed', note: at('medium') }] })
  // Border work drawn onto Carbon high: a failed acceptance does not step it to xhigh.
  expect(nextEffort({ rule: null, current: 'high', deep: null, raises: ['acceptance-failed'], level: 'high' }))
    .toEqual({ effort: 'high', changes: [{ from: 'high', to: 'high', reason: 'acceptance-failed', note: at('high') }] })
  expect(() => nextEffort({ rule: null, current: 'xhigh', deep: null, raises: [], level: 'high' })).toThrow('recorded at xhigh')
})

test('review-second takes the levels an ID names and the provider serving a model for one model', () => {
  const j = judged(jevSpawnScheduler)
  for (const argon of ['hakimi/gemini-4-argon-high', 'antigravity/gemini-4-argon']) {
    const none = decide(spawn(`${SCHEDULER}\n[review-of model=codex/gpt-6.1-sol,opus,${argon}]`), long(), j)
    expect(none.action === 'deny' && none.reason.startsWith('No model is left for an independent second review')).toBe(true)
  }
  // Opus 5.5 served through the hakimi provider is still Opus: Sol 6.1 reviews it.
  expect(routed(decide(spawn(`${SCHEDULER}\n[review-of model=hakimi/claude-opus-5-5-high]`), long(), j)).agent.model).toBe('codex/gpt-6.1-sol')
})

function agentOf(d: SpawnDecision, agentId: string): AgentRecord {
  const r = routed(d)
  return { ...r.agent, agentId, startedAt: NOW }
}

test('unavailableAction: the person\'s model is theirs to replace; code-change\'s two models stand in for each other; no substitute asks', () => {
  const available = (id: string) => isAvailable(id, cat)
  const same = (x: string, y: string) => sameModel(x, y, cat)
  const j = judged(jevSpawnScheduler)

  const user = agentOf(decide(spawn(`${SCHEDULER}\n[model-reason user: 测试不可用模型]`, { model: 'codex/gpt-6-magpie-missing' }), long(), j), 'a1')
  const u = unavailableAction({ agent: user, rules, available, same })
  expect(u.action === 'ask-user' && u.reason).toBe('user-chosen')
  expect(u.action === 'ask-user' && u.candidates).toEqual(['claude/claude-opus-5-5', 'claude/claude-mythos-5-2', 'codex/gpt-6-astra', 'hakimi/gemini-4-carbon-medium', 'claude/claude-haiku-5-5', 'codex/gpt-6-luna'])

  // code-change on Opus 5.5: Mythos 5.2, the rule's other model, at the lowest level of the raise order
  // not below its start or the current effort; Astra (repo-alt) when Mythos is out too.
  const opus = agentOf(decide(spawn(SCHEDULER), long(), j), 'a2')
  expect(unavailableAction({ agent: opus, rules, available, same })).toEqual({ action: 'substitute', model: 'claude/claude-mythos-5-2', effort: 'high', substituteId: 'rule:code-change' })
  expect(unavailableAction({ agent: { ...opus, effort: 'max' }, rules, available, same })).toEqual({ action: 'substitute', model: 'claude/claude-mythos-5-2', effort: 'max', substituteId: 'rule:code-change' })
  const noMythos = (id: string) => available(id) && !same(id, 'claude/claude-mythos-5-2')
  expect(unavailableAction({ agent: opus, rules, available: noMythos, same })).toEqual({ action: 'substitute', model: 'codex/gpt-6-astra', effort: 'xhigh', substituteId: 'repo-alt' })
  // The largest work ran on Mythos 5.2: Opus 5.5 takes over.
  const mythos = agentOf(decide(spawn(SCHEDULER), long(), { ...j, deep: true, deepP: 0.97 }), 'a3')
  expect(mythos.model).toBe('claude/claude-mythos-5-2')
  expect(unavailableAction({ agent: mythos, rules, available, same })).toEqual({ action: 'substitute', model: 'claude/claude-opus-5-5', effort: 'high', substituteId: 'rule:code-change' })

  // An adjusted agent whose rule model is up gets the model the rule chose for its judgment back.
  const adjusted = agentOf(decide(spawn(`${SCHEDULER}\n[model-reason evidence: 诊断 a1 建议换 Sol]\n[effort high]`, { model: 'codex/gpt-6.1-sol' }), long(), j, {}, ROUTE_ORIGIN), 'a4')
  expect(unavailableAction({ agent: adjusted, rules, available, same })).toEqual({ action: 'substitute', model: 'claude/claude-opus-5-5', effort: 'high', substituteId: 'rule:code-change' })
  const adjustedHard = agentOf(decide(spawn(`${SCHEDULER}\n[model-reason evidence: 诊断 a1 建议换 Sol]\n[effort high]`, { model: 'codex/gpt-6.1-sol' }), long(), { ...j, deep: true, deepP: 0.97 }, {}, ROUTE_ORIGIN), 'a7')
  expect(unavailableAction({ agent: adjustedHard, rules, available, same })).toEqual({ action: 'substitute', model: 'claude/claude-mythos-5-2', effort: 'high', substituteId: 'rule:code-change' })

  const noRule = agentOf(decide(spawn(`${NO_RULE}\n[model-reason evidence: 只需直接回答]\n[effort low]`, { model: 'codex/gpt-6.1-terra' }), long(), judged(jevSpawnNoRule), {}, ROUTE_ORIGIN), 'a5')
  const n = unavailableAction({ agent: noRule, rules, available, same })
  expect(n.action === 'ask-user' && n.reason).toBe('no-substitute')

  // the math rule on Sol 6.1 with Astra out of Magpie's list: only Sol 6 (math-extra) is left, and it has
  // no effort an automatic takeover could use.
  const math = { ...opus, agentId: 'a6', ruleId: 'math', model: 'codex/gpt-6.1-sol', effort: 'max' as const, selection: { kind: 'rule' as const, reason: 'rule math' } }
  const noAstra = (id: string) => available(id) && !same(id, 'codex/gpt-6-astra')
  const m = unavailableAction({ agent: math, rules, available: noAstra, same })
  expect(m.action === 'ask-user' && m.reason).toBe('no-substitute')
  expect(m.action === 'ask-user' && m.candidates.includes('codex/gpt-6-sol')).toBe(true)
  expect(unavailableAction({ agent: math, rules, available, same })).toEqual({ action: 'substitute', model: 'codex/gpt-6-astra', effort: 'max', substituteId: 'science-math-alt' })
})

test('the acceptance brief teaches the lines parseVerdict reads, and names the patch when there is a change', () => {
  const task = dailyTaskDraft({ prompt: `${HEADER}\n${WORKER_BRIEFS.telegram}`, description: '实现调度逻辑', id: 'd-20261109-k3x9q2', now: 1762650000000 })
  const at = 1762650000000
  const executor = {
    agentId: 'a83b0057bf058d018', role: 'executor' as const, sessionId: 's', ruleId: 'code-change', rulesVersion: rules.version,
    selection: { kind: 'rule' as const, reason: 'rule code-change' }, judgment: null, model: 'claude/claude-opus-5-5', effort: 'xhigh' as const,
    efforts: [], contextSource: 'brief' as const, cwd: '/w', worktree: null, state: 'idle' as const, pendingRaises: [], filesTouched: [],
    reports: [{ at, status: 'done' as const, text: EXECUTOR_DONE, verification: parseStatus(EXECUTOR_DONE)!.verification }], startedAt: at,
  }
  const full = { ...task, owner: { kind: 'agent' as const, agentId: executor.agentId, workerName: 'tg-7051661301-878', routerSessionId: 's' } }
  const none = acceptanceBrief(full, executor, [])
  expect(parseVerdict(none)!.pass).toBe(false)
  expect(none.includes(EXECUTOR_DONE)).toBe(true)
  const inWorktree = { path: '/w/d-1', direct: false, patchPath: '/s/tasks/d-1.patch', diffStat: ' greet.py | 2 +-\n', files: ['greet.py'] }
  const changed = acceptanceBrief(full, executor, [inWorktree])
  expect(changed.includes('`/s/tasks/d-1.patch`')).toBe(true)
  expect(changed.includes('The change is in the task worktree `/w/d-1`, your working directory.')).toBe(true)
  // A task that changed several projects: every directory with its diff and patch, the first one the reviewer's own.
  const inPlace = { path: '/home/u/notes', direct: true, patchPath: '/s/tasks/d-1.p2.patch', diffStat: ' todo.md | 1 +\n', files: ['todo.md'] }
  const several = acceptanceBrief(full, executor, [inWorktree, inPlace])
  expect(several.includes('The executor changed 2 projects. The first directory below is your working directory.')).toBe(true)
  expect(several.includes('The task worktree `/w/d-1`. Its diff against the task\'s base:\n greet.py | 2 +-\nThe full patch is `/s/tasks/d-1.patch`.')).toBe(true)
  expect(several.includes('The project directory `/home/u/notes`, changed in place.')).toBe(true)
  expect(several.includes(' todo.md | 1 +\nThe full patch is `/s/tasks/d-1.p2.patch`.')).toBe(true)
  expect(parseVerdict(several)!.pass).toBe(false)
})
