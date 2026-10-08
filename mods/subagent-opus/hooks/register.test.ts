import { test, expect } from 'claude-code/testing'
import { register } from './register'

// The kit's $.agent.spawn leaves parentModel unset, so the hook is driven
// directly with a spawn input shaped as the engine raises it.
const spawn = async (e: Record<string, unknown>) => {
  let hook: any
  const on: any = (_event: string, h: any) => ((hook = h), { catch: () => {} })
  register(on, {} as any)
  let seen: unknown = 'unset'
  await hook({}, { fork: false, ...e }, async (x: any) => ((seen = x.model), { model: String(x.model) }))
  return seen
}

const FABLE = 'claude-fable-5-1'

test('Fable parent: unpinned subagent goes to opus', async () => {
  expect(await spawn({ parentModel: FABLE })).toBe('opus')
})

test('Fable parent: explicit fable model is replaced', async () => {
  expect(await spawn({ parentModel: FABLE, model: 'fable' })).toBe('opus')
})

test('Fable parent: explicit haiku is kept', async () => {
  expect(await spawn({ parentModel: FABLE, model: 'haiku' })).toBe('haiku')
})

test('Fable parent: fork and workflow agents are untouched', async () => {
  expect(await spawn({ parentModel: FABLE, fork: true })).toBeUndefined()
  expect(await spawn({ parentModel: FABLE, workflow: { runId: 'wf_x', agentIndex: 1 } })).toBeUndefined()
})

test('Opus parent: untouched', async () => {
  expect(await spawn({ parentModel: 'claude-opus-5-5' })).toBeUndefined()
})
