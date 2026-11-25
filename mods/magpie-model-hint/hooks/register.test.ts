import type { PromptComposeSection } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import {
  DEFAULT_MAGPIE_GATEWAY,
  MAGPIE_CLAUDE_HINT,
  SECTION_ID,
  isMagpieGateway,
  isNonClaudeModel,
} from './register'

const BASE: PromptComposeSection[] = [
  { id: 'intro', text: 'base', scope: 'shared' },
]

const compose = async (
  $: any,
  on: any,
  model: string,
  env: Record<string, string> = { ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY },
  sections: PromptComposeSection[] = BASE,
) => {
  mock.env(on, env)
  on('prompt.compose', () => ({ sections }))
  const out = await $.prompt.compose({
    model,
    promptModel: model,
    surfaces: [],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  return out.sections as PromptComposeSection[]
}

for (const model of [
  'hakimi/gemini-4-neon',
  'hakimi/gemini-4-neon[1m]',
  'codex/gpt-6.2-astra',
  'codex/gpt-6.1-sol',
  'auto/gemini-4-argon',
]) {
  test(`${model} under Magpie: hint section appended`, async ($, on) => {
    const sections = await compose($, on, model)
    expect(sections.map(s => s.id)).toEqual(['intro', SECTION_ID])
    const injected = sections[1]
    expect(injected).toBeDefined()
    expect(injected?.text).toBe(MAGPIE_CLAUDE_HINT)
    expect(injected?.scope).toBe('session')
    expect(injected?.text).toContain('claude-magpie --dangerously-skip-permissions --model <model-id> -p "<brief>" < /dev/null')
    expect(injected?.text).toContain('claude/claude-mythos-5-2')
    expect(injected?.text).toContain('claude/claude-mythos-5-1')
    expect(injected?.text).toContain('run_in_background: true')
  })
}

for (const model of [
  'claude-mythos-5-2',
  'claude/claude-mythos-5-2',
  'claude/claude-mythos-5-1',
  'claude-fable-5-2',
  'claude/claude-fable-5-1[1m]',
  'claude-opus-5-5',
  'hakimi/claude-opus-5-5',
  'auto/claude-sonnet-5-5',
  'claude-haiku-5-5',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'mythos',
  'CLAUDE-OPUS-5-5',
]) {
  test(`${model} under Magpie: Claude family skipped`, async ($, on) => {
    const sections = await compose($, on, model)
    expect(sections.map(s => s.id)).toEqual(['intro'])
  })
}

test('non-Claude model with unset ANTHROPIC_BASE_URL is skipped', async ($, on) => {
  const sections = await compose($, on, 'hakimi/gemini-4-neon', {})
  expect(sections.map(s => s.id)).toEqual(['intro'])
})

test('non-Claude model pointing at api.anthropic.com is skipped', async ($, on) => {
  const sections = await compose($, on, 'hakimi/gemini-4-neon', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
  expect(sections.map(s => s.id)).toEqual(['intro'])
})

test('non-Claude model pointing at unrelated local port is skipped', async ($, on) => {
  const sections = await compose($, on, 'hakimi/gemini-4-neon', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' })
  expect(sections.map(s => s.id)).toEqual(['intro'])
})

test('Magpie gateway matching tolerates trailing slash', async ($, on) => {
  const sections = await compose($, on, 'hakimi/gemini-4-neon', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425/' })
  expect(sections.map(s => s.id)).toEqual(['intro', SECTION_ID])
})

test('Magpie gateway matching tolerates localhost alias', async ($, on) => {
  const sections = await compose($, on, 'codex/gpt-6.2-astra', { ANTHROPIC_BASE_URL: 'http://localhost:3425' })
  expect(sections.map(s => s.id)).toEqual(['intro', SECTION_ID])
})

test('idempotent: existing magpie-model-hint section is not duplicated', async ($, on) => {
  const preExisting: PromptComposeSection[] = [
    ...BASE,
    { id: SECTION_ID, text: MAGPIE_CLAUDE_HINT, scope: 'session' },
  ]
  const sections = await compose($, on, 'hakimi/gemini-4-neon', { ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY }, preExisting)
  expect(sections.map(s => s.id)).toEqual(['intro', SECTION_ID])
})

test('empty model name is skipped', async ($, on) => {
  const sections = await compose($, on, '')
  expect(sections.map(s => s.id)).toEqual(['intro'])
})

test('whitespace model name is skipped', async ($, on) => {
  const sections = await compose($, on, '   ')
  expect(sections.map(s => s.id)).toEqual(['intro'])
  expect(isNonClaudeModel(undefined)).toBe(false)
})

test('does not collide with kernel-model-hint matcher', () => {
  expect(SECTION_ID).not.toBe('llm_rnd_capabilities')
  expect(/accelerator kernel optimization/.test(MAGPIE_CLAUDE_HINT)).toBe(false)
})

test('helper checks cover custom gateway URLs', () => {
  expect(isMagpieGateway('http://127.0.0.1:4000/', 'http://127.0.0.1:4000')).toBe(true)
  expect(isMagpieGateway('http://localhost:4000', 'http://127.0.0.1:4000')).toBe(true)
  expect(isMagpieGateway('http://127.0.0.1:3425', 'http://127.0.0.1:4000')).toBe(false)
  expect(isMagpieGateway(undefined)).toBe(false)
})
