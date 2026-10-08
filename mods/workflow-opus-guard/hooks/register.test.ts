import { test, expect } from 'claude-code/testing'

const PINNED = `export const meta = { name: 'x', description: 'y' }
await agent('review', { label: 'a', model: 'opus' })
await agent("verify", { model: "opus", schema: S })`

const UNPINNED = `export const meta = { name: 'x', description: 'y', phases: [{ title: 'R', model: 'opus' }] }
await agent('review', { label: 'a', model: 'opus' })
// agent('commented', { model: 'opus' })
await agent('verify', { label: 'b' })`

const workflow = async ($: any, on: any, model: string, script: string) => {
  let ran = false
  on('session.model', () => ({ value: model }))
  on('tool.call', { tool: 'Workflow' }, () => ((ran = true), { result: { taskId: 't' } }))
  const r = await $.tool.call({ tool: 'Workflow', script })
  return { ran, text: String(r.text ?? r.deny ?? '') }
}

test('Fable: every agent() pinned to opus passes', async ($, on) => {
  expect((await workflow($, on, 'claude-fable-5-1', PINNED)).ran).toBe(true)
})

test('Fable: an unpinned agent() is denied with its line', async ($, on) => {
  const r = await workflow($, on, 'claude-fable-5-1', UNPINNED)
  expect(r.ran).toBe(false)
  expect(r.text).toContain('line 4')
  expect(r.text).not.toContain('line 2')
})

test('Opus main loop: unpinned script passes', async ($, on) => {
  expect((await workflow($, on, 'claude-opus-5-5', UNPINNED)).ran).toBe(true)
})
