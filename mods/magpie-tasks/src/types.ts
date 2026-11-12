// Shared data types of magpie-tasks (plan section 3.3). This module imports nothing.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type Role = 'inactive' | 'candidate' | 'bg-unclaimed' | 'architect' | 'router' | 'unmanaged'
export type TaskKind = 'long' | 'daily'
export type TaskState = 'starting' | 'running' | 'paused' | 'waiting-user' | 'error' | 'done' | 'abandoned'
// 'error': a plugin flow for this task stopped on an error that was reported (section 8); the next message
// the person sends to the task (window or Telegram) sets it back to 'running'; recovery never resumes it.
export type AgentRole = 'executor' | 'implementer' | 'assessment' | 'acceptance' | 'diagnosis' | 'helper'
export type SelectionKind = 'rule' | 'ambiguous' | 'user' | 'adjusted' | 'assessment-confirmed' | 'diagnosis' | 'review-second' | 'unavailable-substitute'
export type RaiseReason = 'deep' | 'resume-deep' | 'acceptance-failed' | 'diagnosis-redelegate'

export interface Options {
  gatewayUrl: string          // http://127.0.0.1:3425
  stateDir: string            // ~/.config/magpie-tasks (expanded to an absolute path)
  worktreeDir: string         // ~/.local/share/magpie-tasks/worktrees
  jevUrl: string              // https://api.openai.com/v1/decisions
  jevModel: string            // gpt-6-luna
  jevKeyFile: string          // ~/.config/jev-opus/openai-jev.key
  jevDeadlineMs: number       // 10000
  evaluatorModel: string      // claude/claude-opus-5-5: the fixed evaluator model that judges when Jev is unavailable
  launcher: string            // claude-magpie
  claudeBin: string           // claude
  telegramStateDir: string    // ~/.claude/channels/telegram-live
  telegramChatId: string      // empty: read the single allowFrom entry of access.json
  timezone: string            // Asia/Shanghai
  ratingHour: number          // 21
}

export interface JevJudgment {
  provider: 'jev' | 'substitute'
  substituteReason?: string             // why Jev failed (when provider is 'substitute')
  ruleChoice: string                    // rule ID or 'none'
  confidence: number                    // 0..1, see section 6.2
  probabilities: Record<string, number>
  deepP: number | null
  deep: boolean
  latencyMs: number
  inputTokens: number
  cachedTokens?: number
  questionSet: string                   // 'rules-q.v5'
}

export interface EffortChange { at: number; from: Effort | null; to: Effort; reason: 'rule' | 'explicit' | RaiseReason; note?: string }

export interface AgentReport { at: number; status: 'done' | 'needs-user' | 'blocked' | 'working' | 'missing'; text: string; verification: string[] }

export interface AgentRecord {
  agentId: string
  name?: string
  description?: string                 // the Agent tool's short description; names the agent to the person
  role: AgentRole
  parentAgentId?: string
  sessionId: string                     // the session the subagent runs in
  ruleId: string | null
  rulesVersion: string
  selection: { kind: SelectionKind; reason: string; userConfirmation?: string }
  judgment: JevJudgment | null
  model: string                         // the Magpie model ID sent to the engine
  effort: Effort                        // current effort
  efforts: EffortChange[]
  reviewOf?: string[]                   // canonical IDs of the reviewed models
  contextSource: 'brief'                // ordinary subagents receive only the brief
  cwd: string
  worktree: string | null               // the directory it may write in: the task worktree, or the project directory of a direct task
  state: 'running' | 'idle' | 'paused' | 'done' | 'failed'
  pausedFor?: string                    // ID of the decision it waits for
  failure?: { at: number; kind: 'model-unavailable' | 'api-error'; error: string }   // section 9.16; error is the StopFailure category
  replacedBy?: string                   // ID of the agent that took over from it
  pendingRaises: RaiseReason[]          // raises applied when its next turn starts; mirrors st.pendingRaises and is loaded from here after a session resumes
  filesTouched: string[]
  reports: AgentReport[]
  startedAt: number
}

export interface Decision {
  id: string
  kind: 'file-conflict' | 'integration-conflict' | 'route-confirm' | 'fix-confirm' | 'model-change-confirm' | 'no-progress' | 'model-unavailable' | 'interrupted'
  // fix-confirm: a daily task's change, fixed after a failed acceptance, waits for the person (integrated on approval)
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
  id: string                            // l-YYYYMMDD-xxxxxx or d-YYYYMMDD-xxxxxx
  kind: TaskKind
  title: string
  state: TaskState
  pausedByUser: boolean
  createdAt: number
  updatedAt: number
  request: string                       // the first message, or the daily task's original request
  followUps: { at: number; source: 'telegram' | 'window'; text: string }[]
  project: { root: string } | null
  // Where the task changes its project (src/workspace.ts): `direct` while it works in the project
  // directory itself, `worktree` once it got a Git worktree because another task works there
  // directly; neither before it names a project. `dir` is the repository top, or the directory
  // itself outside Git; the base ref is absent outside Git, where no diff is taken.
  direct?: { dir: string; baseRef: string | null; baseCommit: string | null } | null
  worktree: { path: string; baseRef: string; baseCommit: string } | null
  // Files other tasks changed in `direct.dir` since this task's base: they show in its diff without
  // being its own. Cleared when its base moves.
  alsoChanged?: { taskId: string; title: string; files: string[]; at: number }[]
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
  // check: a daily turn's judgment of whether an acceptance is worth running (p is Jev's probability, null from the evaluator)
  // acceptance.fixed: the executor answered a failed acceptance with its fix; decisionId is the fix-confirm question asked about a fixed change
  // told: the outcome the executor was last told of with a message that reached it (brief.ts outcomeNote)
  // integration 'in-place': a direct task's change, already in the project directory, recorded as its result
  deliverables: { at: number; summary: string; verification: string[]; check?: { needed: boolean; p: number | null; provider: 'jev' | 'substitute' }; acceptance?: { agentId: string; pass: boolean; notes: string; fixed?: { at: number; decisionId?: string } }; told?: string; integration?: { status: 'applied' | 'in-place' | 'empty' | 'conflict'; files: string[]; at: number } }[]
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
  expiresAt: number                     // launch claims 10 minutes, takeover claims 2 minutes
  promptHash?: string                   // launch: FNV-1a of the whole message passed to --bg
  fromSessionId?: string                // takeover
}

export interface TelegramIndex {
  schema: 1
  messages: Record<string, { taskId: string; kind: 'long' | 'magpie' | 'rating' | 'decision'; decisionId?: string }>  // key `${chatId}:${messageId}`; a long task's decision question is kind 'long' plus decisionId
  workers: Record<string, { taskId: string; ownerAgentId: string; long: boolean }>                                      // key: tg-router worker name
  agents: Record<string, string>                                                                                        // agentId → worker name
}

export interface SessionState {
  role: Role
  sessionId: string
  cwd: string
  taskId: string | null
  startSource: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | null
  firstPromptSeen: boolean
  pendingBg: boolean                               // after a takeover is confirmed, send /bg when this turn ends
  recovery: Promise<void> | null                   // startup recovery started by this session; ending a foreground session waits for it
  agents: Map<string, string>                     // agentId → taskId (subagents routed in this session)
  freshSpawn: Set<string>                          // subagents this process just spawned that have not started their first turn
  pendingRaises: Map<string, RaiseReason[]>        // agentId → raise reasons for its next turn
  pendingReask: Map<string, string>                // agentId → resume message (recorded by turn.start)
  stopFailures: Map<string, string>                // agentId → classic.StopFailure error category
  replyTargets: { chatId: string; messageId: number }[]
  relay: Map<string, RelayRequest>
  touches: Map<string, Set<string>>                // agentId → absolute paths it changed
  debugOffset: number
}
