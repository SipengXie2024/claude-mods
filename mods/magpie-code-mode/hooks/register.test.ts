import { test, expect, mock } from 'claude-code/testing'
import {
  CODE_TOOL,
  DEFAULT_MAGPIE_GATEWAY,
  isHiddenByCodeMode,
  isMagpieGateway,
  summarizeCodeForUi,
} from '../src/protocol'

const MAGPIE_ENV = { ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY }

function wireHost(on: any) {
  const registeredTools: any[] = []
  const registeredCommands: string[] = []
  const store = new Map<string, unknown>()
  const invalidated: string[] = []
  const tools = [
    { name: 'Bash', description: 'Run shell command', mcp: false },
    { name: 'Read', description: 'Read a file', mcp: false },
    { name: 'Edit', description: 'Edit a file', mcp: false },
    { name: 'Write', description: 'Write a file', mcp: false },
    { name: 'Glob', description: 'Find files', mcp: false },
    { name: 'Grep', description: 'Search text', mcp: false },
    { name: 'Agent', description: 'Spawn subagent', mcp: false },
    { name: 'AskUserQuestion', description: 'Ask user', mcp: false },
    { name: 'mcp__context-memory__notes_write', description: 'Write task notes', mcp: true },
    { name: 'mcp__dune__run_query', description: 'Run Dune SQL query', mcp: true },
    { name: CODE_TOOL, description: 'Code Mode REPL', mcp: true },
  ]

  const host = {
    registeredTools,
    registeredCommands,
    store,
    invalidated,
    sid: 'sess-cm-1',
    messages: [] as unknown[],
    messagesError: false,
  }

  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: host.sid }))
  on('session.messages', () => {
    if (host.messagesError) throw new Error('transcript unavailable')
    return { value: host.messages }
  })
  on('session.cwd', () => ({ value: '/tmp' }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('tool.register', (_: any, e: any) => {
    registeredTools.push(e)
    return { value: { tool: `mcp__magpie-code-mode__${e.name}` } }
  })
  on('command.register', (_: any, e: any) => {
    registeredCommands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.list', () => ({ value: tools }))
  on('tool.offer', () => ({ isOffered: true }))
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'Base prompt', scope: 'session' }] }))
  on('ui.invalidate', (_: any, e: any) => {
    invalidated.push(e.event)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  return host
}

test('protocol helpers classify gateway URLs, hidden tools, and UI summaries', () => {
  expect(isMagpieGateway('http://127.0.0.1:3425')).toBe(true)
  expect(isMagpieGateway('http://localhost:3425/')).toBe(true)
  expect(isMagpieGateway('https://api.anthropic.com')).toBe(false)
  expect(isMagpieGateway(undefined)).toBe(false)

  expect(isHiddenByCodeMode('Bash')).toBe(true)
  expect(isHiddenByCodeMode('Read')).toBe(true)
  expect(isHiddenByCodeMode('Edit')).toBe(true)
  expect(isHiddenByCodeMode('Write')).toBe(true)
  expect(isHiddenByCodeMode('Glob')).toBe(true)
  expect(isHiddenByCodeMode('Grep')).toBe(true)
  expect(isHiddenByCodeMode('WebFetch')).toBe(true)
  expect(isHiddenByCodeMode('WebSearch')).toBe(true)
  expect(isHiddenByCodeMode('mcp__dune__run_query')).toBe(true)

  expect(isHiddenByCodeMode('Agent')).toBe(false)
  expect(isHiddenByCodeMode('Skill')).toBe(false)
  expect(isHiddenByCodeMode('AskUserQuestion')).toBe(false)
  expect(isHiddenByCodeMode('mcp__context-memory__notes_write')).toBe(false)
  expect(isHiddenByCodeMode('mcp__tg-router__dispatch')).toBe(false)
  expect(isHiddenByCodeMode('mcp__tg-channel__reply')).toBe(false)
  expect(isHiddenByCodeMode('mcp__magpie-tasks__forward_long')).toBe(false)
  expect(isHiddenByCodeMode(CODE_TOOL)).toBe(false)

  expect(summarizeCodeForUi('// comment\nconst x = 1 + 2;\nx')).toBe('const x = 1 + 2;')
})

test('native Claude (unset ANTHROPIC_BASE_URL): plugin stays completely silent', async ($, on) => {
  mock.env(on, {})
  const host = wireHost(on)

  await $.session.start({ cwd: '/tmp', isInteractive: true, surface: 'terminal' })
  expect(host.registeredTools).toEqual([])
  expect(host.registeredCommands).toEqual([])

  const bashOffer = await $.tool.offer({ tool: 'Bash', provider: { kind: 'core' }, for: 'list' })
  expect(bashOffer.isOffered).toBe(true)

  const composed = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash', 'Read'],
    outputStyle: null,
    traits: [],
  })
  expect(composed.sections.map(s => s.id)).toEqual(['base'])
})

test('claude-magpie: registers code tool, hides fragmented tools, preserves context-memory & Agent, injects prompt, and toggles via /code-mode', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  const host = wireHost(on)

  await $.session.start({ cwd: '/tmp', isInteractive: true, surface: 'terminal' })
  expect(host.registeredTools.length).toBe(1)
  expect(host.registeredTools[0].name).toBe('code')
  expect(host.registeredTools[0].isDeferred).toBe(false)
  expect(host.registeredCommands).toEqual(['code-mode'])

  // Fragmented built-ins and external MCP tools are hidden; Code Mode, Agent, and context-memory stay offered.
  expect((await $.tool.offer({ tool: 'Bash', provider: { kind: 'core' }, for: 'list' })).isOffered).toBe(false)
  expect((await $.tool.offer({ tool: 'Read', provider: { kind: 'core' }, for: 'list' })).isOffered).toBe(false)
  expect((await $.tool.offer({ tool: 'mcp__dune__run_query', provider: { kind: 'mcp', server: 'dune' }, for: 'list' })).isOffered).toBe(false)
  expect((await $.tool.offer({ tool: CODE_TOOL, provider: { kind: 'plugin', plugin: 'magpie-code-mode' }, for: 'list' })).isOffered).toBe(true)
  expect((await $.tool.offer({ tool: 'Agent', provider: { kind: 'core' }, for: 'list' })).isOffered).toBe(true)
  expect((await $.tool.offer({ tool: 'mcp__context-memory__notes_write', provider: { kind: 'plugin', plugin: 'context-memory' }, for: 'list' })).isOffered).toBe(true)

  const composed = await $.prompt.compose({
    model: 'hakimi/gemini-4-neon',
    promptModel: 'hakimi/gemini-4-neon',
    surfaces: ['terminal'],
    tools: [CODE_TOOL, 'Agent'],
    outputStyle: null,
    traits: [],
  })
  expect(composed.sections.some(s => s.id === 'magpie-code-mode')).toBe(true)
  const sectionText = composed.sections.find(s => s.id === 'magpie-code-mode')!.text
  expect(sectionText).toContain(CODE_TOOL)
  expect(sectionText).toContain('declare function $')

  // /code-mode off restores native tools and hides the code tool.
  const offRes = await $.command.run({ command: 'code-mode', args: 'off', origin: { kind: 'composer' }, presentation: 'inline' })
  expect(offRes.text).toContain('已关闭')
  expect(host.invalidated).toContain('tool.offer')
  expect((await $.tool.offer({ tool: 'Bash', provider: { kind: 'core' }, for: 'list' })).isOffered).toBe(true)
  expect((await $.tool.offer({ tool: CODE_TOOL, provider: { kind: 'plugin', plugin: 'magpie-code-mode' }, for: 'list' })).isOffered).toBe(false)

  // /code-mode on re-enables Code Mode.
  const onRes = await $.command.run({ command: 'code-mode', args: 'on', origin: { kind: 'composer' }, presentation: 'inline' })
  expect(onRes.text).toContain('已开启')
  expect((await $.tool.offer({ tool: 'Bash', provider: { kind: 'core' }, for: 'list' })).isOffered).toBe(false)

  const statusRes = await $.command.run({ command: 'code-mode', args: 'status', origin: { kind: 'composer' }, presentation: 'inline' })
  expect(statusRes.text).toContain('已开启')
})

test('claude-telegram Router (MAGPIE_TASKS_ROLE=router): main loop keeps all native/channel tools, worker subagents still get Code Mode', async ($, on) => {
  mock.env(on, { ...MAGPIE_ENV, MAGPIE_TASKS_ROLE: 'router' })
  wireHost(on)

  await $.session.start({ cwd: '/home/ubuntu', isInteractive: true, surface: 'terminal' })

  // Router main loop (no agentId): Code Mode tool hidden, Bash/tg-router/tg-channel all kept offered.
  expect((await $.tool.offer({ tool: CODE_TOOL, provider: { kind: 'plugin', plugin: 'magpie-code-mode' }, for: 'list' })).isOffered).toBe(false)
  expect((await $.tool.offer({ tool: 'Bash', provider: { kind: 'core' }, for: 'list' })).isOffered).toBe(true)
  expect((await $.tool.offer({ tool: 'mcp__tg-router__dispatch', provider: { kind: 'plugin', plugin: 'tg-router' }, for: 'list' })).isOffered).toBe(true)
  expect((await $.tool.offer({ tool: 'mcp__tg-channel__reply', provider: { kind: 'mcp', server: 'tg-channel' }, for: 'list' })).isOffered).toBe(true)

  // Router main loop prompt does not include CODE_TOOL in e.tools -> no Code Mode prompt injected.
  const routerPrompt = await $.prompt.compose({
    model: 'claude/claude-opus-5-5',
    promptModel: 'claude/claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash', 'mcp__tg-router__dispatch', 'mcp__tg-channel__reply'],
    outputStyle: null,
    traits: [],
  })
  expect(routerPrompt.sections.some(s => s.id === 'magpie-code-mode')).toBe(false)

  // Worker subagent (agentId present): gets Code Mode and hides Bash/Read while keeping tg-channel/tg-router.
  expect((await $.tool.offer({ tool: CODE_TOOL, provider: { kind: 'plugin', plugin: 'magpie-code-mode' }, for: 'list', agentId: 'worker-1' })).isOffered).toBe(true)
  expect((await $.tool.offer({ tool: 'Bash', provider: { kind: 'core' }, for: 'list', agentId: 'worker-1' })).isOffered).toBe(false)
  expect((await $.tool.offer({ tool: 'Read', provider: { kind: 'core' }, for: 'list', agentId: 'worker-1' })).isOffered).toBe(false)
  expect((await $.tool.offer({ tool: 'mcp__tg-channel__reply', provider: { kind: 'mcp', server: 'tg-channel' }, for: 'list', agentId: 'worker-1' })).isOffered).toBe(true)
})

const CODE_PROVIDER = { kind: 'plugin', plugin: 'magpie-code-mode' } as const

async function offered($: any, tool: string): Promise<boolean> {
  const provider = tool === CODE_TOOL ? CODE_PROVIDER : { kind: 'core' }
  return (await $.tool.offer({ tool, provider, for: 'list' })).isOffered
}

async function codeMode($: any, args: string): Promise<string> {
  return (await $.command.run({ command: 'code-mode', args, origin: { kind: 'composer' }, presentation: 'inline' })).text
}

// A transcript from a session whose turns ran before magpie-code-mode was installed.
const PRE_CODE_MODE_HISTORY = [
  { role: 'user', content: [{ type: 'text', text: 'list the files' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.ts\nb.ts' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Two files: a.ts and b.ts.' }] },
]

const CODE_MODE_HISTORY = [
  { role: 'user', content: [{ type: 'text', text: 'list the files' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: CODE_TOOL, input: { code: '$`ls`' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.ts\nb.ts' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Two files: a.ts and b.ts.' }] },
]

test('/code-mode on|off changes only the current session; --global also changes the default for new sessions', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  const host = wireHost(on)
  await $.session.start({ cwd: '/tmp', isInteractive: true, surface: 'terminal' })

  host.sid = 'sess-1'
  expect(await codeMode($, 'off')).toContain('其他会话不受影响')
  expect(await offered($, CODE_TOOL)).toBe(false)
  expect(await offered($, 'Bash')).toBe(true)

  host.sid = 'sess-2'
  expect(await offered($, CODE_TOOL)).toBe(true)
  expect(await offered($, 'Bash')).toBe(false)
  expect(host.store.get('state')).toEqual({ defaultEnabled: true, sessions: { 'sess-1': false } })

  expect(await codeMode($, 'off --global')).toContain('全局默认')
  expect(await offered($, CODE_TOOL)).toBe(false)
  host.sid = 'sess-3'
  expect(await offered($, CODE_TOOL)).toBe(false)
  expect(await offered($, 'Bash')).toBe(true)
  const status3 = await codeMode($, 'status')
  expect(status3).toContain('当前会话: 已关闭（跟随全局默认）')
  expect(status3).toContain('全局默认: 已关闭')
  expect(status3).toContain('用法: /code-mode status | on | off | reset（加 --global 改全局默认）')

  // A session-level on overrides the global default for that session only.
  expect(await codeMode($, 'on')).toContain('已开启')
  expect(await offered($, CODE_TOOL)).toBe(true)
  host.sid = 'sess-4'
  expect(await offered($, CODE_TOOL)).toBe(false)

  expect(await codeMode($, 'on --global')).toContain('已开启')
  host.sid = 'sess-5'
  expect(await offered($, CODE_TOOL)).toBe(true)
  host.sid = 'sess-1'
  expect(await offered($, CODE_TOOL)).toBe(false)
  expect(host.store.get('state')).toEqual({
    defaultEnabled: true,
    sessions: { 'sess-1': false, 'sess-2': false, 'sess-3': true, 'sess-4': true },
  })
})

test('legacy { enabled } state becomes the global default, and stored session choices keep the 64 most recent', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  const host = wireHost(on)
  host.store.set('state', { enabled: false })
  await $.session.start({ cwd: '/tmp', isInteractive: true, surface: 'terminal' })

  expect(await offered($, CODE_TOOL)).toBe(false)
  expect(await codeMode($, 'status')).toContain('全局默认: 已关闭')

  for (let i = 0; i < 70; i++) {
    host.sid = `sess-${i}`
    await codeMode($, i % 2 === 0 ? 'on' : 'off')
  }
  host.sid = 'sess-10'
  await codeMode($, 'on')
  const stored = host.store.get('state') as { defaultEnabled: boolean; sessions: Record<string, boolean> }
  expect(stored.defaultEnabled).toBe(false)
  const kept = Object.keys(stored.sessions)
  expect(kept.length).toBe(64)
  expect(kept[kept.length - 1]).toBe('sess-10')
  // 70 writes keep sess-6..sess-69; rewriting sess-10 only moves it to the end.
  expect(kept).not.toContain('sess-5')
  expect(kept).toContain('sess-6')
  expect(kept).toContain('sess-69')
})

test('session resumed from before Code Mode skips Code Mode automatically until /code-mode on', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  const host = wireHost(on)
  host.sid = 'sess-legacy'
  host.messages = PRE_CODE_MODE_HISTORY
  await $.session.start({ cwd: '/tmp', isInteractive: true, surface: 'terminal' })

  expect(await offered($, CODE_TOOL)).toBe(false)
  expect(await offered($, 'Bash')).toBe(true)
  expect(await offered($, 'Read')).toBe(true)
  expect(await offered($, 'Edit')).toBe(true)
  const composed = await $.prompt.compose({
    model: 'hakimi/gemini-4-neon',
    promptModel: 'hakimi/gemini-4-neon',
    surfaces: ['terminal'],
    tools: [CODE_TOOL, 'Bash'],
    outputStyle: null,
    traits: [],
  })
  expect(composed.sections.some(s => s.id === 'magpie-code-mode')).toBe(false)
  expect(await codeMode($, 'status')).toContain('自动跳过')
  // The automatic skip is per session and never touches the stored global default.
  expect(host.store.get('state')).toBeUndefined()

  expect(await codeMode($, 'on')).toContain('已开启')
  expect(await offered($, CODE_TOOL)).toBe(true)
  expect(await offered($, 'Bash')).toBe(false)
  expect(await codeMode($, 'status')).toContain('当前会话: 已开启（本会话的 /code-mode 设置）')
  expect(host.store.get('state')).toEqual({ defaultEnabled: true, sessions: { 'sess-legacy': true } })
})

test('session resumed with earlier Code Mode calls keeps Code Mode', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  const host = wireHost(on)
  host.sid = 'sess-code-era'
  host.messages = CODE_MODE_HISTORY
  await $.session.start({ cwd: '/tmp', isInteractive: true, surface: 'terminal' })

  expect(await offered($, CODE_TOOL)).toBe(true)
  expect(await offered($, 'Bash')).toBe(false)
  expect(await codeMode($, 'status')).toContain('当前会话: 已开启（跟随全局默认）')
})

test('fresh session keeps Code Mode as its transcript grows, and an unreadable transcript counts as fresh', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  const host = wireHost(on)
  await $.session.start({ cwd: '/tmp', isInteractive: true, surface: 'terminal' })

  host.sid = 'sess-fresh'
  host.messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  expect(await offered($, CODE_TOOL)).toBe(true)
  // The decision is made once: later turns without a code call do not flip it.
  host.messages = [...host.messages, { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] }]
  expect(await offered($, CODE_TOOL)).toBe(true)

  host.sid = 'sess-unreadable'
  host.messagesError = true
  expect(await offered($, CODE_TOOL)).toBe(true)
  expect(await offered($, 'Bash')).toBe(false)
})

test('restricted subagent types (code-editor, code-reader, Explore) keep built-in tools while general-purpose gets Code Mode', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  wireHost(on)

  await $.session.start({ cwd: '/tmp', isInteractive: true, surface: 'terminal' })

  // Specialized built-in-only subagent types must keep Bash/Read/Edit/Write offered.
  for (const st of ['code-editor', 'code-reader', 'Explore', 'Plan']) {
    expect((await $.tool.offer({ tool: 'Bash', provider: { kind: 'core' }, for: 'list', agentId: 'sub-1', subagentType: st })).isOffered).toBe(true)
    expect((await $.tool.offer({ tool: 'Read', provider: { kind: 'core' }, for: 'list', agentId: 'sub-1', subagentType: st })).isOffered).toBe(true)
    expect((await $.tool.offer({ tool: CODE_TOOL, provider: { kind: 'plugin', plugin: 'magpie-code-mode' }, for: 'list', agentId: 'sub-1', subagentType: st })).isOffered).toBe(false)
  }

  // Unrestricted general-purpose subagent gets Code Mode and hides Bash/Read.
  expect((await $.tool.offer({ tool: CODE_TOOL, provider: { kind: 'plugin', plugin: 'magpie-code-mode' }, for: 'list', agentId: 'sub-2', subagentType: 'general-purpose' })).isOffered).toBe(true)
  expect((await $.tool.offer({ tool: 'Bash', provider: { kind: 'core' }, for: 'list', agentId: 'sub-2', subagentType: 'general-purpose' })).isOffered).toBe(false)
})
