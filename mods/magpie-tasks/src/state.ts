// The context object every flow handler receives and this process's per-session state (plan section 3.5).
import type { EngineInterface, Next } from 'claude-code'
import { hostIo, type Io } from './io'
import type { ModelCatalog } from './model'
import type { Registry } from './registry'
import type { Rules } from './rules'
import type { Options, SessionState } from './types'

type E = EngineInterface

// The engine calls the flow modules make, as closures over one hook call's `$`. `$` itself never goes
// into an object: `claude plugin validate` refuses a module that does so, because it reads every
// `$.noun.method` call at its call site. Each closure below is such a call site.
export interface Host {
  session: { id: E['session']['id']; model: E['session']['model']; messages: E['session']['messages']; append: E['session']['append']; send: E['session']['send'] }
  ui: { log: E['ui']['log']; ask: E['ui']['ask']; toast: E['ui']['toast']; notify: E['ui']['notify'] }
  model: { complete: E['model']['complete'] }
  agent: { spawn: E['agent']['spawn']; list: E['agent']['list'] }
  prompt: { submit: E['prompt']['submit'] }
  command: { run: E['command']['run'] }
  clock: { after: E['clock']['after'] }
  tool: { register: E['tool']['register'] }
  plugin: { root: string }
}

export function hostEngine($: EngineInterface): Host {
  return {
    session: {
      id: () => $.session.id(),
      model: () => $.session.model(),
      // The overloads of SessionMessagesCall pick the answer's type by the arguments; the closure
      // hands the arguments on as given.
      messages: ((args?: Parameters<E['session']['messages']>[0]) => args === undefined ? $.session.messages() : $.session.messages(args as never)) as E['session']['messages'],
      append: args => $.session.append(args),
      send: args => $.session.send(args),
    },
    ui: {
      // The engine heads every transcript line with the plugin's name; the module texts carry the
      // name too, because the same texts go to Telegram, so it is dropped here once.
      log: (text, options) => $.ui.log(options?.to === 'debug' ? text : text.replace(/^magpie-tasks(: | ·| (?=出错))/, ''), options),
      ask: (question, options) => $.ui.ask(question, options),
      toast: (text, options) => $.ui.toast(text, options),
      notify: (text, options) => $.ui.notify(text, options),
    },
    model: { complete: (request, options) => $.model.complete(request, options) },
    agent: { spawn: args => $.agent.spawn(args), list: () => $.agent.list() },
    prompt: { submit: args => $.prompt.submit(args) },
    command: { run: args => $.command.run(args) },
    clock: { after: (ms, fn) => $.clock.after(ms, fn) },
    tool: { register: spec => $.tool.register(spec) },
    plugin: { root: $.plugin.root },
  }
}

export interface Ctx { host: Host; io: Io; opts: Options; rules: Rules; catalog: ModelCatalog; reg: Registry; st: SessionState }

// What a prompt.submit hook answers: the result of its `next(e)`, or a refusal. `Next` is narrowed to
// prompt.submit because the bare `Next` defaults to every event and resolves to the union of all results.
export type PromptResult = Awaited<ReturnType<Next<'prompt.submit'>>> | { drop: string }

// The state of a session before session.start has decided its role: 'inactive' does nothing.
export function freshState(): SessionState {
  return {
    role: 'inactive',
    sessionId: '',
    cwd: '',
    taskId: null,
    startSource: null,
    firstPromptSeen: false,
    pendingBg: false,
    recovery: null,
    agents: new Map(),
    freshSpawn: new Set(),
    pendingRaises: new Map(),
    pendingReask: new Map(),
    stopFailures: new Map(),
    replyTargets: [],
    relay: new Map(),
    routed: new Map(),
    touches: new Map(),
    debugOffset: 0,
  }
}

// `$` belongs to one hook call, so a Ctx is built per call around the session's long-lived state.
export function ctxFor($: EngineInterface, st: SessionState, base: Omit<Ctx, 'host' | 'io' | 'st'>): Ctx {
  return { ...base, host: hostEngine($), io: hostIo($), st }
}
