// Model identifiers against Magpie's real launch settings (plan section 12.1, model row). The test
// reads ~/.config/magpie/claude-launch/settings.json and passes on only the model picker and the
// non-secret env fields; the same env object holds credentials, so it is never passed or printed whole.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { canonical, catalogFrom, clampEffort, displayName, isAvailable, nameLevel, requestId, sameModel, sameModelAnyProvider, withRuleModels } from '../src/model'
import { loadRules } from '../src/rules'
import { nodeIo } from './node-io'

const SETTINGS = join(homedir(), '.config/magpie/claude-launch/settings.json')
const ENV_KEYS = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_MODEL_CAPABILITIES']
const PLUGIN_ROOT = join(import.meta.dir, '..')

function flagLayer(drop: string[] = []): { modelPicker: unknown; env: Record<string, string> } {
  const raw = JSON.parse(readFileSync(SETTINGS, 'utf8')) as { modelPicker: unknown; env: Record<string, unknown> }
  const env: Record<string, string> = {}
  for (const k of ENV_KEYS) if (!drop.includes(k) && typeof raw.env[k] === 'string') env[k] = raw.env[k] as string
  return { modelPicker: raw.modelPicker, env }
}
const layer = flagLayer()
const cat = catalogFrom(layer)

test('the catalog keeps the picker IDs, the four aliases and the capability table', () => {
  expect(Object.keys(cat).sort()).toEqual(['aliases', 'capabilities', 'picker'])
  expect(cat.picker).toContain('claude/claude-opus-5-5[1m]')
  expect(cat.picker).toContain('codex/gpt-6.1-sol')
  expect(Object.keys(cat.aliases).sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet'])
  expect([...cat.capabilities['claude/claude-opus-5-5']!].sort()).toEqual(['effort', 'max_effort', 'xhigh_effort'])
  expect([...cat.capabilities['claude/claude-opus-4-5']!]).toEqual(['effort'])
})

test('catalogFrom refuses settings without a model picker or a capability table', () => {
  expect(() => catalogFrom({ env: layer.env })).toThrow('modelPicker.options')
  expect(() => catalogFrom(flagLayer(['CLAUDE_CODE_MODEL_CAPABILITIES']))).toThrow('CLAUDE_CODE_MODEL_CAPABILITIES')
  expect(() => catalogFrom(null)).toThrow('not an object')
})

test('canonical strips [1m] and resolves aliases through ANTHROPIC_DEFAULT_*_MODEL', () => {
  expect(canonical('claude/claude-opus-5-5[1m]', cat)).toBe('claude/claude-opus-5-5')
  expect(canonical('claude/claude-opus-5-5', cat)).toBe('claude/claude-opus-5-5')
  expect(canonical('opus', cat)).toBe('claude/claude-opus-5-5')
  expect(canonical('opus[1m]', cat)).toBe('claude/claude-opus-5-5')
  expect(canonical('sonnet', cat)).toBe('claude/claude-sonnet-5-5')
  expect(canonical('fable', cat)).toBe('claude/claude-fable-5-1')
  // Magpie points the haiku alias wherever its settings say (Astra on 2026-11-09), not at Haiku 5.5.
  expect(canonical('haiku', cat)).toBe(layer.env['ANTHROPIC_DEFAULT_HAIKU_MODEL']!.replace(/\[1m\]$/, ''))
  expect(canonical('codex/gpt-6.1-sol', cat)).toBe('codex/gpt-6.1-sol')
  expect(canonical('codex/gpt-6-magpie-missing', cat)).toBe('codex/gpt-6-magpie-missing')
})

test('an alias Magpie does not set cannot be resolved', () => {
  const noFable = catalogFrom(flagLayer(['ANTHROPIC_DEFAULT_FABLE_MODEL']))
  expect(() => canonical('fable', noFable)).toThrow('ANTHROPIC_DEFAULT_FABLE_MODEL')
})

test('sameModel ignores aliases and the 1M variant', () => {
  expect(sameModel('opus', 'claude/claude-opus-5-5[1m]', cat)).toBe(true)
  expect(sameModel('claude/claude-opus-5-5', 'claude/claude-opus-5-5[1m]', cat)).toBe(true)
  expect(sameModel('claude/claude-opus-5-5', 'codex/gpt-6.1-sol', cat)).toBe(false)
  expect(sameModel('codex/gpt-6.1-sol', 'codex/gpt-6-sol', cat)).toBe(false)
})

test('a model ID that ends in a level names that level; its levels are one model, its providers one model only for a review', () => {
  // Magpie lists every level of a model behind sub2api's Antigravity gateway as a model of its own.
  for (const level of ['low', 'medium', 'high'] as const) expect(cat.picker).toContain(`hakimi/gemini-4-carbon-${level}`)
  expect(nameLevel('hakimi/gemini-4-carbon-medium')).toBe('medium')
  expect(nameLevel('hakimi/claude-opus-5-5-high')).toBe('high')
  expect(nameLevel('claude/claude-opus-5-5[1m]')).toBeNull()
  expect(nameLevel('codex/gpt-6-astra')).toBeNull()
  expect(sameModel('hakimi/gemini-4-argon-high', 'hakimi/gemini-4-argon-medium', cat)).toBe(true)
  expect(sameModel('hakimi/gemini-4-argon-high', 'hakimi/gemini-4-carbon-high', cat)).toBe(false)
  // Another provider is another route: availability and the rules' substitutes keep them apart.
  expect(sameModel('antigravity/gemini-4-argon', 'hakimi/gemini-4-argon-medium', cat)).toBe(false)
  expect(sameModel('opus', 'hakimi/claude-opus-5-5-high', cat)).toBe(false)
  expect(sameModelAnyProvider('antigravity/gemini-4-argon', 'hakimi/gemini-4-argon-medium', cat)).toBe(true)
  expect(sameModelAnyProvider('opus', 'hakimi/claude-opus-5-5-high', cat)).toBe(true)
  expect(sameModelAnyProvider('hakimi/gemini-4-argon-medium', 'hakimi/gemini-4-carbon-medium', cat)).toBe(false)
  expect(sameModelAnyProvider('codex/gpt-6.1-sol', 'claude/claude-opus-5-5', cat)).toBe(false)
})

test('requestId gives Claude models their 1M variant and leaves Codex models alone', () => {
  expect(requestId('claude/claude-opus-5-5', cat)).toBe('claude/claude-opus-5-5[1m]')
  expect(requestId('claude/claude-opus-5-5[1m]', cat)).toBe('claude/claude-opus-5-5[1m]')
  expect(requestId('opus', cat)).toBe('claude/claude-opus-5-5[1m]')
  expect(requestId('claude/claude-sonnet-5-5', cat)).toBe('claude/claude-sonnet-5-5[1m]')
  expect(requestId('codex/gpt-6.1-sol', cat)).toBe('codex/gpt-6.1-sol')
  expect(requestId('codex/gpt-6-astra', cat)).toBe('codex/gpt-6-astra')
  // The picker lists this one without a 1M variant.
  expect(requestId('claude/claude-opus-4-5', cat)).toBe('claude/claude-opus-4-5')
})

test('every model the rules file names counts as listed; a made-up one does not', async () => {
  const rules = await loadRules(nodeIo(), PLUGIN_ROOT)
  // Magpie's own list lags a release the provider already serves (2026-11-10: no Mythos 5.2).
  const missing = Object.keys(rules.models).filter(id => !isAvailable(id, cat))
  const withRules = withRuleModels(cat, Object.keys(rules.models))
  for (const id of Object.keys(rules.models)) expect([id, isAvailable(id, withRules)]).toEqual([id, true])
  expect(withRules.picker.length).toBe(cat.picker.length + missing.length)
  expect(isAvailable('opus', withRules)).toBe(true)
  expect(isAvailable('codex/gpt-6-magpie-missing', withRules)).toBe(false)
})

test('clampEffort removes the efforts a model lacks', () => {
  expect(clampEffort('claude/claude-opus-5-5[1m]', 'max', cat)).toBe('max')
  expect(clampEffort('codex/gpt-6.1-sol', 'xhigh', cat)).toBe('xhigh')
  // claude-sonnet-4-6=effort,max_effort
  expect(clampEffort('claude/claude-sonnet-4-6', 'xhigh', cat)).toBe('high')
  expect(clampEffort('claude/claude-sonnet-4-6', 'max', cat)).toBe('max')
  // claude-opus-4-5=effort
  expect(clampEffort('claude/claude-opus-4-5', 'max', cat)).toBe('high')
  expect(clampEffort('claude/claude-opus-4-5', 'xhigh', cat)).toBe('high')
  expect(clampEffort('claude/claude-opus-4-5', 'medium', cat)).toBe('medium')
  // In the picker but absent from the capability table: left as given.
  expect(cat.capabilities['claude/claude-haiku-4-5']).toBeUndefined()
  expect(clampEffort('claude/claude-haiku-4-5', 'max', cat)).toBe('max')
})

test('displayName uses the routing table names and falls back to the ID', async () => {
  const rules = await loadRules(nodeIo(), PLUGIN_ROOT)
  expect(displayName('claude/claude-opus-5-5[1m]', rules)).toBe('Opus 5.5')
  expect(displayName('codex/gpt-6.1-sol', rules)).toBe('Sol 6.1')
  expect(displayName('codex/gpt-6-sol', rules)).toBe('Sol 6')
  expect(displayName('codex/gpt-6-magpie-missing', rules)).toBe('codex/gpt-6-magpie-missing')
})
