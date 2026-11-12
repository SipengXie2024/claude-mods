// The session_agents tool: where the agents of the session other than the caller stand at the moment
// of the call.
// A subagent's context names the session's agents once, when it starts, in the engine's reminder
// about SendMessage; that list holds every agent a message can reach, the ones that answered long
// ago among them. An answer that speaks of another task as running reads the engine's list here.
import type { AgentInfo, AgentStatus } from 'claude-code'
import type { Ctx } from './state'
import type { AgentRecord, AgentReport, TaskRecord } from './types'

type Row = Pick<AgentInfo, 'id' | 'name' | 'description' | 'status'>
// What the task records know of an agent magpie-tasks routed.
export type Routed = { task: Pick<TaskRecord, 'id' | 'title'>; agent: Pick<AgentRecord, 'role' | 'reports'> }

const STANDS: Record<AgentStatus, { runs: boolean; text: string }> = {
  pending: { runs: true, text: 'starting: its first turn has not begun' },
  running: { runs: true, text: 'running a turn' },
  waiting: { runs: true, text: 'waiting on background work or a subagent it started' },
  idle: { runs: false, text: 'between turns: its last turn ended, and a message can continue it' },
  completed: { runs: false, text: 'ended: its work is finished, and a message can continue it' },
  failed: { runs: false, text: 'ended on an error' },
  killed: { runs: false, text: 'stopped' },
}

// How the last answer of an agent that reports with a status line (brief.ts STATUS_RULES) ended.
const STATUS_LINE: Record<AgentReport['status'], string> = {
  done: 'ended with 状态：已完成',
  stopped: 'ended with 状态：已停止: the person told it to stop',
  'needs-user': 'ended with 状态：需要用户决定',
  blocked: 'ended with 状态：受阻',
  working: 'ended with 状态：进行中, so background work it started may still run',
  missing: 'carried no status line',
}
const REPORTS_STATUS: ReadonlySet<AgentRecord['role']> = new Set(['executor', 'implementer'])

function minutesAgo(at: number, now: number): string {
  const min = Math.max(0, Math.round((now - at) / 60_000))
  return min === 0 ? 'less than a minute ago' : `${min} min ago`
}

// An agent of a task still under way that the engine's list no longer holds, whose last answer
// waits on background work it started.
export type Unlisted = Routed & { label: string }

// The tool's answer: the agents other than `self` (absent for the main conversation, which the
// engine's list does not hold), the running ones first, then the `unlisted`.
export function sessionAgentsText(rows: readonly Row[], self: string | undefined, routed: (agentId: string) => Routed | undefined, now: number, unlisted: readonly Unlisted[] = []): string {
  const others = rows.filter(r => r.id !== self)
  const at = new Date(now).toISOString().slice(0, 19).replace('T', ' ')
  const waiting = unlisted.map(u => `- ${u.label}: not in the engine's list of agents, but its last answer, ${minutesAgo(u.agent.reports[u.agent.reports.length - 1]!.at, now)}, ended with 状态：进行中, so background work it started may still run. The ${u.agent.role} of task ${u.task.id} 「${u.task.title}」.`)
  if (others.length === 0 && waiting.length === 0) return `At ${at} UTC this session has no agent other than you: nothing else runs in it.`
  const running = others.filter(r => STANDS[r.status].runs)
  const line = (r: Row): string => {
    const known = routed(r.id)
    const last = known?.agent.reports[known.agent.reports.length - 1]
    const parts = [`- ${r.name ?? r.id} (${r.description}): ${STANDS[r.status].runs ? 'RUNNING' : 'not running'}, ${STANDS[r.status].text}.`]
    if (known !== undefined) parts.push(`The ${known.agent.role} of task ${known.task.id} 「${known.task.title}」.`)
    if (last !== undefined) parts.push(REPORTS_STATUS.has(known!.agent.role) ? `Its last answer, ${minutesAgo(last.at, now)}, ${STATUS_LINE[last.status]}.` : `Its last answer came ${minutesAgo(last.at, now)}.`)
    return parts.join(' ')
  }
  return [
    `The agents of this session other than you, at ${at} UTC: ${running.length} of ${others.length} running.`,
    ...[...running, ...others.filter(r => !STANDS[r.status].runs)].map(line),
    ...waiting,
    'This is their state at this moment. Call again before a later answer speaks of them.',
  ].join('\n')
}

export async function onSessionAgents(ctx: Ctx, agentId: string | undefined): Promise<string> {
  const rows = await ctx.host.agent.list()
  const routed = new Map<string, Routed>()
  for (const r of rows) {
    const taskId = ctx.st.agents.get(r.id)
    const task = taskId === undefined ? undefined : await ctx.reg.get(taskId)
    const agent = task?.agents[r.id]
    if (task !== undefined && agent !== undefined) routed.set(r.id, { task, agent })
  }
  const listed = new Set(rows.map(r => r.id))
  const unlisted: Unlisted[] = []
  for (const [id, taskId] of ctx.st.agents) {
    if (listed.has(id) || id === agentId) continue
    const task = await ctx.reg.get(taskId)
    const agent = task?.agents[id]
    if (task === undefined || agent === undefined || task.state !== 'running') continue
    if (agent.reports[agent.reports.length - 1]?.status === 'working') unlisted.push({ task, agent, label: agent.name ?? agent.description ?? id })
  }
  return sessionAgentsText(rows, agentId, id => routed.get(id), await ctx.io.now(), unlisted)
}
