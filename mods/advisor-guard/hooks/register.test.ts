import { test, expect } from 'claude-code/testing'

const BASE = [
  { id: 'intro', text: 'base', scope: 'shared' },
  { id: 'advisor', text: '# Advisor Tool\n\nCall advisor BEFORE substantive work.', scope: 'session' },
]

const compose = async ($: any, on: any, model: string) => {
  on('prompt.compose', () => ({ sections: BASE }))
  const out = await $.prompt.compose({ model, promptModel: model, surfaces: [], tools: [], outputStyle: null, traits: [] })
  return out.sections as { id: string; text: string }[]
}

for (const model of ['claude-fable-5-1', 'claude-mythos-5-1']) {
  test(`${model}: advisor section replaced by the never-consult line`, async ($, on) => {
    const s = await compose($, on, model)
    expect(s.map(x => x.id)).toEqual(['intro', 'advisor-guard:never'])
    expect(s[1].text).toContain('Never consult the advisor tool.')
  })
}

test('Opus: system prompt untouched', async ($, on) => {
  expect((await compose($, on, 'claude-opus-5-5')).map(x => x.id)).toEqual(['intro', 'advisor'])
})

const reminder = async ($: any, on: any, model: string, agentId?: string) => {
  on('session.model', () => ({ value: model }))
  on('prompt.attachment', { type: 'advisor_tool' }, (_$: any, e: any) => ({ text: e.text }))
  const input: any = { type: 'advisor_tool', text: '# Advisor Tool\n\nCall advisor BEFORE substantive work.', origin: { kind: 'engine' } }
  if (agentId) input.agentId = agentId
  return (await $.prompt.attachment(input)).text as string | null
}

test('Fable main loop: advisor reminder replaced', async ($, on) => {
  expect(await reminder($, on, 'claude-fable-5-1')).toBe('# Advisor Tool\n\nNever consult the advisor tool.')
})

test('Mythos main loop: advisor reminder replaced', async ($, on) => {
  expect(await reminder($, on, 'claude-mythos-5-1')).toContain('Never consult')
})

test('Opus main loop: advisor reminder kept', async ($, on) => {
  expect(await reminder($, on, 'claude-opus-5-5')).toContain('Call advisor BEFORE')
})

test('Fable session, subagent reminder kept', async ($, on) => {
  expect(await reminder($, on, 'claude-fable-5-1', 'a1')).toContain('Call advisor BEFORE')
})
