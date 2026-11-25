import type { PromptComposeSection } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import {
  DEFAULT_MAGPIE_GATEWAY,
  SECTION_ID,
  isMagpieGateway,
  parseCapabilitiesIds,
  parseModelDirective,
  register,
  resolveMagpieModel,
} from './register'

const BASE: PromptComposeSection[] = [
  { id: 'intro', text: 'base', scope: 'shared' },
]

const SAMPLE_CAPS = 'codex/gpt-6.2-astra=effort,max_effort;claude/claude-opus-5-5=effort,max_effort;hakimi/gemini-4-neon=effort'

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

const runSpawnHook = async (
  e: Record<string, unknown>,
  env: Record<string, string>,
  flagSettings?: unknown,
) => {
  let spawnHook: any
  const on: any = (event: string, h: any) => {
    if (event === 'agent.spawn') spawnHook = h
    return { catch: () => {} }
  }
  register(on, {} as any)
  const $: any = {
    env: { get: async (k: string) => env[k] },
    settings: { read: async () => flagSettings },
  }
  let forwarded: any = null
  const result = await spawnHook($, { fork: false, ...e }, async (x: any) => {
    forwarded = x
    return { model: x.model }
  })
  return { forwarded, result }
}

test('native Claude (unset ANTHROPIC_BASE_URL): prompt.compose and agent.spawn untouched', async ($, on) => {
  const sections = await compose($, on, {})
  expect(sections.map(s => s.id)).toEqual(['intro'])

  const { forwarded } = await runSpawnHook(
    { prompt: '[model codex/gpt-6.2-astra]\nDo work', model: 'opus' },
    {},
  )
  expect(forwarded.model).toBe('opus')
  expect(forwarded.prompt).toBe('[model codex/gpt-6.2-astra]\nDo work')
})

test('native Claude (api.anthropic.com): untouched', async ($, on) => {
  const sections = await compose($, on, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
  expect(sections.map(s => s.id)).toEqual(['intro'])

  const { forwarded } = await runSpawnHook(
    { prompt: '[model codex/gpt-6.2-astra]\nDo work' },
    { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
  )
  expect(forwarded.model).toBeUndefined()
  expect(forwarded.prompt).toBe('[model codex/gpt-6.2-astra]\nDo work')
})

test('claude-magpie: prompt.compose injects hint with available models', async ($, on) => {
  const sections = await compose($, on, {
    ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY,
    CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS,
  })
  expect(sections.map(s => s.id)).toEqual(['intro', SECTION_ID])
  expect(sections[1]?.text).toContain('[model <magpie-model-id>]')
  expect(sections[1]?.text).toContain('codex/gpt-6.2-astra')
  expect(sections[1]?.text).toContain('claude/claude-opus-5-5')
})

test('claude-magpie: [model codex/gpt-6.2-astra] overrides subagent model and strips directive', async () => {
  const { forwarded } = await runSpawnHook(
    { prompt: '[model codex/gpt-6.2-astra]\nImplement Package B.', model: 'opus' },
    { ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY, CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS },
  )
  expect(forwarded.model).toBe('codex/gpt-6.2-astra')
  expect(forwarded.prompt).toBe('Implement Package B.')
})

test('claude-magpie: [model: claude/claude-opus-5-5] resolves [1m] variant from picker', async () => {
  const { forwarded } = await runSpawnHook(
    { prompt: '[model: claude/claude-opus-5-5]\nReview the diff.' },
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
  expect(forwarded.model).toBe('claude/claude-opus-5-5[1m]')
  expect(forwarded.prompt).toBe('Review the diff.')
})

test('claude-magpie: unknown model ID is denied with available list', async () => {
  const { forwarded, result } = await runSpawnHook(
    { prompt: '[model codex/nonexistent-model]\nDo work.' },
    { ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY, CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS },
  )
  expect(forwarded).toBeNull()
  expect(result.deny).toContain('Unknown Magpie model "codex/nonexistent-model"')
  expect(result.deny).toContain('codex/gpt-6.2-astra')
})

test('claude-magpie: fork, workflow, resume, and magpie-tasks briefs are untouched', async () => {
  const env = { ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY, CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS }
  const prompt = '[model codex/gpt-6.2-astra]\nDo work.'

  expect((await runSpawnHook({ prompt, fork: true }, env)).forwarded.model).toBeUndefined()
  expect((await runSpawnHook({ prompt, workflow: { runId: 'wf_1', agentIndex: 0 } }, env)).forwarded.model).toBeUndefined()
  expect((await runSpawnHook({ prompt, resume: 'agent-123' }, env)).forwarded.model).toBeUndefined()

  const mtPrompt = '[magpie-tasks task=t1 role=executor rule=r1 rules=v1 model=codex/gpt-6.2-astra effort=high]\n[model codex/gpt-6.2-astra]\nDo work.'
  expect((await runSpawnHook({ prompt: mtPrompt }, env)).forwarded.model).toBeUndefined()
})

test('claude-magpie: prompt without [model ...] directive passes through unchanged', async () => {
  const { forwarded } = await runSpawnHook(
    { prompt: 'Normal task mentioning [model foo] inline only.', model: 'sonnet' },
    { ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY, CLAUDE_CODE_MODEL_CAPABILITIES: SAMPLE_CAPS },
  )
  expect(forwarded.model).toBe('sonnet')
  expect(forwarded.prompt).toBe('Normal task mentioning [model foo] inline only.')
})

test('unit helpers: parseModelDirective, parseCapabilitiesIds, resolveMagpieModel, isMagpieGateway', () => {
  expect(parseModelDirective('[model codex/gpt-6.2-astra]\nhello')).toEqual({
    model: 'codex/gpt-6.2-astra',
    prompt: 'hello',
  })
  expect(parseModelDirective('  [model: claude/claude-opus-5-5[1m]]  \n\nbody')).toEqual({
    model: 'claude/claude-opus-5-5[1m]',
    prompt: 'body',
  })
  expect(parseModelDirective('Mentioning [model foo] in prose')).toBeNull()
  expect(parseCapabilitiesIds(SAMPLE_CAPS)).toEqual([
    'codex/gpt-6.2-astra',
    'claude/claude-opus-5-5',
    'hakimi/gemini-4-neon',
  ])
  expect(resolveMagpieModel('codex/gpt-6.2-astra', { picker: [], capable: [] })).toEqual({
    ok: true,
    id: 'codex/gpt-6.2-astra',
  })
  expect(isMagpieGateway('http://localhost:3425/')).toBe(true)
  expect(isMagpieGateway('https://api.anthropic.com')).toBe(false)
})
