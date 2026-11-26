import type { EngineInterface, PromptComposeSection, Register } from 'claude-code'
import {
  CODE_TOOL,
  CODE_TOOL_INPUT_SCHEMA,
  CODE_TOOL_SHORT,
  DEFAULT_MAGPIE_GATEWAY,
  DEFAULT_TIMEOUT_MS,
  SECTION_ID,
  buildSystemPromptSection,
  buildToolDescription,
  clampTimeout,
  isHiddenByCodeMode,
  isMagpieGateway,
  summarizeCodeForUi,
} from '../src/protocol'

// Under claude-magpie only, port Claude Code's Code Mode:
// - Hides fragmented file/shell/search/web/MCP tools via `tool.offer`
//   (while keeping them callable inside JS scripts through `$.tool.call`)
// - Registers `mcp__magpie-code-mode__code` (isDeferred: false) backed by a
//   per-session persistent Bun VM worker over a private Unix domain socket
// - Injects Code Mode instructions and TypeScript declarations via `prompt.compose`
// Native Claude Code sessions are untouched.

interface StoredState {
  defaultEnabled: boolean
  sessions: Record<string, boolean>
}

interface WorkerHandle {
  sockPath: string
  token: string
  alive: boolean
  startedOnce: boolean
}

interface WorkerStepResponse {
  status: 'done' | 'need_tools' | 'continue'
  execId?: string
  evalNum?: number
  isError?: boolean
  output?: string
  calls?: Array<{
    id: number
    kind: 'tool' | 'sleep' | 'fs_exists' | 'search_tools' | 'describe_tool'
    tool?: string
    input?: Record<string, unknown>
    ms?: number
    path?: string
    query?: string
    max?: number
    name?: string
  }>
}

interface Runtime {
  gatewayUrl: string
  defaultTimeoutMs: number
  workers: Map<string, WorkerHandle>
  starting: Map<string, Promise<WorkerHandle>>
  registeredSessions: Set<string>
  freshContextNotice: Set<string>
  // Per-session result of the history check, for sessions without an explicit
  // /code-mode choice: false = resumed from before Code Mode existed (skip it),
  // true = Code Mode era session (follow the global default).
  sessionDecisions: Map<string, boolean>
}

const STORE_KEY = 'state'
const MAX_STORED_SESSIONS = 64

function parseState(raw: unknown): StoredState {
  const state: StoredState = { defaultEnabled: true, sessions: {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return state
  const obj = raw as Record<string, unknown>
  if (typeof obj['defaultEnabled'] === 'boolean') state.defaultEnabled = obj['defaultEnabled']
  else if (typeof obj['enabled'] === 'boolean') state.defaultEnabled = obj['enabled']
  const sessions = obj['sessions']
  if (typeof sessions === 'object' && sessions !== null && !Array.isArray(sessions)) {
    for (const [sid, value] of Object.entries(sessions)) {
      if (typeof value === 'boolean') state.sessions[sid] = value
    }
  }
  return state
}

/** Records a session choice as the most recent entry and keeps only the last MAX_STORED_SESSIONS. */
function setSessionChoice(state: StoredState, sid: string, enabled: boolean): void {
  delete state.sessions[sid]
  state.sessions[sid] = enabled
  const sids = Object.keys(state.sessions)
  for (const old of sids.slice(0, Math.max(0, sids.length - MAX_STORED_SESSIONS))) {
    delete state.sessions[old]
  }
}

/** Whether a transcript shows a session resumed from before Code Mode: earlier turns, none using the code tool. */
function isPreCodeModeHistory(messages: readonly unknown[]): boolean {
  let hasAssistantTurn = false
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue
    const { role, content } = m as { role?: unknown; content?: unknown }
    if (role === 'assistant') hasAssistantTurn = true
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (typeof b === 'object' && b !== null
        && (b as { type?: unknown }).type === 'tool_use'
        && (b as { name?: unknown }).name === CODE_TOOL) {
        return false
      }
    }
  }
  // A fresh session's first request carries only the user's prompt; requiring an
  // assistant turn keeps that prompt from being read as resumed history.
  return hasAssistantTurn
}

async function isActive($: EngineInterface, gatewayUrl: string): Promise<boolean> {
  return isMagpieGateway(await $.env.get('ANTHROPIC_BASE_URL'), gatewayUrl)
}

async function loadState($: EngineInterface): Promise<StoredState> {
  return parseState(await $.store.get(STORE_KEY))
}

async function saveState($: EngineInterface, state: StoredState): Promise<void> {
  const entries = Object.entries(state.sessions).slice(-MAX_STORED_SESSIONS)
  await $.store.set(STORE_KEY, {
    defaultEnabled: state.defaultEnabled,
    sessions: Object.fromEntries(entries),
  })
}

async function isRouterMainLoop($: EngineInterface, agentId?: string): Promise<boolean> {
  if (agentId !== undefined) return false
  return (await $.env.get('MAGPIE_TASKS_ROLE'))?.trim() === 'router'
}

async function readMainMessages($: EngineInterface): Promise<unknown[]> {
  try {
    const messages = await $.session.messages({ as: 'api' })
    return Array.isArray(messages) ? messages : []
  } catch {
    // An unreadable transcript is treated as a fresh session.
    return []
  }
}

/**
 * A session resumed from before Code Mode was installed gets the code tool only
 * through `deferred_tools_delta` while `tool.offer` already hides Bash/Read/Edit,
 * so the model calls the hidden tools and fails. Such sessions skip Code Mode
 * until the user runs `/code-mode on` in them. Decided once per session.
 */
async function isCodeModeEraSession($: EngineInterface, rt: Runtime, sid: string): Promise<boolean> {
  const cached = rt.sessionDecisions.get(sid)
  if (cached !== undefined) return cached
  const decision = !isPreCodeModeHistory(await readMainMessages($))
  rt.sessionDecisions.set(sid, decision)
  return decision
}

async function sessionEnabled($: EngineInterface, rt: Runtime, sid: string, state: StoredState): Promise<boolean> {
  if (Object.hasOwn(state.sessions, sid)) return state.sessions[sid]!
  return (await isCodeModeEraSession($, rt, sid)) && state.defaultEnabled
}

const CODE_MODE_SUBAGENT_TYPES: ReadonlySet<string> = new Set([
  'general-purpose',
  'claude',
])

function isCodeModeEligibleSubagent(agentId?: string, subagentType?: string): boolean {
  if (agentId === undefined) return true
  if (subagentType === undefined || subagentType === '') return true
  return CODE_MODE_SUBAGENT_TYPES.has(subagentType)
}

async function isCodeModeEnabled(
  $: EngineInterface,
  rt: Runtime,
  agentId?: string,
  subagentType?: string,
): Promise<boolean> {
  if (!(await isActive($, rt.gatewayUrl))) return false
  if (await isRouterMainLoop($, agentId)) return false
  if (!isCodeModeEligibleSubagent(agentId, subagentType)) return false
  return sessionEnabled($, rt, await $.session.id(), await loadState($))
}

async function workerFetch<T>(
  $: EngineInterface,
  worker: WorkerHandle,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<T> {
  const res = await $.http.fetch(`http://localhost${path}`, {
    method,
    socketPath: worker.sockPath,
    headers: {
      authorization: `Bearer ${worker.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    throw new Error(`magpie-code-mode worker HTTP ${res.status}: ${res.text.slice(0, 400)}`)
  }
  return JSON.parse(res.text) as T
}

async function ensureWorker($: EngineInterface, rt: Runtime, sid: string): Promise<{ worker: WorkerHandle; isFresh: boolean }> {
  const existing = rt.workers.get(sid)
  if (existing && existing.alive) {
    return { worker: existing, isFresh: false }
  }
  const inflight = rt.starting.get(sid)
  if (inflight) {
    return { worker: await inflight, isFresh: false }
  }

  const hadPrevious = existing !== undefined
  const startPromise = (async (): Promise<WorkerHandle> => {
    const tmpDir = (await $.env.get('TMPDIR')) || '/tmp'
    const rand = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
    const sockPath = `${tmpDir.replace(/\/+$/, '')}/magpie-cm-${sid.slice(0, 8)}-${rand}.sock`
    const token = crypto.randomUUID()
    const workerScript = `${$.plugin.root}/src/worker.mjs`
    const handle: WorkerHandle = { sockPath, token, alive: false, startedOnce: true }

    const stream = $.process.spawn({
      argv: ['bun', workerScript, sockPath, token],
    })

    let resolveReady!: () => void
    let rejectReady!: (err: Error) => void
    const readyPromise = new Promise<void>((res, rej) => {
      resolveReady = res
      rejectReady = rej
    })

    let stderrBuf = ''
    let settled = false
    const drain = (async () => {
      try {
        for await (const chunk of stream) {
          if (chunk.stream === 'stdout' && !settled && chunk.text.includes('READY')) {
            settled = true
            handle.alive = true
            resolveReady()
          } else if (chunk.stream === 'stderr') {
            stderrBuf = (stderrBuf + chunk.text).slice(-2000)
          }
        }
        handle.alive = false
        if (!settled) {
          settled = true
          rejectReady(new Error(`Code Mode worker exited before ready: ${stderrBuf.trim() || 'no output'}`))
        }
      } catch (err) {
        handle.alive = false
        if (!settled) {
          settled = true
          rejectReady(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })()
    void drain

    const timer = $.clock.sleep(10_000).then(() => {
      if (!settled) {
        settled = true
        rejectReady(new Error(`Code Mode worker start timed out: ${stderrBuf.trim() || 'no output'}`))
      }
    })

    await Promise.race([readyPromise, timer])
    if (!handle.alive) {
      throw new Error(`Code Mode worker failed to start: ${stderrBuf.trim() || 'unknown error'}`)
    }
    rt.workers.set(sid, handle)
    return handle
  })()

  rt.starting.set(sid, startPromise)
  try {
    const worker = await startPromise
    return { worker, isFresh: hadPrevious }
  } finally {
    rt.starting.delete(sid)
  }
}

async function shutdownWorker($: EngineInterface, rt: Runtime, sid: string): Promise<void> {
  const worker = rt.workers.get(sid)
  rt.workers.delete(sid)
  if (!worker || !worker.alive) return
  worker.alive = false
  try {
    await workerFetch($, worker, '/shutdown', 'POST', {})
  } catch {
    // Worker may already be gone.
  }
}

async function executeHostCall(
  $: EngineInterface,
  call: NonNullable<WorkerStepResponse['calls']>[number],
): Promise<{ id: number; value?: unknown; error?: string }> {
  try {
    if (call.kind === 'sleep') {
      await $.clock.sleep(Math.max(0, Math.min(600_000, call.ms ?? 0)))
      return { id: call.id, value: { ok: true } }
    }

    if (call.kind === 'fs_exists') {
      const exists = typeof call.path === 'string' && call.path.length > 0 ? await $.fs.exists(call.path) : false
      return { id: call.id, value: { exists } }
    }

    if (call.kind === 'search_tools') {
      const query = (call.query ?? '').toLowerCase()
      const terms = query.split(/\s+/).filter(Boolean)
      const max = call.max ?? 10
      const listed = await $.tool.list()
      const scored: Array<{ score: number; name: string; about: string; mcp: boolean }> = []
      for (const t of listed) {
        if (t.name === CODE_TOOL) continue
        const hayName = t.name.toLowerCase()
        const hayDesc = (t.description ?? '').toLowerCase()
        let score = 0
        for (const term of terms) {
          if (hayName.includes(term)) score += 3
          else if (hayDesc.includes(term)) score += 1
        }
        if (score > 0) {
          const about = (t.description ?? '').split('\n')[0]?.slice(0, 200) ?? ''
          scored.push({ score, name: t.name, about, mcp: Boolean(t.mcp) })
        }
      }
      scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      return {
        id: call.id,
        value: scored.slice(0, max).map(({ name, about, mcp }) => ({ name, about, mcp })),
      }
    }

    if (call.kind === 'describe_tool') {
      const name = call.name ?? ''
      const listed = await $.tool.list()
      const found = listed.find(t => t.name === name)
      if (!found) {
        return { id: call.id, value: { error: `No tool named "${name}". Call searchTools("...") to find tools.` } }
      }
      return {
        id: call.id,
        value: { name: found.name, description: found.description ?? '', mcp: Boolean(found.mcp) },
      }
    }

    if (call.kind === 'tool') {
      const toolName = call.tool ?? ''
      if (!toolName || toolName === CODE_TOOL) {
        return { id: call.id, value: { deny: `Cannot invoke ${toolName || 'empty tool'} recursively inside Code Mode.` } }
      }
      const args = (call.input && typeof call.input === 'object' && !Array.isArray(call.input))
        ? call.input
        : {}
      const out = (await $.tool.call({
        tool: toolName,
        ...args,
      } as never)) as Record<string, unknown>
      return {
        id: call.id,
        value: {
          ...(out['deny'] !== undefined ? { deny: out['deny'] } : {}),
          ...(out['isError'] === true ? { isError: true } : {}),
          ...(out['text'] !== undefined ? { text: out['text'] } : {}),
          ...(out['result'] !== undefined ? { result: out['result'] } : {}),
        },
      }
    }

    return { id: call.id, error: `Unknown host call kind: ${String(call.kind)}` }
  } catch (err) {
    return { id: call.id, error: err instanceof Error ? err.message : String(err) }
  }
}

async function runCodeCall(
  $: EngineInterface,
  rt: Runtime,
  code: string,
  timeoutMs: number,
  agentId: string | undefined,
): Promise<string> {
  const sid = await $.session.id()
  const loopId = agentId ?? 'main'
  const cwd = await $.session.cwd()
  const listedTools = await $.tool.list()
  const toolNames = listedTools.map(t => t.name).filter(n => n !== CODE_TOOL)

  const { worker, isFresh } = await ensureWorker($, rt, sid)
  const freshNotice = isFresh
    ? '⚠ This REPL context is new: variables, functions and timers from earlier scripts in this conversation don\'t exist in it.\n'
    : ''

  let step = await workerFetch<WorkerStepResponse>($, worker, '/eval', 'POST', {
    loopId,
    code,
    timeoutMs,
    cwd,
    toolNames,
  })

  while (step.status !== 'done') {
    if (step.status === 'need_tools' && Array.isArray(step.calls) && step.calls.length > 0) {
      const results = await Promise.all(step.calls.map(c => executeHostCall($, c)))
      step = await workerFetch<WorkerStepResponse>($, worker, '/resume', 'POST', {
        execId: step.execId,
        results,
      })
    } else {
      step = await workerFetch<WorkerStepResponse>($, worker, '/resume', 'POST', {
        execId: step.execId,
        results: [],
      })
    }
  }

  return `${freshNotice}${step.output ?? '<repl-output><result>undefined</result></repl-output>'}`
}

export const register: Register = (on, options) => {
  const rt: Runtime = {
    gatewayUrl: typeof options?.gatewayUrl === 'string' && options.gatewayUrl.trim() !== ''
      ? options.gatewayUrl.trim()
      : DEFAULT_MAGPIE_GATEWAY,
    defaultTimeoutMs: clampTimeout(options?.defaultTimeoutMs, DEFAULT_TIMEOUT_MS),
    workers: new Map(),
    starting: new Map(),
    registeredSessions: new Set(),
    freshContextNotice: new Set(),
    sessionDecisions: new Map(),
  }

  on('session.start', async ($, e, next) => {
    const res = await next(e)
    if (await isActive($, rt.gatewayUrl)) {
      const sid = await $.session.id()
      if (!rt.registeredSessions.has(sid)) {
        rt.registeredSessions.add(sid)
        await $.tool.register({
          name: CODE_TOOL_SHORT,
          description: buildToolDescription(),
          inputSchema: CODE_TOOL_INPUT_SCHEMA as unknown as Record<string, unknown>,
          isDeferred: false,
        })
        await $.command.register({
          name: 'code-mode',
          description: 'Magpie Code Mode 开关与状态：status | on | off | reset（on/off 加 --global 改全局默认）',
        })
      }
    }
    return res
  }).catch(($, e, next) => next(e))

  on('tool.offer', async ($, e, next) => {
    if (!(await isActive($, rt.gatewayUrl))) return next(e)
    const enabled = await isCodeModeEnabled($, rt, e.agentId, e.subagentType)
    if (e.tool === CODE_TOOL) {
      return { isOffered: enabled, ...(e.for === 'list' ? { breakPromptCache: true } : {}) }
    }
    if (enabled && isHiddenByCodeMode(e.tool)) {
      return { isOffered: false, ...(e.for === 'list' ? { breakPromptCache: true } : {}) }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (!(await isActive($, rt.gatewayUrl))) return out
    if (!(await sessionEnabled($, rt, await $.session.id(), await loadState($)))) return out
    if (!e.tools.includes(CODE_TOOL)) return out
    if (out.sections.some(s => s.id === SECTION_ID)) return out
    const listed = await $.tool.list()
    const hidden = listed.map(t => t.name).filter(isHiddenByCodeMode)
    const section: PromptComposeSection = {
      id: SECTION_ID,
      text: buildSystemPromptSection(hidden),
      scope: 'session',
    }
    return { sections: [...out.sections, section] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: CODE_TOOL }, async ($, e) => {
    if (!(await isCodeModeEnabled($, rt, e.agentId))) {
      return { deny: 'Code Mode is currently disabled (/code-mode on to re-enable).' }
    }
    const raw = e as unknown as { code?: unknown; timeoutMs?: unknown }
    if (typeof raw.code !== 'string' || raw.code.trim() === '') {
      return { deny: 'code parameter must be a non-empty JavaScript string.' }
    }
    const timeoutMs = clampTimeout(raw.timeoutMs, rt.defaultTimeoutMs)
    const output = await runCodeCall($, rt, raw.code, timeoutMs, e.agentId)
    return { result: output }
  }).catch(($, e, next) => {
    const msg = next.error?.message ?? next.error?.kind ?? 'execution error'
    $.ui.log(`magpie-code-mode: ${msg}`, { to: 'debug' })
    return { result: `<repl-output>\n<error>\n${msg}\n</error>\n</repl-output>` }
  })

  on('ui.render', { component: 'ToolUse', props: { tool: CODE_TOOL } }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const inp = (e.props.input ?? {}) as { description?: unknown; code?: unknown }
    const label = typeof inp.description === 'string' && inp.description.trim() !== ''
      ? inp.description.trim()
      : typeof inp.code === 'string'
        ? summarizeCodeForUi(inp.code)
        : ''
    return next({
      ...e,
      props: {
        ...e.props,
        input: label ? { summary: label } : {},
      },
    })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'code-mode' }, async ($, e, next) => {
    if (!(await isActive($, rt.gatewayUrl))) return next(e)
    const words = (e.args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const isGlobal = words.includes('--global')
    const arg = words.filter(w => w !== '--global').join(' ')
    const sid = await $.session.id()
    const st = await loadState($)

    if (arg === 'off' || arg === 'disable' || arg === 'on' || arg === 'enable') {
      const enabled = arg === 'on' || arg === 'enable'
      setSessionChoice(st, sid, enabled)
      if (isGlobal) st.defaultEnabled = enabled
      await saveState($, st)
      rt.sessionDecisions.delete(sid)
      if (!enabled) await shutdownWorker($, rt, sid)
      $.ui.invalidate('tool.offer')
      const scope = isGlobal ? '当前会话与全局默认' : '当前会话（其他会话不受影响；加 --global 改全局默认）'
      return {
        text: enabled
          ? `已开启：${scope}。下一轮起仅暴露持久 JS REPL 工具，隐藏零散文件/终端/搜索/MCP 工具。`
          : `已关闭：${scope}。原生文件/终端/搜索工具将在下一轮恢复；/code-mode on 可重新开启。`,
      }
    }

    if (arg === 'reset') {
      const worker = rt.workers.get(sid)
      if (worker && worker.alive) {
        await workerFetch($, worker, '/reset', 'POST', { loopId: 'main' })
        return { text: '已重置当前会话主线程的 Code Mode JS 上下文（所有已定义变量已清空）。' }
      }
      return { text: '当前会话尚未启动 Code Mode 工作进程，无需重置。' }
    }

    const worker = rt.workers.get(sid)
    let workerInfo = '未启动（首次调用时按需启动）'
    if (worker && worker.alive) {
      try {
        const ws = await workerFetch<{ evalCount: number; globals: string[]; pid: number }>(
          $,
          worker,
          '/status?loopId=main',
          'GET',
        )
        workerInfo = `运行中 (pid=${ws.pid}, 已执行 ${ws.evalCount} 次, 变量=${ws.globals.length > 0 ? ws.globals.join(', ') : '无'})`
      } catch {
        workerInfo = '不可达（下次调用将自动重启）'
      }
    }
    const current = await sessionEnabled($, rt, sid, st)
    const source = Object.hasOwn(st.sessions, sid)
      ? '本会话的 /code-mode 设置'
      : rt.sessionDecisions.get(sid) === false
        ? '自动跳过：恢复的会话创建于安装 Code Mode 之前，/code-mode on 可强制开启'
        : '跟随全局默认'
    return {
      text: [
        `当前会话: ${current ? '已开启' : '已关闭'}（${source}）`,
        `全局默认: ${st.defaultEnabled ? '已开启' : '已关闭'}`,
        `工具名: ${CODE_TOOL}`,
        `默认超时: ${rt.defaultTimeoutMs} ms`,
        `工作进程: ${workerInfo}`,
        '用法: /code-mode status | on | off | reset（加 --global 改全局默认）',
      ].join('\n'),
    }
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    rt.registeredSessions.delete(e.sessionId)
    rt.sessionDecisions.delete(e.sessionId)
    await shutdownWorker($, rt, e.sessionId)
    return next(e)
  }).catch(($, e, next) => next(e))
}
