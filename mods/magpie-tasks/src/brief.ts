// Briefs and control lines (plan sections 9.6, 9.11): the task marker every routed subagent's brief
// starts with, the control lines the architect, tg-router and the plugin write into a brief, the
// briefs the plugin writes itself (assessment, acceptance, diagnosis, handoff), and the final lines
// those agents end their answers with. Pure functions only.
//
// Briefs are English, as the model reads them; the final-line literals (状态：, 验收结论： …) are the
// Chinese words the plan fixes, and the person's own words stay as written.
import type { Rules } from './rules'
import { EFFORTS, type AgentRecord, type AgentRole, type Blocker, type Effort, type TaskRecord } from './types'

export interface MarkerInfo { taskId: string; role: AgentRole; ruleId: string | null; rulesVersion: string; model: string; effort: Effort }

// The marker JEV keys its skip on (`^\[magpie-tasks task=[^\]\s]+[^\]\n]*\]`, plan section 10.2).
const MARKER = /^\[magpie-tasks task=(\S+) role=(\S+) rule=(\S+) rules=(\S+) model=(\S+) effort=(\S+)\]/
const ROLES: readonly AgentRole[] = ['executor', 'implementer', 'assessment', 'acceptance', 'diagnosis', 'helper']
const EFFORT_ALT = 'low|medium|high|xhigh|max'
const COLON = '[:：]'
const SLASH = '[/／]'

function token(name: string, value: string): string {
  if (value === '' || /[\s\]]/.test(value)) throw new Error(`marker: ${name} ${JSON.stringify(value)} must be non-empty without spaces or "]"`)
  return value
}

export function marker(m: MarkerInfo): string {
  return `[magpie-tasks task=${token('task', m.taskId)} role=${token('role', m.role)} rule=${token('rule', m.ruleId ?? 'none')} rules=${token('rules', m.rulesVersion)} model=${token('model', m.model)} effort=${token('effort', m.effort)}]`
}

// The marker on the brief's first line (leading whitespace allowed, as JEV reads it), or null.
export function parseMarker(prompt: string): MarkerInfo | null {
  const m = MARKER.exec(prompt.trimStart())
  if (!m) return null
  const [, taskId, role, rule, rulesVersion, model, effort] = m
  if (!ROLES.includes(role as AgentRole)) throw new Error(`marker: unknown role "${role}"`)
  if (!EFFORTS.includes(effort as Effort)) throw new Error(`marker: unknown effort "${effort}"`)
  return { taskId: taskId!, role: role as AgentRole, ruleId: rule === 'none' ? null : rule!, rulesVersion: rulesVersion!, model: model!, effort: effort as Effort }
}

// `[model-reason user: …]` or `[model-reason evidence: …]` (either colon); the first one in the brief.
export function parseModelReason(prompt: string): { kind: 'user' | 'evidence'; text: string } | null {
  const m = new RegExp(`\\[model-reason\\s+(user|evidence)\\s*${COLON}\\s*([^\\n]*?)\\s*\\]`).exec(prompt)
  if (!m) return null
  const text = m[2]!.trim()
  if (text === '') return null
  return { kind: m[1] as 'user' | 'evidence', text }
}

// `[model <Magpie model ID>]` on a line of its own: the explicit model of a delegation. The Agent
// tool's `model` input takes only the aliases opus, sonnet, haiku and fable, so any other model is
// named in the brief. Prose that mentions the line (`add no [model ...] line`) is not one.
export function parseModelLine(prompt: string): string | null {
  const m = /^[ \t]*\[model\s+([A-Za-z0-9][A-Za-z0-9._/-]*(?:\[1m\])?)\s*\][ \t]*$/m.exec(prompt)
  return m ? m[1]! : null
}

export function parseEffortLine(prompt: string): Effort | null {
  const m = new RegExp(`\\[effort\\s+(${EFFORT_ALT})\\s*\\]`).exec(prompt)
  return m ? m[1] as Effort : null
}

// Every `[review-of agent=<id>]` and `[review-of model=<id>,<id>]` in the brief, merged.
export function parseReviewOf(prompt: string): { agents: string[]; models: string[] } | null {
  const agents: string[] = []
  const models: string[] = []
  let found = false
  // A model ID may carry the 1M suffix `[1m]` inside the brackets.
  for (const m of prompt.matchAll(/\[review-of\s+(agent|model)=((?:[^\]\[\n]|\[1m\])*)\]/gi)) {
    found = true
    const values = m[2]!.split(',').map(v => v.trim()).filter(v => v !== '')
    for (const v of values) {
      const list = m[1] === 'agent' ? agents : models
      if (!list.includes(v)) list.push(v)
    }
  }
  if (!found) return null
  return { agents, models }
}

// tg-router's request header, the brief's first line in claude-magpie (plan section 10.1).
export function parseRequestHeader(prompt: string): { chatId: string; messageId: number; worker: string } | null {
  const first = prompt.trimStart().split('\n', 1)[0]!.trim()
  const m = /^\[magpie-tasks-request daily chat=(\S+) message=(\d+) worker=([^\]\s]+)\]$/.exec(first)
  if (!m) return null
  return { chatId: m[1]!, messageId: Number(m[2]), worker: m[3]! }
}

// The person's original message in a tg-router worker brief: everything after its
// `The original message:` line. A brief without that line is not tg-router's.
export function requestText(prompt: string): string {
  const m = /^The original message:[ \t]*\n/m.exec(prompt)
  if (!m) throw new Error('requestText: the brief has no "The original message:" line')
  const text = prompt.slice(m.index + m[0].length).trim()
  if (text === '') throw new Error('requestText: the original message is empty')
  return text
}

// ---- the routed brief ------------------------------------------------------------------------

const STATUS_RULES = [
  '- End every answer with the report lines below. When the task is done, first a line `验证：` followed by one line per verification command you actually ran, each with its result. The last line is exactly one of:',
  '  状态：已完成',
  '  状态：需要用户决定',
  '  状态：受阻：<one sentence naming the obstacle>',
]

// What the plugin appends to a brief it routes, by the agent's role. `cwd` is the worktree the agent
// runs in, or null when it has none yet (a daily executor before open_worktree, a check of an answer).
export const TASK_RULES_LINE = '[magpie-tasks task-rules]'

function taskRules(m: MarkerInfo, a: { cwd: string | null; daily: boolean }): string[] {
  // The first line opens the block briefForJev cuts off: Jev judges the brief as the delegator wrote it.
  const out = [`${TASK_RULES_LINE} Task rules from magpie-tasks (task ${m.taskId}):`]
  const noRecords = '- Do not edit `CONTEXT.md` or `.planning/findings.md`; put findings, decisions and their evidence into your report.'
  const noGit = '- Do not commit, push, create branches, stash or reset; the changes are integrated by the plugin or the architect.'
  if (m.role === 'assessment') {
    out.push('- Do not do the task and do not change any file; your answer is the recommendation the person confirms.')
    return out
  }
  if (m.role === 'acceptance' || m.role === 'diagnosis') {
    out.push('- Do not edit files; you check and report. Run commands only to inspect or verify.')
    if (a.cwd !== null) out.push(`- The task worktree is \`${a.cwd}\` (your working directory); run the checks there.`)
    out.push(noGit)
    return out
  }
  if (a.cwd !== null) {
    out.push(`- Work only in the task worktree \`${a.cwd}\`: change files there and \`cd\` there before Bash commands that touch the project. Writes to any other path inside a Git repository are refused.`)
    out.push('- Files Git ignores (node_modules, build output) are not in the worktree; install dependencies there when the work needs them.')
  } else if (a.daily) {
    out.push('- If the task changes a project, first call `mcp__magpie-tasks__open_worktree` with `project` set to the project\'s absolute path, then change files only in the worktree it returns (`cd` there before Bash commands). A task that changes no project needs no worktree.')
    out.push('- If the tool says the directory is not a Git repository, ask the person whether to create one and end the turn with `状态：需要用户决定`; once they agree, call it again with `init_git: true`.')
  }
  out.push(noGit, noRecords, ...STATUS_RULES)
  return out
}

// The brief a routed subagent runs with: the marker as its first line, the brief as given (a marker
// already at its start is replaced), then the task rules.
export function withRouting(prompt: string, m: MarkerInfo, a: { cwd: string | null; daily: boolean }): string {
  let body = prompt.trimStart()
  if (MARKER.test(body)) body = body.slice(body.indexOf('\n') === -1 ? body.length : body.indexOf('\n') + 1).trimStart()
  return `${marker(m)}\n\n${body.trimEnd()}\n\n${taskRules(m, a).join('\n')}`
}

// ---- briefs the plugin writes ----------------------------------------------------------------

type TaskText = Pick<TaskRecord, 'id' | 'title' | 'request' | 'followUps' | 'telegram'>

function terminal(task: Pick<TaskRecord, 'telegram'>): boolean {
  return task.telegram === null || task.telegram.chatId === 'tui'
}

function requestBlock(task: TaskText): string {
  const lines = ['The person\'s original request:', task.request]
  if (task.followUps.length > 0) {
    lines.push('', 'Follow-up messages, oldest first:')
    for (const f of task.followUps) lines.push(`- (${f.source}) ${f.text}`)
  }
  return lines.join('\n')
}

// How an answer reaches the person and how later messages arrive, as tg-router's worker brief words
// it (mods/tg-router/src/prompts.ts workerBrief). tg-router keeps routing a task's follow-ups to the
// agent that owns it, and strips the HANDBACK lines from that agent's answers.
function answerRules(task: TaskText): string {
  return terminal(task)
    ? [
        'Your final answer of each turn is shown to the person in the terminal of the Router session. Write it in Chinese: the result first, then paths, links or commit ids. Markdown is fine.',
        'A later message about this task reaches you as a message in this conversation.',
      ].join('\n')
    : [
        'Your final answer of each turn is posted, as written, as a Telegram reply to the person. Write it in Chinese, at most 100 words before the report lines: the result first, then paths, links or commit ids. Plain text only: Telegram shows Markdown marks such as ** and backquotes as typed. Do not send or edit Telegram messages yourself; the host sends your answer. A file the message carries as attachment_file_id is fetched with the channel\'s download_attachment tool.',
        'A later Telegram message about this task reaches you as a message in this conversation. If one is not about this task, do not work on it: put a line',
        'HANDBACK <its message_id>: <one-sentence reason>',
        'in your final answer. The host gives it back to the Router and removes the line.',
      ].join('\n')
}

function effortsText(e: Effort[] | 'rule' | null): string {
  if (e === null) return 'no effort given'
  if (e === 'rule') return 'the effort of the matching rule'
  return e.join(' or ')
}

// The routing-assessment brief for a daily task no rule fits (plan section 9.11). `chosen` is the
// model the person asked for, with their words, when routing could not set its effort.
export function assessmentBrief(task: TaskText, rules: Rules, chosen?: { model: string; reason: string }): string {
  const name = (id: string) => rules.models[id]?.name ?? id
  const ruleLines = rules.rules.filter(r => r.use === 'subagent').map(r => {
    const model = r.model === null ? 'a second model different from the reviewed one (Sol 6.1 or Opus 5.5)' : `${name(r.model)} (${r.model})`
    const deep = r.deepModel === null ? '' : `; when the work needs deep reasoning ${name(r.deepModel)} (${r.deepModel}) / ${r.deepEffort}`
    const hard = r.hardModel === null ? '' : `; for its largest work (Jev's deep probability at least ${rules.thresholds.hardYes}) ${name(r.hardModel)} (${r.hardModel}) / ${r.deepEffort}`
    return `- ${r.id}: ${r.condition} → ${model} / ${r.effort ?? rules.reviewSecond.effort}${deep}${hard}. Acceptance: ${r.acceptance} Evidence: ${r.evidence}`
  })
  const subLines = rules.substitutes.map(s => {
    const options = s.options.map(o => `${name(o.model)} (${o.model}) at ${effortsText(o.efforts)}`).join('; ')
    const scope = s.forRules === '*' ? 'any rule' : s.forRules.join(', ')
    return `- ${s.id} (for ${scope}; ${s.auto ? 'evidence-backed alternative' : 'only when the person asks'}): ${options}${s.note ? `. ${s.note}` : ''}`
  })
  const person = chosen === undefined ? [] : [
    `The person asked for the model ${name(chosen.model)} (${chosen.model}) in their own words: "${chosen.reason}". Their choice of model stands: recommend the reasoning effort for it, and name a concrete limit of that model for this task only when the evidence shows one. Your 推荐模型 line names that model unless the person changes it, and so does the 选模确认 line when they confirm.`,
    '',
  ]
  return [
    chosen === undefined
      ? `You are the routing assessment for a daily task (${task.title}). No routing rule matched it with enough confidence. Do not do the task and do not change any file: recommend the model and reasoning effort it should run on.`
      : `You are the routing assessment for a daily task (${task.title}). The person chose its model, but no routing rule gives that model's reasoning effort for this task. Do not do the task and do not change any file: recommend the reasoning effort the chosen model should run at.`,
    '',
    requestBlock(task),
    '',
    ...person,
    `Routing rules (${rules.version}):`,
    ...ruleLines,
    '',
    'Substitute candidates:',
    ...subLines,
    '',
    `Reasoning efforts: ${EFFORTS.join(', ')}. Model IDs are the Magpie IDs above.`,
    '',
    answerRules(task),
    'Say which model and effort you recommend, which rule or candidate comes closest and how this task differs from it, and what the evidence does not cover. End the answer with the line',
    '推荐模型：<Magpie model ID> / <effort>',
    terminal(task)
      // E8, 2026-11-09: a typed reply reaches the agent through the Router's SendMessage, which the
      // agent otherwise reads as the coordinator speaking for the person and refuses.
      ? 'The person answers in this conversation: in this terminal task the Router relays each of their replies to you as a coordinator message, and such a message carries the person\'s own words, so it is their answer. When they confirm your recommendation or name a model, end that answer with the line'
      : 'The person answers in this conversation. When they confirm your recommendation or name a model, end that answer with the line',
    '选模确认：<Magpie model ID> / <effort>',
    'and when they decline, with the line',
    '选模确认：取消',
  ].join('\n')
}

function lastReport(executor: AgentRecord): string {
  const r = executor.reports[executor.reports.length - 1]
  if (r === undefined) throw new Error(`agent ${executor.agentId} has no report on record`)
  return r.text
}

function verificationBlock(executor: AgentRecord): string {
  const r = executor.reports[executor.reports.length - 1]
  const v = r?.verification ?? []
  return v.length === 0 ? '(the executor reported no verification command)' : v.map(x => `- ${x}`).join('\n')
}

// The acceptance brief: one independent check of a daily task's result (plan section 9.11).
// `change` is null for a task that changed no project files.
export function acceptanceBrief(task: TaskRecord, executor: AgentRecord, change: { patchPath: string; diffStat: string } | null): string {
  const lines = [
    `You are the acceptance reviewer for a daily task (${task.title}). Check the executor's result once, independently, against the person's request. Do not fix anything.`,
    '',
    requestBlock(task),
    '',
    'The executor\'s last answer:',
    lastReport(executor),
    '',
    'Verification the executor reported:',
    verificationBlock(executor),
    '',
  ]
  if (change !== null) {
    if (task.worktree === null) throw new Error(`acceptanceBrief: task ${task.id} has a change but no worktree`)
    lines.push(
      `The change is in the task worktree \`${task.worktree.path}\`, your working directory. Its diff against the task's base:`,
      change.diffStat.trimEnd(),
      `The full patch is \`${change.patchPath}\`.`,
      'Rerun the reported verification commands in the worktree, check that the result does what the request asks, and check that the change stays within what the request asks for.',
    )
  } else {
    lines.push(
      'There is no change to integrate: the task changed no project files.',
      'Check that the answer responds to the request, and that its facts and numbers can be confirmed with the executor\'s commands or the original material; rerun those commands where they can be run. Say so when no verification was run.',
    )
  }
  lines.push(
    '',
    'Answer in Chinese. When the result fails, list each problem before the last line with where it is, what triggers it, and the evidence. The last line is exactly one of:',
    '验收结论：通过',
    '验收结论：不通过',
  )
  return lines.join('\n')
}

// The diagnosis brief: an independent look at why the executor is blocked (plan section 9.11).
export function diagnosisBrief(task: TaskRecord, executor: AgentRecord, blocker: Blocker, diffStat: string | null): string {
  const reports = executor.reports.length === 0
    ? ['(none)']
    : executor.reports.map((r, i) => `Report ${i + 1} (${r.status}):\n${r.text}`)
  const where = task.worktree === null
    ? 'The task has no worktree: the executor changed no project files.'
    : `The task worktree is \`${task.worktree.path}\`. Its diff against the task's base:\n${diffStat === null ? '(no change)' : diffStat.trimEnd()}`
  return [
    `You are an independent diagnosis for a daily task (${task.title}) whose executor reports that it is blocked. Find out why, from the evidence; do not do the task yourself.`,
    '',
    requestBlock(task),
    '',
    `The executor: agent ${executor.agentId}, model ${executor.model} at effort ${executor.effort}, rule ${executor.ruleId ?? 'none'}.`,
    'Its reports, oldest first:',
    ...reports,
    '',
    `Blocker ${blocker.id}: ${blocker.description}`,
    '',
    where,
    '',
    'Answer in Chinese: what blocks the task and the evidence for it, then what should happen next. Suggest another model only when the evidence shows the model, not the task or its setup, is the obstacle. The last line is exactly one of:',
    '诊断建议：继续原代理',
    '诊断建议：更换模型 <Magpie model ID> / <effort>',
    '诊断建议：交给用户',
  ].join('\n')
}

// The brief of an agent that takes a daily task over from another (a model change or an unavailable
// model, plan sections 9.11 and 9.16).
export function handoffBrief(task: TaskRecord, a: { reason: string; previous: AgentRecord }): string {
  const p = a.previous
  const reports = p.reports.length === 0
    ? ['(none)']
    : p.reports.map((r, i) => `Report ${i + 1} (${r.status}):\n${r.text}`)
  const where = task.worktree === null
    ? 'The task has no worktree yet.'
    : `The task worktree \`${task.worktree.path}\` holds the previous agent's changes so far; continue there.`
  return [
    `You take over a daily task (${task.title}) from agent ${p.name ?? p.agentId} (${p.model} at effort ${p.effort}): ${a.reason}`,
    '',
    answerRules(task),
    '- If you need a decision from the person, end the turn with one concrete question.',
    '- Do the whole task and verify it. Report failures as failures.',
    '',
    requestBlock(task),
    '',
    'The previous agent\'s reports, oldest first:',
    ...reports,
    '',
    where,
  ].join('\n')
}

// ---- final lines -----------------------------------------------------------------------------

function lastLine(answer: string, re: RegExp): { index: number; value: string; lines: string[] } | null {
  const lines = answer.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]!)
    if (m) return { index: i, value: m[1]!.trim(), lines }
  }
  return null
}

const STATUS_LINE = new RegExp(`^\\s*[*_\`]*状态\\s*${COLON}\\s*(.+?)[*_\`]*\\s*$`)
const VERIFY_LINE = new RegExp(`^\\s*[*_\`]*验证\\s*${COLON}[*_\`]*\\s*(.*?)\\s*$`)

// The executor's status line, and the verification lines of the `验证：` block before it.
export function parseStatus(answer: string): { status: 'done' | 'needs-user' | 'blocked'; blocker?: string; verification: string[] } | null {
  const lines = answer.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = STATUS_LINE.exec(lines[i]!)
    if (!m) continue
    const value = m[1]!.trim()
    let status: 'done' | 'needs-user' | 'blocked'
    let blocker: string | undefined
    if (value === '已完成') status = 'done'
    else if (value === '需要用户决定') status = 'needs-user'
    else {
      const b = new RegExp(`^受阻\\s*${COLON}\\s*(.+)$`).exec(value)
      if (!b || b[1]!.trim() === '') continue
      status = 'blocked'
      blocker = b[1]!.trim()
    }
    return { status, ...(blocker !== undefined ? { blocker } : {}), verification: verification(lines, i) }
  }
  return null
}

function verification(lines: string[], statusIndex: number): string[] {
  for (let j = statusIndex - 1; j >= 0; j--) {
    const m = VERIFY_LINE.exec(lines[j]!)
    if (!m) continue
    const out = m[1]! === '' ? [] : [m[1]!]
    for (const line of lines.slice(j + 1, statusIndex)) {
      const t = line.trim().replace(/^[-*•]\s+/, '').trim()
      if (t !== '') out.push(t)
    }
    return out
  }
  return []
}

export function parseVerdict(answer: string): { pass: boolean; notes: string } | null {
  const hit = lastLine(answer, new RegExp(`^\\s*[*_\`]*验收结论\\s*${COLON}\\s*(不通过|通过)[*_\`]*\\s*$`))
  if (!hit) return null
  return { pass: hit.value === '通过', notes: hit.lines.slice(0, hit.index).join('\n').trim() }
}

function modelEffort(value: string): { model: string; effort: Effort } | null {
  const m = new RegExp(`^\`?([^\\s\`]+?)\`?\\s*${SLASH}\\s*\`?(${EFFORT_ALT})\`?$`).exec(value)
  if (!m) return null
  return { model: m[1]!, effort: m[2] as Effort }
}

export function parseRouteConfirm(answer: string): { model: string; effort: Effort } | 'cancel' | null {
  const hit = lastLine(answer, new RegExp(`^\\s*[*_\`]*选模确认\\s*${COLON}\\s*(.+?)[*_]*\\s*$`))
  if (!hit) return null
  if (hit.value === '取消') return 'cancel'
  return modelEffort(hit.value)
}

export function parseDiagnosis(answer: string): { action: 'continue' } | { action: 'replace'; model: string; effort: Effort } | { action: 'user' } | null {
  const hit = lastLine(answer, new RegExp(`^\\s*[*_\`]*诊断建议\\s*${COLON}\\s*(.+?)[*_]*\\s*$`))
  if (!hit) return null
  if (hit.value === '继续原代理') return { action: 'continue' }
  if (hit.value === '交给用户') return { action: 'user' }
  const m = /^更换模型\s*(.+)$/.exec(hit.value)
  if (!m) return null
  const me = modelEffort(m[1]!.trim())
  return me === null ? null : { action: 'replace', ...me }
}
