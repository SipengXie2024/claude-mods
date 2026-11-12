# magpie-tasks 实现计划

日期：2026-11-09。依据：[实现方案](model-routing-implementation.md)（全部章节）、[系统行为约定](model-routing-design.md)、[模型路由表](model-routing-table.md)、`CONTEXT.md`、`findings.md` 中“magpie-tasks interface probes (2026-11-09)”“JEV readiness for subagent effort routing”和 2026-11-09 关于 Jev 上下文的决定，以及[接口实测报告](research/magpie-tasks-interface-probes-2026-11-09.md)。这些文档中的决定在本计划中直接采用。

本计划把实现拆成 8 个工作包，各自拥有互不重叠的文件。第 3 节的共享类型与第 3–9 节列出的接口签名是各工作包之间的约定；按约定编写的模块可以独立完成，再按第 13 节的顺序集成。

## 1. 范围

需要完成的内容：

1. 新插件 `mods/magpie-tasks`：只在 claude-magpie 会话中生效，负责长期任务窗口、子代理的模型与思考强度路由、任务登记与记录、工作副本与整合、日常任务的验收与诊断、Telegram 连接、启动恢复、评分邀请和校准提醒。
2. `mods/tg-router`：在 claude-magpie 中不再固定 `WORKER_MODEL`；读取 magpie-tasks 的 Telegram 索引，把追问送给任务当前的负责代理，把长期任务和评分消息交给 magpie-tasks；放行 magpie-tasks 为 Router 注册的工具；`dispatch` 增加用户指定模型的参数。
3. 启动脚本：`examples/claude-telegram/claude-telegram` 与 `/home/ubuntu/.local/bin/claude-telegram` 改为通过 `claude-magpie` 启动，设置 `MAGPIE_TASKS_ROLE=router`，以 Opus 5.5 运行 Router。
4. `.claude-plugin/marketplace.json` 增加 magpie-tasks；根目录 `README.md` 与 `examples/claude-telegram/README.md` 更新说明。

`mods/subagent-opus` 不需要修改。它在父模型为 Fable 或 Mythos、且委派没有指定模型（或指定了 Fable、Mythos）时把子代理模型改为 `opus`。magpie-tasks 管理的会话中，架构师只能是 Opus 5.5、Astra 或 Sol 6.1，Router 是 Opus 5.5，接管已有会话也只接受这三种模型（第 9.4 节），所以主对话的委派不满足这个条件；满足条件的是 Fable 5.1 子代理（`long-autonomous` 候选或用户指定）再委派的嵌套子代理。安装后 subagent-opus 位于外层，magpie-tasks 在内层收到的是改写后的 `model: 'opus'`，第 9.6 节第 6 步把这种情况当作没有指定模型，交给路由规则。同一字段以最内层的 magpie-tasks 为准（第 9.15 节）。端到端场景 E6 检查这两点。

`mods/jev` 不在本计划中修改。JEV 对 magpie-tasks 的配合由 JEV 的 Jev 上下文改造（`/tmp/jev-dev`，由该改造的负责人合入仓库）提供，magpie-tasks 依赖其中两项已经实现的行为（第 10.2 节）：委派说明第一行匹配 `^\[magpie-tasks task=` 的子代理，JEV 每次运行写一条 `skip` 记录、不改写强度；插件 `magpie-tasks` 提交、以 `[magpie-tasks spawn ` 开头的中转消息，JEV 直接放行，不写判断记录。改造的其余内容（只用 OpenAI 上的 Jev、按 Claude Code 上下文重建对话、删除截断和滚动摘要、子代理失败升级、重新校准门槛）属于 JEV 自己的实现计划。端到端场景以合入了该改造的 JEV 运行。

## 2. 生效条件与会话角色

插件在 `session.start` 中判定本会话的角色，之后各钩子按角色处理。判定顺序：

| 顺序 | 条件 | 角色 | 说明 |
| --- | --- | --- | --- |
| 1 | `await $.env.get('ANTHROPIC_BASE_URL') !== opts.gatewayUrl`（默认 `http://127.0.0.1:3425`） | `inactive` | 普通 `claude` 会话。插件不注册工具，所有钩子直接 `next(e)`；与角色无关的 `settings.read` 钩子在这里原样返回（见下文） |
| 2 | `e.isInteractive === false` | `inactive` | `claude-magpie -p` 等一次性调用 |
| 3 | `await $.env.get('MAGPIE_TASKS_ROLE') === 'router'` | `router` | `claude-telegram` 启动的 Telegram Router |
| 4 | 登记表中已有记录的 `owner.sessionId` 等于 `await $.session.id()` | `architect` | 用 `claude --bg --resume <完整会话 ID>` 恢复的架构师会话，会话 ID 不变 |
| 5 | `await $.env.get('CLAUDE_JOB_DIR') !== undefined` 且 `CLAUDE_BG_SOURCE === 'slash'` | `architect` 或 `unmanaged` | `/bg` 生成的副本：按接管认领（第 9.4 节）成功则为架构师；失败时报告错误（第 9.4 节第 6 步）后为普通会话；没有接管标记（用户自己的 `/bg`）时为普通会话 |
| 6 | `CLAUDE_JOB_DIR` 已设置（其他后台会话） | `bg-unclaimed` | 第一次 `prompt.submit` 时按启动认领（第 9.3 节）决定架构师、报告认领失败或普通会话 |
| 7 | 其余交互式会话 | `candidate` | 第一条消息进入长期任务流程（第 9.2 节）或接管流程（第 9.4 节） |

`unmanaged` 与 `inactive` 一样不做任何处理。`unmanaged` 只有三个来源：用户自己用 `claude-magpie --bg` 或 `/bg` 启动、没有认领记录的后台会话；用户拒绝接管的已有会话（第 9.4 节）；模型不在架构师候选中的已有会话。每个交互式 `claude-magpie` 新窗口都进入长期任务流程（findings“model routing implementation interview”的 Window scope 决定）；不需要登记的临时操作使用普通 `claude`。

**后台会话不进入原生工作副本。** `claude --bg` 启动的后台会话在 Git 仓库中第一次编辑文件之前，会被 Claude Code 移入 `.claude/worktrees/` 下的原生工作副本，移入之前不能对共享目录使用 Edit、Write 和 NotebookEdit（官方 agent-view 文档 “How file edits are isolated” 一节，`/tmp/magpie-background-agent-view-w4z2940o/source.md:589-611`）。架构师由 `claude-magpie --bg` 或 `claude --bg --resume` 启动，如果被移入原生工作副本，就不能在项目主目录写 `.planning/findings.md`、`CONTEXT.md` 与 `.planning/plan-*.md`；移入后会话的工作目录也随之改变，context-memory 按工作目录划分的项目范围和第 9.5 节按 `projectRoot` 判断的写入范围都会失效，而被 Git 忽略的 `.planning/` 不在原生工作副本中。文档给出的关闭方法是设置 `worktree.bgIsolation: "none"`。magpie-tasks 注册 `settings.read` 钩子提供这个设置：读取合并后的设置（`e.source` 为空）时，若 `flag` 层的 `env.ANTHROPIC_BASE_URL` 等于 `opts.gatewayUrl`（claude-magpie 的 `--settings` 写入的网关地址），在 `next(e)` 的结果上设置 `worktree.bgIsolation = 'none'`，否则原样返回；读取单个来源时原样返回。类型说明规定引擎自己合并设置时也经过这些钩子，钩子的回答对所有读取者生效，且回答只能由 `layers` 与 `next(e)` 的结果决定，所以判断只依据 `flag` 层，不读会话角色或环境变量。后果：所有 claude-magpie 后台会话（包括用户自己启动的 `claude-magpie --bg`）都直接编辑启动目录，与在项目设置中写入 `worktree.bgIsolation: "none"` 的效果相同，不再自行建立原生工作副本；普通 `claude` 的后台会话没有 Magpie 的 `flag` 层，不受影响。接管流程用 `/bg` 转入后台，文档说明这种会话本来就不移入原生工作副本。这一机制是未验证行为 U9（第 11 节），由场景 E5 判定。

## 3. 目录、模块与共享约定

### 3.1 目录

```
mods/magpie-tasks/
  .claude-plugin/plugin.json        manifest，含 userConfig
  .claude-plugin/types/             Claude Code 2.1.319 类型（按 plugin-authoring 技能放置）
  tsconfig.json                     extends ./.claude-plugin/types/tsconfig.json
  hooks/hooks.json                  { "modules": ["./register.ts"] }
  hooks/register.ts                 事件接线
  rules/routing-rules.json          路由规则文件
  src/types.ts  src/io.ts  src/lock.ts  src/registry.ts
  src/rules.ts  src/model.ts  src/jevconfig.ts
  src/jev.ts  src/dialogue.ts  src/judge.ts
  src/git.ts  src/integrate.ts  src/conflict.ts
  src/session.ts  src/trust.ts  src/launch.ts  src/gate.ts  src/architect.ts  src/recovery.ts
  src/brief.ts  src/spawn.ts  src/band.ts  src/route.ts  src/daily.ts  src/unavailable.ts
  src/telegram.ts  src/router.ts  src/calibration.ts
  src/tools.ts  src/state.ts
  tests/*.test.ts                   claude plugin test 运行的纯函数测试
  io-tests/*.spec.ts                bun test 运行的真实文件系统、Git 与 Jev 测试
  io-tests/node-io.ts               Io 接口的 Node 实现，供 io-tests 与 eval 使用
  eval/rules-eval.ts                Jev 规则判定的标注与评分脚本
  e2e/*.sh                          端到端场景脚本
  README.md                         插件说明（中文）
```

### 3.2 模块总表

| 文件 | 职责 | 处理的事件或调用方 | 工作包 |
| --- | --- | --- | --- |
| `src/types.ts` | 全部共享数据类型：记录、角色、强度、会话状态（不导入其他模块） | 所有模块 | C |
| `src/io.ts` | `Io` 接口及其 `$` 实现 `hostIo`，路径展开，FNV-1a 散列 | 所有做输入输出的模块 | C |
| `src/lock.ts` | 跨会话的目录锁 | registry、integrate、recovery、calibration | C |
| `src/registry.ts` | 任务记录、任务日志、认领记录、Telegram 索引、会话索引、状态文件 | 所有流程模块 | C |
| `rules/routing-rules.json`、`src/rules.ts` | 规则文件与校验，强度计算，`review-second` 排除，替代候选，架构师候选 | judge、spawn、daily、session | A |
| `src/model.ts` | 模型标识规范化、别名解析、1M 上下文变体、强度能力、显示名称 | spawn、session、rules | A |
| `src/jevconfig.ts` | 读取 JEV 的 `.env`，取深入推理阈值 `JEV_OPUS_DEEP_YES` | rules | A |
| `src/jev.ts` | OpenAI Decisions 客户端：读密钥文件、消息列表输入、解析、时限 | judge | B |
| `src/dialogue.ts` | 从 `$.session.messages({ agentId, as: 'api' })` 整理子代理对话 | spawn（续接时的深入推理判断） | B |
| `src/judge.ts` | 规则与深入推理判断、架构师推荐、反馈判断；Jev 失败时由评估模型替代 | spawn、session、router、daily | B |
| `src/git.ts` | `git init` 与基线、快照树、工作副本创建与删除、差异 | session、daily、architect、integrate | D |
| `src/integrate.ts` | 把工作副本的改动应用到目标目录，按项目排队，报告冲突 | architect、daily | D |
| `src/conflict.ts` | 子代理改动文件的记录与冲突判定（纯函数） | architect | D |
| `src/session.ts` | 角色判定、后台会话的原生工作副本设置、第一条消息流程、启动认领、接管认领、架构师每轮上下文 | `session.start`、`settings.read`、`classic.SessionStart`、`prompt.submit` | E |
| `src/trust.ts` | 读取与写入 Claude Code 全局配置中项目根的信任标记 | session | E |
| `src/launch.ts` | 启动与恢复后台会话、解析输出、读取 `claude agents --json` | session、router、recovery | E |
| `src/gate.ts` | 架构师工具限制、子代理写入范围 | `tool.call` | E |
| `src/architect.ts` | 架构师会话的回合结束处理（Telegram 回复、调试日志检查）、架构师工具、文件冲突流程、长期任务决定的执行 | `prompt.submit`、`turn.complete`、`tool.call` | E |
| `src/recovery.ts` | 启动恢复、context-memory 更新后的重新恢复 | `session.start` | E |
| `src/brief.ts` | 任务标记、各类说明的生成与解析、状态行与结论行解析 | spawn、daily、architect | F |
| `src/spawn.ts` | `agent.spawn` 路由、`turn.start` 续接判定、`turn.step` 强度、续接时的重新判断 | `agent.spawn`、`turn.start`、`turn.step` | F |
| `src/band.ts` | 路由过的子代理的强度条：模型、请求实际带的强度、规则 | `turn.step`、`turn.complete`、`ui.render`、`session.end` | F |
| `src/route.ts` | 架构师的委派工具 `model_route`：Jev 与路由表选择模型和强度，Jev 权衡架构师的推荐，经中转启动子代理 | architect（工具调用） | F |
| `src/daily.ts` | 中转（启动与唤醒子代理）、日常任务的评估确认、验收、诊断、阻碍判定、整合触发、日常任务决定的执行、`open_project` 工具 | `prompt.submit`（中转）、`turn.complete`、`tool.call` | F |
| `src/unavailable.ts` | 路由过的子代理因模型不可用或额度耗尽结束时的替代与报告 | `classic.StopFailure`、`turn.complete` | F |
| `src/telegram.ts` | Bot API 发送、令牌读取、默认聊天、频道标签解析 | architect、router、daily、calibration | G |
| `src/router.ts` | Router 角色：magpie-tasks 消息的回复处理、长期任务转交、日常转长期、架构师推荐、追问观察 | `prompt.submit`、`session.send`、`tool.call` | G |
| `src/calibration.ts` | 评分邀请、评分解析、两周校准检查 | Router 定时器、router | G |
| `src/tools.ts` | 工具定义与按角色注册 | `session.start` | H |
| `src/state.ts` | 上下文对象 `Ctx`、本进程的会话状态 | 所有流程模块、register | H |
| `hooks/register.ts` | 事件接线、错误处理 | 全部事件 | H |

### 3.3 共享类型（`src/types.ts`，工作包 C 按此原样实现）

```ts
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type Role = 'inactive' | 'candidate' | 'bg-unclaimed' | 'architect' | 'router' | 'unmanaged'
export type TaskKind = 'long' | 'daily'
export type TaskState = 'starting' | 'running' | 'paused' | 'waiting-user' | 'error' | 'done' | 'abandoned'
// 'error': a plugin flow for this task stopped on an error that was reported (section 8); the next message
// the person sends to the task (window or Telegram) sets it back to 'running'; recovery never resumes it.
export type AgentRole = 'executor' | 'implementer' | 'assessment' | 'acceptance' | 'diagnosis' | 'helper'
export type SelectionKind = 'rule' | 'user' | 'adjusted' | 'assessment-confirmed' | 'diagnosis' | 'review-second' | 'unavailable-substitute'
export type RaiseReason = 'deep' | 'resume-deep' | 'acceptance-failed' | 'diagnosis-redelegate'

export interface Options {
  gatewayUrl: string          // http://127.0.0.1:3425
  stateDir: string            // ~/.config/magpie-tasks（已展开为绝对路径）
  worktreeDir: string         // ~/.local/share/magpie-tasks/worktrees
  jevUrl: string              // https://api.openai.com/v1/decisions
  jevModel: string            // gpt-6-luna
  jevKeyFile: string          // ~/.config/jev-opus/openai-jev.key
  jevDeadlineMs: number       // 10000
  evaluatorModel: string      // claude/claude-opus-5-5：Jev 不可用时代为判断的固定评估模型
  launcher: string            // claude-magpie
  claudeBin: string           // claude
  telegramStateDir: string    // ~/.claude/channels/telegram-live
  telegramChatId: string      // 空：从 access.json 的唯一 allowFrom 读取
  timezone: string            // Asia/Shanghai
  ratingHour: number          // 21
}

export interface JevJudgment {
  provider: 'jev' | 'substitute'
  substituteReason?: string             // Jev 失败的原因（provider 为 substitute 时）
  ruleChoice: string                    // 规则 ID 或 'none'
  confidence: number                    // 0..1，见第 6.2 节
  probabilities: Record<string, number>
  deepP: number | null
  deep: boolean
  latencyMs: number
  inputTokens: number
  cachedTokens?: number
  questionSet: string                   // 'rules-q.v3'
}

export interface EffortChange { at: number; from: Effort | null; to: Effort; reason: 'rule' | 'explicit' | RaiseReason; note?: string }

export interface AgentReport { at: number; status: 'done' | 'needs-user' | 'blocked' | 'missing'; text: string; verification: string[] }

export interface AgentRecord {
  agentId: string
  name?: string
  role: AgentRole
  parentAgentId?: string
  sessionId: string                     // 子代理所在会话
  ruleId: string | null
  rulesVersion: string
  selection: { kind: SelectionKind; reason: string; userConfirmation?: string }
  judgment: JevJudgment | null
  model: string                         // 发给引擎的 Magpie 模型 ID
  effort: Effort                        // 当前强度
  efforts: EffortChange[]
  reviewOf?: string[]                   // 被复核模型的规范化 ID
  contextSource: 'brief'                // 普通子代理只接收说明
  cwd: string
  worktree: string | null               // 允许写入的工作副本
  state: 'running' | 'idle' | 'paused' | 'done' | 'failed'
  pausedFor?: string                    // 等待中的决定 ID
  failure?: { at: number; kind: 'model-unavailable' | 'api-error'; error: string }   // 第 9.16 节；error 为 StopFailure 的分类
  replacedBy?: string                   // 接手它的代理 ID
  pendingRaises: RaiseReason[]          // 下一轮开始时应用的提高原因；与 st.pendingRaises 同步，会话恢复后从这里载入
  filesTouched: string[]
  reports: AgentReport[]
  startedAt: number
}

export interface Decision {
  id: string
  kind: 'file-conflict' | 'integration-conflict' | 'route-confirm' | 'fix-confirm' | 'model-change-confirm' | 'no-progress' | 'model-unavailable' | 'interrupted'
  // fix-confirm: a daily result fixed after failed acceptance waits for the person (integrated on approval when it changed files)
  // model-change-confirm: a diagnosis suggests a model outside the automatic substitutes
  // model-unavailable: a routed agent's model is unavailable and no automatic substitute exists, or the person chose the model
  createdAt: number
  question: string
  options: string[]
  telegram?: { chatId: string; messageId: number }
  resolvedAt?: number
  answer?: string
  data: Record<string, string>
}

// id: 'b1', 'b2', ... per task, assigned by the plugin when a blocker is first reported and never reused;
// later reports name it (architect: blocker_id; daily: the blocker judgment of section 9.11)
export interface Blocker { id: string; description: string; diagnoses: number; modelChanges: number; history: { at: number; step: 'diagnosis' | 'model-change'; agentId: string; note: string; match?: { provider: 'architect' | 'jev' | 'substitute'; confidence: number | null } }[] }

export interface TaskRecord {
  schema: 1
  id: string                            // l-YYYYMMDD-xxxxxx 或 d-YYYYMMDD-xxxxxx
  kind: TaskKind
  title: string
  state: TaskState
  pausedByUser: boolean
  createdAt: number
  updatedAt: number
  request: string                       // 第一条消息或日常任务的原始请求
  followUps: { at: number; source: 'telegram' | 'window'; text: string }[]
  project: { root: string } | null
  direct?: { dir: string; baseRef: string | null; baseCommit: string | null } | null   // 直接修改项目目录（第 9.9 节）
  alsoChanged?: { taskId: string; title: string; files: string[]; at: number }[]       // 其他任务在同一目录改过的文件
  worktree: { path: string; baseRef: string; baseCommit: string } | null
  extraWorktrees: Record<string, { path: string; baseRef: string; forAgent: string }>
  owner:
    | { kind: 'session'; sessionId: string; jobShortId?: string; previousSessionIds: string[]; model: string; contextMemoryFingerprint: string }
    | { kind: 'agent'; agentId: string; workerName: string; routerSessionId: string }
  architect?: { model: string; recommendation: { model: string; reason: string; limits: string; judgment: JevJudgment | null }; userChoice: string; confirmedAt: number; source: 'new' | 'takeover' | 'promoted' }
  requestedModel?: { model: string; reason: string }  // a daily task: the model the person named when no rule gives its effort; every routing assessment of the task is briefed with it
  telegram: { chatId: string; rootMessageId?: number; workerName?: string } | null
  agents: Record<string, AgentRecord>
  blockers: Record<string, Blocker>
  decisions: Record<string, Decision>
  deliverables: { at: number; summary: string; verification: string[]; acceptance?: { agentId: string; pass: boolean; notes: string }; integration?: { status: 'applied' | 'empty' | 'conflict'; files: string[]; at: number } }[]
  feedback: { at: number; source: 'telegram' | 'window'; text: string; unsuitable: boolean | null; modelOpinion: boolean | null }[]
  ratings: { at: number; score: number; raw: string; invited: boolean }[]
  pendingRelays: Record<string, RelayRequest>
  completedAt?: number
  error?: string
}

// A spawn or a wake the plugin carries out from prompt.submit (section 9.8); both use the text `[magpie-tasks spawn <id>]`.
export type RelayRequest = { id: string; taskId: string; createdAt: number } & (
  | { kind: 'spawn'; role: AgentRole; args: { prompt: string; description: string; name?: string; model: string; cwd?: string }; agent: Omit<AgentRecord, 'agentId' | 'startedAt'> }
  | { kind: 'wake'; agentId: string; message: string; raises: RaiseReason[] }
)

export interface Claim {
  id: string
  kind: 'launch' | 'takeover'
  taskId: string
  cwd: string
  createdAt: number
  expiresAt: number                     // 启动认领 10 分钟，接管认领 2 分钟
  promptHash?: string                   // launch：传给 --bg 的完整消息的 FNV-1a
  fromSessionId?: string                // takeover
}

export interface TelegramIndex {
  schema: 1
  messages: Record<string, { taskId: string; kind: 'long' | 'magpie' | 'rating' | 'decision'; decisionId?: string }>  // 键为 `${chatId}:${messageId}`；长期任务的决定问题为 kind 'long' 加 decisionId
  workers: Record<string, { taskId: string; ownerAgentId: string; long: boolean }>                                      // 键为 tg-router 的 worker 名
  agents: Record<string, string>                                                                                        // agentId → worker 名
}

export interface SessionState {
  role: Role
  sessionId: string
  cwd: string
  taskId: string | null
  startSource: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | null
  firstPromptSeen: boolean
  pendingBg: boolean                               // 接管确认后，本轮结束时发出 /bg
  recovery: Promise<void> | null                   // 本会话启动的启动恢复；结束前台会话前等待它
  agents: Map<string, string>                     // agentId → taskId（本会话中路由过的子代理）
  freshSpawn: Set<string>                          // 本进程刚启动、还没有开始第一轮的子代理
  pendingRaises: Map<string, RaiseReason[]>        // agentId → 下一轮开始时的提高原因
  pendingReask: Map<string, string>                // agentId → 续接消息（turn.start 记录）
  stopFailures: Map<string, string>                // agentId → classic.StopFailure 的错误分类
  replyTargets: { chatId: string; messageId: number }[]
  relay: Map<string, RelayRequest>
  touches: Map<string, Set<string>>                // agentId → 改过的绝对路径
  debugOffset: number
}
```

`Ctx` 引用 A 的 `Rules`、`ModelCatalog` 与 C 的 `Registry`，放在 H 的 `src/state.ts` 中（第 3.5 节），`types.ts` 因此不导入任何模块。

### 3.4 宿主输入输出（`src/io.ts`）

```ts
export interface Io {
  run(argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>
  read(path: string): Promise<string>                  // 文件不存在时拒绝
  write(path: string, text: string): Promise<void>     // 自动建立目录
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<{ kind: string; size: number; mtimeMs: number }>
  realPath(path: string): Promise<string | null>       // $.fs.stat(path, { resolve: true }).realPath
  list(path: string): Promise<{ name: string; kind: string }[]>
  now(): Promise<number>
  sleep(ms: number): Promise<void>                     // $.clock.sleep：计入钩子的 10 秒时限，只用于与另一个 $ 调用竞争的时限
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; ok: boolean; text: string }>
  env(name: string): Promise<string | undefined>
  log(line: string): Promise<void>                     // $.ui.log(..., { to: 'debug' })，前缀 'magpie-tasks: '
}
export function hostIo($: EngineInterface): Io
export function wait(io: Io, ms: number): Promise<void>  // io.run(['sleep', 秒数])：等待期间钩子时限停止计时
export function expandHome(path: string, home: string): string
export function fnv1a64(text: string): string           // 16 位十六进制
export function newId(prefix: 'l' | 'd' | 'c' | 'r' | 'q', now: number): string   // 前缀-YYYYMMDD-6 位 base36
```

`hostIo` 只用插件接口：`$.process.run`、`$.fs.*`、`$.clock.now/sleep`、`$.http.fetch`、`$.env.get`、`$.ui.log`。钩子环境中没有 `process`（实测），所以 Node 实现 `io-tests/node-io.ts` 只供 `bun test` 与 `eval/` 使用，两者对同一组真实目录和进程操作。

钩子的时限在 `$` 调用进行中停止计时，`$.clock` 的等待除外（类型定义 `HookBudget`）。所以在钩子中反复等待的循环（锁的重试、等待认领完成）一律用 `wait(io, ms)`，它通过 `$.process.run` 运行 `sleep`；`io.sleep` 只出现在 `Promise.race(fetch, io.sleep(deadlineMs))` 这类与另一个进行中的 `$` 调用竞争的地方，此时计时已经因为那个调用停止。

### 3.5 流程模块的导出接口

流程模块的处理函数统一以 `ctx: Ctx` 为第一个参数，由 `hooks/register.ts` 按角色调用。`$` 本身不放进任何对象：`claude plugin validate` 按调用处读取每个 `$.noun.method`，`$` 被放进对象时拒绝整个模块，所以 `Ctx` 带的是 `hostEngine($)` 建立的 `host`，其中每个方法是对一次 `$` 调用的闭包，流程模块写 `ctx.host.session.send(…)`；`hooks/register.ts` 中建立 `Ctx` 的函数是文件顶层的函数声明。`PromptResult` 指 `prompt.submit` 钩子的返回值（`next(e)` 的结果或 `{ drop }`），`'pass'` 表示交给下一个处理者；`Next<'…'>` 是该事件的钩子收到的 `next`，类型参数写明事件名（不带参数的 `Next` 涵盖全部事件，不能接收单个事件钩子的 `next`）；事件输入与结果类型（`SessionStartInput`、`PromptSubmitInput`、`AgentSpawnInput`、`AgentSpawnResult`、`TurnStartInput`、`TurnStepInput`、`TurnCompleteInput`、`ToolCallInput`、`ToolCallResult`、`SessionSendInput`、`SessionSendResult`、`SettingsReadInput`、`Settings`）从 `claude-code` 类型导入，`StopFailureInput` 指 `classic.StopFailure` 的输入。`state.ts` 导出 `type PromptResult = Awaited<ReturnType<Next<'prompt.submit'>>> | { drop: string }`。

```ts
// src/session.ts（E）
export function detectRole(ctx: Ctx, e: SessionStartInput): Promise<Role>
export function bgIsolationAnswer(e: SettingsReadInput, merged: Settings, gatewayUrl: string): Settings   // 第 2 节；纯函数
export function noteStartSource(ctx: Ctx, source: SessionState['startSource']): void
export function onFirstPrompt(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult>      // 第 9.2、9.4 节
export function claimLaunch(ctx: Ctx, text: string): Promise<TaskRecord | 'mismatch' | null>        // 第 9.3 节
export function claimTakeover(ctx: Ctx): Promise<TaskRecord | 'failed' | null>                        // 第 9.4 节第 6 步；null 为没有接管标记
export function onTakeoverTurnEnd(ctx: Ctx): Promise<void>                                            // 第 9.4 节第 5 步
export function architectContext(task: TaskRecord, opts: Options): string                            // 每轮上下文（英文）
export function askText(a: { recommendation: { model: string; reason: string; limits: string }; root: string; worktree: string; git: { files: number; bytes: number } | null }, rules: Rules): { question: string; options: string[] }

// src/launch.ts（E）
export function launchArgv(opts: Options, a: { model: string; message: string; pluginDir: string | null }): string[]
export function parseBackgrounded(stdout: string): string | null
export function pluginDirArg(pluginRoot: string, installed: unknown): string | null   // installed：<配置目录>/plugins/installed_plugins.json 的内容；其中有 magpie-tasks@… 时为 null
export function launchArchitect(ctx: Ctx, a: { task: TaskRecord; model: string; message: string; cwd: string }): Promise<{ shortId: string; sessionId: string }>   // 写启动认领、启动，并等到认领完成；失败时停止后台会话、任务改为 error 后抛出
export function resumeSession(ctx: Ctx, sessionId: string, message: string, cwd: string): Promise<void>                                       // 不带参数的 claude --bg --resume
export function stopSession(ctx: Ctx, shortId: string): Promise<void>
export interface AgentsRow { id: string; sessionId: string; kind: 'background' | 'interactive'; cwd: string; name: string; startedAt: number; state?: string; status?: 'idle' | 'busy'; pid?: number | null }
export function listAgents(io: Io, opts: Options): Promise<AgentsRow[]>                                                                       // claude agents --json --all

// src/gate.ts（E）
export function architectDeny(e: { tool: string; [k: string]: unknown }, a: { projectRoot: string; home: string; place: (path: string) => Promise<string | null> }): Promise<string | null>
export function subagentWriteDeny(e: { tool: string; [k: string]: unknown }, a: { worktree: string | null; place: (path: string) => Promise<string | null>; repoOf: (path: string) => Promise<string | null> }): Promise<string | null>
export function isReadOnlyBash(command: string): boolean
export function isPlanCommand(command: string, projectRoot: string, home: string): boolean
export function isRecordPath(realPath: string, projectRoot: string): boolean

// src/architect.ts（E）
export function onArchitectPrompt(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult>     // Telegram 标记、决定标记、反馈记录、每轮上下文
export function onArchitectComplete(ctx: Ctx, e: TurnCompleteInput): Promise<void>                       // 主对话：Telegram 回复、调试日志检查
export function onSubagentToolCall(ctx: Ctx, e: ToolCallInput, next: Next<'tool.call'>): Promise<ToolCallResult>      // 写入范围、文件记录、冲突
export function onSubagentComplete(ctx: Ctx, e: TurnCompleteInput): Promise<void>                        // 报告记录、等待解除、单独副本合入
export function architectTool(ctx: Ctx, name: ArchitectToolName, args: Record<string, unknown>): Promise<string>   // 第 9.5 节的工具；参数不合法时抛出，作为拒绝理由返回
export function applyLongDecision(ctx: Ctx, task: TaskRecord, decision: Decision, answer: string): Promise<string>   // 在架构师会话中执行长期任务的决定（resolve_conflict 与 Telegram 回复共用）；返回给架构师读的结果

// src/recovery.ts（E）
export function recover(ctx: Ctx): Promise<{ resumed: string[]; waiting: string[]; reported: string[] }>
export function contextMemoryFingerprint(io: Io, configDir: string): Promise<string>                 // 第 9.13 节第 4 步
export function scanDebugLog(ctx: Ctx): Promise<string | null>

// src/brief.ts（F）
export interface MarkerInfo { taskId: string; role: AgentRole; ruleId: string | null; rulesVersion: string; model: string; effort: Effort }
export function marker(m: MarkerInfo): string
export function parseMarker(prompt: string): MarkerInfo | null
export function parseModelReason(prompt: string): { kind: 'user' | 'evidence'; text: string } | null
export function parseModelLine(prompt: string): string | null        // `[model <Magpie 模型 ID>]`
export function parseEffortLine(prompt: string): Effort | null
export function parseReviewOf(prompt: string): { agents: string[]; models: string[] } | null
export function parseRequestHeader(prompt: string): { chatId: string; messageId: number; worker: string } | null
export function requestText(prompt: string): string
export function withRouting(prompt: string, m: MarkerInfo, a: { cwd: string | null; daily: boolean }): string
export function assessmentBrief(task: TaskRecord, rules: Rules): string
export function acceptanceBrief(task: TaskRecord, executor: AgentRecord, change: { patchPath: string; diffStat: string } | null): string   // null：没有改动的任务
export function diagnosisBrief(task: TaskRecord, executor: AgentRecord, blocker: Blocker, diffStat: string | null): string
export function handoffBrief(task: TaskRecord, a: { reason: string; previous: AgentRecord }): string
export function parseStatus(answer: string): { status: 'done' | 'needs-user' | 'blocked'; blocker?: string; verification: string[] } | null
export function parseVerdict(answer: string): { pass: boolean; notes: string } | null
export function parseRouteConfirm(answer: string): { model: string; effort: Effort } | 'cancel' | null
export function parseDiagnosis(answer: string): { action: 'continue' } | { action: 'replace'; model: string; effort: Effort } | { action: 'user' } | null

// src/spawn.ts（F）
export type SpawnDecision =
  | { action: 'pass' }
  | { action: 'deny'; reason: string }
  | { action: 'route' | 'assess'; rewrite: { prompt: string; model: string; cwd?: string; description: string }; agent: Omit<AgentRecord, 'agentId' | 'startedAt'>; notice: string; requestedModel?: { model: string; reason: string } }
export function decideSpawn(a: { e: AgentSpawnInput; origin: string; task: TaskRecord | null; judgment: JevJudgment | null; rules: Rules; catalog: ModelCatalog; lookupAgentModel: (agentId: string) => string | undefined }): SpawnDecision
export function onAgentSpawn(ctx: Ctx, e: AgentSpawnInput, next: Next<'agent.spawn'>): Promise<AgentSpawnResult>
export function onTurnStart(ctx: Ctx, e: TurnStartInput): Promise<void>                    // 第 9.7 节：续接判定
export function onTurnStep(ctx: Ctx, e: TurnStepInput): Promise<Effort | undefined>        // register.ts 的生成器钩子据此改写 effort
export function nextEffort(a: { rule: Rule | null; current: Effort; deep: boolean | null; raises: RaiseReason[]; explicit?: Effort }): { effort: Effort; changes: Omit<EffortChange, 'at'>[] }

// src/daily.ts（F）
export function relay(ctx: Ctx, req: RelayRequest): Promise<string>                        // 第 9.8 节：启动与唤醒子代理的唯一入口，在调用处直接执行；返回显示在会话中的一行
export function onDailyComplete(ctx: Ctx, e: TurnCompleteInput): Promise<void>               // 执行者、评估、验收、诊断子代理的回合结束
export function onOpenProject(ctx: Ctx, agentId: string, args: { project?: unknown }): Promise<string>
export function applyDailyDecision(ctx: Ctx, task: TaskRecord, decision: Decision, text: string): Promise<string>   // Router 会话中执行日常任务的决定；返回发给用户的确认文字
export function matchBlocker(ctx: Ctx, task: TaskRecord, report: string): Promise<{ blockerId: string | null; provider: 'jev' | 'substitute'; confidence: number }>   // null：新的阻碍

// src/unavailable.ts（F）
export type UnavailableAction =
  | { action: 'substitute'; model: string; effort: Effort; substituteId: string }
  | { action: 'ask-user'; reason: 'user-chosen' | 'no-substitute'; candidates: string[] }
export function isUnavailableError(kind: string | undefined): boolean    // rate_limit、overloaded、server_error、billing_error、model_not_found、authentication_failed
export function unavailableAction(a: { agent: AgentRecord; rules: Rules; available: (id: string) => boolean; same: (x: string, y: string) => boolean }): UnavailableAction   // 纯函数
export function onStopFailure(ctx: Ctx, e: StopFailureInput): Promise<void>               // 记录 st.stopFailures
export function onAgentError(ctx: Ctx, e: TurnCompleteInput): Promise<void>               // 路由过的子代理 reason === 'error' 时，第 9.16 节

// src/router.ts（G）
export function onRouterPrompt(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult>
export function routerContext(longTasks: TaskRecord[], now: number): string
export function deliverToArchitect(ctx: Ctx, task: TaskRecord, text: string, tg: { chatId: string; messageId: number } | null, decision?: { id: string; answer: 'separate' | 'wait' | 'approve' | 'reject' | 'unclear' }): Promise<'sent' | 'resumed' | 'failed'>   // decision 写入转交标记
export function routerTool(ctx: Ctx, name: RouterToolName, args: Record<string, unknown>): Promise<string>
export function onSessionSend(ctx: Ctx, e: SessionSendInput, next: Next<'session.send'>): Promise<SessionSendResult>

// src/tools.ts（H）
export type ArchitectToolName = 'task_status' | 'report_outcome' | 'integrate' | 'notify_user' | 'resolve_conflict'
export type RouterToolName = 'forward_long' | 'recommend_architect' | 'promote_task'
export type SubagentToolName = 'open_project'
export const TOOL_SPECS: Record<ArchitectToolName | RouterToolName | SubagentToolName, { description: string; inputSchema: Record<string, unknown> }>   // ToolSpec.inputSchema 的类型
export function registerTools(ctx: Ctx, role: Role): Promise<void>          // architect：架构师工具与 open_project；router：Router 工具与 open_project
export function toolOwner(fullName: string): { name: string; kind: 'architect' | 'router' | 'subagent' } | null   // mcp__magpie-tasks__<name>

// src/state.ts（H）
export interface Host { session: { id; model; messages; append; send }; ui: { log; ask; toast }; model: { complete }; agent: { spawn }; prompt: { submit }; command: { run }; clock: { after }; tool: { register }; plugin: { root: string } }   // 各方法的类型取自 EngineInterface 的同名成员
export function hostEngine($: EngineInterface): Host
export interface Ctx { host: Host; io: Io; opts: Options; rules: Rules; catalog: ModelCatalog; reg: Registry; st: SessionState }
export type PromptResult = Awaited<ReturnType<Next<'prompt.submit'>>> | { drop: string }
export function freshState(): SessionState
export function ctxFor($: EngineInterface, st: SessionState, base: Omit<Ctx, 'host' | 'io' | 'st'>): Ctx
```

所有用户可见文字（确认对话、Telegram 消息、提示）用中文；给模型读的说明、上下文和拒绝理由与 tg-router 一致使用英文，其中引用用户原话时保留原文。

## 4. 路由规则文件（工作包 A）

### 4.1 文件格式

`rules/routing-rules.json` 在插件目录中，随插件版本走。运行时由 `loadRules(io, $.plugin.root)` 读取并校验，校验失败时插件在 `session.start` 抛出错误（会话中显示钩子失败，插件不生效）。每次选模把 `version` 写入记录。校准后修改规则需要用户确认，确认后提高版本号。

```json
{
  "version": "routing-rules.v5",
  "date": "2026-11-10",
  "source": ".planning/model-routing-table.md",
  "thresholds": { "ruleConfidence": 0.5, "hardYes": 0.95, "architectConfidence": 0.4 },
  "models": {
    "claude/claude-opus-5-5":   { "name": "Opus 5.5" },
    "claude/claude-sonnet-5-5": { "name": "Sonnet 5.5" },
    "claude/claude-mythos-5-2": { "name": "Mythos 5.2" },
    "claude/claude-haiku-5-5":  { "name": "Haiku 5.5" },
    "codex/gpt-6-astra":        { "name": "Astra" },
    "codex/gpt-6.1-sol":        { "name": "Sol 6.1" },
    "codex/gpt-6.1-terra":      { "name": "Terra 6.1" },
    "codex/gpt-6-luna":         { "name": "Luna 6" },
    "codex/gpt-6-sol":          { "name": "Sol 6" },
    "antigravity/gemini-4-argon": { "name": "Argon" }
  },
  "rules": [
    {
      "id": "code-change",
      "section": "2.2",
      "condition": "交付的是程序本身：新功能、修复、重构或测试，验收看程序的行为；设计已经明确",
      "role": "实施子代理",
      "model": "claude/claude-opus-5-5",
      "hardModel": "claude/claude-mythos-5-2",
      "effort": "high",
      "deepEffort": "high",
      "raiseOrder": ["high", "xhigh", "max"],
      "acceptance": "相关测试通过，实际行为符合要求，修改范围符合任务",
      "evidence": "[E9]、[E12]、[E13]、[E14]、[E17]；…",
      "use": "subagent",
      "jevOption": true
    }
  ],
  "architect": { "default": "claude/claude-opus-5-5", "candidates": [ "…见 4.3" ] },
  "reviewSecond": { "effort": "medium", "whenOriginalIncludes": { "codex/gpt-6.1-sol": "claude/claude-opus-5-5" }, "otherwise": "codex/gpt-6.1-sol", "order": ["claude/claude-opus-5-5", "codex/gpt-6.1-sol"] },
  "substitutes": [ "…见 4.4" ],
  "ratingPriority": { "note": "…", "cells": [ { "rule": "code-change", "when": "base-model" }, { "rule": "code-change", "when": "deep" }, "…" ] }
}
```

`condition`、`acceptance`、`evidence` 三个字段逐字取自路由表第 2 节对应列（“任务条件”“验收方式”“证据与适用边界”），不改写。`condition` 就是 Jev 规则选择题中该选项的描述。`thresholds` 的值是未校准的起始值 [NEEDS-EVIDENCE]：`deepYes` 取 JEV 为 `gpt-6-luna` 设定的 0.85（主对话提示上的校准），`hardYes` 取 0.95（233 件委派的运行记录中，Jev 深入推理概率达到 0.95 的委派运行规模最大，判为 code-change 的 20 件中同样如此，路由表 [E17]；没有比较其他切点），`ruleConfidence` 与 `architectConfidence` 尚无测量；第 9.14 节的校准提出调整、用户确认后改为新值并提高规则版本。`hardModel` 是规则在 Jev 的深入推理概率达到 `hardYes` 时改用的模型，强度不变；目前只有 `code-change`：Opus 5.5，达到 0.95 时 Mythos 5.2（路由表第 2.4 节）。`ratingPriority` 列出结果还没有在用户任务上比较过的设置，每天的评分邀请先从这些任务中选（第 9.14 节）。

### 4.2 19 条规则

`use` 取值：`subagent`（Jev 在子代理启动时可以选中）、`plugin`（只由插件在特定流程中指定）、`main`（主对话角色，不由子代理规则选择）。

| `id` | `use` | `jevOption` | 角色 | 模型 ID | 起始强度 |
| --- | --- | --- | --- | --- | --- |
| `architect` | main | false | 长期任务架构师 | `claude/claude-opus-5-5`（用户确认，候选见 4.3） | 无（JEV 逐条判断） |
| `route-assessment` | plugin | false | 评估子代理 | `claude/claude-mythos-5-2` | high |
| `daily-default` | plugin | false | 执行子代理 | `claude/claude-opus-5-5` | medium |
| `review-second` | subagent | false | 审查或诊断子代理 | 按 4.5 节计算 | medium |
| `code-change` | subagent | true | 实施子代理 | `claude/claude-opus-5-5`；Jev 深入推理概率达到 `hardYes` 时 `claude/claude-mythos-5-2` | high |
| `review` | subagent | true | 审查或诊断子代理 | `claude/claude-opus-5-5` | medium |
| `code-read` | subagent | true | 调研子代理 | `claude/claude-opus-5-5` | medium |
| `design-advice` | subagent | true | 设计子代理 | `claude/claude-mythos-5-2` | high |
| `web-research` | subagent | true | 研究子代理 | `claude/claude-opus-5-5` | medium |
| `machine-ops` | subagent | true | 执行子代理 | `claude/claude-sonnet-5-5` | max |
| `batch-judge` | subagent | true | 执行子代理 | `claude/claude-opus-5-5` | medium |
| `explain-write` | subagent | true | 写作子代理 | `antigravity/gemini-4-argon` | high |
| `document-analysis` | subagent | true | 研究子代理 | `codex/gpt-6.1-sol` | high |
| `visual-build` | subagent | true | 实施子代理 | `claude/claude-opus-5-5` | high |
| `translation` | subagent | true | 执行子代理 | `claude/claude-opus-5-5` | medium |
| `math` | subagent | true | 研究子代理 | `codex/gpt-6.1-sol` | max |
| `science-compute` | subagent | true | 研究或实施子代理 | `claude/claude-mythos-5-2` | high |
| `lean` | subagent | true | 实施子代理 | `claude/claude-opus-5-5` | high |
| `computer-use` | subagent | true | 实施子代理 | `codex/gpt-6.1-terra`；需要深入推理时 `codex/gpt-6.1-sol` | medium |

Jev 的规则选择题共 16 个选项：15 条 `jevOption` 规则加 `none`（描述：`没有一条规则符合：任务条件与上面每一条都不一致，或说明缺少判断所需的目标`）。`daily-default` 在日常请求没有匹配规则时由插件指定，`route-assessment` 在日常任务的执行者不能按规则直接确定时由插件指定；`review` 规则同时用于日常任务的验收子代理和诊断子代理，由插件直接指定。

### 4.3 架构师候选

架构师只用 JEV 覆盖的三个模型（用户决定）。`architect.candidates` 每项含 `model`、`name`、`when`（Jev 选择题的选项描述）、`evidence`、`limits`（确认对话中展示）：

| 模型 | `when` | `evidence` | `limits` |
| --- | --- | --- | --- |
| `claude/claude-opus-5-5`（默认） | 需要持续讨论目标、模块职责、关键约束和方案取舍，主要工作是代码、系统设计、写作或综合判断 | 路由表 `architect` 行：[E1] 仓库修改、[E2] 综合测评、[E3] 交流偏好 | 综合间接证据，没有直接测试与用户共同设计的能力 |
| `codex/gpt-6-astra` | 长期任务的主体是科学计算、数据分析、模拟或多步科学探索，设计讨论围绕计算方法展开 | [E2] Science：Astra high 59.5%、max 63.3% | 测评衡量科学工具工作流，没有衡量长期设计讨论 |
| `codex/gpt-6.1-sol` | 长期任务的主体是数学推导、命题核查或大量文档核对，设计讨论围绕论证与来源展开 | [E5] ArXivMath、BrokenArXiv；[E2] GDP.pdf | 测评衡量最终答案与文档推理，没有衡量长期设计讨论 |

推荐规则：Jev 对 `architect` 选择题的答案置信度不低于 `architectConfidence` 时推荐所选模型，否则推荐默认的 Opus 5.5。

### 4.4 替代候选

`substitutes` 来自路由表第 3 节，供诊断后的模型更换和模型不可用时使用。强度一列只写路由表给出的内容：`efforts` 为列出的档位，`'rule'` 表示取对应任务规则的强度，`null` 表示路由表没有给出强度。

| `id` | `forRules` | 模型与强度（`efforts`） | `auto` |
| --- | --- | --- | --- |
| `repo-alt` | `code-change` | Astra，`['xhigh', 'max']` | true |
| `science-math-alt` | `science-compute`、`math` | Astra，`['high', 'max']`；Sol 6.1，`'rule'` | true |
| `assessment-alt` | `route-assessment` | Opus 5.5，`['xhigh']` | true |
| `review-alt` | `review` | Opus 5.5，`['medium']`；Sol 6.1，`['medium']` | true |
| `writing-alt` | `explain-write` | Opus 5.5，`['high', 'xhigh', 'max']` | true |
| `math-extra` | `math` | Sol 6，`null` | true |
| `long-autonomous` | 任意 | Mythos 5.2，`['high']` | false |
| `small-tasks` | 任意 | Haiku 5.5，`null`；Luna 6，`null` | false |

`auto: true` 的候选在已有规则之内：长期任务由架构师说明理由后采用；日常任务在诊断建议之后由插件直接采用，强度取诊断建议给出的档位，必须在 `efforts` 之内（`'rule'` 时等于对应规则的强度，`null` 时不限）。`repo-alt` 在日常任务中由诊断建议的档位代替架构师的选择，记录的选择理由写明这一点。`auto: false` 的候选只有用户指定时才使用。

规则自己写明的模型（`model`、`hardModel`、`deepModel`）不列在替代候选中：它们在该规则提升顺序的档位内都可以自动采用（`substituteAllowed` 返回 `rule:<id>`），模型不可用时也先换这些模型（第 9.16 节）。

模型不可用时的自动接手（第 9.16 节）不经过诊断，强度只能从路由表推出：`efforts` 列出档位时取不低于该代理当前强度的最低一档，当前强度高于全部档位时取最高一档（`repo-alt`：`code-change` 的 high 得到 Astra xhigh，提升到 max 后得到 Astra max）；`'rule'` 时取对应规则的强度；`null` 的候选（`math-extra`、`small-tasks`）没有可推出的强度，不用于自动接手。

### 4.5 `rules.ts` 接口

```ts
export interface Rule { id: string; section: string; condition: string; role: string; model: string | null; deepModel: string | null; hardModel: string | null; effort: Effort | null; deepEffort: Effort | null; raiseOrder: Effort[] | null; acceptance: string; evidence: string; use: 'subagent' | 'plugin' | 'main'; jevOption: boolean }
export interface ArchitectCandidate { model: string; name: string; when: string; evidence: string; limits: string }
export interface Substitute { id: string; forRules: string[] | '*'; options: { model: string; efforts: Effort[] | 'rule' | null }[]; auto: boolean; note?: string }
export interface RatingCell { rule: string; when: 'base-model' | 'deep' }
export interface Rules { version: string; thresholds: { ruleConfidence: number; deepYes: number; hardYes: number; architectConfidence: number }; models: Record<string, { name: string }>; rules: Rule[]; architect: { default: string; candidates: ArchitectCandidate[] }; reviewSecond: { effort: Effort; whenOriginalIncludes: Record<string, string>; otherwise: string; order: string[] }; substitutes: Substitute[]; ratingPriority: { note: string; cells: RatingCell[] } }

export function parseRules(json: unknown, jev: { deepYes: number }): Rules        // 校验：19 条规则 ID 唯一且齐全，模型在 models 中，hardModel 不等于规则自己的模型，强度合法，raiseOrder 从起步档位开始严格上升且含 deepEffort，ratingPriority 的规则为子代理规则、base-model 只用于有第二个模型的规则；否则抛出
export function jevDeepYes(io: Io): Promise<number>                               // src/jevconfig.ts：JEV .env 的 JEV_OPUS_DEEP_YES，缺省为 JEV 的默认值 0.5
export function loadRules(io: Io, pluginRoot: string): Promise<Rules>
export function ruleById(rules: Rules, id: string): Rule                           // 不存在时抛出
export function jevChoices(rules: Rules): { value: string; description: string }[] // 15 条加 none，顺序同文件
export function raise(e: Effort, steps?: number): Effort                           // 最高 max
export function isHardWork(deepP: number | null, rules: Rules): boolean           // deepP 不低于 thresholds.hardYes；没有概率（评估模型代为判断）时为 false
export function ruleModel(rule: Rule, j: { deep: boolean; hard: boolean }): string // hard 且有 hardModel 时为 hardModel，deep 且有 deepModel 时为 deepModel，否则为 model
export function ownModels(rule: Rule): string[]                                    // model、hardModel、deepModel 中不为 null 的
export function startEffort(rule: Rule, deep: boolean): Effort                     // deep 时为 deepEffort
export function raiseOnRule(rule: Rule, current: Effort): Effort                  // raiseOrder 中高于 current 的下一档；已在顶端时不变
export function reviewSecondTarget(rules: Rules, originals: string[], available: (id: string) => boolean, same: (a: string, b: string) => boolean): { model: string; effort: Effort } | { none: string }
export function substituteAllowed(rules: Rules, ruleId: string, model: string, effort: Effort, same: (a: string, b: string) => boolean): Substitute | null   // 规则自己写明的模型且强度在 raiseOrder 内时返回 rule:<id>；否则 auto 候选且强度符合 efforts 时返回
export function substituteEffort(rules: Rules, sub: Substitute, model: string, ruleId: string, current: Effort): Effort | null   // 第 4.4 节的自动接手强度；null 为不能自动接手
```

`reviewSecondTarget` 的计算：

1. `originals` 是被复核模型的集合（来自说明中的 `[review-of …]`，第 9.6 节），比较前都经过 `model.canonical`，别名与 1M 变体视为同一模型，强度不同也视为同一模型。
2. 首选：集合中含 Sol 6.1 时为 Opus 5.5，否则为 Sol 6.1。
3. 候选顺序：首选在前，`order` 中其余模型随后；去掉与集合中任一模型相同的候选，再去掉 `available` 为 false 的候选（Magpie 模型列表中没有）。
4. 取第一个剩余候选，强度为 `reviewSecond.effort`（medium）；没有剩余候选时返回 `{ none: 说明 }`，由调用方报告用户并等待决定。

### 4.6 模型标识（`src/model.ts`）

```ts
export interface ModelCatalog { picker: string[]; aliases: Record<string, string>; capabilities: Record<string, Set<string>> }
export function catalogFrom(flagSettings: unknown): ModelCatalog   // 读取 $.settings.read({ source: 'flag' })
export function canonical(id: string, cat: ModelCatalog): string    // 去掉 [1m]；opus/sonnet/haiku/fable 别名经 ANTHROPIC_DEFAULT_*_MODEL 解析
export function sameModel(a: string, b: string, cat: ModelCatalog): boolean
export function requestId(id: string, cat: ModelCatalog): string    // picker 中有 `${id}[1m]` 时用它，否则用 id
export function withRuleModels(cat: ModelCatalog, ruleModels: string[]): ModelCatalog   // session.start 用它把规则文件的模型加进列表
export function isAvailable(id: string, cat: ModelCatalog): boolean
export function clampEffort(id: string, effort: Effort, cat: ModelCatalog): Effort  // 按 CLAUDE_CODE_MODEL_CAPABILITIES 去掉不支持的 xhigh/max
export function displayName(id: string, rules: Rules): string
```

Magpie 的 flag 层设置提供三样数据（2026-11-09 读取 `~/.config/magpie/claude-launch/settings.json` 的结构确认）：`modelPicker.options[].model`（带 `[1m]` 的 Claude 模型 ID 与 Codex 模型 ID）、`env.ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`、`env.CLAUDE_CODE_MODEL_CAPABILITIES`（`id=effort,xhigh_effort,max_effort;…`）。子代理请求使用 `requestId` 的结果，让 Claude 模型使用启动脚本提供的 1M 上下文变体；记录中保存规范化 ID。

`isAvailable` 只判断模型是否在 Magpie 的模型列表中，用于规则选出的模型、`review-second` 与替代候选。用户指定的模型（`[model-reason user: …]`）不做这项检查，原样交给 Magpie：路由表第 5 节规定用户指定优先，接口不支持时说明实际限制；Magpie 拒绝时按第 9.16 节报告用户。架构师依据证据指定（`[model-reason evidence: …]`）的模型不在列表中时拒绝启动，理由写明这一点。

Magpie 的列表来自各家服务自己的模型列表，可能晚于已经能用的新模型（2026-11-10：Mythos 5.2 的请求正常返回，列表里还没有它）。所以 `session.start` 用 `withRuleModels` 把规则文件 `models` 中的模型加进列表：规则写明的模型视为可用；实际不可用时，子代理以 API 错误结束，由第 9.16 节的模型不可用处理接手。

## 5. 强度规则

子代理的强度由插件在 `turn.step` 中设置（第 9.7 节）。架构师与 Router 的主对话、未路由的子代理和其他会话的请求原样传递，交给 JEV。

| 时机 | 新强度 | 记录原因 |
| --- | --- | --- |
| 启动 | `startEffort(rule, deep)`：规则的起步强度，Jev 判断需要深入推理时为规则的深入强度 | `rule`、`deep` |
| 启动且说明写明 `[effort <level>]`（指定模型时） | 该强度 | `explicit` |
| 续接（同一代理收到新消息） | `max(当前强度, startEffort(rule, 新判断的 deep))` | `resume-deep`（强度变化时） |
| 验收不通过后交回修复 | `raiseOnRule(rule, 上一项结果)`：规则提升顺序中的下一档（没有规则时提高一级） | `acceptance-failed` |
| 诊断后重新委派同一任务（原代理继续或更换模型） | 同上 | `diagnosis-redelegate` |
| 每一步 | `clampEffort(model, …)`，最高 max | — |

Opus 5.5 与 Mythos 5.2 的规则判为需要深入推理时也从 high 起步，xhigh、max 只经由上表的提高（验收不通过、诊断后重新委派）或明确指定（路由表第 2.4 节）。`code-change` 的 `hardModel` 只改变模型，不改变强度（第 4.1 节）。

“深入推理”判断：Jev 的 `deep` 判断题概率不低于 JEV 的 `JEV_OPUS_DEEP_YES`（`loadRules` 经 `jevDeepYes` 读取，写入 `rules.thresholds.deepYes`）时为真；规则文件不另存门槛，JEV 重新校准时两处一起变化。判断结果写入记录，在路由校准中用实际结果检验。

## 6. Jev 客户端与判断（工作包 B）

magpie-tasks 与 `mods/jev` 是不同的插件根目录，不能互相导入，所以它有自己的小客户端。

### 6.1 `src/jev.ts`

```ts
export type JevMessage = { role: 'user' | 'assistant'; content: string }
export type JevQuestion =
  | { name: string; type: 'choice'; instructions: string; choices: { value: string; description: string }[] }
  | { name: string; type: 'predicate'; instructions: string }
export type JevAnswer = { kind: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> } | { kind: 'predicate'; p: number }
export type JevResult =
  | { ok: true; answers: Record<string, JevAnswer>; latencyMs: number; inputTokens: number; cachedTokens?: number }
  | { ok: false; error: string; latencyMs: number }
export interface JevConfig { url: string; model: string; keyFile: string; deadlineMs: number }

export function buildRequest(model: string, input: JevMessage[], questions: JevQuestion[]): unknown
export function parseResponse(text: string, questions: JevQuestion[]): { answers: Record<string, JevAnswer>; inputTokens: number; cachedTokens?: number }  // 任一问题缺失或不合法时抛出
export function recomputedConfidence(probabilities: Record<string, number>, n: number): number
export function ask(io: Io, cfg: JevConfig, input: JevMessage[], questions: JevQuestion[]): Promise<JevResult>
```

- 请求：`POST cfg.url`，头 `Authorization: Bearer <key>`、`Content-Type: application/json`；正文 `{ model, input: JevMessage[], questions: [...] }`。`input` 始终是消息列表，按原顺序排列，当前内容在最后（2026-11-09 实测：消息列表追加后前缀走缓存，拼成一段文字不走缓存）。选择题的 `choices` 为 `[{ value, description }]`，判断题 `type: 'predicate'`。
- 响应：`answers` 为数组，选择题 `{ name, type: 'choice', choice, confidence, probabilities: [{ value, probability }] }`，判断题 `{ name, type: 'predicate', probability }`（与 `mods/jev/src/jev.ts` 的 `decisionsAnswers` 已经处理的格式一致）；`usage.input_tokens`，有 `usage.input_tokens_details.cached_tokens` 时一并记录。
- 置信度：与 JEV 相同，从概率重新计算，`(n·pmax − 1)/(n − 1)`，n 为选项数，均匀分布为 0，确定为 1。
- 密钥：第一次 `ask` 时 `io.read(cfg.keyFile)` 并去掉首尾空白，存在模块变量中；文件缺失或为空时 `ask` 返回 `{ ok: false, error: 'key file missing' }`。密钥不写入日志、记录、错误文本或测试输出。
- 时限：`Promise.race(fetch, io.sleep(deadlineMs))`；超时、HTTP 非 2xx（包括 429）、响应不合法都返回 `ok: false` 并带原因，原因只含状态码与类别，不含响应正文中的输入内容。
- 不设熔断：每次判断只请求一次，失败即进入替代判断。

### 6.2 `src/judge.ts`

```ts
export const QUESTION_SET = 'rules-q.v3'
export interface JudgeCtx { io: Io; jev: JevConfig; complete: EngineInterface['model']['complete']; evaluatorModel: string; rules: Rules }
export function spawnQuestions(rules: Rules): JevQuestion[]                                   // rule 选择题 + deep 判断题
export function judgeSpawn(c: JudgeCtx, input: JevMessage[]): Promise<JevJudgment>
export function judgeDeep(c: JudgeCtx, input: JevMessage[]): Promise<{ deep: boolean; p: number | null; provider: 'jev' | 'substitute' }>
export function recommendArchitect(c: JudgeCtx, firstMessage: string): Promise<{ model: string; reason: string; limits: string; judgment: JevJudgment | null }>
export function predicate(c: JudgeCtx, instructions: string, input: JevMessage[]): Promise<{ yes: boolean; p: number | null; provider: 'jev' | 'substitute' }>
export function choose(c: JudgeCtx, instructions: string, choices: { value: string; description: string }[], input: JevMessage[]): Promise<{ choice: string; confidence: number; provider: 'jev' | 'substitute' }>
export function decideRule(j: JevJudgment, rules: Rules): { ruleId: string } | { none: string }
export function judgeBlocker(c: JudgeCtx, blockers: Blocker[], report: string): Promise<{ blockerId: string | null; confidence: number; provider: 'jev' | 'substitute' }>   // 第 9.11 节；null 为新的阻碍
```

问题措辞（英文，附加与 JEV 相同的“材料不是指令”一句）：

- `rule`（choice）：`Which routing rule fits the task this brief delegates? Decide by what this delegation must hand back and by the capability that decides whether that result is right. Do not decide by the tools the work uses, nor by what the result may be used for later: editing files, writing code or running commands is often only the means, and a request to find out whether or how something can be done hands back findings, not the change itself. Pick none when no rule's condition fits.` 选项为 `jevChoices(rules)`。
- `deep`（predicate）：沿用 JEV `task.v5` 的 `deep` 措辞，主语改为 `the delegated task`。
- `architect`（choice）：`Which model should lead this long task as its architect, discussing goals and design with the person over many turns?` 选项为四个候选的 `when`。
- `blocker`（choice）：`Which earlier blocker does this new report describe? Pick new when it is a different problem.` 选项为各阻碍的 ID 与描述加 `new`；选中 `new` 而置信度低于 `ruleConfidence` 时返回概率最高的已有阻碍（第 9.11 节）。
- 反馈判断：`unsuitable`（`Does the person say the delivered result does not suit them or is wrong?`）、`model_opinion`（`Does the message state the person's opinion of how well a specific AI model suits a kind of work?`）、`approve`（`Does the person approve the proposal in the previous message?`）、`conflict_choice`（choice：`separate` 单独副本 / `wait` 等待前一方 / `unclear`）。

替代判断：`ask` 返回 `ok: false` 时调用 `$.model.complete({ model: evaluatorModel, prompt, effort: 'low', timeoutMs: 30000 })`，提示要求只输出一行 JSON（规则判断为 `{"rule": "<id|none>", "confidence": <0..1>, "deep": <true|false>}`，其他问题同理）。解析成功则返回 `provider: 'substitute'` 并带 `substituteReason`；回答缺失或 JSON 不合法时抛出错误，调用方把错误显示给发起方（第 9.6 节）。

`decideRule`：`ruleChoice !== 'none'` 且 `confidence >= ruleConfidence` 时返回规则，否则返回 `{ none }`，说明写明 Jev 的首选、置信度与门槛。

### 6.3 `src/dialogue.ts`

```ts
export function subagentDialogue(api: ApiMessage[]): JevMessage[]
export function briefForJev(prompt: string): string     // 去掉所有 [magpie-tasks …]、[model …]、[model-reason …] 等控制行；以 [magpie-tasks task-rules] 开头的行及其后的任务规则整段去掉；tg-router 的工作者说明（含 `The original message:` 一行）只保留用户的原话（频道块的正文）：Router 写的标题会改写用户的意图（2026-11-10：“看看能不能支持……”被写成“改造 provider 机制……”，带标题时 Jev 判 code-change 0.93，只给原话时判 code-read 0.79），说明里固定的仓库编辑指示也会把任务拉向 code-change
```

续接子代理时，Jev 的输入从 `$.session.messages({ agentId, as: 'api' })` 整理，规则采用 findings 中实测的过滤规则：

- user 消息按块拆分；去掉匹配 `/^<system-reminder(\s[^>]*)?>/` 的提醒块，但其中同时含 `[SYSTEM NOTIFICATION - NOT USER INPUT]` 与 `<task-notification>` 的块保留为一轮开始，只取 `<summary>` 与 `<result>`，按 task-id、summary 与 result 三项去重。只按 task-id 加 summary 去重会丢掉真实事件：被 SendMessage 续接的子代理完成后再发一条 task-id 与 summary 相同、result 不同的通知（探测转储 034 的 msg10 与 msg48，findings“JEV Jev context rework”）；三项都相同的才是子代理视图中重复出现的同一条（转储 048 的 msg0 与 msg4）。
- tool_result 中只提取两种中途消息：`The user sent a new message while you were working:` 到 `\n\nThis is how Claude Code surfaces` 之间，`The coordinator sent a message while you were working:` 到 `\n\nAddress this before completing your current task.` 之间；开始标签可以带 `id` 属性。
- 已完成后被续发的子代理：去掉 coordinator 包装块，保留并列的原文块。
- 每轮的最终回答取该轮最后一条不含 tool_use 的 assistant 消息的 text 块；thinking 块为空，跳过。
- 第一条 user 内容经过 `briefForJev`。结果按原顺序输出，当前续接消息在最后。

## 7. 任务登记与记录（工作包 C）

### 7.1 存储位置

所有共享状态放在 `opts.stateDir`（默认 `~/.config/magpie-tasks`，在仓库之外）。插件的 `$.store` 按插件与 `CLAUDE_CONFIG_DIR` 各一个 JSON 文件，不能被多个进程安全地同时改写，所以不用于共享状态。

```
<stateDir>/
  tasks/<taskId>.json          一个任务一个记录文件
  tasks/<taskId>.log.jsonl     任务日志，只追加
  claims/<claimId>.json        待认领记录
  index/telegram.json          Telegram 索引（tg-router 只读）
  index/sessions.json          会话 ID → 任务 ID
  state/rating.json            { lastInviteDay, invites: [...] }
  state/calibration.json       { lastCheckAt, reminded: [...] }
  state/recovery.json          { lastRunAt }
  state/declined.json          { sessions: { <会话 ID>: <拒绝时间> } }：拒绝接管的会话（第 9.4 节）
  locks/<name>.lock/           目录锁
<worktreeDir>/<taskId>/        任务工作副本（另一个任务在直接修改同一项目时才建立）
<worktreeDir>/<taskId>-<agentId>/  单独副本
```

### 7.2 锁（`src/lock.ts`）

```ts
export function withLock<T>(io: Io, locksDir: string, name: string, owner: string, fn: () => Promise<T>, o?: { waitMs?: number; staleMs?: number }): Promise<T>
```

- 获取：`io.run(['mkdir', `${locksDir}/${name}.lock`])`，退出码 0 即获得，随后写入 `owner.json`（`{ owner, at }`）。
- 等待：目录已存在时，`stat` 锁目录；修改时间早于 `staleMs`（默认 30 秒）时用 `mv <lock> <lock>.stale.<owner>.<now>` 改名再 `rm -rf`，只有改名成功的一方继续；否则 `wait(io, 25–100 毫秒随机)` 后重试，超过 `waitMs`（默认 10 秒）抛出错误，错误中写明锁名与持有者。等待用 `wait` 而不用 `io.sleep`：`withLock` 在 `tool.call`、`turn.complete`、`prompt.submit` 钩子中运行，`$.clock` 的等待计入钩子的 10 秒时限，争用时钩子会超时、被当作不存在，整合等流程就此消失而没有错误；`wait` 运行 `sleep` 进程，等待期间时限停止计时。第一次需要等待时 `io.log` 一行 `lock wait <锁名> held by <持有者>`，供排查与场景 E8 使用。
- 释放：`rm -rf` 锁目录，放在 `finally` 中。
- 约束：持有锁期间只做文件读写与本地命令，不调用 Jev、模型或网络，因此正常持锁时间远小于 30 秒。`integrate` 的项目锁例外，它运行 `git apply`，等待上限设为 120 秒、失效时间 10 分钟。

锁名：`task-<taskId>`、`index`、`claims`、`project-<fnv1a64(项目真实路径)>`、`recovery`、`schedule`、`declined`。

### 7.3 写入

- 原子写入：`io.write(<file>.tmp.<owner>.<now>, text)` 后 `io.run(['mv', '-f', tmp, file])`，退出码非 0 时抛出。读取不加锁，读到的总是完整文件。
- 日志追加：在任务锁内执行 `io.run(['sh', '-c', 'cat >> "$1"', 'sh', logPath], { stdin: JSON.stringify(entry) + '\n' })`。
- 日志条目：`{ at, session, type, ... }`，`type` 包括 `created`、`state`、`claim`、`claim-failed`、`rekey`、`spawn`、`relay`、`effort`、`report`、`acceptance`、`diagnosis`、`blocker`、`integration-start`、`integration`、`unavailable`、`decision`、`telegram`、`feedback`、`rating`、`recovery`、`error`。

### 7.4 `src/registry.ts`

```ts
export class Registry {
  constructor(io: Io, opts: Options, owner: string)   // owner = 本会话 ID
  create(t: Omit<TaskRecord, 'schema' | 'createdAt' | 'updatedAt'>): Promise<TaskRecord>
  get(id: string): Promise<TaskRecord | undefined>
  update(id: string, change: (t: TaskRecord) => void, log: { type: string; [k: string]: unknown }): Promise<TaskRecord>
  list(filter?: (t: TaskRecord) => boolean): Promise<TaskRecord[]>
  bySession(sessionId: string): Promise<TaskRecord | undefined>
  byAgent(agentId: string): Promise<{ task: TaskRecord; agent: AgentRecord } | undefined>
  log(id: string, entry: { type: string; [k: string]: unknown }): Promise<void>
  putClaim(c: Claim): Promise<void>
  takeClaim(match: (c: Claim) => boolean, now: number): Promise<Claim | undefined>   // 在 claims 锁内找到并删除；顺带删除过期认领
  readIndex(): Promise<TelegramIndex>
  updateIndex(change: (x: TelegramIndex) => void): Promise<void>
  readState<T>(name: string, empty: T): Promise<T>
  writeState(name: string, value: unknown): Promise<void>
  lock<T>(name: string, fn: () => Promise<T>, o?: { waitMs?: number; staleMs?: number }): Promise<T>
}
```

`update` 在任务锁内读取、修改、原子写回并追加日志，同时维护 `index/sessions.json`（`owner.sessionId` 与 `previousSessionIds`）。`byAgent` 先查本进程缓存，未命中时扫描 `tasks/`（任务数量为几十到几百，读取开销小）。

### 7.5 Telegram 索引的约定

`index/telegram.json` 由 magpie-tasks 在 `index` 锁内原子写入，tg-router 只读（第 10.1 节）：

- `messages["<chatId>:<messageId>"]`：magpie-tasks 发出的消息与长期任务相关的消息。`kind`：`long`（长期任务的消息，回复转给架构师；其中等待用户决定的问题另带 `decisionId`）、`magpie`（日常任务的路由说明、验收与整合报告，回复转给任务当前负责代理）、`rating`（评分邀请）、`decision`（日常任务等待用户决定的问题，带 `decisionId`，由 Router 会话执行）。决定的执行者由任务的负责人决定（第 9.12 节）：长期任务的子代理只属于架构师会话，`$.session.send({ to: { agentId } })` 只能送达本会话的子代理（类型定义 `SessionSendAddress.agentId`），所以长期任务的决定一律交给架构师会话执行。
- `workers["<workerName>"]`：tg-router 的 worker 名对应的任务、当前负责代理 ID，以及任务是否已转为长期任务。
- `agents["<agentId>"]`：负责代理 ID 到 worker 名，tg-router 据此把更换后的执行者的回答发到原任务下。验收、诊断子代理不写入这里，tg-router 因而不转发它们的回答。

### 7.6 待认领记录与会话 ID 更新

后台会话收不到启动者的环境变量（实测），插件通过登记表认领：

- 启动认领（`kind: 'launch'`）：插件启动 `claude-magpie --bg` 前写入，包含任务 ID、工作目录、传给后台会话的完整消息的散列，10 分钟后过期。
- 接管认领（`kind: 'takeover'`）：前台会话发出 `/bg` 前写入，包含任务 ID、工作目录、原会话 ID，2 分钟后过期；同时用 `$.session.append` 在对话中追加一行 `[magpie-tasks takeover task=<id> claim=<claimId>]`（user 角色，模型读到但用户看不到），`/bg` 生成的副本从原会话分叉，带着这一行。
- 认领成功后，记录的 `owner.sessionId` 改为新会话 ID，旧 ID 放入 `previousSessionIds`，`jobShortId` 取 `CLAUDE_JOB_DIR` 的末段，日志写 `claim` 或 `rekey`。
- 认领失败一律报告，不让会话以普通会话的身份悄悄继续：启动认领由启动方等待确认（第 9.2 节第 10 步），后台会话发现散列不符时报告并丢弃消息（第 9.3 节）；接管认领失败时副本报告（第 9.4 节第 6 步）；从未被认领的 `starting` 任务由启动恢复报告（第 9.13 节）。日志写 `claim-failed`。

## 8. 钩子事件总表（`hooks/register.ts`，工作包 H）

| 事件 | `inactive`/`unmanaged` | `candidate` | `bg-unclaimed` | `architect` | `router` |
| --- | --- | --- | --- | --- | --- |
| `settings.read` | `bgIsolationAnswer`：只看 `flag` 层，与角色无关（第 2 节） | 同左 | 同左 | 同左 | 同左 |
| `session.start` | 判定角色 | 安装顺序检查；启动恢复 | — | 载入本任务的子代理；记录 context-memory 指纹 | 安装顺序检查；注册 Router 工具；启动恢复；启动定时器 |
| `classic.SessionStart` | — | 记录 `source`（判断是否为恢复的会话） | — | — | — |
| `prompt.submit` | `next` | 第一条消息流程或接管流程 | 启动认领 | 中转；决定标记；记录 Telegram 回复目标；每轮上下文；记录窗口消息 | 中转；magpie-tasks 消息的回复；评分；长期任务列表上下文 |
| `session.send` | — | — | — | — | 观察 tg-router 发给 worker 的追问，记录反馈 |
| `agent.spawn` | `next` | `next` | `next` | 路由 | 路由 |
| `turn.start` | `next` | `next` | `next` | 路由过的子代理的续接判定 | 同左 |
| `turn.step` | `next` | `next` | `next` | 路由过的子代理设强度，记下它的强度条 | 同左 |
| `tool.call` | `next` | `next` | `next` | 主对话工具限制；子代理写入范围与文件冲突；注册工具的处理（架构师工具只回应主对话，子代理调用时拒绝） | 子代理写入范围；注册工具的处理（Router 工具只回应主对话，子代理调用时拒绝） |
| `classic.StopFailure` | — | — | — | 路由过的子代理：记录错误分类 | 同左 |
| `turn.complete` | `next` | 接管确认后发出 `/bg` | — | 主对话：Telegram 回复、调试日志检查；子代理：冲突等待解除、报告记录、模型不可用、强度条标记结束 | 日常任务流程；模型不可用；强度条标记结束 |
| `ui.render`（`AbovePrompt`） | `next` | `next` | `next` | 视图中是路由过的子代理时画它的强度条（第 9.7 节），其余 `next` | 同左 |
| `session.end` | 清空强度条 | 同左 | 同左 | 同左 | 同左 |

`settings.read` 钩子是纯函数 `bgIsolationAnswer`，不注册 `.catch`。`ui.render` 与 `session.end` 只读写本进程内存中的强度条，也不注册 `.catch`：绘制钩子出错时引擎跳过它，画内层的内容。其余钩子按出错的后果分三类处理，没有一类在出错后悄悄继续：

1. **流程钩子**：`prompt.submit`（第一条消息、接管、启动认领、中转、架构师收到的消息）、`turn.complete`（架构师主对话、子代理、日常任务）以及注册工具的处理。`.catch` 中：错误写入调试日志与任务日志（`type: 'error'`，含错误首行）；能确定任务时，任务改为 `error` 并写入 `error`；`$.ui.log('magpie-tasks 出错（任务 <id>）：<错误首行>')`（本计划中的 `$.ui.notice(text)` 一律指 `$.ui.log(text)`：一行不发给模型的会话提示；类型中的 `$.ui.notice` 是工具调用对话框下的说明行）；有 Telegram 关联或默认聊天、且聊天不是 `tui` 时发一条通知（任务标题、ID、错误首行，`notify: true`），聊天为 `tui` 时会话中的那一行就是报告。`prompt.submit` 的流程返回 `{ drop: 'magpie-tasks 出错：<错误首行>；消息没有发出' }`，不把消息交给普通会话：第一条消息流程在 `git init` 或建立工作副本之后出错时，前台会话保留，消息放回输入框；中转消息出错时请求留在 `pendingRelays` 中，由出错通知说明；架构师收到的 Telegram 转交消息出错时，Telegram 通知说明这条消息没有交给架构师。注册工具的处理抛出错误时（参数不合法最常见）以 `{ deny: 错误首行 }` 返回，模型读到拒绝理由后改正；错误写入调试日志、任务日志（`type: 'error'`）与会话提示，任务状态不变。
2. **把关钩子**：`agent.spawn` 与 `tool.call` 的检查。`.catch` 在 `next.called` 为假时返回拒绝，理由含错误首行，模型或 Router 看到原因；同时写入日志并 `$.ui.notice`。`next` 已经调用后出错时保留其结果，写入日志并 `$.ui.notice`。
3. **强度钩子**：`turn.start`、`turn.step`、`classic.StopFailure`。`.catch` 写入日志，对每个代理只 `$.ui.notice` 一次，请求按引擎原值继续（强度设置失败不应让子代理的请求失败）；任务记录中该代理的 `efforts` 追加一条 `note: 'effort hook error'`，校准时可以看到。

用户之后向处于 `error` 的任务发出的第一条消息（窗口或 Telegram）把任务改回 `running`，日志写 `state`；`error` 字段保留最后一次错误。场景 E15 强制一次流程钩子错误并检查报告。

## 9. 流程

### 9.1 会话启动

1. `session.start`：`next(e)` 后执行。读 `opts`（`register(on, options)` 传入，`~` 用 `$.env.get('HOME')` 展开），按第 2 节判定角色，写入 `st`。
2. `inactive`：直接返回。
3. 其他角色：`loadRules`，`catalogFrom(await $.settings.read({ source: 'flag' }))`，建立 `Registry`。
4. `candidate` 与 `router`：执行安装顺序检查（第 9.15 节），然后在后台执行启动恢复（第 9.13 节，不阻塞会话），其 Promise 存入 `st.recovery`。`recover` 总是返回 Promise，10 分钟内已运行过的判断在它内部进行，所以这两种角色的 `st.recovery` 从不为 `null`。`candidate` 会话之后会结束前台进程（第 9.2 节第 11 步）或转入后台（第 9.4 节第 5 步），两处都先等待 `st.recovery` 结束，恢复不会在中途被打断。
5. `router`：注册 Router 工具（第 9.12 节），启动 15 分钟一次的 `$.clock.every`，执行评分与校准检查（第 9.14 节）。
6. `architect`（会话 ID 已登记）：从记录载入本会话的子代理到 `st.agents`、它们的 `pendingRaises` 到 `st.pendingRaises`，注册架构师工具，`st.taskId` 设为任务 ID。

### 9.2 新长期任务：第一条消息

触发：`candidate` 角色，`prompt.submit` 中 `e.origin.kind === 'composer'`、没有 `e.command`、本会话第一条消息，`classic.SessionStart` 的 `source` 不是 `resume`。

1. 取项目根：`git -C <cwd> rev-parse --show-toplevel`。是仓库时项目根为输出路径；不是仓库时项目根为 `cwd`。
2. `recommendArchitect(firstMessage)`（第 6.2 节）。
3. `$.ui.ask(question, { options, header: '长期任务' })`。选项为纯文字：推荐模型排第一并标“（推荐）”，然后是另外三个候选。问题文字包含：推荐理由、证据与限制（来自 `architect.candidates`）、项目根路径、任务将在哪里修改（`previewPlacement` 的结果，第 9.9 节：`直接修改：<目录>`，不是 Git 仓库时注明没有差异记录；已有任务在直接修改时为 `工作副本：<worktreeDir>/<taskId>`，并写出那些任务的标题），项目根不受信任时（`trust.projectTrusted` 为假，见第 6 步）加一句“Claude Code 还没有把 `<项目根>` 记为受信任的目录，后台会话不能在那里启动。确认即表示你信任这个目录，插件会在 Claude Code 的配置中记下这一点”，最后一句说明不需要登记的临时操作请使用普通 `claude`。确认对话会一直挂起消息，直到用户回答（实测 23 秒，超过钩子时限也有效）。
4. 回答处理（与选项文字逐字比较）：
   - Esc（`$.ui.ask` 拒绝）：返回 `{ drop: 'magpie-tasks: 已取消；消息已放回输入框，再次发送会重新询问；临时操作请使用普通 claude' }`，下一条消息重新询问。
   - 无法识别的自由文字：同上，理由写“没有识别出选择”。
   - 某个模型：继续。
5. 登记：`reg.create`（`kind: 'long'`，`state: 'starting'`，`title` 取第一条消息的前 30 个字，`architect` 写入推荐、判断与用户选择，`telegram: { chatId: defaultChat() }`）。
6. 项目准备：项目根不受信任时先 `trust.trustProject(root)`：在全局配置（`<CLAUDE_CONFIG_DIR>/.claude.json`，没有 `CLAUDE_CONFIG_DIR` 时为 `~/.claude.json`）中把 `projects[<项目根>].hasTrustDialogAccepted` 设为 `true`，其余字段不变；新内容写到同目录的临时文件，`chmod --reference` 后改名覆盖，再读回确认标记还在。`claude --bg` 拒绝在不受信任的 Git 仓库中启动（“Workspace not trusted”，带不带 `--dangerously-skip-permissions` 都一样），而以 `--dangerously-skip-permissions` 运行的窗口从不显示信任对话，Claude Code 也没有设置信任的命令；用户在确认对话中的回答即视为信任这个目录（findings“workspace trust blocks background architects”）。然后 `placeTask`（第 9.9 节）确定任务的工作目录。插件从不在项目中建立 Git 仓库。
7. 生成架构师的第一条消息：原文，空一行，加一行 `[magpie-tasks architect task=<id> direct=<项目目录>]`（工作副本时为 `worktree=<绝对路径>`），再加一段英文说明：子代理在哪里修改、架构师职责与写入范围、不做提交和推送（覆盖后台会话默认的“完成后提交并推送”）。
8. 写启动认领（散列为第 7 步完整消息的 `fnv1a64`）。
9. `launch.launchArchitect`：`io.run(['env', '-u', 'CLAUDECODE', '-u', 'CLAUDE_CODE_SESSION_ID', '-u', 'CLAUDE_CODE_ENTRYPOINT', opts.launcher, '--bg', '--model', requestId(model), ...pluginDirArgs, message], { cwd: root, timeoutMs: 60000 })`。`env -u` 去掉嵌套会话的标记（`$.process.run` 的 `env` 只能叠加变量，不能删除）。`pluginDirArgs`：`<CLAUDE_CONFIG_DIR 或 ~/.claude>/plugins/installed_plugins.json` 中没有 `magpie-tasks@…` 条目（以 `--plugin-dir` 加载的开发方式）时为 `['--plugin-dir', $.plugin.root]`，否则为空。插件根目录不能用来判断：从目录形式的市场安装的插件直接从市场目录运行（2026-11-09 端到端环境：`$.plugin.root` 为 `~/sipeng/claude-mods/mods/magpie-tasks`），按目录判断会给后台会话加上 `--plugin-dir`，那个会话以 `magpie-tasks@inline` 加载插件、读不到 `pluginConfigs["magpie-tasks@sipeng-mods"]` 的选项。
10. 解析输出 `/backgrounded · ([0-9a-f]{8})/`；退出码非 0 或解析不到时，任务改为 `error` 并写入 `error`，返回 `{ drop: 'magpie-tasks: 后台会话没有启动：<stderr 第一行>' }`，前台会话保留。解析到 `shortId` 后等待认领完成：每 500 毫秒 `wait(io, 500)` 后读取任务记录，最多 60 秒。`owner.kind === 'session'` 且 `state === 'running'` 为成功；任务变为 `error`（后台会话发现散列不符，第 9.3 节）或 60 秒内没有认领时为失败：`stopSession(shortId)` 停止那个后台会话，任务改为 `error`（`error` 写明原因），删除剩余的启动认领，`$.ui.notice` 与 Telegram 报告，返回 `{ drop: 'magpie-tasks: 架构师会话没有完成认领（<原因>），已停止；消息已放回输入框' }`，前台会话保留。
11. 成功：`$.ui.notice` 显示同一行，返回 `{ drop: 'magpie-tasks: 已登记长期任务「<title>」（<id>），架构师 <模型> 已在后台运行。重新打开：claude attach <shortId>' }`，并 `$.clock.after(1500, () => void st.recovery?.then(() => $.command.run({ command: 'exit' })))` 结束前台会话：定时器回调本身立即返回，`exit` 等启动恢复结束后才发出（实测：`prompt.submit` 中不能调用 `$.command.run`，从这里排定的定时器可以）。

第 9、11 步合起来是未验证行为 U1（第 11 节）。架构师会话不会被移入 Claude Code 的原生工作副本（第 2 节），是未验证行为 U9。

### 9.3 后台会话认领

触发：`bg-unclaimed` 角色的第一次 `prompt.submit`。

1. `h = fnv1a64(e.text)`。
2. `takeClaim(c => c.kind === 'launch' && c.cwd === st.cwd && c.promptHash === h && c.expiresAt > now)`。
3. 找到：任务的 `owner = { kind: 'session', sessionId, jobShortId, previousSessionIds: [], model: await $.session.model(), contextMemoryFingerprint }`，`state: 'running'`；`st.role = 'architect'`；注册架构师工具；加入每轮上下文后 `next(e)`。
4. 没有散列相同的认领，但有工作目录相同、未过期的启动认领（散列不符，例如外层插件改写了 `e.text`）：`claimLaunch` 返回 `'mismatch'`。取走该认领，任务改为 `error`（`error: 'launch claim hash mismatch'`），日志 `claim-failed`，`$.ui.notice` 与 Telegram 报告，返回 `{ drop: 'magpie-tasks: 启动认领不符，这个会话没有登记为架构师；任务 <id> 已标为出错' }`。消息不交给模型，会话不以普通会话的身份执行任务；等待中的启动方看到 `error` 后停止这个会话（第 9.2 节第 10 步）。
5. 工作目录没有任何未过期的启动认领（用户自己启动的 `claude-magpie --bg`）：`st.role = 'unmanaged'`，`next(e)`。

### 9.4 接管已有会话

触发：`candidate` 角色，`classic.SessionStart` 的 `source === 'resume'`，本会话 ID 不在登记表中，第一条输入的消息。

0. 本会话 ID 在 `state/declined.json` 中（用户此前拒绝过接管）：`st.role = 'unmanaged'`，`next(e)`，不再询问。设计规定只在第一次恢复时确认一次（findings“model routing implementation interview”）。
1. 当前模型 `await $.session.model()` 规范化后不是四个架构师候选之一：`$.ui.notice('当前模型 <名称> 不在架构师候选（Opus 5.5、Mythos 5.2、Astra、Sol 6.1）中，这个会话不登记为长期任务')`，`st.role = 'unmanaged'`，`next(e)`。
2. `$.ui.ask`：问题说明接管的后果（登记为长期任务、沿用当前模型与对话历史、接入 Telegram、启用架构师工具限制、本轮结束后转入后台），包含与第 9.2 节相同的项目、Git 与信任信息，并说明选择不接管后这个会话以后恢复时不再询问；选项 `接管`、`不接管`。
3. `不接管`：会话 ID 在 `declined` 锁内写入 `state/declined.json`，`unmanaged`，`next(e)`。Esc 或无法识别：`drop` 并下次重新询问（没有作出回答，不算拒绝）。
4. `接管`：登记任务（`architect.source: 'takeover'`，`owner.sessionId` 为当前 ID），项目根不受信任时 `trust.trustProject(root)`（第 9.2 节第 6 步），按需 `git init`，创建工作副本，`st.role = 'architect'`，注册架构师工具，加上每轮上下文后 `next(e)`，并设置 `st.pendingBg = true`。
5. 本轮 `turn.complete`（主对话，`st.pendingBg`）：`void st.recovery?.then(…)` 后立即返回，钩子不等待（等待一个不是 `$` 调用的 Promise 会计入钩子时限）；启动恢复结束后（`/bg` 之后原进程退出，恢复不能被打断）再写接管认领，`$.session.append` 追加接管标记行，然后 `void $.command.run({ command: 'bg' })`（不等待；实测可行）。
6. `/bg` 生成的副本在 `session.start` 中（角色判定第 5 条）：读取 `$.session.messages({ as: 'api' })`，找到最后一个 `[magpie-tasks takeover task=… claim=…]`，`takeClaim(c => c.id === claimId && c.kind === 'takeover' && c.cwd === st.cwd)`，成功则更新会话 ID（第 7.6 节）并成为架构师。有标记但认领失败（过期、已被取走、工作目录不同）时，原来的前台会话已经结束，用户只能从别处得知：任务改为 `error`（`error` 写明原因），日志 `claim-failed`，`$.ui.notice`（用户 `claude attach` 时可见）并发 Telegram 通知（任务标题、ID、副本的会话 ID 与 `claude attach <shortId>`），角色为 `unmanaged`。没有标记时（用户自己执行的 `/bg`）为 `unmanaged`，不报告。

第 6 步在 `session.start` 中读取对话，是未验证行为 U6。第 0 步按会话 ID 记录拒绝，依赖交互式 `claude-magpie --resume <ID>` 保持会话 ID 不变（探测只确认了 `--bg --resume` 会分叉），场景 E4 检查这一点。

### 9.5 架构师的工具限制

`tool.call` 中，角色为 `architect` 且没有 `e.agentId`（主对话）时执行 `gate.architectDeny`：

| 工具 | 规则 |
| --- | --- |
| `Edit`、`Write`、`MultiEdit` | 路径用 `io.realPath`（文件不存在时取所在目录的真实路径加文件名，方法同类型文档 `$.fs.stat` 的示例）解析后，必须是项目主目录下的 `.planning/findings.md`、`CONTEXT.md`、`.planning/plan-*.md`、`.planning/*.html`（`.planning` 的直接子文件）之一 |
| `NotebookEdit` | 拒绝 |
| `Bash` | 允许两类：只读命令（每个由 `&&`、`||`、`;`、`|` 分开的部分都以 `ls`、`cat`、`head`、`tail`、`wc`、`rg`、`grep`、`find`、`stat`、`du`、`file`、`pwd`、`tree`、`jq`、`sed -n`、`git status|diff|log|show|ls-files|rev-parse|blame|worktree list|branch --list` 开头；不含 `>`、`$(`、反引号、`<(`、`find` 的 `-exec`/`-delete`/`-fprint`、`sed -i`）；html-plan 打包命令 `node <…>/html-plan/runtime/pack.mjs <项目>/.planning/<名>.html --root <项目>` 与 `~/sipeng/plans/publish-plan`（含 `--remove`） |
| 其他工具 | 放行（Read、Grep、Glob、Agent、SendMessage、TaskStop、ToolSearch、WebFetch、WebSearch、Skill、AskUserQuestion，以及 MCP 工具；context-memory 的 `notes_write` 属于此类） |

拒绝理由（英文）说明架构师的职责，并指出改用 Agent 委派实施子代理；写入被拒时列出允许的四类路径。

**架构师工具**（magpie-tasks 在架构师会话中注册，处理在 `architect.ts`，定义在 `tools.ts`；工具结果是给架构师读的英文）：

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `mcp__magpie-tasks__model_route` | `description`、`prompt`（完整说明）、`recommended_model`、`recommended_effort`、`reason`（有推荐模型时必填） | 委派一项工作：Jev 判断匹配的规则与是否需要深入推理，路由表给出模型与强度；有推荐时 Jev 在推荐与路由表的选择之间判断（第 9.6 节“架构师的推荐”）。子代理经中转（第 9.8 节）在任务工作副本中启动，在后台运行；结果写明模型、强度与理由，或没有启动的原因 |
| `mcp__magpie-tasks__task_status` | 无 | 返回任务记录摘要：项目根、工作副本与单独副本路径、各子代理的规则、模型、强度及调整原因、状态、阻碍（ID、描述、诊断与更换次数）、未决决定 |
| `mcp__magpie-tasks__report_outcome` | `agent_id`、`outcome`（`accepted`、`rejected`、`diagnosis`、`diagnosis-redelegate`、`model-change`）、`blocker_id`（`diagnosis`/`diagnosis-redelegate`/`model-change` 时必填：`task_status` 列出的已有阻碍 ID，或 `new`）、`blocker`（`blocker_id` 为 `new` 时必填，一句话描述阻碍）、`notes` | `accepted`：写入 `deliverables`。`rejected`：该代理 `pendingRaises` 加 `acceptance-failed`，记录返工。`diagnosis`：`blocker_id` 为 `new` 时建立阻碍记录（ID 依次为 `b1`、`b2`…），结果中返回新 ID；`diagnoses` 加一。`diagnosis-redelegate`：该代理 `pendingRaises` 加 `diagnosis-redelegate`。`model-change`：`modelChanges` 加一。同一阻碍按 ID 计数，不按描述文字匹配；`blocker_id` 不存在时拒绝并列出已有阻碍。同一阻碍的 `diagnoses` 或 `modelChanges` 已为 1 时再次申报被拒绝，结果要求架构师暂停受影响的工作并与用户讨论，插件同时发 Telegram 通知（决定 `no-progress`）。每轮上下文说明：同一个问题沿用已有 ID，只有确实是另一个问题时才用 `new` |
| `mcp__magpie-tasks__integrate` | `note` | 第 9.10 节：把任务工作副本的改动应用到项目主目录；返回应用的文件或冲突详情 |
| `mcp__magpie-tasks__notify_user` | `kind`（`decision`、`done`）、`text` | 发 Telegram（`notify: true`）；`done` 记录完成时间，任务成为当天的评分候选 |
| `mcp__magpie-tasks__resolve_conflict` | `agent_id`、`decision`（`separate`、`wait`） | 调用 `applyLongDecision` 执行该代理等待中的 `file-conflict` 决定（第 9.9 节第 5、6 步） |

每轮上下文告诉架构师：验收一个子代理的成果后调用 `report_outcome`（通过、退回修复）；安排诊断或依据诊断重新委派、更换实施模型时同样申报，插件据此提高该子代理下次续接的强度并累计阻碍次数。

子代理的写入范围（`gate.subagentWriteDeny`），对路由过且记录了 `worktree` 的子代理生效：`Edit`/`Write`/`MultiEdit`/`NotebookEdit` 的真实路径位于某个 Git 仓库之内时，必须在该子代理的 `worktree` 之内（任务工作副本，或直接修改的任务的项目目录）；位于仓库之外（例如 `/tmp`）的写入放行。日常任务的执行者在调用 `open_project` 之前写入仓库会被拒绝，理由中要求先调用 `mcp__magpie-tasks__open_project`。`CONTEXT.md` 与 `.planning/findings.md` 在任务的工作目录中也拒绝写入（设计记录由架构师写在主目录）。一个已结束的直接修改任务被续接后，若另一个进行中的任务正在直接修改同一项目，它的文件写入被拒绝，理由要求再次调用 `open_project`，插件随之把它转到工作副本（`leaveIfTaken`）。

### 9.6 子代理启动路由（`agent.spawn`）

适用角色：`architect` 与 `router`。`spawn.onAgentSpawn` 按顺序判断：

1. `e.fork`、`e.workflow`、`e.isTeammate`：`next(e)`，保留各自机制。
2. `e.resume`：`next(e)`（续接只能拒绝，不能改写）。续接的判定不依赖这个分支：插件自己用 `$.session.send` 唤醒子代理时是否引发 `agent.spawn` 没有测量，续接统一在 `turn.start` 中判定（第 9.7 节）。
3. `next.origin.plugin === 'magpie-tasks'`（插件自己启动，第 9.8 节）：说明已经确定；模型取说明第一行任务标记中的 `model`，`next({ ...e, model: requestId(model) })`。插件调用 `$.agent.spawn` 时不带 `model`：`$.agent.spawn` 经过 Agent 工具的输入校验，`model` 只接受 `sonnet`、`opus`、`haiku`、`fable`（2026-11-09 实测，完整 ID 被拒绝），`agent.spawn` 钩子改写的模型不受这个限制。
4. 归属任务：
   - 架构师会话：`st.taskId`。
   - Router 会话：说明第一行是 tg-router 的请求头 `[magpie-tasks-request daily chat=<chatId> message=<messageId> worker=<name>]` 时，新建日常任务（`kind: 'daily'`，`owner.kind: 'agent'`，`telegram` 取请求头，`request` 取说明中 `The original message:` 之后的文字）；`e.parentAgentId` 属于某个任务时归该任务；其余（Router 主对话自己发起的委派）`next(e)` 不管理。
5. 解析说明中的控制行（`brief.ts`）：`[model <Magpie 模型 ID>]`、`[model-reason user: …]`、`[model-reason evidence: …]`、`[effort <level>]`、`[review-of agent=<agentId>]` 或 `[review-of model=<id>,<id>]`。Agent 工具的 `model` 参数只接受四个别名，别名以外的模型（Sol 6.1、Astra、Terra 6.1 等）由说明中的 `[model <ID>]` 行指定；两者都有时以 `[model]` 行为准。架构师的每轮上下文与 tg-router 的 `dispatch` 按这个格式写出。
6. 指定模型：说明有 `[model <ID>]` 行或 `e.model !== undefined` 时，没有 `model-reason` 行则返回 `{ deny }`，理由说明用户指定的模型要写 `[model-reason user: <用户原话>]`，架构师自己推荐模型要改用 `model_route`。有理由时选择类型为 `user` 或 `adjusted`：`adjusted`（`[model-reason evidence: …]`）只接受 `model_route` 的调用（`origin` 为 `model-route`），从 Agent 工具来的一律拒绝，理由指向 `model_route`；`adjusted` 的模型须通过 `isAvailable`，`user` 的模型不检查（第 4.6 节）。例外：`e.model === 'opus'`、`e.parentModel` 匹配 `/fable|mythos/i` 且说明中没有 `model-reason` 行时，按没有指定模型处理。这是外层 subagent-opus 对 Fable 或 Mythos 父模型的改写（第 1 节），内层看不到改写前的值（`next.trace` 只列出本钩子之下的环节）；Fable 父模型亲自写 `model: 'opus'` 而不写理由的情况与之无法区分，同样交给规则。代理定义文件中的模型不出现在 `e.model` 中，按规则选择。
7. 判断：`judgeSpawn([{ role: 'user', content: briefForJev(e.prompt) }])`。替代判断也失败时返回 `{ deny: 'magpie-tasks could not judge the routing rule: <原因>' }`。
8. 选择：
   - 指定模型：模型为 `e.model`；强度取 `[effort]` 行，没有时取匹配规则的 `startEffort`，规则也不匹配时拒绝并要求补 `[effort <level>]`。
   - `review-of` 存在，或 `decideRule` 选中 `review-second`：被复核模型取自 `review-of`（`agent=` 时查该代理记录的模型）；缺少时拒绝并要求补 `[review-of …]`。计算 `reviewSecondTarget`，`none` 时拒绝，理由写明排除的模型与没有可用候选，由架构师告诉用户；日常任务改为第 9.11 节的评估流程。
   - `decideRule` 返回规则：`ruleModel(rule, { deep, hard })`，`hard` 为 `isHardWork(judgment.deepP)`：概率达到 `hardYes` 时用规则的 `hardModel`，评估模型代为判断时没有概率，用规则的 `model`；强度为 `startEffort(rule, deep)`。选中 `hardModel` 时，选择理由与路由说明写明概率达到门槛。
   - 没有匹配：架构师会话拒绝，理由写明 Jev 的首选与置信度，并说明可以补充任务条件后重试，或用 `model_route` 推荐模型与强度，由 Jev 判断推荐是否适合这项任务；日常任务的执行者按 `daily-default` 交给 Opus 5.5 执行（medium 起，需要深入推理时 high），不评估，也不等确认（用户决定，2026-11-10）。
9. 工作目录：任务有工作副本时 `cwd` 设为它；长期任务中该子代理有单独副本时设为单独副本。
10. 改写并启动：`prompt = withRouting(e.prompt, marker, extras)`，第一行为任务标记 `[magpie-tasks task=<taskId> role=<agentRole> rule=<ruleId|none> rules=<version> model=<规范化 ID> effort=<level>]`，原说明随后，末尾附加英文的任务规则（工作目录、不做提交和推送、不修改 `CONTEXT.md` 与 `findings.md`、发现写进报告、报告格式与状态行，见第 9.11 节）；`description` 末尾加 ` · <模型名>/<强度>`；`model = requestId(model)`。`const r = await next({ ...e, prompt, model, cwd, description })`。
11. `r.agentId` 存在时写入任务记录的 `agents`，`st.agents.set(agentId, taskId)`，`st.freshSpawn.add(agentId)`，日志 `spawn`；日常任务同时更新 Telegram 索引的 `workers` 与 `agents`。
12. 告知：架构师会话用 `$.session.append` 追加一行给架构师读的说明（模型、强度、规则、理由，是否为替代判断）；日常任务的第一个执行者由 Telegram 发一条路由说明（第 9.11 节）。同一代理续接时不重复。

**架构师的推荐（`model_route`，`route.ts`）。** 架构师用 `mcp__magpie-tasks__model_route` 委派，不能自己指定模型（用户决定，2026-11-10）：

1. `judgeSpawn` 判断说明（与第 7 步相同），`decideSpawn` 给出路由表的选择（`origin` 为 `model-route`）。
2. 没有推荐：直接采用路由表的选择；路由表拒绝时把理由返回给架构师，不启动。
3. 有推荐：推荐模型不在 Magpie 的模型列表中时不启动，返回原因。与路由表选出的模型相同时直接采用。否则问 Jev 一道选择题（`judge.recommendationQuestion`）：选项为路由表的选择（规则、模型、强度）与架构师的推荐；没有匹配规则时为推荐与“都不合适”。Jev 读到的是说明、架构师的理由，以及路由表对两个模型的全部说明（选中它们的规则及证据、替代条目及其限制，例如“只在用户指定时使用”）。
4. Jev 选中推荐且置信度不低于 `ruleConfidence` 时采用推荐：说明末尾加 `[model <ID>]`、`[model-reason evidence: 架构师的理由；Jev 的置信度]`，有推荐强度时加 `[effort]`，再经 `decideSpawn` 得到 `adjusted` 的记录（强度取推荐强度，没有时取匹配规则的强度，规则也不匹配时拒绝）。其余情况采用路由表的选择。这道题只问 Jev：Jev 调用失败时采用路由表的选择，不交给评估模型，避免由某一家的模型在两个模型之间裁决。
5. 经中转（第 9.8 节，`kind: 'spawn'`）启动子代理，返回中转的那一行、路由说明与 Jev 的判断。说明在 Jev 判断后不再改动，启动的就是 Jev 判断过的说明，每次委派只判断一次。

Agent 工具仍可委派：不带模型时按路由表选择；用户亲自指定的模型写 `[model-reason user: …]`。

插件更新新增的工具，到不了更新前建立、之后被恢复的架构师会话：会话恢复时，引擎把恢复前没有的工具作为延迟加载的工具发送（调试日志 `Dynamic tool loading: seeded 1 tool reference(s) to 1 deferred tool(s) the previous process sent`、`1/27 deferred tools included`），而 Magpie 为这次请求写出的工具清单里没有它（2026-11-10，架构师 203a0aff 恢复后调用 `model_route` 得到 `No such tool available`）。新建的架构师会话在初始工具清单中就有它（同日 E3 环境实测）。

### 9.7 思考强度（`turn.step`）

```ts
on('turn.step', async function* ($, e, next) { … })
```

续接判定在 `turn.start` 中（`spawn.onTurnStart`）：子代理的每一轮运行开始一个回合，`e.text` 在第一轮是启动说明，在之后的轮次是唤醒它的消息（类型定义 `TurnStartInput.text`）。`e.agentId` 在 `st.agents` 中时：在 `st.freshSpawn` 中则是第一轮，从集合中删除；否则是续接，`st.pendingReask.set(agentId, e.text)`。由第 9.6 节第 11 步加入 `freshSpawn` 的只有本进程启动的子代理，所以架构师会话恢复后从记录载入的子代理，下一轮一定按续接处理。这一判定不依赖 `agent.spawn` 的 `resume` 分支，也覆盖模型用 SendMessage、tg-router 的追问和插件自己的唤醒三种来源；`turn.start` 能否看到插件唤醒的子代理由 U10 判定。

- `e.agentId` 不在 `st.agents` 中：`yield* next(e)` 原样传递（架构师、Router 主对话与其他子代理交给 JEV 或保持原值）。
- `e.index === 0`：`st.pendingReask` 有该代理时，`judgeDeep(subagentDialogue(await $.session.messages({ agentId, as: 'api' })))`，按第 5 节计算续接强度。之后无论有没有续接消息，都依次应用 `st.pendingRaises` 中该代理的提高原因（验收不通过与诊断后重新委派的提高，第 5 节），写入记录与日志，清空两项。
- 其余：用记录中的当前强度，`yield* next({ ...e, effort: clampEffort(model, effort) })`。

安装后 magpie-tasks 位于 JEV 之内，它设置的强度到达请求（实测）；它只改写带任务标记的子代理请求，其余原样传递。

强度条（`src/band.ts`，输入框正上方的一行）：路由过的子代理每次请求时记下请求的模型（`e.model`）、这次请求实际带的强度和规则 ID；强度钩子出错时请求按引擎原值发出，强度条记引擎的强度并写 `engine effort`。`turn.complete` 时标记 `done`，下一轮运行开始时去掉。从任务列表打开这个子代理的界面时，`ui.render`（`AbovePrompt`）画一行，例如 `Opus 5.5 · ◆ magpie-tasks · medium → HIGH · daily-default`：模型用路由表中的名称，强度按变化的先后排列，当前的一个大写，超过六个时只显示最后五个；换了模型时重新开始记录。JEV 在本插件之外，同一时刻只有一层能画这一行：JEV 对带任务标记的子代理调用 `next(e)`，把这一行交给本插件，主对话与其他子代理的强度条由 JEV 画。强度条只存在本进程的内存中，最多 64 行，超出时先删除已结束的子代理的行。

### 9.8 中转：启动与唤醒子代理

插件自己启动子代理（日常任务的执行者、验收、诊断、接手者）与唤醒已完成的子代理（`$.session.send({ to: { agentId } })`）都经过 `daily.relay(ctx, req)`：请求先写入 `st.relay` 与任务记录的 `pendingRelays`，然后在调用它的钩子中直接执行，执行成功后从 `pendingRelays` 删除，并在会话中显示一行（`magpie-tasks: 已启动<角色>子代理（<模型>/<强度>）` 或 `magpie-tasks: 已把<说明>交给子代理 <名字>`）；执行出错时错误交给调用它的流程钩子按第 8 节报告，请求留在 `pendingRelays` 中。

- `kind: 'spawn'`：`const r = await $.agent.spawn(args)`，`args` 是 `req.args` 去掉 `model`（第 9.6 节第 3 步由 `agent.spawn` 钩子按任务标记设置模型）。第 9.6 节第 11 步的登记在这里完成：`req.agent` 加上 `r.agentId` 写入任务记录的 `agents`，`st.agents.set(agentId, taskId)`，`st.freshSpawn.add(agentId)`，日志 `spawn`，日常任务同时更新 Telegram 索引。子代理的 `turn.start` 可能早于 `$.agent.spawn` 返回，此时按说明第一行的任务标记识别它（`spawn.turnStarted`）。
- `kind: 'wake'`：`req.raises` 加入该代理的 `pendingRaises`（记录与 `st`），然后 `await $.session.send({ to: { agentId: req.agentId }, text: req.message })`，日志 `relay`。

直接执行的依据是 U3 的对照与 U10（第 11 节，2026-11-09）：插件从主对话的 `turn.complete` 启动的子代理，以及从 `prompt.submit`、`turn.complete`、`tool.call` 唤醒的子代理，插件自己的 `turn.start`、`turn.step`、`tool.call`、`turn.complete` 都能看到；`$.prompt.submit` 在 `prompt.submit` 钩子中被宿主拒绝（`prompt.submit: called from a prompt.submit hook, it would wait on the turn this hook is holding`），从 `prompt.submit` 中排定的定时器提交的消息也不经过本插件的 `prompt.submit` 钩子，所以用插件提交的消息中转的做法在 Router 回复与架构师收到的决定标记这两条路径上不可用。启动只在 `turn.complete` 与 `prompt.submit` 中进行（第 9.11、9.16 节的启动都在这两处）；在 `tool.call` 或 `turn.step` 中启动的子代理，发起启动的那个钩子看不到它的同名事件（接口实测报告），本插件没有从这两处启动的流程。

本节适用于第 9.9 节第 5、6 步，第 9.11 节的验收、诊断、接手、验收不通过、补状态行、诊断结论与决定的执行，第 9.16 节的接手与“等待”后继续。

### 9.9 工作目录、工作副本、文件冲突与单独副本（工作包 D）

任务在哪里修改项目（`workspace.ts`，用户 2026-11-12 决定：工作副本只在有并行任务时使用）：

- `placeTask(taskId, root)` 在项目锁（与整合相同的 `project-<fnv1a64(目录)>`）内判断：没有其他进行中（不是 `done` 或 `abandoned`）的任务在直接修改同一目录时，任务直接修改项目目录（`direct`）；在 Git 仓库中同时用 `snapshotBase` 为当时的目录内容做基线提交 `refs/magpie-tasks/<taskId>/base`，用来区分任务自己的改动。已有任务在直接修改时，后来的任务得到工作副本（`createWorktree`，下文）。不是 Git 仓库的目录总是直接修改，`direct.baseRef` 为空，没有差异，任务的改动是子代理用文件工具改过的文件（`filesTouched`）；插件从不建立仓库。
- `settleDirect(taskId)`：直接修改的任务的结果在项目目录中已经存在，记为整合 `in-place`（文件为基线到当前目录的差异，或文件工具改过的文件），基线移到当前目录内容，下一次只记之后的改动。
- `noteChange`：一个任务的改动进入某个目录（工作副本整合或 `settleDirect`）后，其他直接修改这个目录的任务在 `alsoChanged` 里记下这些文件；它们的差异统计据此注明哪些文件也被别的任务改过。差异同样会带上用户在这段时间里在项目目录中的修改，验收说明写明这一点。
- `leaveIfTaken(taskId)`：已结束的直接修改任务被续接时，若另一个进行中的任务正在直接修改同一目录，删除它的基线引用，按当前目录内容建立工作副本，任务转为工作副本模式。

`git.ts`：

```ts
export function repoRoot(io: Io, dir: string): Promise<string | null>
export function snapshotBase(io: Io, repo: string, ref: string, from: string): Promise<{ baseCommit: string; baseRef: string }>
export function dropBase(io: Io, repo: string, ref: string, commit: string): Promise<void>
export function snapshotTree(io: Io, dir: string, tmpIndex: string): Promise<string>
export function snapshotCommit(io: Io, repo: string, tree: string, parent: string | null, message: string): Promise<string>
export function createWorktree(io: Io, repo: string, path: string, ref: string, from: string): Promise<{ baseCommit: string; baseRef: string }>
export function removeWorktree(io: Io, repo: string, path: string): Promise<void>
export function diffSince(io: Io, dir: string, base: string, tmpIndex: string): Promise<{ patch: string; tree: string; files: string[] }>
```

创建工作副本（`from` 为项目主目录，或长期任务的工作副本以建立单独副本）：

1. `T = snapshotTree(from)`：`GIT_INDEX_FILE=<tmp> git -C <from> read-tree HEAD`（仓库没有提交时省略），`GIT_INDEX_FILE=<tmp> git -C <from> add -A`，`GIT_INDEX_FILE=<tmp> git -C <from> write-tree`，删除临时索引。用户的索引和工作区不变；未提交和未跟踪（未被忽略）的文件都进入快照。
2. `B = snapshotCommit(T, parent = HEAD 或无)`：`git commit-tree <T> [-p HEAD] -m 'magpie-tasks base <taskId>'`，作者用户的 Git 身份。
3. `git update-ref refs/magpie-tasks/<taskId>/base <B>`（单独副本为 `refs/magpie-tasks/<taskId>/<agentId>/base`）。提交对象只挂在插件自己的引用下，不在任何分支上，用户分支没有新提交。
4. `git -C <repo> worktree add --detach <path> <B>`。

被 Git 忽略的文件（例如 `node_modules`）不进入工作副本，子代理说明中写明需要时在工作副本中安装依赖。

文件冲突（长期任务，多个实施子代理共用任务的工作目录：工作副本或直接修改的项目目录），`conflict.ts`：

```ts
export function touchedPaths(tool: string, input: Record<string, unknown>): string[]           // Edit/Write/MultiEdit/NotebookEdit 的 file_path
export function porcelainChanged(before: string, after: string): string[]                         // 两次 git status --porcelain=v1 -z 的差
export function findConflict(touches: Map<string, Set<string>>, agentId: string, path: string, running: Set<string>): string | null   // 返回冲突方 agentId
export function isCheckCommand(cmd: string): boolean                                               // 与 JEV 相同的检查命令判定
```

`architect.ts` 的处理（`tool.call`，子代理属于本任务且在工作副本中）：

1. 写入前：`touchedPaths` 的每个路径，`findConflict` 找到另一个仍在运行、改过同一文件的子代理时，暂停后来的一方（启动时间较晚者）：本次调用返回 `{ deny }`，理由要求它停止修改、在回答中说明进度并结束本轮；代理记录 `state: 'paused'`，`pausedFor` 为新决定。
2. Bash 调用：调用前后各取一次工作目录的 `git status --porcelain=v1 -z`（不是 Git 仓库时不取），差异记为该代理改过的文件（并发时可能记到多个代理名下，判定按保守方向处理）。
3. 检查命令失败（`isCheckCommand` 且结果为错误）时，若自该代理上一次运行同一命令以来，另一个运行中的代理改过文件，按冲突处理，暂停后启动的一方。
4. 新决定（`kind: 'file-conflict'`）：问题与选项 `单独副本`、`等待前一方`（不是 Git 仓库时只有 `等待前一方`）。通知两处：`$.session.append` 给架构师一行说明（架构师可以与用户讨论后调用 `resolve_conflict`），Telegram 发一条问题（索引 `kind: 'long'` 加 `decisionId`）。用户在 Telegram 的回复由 Router 判断后交给架构师会话执行（第 9.12 节），因为被暂停的子代理、`st.touches` 与 `pausedFor` 都在架构师会话中，Router 的 `$.session.send({ to: { agentId } })` 送不到别的会话的子代理。
5. `单独副本`（`applyLongDecision`，由 `resolve_conflict` 或 Telegram 回复触发）：`createWorktree(from = 任务的工作目录)` 建立单独副本，该代理记录的 `worktree` 改为单独副本，`state` 改回 `idle`，清除 `pausedFor`，决定记为已解决；经中转唤醒它（`kind: 'wake'`，第 9.8 节），消息告诉它新的工作目录（续接不能改 `cwd`，写入范围由第 9.5 节的检查保证，Bash 需要先 `cd`）。它完成后（`turn.complete` 且报告状态为完成）用 `integrate(source = 单独副本, target = 任务的工作目录)` 合入，冲突时同样建立决定并通知。与它冲突的前一方仍在运行时，合入推迟到前一方 `turn.complete`（决定的 `data.merge` 记为 `waiting`，日志 `merge-deferred`，架构师收到一行说明）：先合入时，仍在运行的前一方看到自己负责的文件被改，会把它改回自己的版本（2026-11-09 E7 实测），合入的改动随之丢失。
6. `等待前一方`（`applyLongDecision`）：决定记为已解决，被暂停者保持 `paused`。前一方 `turn.complete` 时，经中转唤醒被暂停者，告诉它继续，记录恢复。

### 9.10 整合（`integrate.ts`）

```ts
export type IntegrationResult = { status: 'applied'; files: string[]; newBase: string } | { status: 'empty' } | { status: 'conflict'; files: string[]; detail: string }
export function integrate(io: Io, reg: Registry, a: { taskId: string; repo: string; source: string; target: string; baseRef: string }): Promise<IntegrationResult>
```

1. 取项目锁 `project-<fnv1a64(realpath(repo))>`，同一项目的整合排队进行。
2. `diffSince(source, base)`：在 `source` 中用临时索引得到当前树 `T`，`git diff --binary <base> <T>` 得到补丁与文件列表。补丁为空返回 `empty`。
3. `git -C <target> apply --binary --check -`（补丁从标准输入传入）。失败返回 `conflict`，`detail` 为 stderr，`files` 为补丁涉及的文件。
4. 日志 `integration-start`（`target`、`base`、新树 `T`、文件列表），然后 `git -C <target> apply --binary -`：只改工作区，不动用户的索引；成功后 `snapshotCommit(T, parent = base)` 得到新基线，`update-ref` 移动 `baseRef`，下一次整合只应用之后的改动。
5. 记录 `deliverables[].integration` 与日志 `integration`（与 `integration-start` 用同一个树 `T` 对应）。只有 `integration-start` 没有对应 `integration` 的整合，就是开始了而不知道是否完成的整合（第 9.13 节）。

项目锁的等待上限是 120 秒，等待用 `wait`（第 7.2 节），在 `tool.call`（`integrate` 工具）与 `turn.complete`（日常任务验收通过）中等待也不会使钩子超时。

触发：长期任务由架构师验收后调用 `integrate` 工具；日常任务在验收通过后由插件自动调用，或在用户确认后调用（第 9.11 节）。冲突时任务进入 `waiting-user`，建立 `integration-conflict` 决定，Telegram 与架构师（长期任务）收到冲突文件列表与 stderr 摘要。插件不做 Git 提交和推送；整合结果留在用户的工作区中，由用户决定是否提交。

### 9.11 日常任务（工作包 F）

消息顺序（Telegram 中用户看到的）：tg-router 的确认 `收到：…` → magpie-tasks 的路由说明 → 进度卡片（tg-router，超过 30 秒时） → 执行者的回答（tg-router 在执行者 `turn.complete` 时发出，早于验收） → 需要用户决定时 magpie-tasks 的问题（整合冲突、返工后的改动是否整合）；验收通过与整合不发消息。终端输入的任务（chat `tui`）没有 Telegram 消息，magpie-tasks 的说明与报告用 `$.ui.notice` 显示在 Router 窗格中。

**派发与路由。** Router 调用 tg-router 的 `dispatch`，tg-router 在 claude-magpie 中以请求头开头的说明启动 worker（第 10.1 节）。magpie-tasks 在 `agent.spawn` 中新建日常任务并路由（第 9.6 节）。匹配规则时，Telegram 发路由说明（回复原消息，静音）：`模型：<名称> · <强度> · 规则 <id>（Jev 置信度 0.82；需要深入推理）`，替代判断时加“由评估模型代为判断”，指定模型时写“用户指定：<理由>”；消息写入索引 `kind: 'magpie'`。

**执行者的说明。** 第 9.6 节附加的任务规则中包括：

- 需要修改某个项目时，先调用 `mcp__magpie-tasks__open_project { project: <绝对路径> }`，此后只在返回的目录中修改（Bash 先 `cd` 到该目录）：没有其他任务直接修改这个项目时就是项目目录本身，否则是工作副本；不修改项目的任务不需要调用。
- 回答末尾的状态行：`状态：已完成`、`状态：需要用户决定` 或 `状态：受阻：<一句话说明阻碍>`。完成时在状态行之前写 `验证：`，每行一条实际运行过的验证命令及结果。

**`open_project` 工具**（执行者调用，`daily.onOpenProject`）：

1. `project` 必须是存在的绝对路径；项目根为它所在仓库的顶层目录，不是仓库时为它自己。
2. 任务还没有工作目录时按 `placeTask` 确定（第 9.9 节），写入任务的 `project` 与 `direct` 或 `worktree`，该代理记录的 `worktree` 与 `cwd` 同步设置。任务已有工作目录时，不同项目返回错误（一个任务只改一个项目），同一项目先经 `leaveIfTaken` 判断是否转到工作副本，再返回当前目录。
3. 返回目录与说明：直接修改时写明改动立即在项目目录中、验收在之后；工作副本时写明依赖安装、只在此目录修改，以及是哪个任务在直接修改项目。

**执行者完成**（`turn.complete`，代理为任务当前负责的执行者）：

1. 用 `parseStatus` 取状态与验证命令，写入 `reports`。
2. `已完成`：先判断这一轮的成果是否值得独立检查（`judgeCheck`，实现方案第 2、7 节）。Jev 回答一个判断题，材料是三条消息：用户这一轮的话与这一轮的工具调用次数（`endedTurn` 从执行者的对话中取：最后一条不属于后台任务事件、也不是插件自己发给它的消息，首轮是说明中用户的原话；工具调用从这一轮开始的那条消息之后计数）、执行者的回答（上一条报告是补状态行之前的回答时两者拼接）、等待整合的改动统计或“没有改动”。概率不低于 `CHECK_YES`（0.3）时验收；Jev 失败时由评估模型回答同一个问题。判断写入 `deliverables` 最后一项的 `check` 与日志 `check`。2026-11-11 用当天 20 次验收的真实记录测量（`bun eval/check-eval.ts`）：4 次不通过的验收为 0.65 到 0.98，其余 10 次工具调用 7 到 88 次的为 0.54 到 0.98；6 次工具调用 0 到 5 次的（对话、交还、“合并吧”“推吧”“重装”）为 0.01 到 0.07。
   - 不需要验收：有改动时直接整合；任务 `done`，不发消息。
   - 需要验收：建立验收子代理。规则 `review`（Opus 5.5 / medium，深入推理时提高），说明包含：任务标记、原始请求与全部追问、执行者最后一次回答、执行者报告的验证命令；要求重新运行这些命令，对照原始请求检查结果，末行 `验收结论：通过` 或 `验收结论：不通过`，不通过时每个问题写位置、触发条件和依据。说明按有无改动分两种（`acceptanceBrief` 的 `change` 为 `null` 即为第二种）：
     - 任务有工作副本且 `diffSince` 不为空：`cwd` 为工作副本，另附 `git diff --stat` 与补丁路径（写到 `<stateDir>/tasks/<id>.patch`），并要求检查改动范围。
     - 没有改动（只给出回答的任务，或执行者没有修改项目）：`cwd` 为 Router 的工作目录，说明写明没有需要整合的改动，要求核对回答是否回应了请求、事实与数字能否用执行者报告的命令或原始材料复核、没有运行验证时指出这一点。

     通过中转启动（第 9.8 节），名字 `<worker>-acc<n>`。
3. `需要用户决定`：任务 `waiting-user`（回答已由 tg-router 发出）。
4. `受阻`：进入诊断（下文）。
5. 没有状态行：任务有改动时经中转唤醒它，请它补一行状态（每个回合最多一次），日志记 `status-missing`；没有改动时视为 `需要用户决定`。

**验收子代理完成**：`parseVerdict`。

- 通过且有改动：`integrate(source = 工作副本, target = 项目主目录)`。`applied` 或 `empty`：任务 `done`，不发消息；`conflict`：建立决定并报告冲突文件，任务 `waiting-user`。
- 通过且没有改动：任务 `done`，记录完成时间（评分候选），不发消息。
- 不通过：经中转唤醒执行者（`raises: ['acceptance-failed']`），送去验收意见并要求修复后重新报告，同时说明用户已经读过上一次回答、新回答要写明哪些说法有误和正确的内容；任务保持 `running`，`deliverables` 最后一项记录 `acceptance.pass = false`，日志 `acceptance`。执行者再次以 `已完成` 结束时不再验收（只检查一次），该项记录 `acceptance.fixed`：
  - 没有改动：修复后的回答已由 tg-router 发出，任务 `done`，不发消息。
  - 有改动：Telegram 询问是否整合这份返工过的改动（不附验收意见，执行者的回答已经写明更正了什么），消息写入索引 `kind: 'decision'`（`fix-confirm`，决定 ID 记入 `acceptance.fixed.decisionId`），任务 `waiting-user`。用户回复经 `approve` 判断：同意则整合，回复整合结果，任务 `done`；拒绝则记录并保持工作副本；无法判断时请用户明确回答。这个问题未答复期间，执行者之后的 `已完成` 只记录报告，不验收、不整合、不再询问；用户拒绝之后执行者又完成一轮时，带着当时的改动再问一次。

**执行者得知结果。** 验收通过与整合不通知用户，执行者从下一条到达它的消息得知：`outcomeNote` 按 `deliverables` 最后一项给出一行 `[magpie-tasks note] …`（改动已整合到主目录及文件列表、是否经过验收；整合冲突；验收通过且没有改动；返工后的改动正在等用户答复或被用户拒绝），`withOutcome` 把它附在消息末尾。经过的消息有两类：Router 主对话或 tg-router 发给该任务执行者的消息（`session.send` 钩子），以及用户回复 magpie-tasks 的消息后转给执行者的追问（`executorReply`）。送达后在该项记 `told`（已告知的结果）并写日志 `outcome-told`，同一结果只告知一次；没有验收也没有改动的回答、已经用验收意见唤醒执行者的不通过，不告知。判断是否验收时，`asked` 先去掉这一行（`stripOutcomeNote`）。执行者的任务规则写明：改动在回合结束后由插件应用到主目录，用户不会收到通知，下一条消息后的说明行会写明结果，用户再次要求时提交。

**执行者不能按规则直接确定：评估与确认。** 用户指定的模型没有规则给出的强度、规则的模型不在 Magpie 的模型列表中，或独立复核缺少条件时，日常任务走这个流程；没有匹配规则的请求按 `daily-default` 直接执行（第 9.6 节）。

1. `agent.spawn` 中把这次启动改为评估子代理（规则 `route-assessment`，Mythos 5.2 / high 起），名字与 worker 名相同，tg-router 把它当作任务的 worker。说明：原始请求、路由表全部规则与替代候选的摘要（来自规则文件）、要求给出推荐模型、强度、任务匹配理由与证据限制，末行 `推荐模型：<Magpie 模型 ID> / <强度>`；并说明当用户回复确认或指定模型时，回答末行写 `选模确认：<模型 ID> / <强度>`，拒绝时写 `选模确认：取消`。
2. 它的回答由 tg-router 发到 Telegram；任务 `waiting-user`，决定 `route-confirm`。
3. 用户回复评估回答（tg-router 把回复送到评估子代理，续接）。评估子代理以 `选模确认：…` 结束时（`turn.complete`），插件通过中转启动执行者：模型为确认的模型，说明加 `[model-reason user: 用户确认了评估推荐：<用户原话>]`，选择类型 `assessment-confirmed`，名字 `<worker>-x<n>`；更新索引 `workers[worker].ownerAgentId` 与 `agents`，tg-router 此后把追问送给执行者、把执行者的回答发到原任务下。记录这次例外与确认内容。

**没有进展：诊断与更换。**

1. 执行者以 `受阻：<说明>` 结束：先判定这是哪一个阻碍（`matchBlocker`）。任务没有阻碍记录时直接建立 `b1`。已有记录时调用 `judgeBlocker`（第 6.2 节的 `blocker` 选择题），输入为各阻碍的诊断历史与这次的报告；Jev 不可用时按第 6.2 节由评估模型代为判断。选中 `new` 且置信度不低于 `ruleConfidence` 时建立新阻碍（`b2`、`b3`…），否则归入概率最高的已有阻碍：判断不确定时按同一阻碍计数，更早交给用户，不会多做一次自动诊断。判定结果（提供方与置信度）写入阻碍历史的 `match`。同一阻碍按 ID 计数，第一个阻碍解决后出现的另一个阻碍有自己的一次诊断与一次更换。
2. 该阻碍 `diagnoses` 已为 1（同一阻碍最多一次独立诊断，那次诊断给出的模型更换也已执行或被拒绝），或没有合适候选时：直接 Telegram 报告用户（证据与阻碍），任务 `paused`，决定 `no-progress`。
3. 否则 `diagnoses` 加一，启动诊断子代理（规则 `review`，独立上下文）：说明包含原始请求、追问、执行者全部报告、该阻碍的 ID 与描述、工作副本路径与差异；要求末行写 `诊断建议：继续原代理`、`诊断建议：更换模型 <模型 ID> / <强度>` 或 `诊断建议：交给用户`，并给出依据。
4. 诊断完成：
   - `继续原代理`：经中转唤醒执行者（`raises: ['diagnosis-redelegate']`），送去诊断结论。
   - `更换模型`：该阻碍 `modelChanges` 已为 1 时报告用户；`substituteAllowed(rule, model, effort)` 为自动候选时（包括规则自己写明的模型在其提升顺序内的档位），通过中转启动新执行者（`[model-reason evidence: 诊断 <agentId> 建议：…]`，强度为建议强度再提高一级，选择类型 `diagnosis`；`repo-alt` 的档位由诊断建议代替架构师的选择，理由中写明），交接原始请求、追问、前一执行者的报告与工作副本，`modelChanges` 加一，前一执行者记录 `replacedBy`，更新索引负责人；不是自动候选时建立 `model-change-confirm` 决定请用户确认。
   - `交给用户`：Telegram 报告，任务 `waiting-user`。
5. 次数随任务记录保存，更换代理后继续累计。

**日常任务的决定**（`applyDailyDecision`，在 Router 会话中执行，日常任务的子代理都属于 Router 会话）：`integration-conflict` 与 `fix-confirm` 经 `approve` 判断；`route-confirm` 由评估子代理的续接处理（上文）；`model-change-confirm` 与 `model-unavailable` 中，用户同意建议的模型或说出另一个模型时，通过中转启动接手者，说明加 `[model-reason user: <用户原话>]`，选择类型 `user`，用户选择等待时任务保持 `waiting-user`，之后的“继续”经中转唤醒原执行者；`no-progress` 的回复经中转送给当前执行者，任务改回 `running`。无法判断时请用户明确回答。

### 9.12 Telegram 连接（工作包 G）

**令牌与聊天。** `telegram.botToken(io, opts.telegramStateDir)` 读取 `<dir>/.env` 中的 `TELEGRAM_BOT_TOKEN`；后台会话没有 `TELEGRAM_STATE_DIR` 环境变量，所以目录来自插件配置。读取失败时抛出错误，发送处把错误写入任务日志并 `$.ui.notice`。长期任务从窗口开始时，通知聊天为 `opts.telegramChatId`，为空时取 `<dir>/access.json` 中 `allowFrom` 的唯一一项；不是一项时抛出错误，说明需要配置 `telegramChatId`。只调用 `sendMessage`，不轮询，与通道服务器不冲突。请求经 `curl --config -` 发出，网址与正文写在标准输入的配置中：Bot API 把令牌放在网址路径里，引擎的调试日志记录每次 `$.http.fetch` 的完整网址（2026-11-10 E9 实测，架构师会话总有调试文件，第 9.13 节），而 `$.process.run` 只记录命令名与参数个数。tg-router 的发送与编辑用同样的方式。

```ts
export function botToken(io: Io, stateDir: string): Promise<string>
export function send(io: Io, opts: Options, chatId: string, text: string, replyTo?: number, notify?: boolean): Promise<number>   // 返回 message_id；失败抛出
export function clip(text: string, max?: number): string
export function parseChannelTag(text: string): { chatId: string; messageId: number; replyTo?: number; imagePath?: string; body: string } | null
export function defaultChat(io: Io, opts: Options): Promise<string>
```

**Router 工具**（magpie-tasks 在 Router 会话中注册；tg-router 的工具限制放行它们，第 10.1 节）：

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `mcp__magpie-tasks__forward_long` | `chat_id`、`message_id`、`task` | 把一条消息转给长期任务的架构师 |
| `mcp__magpie-tasks__recommend_architect` | `task`（worker 名或任务 ID） | 返回架构师推荐（模型、理由、证据限制），供 Router 与用户讨论 |
| `mcp__magpie-tasks__promote_task` | `worker`、`model`、`user_confirmation` | 用户确认后把日常任务转为长期任务 |

**Router 的上下文。** magpie-tasks 在 Router 的 `prompt.submit` 中，对频道消息与终端消息追加一段英文上下文：未结束的长期任务列表（标题、任务 ID、架构师模型、状态、最近活动时间），以及规则：消息继续某个长期任务时调用 `forward_long`；日常任务的 worker 交回需要持续设计讨论的工作时，先 `recommend_architect`，与用户讨论，用户确认模型后 `promote_task`；用户在消息中明确要求某个模型时，`dispatch` 带 `model` 与 `model_reason`（用户原话）。

**转交消息给架构师**（`router.deliverToArchitect`）：

1. 文本：第一行 `[magpie-tasks telegram chat=<chatId> message=<messageId>]`（转交决定的回答时加 ` decision=<id> answer=<值>`），随后是去掉频道标签属性的正文，有图片时加一行 `image_path: <路径>`。终端消息（chat `tui`）没有这一行，回答留在架构师窗口。
2. `$.session.send({ to: { sessionId } })`。`isDelivered` 为真：Telegram 回复“已转给长期任务「<title>」的架构师。”（静音），消息写入索引 `kind: 'long'`。
3. 未送达：`launch.listAgents()`（`claude agents --json --all`）找到该会话。`pid` 为空（已停止）：`io.run([opts.claudeBin, '--bg', '--resume', <完整会话 ID>, text], { cwd: 项目根 })`，不带任何其他参数，沿用会话保存的启动参数与原会话 ID（实测规则）。仍有进程却未送达，或会话不在列表中：Telegram 报告“无法把消息交给架构师”，任务日志记录，决定 `interrupted`。

`$.session.send` 能否投递给空闲的后台会话是未验证行为 U2。

**架构师会话中的接收与回复**（`architect.ts`）：

消息正文：`$.session.send` 送达的消息带引擎的同伴包装，`e.text` 是“Another Claude session sent a message:”一行、`<cross-session-message …>` 元素和元素后的一段说明，元素内容不转义（2026-11-10 E9 实测）；正文取元素内容。`claude --bg --resume` 唤醒时的第一条消息没有包装，正文就是全文。

1. `prompt.submit`：消息正文的第一行是 Telegram 转交标记时（按文本判断，不看来源），`st.replyTargets.push({ chatId, messageId })`，加一段上下文说明这条消息来自 Telegram、最终回答会以纯文字发回（结论在前，不用 Markdown 标记）；同时把正文写入任务 `followUps` 并做反馈判断（异步，不阻塞）。任务处于 `error` 时改回 `running`（第 8 节）。
   标记带 `decision=<id> answer=<值>` 时（Router 已判断出用户对决定的回答，见下文“回复的路由”），在模型看到消息之前调用 `applyLongDecision` 执行，与架构师调用 `resolve_conflict` 走同一个处理函数；执行结果作为一行上下文告诉架构师（例如“决定 <id> 已按用户回复执行：单独副本 `<路径>`”），用户原话照常交给架构师。决定已经解决（架构师先调用了 `resolve_conflict`）时不再执行，上下文说明已解决的结果。`answer=unclear` 时不执行，上下文请架构师向用户确认后调用 `resolve_conflict` 或相应工具；例外是 `model-unavailable` 与 `model-change-confirm`，它们的决定在这里记为已解决、答案为用户原话，由架构师按原话安排接手的委派（第 9.16 节）。
2. 主对话 `turn.complete`：`st.replyTargets` 非空时，`reason === 'answer'` 把 `clip(e.answer)` 发回（回复最早的一条），其他结束原因发一行状态（被中断、出错）；发出的消息写入索引 `kind: 'long'`；清空回复目标。
3. 同一回合中途送达的消息（`e.turnId` 存在）也加入回复目标，由该回合的回答一起答复。

**回复的路由**（Router 会话的 `prompt.submit`，magpie-tasks 位于 tg-router 之内）：

1. tg-router 先处理：回复 tg-router 自己记录的消息时送给 worker 并 `drop`；其余交给内层。
2. magpie-tasks 解析频道标签：
   - `reply_to` 在索引中为 `long` 且没有 `decisionId`：转给架构师（上文），`drop`。
   - 为 `long` 且带 `decisionId`（长期任务的决定）：Router 按决定类型判断回答（`file-conflict` 用 `conflict_choice`；`integration-conflict`、`fix-confirm`、`no-progress`、`interrupted` 用 `approve`；`model-unavailable` 与 `model-change-confirm` 的回答可能是用户说出的模型名，不做判断，一律记为 `unclear`，由架构师读用户原话后安排；判断失败时由评估模型代为判断），把结果写进转交标记 `[magpie-tasks telegram chat=… message=… decision=<id> answer=<separate|wait|approve|reject|unclear>]`，再按上文转给架构师，`drop`。决定在架构师会话中执行：被暂停的子代理、`st.touches` 与 `pausedFor` 都在那里，`$.session.send({ to: { agentId } })` 只能送达本会话的子代理。架构师会话未运行时，转交按上文第 3 步恢复会话，标记随第一条消息到达。
   - 为 `magpie`：送给 `workers` 中该任务当前负责代理（`$.session.send({ to: { agentId } })`，这里已经在 `prompt.submit` 中，与中转的位置相同；文本用 tg-router 的追问格式 `Telegram 追问（message_id=X）：…`），`drop`。
   - 为 `decision`（日常任务的决定）：Router 会话执行 `applyDailyDecision`（第 9.11 节），在 Telegram 确认，`drop`；无法判断时请用户明确回答。
   - 决定的执行者按任务负责人区分：`owner.kind === 'session'`（长期任务）在架构师会话中执行，`owner.kind === 'agent'`（日常任务）在 Router 会话中执行。日常任务转为长期任务后，未解决的决定随任务转给架构师，索引中这些消息改为 `long` 加 `decisionId`。
   - 为 `rating`，或文字为 `评分 N`：第 9.14 节，`drop`。
   - 其余：`next`，带上长期任务列表上下文。

**主动通知。** 插件发现的事件直接发 Telegram（`notify: true`）：文件冲突、整合冲突、没有进展而暂停、中断后无法自动恢复、模型不可用（第 9.16 节）、认领失败与插件流程出错（第 8 节）、context-memory 归档失败。架构师判断的事件由它调用 `notify_user`：`kind: 'decision'`（关键设计变化等需要用户决定的事）或 `kind: 'done'`（任务或明确成果完成，任务记录完成时间并成为评分候选）。普通进展不推送。

**日常任务转为长期任务**（`promote_task`）：

1. 检查：`model` 是四个架构师候选之一，`user_confirmation` 非空（用户确认的原话）。
2. 任务 `kind` 改为 `long`，保留任务 ID、追问与 Telegram 关联；工作副本沿用（没有时为项目创建，项目未知时不建，由架构师之后处理）。
3. 交接消息：原始请求、全部追问、执行者各次报告、验收与诊断记录、工作副本路径、已确认与未决事项，末尾加 `[magpie-tasks architect task=<id> worktree=<路径>]` 与架构师说明。
4. 启动认领并 `launchArchitect`（`cwd` 为项目根；没有项目时为 `$HOME`）。
5. 索引：`workers[worker].long = true`，该任务的全部消息写入 `messages` 为 `long`；tg-router 此后把这些回复交给内层（第 10.1 节）。
6. Telegram 告诉用户“已转为长期任务，架构师 <模型>：claude attach <shortId>”。

### 9.13 启动恢复（`recovery.ts`）

触发：`candidate` 与 `router` 会话的 `session.start`（即 `claude-magpie` 或 `claude-telegram` 启动时），在 `recovery` 锁内执行；`state/recovery.json` 中上次运行不到 10 分钟时跳过。`candidate` 会话在第一条消息后结束前台进程或转入后台，这两步都先等待 `st.recovery`（第 9.1 节第 4 步），恢复中的 `claude --bg --resume` 不会被打断。

1. `listAgents()` 一次，建立会话 ID → 行的映射。
2. `state` 为 `starting` 且 `createdAt` 早于 10 分钟（启动认领的有效期）的任务：从未被认领，启动方已经不在。任务改为 `error`（`error: 'never claimed'`），日志 `claim-failed`，Telegram 报告（标题、ID、项目根）。`error` 状态的任务不恢复，也不在每次启动时重复报告。
3. 对每个 `state` 为 `running`、`waiting-user`、`paused` 的长期任务：
   - 行存在且 `pid` 不为空：仍在运行，不处理。
   - `waiting-user`：保持等待。
   - `paused` 且 `pausedByUser`：不处理。
   - 已停止且未被用户暂停：检查工作副本存在、`git -C <wt> status` 成功；日志中有 `integration-start` 而没有对应（同一个树 `T`）的 `integration` 时，这次整合无法确定是否完成，建立 `interrupted` 决定并报告（目标目录、文件列表），不自动恢复整合。其余情况用 `claude --bg --resume <完整会话 ID> "<恢复说明>"` 恢复（恢复说明：会话被中断后恢复，列出进行中的子代理与工作副本状态，请架构师核对后继续）。恢复说明以窗口输入的身份到达架构师会话，但它是插件写的：`recovery.isRecoveryMessage` 识别它与 context-memory 更新后的重新加载说明，架构师不把它们记为用户追问，也不做反馈判断。
4. 日常任务：`owner.routerSessionId` 不是当前 Router 会话的运行中任务改为 `waiting-user`，Telegram 报告“Router 重启，任务「<title>」的执行者已不在；回复这条消息可以继续”（tg-router 的丢失处理会接手回复）。
5. context-memory 更新：会话运行的是安装后的缓存副本，不是仓库源码（2026-11-09：`installed_plugins.json` 中 context-memory 的 `installPath` 为 `~/.claude/plugins/cache/sipeng-mods/context-memory/0.2.0`，仓库 HEAD 已是 0.4.0）。所以指纹取 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/plugins/installed_plugins.json` 中 `context-memory@sipeng-mods` 条目的 `installPath`、`version`、`gitCommitSha`、`lastUpdated` 四项的 `fnv1a64`，没有安装时为 `absent`；编辑仓库不会改变它，从任何来源安装的更新都会改变它。指纹与某个空闲（`status === 'idle'`）的架构师会话记录的指纹不同时，`claude stop <shortId>` 后用不带参数的 `claude --bg --resume <ID> "context-memory 已更新，会话已重新加载，请继续当前任务"` 恢复，并更新指纹；忙碌的会话留到下次。
6. 结果写入各任务日志 `recovery` 与 `state/recovery.json`。

**归档失败检查。** 架构师会话每次主对话 `turn.complete` 后，从 `st.debugOffset` 开始检查本会话的调试日志（`$.fs.read` 有 4 MiB 上限，用 `io.run(['sh', '-c', 'tail -c +"$1" "$2" | grep -m1 -E "$3"', …])`），匹配 `context-memory 归档失败|hook failed closed: context-memory` 时 Telegram 报告并记录。后台会话不带调试参数时不写调试日志（U4），所以 `launchArchitect` 启动架构师时加上 `--debug-file <stateDir>/debug/<任务 ID>.txt`；`claude --bg --resume` 把它作为保存的选项沿用，同一个会话恢复后继续写进这个文件（2026-11-09 实测）。架构师会话读这个文件；其他会话读 `$CLAUDE_CONFIG_DIR/debug/<会话 ID>.txt`，没有时在调试输出里记一次。

### 9.14 评分与校准提醒（`calibration.ts`）

```ts
export function ratingDue(state: { lastInviteDay?: string }, now: number, tz: string, hour: number): boolean
export function pickRatingTask(tasks: TaskRecord[], day: string, rand: () => number, tz: string, first?: (t: TaskRecord) => boolean): TaskRecord | null
export function ratingFirst(t: TaskRecord, rules: Rules): boolean   // 当前规则版本的执行者用了 ratingPriority 列出的设置
export function parseRating(text: string, replyKind: string | undefined): number | null
export function calibrationFindings(tasks: TaskRecord[], now: number): { ruleId: string; kind: 'rework' | 'diagnosis' | 'model-change' | 'low-rating' | 'unsuitable' | 'substitute-success'; taskIds: string[] }[]
export function bandOf(deepP: number | null, t: { deepYes: number; hardYes: number }): 'below' | 'deep' | 'hard' | null
export function startEffortOf(a: AgentRecord): Effort            // 第一次提高之前最后一次起步变化的强度
export function bandStats(tasks: TaskRecord[], now: number, rules: Rules): BandStat[]   // 按规则、概率段、模型、起步强度分格：任务、提高过的任务、换过模型的任务
export function bandFindings(stats: BandStat[]): BandStat[]      // 提高或换模型的任务不少于 3 个的格
export function tick(ctx: Ctx): Promise<void>
```

- **评分邀请。** Router 的定时器在 `schedule` 锁内执行。当地时间（`opts.timezone`）达到 `ratingHour` 且当天还没有邀请时，从当天完成的任务（`completedAt` 在当天）中随机选一个；其中有 `ratingFirst` 为真的任务（当前规则版本的执行者用了 `ratingPriority` 列出的设置：`code-change` 交给 Opus 5.5，或 Opus 5.5、Mythos 5.2 判为需要深入推理、起步限在 high）时，只在这些任务中选。邀请作为回复发到选中任务的完成通知下：“可以给「<title>」打个分吗？点下面的分数，或回复 1–5；不想评就点“跳过”。”消息下带按钮 1–5 与“跳过”（`telegram.RATING_BUTTONS`，回调数据 `rate:<n>`、`rate:skip`）。频道服务器收到按下的按钮后，把按钮换成“已评分 N”或“已跳过”；分数按钮作为用户对这条邀请的回复送进 Router，内容是那个数字，`message_id` 与 `reply_to_message_id` 都是邀请的消息 ID（按钮没有自己的消息），走与回复数字相同的评分流程。消息写入索引 `kind: 'rating'`，`state/rating.json` 记下当天。当天没有完成的任务时不发。
- **评分解析。** 回复评分邀请的 `1`–`5`，或回复任务任意消息的 `评分 N`：写入 `ratings`（原文、是否来自邀请），Telegram 回复“已记录评分 N”。
- **校准检查。** 距上次检查满 14 天时运行，窗口为最近 14 天：同一条规则至少 3 个任务出现同一类问题（验收不通过的返工、需要诊断或更换模型、评分不高于 2、反馈中 `unsuitable` 为真），或替代模型至少 3 次完成了原模型没有完成的工作（`model-change` 后验收通过或架构师接受），才发提醒：列出规则、问题类别、对应任务（标题与 ID）和调整建议（检查该规则的模型或起始强度，在校准讨论中由用户确认）。`model_opinion` 为真的用户原话一次即触发提醒并附原话。没有达到条件时只记录检查时间。
- **按深入推理概率分段。** 同一次检查还按规则、Jev 深入推理概率所在的段（低于 `deepYes`、`deepYes` 到 `hardYes`、`hardYes` 以上；评估模型代为判断的没有概率，不计入）、模型和起步强度（`startEffortOf`）分格，统计窗口内开始的规则执行者：任务数、验收不通过或诊断后重新委派而提高过强度的任务、换过模型的任务。同一格中提高或换模型的任务不少于 3 个时成为证据：提醒写明这一格和对应任务，建议把这一段的起步提高一档；格子是 `code-change` 交给 `model`（Opus 5.5）的 `deepYes` 到 `hardYes` 段时，建议把 `hardYes` 往下调。发提醒时附上每一格的计数，零次提高的格子供用户判断起步是否偏高。已提醒过的格按规则、段、模型、起步与任务集合记入 `reminded`，不重复提醒。
- **反馈来源。** Router 的 `session.send` 钩子观察 tg-router 发给 worker 的追问（调用 `next(e)` 不改变投递），架构师会话的窗口消息与 Telegram 转交消息，都写入任务 `feedback`（保留原话），异步做 `unsuitable` 与 `model_opinion` 判断。

### 9.15 安装顺序要求

同一字段由最内层插件决定；`claude plugin install` 把新插件追加在 `enabledPlugins` 末尾，成为最内层（实测）。magpie-tasks 必须在 jev 与 subagent-opus 之后安装。

`session.start`（`candidate` 与 `router`）：读取 `$.settings.read({ source: 'user' })` 的 `enabledPlugins` 键顺序。`magpie-tasks@sipeng-mods` 存在且排在 `jev@sipeng-mods` 或 `subagent-opus@sipeng-mods` 之前时，`$.ui.notice` 显示错误（说明顺序要求与修正方法：卸载后重新安装 magpie-tasks），并把角色设为 `inactive`。以 `--plugin-dir` 加载时（magpie-tasks 位于最外层），JEV 依靠任务标记跳过子代理（第 10.2 节）；subagent-opus 位于内层，只在 Fable 或 Mythos 父模型的嵌套委派中改写模型（第 1 节），magpie-tasks 在这些委派中已经写入选定的模型（`e.model` 不再为空），subagent-opus 的条件因此不成立；唯一的例外是 Fable 父模型下用户再指定 Fable 或 Mythos 的嵌套委派，开发方式下它会被 subagent-opus 改为 opus。除此之外开发方式下各字段也由 magpie-tasks 决定；端到端测试仍以安装方式进行（第 12.2 节）。

### 9.16 模型不可用或额度耗尽（`unavailable.ts`，工作包 F）

设计规定：有证据支持、符合已有规则的替代模型可以在告知用户后接手；没有合适替代时由用户决定等待或接受其他模型（系统行为约定“模型不可用或额度耗尽”，路由表第 5 节）。Magpie 负责账号与故障转移，它在重试和切换账号之后仍然失败时，子代理的回合以错误结束。

**发现。** `classic.StopFailure` 在 API 错误结束回合时触发，带错误分类 `error`（`rate_limit`、`overloaded`、`server_error`、`billing_error`、`model_not_found`、`authentication_failed`、`invalid_request`、`max_output_tokens`、`unknown` 等）与 `agent_id`（在子代理中触发时）。`onStopFailure` 对 `st.agents` 中的代理记录 `st.stopFailures.set(agentId, error)`。随后该代理的 `turn.complete` 以 `reason === 'error'` 到达，`onAgentError` 取出分类：

- `isUnavailableError` 为真（`rate_limit`、`overloaded`、`server_error`、`billing_error`、`model_not_found`、`authentication_failed`）：代理记录 `state: 'failed'`、`failure: { kind: 'model-unavailable', error }`，日志 `unavailable`，进入下文的处理。
- 其他分类或没有分类：`failure.kind = 'api-error'`，按第 8 节的流程错误报告（长期任务另用 `$.session.append` 告诉架构师），不更换模型。

这一路径不经过“没有状态行”的处理：回合以错误结束的代理不会被要求补状态行。

**选择接手者**（`unavailableAction`，纯函数）：

1. 代理的选择类型为 `user`（用户指定的模型）：不自动更换，`ask-user`（`user-chosen`）。用户指定优先，换不换由用户决定。
2. 其余类型：候选依次为该代理规则写明的模型（规则按该代理的判断选中的模型在前，然后是规则的 `model`、`hardModel`、`deepModel`），再是 `forRules` 含该规则的 `auto: true` 替代候选的各个模型；去掉与失败模型相同的（`sameModel`）、`isAvailable` 为假的、`substituteEffort` 为 `null` 的。取第一个，`substitute`。规则写明的模型取规则提升顺序中不低于该模型起步档位与代理当前强度的最低一档，保留已经需要的提高；替代候选取 `substituteEffort` 的结果。`code-change` 的 Opus 5.5 与 Mythos 5.2 因此互为接手者。
3. 没有剩余候选（包括规则为 `none` 的代理）：`ask-user`（`no-substitute`），列出可供用户选择的候选。

**日常任务**（Router 会话）：`substitute` 时，Telegram 回复原消息“<原模型> 不可用（<分类>），改由 <模型>/<强度> 接手”，经中转启动接手者：`handoffBrief` 交接原始请求、追问、前一执行者的报告与工作副本，说明加 `[model-reason evidence: <原模型> unavailable (<分类>)]`，选择类型 `unavailable-substitute`，前一执行者记录 `replacedBy`，更新索引负责人。`ask-user` 时建立 `model-unavailable` 决定（选项：等待、改用列出的候选），Telegram 发问题（索引 `kind: 'decision'`），任务 `waiting-user`；回复由 `applyDailyDecision` 执行（第 9.11 节）。

**长期任务**（架构师会话）：实施子代理由架构师安排，插件不自行启动接手者。`$.session.append` 告诉架构师失败的代理、分类与 `unavailableAction` 的结果（建议的接手模型与强度，或没有替代）；Telegram 通知用户同样的内容（`notify: true`）。`ask-user` 时建立 `model-unavailable` 决定（索引 `kind: 'long'` 加 `decisionId`），用户的回答按第 9.12 节交给架构师会话。架构师采用建议时，用 `model_route` 委派剩余工作，推荐建议的模型与强度，理由写明原模型不可用及路由表的替代条目；Jev 照常权衡，第 9.6 节照常记录。

**架构师或 Router 主对话的模型不可用**：主对话的 `turn.complete` 以 `reason === 'error'` 结束时，Telegram 通知用户（会话、分类、`claude attach <shortId>`），有回复目标时回复原消息；会话本身不受影响，模型由用户决定。

`StopFailure` 在子代理中触发并带 `agent_id`（U11）。Magpie 对不服务的模型返回 400 `invalid_request_error`，引擎分类为 `unknown`；`stopFailureCategory` 在分类为 `unknown` 或 `invalid_request`、且 `error_details`（没有时用 `last_assistant_message`）是说明模型不被服务的 400 时，把它记为 `model_not_found`，按模型不可用处理。

## 10. 配套修改

### 10.1 tg-router（工作包 G）

`magpieActive` 在 `session.start` 判定：`ANTHROPIC_BASE_URL` 等于 `http://127.0.0.1:3425`。为 false 时行为不变。

1. `src/magpie.ts`（新文件）：`indexPath(home, env)`（`MAGPIE_TASKS_STATE_DIR` 或 `~/.config/magpie-tasks` 下的 `index/telegram.json`），`readIndex(io)`（文件不存在时返回空索引；JSON 不合法时抛出），以及三个查询：`ownerOf(index, workerName)`、`workerOfAgent(index, agentId)`、`messageKind(index, chatId, messageId)`。
2. `hooks/register.ts`：
   - `dispatch`：`magpieActive` 时不传 `model: WORKER_MODEL`；说明第一行加 `[magpie-tasks-request daily chat=<chatId> message=<messageId> worker=<name>]`；参数增加可选的 `model` 与 `model_reason`，两者同时给出时在说明中加 `[model <model>]` 与 `[model-reason user: <model_reason>]` 两行（`$.agent.spawn` 的 `model` 只接受四个别名，第 9.6 节），不传 `model`；只给一个时报错。
   - `deliver`：`ownerOf` 有记录且 `ownerAgentId` 与 tg-router 记录的 worker 不同时，发往 `{ agentId: ownerAgentId }`；`long` 为真时不投递，返回交给内层。
   - `prompt.submit`：频道消息 `reply_to` 的 `messageKind` 为 `long`、`magpie`、`decision`、`rating`，或文字匹配 `^\s*评分\s*[1-5]\s*$` 时，不做自己的路由，清除 `armed` 后 `return next(e)`；内层返回 `drop` 时同样清除 `armed`。
   - `taskFor(agentId)`：自己的记录与代理名都找不到时，用 `workerOfAgent` 找 worker 名，再按名取任务（更换后的执行者的回答发到原任务下）。
3. `src/gate.ts`：`ROUTER_TOOLS` 增加 `mcp__magpie-tasks__forward_long`、`mcp__magpie-tasks__recommend_architect`、`mcp__magpie-tasks__promote_task`；子代理调用这三个工具时拒绝。子代理调用 `mcp__magpie-tasks__open_project` 不受 tg-router 限制（tg-router 不检查子代理的普通工具）。
4. `src/prompts.ts`：`workerBrief` 在 `magpieActive` 时去掉“自己建工作副本”一条（由 `open_project` 负责），并说明状态行由 magpie-tasks 的任务规则规定。`routerContext` 与 `terminalContext` 增加 `dispatch` 的 `model`/`model_reason` 用法。
5. `src/telegram.ts`：`stateDir` 依次读取 `TG_ROUTER_STATE_DIR`、`TELEGRAM_STATE_DIR`、默认目录。
6. 测试：`tests/magpie.test.ts`（索引查询）；`hooks/register.test.ts` 中现有用例在 `magpieActive` 为 false 时保持通过。

### 10.2 JEV（依赖 JEV 的 Jev 上下文改造）

JEV 的 Jev 上下文改造（`/tmp/jev-dev`，已合入 `mods/jev`）替换了 `prompt.submit` 与对话整理，并实现了 magpie-tasks 需要的两项跳过；JEV 还把带任务标记的子代理的强度条交给 magpie-tasks。magpie-tasks 依赖这三项的现有形式：

- 子代理：委派说明（子代理视图的第一条 user 消息）去掉开头空白后匹配 `^\[magpie-tasks task=[^\]\s]+[^\]\n]*\]` 时（`mods/jev/src/dialogue.ts` 的 `MAGPIE_TASKS_MARKER`），JEV 在该子代理每一轮运行的第一次请求时写一条 `skip` 记录（`event: 'skip', reason: 'magpie-tasks'`），本轮不再改写强度、不写判断记录（`mods/jev/hooks/register.tsx` 的 `decideStep`；子代理的 `loops` 记录在它的 `turn.complete` 时删除，所以每轮一条）。第 9.6 节第 10 步写出的任务标记满足这个格式。
- 中转消息：`e.origin` 为插件 `magpie-tasks` 且文本以 `[magpie-tasks spawn ` 开头时（`MAGPIE_TASKS_RELAY`），JEV 直接 `next(e)`，不写判断记录，也不改变下一回合的判断。第 9.8 节的启动与唤醒在调用处直接执行，magpie-tasks 不提交这种消息，JEV 的这项放行没有使用者。
- 强度条：委派说明带任务标记的子代理，不论模型，JEV 都不记它的模型，`ui.render`（`AbovePrompt`）对它调用 `next(e)`，由 magpie-tasks 画（第 9.7 节）。是否带标记按子代理 ID 记在 `magpieOwned` 中，每个子代理只读一次委派说明。

集成顺序（第 13 节）要求这一改造先合入仓库；端到端场景安装的 JEV 是合入后的版本。

### 10.3 启动脚本（工作包 G）

`examples/claude-telegram/claude-telegram` 与 `/home/ubuntu/.local/bin/claude-telegram`（后者 `CLAUDE_MODS` 默认 `$HOME/sipeng/claude-mods`，其余相同）：

```bash
cd "$HOME" || exit 1
CLAUDE_MODS="${CLAUDE_MODS:-$HOME/claude-mods}"
CHANNEL_DIR="$CLAUDE_MODS/examples/claude-telegram/tg-channel"
LIVE="$HOME/.claude/channels/telegram-live"
export MAGPIE_TASKS_ROLE=router
export TG_ROUTER_STATE_DIR="$LIVE"

mcp_config=$(jq -nc --arg dir "$CHANNEL_DIR" --arg live "$LIVE" \
  '{mcpServers: {"tg-channel": {command: "bun", args: ["run", "--cwd", $dir, "--shell=bun", "--silent", "start"], env: {TELEGRAM_STATE_DIR: $live}}}}')

exec claude-magpie --model 'claude/claude-opus-5-5[1m]' --dangerously-skip-permissions \
  --mcp-config "$mcp_config" \
  --dangerously-load-development-channels server:tg-channel \
  --plugin-dir "$CLAUDE_MODS/mods/tg-router" \
  "$@"
```

变化及原因：

- 通过 `claude-magpie` 启动，模型固定为 Opus 5.5（Router 的模型选择；Magpie 默认模型是 Astra）。
- 不再传 `--settings`：claude-magpie 自己用 `--settings` 传入网关设置，多个 `--settings` 只有最后一个生效、不合并（实测 00c71792），再传一个会让会话失去网关。官方 telegram 插件因此保持启用；它读取默认的 `~/.claude/channels/telegram/`，那里没有令牌，启动时退出，与普通会话相同。
- `TELEGRAM_STATE_DIR` 只通过 MCP 配置的 `env` 交给 tg-channel，不再导出给整个会话，官方插件不会读到 `telegram-live`。tg-router 改读 `TG_ROUTER_STATE_DIR`。
- `MAGPIE_TASKS_ROLE=router` 让 magpie-tasks 把这个会话当作 Router（前台会话能收到自定义环境变量，实测）。

`examples/claude-telegram/README.md` 更新：架构图加入 magpie-tasks 与长期任务；Setup 增加“安装 magpie-tasks（在 jev 与 subagent-opus 之后）”；说明 Router 在 Opus 5.5 上运行、日常任务的模型由路由规则决定、验收与整合流程、长期任务的转交与回复、评分。

### 10.4 仓库

- `.claude-plugin/marketplace.json` 增加 `{ "name": "magpie-tasks", "source": "./mods/magpie-tasks", "description": "…" }`，放在列表末尾。
- 根 `README.md` 的插件表增加一行，Install 节说明安装顺序要求。
- `mods/magpie-tasks/README.md`：用途、生效条件、角色、配置项、记录位置、安装顺序、检查命令。

## 11. 未验证的接口行为及判定测试

U1、U2 是实现方案第 11 节列出的待验证行为；U9 来自官方文档描述的后台会话原生工作副本；其余是本计划的机制所依赖、探测报告没有覆盖的组合。每项在对应工作包集成后、其他端到端场景之前运行。任一项失败时停止依赖它的部分，把测试输出带回设计讨论。

| 编号 | 行为 | 判定测试 | 通过标准 |
| --- | --- | --- | --- |
| **U1** | 从钩子用 `$.process.run` 启动 `claude-magpie --bg --model <id> "<消息>"`，再从定时器 `$.command.run({ command: 'exit' })` 结束前台会话 | 场景 E3；`session.start` 把 `$.command.list()` 的命令名写入调试日志，确认 `exit` 是可用的命令名（`bg` 只是 `background` 的别名，实测） | 后台会话出现在 `claude agents --json` 中，`cwd` 为项目根；Magpie 用量中该会话的模型为所选模型；前台进程退出（tmux 窗格 `pane_dead=1`）；`tmux capture-pane` 在退出后仍能看到 `claude attach <id>` 一行；认领成功 |
| **U2** | `$.session.send({ to: { sessionId } })` 投递给空闲的后台会话 | 场景 E9 的第一步：后台架构师空闲（`claude agents --json` 中 `status: idle`）时由 Router 转交 | `isDelivered === true`；架构师会话开始新回合（Magpie 用量出现新行，转录中出现转交文本）；回答经 Bot API 发回 |
| U3（对照通过，2026-11-09：四个钩子都看到在主对话 `turn.complete` 中启动的子代理，第 9.8 节的启动直接进行；E8 中验收子代理以 `magpie-tasks: 已启动验收子代理（…）` 一行启动） | 插件启动的子代理正常运行，插件看到它的 `turn.start`、`turn.step`、`tool.call`、`turn.complete` | 场景 E8 中验收子代理的启动；对照：独立配置目录中加载一个只含 `turn.complete`、`turn.start`、`turn.step`、`tool.call` 日志钩子的探测插件，在 `turn.complete` 中直接 `$.agent.spawn` 一个运行一次 Bash 的 Haiku 子代理 | 启动：Router 窗格出现 `magpie-tasks: 已启动验收子代理（<模型>/<强度>）`；插件看到该 agentId 的 start、step（强度为设定值）、tool.call 与 complete；验收结论写入记录。对照：探测插件的四个钩子都记录到该子代理时，第 9.8 节的启动改为在 `turn.complete` 中直接进行；有任一钩子缺失时保留中转 |
| U4（2026-11-09：不带 `--debug` 或 `--debug-file` 的后台会话不写调试日志；带 `--debug-file` 启动的会话在 `claude --bg --resume` 后继续写同一个文件，恢复时的提示列出了它保存的 `--debug-file`） | 架构师会话的调试日志位于 `<stateDir>/debug/<任务 ID>.txt` | 场景 E3 中检查该文件 | 文件存在且含该会话的认领日志行 |
| U5 | `$.session.send` 送达的消息与 `claude --bg --resume` 唤醒时的第一条消息，在接收会话的 `prompt.submit` 中保留第一行标记 | 场景 E9 的第 (1)、(3) 步 | 两条路径上架构师会话的调试日志都记录到标记与实际的 `origin.kind`，回复目标被记录，回答发回 Telegram |
| U6 | `/bg` 生成的副本在 `session.start` 中能用 `$.session.messages({ as: 'api' })` 读到分叉前追加的标记行 | 场景 E4 | 副本认领成功，记录中 `owner.sessionId` 为新 ID，旧 ID 在 `previousSessionIds` 中 |
| U7 | Jev 对 19 条规则的判定质量与门槛（实现方案第 11 节第 3 项） | 第 12.3 节的脚本可以重新生成判断表；用户不做逐件标注（用户决定，2026-11-10），门槛与分界由第 9.14 节的校准按实际结果调整 | 校准提醒提出调整、用户确认后提高规则版本 |
| U8 | 委派说明中的选模理由格式能被稳定使用（实现方案第 11 节第 4 项） | 场景 E6 第 4–5 步 | 架构师按每轮上下文的格式写出 `[model-reason …]`，插件识别；没有理由时的拒绝理由足以让架构师自行补上 |
| **U9** | `settings.read` 钩子回答的 `worktree.bgIsolation: 'none'` 对 `claude-magpie --bg` 与 `claude --bg --resume` 启动的后台会话生效，架构师留在项目主目录（第 2 节） | 场景 E5 第 2 步之后，以及 E9 第 (3) 步恢复之后再请架构师 Edit 一次 `.planning/findings.md` | Edit 成功，`$E/proj/.planning/findings.md` 存在且含写入内容；`claude agents --json` 中该会话的 `cwd` 仍为 `$E/proj`；`$E/proj/.claude/worktrees/` 不存在；`git -C $E/proj worktree list` 只列出项目本身与插件的任务工作副本 |
| U10（通过，2026-11-09：(a)(b)(c) 三种唤醒下 `agent.spawn` 都以 `resume` 触发，`turn.start` 的 `text` 为 `The coordinator sent a message while you were working:` 包装的唤醒消息，`turn.step`、`tool.call`、`turn.complete` 都看到被唤醒的一轮；唤醒在原处直接发送） | 插件唤醒已完成的子代理时，插件自己的钩子能否看到被唤醒的这一轮 | 独立配置目录中的探测插件（`turn.start`、`turn.step`、`tool.call`、`turn.complete`、`agent.spawn` 日志钩子，加一个注册工具）：在 `prompt.submit`（插件提交的消息）中启动一个运行一次 Bash 的 Haiku 子代理；它完成后分别从 (a) 插件提交并 `drop` 的消息的 `prompt.submit`、(b) 该子代理的 `turn.complete`、(c) 主对话调用注册工具时的 `tool.call` 中，用 `$.session.send({ to: { agentId } })` 唤醒它，每次要求再运行一次 Bash | 记录每种唤醒下：`agent.spawn` 是否以 `resume` 触发；`turn.start` 的 `text` 是否为唤醒消息；探测插件的 `turn.step`、`tool.call`、`turn.complete` 各自是否看到被唤醒的一轮。通过：(a) 下四个钩子都看到，第 9.8 节的唤醒中转成立。(b)、(c) 下也都看到时，唤醒改为在原处直接发送，中转只用于启动；(a) 下有钩子缺失时停止依赖唤醒的流程，把记录带回设计讨论 |
| U11（2026-11-09：E14 中 `classic.StopFailure` 在子代理中触发、`agent_id` 正确；Magpie 对不服务的模型返回 400 `invalid_request_error`，Claude Code 分类为 `unknown`，`last_assistant_message` 为 `API Error: 400 Codex: The '<模型>' model is not supported …`。用户决定这种 400 算作模型不可用：`stopFailureCategory` 把错误文字说明模型不被服务的 400 记为 `model_not_found`） | 路由过的子代理因 Magpie 拒绝而以错误结束时，插件收到带 `agent_id` 的 `classic.StopFailure` 与 `reason === 'error'` 的 `turn.complete`（第 9.16 节） | 场景 E14 | `StopFailure` 在子代理中触发，`agent_id` 等于该代理，`error` 属于 `isUnavailableError` 的分类（记录实际分类与 `error_details`）；随后的 `turn.complete` 的 `reason` 为 `error`。分类不在不可用集合中时停止第 9.16 节的自动处理，把分类带回设计讨论 |

2026-11-09 在独立配置目录中运行端到端场景时测得、影响设计的另外几项：

- Magpie 的 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 是 `codex/gpt-6-astra`，Agent 工具的别名 `haiku` 因此请求 Astra，`canonical` 照此记录。用户说“用 Haiku”时，架构师要写 `[model claude/claude-haiku-5-5]`，每轮上下文据此要求按 ID 指定模型。
- 前台窗口设置的 `JEV_OPUS_CONFIG_DIR=$E/jev` 到达了插件启动的架构师后台会话：它的 JEV 记录写在 `$E/jev`，没有写进 `~/.config/jev-opus`。
- 插件的 `$.agent.spawn` 以主对话的 Agent 调用经过外层插件的 `tool.call`。tg-router 的工具限制拒绝 Router 主对话的 Agent 调用，只放行 `next.origin.plugin === 'magpie-tasks'` 的那些，日常任务的验收、诊断与接手子代理因此能够启动。
- 终端日常任务中，用户在 Router 窗格输入的回复由 Router 用 SendMessage 送给评估子代理，子代理把它当作协调者的话、拒绝作为用户的确认；终端任务的评估说明因此写明 Router 转达的就是用户原话。
- `$.session.append` 追加的 `system` 消息不显示在窗格中，终端任务的说明与报告改用 `$.ui.log`。
- “统计 greet.py 有几行”“这台机器还剩多少空间”这类很小的请求，Jev 判定为没有匹配规则（`none`）。这类请求按 `daily-default` 直接由 Opus 5.5 执行，不评估，也不等确认（用户决定，2026-11-10）。

## 12. 测试计划

### 12.1 单元测试

两种测试，都不替换任何依赖：

- `claude plugin test mods/magpie-tasks`：`tests/*.test.ts`，只测试纯函数（输入是规则文件、真实格式的记录、从探测与实际会话中保存的 `{as:'api'}` 消息），从 `claude-code/testing` 导入 `test` 与 `expect`，不使用测试工具中的 `mock` 与替身钩子。
- `bun test mods/magpie-tasks/io-tests`：`io-tests/*.spec.ts`，通过 `node-io.ts` 在 `mktemp -d` 建立的真实目录中运行真实的 `mkdir`、`mv`、`git` 和真实的 Jev 请求。

| 模块 | 测试文件 | 内容 |
| --- | --- | --- |
| rules | `io-tests/rules.spec.ts`（读取 `model-routing-table.md`，`claude plugin test` 的测试环境不能读仓库文件） | 规则文件通过校验，19 条齐全（15 条 Jev 选项），`condition`/`acceptance` 与 `model-routing-table.md` 对应列逐字相同（测试读取该 Markdown 文件比较）；删掉一条或写错强度时 `parseRules` 抛出；`startEffort`、`raise` 封顶；`reviewSecondTarget`：原模型 Sol → Opus，原模型 Opus → Sol，原模型含 `codex/gpt-6.1-sol` 与 `claude/claude-opus-5-5[1m]` → `none`，别名 `opus` 与 `[1m]` 视为同一模型；`substituteAllowed` 按表 4.4（`repo-alt` 只接受 xhigh、max；`math-extra` 接受任意强度；`science-math-alt` 只接受对应规则的强度）；`substituteEffort`：`code-change` xhigh → Astra xhigh，`code-deep` max → Astra max，`math-extra` 为 `null`；`hardYes` 缺失、`hardModel` 不在 models 中或等于规则自己的模型、`ratingPriority` 的规则或条件不合法时抛出；`code-change` 的模型列写明门槛 0.95 与 Mythos 5.2；`substituteAllowed` 对规则自己写明的模型返回 `rule:<id>` |
| model | `io-tests/model.spec.ts` | 输入为 `~/.config/magpie/claude-launch/settings.json` 的结构（测试从该文件读取，只取 `modelPicker` 与三个非密钥 env 字段）：`canonical`、`requestId`（Opus 得到 `[1m]` 变体，Sol 不变）、`clampEffort` |
| jev | `io-tests/jev.spec.ts` | 真实 Decisions 请求（密钥只在代码中读取，测试不打印）：消息列表输入、一题选择加一题判断的解析；连续两次追加消息时第二次 `cachedTokens > 0`；错误模型名得到 `ok: false`；把时限设为 1 毫秒得到超时 |
| jev 解析 | `tests/jev.test.ts` | `parseResponse` 对 `jev.spec.ts` 保存下来的真实响应正文；缺题、选项不在列表中时抛出；`recomputedConfidence` |
| dialogue | `tests/dialogue.test.ts` | 输入为探测目录中保存的 `{as:'api'}` 转储（`/tmp/magpie-probe-recheck-JQE9/out/` 的 006、032、034、044、047、048，复制到 `tests/data/`）：委派说明、协调者续发两种形式、最终回答提取；通知去重：034 中 msg10 与 msg48 两条 task-id 与 summary 相同、result 不同的通知都保留，048 中 msg0 与 msg4 的相同通知只保留一条 |
| judge | `io-tests/judge.spec.ts` | 真实 Jev：路由表第 4 节的例子与每条规则各一个按条件写成的说明，检查返回的规则 ID 与置信度字段齐全并记录结果（判定质量由第 12.3 节评估，这里不设准确率门槛）；`decideRule` 的门槛逻辑与替代判断的 JSON 解析（合法、缺字段、不是 JSON 时抛出）在 `tests/judge.test.ts`；替代判断的完整路径（`$.model.complete` 只在钩子中可用）由场景 E13 检查 |
| 阻碍判定 | `io-tests/judge.spec.ts` | 真实 Jev 的 `blocker` 选择题：已有阻碍 `b1`（依赖安装失败）时，换一种说法描述同一失败的报告选中 `b1`，描述另一个失败（测试断言错误）的报告选中 `new`；记录置信度。低置信度归入概率最高的已有阻碍的逻辑在 `tests/judge.test.ts` |
| lock | `io-tests/lock.spec.ts` | 两个并发 `withLock` 串行执行；持有者进程被杀后旧锁超过 `staleMs` 被接管；`waitMs` 超时抛出；等待期间调用的是 `io.run(['sleep', …])` 而不是 `io.sleep`（node-io 记录调用）。钩子中长时间等待不超时由场景 E8 的锁等待步骤检查 |
| registry | `io-tests/registry.spec.ts` | 创建、更新、日志追加；20 个并发 `update` 不丢修改；认领只被取走一次；过期认领清理；索引读写；会话索引随换 ID 更新 |
| git、integrate | `io-tests/git.spec.ts` | 真实仓库：未提交与未跟踪文件进入工作副本，用户索引不变；整合只应用任务改动并保留用户未提交改动；第二次整合只应用新改动；与用户改动冲突时 `conflict` 且主目录不变；`placeTask` 的直接修改与工作副本两种结果，非仓库目录直接修改且不建立仓库；`settleDirect` 记录改动、移动基线并告知同一目录的其他任务；`leaveIfTaken` 转到工作副本；空仓库（无 HEAD）；二进制文件 |
| conflict | `tests/conflict.test.ts` | `touchedPaths`、`porcelainChanged`（`-z` 输出含空格与改名）、`findConflict`、`isCheckCommand` |
| gate | `tests/gate.test.ts` | 写入白名单的路径（含 `..`、符号链接解析结果、工作副本中的同名文件）；只读 Bash 的放行与拒绝（重定向、`$(…)`、`sed -i`、`find -delete`、`git commit`）；打包与发布命令 |
| brief | `tests/brief.test.ts` | 标记生成与解析、`[model-reason …]`、`[review-of …]`、`[effort …]`、tg-router 请求头、`requestText`；状态行、验收结论、选模确认、诊断建议的解析（含全角冒号与多余空白） |
| spawn | `tests/spawn.test.ts` | `decideSpawn` 的每个分支：fork/workflow/teammate/resume/自身中转放行，指定模型无理由拒绝，有理由采用（`user` 不检查模型列表；`adjusted` 只接受 `model_route` 的调用，不在列表时拒绝），`parentModel` 为 Fable 5.1 且 `e.model === 'opus'`、没有理由行时按规则选择，`review-second` 排除，没有匹配时架构师拒绝、日常任务转评估；`nextEffort` 按第 5 节；`unavailableAction`：`user` 类型询问用户，`code-change` 的 Opus 5.5 与 Mythos 5.2 互为接手者（强度不低于当前档位），两者都不可用时得到 Astra xhigh，规则 `none` 与只有 `null` 强度候选时询问用户；`code-change` 在 Jev 深入推理概率达到 0.95 时选 Mythos 5.2，评估模型代为判断时选 Opus 5.5 |
| band | `tests/band.test.ts` | 强度条：按路由表名称写模型、请求实际带的强度与规则，重复请求不重画；续接提高后的强度变化；结束标记在下一轮运行时去掉；钩子出错时的 `engine effort`；换模型时重新记录；超过六个强度时只显示最后五个；超过 64 行时先删除已结束子代理的行 |
| route | `tests/route.test.ts`、`io-tests/route.spec.ts` | `model_route` 的参数校验；采用推荐时写出的控制行能被 `brief.ts` 读回；Jev 的推荐选择题：有规则时选项为路由表的选择与推荐，没有规则时为推荐与“都不合适”，输入含说明、理由与路由表对两个模型的说明（Haiku 的“只在用户指定时使用”）；真实 Jev 对 E9 第 5 步（架构师为改一行推荐 Haiku 5.5）的判断 |
| session、launch | `tests/session.test.ts`、`tests/launch.test.ts` | 角色判定表；`bgIsolationAnswer`：输入为 `~/.config/magpie/claude-launch/settings.json` 作为 `flag` 层（测试只取 `env.ANTHROPIC_BASE_URL`）时得到 `worktree.bgIsolation: 'none'`，没有 `flag` 层或地址不同时原样返回，读取单个来源时原样返回；`launchArgv`（`env -u`、开发方式的 `--plugin-dir`）；`parseBackgrounded` 对实测输出 `backgrounded · e21efae8`；确认对话的选项恰好是四个候选模型，文字包含 Git 信息与不受信任时的说明 |
| telegram、router、calibration | `tests/telegram.test.ts`、`tests/router.test.ts`、`tests/calibration.test.ts` | `parseChannelTag` 对实测的 channel 块；`clip`；索引种类到处理方式的分派；`parseRating`；`ratingDue` 在时区边界；`calibrationFindings` 的 3 个任务门槛、两周窗口、替代成功计数；按深入推理概率分段的统计（3 个任务需要提高或换模型时成为证据，`code-change` 的 Opus 段建议下调 `hardYes`，提醒列出每一格）；评分邀请先选 `ratingPriority` 的任务 |
| recovery | `tests/recovery.test.ts` | 输入为真实 `claude agents --json --all` 输出（保存到 `tests/data/`）：运行、空闲、停止、失败各状态的处理决定；超过 10 分钟的 `starting` 任务改为 `error`；有 `integration-start` 无对应 `integration` 时建立 `interrupted` 决定；指纹只由 `installed_plugins.json` 条目的四项决定 |

`io-tests/` 与 `eval/` 导入 Node 模块，有自己的 `tsconfig.json`（`types: ["bun"]`，`include` 这两个目录与 `src/`）与 `package.json`（开发依赖 `@types/bun`，`cd io-tests && bun install` 后类型检查才能通过）；插件的 `tsconfig.json` 只包含 `.claude-plugin/types`、`hooks`、`src`、`tests`。

测试数据：`claude plugin test` 只加载代码文件，`tests/data/` 中的 JSON 与文本转储由同名的 `.ts` 模块原样嵌入后导入（`api-dumps.ts`、`jev-responses.ts`、`agents.ts`、`installed-plugins.ts`、`channel-blocks.ts`），JSON 文件保留为来源。

其他检查：`claude plugin validate mods/magpie-tasks`、`claude plugin test mods/magpie-tasks`、`bunx tsc -p mods/magpie-tasks/tsconfig.json`、`bunx tsc -p mods/magpie-tasks/io-tests/tsconfig.json`、`claude plugin test mods/tg-router`。

### 12.2 端到端场景

前提（所有场景）：在独立配置目录中按安装方式加载，顺序与正式安装相同：

```bash
E=$(mktemp -d /tmp/mt-e2e-XXXX); export CLAUDE_CONFIG_DIR=$E/cfg; mkdir -p $E/cfg $E/state $E/wt
cat > $E/cfg/settings.json <<JSON
{ "pluginConfigs": { "magpie-tasks@sipeng-mods": { "options": { "stateDir": "$E/state", "worktreeDir": "$E/wt" } } } }
JSON
claude plugin marketplace add ~/sipeng/claude-mods
for m in subagent-opus jev context-memory magpie-tasks; do claude plugin install $m@sipeng-mods --scope user; done
export MAGPIE_TASKS_STATE_DIR=$E/state      # 供 tg-router 读取索引
start() { tmux new-session -d -s "$1" -x 220 -y 60 "cd $2 && env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID CLAUDE_CONFIG_DIR=$E/cfg ${@:3}"; tmux set -t "$1" remain-on-exit on; }
```

`e2e/setup.sh` 建立上面的环境并打印 `E`，另外做两件事：配置目录写入完成引导与目录信任的 `.claude.json` 和 `skipDangerousModePermissionPrompt`（否则第一个窗格停在对话框上）；`JEV_OPUS_CONFIG_DIR=$E/jev`（复制 `~/.config/jev-opus/.env`），JEV 的记录写在 `$E/jev`。默认 `telegramChatId` 为 `tui`、`telegramStateDir` 为空目录，通知只显示在会话中，不发 Telegram；`e2e/setup.sh --telegram` 使用真实的 Telegram 状态目录，E3–E8 与 E13–E15 中的冲突、完成、模型不可用与出错通知会发到用户的聊天（`sendMessage` 不与常驻 Router 的轮询冲突），这是向用户发送消息的外部操作，使用前征得用户同意，并说明这些消息来自测试。每个场景结束后 `claude stop` 停止自己启动的后台会话、`tmux kill-session` 关闭窗格；日志与记录留在 `$E` 中供检查。场景脚本放在 `mods/magpie-tasks/e2e/`，每个脚本打印检查项与结果，任一检查失败时以非零状态退出。

| 场景 | 步骤 | 通过标准 |
| --- | --- | --- |
| E1 生效范围 | `claude -p --model claude/claude-haiku-5-5 '回复 ok'`；`claude-magpie -p --model claude/claude-haiku-5-5 '回复 ok'`；`start e1 $E claude-magpie --model claude/claude-haiku-5-5 --debug-file $E/e1.log` 后发送 `回复 ok`，确认对话出现后按 Esc | 前两者调试日志中 magpie-tasks 判定 `inactive`，`$E/state/tasks` 为空；第三个会话判定 `candidate`，确认对话的选项恰好是四个候选模型，按 Esc 后窗格显示 `Prompt dropped by a hook: magpie-tasks: 已取消…`，`$E/state/tasks` 仍为空，再次发送时重新出现确认对话 |
| E2 安装顺序 | `--debug-file` 启动任一会话，检查 `$ built for` 行；再把 `enabledPlugins` 中 magpie-tasks 移到 jev 之前启动一次 | 第一次 magpie-tasks 在 jev 与 subagent-opus 之后；第二次出现顺序错误提示且角色为 `inactive` |
| E3 新长期任务（U1、U4） | `mkdir $E/proj`，其中 `git init`，提交 `greet.py`；`start e3 $E/proj claude-magpie`；发送 `检查 greet.py 并只回复 ok`；确认对话中选推荐项 | 确认文字含“直接修改：$E/proj”，没有“建立 Git 仓库”；分支上仍只有一个提交；任务记录 `direct.dir` 为 `$E/proj`，`refs/magpie-tasks/<id>/base` 等于 `direct.baseCommit`；`$E/wt/<id>` 不存在；任务记录 `running`，`owner.sessionId` 等于 `claude agents --json` 中 `cwd=$E/proj` 的后台会话；认领文件已删除；前台 `pane_dead=1`；`magpie usage --csv --last 10m` 中该会话为所选模型；`$E/state/debug/<任务 ID>.txt` 含该会话的认领日志行 |
| E4 接管（U6） | 在 `$E/proj2`（`git init` 加一次提交）中运行两次 `claude-magpie -p --model claude/claude-haiku-5-5 --output-format json '回复 ok'`，取得会话 ID A、B（`-p` 为 `inactive`，不登记）。(a) `start e4a $E/proj2 claude-magpie --resume A --model claude/claude-opus-5-5 --debug-file $E/e4a.log`，发消息，选“不接管”，得到回答后 `/exit`；用同一命令再启动一次（`--debug-file $E/e4a2.log`）并发消息。(b) `start e4b $E/proj2 claude-magpie --resume B --model claude/claude-opus-5-5 --debug-file $E/e4b.log`，发消息，选“接管” | (a) 第一次的调试日志中 `$.session.id()` 等于 A（交互式恢复保持会话 ID），`state/declined.json` 含 A；第二次没有出现确认对话，角色为 `unmanaged`，消息正常得到回答。(b) 回答在前台完成后窗格显示 `backgrounded · <id>`；新后台会话记录为负责人，B 在 `previousSessionIds`；`claude attach <id>` 后再发一条消息，回答带架构师上下文 |
| E5 架构师工具限制（U9） | 对 E3 的架构师 `claude attach`，依次请它：(1) 用 Edit 改 `greet.py`；(2) 用 Write 写 `.planning/findings.md`，再用 Edit 在其末尾加一行 `e5-edit`；(3) 运行 `touch x`；(4) 运行 `git status` | (1)、(3) 被拒（任务日志无写入，`greet.py` 不变，`$E/proj/x` 不存在）；(2)、(4) 成功。U9：`$E/proj/.planning/findings.md` 含 `e5-edit`；`claude agents --json` 中该会话的 `cwd` 仍为 `$E/proj`；`$E/proj/.claude/worktrees/` 不存在；`git -C $E/proj worktree list` 只列出项目本身 |
| E6 子代理路由（U8） | 对 E3 架构师依次请求：(1) “委派一个子代理：给 greet.py 加一个 main 函数并运行验证”；(2) “委派子代理对这次修改做独立审查”；(3) “用不同模型复核这次修改，[review-of agent=<(1) 的 agentId>]”；(4) “用 Haiku 委派一个子代理统计文件行数”；(5) “用 Haiku 委派，理由是我指定的”；(6) “用 Fable 5.1 委派一个子代理（我指定的），让它不指定模型再委派一个子代理统计 greet.py 的行数” | (1) `agent.spawn` 记录 `code-change`，模型 Opus 5.5（Jev 深入推理概率达到 0.95 时为 Mythos 5.2），说明第一行为任务标记，Magpie 用量中该子代理的强度为 high；(1) 的 `cwd` 为项目目录 `$E/proj`；(2) `review`、Opus、medium 或 high；(3) `review-second`，模型 Sol 6.1；(4) 被拒，拒绝理由中有 `model-reason`；(5) 采用 Haiku，选择类型 `user`；(6) Fable 子代理选择类型 `user`，它的嵌套委派登记在同一任务下（`parentAgentId` 为 Fable 子代理），选择类型 `rule`，没有被拒，模型为规则模型（经 `requestId`，不是 subagent-opus 写入的别名 `opus`）；子代理模型都不是 subagent-opus 改写的 `opus` |
| E7 文件冲突 | 对 E3 架构师请求：“委派后台子代理 A：把 greet.py 的 hello 改成 hi，然后运行 `sleep 60`，再运行 `python3 greet.py`。等 greet.py 出现 hi 之后，委派后台子代理 B：把 greet.py 输出的词改成 hey 并运行 `python3 greet.py`。B 的写入被拒后，调用 `resolve_conflict`，`agent_id` 为 B，`decision` 为 `separate`。” | B 对 greet.py 的第一次写入被拒，拒绝理由要求它停止并报告；B 的记录 `paused`，任务有一个 `file-conflict` 决定，Telegram 收到冲突问题（索引 `long` 加 `decisionId`），架构师窗口有一行冲突说明；`resolve_conflict` 之后决定已解决，`$E/wt/<id>-<B 的 agentId>` 存在，B 的记录 `worktree` 为该路径，任务日志有 B 的 `relay`（唤醒）；B 在单独副本中完成，整合日志 `integration-start` 与 `integration`（`applied`）成对出现，项目目录的 greet.py 输出 hey；A 的记录不受影响 |
| E8 日常任务（终端，U3） | `mkdir $E/repo && cd $E/repo && git init && printf 'print("hello")\n' > greet.py && git add . && git commit -m init && echo '# note' >> README.md`；`start e8 $HOME env MAGPIE_TASKS_ROLE=router claude-magpie --model 'claude/claude-opus-5-5[1m]' --plugin-dir ~/sipeng/claude-mods/mods/tg-router`；在窗格输入：(a) `在 $E/repo 里给 greet.py 加一个 --name 参数（默认 world），输出 hello <name>；再补一个 test_greet.py，用 subprocess 检查带参数和不带参数两种调用；运行测试验证`；脚本在任务日志出现验收子代理的 `spawn` 时建立 `$E/state/locks/project-<fnv1a64(realpath $E/repo)>.lock`（写入当前时间的 `owner.json`），在插件调试日志出现该锁的等待行之后再保持 15 秒才删除；(b) `在 $E/repo 里把 greet.py 输出里的 hello 改成 hi，并运行 python3 greet.py 验证`；(c) `统计 $E/repo/greet.py 有几行，只回答数字`；(d) 一条没有匹配规则的请求（例如为一段混合任务挑选模型），在评估回答后输入“确认” | (a) 日常任务记录 `code-change`；执行者调用 `open_project`，任务直接修改 `$E/repo`（`direct.dir`，没有工作副本）；日志 `check` 判断为需要验收，验收子代理经中转启动，结论写入记录；结果在锁删除之后记录（`integration`（`in-place`）的时间晚于锁等待行至少 15 秒），调试日志中 magpie-tasks 的钩子没有超时（没有 `expired` 或被当作不存在的记录）；之后 `python3 greet.py --name Ann` 输出 `hello Ann`，`README.md` 的未提交改动仍在，`git rev-list --count HEAD` 仍为 1，基线引用已越过第一次的基线提交；Router 窗格没有验收或整合报告。(b) 日志 `check` 判断为不需要验收，没有验收子代理，改动直接记为结果（`in-place`），`python3 greet.py` 输出 `hi world`，任务 `done`，Router 窗格没有验收或整合报告；Router 把这条请求转给 (a) 的执行者时，任务日志有 `outcome-told`（`in-place`）。(c) 日志 `check` 判断为不需要验收，没有验收子代理，任务 `done`，没有 `integration` 日志，Router 窗格没有验收或整合报告。(d) 评估子代理为 Opus/xhigh，确认后执行者模型为推荐模型且选择类型 `assessment-confirmed` |
| E9 Telegram 连接（U2、U5，需要用户） | 用户同意暂停常驻的 `claude-telegram` 后，用新的启动脚本在独立配置目录中启动 Router；用户在手机上：(1) 发“把这条转给 greet 那个长期任务：greet.py 现在输出什么？”；(2) 回复架构师发回的消息“再确认一次”；(3) `claude stop <架构师 ID>` 后回复 (2) 的回答；(4) 发一个日常请求，等完成后回复 `评分 4`；(5) 让架构师按 E7 的步骤再委派一次，但不调用 `resolve_conflict`，用户回复 Telegram 中的冲突问题“给它单独副本” | (1) Router 调用 `forward_long`，`isDelivered` 为真，架构师回答经 Bot API 作为回复出现；(2) 由 magpie-tasks 直接转给架构师，Router 不产生回合；(3) 插件用 `claude --bg --resume <完整 ID>` 恢复，会话 ID 不变，回答送达，恢复后的会话按 U9 的检查仍在 `$E/proj`；(4) 任务 `ratings` 有一条 4 分；(5) Router 的调试日志记录判断结果 `separate`，转交标记带 `decision=<id> answer=separate`，架构师会话在模型回合开始前执行决定（日志 `decision` 的会话为架构师会话），单独副本被建立、被暂停的子代理经中转唤醒，架构师的回答经 Bot API 回复用户 |
| E10 恢复 | E3 的架构师 `claude stop`；任务保持 `running`；删除 `$E/state/state/recovery.json`（E3 的启动恢复在 10 分钟内运行过）；`start e10 $E claude-magpie --model claude/claude-haiku-5-5`，不发送消息，等恢复日志出现后关闭窗格 | 恢复日志 `recovery`；架构师会话以原 ID 重新运行（`claude agents --json`），收到恢复说明 |
| E11 评分与校准 | 在 E9 环境中把 `ratingHour` 设为当前小时（`/config` 修改插件选项），已有一个当天完成的任务 | 当天发出一次邀请，第二次定时检查不再发；回复 `5` 记录评分。校准检查对 E8、E9 产生的真实记录运行一次，条件不足时只更新 `lastCheckAt` |
| E12 JEV 跳过 | E6、E8 运行期间的 JEV 日志 | 每个带任务标记的子代理，每一轮运行在 JEV 日志中恰好一条 `skip` 记录（`reason: 'magpie-tasks'`），没有 `prompt`/`step` 判断行，也没有 Jev 请求；Magpie 用量中这些子代理的强度等于插件设置的强度；中转消息（`[magpie-tasks spawn …]`）没有判断行；Router 与架构师主对话照常有判断行 |
| E13 替代判断 | E8 的环境中把插件选项 `jevKeyFile` 改为不存在的 `$E/missing.key`，重启 Router，输入 `在 $E/repo 里把 greet.py 的 hi 改成 hey，并运行 python3 greet.py 验证` | 执行者的代理记录 `judgment.provider === 'substitute'`，`substituteReason` 为 `key file missing`，判断由 `evaluatorModel` 给出（Magpie 用量中有该模型的一次请求）；Router 窗格的路由说明含“由评估模型代为判断”；任务照常完成验收与整合 |
| E14 模型不可用（U11） | 对 E3 架构师请求：“按我的指定用模型 `codex/gpt-6-magpie-missing` 委派一个子代理统计 greet.py 的行数，说明中写 `[model-reason user: 测试不可用模型]`” | 启动被接受，选择类型 `user`；插件调试日志记录该子代理的 `StopFailure`（`agent_id` 相同，分类属于不可用集合）与 `reason: error` 的 `turn.complete`；代理记录 `state: 'failed'`、`failure.kind: 'model-unavailable'`；任务有 `model-unavailable` 决定，架构师窗口有一行说明，Telegram 收到问题；没有自动启动接手者 |
| E15 流程出错 | `mkdir $E/proj3`，其中 `git init`，提交 `a.txt`，再写一个未提交的 `b.txt`；`chmod -R a-w $E/proj3/.git/objects`（基线快照写不进对象库）；`start e15 $E/proj3 claude-magpie`；发送 `检查 a.txt`，在确认对话中选推荐项；结束后 `chmod -R u+w $E/proj3/.git/objects` | 窗格显示 `magpie-tasks 出错（任务 <id>）：…` 的提示与 `Prompt dropped by a hook: magpie-tasks 出错：…`，消息没有交给模型；Telegram 收到含任务 ID 与错误首行的通知；任务记录 `state: 'error'`，`error` 含基线快照失败的原因；`claude agents --json` 中没有新的后台会话；前台窗格仍在运行 |

E9 与 E11 需要暂停用户常驻的 `claude-telegram` 并由用户在手机上发消息，开始前另外征得用户同意。全部场景通过后，正式安装 `claude plugin install magpie-tasks@sipeng-mods --scope user`（在 jev 与 subagent-opus 之后），替换 `/home/ubuntu/.local/bin/claude-telegram`，由用户重新启动常驻 Router。

### 12.3 Jev 规则判定的标注与评分（U7）

`eval/rules-eval.ts`（bun 运行）：

- `extract`：从 `~/.claude/projects/**/subagents/agent-*.jsonl` 取最近的委派说明（第一条 user 文本），去掉控制行，写 `~/.config/magpie-tasks/eval/briefs.jsonl`。
- `sheet`：对每条说明请求一次 Jev（规则与 deep），把判断与说明写成标注表，由用户标注正确规则（可标 `none`）与是否需要深入推理。
- `score`：按标注计算规则准确率、`none` 的召回、各门槛下的覆盖率与准确率，输出建议门槛。

费用按 2026-11-09 实测价格在 1 美元以内。用户不做逐件标注（用户决定，2026-11-10）：`sheet` 生成的判断表用于比较问题措辞；规则文件使用第 4.1 节的起始值，门槛与分界由第 9.14 节的校准按实际结果（提高强度、返工、更换模型、评分）调整，记录中保留每次判断的完整概率，供之后重新评估。

## 13. 工作包

| 包 | 负责的文件 | 提供的接口 | 依赖的接口 |
| --- | --- | --- | --- |
| A 规则与模型 | `rules/routing-rules.json`、`src/rules.ts`、`src/model.ts`、`src/jevconfig.ts`、`io-tests/rules.spec.ts`、`io-tests/model.spec.ts` | 第 4.5、4.6 节 | C 的 `types.ts`、`io.ts` |
| B Jev 判断 | `src/jev.ts`、`src/dialogue.ts`、`src/judge.ts`、`tests/jev.test.ts`、`tests/dialogue.test.ts`、`tests/judge.test.ts`、`tests/data/api-*.json`（探测转储）与嵌入它们的 `tests/data/api-dumps.ts`、`tests/data/jev-*.json`（保存的 Decisions 响应）与 `tests/data/jev-responses.ts`、`tests/data/jev-rules.ts`、`io-tests/jev.spec.ts`、`io-tests/judge.spec.ts`、`eval/rules-eval.ts` | 第 6 节（含 `judgeBlocker`） | A 的 `Rules`、`jevChoices`；C |
| C 登记与基础 | `src/types.ts`、`src/io.ts`、`src/lock.ts`、`src/registry.ts`、`io-tests/node-io.ts`、`io-tests/tsconfig.json`、`io-tests/lock.spec.ts`、`io-tests/registry.spec.ts` | 第 3.3、3.4、7 节 | 无 |
| D 工作副本与整合 | `src/git.ts`、`src/integrate.ts`、`src/conflict.ts`、`io-tests/git.spec.ts`、`tests/conflict.test.ts` | 第 9.9、9.10 节 | C |
| E 会话与架构师 | `src/session.ts`、`src/trust.ts`、`io-tests/trust.spec.ts`、`src/launch.ts`、`src/gate.ts`、`src/architect.ts`、`src/recovery.ts`、`tests/session.test.ts`、`tests/launch.test.ts`、`tests/gate.test.ts`、`tests/recovery.test.ts`、`tests/data/agents-*.json`（`claude agents --json --all` 输出）、`tests/data/installed-plugins-*.json` | 第 2 节（`bgIsolationAnswer`）、9.1–9.5、9.9（冲突流程）、9.12（架构师接收、回复与决定标记）、9.13 节；`launchArchitect`、`resumeSession`、`listAgents` 供 G 使用；`applyLongDecision`（长期任务的全部决定） | A、B、C、D、F 的 `relay`、G 的 `telegram.send` |
| F 子代理路由与日常任务 | `src/brief.ts`、`src/spawn.ts`、`src/daily.ts`、`src/unavailable.ts`、`tests/brief.test.ts`、`tests/spawn.test.ts` | 第 9.6–9.8、9.11、9.16 节；`relay`、`applyDailyDecision`（日常任务的全部决定） | A、B、C、D、G 的 `telegram.send` |
| G Telegram、Router 与配套 | `src/telegram.ts`、`src/router.ts`、`src/calibration.ts`、`tests/telegram.test.ts`、`tests/router.test.ts`、`tests/calibration.test.ts`、`tests/data/channel-*.txt`（实测的 channel 块）；`mods/tg-router/**`；`examples/claude-telegram/claude-telegram`、`examples/claude-telegram/README.md`、`/home/ubuntu/.local/bin/claude-telegram` | 第 9.12（Router 侧：回复路由、决定回答的判断与转交、`promote_task`）、9.14、10.1、10.3 节 | B、C、D 的 `createWorktree`、E 的 `launch` 与转交标记的格式（第 9.12 节）、F 的 `relay` 与 `applyDailyDecision` |
| H 接线与发布 | `.claude-plugin/plugin.json`、`.claude-plugin/types/`、`tsconfig.json`、`hooks/hooks.json`、`hooks/register.ts`、`src/state.ts`、`src/tools.ts`、`io-tests/package.json`、`mods/magpie-tasks/README.md`、`e2e/*.sh`；`.claude-plugin/marketplace.json`、根 `README.md` | 第 3.5 节的 `Ctx`、`PromptResult`、`freshState`、`ctxFor`；第 8、9.15、10.4、12.2 节 | 全部 |

工作包之间的约定：

- 第 3.3 节的类型与第 3.4 节的 `Io` 由 C 原样实现，`Ctx` 由 H 在 `src/state.ts` 中实现；其他包按签名编写，不等 C、H 完成。
- 各流程模块导出的处理函数统一为 `(ctx: Ctx, e, next?) => Promise<…>` 或纯函数，不直接注册事件；H 负责注册与按角色分派。
- 决定按任务负责人分给执行者：长期任务（`owner.kind === 'session'`）的全部决定由 E 的 `applyLongDecision` 在架构师会话中执行；日常任务（`owner.kind === 'agent'`）的全部决定由 F 的 `applyDailyDecision` 在 Router 会话中执行；G 负责把用户的回复送到对应的会话：长期任务的回复由 G 判断出回答后写进转交标记，日常任务的回复原样交给 `applyDailyDecision`，在其中判断。
- 跨包调用只用本计划列出的函数名与签名。需要新的跨包函数时，提出方写清签名，由 H 的负责人更新本计划第 13 节后再实现。
- `tests/data/` 中的每个文件归上表列出它的工作包，由该包从真实来源复制或保存，不手写。
- 说明文字（模型读的英文、用户读的中文）放在使用它的模块中，不设共享文字模块。
- 所有改动保留工作区中现有的未提交修改；不做 Git 提交、推送、建分支或 stash。本计划不修改 `mods/jev`（第 10.2 节）。

已实现的跨包辅助导出（按“提出方写清签名”的约定登记，调用方只用这些名字）：

```ts
// src/session.ts（E）
export function judgeCtxOf(ctx: Ctx): JudgeCtx
export function notice(ctx: Ctx, text: string): void                                   // ctx.host.ui.log(text)
export function telegramReport(ctx: Ctx, task: TaskRecord, text: string, a?: { decisionId?: string; replyTo?: number }): Promise<number | null>   // 聊天为 tui 或没有聊天时写入会话
export function architectFirstMessage(request: string, taskId: string, worktree: string): string
// src/launch.ts（E）
export function claudeConfigDir(io: Io): Promise<string>
// src/daily.ts（F）
export function askDecision(ctx: Ctx, task: TaskRecord, d: { kind: Decision['kind']; question: string; options: string[]; data: Record<string, string> }, state: TaskRecord['state']): Promise<Decision>
export function tell(ctx: Ctx, task: Pick<TaskRecord, 'id' | 'title' | 'telegram'>, text: string, o: { kind: 'magpie' | 'decision' | 'long'; notify: boolean; replyTo?: number; decisionId?: string }): Promise<{ chatId: string; messageId: number } | null>
export function handOver(ctx: Ctx, task: TaskRecord, previous: AgentRecord, a: { model: string; efforts: Omit<EffortChange, 'at'>[]; selection: AgentRecord['selection']; reasonLine: string; why: string }): Promise<void>
// src/judge.ts（B）
export const UNSUITABLE_QUESTION: string
export const MODEL_OPINION_QUESTION: string
export const CONFLICT_CHOICE: { instructions: string; choices: { value: string; description: string }[] }
// src/git.ts（D）
export function baseRefName(taskId: string, agentId?: string): string
export function git(io: Io, args: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<string>
export function gitRun(io: Io, args: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<GitResult>
export function diffToFile(io: Io, dir: string, base: string, tmpIndex: string, patchPath: string): Promise<{ tree: string; files: string[] }>
export function scratchPath(io: Io, dir: string, suffix: string): Promise<string>
// src/brief.ts（F）
export const TASK_RULES_LINE = '[magpie-tasks task-rules]'                              // withRouting 追加的任务规则的第一行，briefForJev 从这里截断
```

接口请求的处理结果：

- 工作包 G：`$` 放在 `Ctx` 中使模块无法通过 `claude plugin validate`。`Ctx` 带 `host`（第 3.5 节），流程模块写 `ctx.host.`。`TOOL_SPECS` 含 Router 三个工具的参数；`inputSchema` 的类型为 `Record<string, unknown>`。Router 的 `prompt.submit` 只调用 `onRouterPrompt`，`session.send` 接 `onSessionSend`，15 分钟的定时器调用 `tick`，三个 Router 工具交给 `routerTool`。
- 工作包 E：`$.ui.notice(text)` 指 `$.ui.log(text)`（第 8 节）。`onStopFailure` 把主对话的错误分类记在 `st.stopFailures.get('main')`。`Registry.readLog` 不增加：任务日志的路径 `<stateDir>/tasks/<id>.log.jsonl` 是第 7.1 节规定的存储格式，`recovery.ts` 与 `calibration.ts` 直接读取它的文字，两处的解析函数（`unfinishedIntegrations`、`completionMessageId`）都以日志文字为输入。
- 工作包 B：`withRouting` 追加的任务规则以 `[magpie-tasks task-rules]` 开头，`briefForJev` 去掉这一行及其后全部内容，续接时 Jev 读到的说明与启动时相同。`io-tests/package.json` 提供 `@types/bun`。
- 工作包 A：规则与模型的测试在 `io-tests/rules.spec.ts`、`io-tests/model.spec.ts`（第 12.1 节）。
- 工作包 F：评估代理被替换时保留用户最初指定的模型。`TaskRecord.requestedModel`（第 3.3 节）记下用户指定、而路由规则没有给出思考强度的模型及用户的原话；`decideSpawn` 走评估分支时在 `SpawnDecision.requestedModel` 中带出它，`onAgentSpawn` 写入任务记录，`handOver` 为接手的评估子代理调用 `assessmentBrief(task, rules, task.requestedModel)`。

集成顺序：

1. C、A 与 H 的骨架一起合入：骨架为 `plugin.json`、`hooks/hooks.json`、只导出空 `register` 的 `hooks/register.ts`、`src/state.ts`（`Ctx`、`PromptResult`、`freshState`、`ctxFor`）、`tsconfig.json` 与 `.claude-plugin/types/`。`claude plugin test` 要求插件目录中有真实的钩子模块（`.planning/progress.md` 记录的测试运行器要求），骨架让 A 的单元测试从这一步起就能运行。检查：`claude plugin validate mods/magpie-tasks`、`claude plugin test mods/magpie-tasks`（A 的测试）、`bun test io-tests/lock.spec.ts io-tests/registry.spec.ts`、两个 `tsc`。
2. B、D 合入，各自单元测试与 `io-tests` 通过。
3. E、F、G 合入（G 包括 tg-router 修改与启动脚本），各自测试通过，`claude plugin test mods/tg-router` 通过。
4. H 完成接线；`claude plugin validate`、两种单元测试、类型检查全部通过。
5. 确认 JEV 的 Jev 上下文改造已合入仓库（第 10.2 节）。征得用户同意发送测试通知后，在独立配置目录中先运行 U10 的探测与 U3 的对照，再运行 U1、U3、U4、U6、U9 对应的 E3、E8、E4、E5，然后运行 E1、E2、E6、E7、E10、E14（U11）、E12、E13、E15。E14 留下一个等待用户的决定，启动恢复不会再恢复这样的任务，所以 E14 在 E10 之后。
6. 征得用户同意后运行 E9、E11（U2、U5），全部通过后正式安装与替换启动脚本。
7. 门槛与分界由第 9.14 节的校准按实际结果调整，用户确认后提高规则版本。
