import type { PromptComposeSection } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import {
  DEFAULT_MAGPIE_GATEWAY,
  SECTION_ID,
  clampEffortForModel,
  isMagpieGateway,
  parseCapabilities,
  parseCapabilitiesIds,
  parseEffortDirective,
  parseModelDirective,
  register,
  resolveMagpieModel,
} from './register'
import { renderRoutingTable } from '../src/routing-table'

const BASE: PromptComposeSection[] = [
  { id: 'intro', text: 'base', scope: 'shared' },
]

const SAMPLE_CAPS = [
  'codex/gpt-6.2-astra=effort,xhigh_effort,max_effort',
  'claude/claude-opus-5-5=effort,xhigh_effort,max_effort',
  'claude/claude-sonnet-5-5=effort,xhigh_effort,max_effort',
  'claude/claude-mythos-5-1=effort,xhigh_effort',
  'claude/claude-mythos-5-2=effort,xhigh_effort,max_effort',
  'hakimi/gemini-4-neon=effort,xhigh_effort',
  'hakimi/gemini-4-argon=effort',
].join(';')

const compose = async (
  $: any,
  on: any,
  env: Record<string, string>,
  sections: PromptComposeSection[] = BASE,
) => {
  mock.env(on, env)
  on('prompt.compose', () => ({ sections }))
  const out = await $.prompt.compose({
    model: 'hakimi/gemini-4-neon',
    promptModel: 'hakimi/gemini-4-neon',
    surfaces: [],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  return out.sections as PromptComposeSection[]
}

const createHarness = (env: Record<string, string>, flagSettings?: unknown) => {
  const hooks: Record<string, any> = {}
  const on: any = (event: string, h: any) => {
    hooks[event] = h
    return { catch: () => {} }
  }
  register(on, {} as any)
  const $: any = {
    env: { get: async (k: string) => env[k] },
    settings: { read: async () => flagSettings },
  }

  const spawn = async (e: Record<string, unknown>, returnedAgentId = 'agent-1') => {
    let forwarded: any = null
    const result = await hooks['agent.spawn']($, { fork: false, ...e }, async (x: any) => {
      forwarded = x
      return { agentId: returnedAgentId, model: x.model }
    })
    return { forwarded, result }
  }

  const step = async (e: Record<string, unknown>) => {
    let seen: any = null
    const gen = hooks['turn.step']($, e, async function* (x: any) {
      seen = x
      return { stopReason: 'end_turn' }
    })
    while (!(await gen.next()).done) {}
    return seen
  }

  const endSession = () => hooks['session.end']($, {}, (x: any) => x)

  return { spawn, step, endSession }
}

test('native Claude (unset ANTHROPIC_BASE_URL): prompt.compose and agent.spawn untouched', async ($, on) => {
  const sections = await compose($, on, {})
  expect(sections.map(s => s.id)).toEqual(['intro'])

  const h = createHarness({})
  const { forwarded } = await h.spawn({ prompt: '[model codex/gpt-6.2-astra]\n[effort max]\nDo work', model: 'opus' })
  expect(forwarded.model).toBe('opus')
  expect(forwarded.prompt).toBe('[model codex/gpt-6.2-astra]\n[effort max]\nDo work')
})

test('native Claude (api.anthropic.com): untouched', async ($, on) => {
  const sections = await compose($, on, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
  expect(sections.map(s => s.id)).toEqual(['intro'])

  const h = createHarness({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
  const { forwarded } = await h.spawn({ prompt: '[model codex/gpt-6.2-astra]\nDo work' })
  expect(forwarded.model).toBeUndefined()
  expect(forwarded.prompt).toBe('[model codex/gpt-6.2-astra]\nDo work')
})

test('claude-magpie: prompt.compose injects routing table and available models', async ($, on) => {
  const sections = await compose($, on, {
    ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY,
    CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS,
  })
  expect(sections.map(s => s.id)).toEqual(['intro', SECTION_ID])
  const text = sections[1]?.text ?? ''
  expect(text).toContain('[model <magpie-model-id>]')
  expect(text).toContain('[effort <low|medium|high|xhigh|max>]')
  expect(text).toContain('## Task routing table')
  expect(text).toContain('`code-change`')
  expect(text).toContain('`gpu-kernel`')
  expect(text).toContain('claude/claude-mythos-5-1')
  expect(text).toContain('`machine-ops`')
  expect(text).toContain('claude/claude-sonnet-5-5')
  expect(text).toContain('`math`')
  expect(text).toContain('codex/gpt-6.2-astra')
  expect(text).toContain('`document-analysis`')
  expect(text).toContain('hakimi/gemini-4-neon')
  expect(text).toContain('Available Magpie models:')
})

test('claude-magpie: [model ...] strips directive and overrides model; [effort ...] pins turn.step', async () => {
  const h = createHarness({
    ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY,
    CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS,
  })
  const { forwarded } = await h.spawn(
    { prompt: '[model claude/claude-sonnet-5-5]\n[effort max]\nCheck server status.', model: 'opus' },
    'agent-ops',
  )
  expect(forwarded.model).toBe('claude/claude-sonnet-5-5')
  expect(forwarded.prompt).toBe('[effort max]\nCheck server status.')

  // Enforced on turn.step for the spawned agent, leaving main and other subagents untouched.
  expect((await h.step({ agentId: 'agent-ops', effort: 'medium' })).effort).toBe('max')
  expect((await h.step({ agentId: 'other-agent', effort: 'medium' })).effort).toBe('medium')
  expect((await h.step({ effort: 'low' })).effort).toBe('low')

  // session.end clears tracked efforts.
  h.endSession()
  expect((await h.step({ agentId: 'agent-ops', effort: 'medium' })).effort).toBe('medium')
})

test('claude-magpie: effort is clamped to model capability ceiling and normalized in prompt', async () => {
  const h = createHarness({
    ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY,
    CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS,
  })
  // hakimi/gemini-4-argon only advertises `effort` (ceiling high), so max clamps to high.
  const { forwarded } = await h.spawn(
    { prompt: '[model hakimi/gemini-4-argon]\n[effort: MAX]\nWrite explanation.' },
    'agent-argon',
  )
  expect(forwarded.model).toBe('hakimi/gemini-4-argon')
  expect(forwarded.prompt).toBe('[effort high]\nWrite explanation.')
  expect((await h.step({ agentId: 'agent-argon', effort: 'medium' })).effort).toBe('high')
})

test('claude-magpie: [effort ...] alone (without [model ...]) pins effort on turn.step', async () => {
  const h = createHarness({
    ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY,
    CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS,
  })
  const { forwarded } = await h.spawn(
    { prompt: '[effort xhigh]\nDeep numerical check.', parentModel: 'codex/gpt-6.2-astra' },
    'agent-num',
  )
  expect(forwarded.model).toBeUndefined()
  expect(forwarded.prompt).toBe('[effort xhigh]\nDeep numerical check.')
  expect((await h.step({ agentId: 'agent-num', effort: 'medium' })).effort).toBe('xhigh')
})

test('claude-magpie: [model: claude/claude-opus-5-5] resolves [1m] variant from picker', async () => {
  const h = createHarness(
    { ANTHROPIC_BASE_URL: 'http://localhost:3425/' },
    {
      modelPicker: {
        options: [
          { model: 'claude/claude-opus-5-5[1m]' },
          { model: 'codex/gpt-6.2-astra' },
        ],
      },
      env: { CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS },
    },
  )
  const { forwarded } = await h.spawn({ prompt: '[model: claude/claude-opus-5-5]\nReview the diff.' })
  expect(forwarded.model).toBe('claude/claude-opus-5-5[1m]')
  expect(forwarded.prompt).toBe('Review the diff.')
})

test('claude-magpie: unknown model ID or invalid effort is denied', async () => {
  const h = createHarness({
    ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY,
    CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS,
  })
  const badModel = await h.spawn({ prompt: '[model codex/nonexistent-model]\nDo work.' })
  expect(badModel.forwarded).toBeNull()
  expect(badModel.result.deny).toContain('Unknown Magpie model "codex/nonexistent-model"')

  const badEffort = await h.spawn({ prompt: '[model codex/gpt-6.2-astra]\n[effort ultra]\nDo work.' })
  expect(badEffort.forwarded).toBeNull()
  expect(badEffort.result.deny).toContain('Unknown effort level "ultra"')
})

test('claude-magpie: fork, workflow, resume, and magpie-tasks briefs are untouched', async () => {
  const h = createHarness({
    ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY,
    CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS,
  })
  const prompt = '[model codex/gpt-6.2-astra]\n[effort max]\nDo work.'

  expect((await h.spawn({ prompt, fork: true })).forwarded.model).toBeUndefined()
  expect((await h.spawn({ prompt, workflow: { runId: 'wf_1', agentIndex: 0 } })).forwarded.model).toBeUndefined()
  expect((await h.spawn({ prompt, resume: 'agent-123' })).forwarded.model).toBeUndefined()

  const mtPrompt = '[magpie-tasks task=t1 role=executor rule=r1 rules=v1 model=codex/gpt-6.2-astra effort=high]\n[model codex/gpt-6.2-astra]\nDo work.'
  expect((await h.spawn({ prompt: mtPrompt })).forwarded.model).toBeUndefined()
})

test('claude-magpie: prompt without directives passes through unchanged', async () => {
  const h = createHarness({
    ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY,
    CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS,
  })
  const { forwarded } = await h.spawn({
    prompt: 'Normal task mentioning [model foo] and [effort max] inline only.',
    model: 'sonnet',
  })
  expect(forwarded.model).toBe('sonnet')
  expect(forwarded.prompt).toBe('Normal task mentioning [model foo] and [effort max] inline only.')
})

test('unit helpers: directives, capabilities, clamping, routing table', () => {
  expect(parseModelDirective('[model codex/gpt-6.2-astra]\nhello')).toEqual({
    model: 'codex/gpt-6.2-astra',
    prompt: 'hello',
  })
  expect(parseModelDirective('  [model: claude/claude-opus-5-5[1m]]  \n\nbody')).toEqual({
    model: 'claude/claude-opus-5-5[1m]',
    prompt: 'body',
  })
  expect(parseModelDirective('Mentioning [model foo] in prose')).toBeNull()

  expect(parseEffortDirective('[effort high]\nhello')).toMatchObject({ ok: true, effort: 'high' })
  expect(parseEffortDirective('  [effort: XHIGH]  \nhello')).toMatchObject({ ok: true, effort: 'xhigh' })
  expect(parseEffortDirective('[effort bogus]\nhello')).toEqual({ ok: false, raw: 'bogus' })
  expect(parseEffortDirective('inline [effort max] prose')).toBeNull()

  const caps = parseCapabilities(SAMPLE_CAPS)
  expect(caps.maxEffort['hakimi/gemini-4-argon']).toBe('high')
  expect(caps.maxEffort['hakimi/gemini-4-neon']).toBe('xhigh')
  expect(caps.maxEffort['codex/gpt-6.2-astra']).toBe('max')
  expect(parseCapabilitiesIds(SAMPLE_CAPS)).toEqual(caps.ids)

  expect(clampEffortForModel('max', 'hakimi/gemini-4-argon[1m]', caps.maxEffort)).toBe('high')
  expect(clampEffortForModel('max', 'hakimi/gemini-4-neon', caps.maxEffort)).toBe('xhigh')
  expect(clampEffortForModel('max', 'codex/gpt-6.2-astra', caps.maxEffort)).toBe('max')

  expect(resolveMagpieModel('codex/gpt-6.2-astra', { picker: [], capable: [] })).toEqual({
    ok: true,
    id: 'codex/gpt-6.2-astra',
  })
  expect(isMagpieGateway('http://localhost:3425/')).toBe(true)
  expect(isMagpieGateway('https://api.anthropic.com')).toBe(false)

  const table = renderRoutingTable(new Set(['claude/claude-opus-5-5']))
  expect(table).toContain('`claude/claude-opus-5-5` · `high`')
  expect(table).toContain('`codex/gpt-6.2-astra` (unavailable) · `max`')
})
