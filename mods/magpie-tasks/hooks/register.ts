// Event wiring of magpie-tasks (plan sections 8, 9.1 and 9.15): decides the session's role at
// session.start and hands each event to the flow module of that role. Errors are handled by kind:
// flow hooks report and stop the flow, gate hooks refuse, effort hooks let the request go on.
import type { EngineInterface, PluginOptions, Register, RenderElement, TurnCompleteInput } from 'claude-code'
import { onSessionAgents } from '../src/agents'
import { architectTool, onArchitectComplete, onArchitectPrompt, onArchitectReceive, onArchitectToolCall, onSubagentComplete, onSubagentToolCall, resumeArchitectChannels } from '../src/architect'
import { agentBand, bandsRunning, bandText, clearBands, isEffort, noteBandDone, noteBandStep, noteBandTool } from '../src/band'
import { resetChannels, showNotice } from '../src/channel'
import { onDailyComplete, onOpenProject } from '../src/daily'
import { tick } from '../src/calibration'
import { expandHome, hostIo } from '../src/io'
import { catalogFrom, withRuleModels, type ModelCatalog } from '../src/model'
import { reclaim } from '../src/reclaim'
import { recover, recoverRouter } from '../src/recovery'
import { Registry } from '../src/registry'
import { onRouterPrompt, onSessionSend, routerTool } from '../src/router'
import { startRouted, unstartedRoutes } from '../src/route'
import { loadRules, type Rules } from '../src/rules'
import { bgIsolationAnswer, detectRole, loadRouter, onClaimPrompt, onFirstPrompt, onTakeoverTurnEnd } from '../src/session'
import { onAgentSpawn, onTurnStart, onTurnStep, turnRule } from '../src/spawn'
import { ctxFor, freshState, type Ctx } from '../src/state'
import { clip, defaultChat, send } from '../src/telegram'
import { registerTools, toolOwner, type ArchitectToolName, type RouterToolName } from '../src/tools'
import type { Options, SessionState, TaskRecord } from '../src/types'
import { onAgentError, onStopFailure } from '../src/unavailable'

const TICK_MS = 15 * 60_000
// How often a running subagent's band is drawn again, so the time on it moves between its tool calls.
const BAND_MS = 10_000

export function errorLine(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? String((err as { message?: unknown }).message ?? '') : String(err)
  return text.trim().split('\n')[0]?.trim() || 'unknown error'
}

// Plan section 3.3 Options from the plugin's userConfig values (defaults filled in by the engine);
// `~` is expanded with HOME.
export function optionsFrom(o: PluginOptions, home: string): Options {
  const str = (k: string): string => {
    const v = o[k]
    if (typeof v !== 'string') throw new Error(`magpie-tasks option ${k} must be a string`)
    return v
  }
  const num = (k: string): number => {
    const v = o[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`magpie-tasks option ${k} must be a number`)
    return v
  }
  return {
    gatewayUrl: str('gatewayUrl'),
    stateDir: expandHome(str('stateDir'), home),
    worktreeDir: expandHome(str('worktreeDir'), home),
    jevUrl: str('jevUrl'),
    jevModel: str('jevModel'),
    jevKeyFile: expandHome(str('jevKeyFile'), home),
    jevDeadlineMs: num('jevDeadlineMs'),
    evaluatorModel: str('evaluatorModel'),
    launcher: str('launcher'),
    claudeBin: str('claudeBin'),
    telegramStateDir: expandHome(str('telegramStateDir'), home),
    telegramChatId: str('telegramChatId'),
    telegramAfterMinutes: num('telegramAfterMinutes'),
    timezone: str('timezone'),
    ratingHour: num('ratingHour'),
  }
}

// Section 9.15: the innermost plugin decides a field, and `claude plugin install` appends a new plugin
// at the end of enabledPlugins, which makes it the innermost. magpie-tasks must come after jev and
// subagent-opus. Returns the error to show, or null when the order is right or magpie-tasks is not
// installed (a --plugin-dir load).
export function installOrderProblem(enabledPlugins: unknown): string | null {
  if (typeof enabledPlugins !== 'object' || enabledPlugins === null) return null
  const keys = Object.entries(enabledPlugins as Record<string, unknown>).filter(([, on]) => on !== false).map(([k]) => k)
  const me = keys.indexOf('magpie-tasks@sipeng-mods')
  if (me < 0) return null
  const after = ['jev@sipeng-mods', 'subagent-opus@sipeng-mods'].filter(k => keys.indexOf(k) > me)
  if (after.length === 0) return null
  return `magpie-tasks 没有生效：它必须在 ${after.join('、')} 之后安装（同一字段由最内层的插件决定，后安装的插件在最内层），现在排在它们之前。修正方法：claude plugin uninstall magpie-tasks@sipeng-mods，再 claude plugin install magpie-tasks@sipeng-mods --scope user。`
}

type Loaded = { opts: Options; rules: Rules; catalog: ModelCatalog }

// The Ctx of one hook call: the session's state, what session.start loaded and this call's `$`.
function ctxOf($: EngineInterface, st: SessionState, loaded: Loaded | null): Ctx {
  if (loaded === null) throw new Error('magpie-tasks: the session was not loaded')
  return ctxFor($, st, { ...loaded, reg: new Registry(hostIo($), loaded.opts, st.sessionId) })
}

export const register: Register = (on, options) => {
  const st = freshState()
  const gatewayUrl = typeof options['gatewayUrl'] === 'string' ? options['gatewayUrl'] : ''
  // What session.start loaded for a session the plugin manages; null while inactive.
  let loaded: Loaded | null = null
  // Agents whose effort-hook error was already shown (section 8: once per agent).
  const effortNoticed = new Set<string>()

  const managed = () => loaded !== null && st.role !== 'inactive' && st.role !== 'unmanaged'
  const routes = () => loaded !== null && (st.role === 'architect' || st.role === 'router')

  // ---- error reports (section 8) ---------------------------------------------------------------

  // A flow stopped on an error: debug log, task log and state 'error', and a report to the person.
  // An architect reports its long task's error like the plugin's other notices of that task (the
  // window first, Telegram when the person sends nothing, src/channel.ts); the Router reports on
  // Telegram; a claude-magpie window (the first message, a takeover, startup recovery) and a background
  // session not yet claimed (whose launching window reports the failed claim) report in their own
  // transcript only. Each part that fails is named in one more transcript line.
  async function reportFlowError(c: Ctx, taskId: string | null, line: string, during: string): Promise<void> {
    const failed: string[] = []
    const step = async (what: string, fn: () => Promise<void>) => {
      try { await fn() } catch (err) { failed.push(`${what}：${errorLine(err)}`) }
    }
    await step('调试日志', () => c.io.log(`flow error during ${during}${taskId ? ` (task ${taskId})` : ''}: ${line}`))
    let task: TaskRecord | undefined
    if (taskId !== null) {
      await step('任务记录', async () => {
        task = await c.reg.update(taskId, t => { t.state = 'error'; t.error = line }, { type: 'error', during, error: line })
      })
    }
    if (st.role === 'architect' && task !== undefined && task.kind === 'long') {
      const long = task
      await step('窗口通知', async () => { await showNotice(c, long, `magpie-tasks 出错（任务 ${long.id}）：长期任务「${long.title}」的流程停止：${line}`) })
    } else {
      c.host.ui.log(`magpie-tasks 出错${taskId ? `（任务 ${taskId}）` : ''}：${line}`)
    }
    if (st.role === 'router') await step('Telegram 通知', async () => {
      const own = task?.telegram && task.telegram.chatId !== 'tui' ? task.telegram : null
      const chatId = own?.chatId ?? await defaultChat(c.io, c.opts)
      // A terminal task (chat 'tui') has its report in the transcript line above.
      if (chatId === 'tui') return
      const text = task !== undefined
        ? `magpie-tasks 出错：任务「${task.title}」（${task.id}）的流程停止：${line}`
        : `magpie-tasks 出错（会话 ${c.st.sessionId}，${during}）：${line}`
      await send(c.io, c.opts, chatId, clip(text), own?.rootMessageId, true)
    })
    if (failed.length > 0) {
      const text = `magpie-tasks: 出错报告没有全部完成：${failed.join('；')}`
      c.host.ui.log(text)
      await c.io.log(text).catch(() => undefined)
    }
  }

  // A gate check failed: the call is refused (or keeps the result it already had); the error goes to
  // the debug log, the task log and the transcript.
  async function reportGateError(c: Ctx, taskId: string | null, line: string, during: string): Promise<void> {
    await c.io.log(`gate error during ${during}${taskId ? ` (task ${taskId})` : ''}: ${line}`)
    if (taskId !== null) await c.reg.log(taskId, { type: 'error', during, error: line })
    c.host.ui.log(`magpie-tasks 出错${taskId ? `（任务 ${taskId}）` : ''}：${during} 的检查失败：${line}`)
  }

  // A registered tool threw: the model reads the error as the call's refusal; the debug log, the task
  // log and the transcript keep it.
  async function reportToolError(c: Ctx, taskId: string | null, line: string, tool: string): Promise<void> {
    await c.io.log(`tool error ${tool}${taskId ? ` (task ${taskId})` : ''}: ${line}`)
    if (taskId !== null) await c.reg.log(taskId, { type: 'error', during: tool, error: line })
    c.host.ui.log(`magpie-tasks: ${tool} 被拒绝${taskId ? `（任务 ${taskId}）` : ''}：${line}`)
  }

  // An effort hook failed: the request goes on with the engine's effort; the error is logged, shown
  // once per agent and noted on the agent's effort history for calibration.
  async function reportEffortError(c: Ctx, agentId: string | undefined, err: unknown, during: string): Promise<void> {
    const line = errorLine(err)
    await c.io.log(`effort hook error during ${during}${agentId ? ` (agent ${agentId})` : ''}: ${line}`)
    const key = agentId ?? 'main'
    if (!effortNoticed.has(key)) {
      effortNoticed.add(key)
      c.host.ui.log(`magpie-tasks 出错：${agentId ? `子代理 ${agentId} ` : ''}${during} 失败（${line}）；请求按引擎原来的思考强度继续`)
    }
    const taskId = agentId === undefined ? undefined : c.st.agents.get(agentId)
    if (taskId === undefined || agentId === undefined) return
    const at = await c.io.now()
    await c.reg.update(taskId, t => {
      const a = t.agents[agentId]
      if (a !== undefined) a.efforts.push({ at, from: a.effort, to: a.effort, reason: 'rule', note: 'effort hook error' })
    }, { type: 'error', during, agentId, error: line })
  }

  // The sweep of finished tasks' worktrees and idle architects (src/reclaim.ts). A failure is reported
  // once per distinct error in this process: the timer repeats the sweep every 15 minutes.
  const sweepErrors = new Set<string>()
  async function sweep(c: Ctx): Promise<void> {
    try {
      const r = await reclaim(c)
      if (r.worktrees.length > 0 || r.architects.length > 0) await c.io.log(`reclaim: worktrees of ${r.worktrees.join(',') || '-'}; architects stopped ${r.architects.join(',') || '-'}`)
    } catch (err) {
      const line = errorLine(err)
      if (sweepErrors.has(line)) return void (await c.io.log(`reclaim (again): ${line}`))
      sweepErrors.add(line)
      await reportFlowError(c, null, line, 'reclaiming finished tasks')
    }
  }

  // An architect session started with its task's questions and notices still open (a restart, a
  // takeover's copy, a promoted daily task): they go back into the window with their remaining time.
  // It runs behind the hook; a failure is reported and leaves the task as it is.
  function resumeQuestions(c: Ctx): void {
    void resumeArchitectChannels(c).catch(async (err: unknown) => {
      const line = errorLine(err)
      c.host.ui.log(`magpie-tasks 出错${st.taskId ? `（任务 ${st.taskId}）` : ''}：没有把待回答的问题放回窗口：${line}`)
      await c.io.log(`resuming window questions${st.taskId ? ` (task ${st.taskId})` : ''}: ${line}`)
      if (st.taskId !== null) await c.reg.log(st.taskId, { type: 'error', during: 'resuming window questions', error: line })
    }).catch((err: unknown) => c.host.ui.log(`magpie-tasks 出错：没有记下放回问题的失败：${errorLine(err)}`))
  }

  function eventTask(agentId: string | undefined): string | null {
    if (agentId !== undefined) return st.agents.get(agentId) ?? null
    return st.taskId
  }

  // ---- settings and session start (sections 2, 9.1, 9.15) ----------------------------------------

  on('settings.read', async ($, e, next) => {
    const r = await next(e)
    return r.deny !== undefined ? r : { value: bgIsolationAnswer(e, r.value, gatewayUrl) }
  })

  on('classic.SessionStart', async ($, e, next) => {
    st.startSource = e.source
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const io = hostIo($)
    const home = await io.env('HOME')
    if (home === undefined || home === '') throw new Error('HOME is not set')
    const opts = optionsFrom(options, home)
    st.cwd = e.cwd
    st.sessionId = await $.session.id()
    // Section 2 rows 1 and 2 are decided before anything is loaded.
    if (await io.env('ANTHROPIC_BASE_URL') !== opts.gatewayUrl || !e.isInteractive) {
      st.role = 'inactive'
      await io.log(`role inactive (session ${st.sessionId})`)
      return r
    }
    const rules = await loadRules(io, $.plugin.root)
    loaded = { opts, rules, catalog: withRuleModels(catalogFrom(await $.settings.read({ source: 'flag' })), Object.keys(rules.models)) }
    const c = ctxOf($, st, loaded)
    const role = await detectRole(c, e)
    await io.log(`role ${role} (session ${st.sessionId}, cwd ${st.cwd})`)
    $.clock.every(BAND_MS, () => { if (bandsRunning()) $.ui.invalidate('ui.render') })
    if (role === 'candidate' || role === 'router') {
      const problem = installOrderProblem((await $.settings.read({ source: 'user' }))['enabledPlugins'])
      if (problem !== null) {
        st.role = 'inactive'
        loaded = null
        $.ui.log(problem)
        await io.log(`role inactive: ${problem}`)
        return r
      }
      // A Router's own subagents from before a restart are routed and gated again when a reply resumes them.
      if (role === 'router') await io.log(`router: ${await loadRouter(c)} subagents of earlier runs of this session loaded`)
      // Startup recovery runs behind the session; the candidate's exit and /bg wait for it. A Router then
      // recovers the daily tasks its restart cut off; both sweep what finished tasks still hold.
      st.recovery = recover(c).then(
        res => io.log(`recovery: resumed ${res.resumed.join(',') || '-'}; waiting ${res.waiting.join(',') || '-'}; reported ${res.reported.join(',') || '-'}`),
        (err: unknown) => reportFlowError(c, null, errorLine(err), 'startup recovery'),
      ).then(async () => {
        if (role === 'router') {
          await recoverRouter(c).then(
            res => io.log(`router recovery: checks rerun ${res.rerun.join(',') || '-'}; integrated ${res.integrated.join(',') || '-'}; asked ${res.asked.join(',') || '-'}`),
            (err: unknown) => reportFlowError(c, null, errorLine(err), 'Router restart recovery'),
          )
        }
        await sweep(c)
      })
    }
    if (role === 'candidate') {
      // U1: the command the first-message flow runs to end the foreground session is listed here.
      await io.log(`commands: ${(await $.command.list()).map(x => x.name).join(' ')}`)
    }
    if (role === 'router') {
      await registerTools(c, 'router')
      let ticking = false
      $.clock.every(TICK_MS, () => {
        if (ticking) return
        ticking = true
        void tick(c)
          .catch((err: unknown) => reportFlowError(c, null, errorLine(err), 'rating and calibration timer'))
          .then(() => sweep(c))
          .finally(() => { ticking = false })
      })
    }
    if (role === 'architect') {
      await registerTools(c, 'architect')
      resumeQuestions(c)
    }
    return r
  })

  // ---- prompts (flow) ------------------------------------------------------------------------------

  on('prompt.submit', async ($, e, next) => {
    if (!managed()) return next(e)
    const c = ctxOf($, st, loaded)
    switch (st.role) {
      case 'candidate': return onFirstPrompt(c, e, next)
      case 'bg-unclaimed': {
        const r = await onClaimPrompt(c, e, next)
        // The claim made this session an architect; its task may bring open questions along (a
        // promoted daily task's).
        const claimed: string = st.role
        if (claimed === 'architect') resumeQuestions(c)
        return r
      }
      case 'architect': return onArchitectPrompt(c, e, next)
      case 'router': return onRouterPrompt(c, e, next)
      default: return next(e)
    }
  }).catch(async ($, e, next) => {
    const line = errorLine(next.error)
    if (loaded === null) {
      $.ui.log(`magpie-tasks 出错：${line}`)
      return next.called ? next(e) : { drop: `magpie-tasks 出错：${line}；消息没有发出` }
    }
    const c = ctxOf($, st, loaded)
    // A Router prompt (a reply, a typed request) names no task the error can be put on.
    const taskId = st.role === 'router' ? null : st.taskId
    await reportFlowError(c, taskId, line, 'prompt.submit')
    // A failed first message leaves the window a candidate: the next message asks again.
    if (st.role === 'candidate') st.taskId = null
    return next.called ? next(e) : { drop: `magpie-tasks 出错：${line}；消息没有发出` }
  })

  on('session.send', async ($, e, next) => (routes() && st.role === 'router' ? onSessionSend(ctxOf($, st, loaded), e, next) : next(e)))
    .catch(async ($, e, next) => {
      if (loaded !== null) await reportGateError(ctxOf($, st, loaded), null, errorLine(next.error), 'session.send').catch(() => undefined)
      return next(e)
    })

  // A Telegram message that answers the architect's waiting question is taken before it is queued:
  // the turn is held by that question, and a queued message would be read only after it.
  on('session.receive', async ($, e, next) => {
    if (loaded === null || st.role !== 'architect' || e.agentId !== undefined) return next(e)
    const taken = await onArchitectReceive(ctxOf($, st, loaded), e.text)
    return taken === null ? next(e) : { consumed: taken }
  }).catch(async ($, e, next) => {
    if (loaded !== null) await reportGateError(ctxOf($, st, loaded), st.taskId, errorLine(next.error), 'session.receive').catch(() => undefined)
    return next(e)
  })

  // ---- subagents: spawn, turns, effort (sections 9.6, 9.7, 9.16) -------------------------------------

  on('agent.spawn', async ($, e, next) => (routes() ? onAgentSpawn(ctxOf($, st, loaded), e, next) : next(e)))
    .catch(async ($, e, next) => {
      const line = errorLine(next.error)
      if (loaded !== null) await reportGateError(ctxOf($, st, loaded), eventTask(e.parentAgentId), line, 'agent.spawn').catch(() => undefined)
      return next.called ? next(e) : { deny: `magpie-tasks could not route this subagent: ${line}` }
    })

  on('turn.start', async ($, e, next) => {
    if (routes() && e.agentId !== undefined) {
      const c = ctxOf($, st, loaded)
      try { await onTurnStart(c, e) } catch (err) { await reportEffortError(c, e.agentId, err, 'turn.start') }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let effort: Awaited<ReturnType<typeof onTurnStep>>
    if (routes() && e.agentId === undefined && st.routed.size > 0) {
      // The architect's next request goes out and a model_route call's subagent was never started.
      const c = ctxOf($, st, loaded)
      for (const left of unstartedRoutes(c)) await reportGateError(c, left.taskId, `PostToolBatch did not run for a model_route call; its subagent (${left.kind === 'spawn' ? left.args.description : left.id}) was not started`, 'model_route')
    }
    if (routes() && e.agentId !== undefined) {
      const c = ctxOf($, st, loaded)
      try { effort = await onTurnStep(c, e) } catch (err) { await reportEffortError(c, e.agentId, err, 'turn.step') }
      // The band names the effort the request goes out with: the engine's when the hook failed.
      if (st.agents.has(e.agentId)) {
        const step = { model: e.model, effort: effort ?? (isEffort(e.effort) ? e.effort : undefined), ruleId: turnRule(e.agentId) ?? null, engine: effort === undefined }
        if (noteBandStep(e.agentId, step, await $.clock.now())) $.ui.invalidate('ui.render')
      }
    }
    return yield* next(effort === undefined ? e : { ...e, effort })
  })

  // A model_route call's subagent is started here, once the calls of the architect's request have
  // all returned and before its next request: started inside the call's own tool.call hook, the
  // subagent's tool calls would pass this plugin's tool.call hook by (src/route.ts). The architect
  // reads how each start went with the calls' results.
  on('classic.PostToolBatch', async ($, e, next) => {
    const r = await next(e)
    if (!routes() || st.role !== 'architect') return r
    const c = ctxOf($, st, loaded)
    const notes: string[] = []
    for (const call of e.tool_calls) {
      if (!st.routed.has(call.tool_use_id)) continue
      try {
        notes.push(await startRouted(c, call.tool_use_id) ?? '')
      } catch (err) {
        const line = errorLine(err)
        await reportGateError(c, st.taskId, line, 'starting the subagent of model_route')
        notes.push(`[magpie-tasks] The subagent of a model_route call was not started: ${line}`)
      }
    }
    return notes.length === 0 ? r : { ...r, additionalContext: [...(r.additionalContext ?? []), ...notes] }
  }).catch(async ($, e, next) => {
    if (loaded !== null) await reportGateError(ctxOf($, st, loaded), st.taskId, errorLine(next.error), 'classic.PostToolBatch').catch(() => undefined)
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    if (routes()) {
      const c = ctxOf($, st, loaded)
      try { await onStopFailure(c, e) } catch (err) { await reportEffortError(c, e.agent_id, err, 'StopFailure') }
    }
    return next(e)
  })

  // ---- tools: registered tools (flow) and gates -------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    if (!managed()) return next(e)
    if (e.agentId !== undefined && st.agents.has(e.agentId) && noteBandTool(e.agentId, e.tool, e as unknown as Record<string, unknown>)) $.ui.invalidate('ui.render')
    const owned = toolOwner(e.tool)
    if (owned !== null) {
      const c = ctxOf($, st, loaded)
      const args = e as unknown as Record<string, unknown>
      try {
        if (owned.kind === 'session') return { result: await onSessionAgents(c, e.agentId) }
        // Architect and router tools belong to the session's main agent; a subagent reports its result in its answer.
        if (owned.kind !== 'subagent' && e.agentId !== undefined) return { deny: `${e.tool} is for the ${owned.kind} itself; report your result in your answer.` }
        if (owned.kind === 'architect' && st.role === 'architect') return { result: await architectTool(c, owned.name as ArchitectToolName, args) }
        if (owned.kind === 'router' && st.role === 'router') return { result: await routerTool(c, owned.name as RouterToolName, args) }
        if (owned.kind === 'subagent' && e.agentId !== undefined) return { result: await onOpenProject(c, e.agentId, { project: args['project'] }) }
        return { deny: `${e.tool} is not available here: ${owned.kind === 'subagent' ? 'only a subagent of a task calls it' : `it belongs to the ${owned.kind} session`}.` }
      } catch (err) {
        // A tool's error (an invalid argument above all) is the refusal the model reads; the task
        // goes on, so it is logged without stopping the task.
        const line = errorLine(err)
        await reportToolError(c, eventTask(e.agentId), line, e.tool)
        return { deny: `magpie-tasks: ${line}` }
      }
    }
    const c = ctxOf($, st, loaded)
    if (st.role === 'architect') return e.agentId === undefined ? onArchitectToolCall(c, e, next) : onSubagentToolCall(c, e, next)
    if (st.role === 'router' && e.agentId !== undefined) return onSubagentToolCall(c, e, next)
    return next(e)
  }).catch(async ($, e, next) => {
    const line = errorLine(next.error)
    if (loaded !== null) await reportGateError(ctxOf($, st, loaded), eventTask(e.agentId), line, `tool.call ${e.tool}`).catch(() => undefined)
    return next.called ? next(e) : { deny: `magpie-tasks could not check this tool call: ${line}` }
  })

  // ---- turn ends (flow) --------------------------------------------------------------------------------

  async function turnEnd(c: Ctx, e: TurnCompleteInput): Promise<void> {
    if (st.role === 'candidate') {
      if (e.agentId === undefined) await onTakeoverTurnEnd(c)
      return
    }
    if (st.role === 'architect') {
      if (e.agentId === undefined) return onArchitectComplete(c, e)
      await onAgentError(c, e)
      return onSubagentComplete(c, e)
    }
    if (st.role === 'router') {
      if (e.agentId === undefined) return routerTurnError(c, e)
      await onAgentError(c, e)
      return onDailyComplete(c, e)
    }
  }

  // Section 9.16: the Router's own turn ended on an API error; the person decides about the model.
  async function routerTurnError(c: Ctx, e: TurnCompleteInput): Promise<void> {
    if (e.reason !== 'error') return
    const kind = st.stopFailures.get('main')
    st.stopFailures.delete('main')
    const text = `Router 会话 ${st.sessionId} 的主对话因 API 错误结束${kind ? `（${kind}）` : ''}；模型由你决定。`
    c.host.ui.log(`magpie-tasks: ${text}`)
    const chatId = await defaultChat(c.io, c.opts)
    if (chatId !== 'tui') await send(c.io, c.opts, chatId, text, undefined, true)
  }

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined && noteBandDone(e.agentId, await $.clock.now())) $.ui.invalidate('ui.render')
    if (!managed()) return r
    const c = ctxOf($, st, loaded)
    try {
      await turnEnd(c, e)
    } catch (err) {
      await reportFlowError(c, eventTask(e.agentId), errorLine(err), e.agentId === undefined ? 'turn.complete' : `turn.complete of ${e.agentId}`)
    }
    return r
  }).catch(async ($, e, next) => {
    if (loaded !== null) await reportFlowError(ctxOf($, st, loaded), eventTask(e.agentId), errorLine(next.error), 'turn.complete').catch(() => undefined)
    return next(e)
  })

  // ---- the band above the prompt (section 9.7) ------------------------------------------------------

  // A routed subagent's transcript in view: its model, the efforts its requests carried and its rule.
  // JEV draws every other loop's band and passes this one on, since this plugin sets that effort.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const id = e.props.view.agentId
    const band = id === undefined || e.props.hasSurvey ? undefined : agentBand(id)
    if (band === undefined || loaded === null) return next(e)
    const { Text } = $.ui.resolve(e)
    // h() of an element constructor builds an element; RenderElement is the type a JSX expression has.
    return h(Text, { color: 'warning' }, bandText(band, loaded.rules, await $.clock.now())) as RenderElement
  })

  on('session.end', ($, e, next) => {
    clearBands()
    resetChannels()
    return next(e)
  })
}
