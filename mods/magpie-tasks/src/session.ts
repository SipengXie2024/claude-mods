// Session roles and the flows that make a session an architect (plan sections 2, 9.1–9.4): role
// detection at session.start, the worktree isolation answer for background sessions, the first
// message of a new long task, the launch claim of a background architect, the takeover of an
// existing session and its claim in the /bg copy, and the architect's per-turn context.
import type { Next, PromptSubmitInput, SessionStartInput, Settings, SettingsReadInput } from 'claude-code'
import { baseRefName, createWorktree, initRepo, projectStats, repoRoot } from './git'
import { fnv1a64, newId } from './io'
import type { JudgeCtx } from './judge'
import { recommendArchitect } from './judge'
import { claudeConfigDir, launchArchitect, LaunchError } from './launch'
import { canonical, displayName, sameModel } from './model'
import { contextMemoryFingerprint } from './recovery'
import type { Rules } from './rules'
import { projectTrusted, trustProject } from './trust'
import type { Ctx, PromptResult } from './state'
import { defaultChat, send } from './telegram'
import { registerTools } from './tools'
import type { Role, SessionState, TaskRecord } from './types'

const TAKEOVER_CLAIM_MS = 2 * 60_000
const EXIT_DELAY_MS = 1500
const TAKEOVER_MARK = /\[magpie-tasks takeover task=([^\s\]]+) claim=([^\s\]]+)\]/g

// ---- shared helpers ---------------------------------------------------------------------------

export function judgeCtxOf(ctx: Ctx): JudgeCtx {
  const { opts } = ctx
  return {
    io: ctx.io,
    jev: { url: opts.jevUrl, model: opts.jevModel, keyFile: opts.jevKeyFile, deadlineMs: opts.jevDeadlineMs },
    complete: (request, options) => ctx.host.model.complete(request, options),
    evaluatorModel: opts.evaluatorModel,
    rules: ctx.rules,
  }
}

// A line the person sees in the transcript (dim, never sent to the model); visible after
// `claude attach` in a background session.
export function notice(ctx: Ctx, text: string): void {
  ctx.host.ui.log(text)
}

// Sends `text` to the task's Telegram chat as a notification and indexes it as a long-task message
// (with `decisionId` when it asks for a decision), so the person's reply reaches the architect.
// A task without a chat, or a terminal one (chat 'tui'), gets the line in the transcript instead.
export async function telegramReport(ctx: Ctx, task: TaskRecord, text: string, a: { decisionId?: string; replyTo?: number } = {}): Promise<number | null> {
  const chatId = task.telegram?.chatId
  if (chatId === undefined || chatId === 'tui') {
    notice(ctx, text)
    return null
  }
  const messageId = await send(ctx.io, ctx.opts, chatId, text, a.replyTo, true)
  await ctx.reg.updateIndex(x => { x.messages[`${chatId}:${messageId}`] = { taskId: task.id, kind: 'long', ...(a.decisionId ? { decisionId: a.decisionId } : {}) } })
  return messageId
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

// The first 30 characters (code points) of the request, on one line.
function titleOf(text: string): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 30).join('')
}

// Resolves once this session's startup recovery has finished, successfully or not. Ending the
// foreground process or going to the background waits for it (section 9.1 step 4); a failure of
// recovery is reported where recovery is started and does not belong to the step that waited.
function recoverySettled(st: SessionState): Promise<void> {
  return (st.recovery ?? Promise.resolve()).then(() => undefined, () => undefined)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v.toFixed(1)} ${units[u]}`
}

// ---- role detection (section 2) ----------------------------------------------------------------

// The facts section 2 decides a role from, in its order.
export interface RoleFacts {
  baseUrl: string | undefined        // ANTHROPIC_BASE_URL
  gatewayUrl: string                 // opts.gatewayUrl
  isInteractive: boolean
  roleEnv: string | undefined        // MAGPIE_TASKS_ROLE
  ownsTask: boolean                  // the registry names this session a task's current architect
  jobDir: string | undefined         // CLAUDE_JOB_DIR
  bgSource: string | undefined       // CLAUDE_BG_SOURCE
}

// Section 2's table. 'takeover-copy' is row 5: the /bg copy becomes an architect when its takeover
// claim succeeds and is unmanaged otherwise.
export function roleRule(f: RoleFacts): 'inactive' | 'router' | 'architect' | 'takeover-copy' | 'bg-unclaimed' | 'candidate' {
  if (f.baseUrl !== f.gatewayUrl) return 'inactive'
  if (!f.isInteractive) return 'inactive'
  if (f.roleEnv === 'router') return 'router'
  if (f.ownsTask) return 'architect'
  if (f.jobDir !== undefined && f.jobDir !== '') return f.bgSource === 'slash' ? 'takeover-copy' : 'bg-unclaimed'
  return 'candidate'
}

// Decides this session's role and records it, the session ID and the directory in st; for an
// architect (a resumed one, or the /bg copy of a takeover that claimed its task) loads the task's state.
export async function detectRole(ctx: Ctx, e: SessionStartInput): Promise<Role> {
  const role = await roleOf(ctx, e)
  ctx.st.role = role
  return role
}

async function roleOf(ctx: Ctx, e: SessionStartInput): Promise<Role> {
  const { io, st, opts } = ctx
  st.cwd = e.cwd
  st.sessionId = await ctx.host.session.id()
  const baseUrl = await io.env('ANTHROPIC_BASE_URL')
  const gate = { baseUrl, gatewayUrl: opts.gatewayUrl, isInteractive: e.isInteractive }
  // Nothing else is read for a session the plugin leaves alone.
  if (roleRule({ ...gate, roleEnv: undefined, ownsTask: false, jobDir: undefined, bgSource: undefined }) === 'inactive') return 'inactive'
  const own = await ctx.reg.bySession(st.sessionId)
  const rule = roleRule({
    ...gate,
    roleEnv: await io.env('MAGPIE_TASKS_ROLE'),
    ownsTask: own !== undefined && isOwner(own, st.sessionId),
    jobDir: await io.env('CLAUDE_JOB_DIR'),
    bgSource: await io.env('CLAUDE_BG_SOURCE'),
  })
  if (rule === 'architect') {
    await loadArchitect(ctx, own!)
    return 'architect'
  }
  if (rule === 'takeover-copy') {
    const claimed = await claimTakeover(ctx)
    if (claimed === null || claimed === 'failed') return 'unmanaged'
    await loadArchitect(ctx, claimed)
    return 'architect'
  }
  return rule
}

// Whether `sessionId` is the task's current architect. A new task names the launching window as its
// owner until the background architect claims it (the claim adds jobShortId); a takeover's owner is
// the architect from the moment the person confirms.
export function isOwner(t: TaskRecord, sessionId: string): boolean {
  return t.owner.kind === 'session' && t.owner.sessionId === sessionId && (t.owner.jobShortId !== undefined || t.architect?.source === 'takeover')
}

// Loads an architect session's state from its task: the subagents this session routed (agents of
// earlier session IDs ran in other processes and cannot be continued here), their pending effort
// raises and touched files; refreshes the recorded context-memory fingerprint.
export async function loadArchitect(ctx: Ctx, task: TaskRecord): Promise<void> {
  const { st } = ctx
  st.taskId = task.id
  for (const agent of Object.values(task.agents)) {
    if (agent.sessionId !== st.sessionId) continue
    st.agents.set(agent.agentId, task.id)
    if (agent.pendingRaises.length > 0) st.pendingRaises.set(agent.agentId, [...agent.pendingRaises])
    if (agent.filesTouched.length > 0) st.touches.set(agent.agentId, new Set(agent.filesTouched))
  }
  const fingerprint = await contextMemoryFingerprint(ctx.io, await claudeConfigDir(ctx.io))
  if (task.owner.kind === 'session' && task.owner.contextMemoryFingerprint !== fingerprint) {
    await ctx.reg.update(task.id, t => { if (t.owner.kind === 'session') t.owner.contextMemoryFingerprint = fingerprint }, { type: 'fingerprint', fingerprint })
  }
}

// Section 2: every claude-magpie background session edits its start directory directly. Only a read
// of the merged settings whose flag layer points at the Magpie gateway gets worktree.bgIsolation
// 'none'; a read of one source, or settings without that flag layer, are returned as they are.
export function bgIsolationAnswer(e: SettingsReadInput, merged: Settings, gatewayUrl: string): Settings {
  if (e.source !== undefined) return merged
  const flag = e.layers.find(l => l.source === 'flag')
  const env = flag?.settings['env']
  const baseUrl = typeof env === 'object' && env !== null ? (env as Record<string, unknown>)['ANTHROPIC_BASE_URL'] : undefined
  if (baseUrl !== gatewayUrl) return merged
  const worktree = merged['worktree']
  return { ...merged, worktree: { ...(typeof worktree === 'object' && worktree !== null ? worktree : {}), bgIsolation: 'none' } }
}

export function noteStartSource(ctx: Ctx, source: SessionState['startSource']): void {
  ctx.st.startSource = source
}

// ---- the first message of a candidate session (sections 9.2, 9.4) ----------------------------------

// Background sessions start only in a trusted directory (src/trust.ts).
const UNTRUSTED = (root: string) => `Claude Code 还没有把 ${root} 记为受信任的目录，后台会话不能在那里启动。确认即表示你信任这个目录，插件会在 Claude Code 的配置中记下这一点。`

const CANCELLED = 'magpie-tasks: 已取消；消息已放回输入框，再次发送会重新询问；临时操作请使用普通 claude'
const UNRECOGNIZED = 'magpie-tasks: 没有识别出选择；消息已放回输入框，再次发送会重新询问；临时操作请使用普通 claude'

export async function onFirstPrompt(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult> {
  if (e.origin.kind !== 'composer' || e.command !== undefined || ctx.st.firstPromptSeen) return next(e)
  return ctx.st.startSource === 'resume' ? takeover(ctx, e, next) : newLongTask(ctx, e, next)
}

async function projectInfo(ctx: Ctx): Promise<{ root: string; git: { files: number; bytes: number } | null }> {
  const top = await repoRoot(ctx.io, ctx.st.cwd)
  if (top !== null) return { root: top, git: null }
  return { root: ctx.st.cwd, git: await projectStats(ctx.io, ctx.st.cwd) }
}

// The models of the confirmation options, in order: the recommendation, then the other candidates.
export function optionModels(recommended: string, rules: Rules): string[] {
  const others = rules.architect.candidates.map(c => c.model).filter(m => m !== recommended)
  if (others.length === rules.architect.candidates.length) throw new Error(`${recommended} is not an architect candidate`)
  return [recommended, ...others]
}

export function askText(a: { recommendation: { model: string; reason: string; limits: string }; root: string; worktree: string; git: { files: number; bytes: number } | null; trusted: boolean }, rules: Rules): { question: string; options: string[] } {
  const models = optionModels(a.recommendation.model, rules)
  const name = (m: string) => displayName(m, rules)
  const options = models.map((m, i) => (i === 0 ? `${name(m)}（推荐）` : name(m)))
  const lines = [
    `用哪个模型担任这个长期任务的架构师？推荐 ${name(a.recommendation.model)}。`,
    `推荐理由：${a.recommendation.reason}`,
    `证据的限制：${a.recommendation.limits}`,
    `项目根目录：${a.root}`,
    `任务工作副本：${a.worktree}`,
  ]
  if (a.git !== null) lines.push(`这个目录不是 Git 仓库。确认后会在 ${a.root} 建立 Git 仓库并提交一份基线快照：${a.git.files} 个文件，共 ${formatBytes(a.git.bytes)}。`)
  if (!a.trusted) lines.push(UNTRUSTED(a.root))
  lines.push('确认后这条消息交给后台的架构师会话，当前窗口随即关闭，之后用 claude attach 重新打开。不需要登记的临时操作请使用普通 claude。')
  return { question: lines.join('\n'), options }
}

// The architect's first message: the request, the task marker line, and its standing instructions.
export function architectFirstMessage(request: string, taskId: string, worktree: string): string {
  return [
    request,
    '',
    `[magpie-tasks architect task=${taskId} worktree=${worktree}]`,
    `You are the architect of this long task, started by magpie-tasks. The task worktree is ${worktree}: implementation subagents you delegate with the Agent tool work there, and you read their changes there by absolute path. You stay in the project main directory, where you write only .planning/findings.md, CONTEXT.md, .planning/plan-*.md and .planning/*.html; discuss goals and design with the person, delegate implementation, accept results and integrate them with mcp__magpie-tasks__integrate. Do not commit or push, whatever the background-session default says: integrated changes stay in the person's working tree for them to commit.`,
  ].join('\n')
}

async function newLongTask(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult> {
  const { io, st, opts, rules, reg } = ctx
  const { root, git } = await projectInfo(ctx)
  const chatId = await defaultChat(io, opts)
  const rec = await recommendArchitect(judgeCtxOf(ctx), e.text)
  const taskId = newId('l', await io.now())
  const worktree = `${opts.worktreeDir}/${taskId}`
  const trusted = await projectTrusted(io, root)
  const { question, options } = askText({ recommendation: rec, root, worktree, git, trusted }, rules)
  const models = optionModels(rec.model, rules)
  let answer: string
  try {
    answer = await ctx.host.ui.ask(question, { options, header: '长期任务' })
  } catch {
    // $.ui.ask rejects when the person dismisses the dialog.
    return { drop: CANCELLED }
  }
  const picked = options.indexOf(answer)
  if (picked < 0) return { drop: UNRECOGNIZED }
  const model = models[picked]!
  const now = await io.now()
  const task = await reg.create({
    id: taskId,
    kind: 'long',
    title: titleOf(e.text),
    state: 'starting',
    pausedByUser: false,
    request: e.text,
    followUps: [],
    project: { root, gitInitByPlugin: git !== null },
    worktree: null,
    extraWorktrees: {},
    owner: { kind: 'session', sessionId: st.sessionId, previousSessionIds: [], model, contextMemoryFingerprint: '' },
    architect: { model, recommendation: rec, userChoice: answer, confirmedAt: now, source: 'new' },
    telegram: { chatId },
    agents: {},
    blockers: {},
    decisions: {},
    deliverables: [],
    feedback: [],
    ratings: [],
    pendingRelays: {},
  })
  st.taskId = task.id
  if (!trusted) await trustProject(io, root)
  if (git !== null) await initRepo(io, root)
  const wt = await createWorktree(io, root, worktree, baseRefName(task.id), root)
  const ready = await reg.update(task.id, t => { t.worktree = { path: worktree, baseRef: wt.baseRef, baseCommit: wt.baseCommit } }, { type: 'worktree', path: worktree, baseCommit: wt.baseCommit, gitInit: git !== null })
  const message = architectFirstMessage(e.text, task.id, worktree)
  let shortId: string
  try {
    shortId = (await launchArchitect(ctx, { task: ready, model, message, cwd: root })).shortId
  } catch (error) {
    if (!(error instanceof LaunchError)) throw error
    st.taskId = null
    if (error.kind === 'not-started') return { drop: `magpie-tasks: 后台会话没有启动：${error.reason}` }
    const text = `magpie-tasks: 长期任务「${ready.title}」（${ready.id}）的架构师会话 ${error.shortId} 没有完成认领（${error.reason}），已停止；任务已标为出错`
    notice(ctx, text)
    await telegramReport(ctx, ready, text)
    return { drop: `magpie-tasks: 架构师会话没有完成认领（${error.reason}），已停止；消息已放回输入框` }
  }
  st.firstPromptSeen = true
  const done = `magpie-tasks: 已登记长期任务「${ready.title}」（${ready.id}），架构师 ${displayName(model, rules)} 已在后台运行。重新打开：claude attach ${shortId}`
  notice(ctx, done)
  // $.command.run is refused inside prompt.submit; a timer scheduled from here may run it. The exit
  // waits for this session's startup recovery, which `claude --bg --resume` calls must not lose.
  const { host } = ctx
  host.clock.after(EXIT_DELAY_MS, () => {
    void recoverySettled(st)
      .then(() => host.command.run({ command: 'exit' }))
      .catch((err: unknown) => host.ui.log(`magpie-tasks 出错（任务 ${ready.id}）：结束前台会话失败：${firstLine(err instanceof Error ? err.message : String(err))}`))
  })
  return { drop: done }
}

async function takeover(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult> {
  const { io, st, opts, rules, reg, catalog } = ctx
  const declined = await reg.readState<{ sessions: Record<string, number> }>('declined', { sessions: {} })
  if (declined.sessions[st.sessionId] !== undefined) return unmanaged(ctx, e, next)
  // A session that already handed its task to a /bg copy (an earlier ID of a task's owner).
  const earlier = await reg.bySession(st.sessionId)
  if (earlier !== undefined && earlier.owner.kind === 'session' && earlier.owner.previousSessionIds.includes(st.sessionId)) {
    const shortId = earlier.owner.kind === 'session' ? earlier.owner.jobShortId : undefined
    notice(ctx, `这个会话已转入后台，作为长期任务「${earlier.title}」（${earlier.id}）的架构师${shortId ? `（claude attach ${shortId}）` : ''}；这里按普通会话处理`)
    return unmanaged(ctx, e, next)
  }
  const model = canonical(await ctx.host.session.model(), catalog)
  const candidate = rules.architect.candidates.find(c => sameModel(c.model, model, catalog))
  if (candidate === undefined) {
    notice(ctx, `当前模型 ${displayName(model, rules)} 不在架构师候选（${rules.architect.candidates.map(c => c.name).join('、')}）中，这个会话不登记为长期任务`)
    return unmanaged(ctx, e, next)
  }
  const { root, git } = await projectInfo(ctx)
  const chatId = await defaultChat(io, opts)
  const taskId = newId('l', await io.now())
  const worktree = `${opts.worktreeDir}/${taskId}`
  const lines = [
    `接管这个会话，作为长期任务继续吗？接管后：登记为长期任务，沿用当前模型 ${candidate.name} 与对话历史，接入 Telegram，启用架构师的工具限制（主对话只写设计记录，实施交给子代理），本轮回答结束后转入后台（之后用 claude attach 重新打开）。`,
    `项目根目录：${root}`,
    `任务工作副本：${worktree}`,
  ]
  if (git !== null) lines.push(`这个目录不是 Git 仓库。接管后会在 ${root} 建立 Git 仓库并提交一份基线快照：${git.files} 个文件，共 ${formatBytes(git.bytes)}。`)
  const trusted = await projectTrusted(io, root)
  if (!trusted) lines.push(UNTRUSTED(root))
  lines.push('选择不接管后，这个会话以后恢复时不再询问。')
  const options = ['接管', '不接管']
  let answer: string
  try {
    answer = await ctx.host.ui.ask(lines.join('\n'), { options, header: '接管会话' })
  } catch {
    return { drop: 'magpie-tasks: 已取消；消息已放回输入框，再次发送会重新询问' }
  }
  if (answer === '不接管') {
    const at = await io.now()
    await reg.lock('declined', async () => {
      const d = await reg.readState<{ sessions: Record<string, number> }>('declined', { sessions: {} })
      d.sessions[st.sessionId] = at
      await reg.writeState('declined', d)
    })
    return unmanaged(ctx, e, next)
  }
  if (answer !== '接管') return { drop: 'magpie-tasks: 没有识别出选择；消息已放回输入框，再次发送会重新询问' }
  const now = await io.now()
  const task = await reg.create({
    id: taskId,
    kind: 'long',
    title: titleOf(e.text),
    state: 'running',
    pausedByUser: false,
    request: e.text,
    followUps: [],
    project: { root, gitInitByPlugin: git !== null },
    worktree: null,
    extraWorktrees: {},
    owner: { kind: 'session', sessionId: st.sessionId, previousSessionIds: [], model, contextMemoryFingerprint: await contextMemoryFingerprint(io, await claudeConfigDir(io)) },
    architect: { model, recommendation: { model, reason: '接管已有会话，沿用当前模型', limits: candidate.limits, judgment: null }, userChoice: answer, confirmedAt: now, source: 'takeover' },
    telegram: { chatId },
    agents: {},
    blockers: {},
    decisions: {},
    deliverables: [],
    feedback: [],
    ratings: [],
    pendingRelays: {},
  })
  st.taskId = task.id
  if (!trusted) await trustProject(io, root)
  if (git !== null) await initRepo(io, root)
  const wt = await createWorktree(io, root, worktree, baseRefName(task.id), root)
  const ready = await reg.update(task.id, t => { t.worktree = { path: worktree, baseRef: wt.baseRef, baseCommit: wt.baseCommit } }, { type: 'worktree', path: worktree, baseCommit: wt.baseCommit, gitInit: git !== null })
  st.role = 'architect'
  st.firstPromptSeen = true
  st.pendingBg = true
  await registerTools(ctx, 'architect')
  return next({ ...e, context: [...(e.context ?? []), architectContext(ready, opts)] })
}

function unmanaged(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult> {
  ctx.st.role = 'unmanaged'
  ctx.st.firstPromptSeen = true
  return next(e)
}

// Section 9.4 step 5: after the confirmed takeover's turn, once startup recovery has finished (the
// /bg ends this process), writes the takeover claim, appends the marker the /bg copy looks for and
// backgrounds the session. Returns at once; the rest runs after the hook.
export async function onTakeoverTurnEnd(ctx: Ctx): Promise<void> {
  const { st, host, io, reg } = ctx
  if (!st.pendingBg) return
  st.pendingBg = false
  const taskId = st.taskId
  if (taskId === null) throw new Error('takeover: the session has no task')
  void recoverySettled(st).then(async () => {
    const now = await io.now()
    const claimId = newId('c', now)
    await reg.putClaim({ id: claimId, kind: 'takeover', taskId, cwd: st.cwd, createdAt: now, expiresAt: now + TAKEOVER_CLAIM_MS, fromSessionId: st.sessionId })
    const appended = await host.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[magpie-tasks takeover task=${taskId} claim=${claimId}]` }] } })
    if (appended.deny !== undefined) throw new Error(`appending the takeover marker was refused: ${appended.deny}`)
    await reg.log(taskId, { type: 'takeover', claim: claimId })
    await host.command.run({ command: 'bg' })
  }).catch(async (err: unknown) => {
    const line = firstLine(err instanceof Error ? err.message : String(err))
    host.ui.log(`magpie-tasks 出错（任务 ${taskId}）：没有转入后台：${line}`)
    await reg.update(taskId, t => { t.state = 'error'; t.error = `takeover: ${line}` }, { type: 'error', during: 'takeover', error: line })
  }).catch((err: unknown) => host.ui.log(`magpie-tasks 出错（任务 ${taskId}）：没有记下接管失败：${firstLine(err instanceof Error ? err.message : String(err))}`))
}

// ---- claims ------------------------------------------------------------------------------------

async function takeLaunchClaim(ctx: Ctx, text: string): Promise<{ task: TaskRecord } | { mismatch: TaskRecord } | null> {
  const { io, st, reg } = ctx
  const hash = fnv1a64(text)
  const now = await io.now()
  const claim = await reg.takeClaim(c => c.kind === 'launch' && c.cwd === st.cwd && c.promptHash === hash && c.expiresAt > now, now)
  if (claim === undefined) {
    const other = await reg.takeClaim(c => c.kind === 'launch' && c.cwd === st.cwd && c.expiresAt > now, now)
    if (other === undefined) return null
    const error = 'launch claim hash mismatch'
    const t = await reg.update(other.taskId, x => { x.state = 'error'; x.error = error }, { type: 'claim-failed', error, claim: other.id, sessionId: st.sessionId })
    return { mismatch: t }
  }
  const jobDir = await io.env('CLAUDE_JOB_DIR')
  const fingerprint = await contextMemoryFingerprint(io, await claudeConfigDir(io))
  const model = canonical(await ctx.host.session.model(), ctx.catalog)
  const task = await reg.update(claim.taskId, t => {
    t.owner = { kind: 'session', sessionId: st.sessionId, ...(jobDir ? { jobShortId: basename(jobDir) } : {}), previousSessionIds: [], model, contextMemoryFingerprint: fingerprint }
    t.state = 'running'
  }, { type: 'claim', claim: claim.id, sessionId: st.sessionId, model })
  return { task }
}

// Section 9.3: the claim a background session makes with its first prompt. The task, 'mismatch' when
// only a claim with another hash waits in this directory (the task is then marked 'error'), or null
// when no launch claim waits here (a background session the person started).
export async function claimLaunch(ctx: Ctx, text: string): Promise<TaskRecord | 'mismatch' | null> {
  const r = await takeLaunchClaim(ctx, text)
  if (r === null) return null
  return 'mismatch' in r ? 'mismatch' : r.task
}

// The whole of section 9.3 for a 'bg-unclaimed' session's first prompt.
export async function onClaimPrompt(ctx: Ctx, e: PromptSubmitInput, next: Next<'prompt.submit'>): Promise<PromptResult> {
  const { st } = ctx
  const r = await takeLaunchClaim(ctx, e.text)
  if (r === null) return unmanaged(ctx, e, next)
  if ('mismatch' in r) {
    st.role = 'unmanaged'
    st.firstPromptSeen = true
    const t = r.mismatch
    notice(ctx, `magpie-tasks: 启动认领不符，这个会话没有登记为架构师；任务 ${t.id} 已标为出错`)
    await telegramReport(ctx, t, `magpie-tasks：长期任务「${t.title}」（${t.id}）的后台会话 ${st.sessionId} 认领失败（启动消息的散列不符），任务已标为出错，会话由启动方停止。`)
    return { drop: `magpie-tasks: 启动认领不符，这个会话没有登记为架构师；任务 ${t.id} 已标为出错` }
  }
  st.role = 'architect'
  st.firstPromptSeen = true
  await loadArchitect(ctx, r.task)
  await registerTools(ctx, 'architect')
  return next({ ...e, context: [...(e.context ?? []), architectContext(r.task, ctx.opts)] })
}

// Section 9.4 step 6, in the /bg copy's session.start: finds the last takeover marker in the copied
// conversation and takes its claim. The task (now owned by this session), 'failed' (reported), or
// null when the conversation has no marker (the person's own /bg).
export async function claimTakeover(ctx: Ctx): Promise<TaskRecord | 'failed' | null> {
  const { io, st, reg } = ctx
  let mark: RegExpExecArray | null = null
  for (const m of await ctx.host.session.messages({ as: 'api' })) {
    if (m.role !== 'user') continue
    for (const block of m.content) {
      if (block.type !== 'text' || typeof block['text'] !== 'string') continue
      for (const found of block['text'].matchAll(TAKEOVER_MARK)) mark = found
    }
  }
  if (mark === null) return null
  const [, taskId, claimId] = mark as unknown as [string, string, string]
  const now = await io.now()
  const claim = await reg.takeClaim(c => c.id === claimId && c.kind === 'takeover' && c.cwd === st.cwd && c.taskId === taskId, now)
  const jobDir = await io.env('CLAUDE_JOB_DIR')
  const shortId = jobDir ? basename(jobDir) : st.sessionId.slice(0, 8)
  if (claim === undefined) {
    const error = `takeover claim ${claimId} is missing, expired or for another directory`
    const t = await reg.update(taskId, x => { x.state = 'error'; x.error = error }, { type: 'claim-failed', error, claim: claimId, sessionId: st.sessionId })
    notice(ctx, `magpie-tasks: 接管认领失败（${error}）；这个会话没有登记为长期任务「${t.title}」（${t.id}）的架构师，按普通会话处理`)
    await telegramReport(ctx, t, `magpie-tasks：长期任务「${t.title}」（${t.id}）接管后转入后台的会话 ${st.sessionId} 认领失败（${error}），任务已标为出错。这个会话按普通会话运行：claude attach ${shortId}`)
    return 'failed'
  }
  return reg.update(taskId, t => {
    if (t.owner.kind !== 'session') throw new Error(`task ${taskId} is not owned by a session`)
    t.owner.previousSessionIds.push(t.owner.sessionId)
    t.owner.sessionId = st.sessionId
    t.owner.jobShortId = shortId
  }, { type: 'rekey', claim: claimId, from: claim.fromSessionId, to: st.sessionId, jobShortId: shortId })
}

// ---- the architect's per-turn context -----------------------------------------------------------

export function architectContext(task: TaskRecord, opts: { worktreeDir: string }): string {
  const root = task.project?.root ?? '(none)'
  const wt = task.worktree?.path ?? `${opts.worktreeDir}/${task.id} (not created yet)`
  const lines = [
    `[magpie-tasks] You are the architect of long task ${task.id} "${task.title}". Project main directory: ${root}. Task worktree: ${wt}; implementation subagents work there, and you read their changes there by absolute path (for example git -C ${wt} diff).`,
  ]
  const extra = Object.entries(task.extraWorktrees)
  if (extra.length > 0) lines.push(`Separate worktrees: ${extra.map(([agentId, x]) => `${agentId}: ${x.path}`).join('; ')}.`)
  lines.push(
    'You write only .planning/findings.md, CONTEXT.md, .planning/plan-*.md and .planning/*.html in the project main directory, and Bash runs only read-only commands and the html-plan pack and publish-plan commands. Delegate implementation, builds and tests to subagents with the Agent tool. Do not commit or push; after you accept a result, mcp__magpie-tasks__integrate applies the task worktree\'s changes to the project main directory.',
    'Delegation: delegate each piece of work with mcp__magpie-tasks__model_route (description, and the full brief as prompt). Jev judges which routing rule fits and whether the work needs deep reasoning, and the routing table gives the model and effort. When you think another model suits the work better, add recommended_model (a Magpie model ID), reason (the concrete evidence) and, if you like, recommended_effort; Jev weighs your recommendation against the table\'s choice and its notes on both models, and the table\'s choice stands unless Jev prefers yours. The subagent starts in the task worktree and runs in the background. When the person names a model, delegate with the Agent tool and put "[model <Magpie model ID>]" and "[model-reason user: <the person\'s words>]" on their own lines in the brief, with "[effort <low|medium|high|xhigh|max>]" when no rule gives its effort. For a second review by a different model, put "[review-of agent=<agentId>]" or "[review-of model=<id>,<id>]" in the brief.',
    'After checking a subagent\'s result, call mcp__magpie-tasks__report_outcome: accepted, or rejected (it goes back for fixes). Report diagnosis, diagnosis-redelegate and model-change too, with blocker_id: the ID of an existing blocker (mcp__magpie-tasks__task_status lists them) for the same problem, or new with a one-sentence blocker only for a different problem. The plugin raises that subagent\'s effort on its next run and counts diagnoses and model changes per blocker; a second one for the same blocker is refused, and you then pause that work and discuss it with the person.',
    'mcp__magpie-tasks__notify_user (kind decision or done) reaches the person on Telegram for decisions they must make and for finished results; ordinary progress is not sent. mcp__magpie-tasks__resolve_conflict answers a file-conflict question (separate or wait). Keep progress in context-memory\'s notes_write and lasting findings in .planning/findings.md.',
  )
  const blockers = Object.values(task.blockers)
  if (blockers.length > 0) lines.push(`Blockers: ${blockers.map(b => `${b.id} "${b.description}" (diagnoses ${b.diagnoses}, model changes ${b.modelChanges})`).join('; ')}.`)
  const open = Object.values(task.decisions).filter(d => d.resolvedAt === undefined)
  if (open.length > 0) lines.push(`Open decisions: ${open.map(d => `${d.id} ${d.kind}${d.data['agentId'] ? ` for agent ${d.data['agentId']}` : ''}`).join('; ')}.`)
  return lines.join('\n')
}
