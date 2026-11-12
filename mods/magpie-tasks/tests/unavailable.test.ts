// The StopFailure category a routed subagent's error is filed under (plan section 9.16). The texts
// are what Claude Code 2.1.319 reported through Magpie in E14 on 2026-11-09
// (/tmp/mt-e2e-f4ve, agent a586a174a5c6d8e3d) and Magpie's own 400 body for the same request.
import { expect, test } from 'claude-code/testing'
import { agentLabel } from '../src/model'
import { parseRules } from '../src/rules'
import { isUnavailableError, stopFailureCategory } from '../src/unavailable'
import { routingRules } from './data/jev-rules'

const LAST_MESSAGE = "API Error: 400 Codex: The 'gpt-6-magpie-missing' model is not supported when using Codex with a ChatGPT account."
const BODY = '400 {"error":{"message":"Codex: The \'gpt-6-magpie-missing\' model is not supported when using Codex with a ChatGPT account.","type":"invalid_request_error"},"type":"error"}'

test('a 400 saying the model is not served counts as model_not_found, so the model is unavailable', () => {
  expect(stopFailureCategory('unknown', LAST_MESSAGE)).toBe('model_not_found')
  expect(stopFailureCategory('invalid_request', BODY)).toBe('model_not_found')
  expect(isUnavailableError(stopFailureCategory('unknown', LAST_MESSAGE))).toBe(true)
})

// Magpie's 400 for Antigravity's answer to a Claude Code request (claude-magpie -p --model
// antigravity/gemini-4-argon, 2026-11-12 03:10Z; the same for antigravity/claude-opus-5-5).
const ANTIGRAVITY_REFUSAL = "API Error: 400 Antigravity: Resource has been exhausted (e.g. check quota). — Antigravity answers this 429 to the system prompt of Claude Code and the Claude Agent SDK (Claude Desktop's chats) whatever quota is left, so it is not a quota and waiting won't help; use another provider for these chats, or put one after Antigravity in a routing group"

test('Antigravity refusing Claude Code counts as model_not_found, so a substitute takes over', () => {
  expect(stopFailureCategory('unknown', ANTIGRAVITY_REFUSAL)).toBe('model_not_found')
  expect(stopFailureCategory('invalid_request', ANTIGRAVITY_REFUSAL)).toBe('model_not_found')
  expect(isUnavailableError(stopFailureCategory('unknown', ANTIGRAVITY_REFUSAL))).toBe(true)
})

test('other errors keep the engine category', () => {
  expect(stopFailureCategory('unknown', undefined)).toBe('unknown')
  expect(stopFailureCategory('unknown', 'API Error: 400 messages.3: tool_use ids must be unique')).toBe('unknown')
  expect(stopFailureCategory('invalid_request', 'API Error: 400 prompt is too long')).toBe('invalid_request')
  expect(stopFailureCategory('rate_limit', LAST_MESSAGE)).toBe('rate_limit')
  expect(isUnavailableError(stopFailureCategory('unknown', 'API Error: 500 upstream reset'))).toBe(false)
})

test('the person reads a subagent as role, task and model, never its ID', () => {
  const rules = parseRules(routingRules, { deepYes: 0.85 })
  // The description as the plugin rewrote it at spawn: the Agent tool's words, then " · model/effort".
  expect(agentLabel({ role: 'implementer', description: '把 hello 改成 hi · Sonnet 5.5/medium', model: 'claude/claude-sonnet-5-5' }, rules))
    .toBe('实施子代理「把 hello 改成 hi」（Sonnet 5.5）')
  expect(agentLabel({ role: 'acceptance', model: 'claude/claude-opus-5-5' }, rules)).toBe('验收子代理（Opus 5.5）')
})
