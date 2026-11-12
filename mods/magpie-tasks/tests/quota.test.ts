// The acceptance model chosen from Magpie's subscription quotas (routing rules, `acceptance`). ANSWER
// is Magpie's GET /v1/magpie/quotas answer of 2026-11-12 03:06Z with the account names, sign-in
// emails and the usage details of the Claude window left out; the other cases change its readings.
import { expect, test } from 'claude-code/testing'
import { acceptancePick, parseQuotas } from '../src/quota'
import { parseRules } from '../src/rules'
import { routingRules } from './data/jev-rules'

const rules = parseRules(routingRules, { deepYes: 0.85 })
const OPUS = 'claude/claude-opus-5-5'
const SOL = 'codex/gpt-6.1-sol'

const ANSWER = {
  object: 'list',
  data: [
    {
      provider: 'claude', name: 'Claude Code', kind: 'subscription', plan: 'max',
      windows: [
        { name: '5 hours', used: 0, remaining: 100, holdsWhy: 'low' },
        { name: '7 days', used: 10, remaining: 90, resetsAt: '2026-11-15T16:00:00Z' },
        { name: '7 days · Fable', used: 19, remaining: 81, resetsAt: '2026-11-15T15:59:00Z', holdsWhy: 'none' },
      ],
      readAt: '2026-11-12T03:06:28.67102698Z', last: true,
    },
    {
      provider: 'codex', name: 'Codex', kind: 'subscription', plan: 'pro',
      windows: [{ name: '7 days', used: 2, remaining: 98, resetsAt: '2026-11-18T07:07:14Z' }],
      balance: '35950.81 credits', readAt: '2026-11-12T03:06:31.640613129Z',
    },
    {
      provider: 'antigravity', name: 'Antigravity', kind: 'subscription', plan: 'Google AI Pro',
      windows: [
        { name: 'Gemini 4 Argon (High)', used: 1.287453999999999, remaining: 98.712546, resetsAt: '2026-11-17T03:32:14Z', pool: 'Gemini 4 Argon' },
        { name: 'Claude & GPT · 7 days', used: 0, remaining: 100, resetsAt: '2026-11-19T03:06:31Z', pool: 'Claude & GPT', holdsWhy: 'low' },
      ],
      readAt: '2026-11-12T03:06:31.976068259Z',
    },
  ],
}

type Window = { name: string; remaining: number; [k: string]: unknown }
// ANSWER with the windows of one provider replaced.
function withWindows(provider: string, windows: Window[]): string {
  return JSON.stringify({ ...ANSWER, data: ANSWER.data.map(e => e.provider === provider ? { ...e, windows } : e) })
}

test('Magpie\'s answer reads as its subscriptions and their windows', () => {
  const q = parseQuotas(JSON.stringify(ANSWER))
  expect(q.map(s => s.provider)).toEqual(['claude', 'codex', 'antigravity'])
  expect(q[0]!.windows).toEqual([{ name: '5 hours', remaining: 100 }, { name: '7 days', remaining: 90 }, { name: '7 days · Fable', remaining: 81 }])
})

test('the subscription with the most of its week left gives the model: Codex at 98% over Claude at 90%', () => {
  const pick = acceptancePick(rules, parseQuotas(JSON.stringify(ANSWER)))
  expect(pick.model).toBe(SOL)
  expect(pick.reason).toBe('the codex subscription has the most of its week left (codex 7 days 98% left; claude 7 days 90% left)')
})

test('Claude\'s week left decides when it is larger; the Fable window does not count for Opus', () => {
  const q = parseQuotas(withWindows('claude', [{ name: '5 hours', remaining: 60 }, { name: '7 days', remaining: 99.5 }, { name: '7 days · Fable', remaining: 0 }]))
  expect(acceptancePick(rules, q).model).toBe(OPUS)
})

test('a used-up five-hour window puts its subscription last, whatever its week', () => {
  const q = parseQuotas(withWindows('claude', [{ name: '5 hours', remaining: 0 }, { name: '7 days', remaining: 99.5 }]))
  const pick = acceptancePick(rules, q)
  expect(pick.model).toBe(SOL)
  expect(pick.reason).toContain('claude 7 days 99.5% left (5 hours used up)')
})

test('a tie goes to the subscription listed first in the rules file', () => {
  const q = parseQuotas(withWindows('claude', [{ name: '5 hours', remaining: 100 }, { name: '7 days', remaining: 98 }]))
  expect(rules.acceptance.subscriptions[0]!.model).toBe(OPUS)
  expect(acceptancePick(rules, q).model).toBe(OPUS)
})

test('a listed subscription without its weekly reading, or with two accounts, stops the choice', () => {
  expect(() => acceptancePick(rules, parseQuotas(withWindows('codex', [{ name: '5 hours', remaining: 40 }])))).toThrow('the codex subscription has no "7 days" window (it reports "5 hours")')
  const twice = { ...ANSWER, data: [...ANSWER.data, ANSWER.data[0]!] }
  expect(() => acceptancePick(rules, parseQuotas(JSON.stringify(twice)))).toThrow('2 claude subscriptions reported')
  const none = { ...ANSWER, data: ANSWER.data.filter(e => e.provider !== 'codex') }
  expect(() => acceptancePick(rules, parseQuotas(JSON.stringify(none)))).toThrow('0 codex subscriptions reported')
})

test('an answer that is not Magpie\'s quota list is refused', () => {
  expect(() => parseQuotas('<html>')).toThrow('the answer is not JSON')
  expect(() => parseQuotas('{"error":"unauthorized"}')).toThrow('the answer has no data list')
  expect(() => parseQuotas(withWindows('codex', [{ name: '7 days' } as Window]))).toThrow('codex windows[0] has no name or remaining share')
})
