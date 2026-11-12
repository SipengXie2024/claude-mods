// The tools magpie-tasks registers, by session role (plan sections 9.5, 9.11, 9.12). Their calls are
// served by register.ts's tool.call hook: architect tools by architect.ts, Router tools by router.ts,
// open_project by daily.ts, session_agents by agents.ts. Descriptions are for the model and in English.
import type { Ctx } from './state'
import type { Role } from './types'

export type ArchitectToolName = 'model_route' | 'task_status' | 'report_outcome' | 'integrate' | 'notify_user' | 'resolve_conflict'
export type RouterToolName = 'forward_long' | 'recommend_architect' | 'promote_task'
export type SubagentToolName = 'open_project'
// For the session's main conversation and its subagents alike.
export type SessionToolName = 'session_agents'
type ToolName = ArchitectToolName | RouterToolName | SubagentToolName | SessionToolName

const PREFIX = 'mcp__magpie-tasks__'

const ARCHITECT_TOOLS: readonly ArchitectToolName[] = ['model_route', 'task_status', 'report_outcome', 'integrate', 'notify_user', 'resolve_conflict']
const ROUTER_TOOLS: readonly RouterToolName[] = ['forward_long', 'recommend_architect', 'promote_task']
const SUBAGENT_TOOLS: readonly SubagentToolName[] = ['open_project']
const SESSION_TOOLS: readonly SessionToolName[] = ['session_agents']

const string = (description: string) => ({ type: 'string', description })

export const TOOL_SPECS: Record<ToolName, { description: string; inputSchema: Record<string, unknown> }> = {
  model_route: {
    description: 'Delegate a piece of work to a subagent. Jev judges which routing rule fits the brief and whether it needs deep reasoning, and the routing table gives the model and effort. You may recommend a model with a reason (and an effort): Jev weighs your recommendation against the table\'s choice and the table\'s notes on both models, and the table\'s choice stands unless Jev prefers yours. The subagent starts at once in the task\'s working directory and runs in the background; its result reaches you like any background subagent\'s. The answer names the model, effort and why, or why nothing was started.',
    inputSchema: {
      type: 'object',
      properties: {
        description: string('A short (3-6 words) description of the work.'),
        prompt: string('The full brief: goal, constraints, confirmed design, where the material is, and how the result is checked. Lines such as [review-of agent=<agentId>] go here too.'),
        recommended_model: string('A Magpie model ID you think suits the work better than the routing table\'s choice, such as codex/gpt-6.1-sol. Leave it out to let the table choose.'),
        recommended_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'The effort for the recommended model; without it the matched rule\'s effort is used.' },
        reason: string('Why the recommended model suits this work: the concrete evidence. Required with recommended_model.'),
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
  },
  task_status: {
    description: 'Show this long task\'s record: project main directory, the working directory of each project it changes and separate worktrees, each subagent\'s rule, model, effort with the reasons it changed, and state, the blockers (ID, description, diagnoses, model changes) and the open decisions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  report_outcome: {
    description: 'Report what you decided about a subagent\'s result. accepted: the result is recorded as a deliverable. rejected: it goes back for fixes, and its next run gets a higher effort. diagnosis: you arranged a diagnosis of a blocker. diagnosis-redelegate: you delegate the same work again after a diagnosis (higher effort next run). model-change: you move the work to another model. diagnosis, diagnosis-redelegate and model-change need blocker_id: the ID of an existing blocker (task_status lists them) when it is the same problem, or new together with a one-sentence blocker for a different problem. A second diagnosis or model change for one blocker is refused: then pause that work and discuss it with the person.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: string('The subagent whose result this is.'),
        outcome: { type: 'string', enum: ['accepted', 'rejected', 'diagnosis', 'diagnosis-redelegate', 'model-change'] },
        blocker_id: string('For diagnosis, diagnosis-redelegate and model-change: an existing blocker ID such as b1, or new.'),
        blocker: string('When blocker_id is new: the blocker in one sentence.'),
        notes: string('What you found: why it was accepted or rejected, or what the diagnosis is about.'),
      },
      required: ['agent_id', 'outcome'],
      additionalProperties: false,
    },
  },
  integrate: {
    description: 'Bring the change of every project this task changes into its project directory: the changes in a task worktree since the last integration are applied to that project\'s main directory (only its working tree: nothing is committed or pushed), and a change subagents made in a project directory itself is recorded as the result. Returns, for each project, the files applied or recorded, or the conflicting files and git\'s message, in which case the person is asked on Telegram about that project while the others are applied.',
    inputSchema: { type: 'object', properties: { note: string('What is being integrated, in one sentence.') }, additionalProperties: false },
  },
  notify_user: {
    description: 'Send the person a Telegram notification. kind decision: a key design change or anything else they must decide. kind result: a finished part of the task worth their attention. kind done: the whole task is finished; the task closes (recorded as the completion time), this session is stopped after ten idle minutes and the task worktree removed, and the person\'s next message reopens it. Do not send ordinary progress, and do not answer a message from Telegram with it: the host sends your final answer of that turn as the reply. Write text in Chinese, plain text without Markdown.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['decision', 'result', 'done'] }, text: string('The message, in Chinese.') },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
  },
  resolve_conflict: {
    description: 'Answer the file-conflict question of a subagent magpie-tasks paused because another subagent changes the same files. separate: it gets a separate worktree copied from the task worktree and is woken to continue there; its changes are merged into the task worktree when it reports done. wait: it stays paused and is woken when the other subagent finishes.',
    inputSchema: {
      type: 'object',
      properties: { agent_id: string('The paused subagent.'), decision: { type: 'string', enum: ['separate', 'wait'] } },
      required: ['agent_id', 'decision'],
      additionalProperties: false,
    },
  },
  forward_long: {
    description: 'Hand a message over to the architect of a long task: the message goes to the architect\'s session (a stopped session is resumed), and its answer is posted under the message. Use it when a Telegram or terminal message continues a long task from the list in your context.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: string('The chat_id of the message (tui for a message typed in this terminal).'),
        message_id: string('The message_id of the message.'),
        task: string('The long task\'s ID.'),
      },
      required: ['chat_id', 'message_id', 'task'],
      additionalProperties: false,
    },
  },
  recommend_architect: {
    description: 'Recommend an architect model for a daily task whose work needs sustained design discussion: the model, the reason and the limits of its evidence. Tell the person and let them confirm a model before promote_task.',
    inputSchema: { type: 'object', properties: { task: string('The tg-router worker name or the task ID.') }, required: ['task'], additionalProperties: false },
  },
  promote_task: {
    description: 'Turn a daily task into a long task once the person has confirmed its architect model: an architect session starts in the background with the task\'s request, follow-ups, reports and worktree, and later replies to the task go to it.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: string('The tg-router worker name of the daily task (or its task ID).'),
        model: string('The confirmed architect model: Opus 5.5, Astra or Sol 6.1 (name or Magpie model ID).'),
        user_confirmation: string('The person\'s words confirming the model, verbatim.'),
      },
      required: ['worker', 'model', 'user_confirmation'],
      additionalProperties: false,
    },
  },
  open_project: {
    description: 'Before changing a project for this task, name it here and change that project\'s files only in the directory this returns (cd there before Bash commands): the project directory itself while no other task changes that project in place, or a Git worktree of it when another task does. Outside Git the task always works in the directory itself. A task may change several projects: call this once for each, and the directories returned earlier stay open.',
    inputSchema: {
      type: 'object',
      properties: {
        project: string('The project\'s absolute path.'),
      },
      required: ['project'],
      additionalProperties: false,
    },
  },
  session_agents: {
    description: 'List the agents of this session other than the caller with where each stands at this moment: running a turn, waiting on background work it started, or not running after its last answer, and for a routed agent its task and how its last answer ended. Call it right before an answer says that a task, worker or check is running, has finished, or would be cut off (by a restart of the session, for one). The agents a system reminder names are the ones a message can reach, finished ones included; that reminder does not say which of them run, and a worker\'s answer speaks of the moment it was written.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
}

// architect: the architect tools; router: the Router tools; both: the subagent and session tools.
// Other roles register nothing.
export async function registerTools(ctx: Ctx, role: Role): Promise<void> {
  const names: readonly ToolName[] = role === 'architect' ? [...ARCHITECT_TOOLS, ...SUBAGENT_TOOLS, ...SESSION_TOOLS]
    : role === 'router' ? [...ROUTER_TOOLS, ...SUBAGENT_TOOLS, ...SESSION_TOOLS]
    : []
  for (const name of names) {
    const spec = TOOL_SPECS[name]
    await ctx.host.tool.register({ name, description: spec.description, inputSchema: spec.inputSchema, isDeferred: false })
  }
}

// The tool a full name (mcp__magpie-tasks__<name>) calls, and whose handler serves it.
export function toolOwner(fullName: string): { name: ToolName; kind: 'architect' | 'router' | 'subagent' | 'session' } | null {
  if (!fullName.startsWith(PREFIX)) return null
  const name = fullName.slice(PREFIX.length)
  if ((ARCHITECT_TOOLS as readonly string[]).includes(name)) return { name: name as ArchitectToolName, kind: 'architect' }
  if ((ROUTER_TOOLS as readonly string[]).includes(name)) return { name: name as RouterToolName, kind: 'router' }
  if ((SUBAGENT_TOOLS as readonly string[]).includes(name)) return { name: name as SubagentToolName, kind: 'subagent' }
  if ((SESSION_TOOLS as readonly string[]).includes(name)) return { name: name as SessionToolName, kind: 'session' }
  return null
}

export const TOOL_NAMES: readonly string[] = [...ARCHITECT_TOOLS, ...ROUTER_TOOLS, ...SUBAGENT_TOOLS, ...SESSION_TOOLS].map(n => `${PREFIX}${n}`)
