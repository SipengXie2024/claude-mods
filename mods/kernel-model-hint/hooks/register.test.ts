import { test, expect } from 'claude-code/testing'
import { KERNEL_HINT } from './register'

const LIMIT = 'The training of Fable 5.2 and Mythos 5.2 included measures to limit advances in a narrow set of capabilities that could most directly accelerate AI development, like accelerator kernel optimization. These changes are not, on their own, a reason to suggest a different model.'

const compose = async ($: any, on: any, sections: any[]) => {
  on('prompt.compose', () => ({ sections }))
  const model = 'claude-fable-5-2'
  const out = await $.prompt.compose({ model, promptModel: model, surfaces: [], tools: [], outputStyle: null, traits: [] })
  return out.sections as { id: string; text: string; scope: string }[]
}

test('limit section replaced in place by the Mythos 5.1 hint', async ($, on) => {
  const s = await compose($, on, [
    { id: 'intro', text: 'base', scope: 'shared' },
    { id: 'llm_rnd_capabilities', text: LIMIT, scope: 'session' },
    { id: 'tail', text: 'end', scope: 'session' },
  ])
  expect(s.map(x => x.id)).toEqual(['intro', 'kernel-model-hint', 'tail'])
  expect(s[1].text).toBe(KERNEL_HINT)
  expect(s[1].scope).toBe('session')
  expect(s.some(x => x.text.includes('not, on their own, a reason'))).toBe(false)
})

test('section found by its text when the id differs', async ($, on) => {
  const s = await compose($, on, [{ id: 'other', text: LIMIT, scope: 'session' }])
  expect(s[0].text).toContain('Mythos 5.1')
})

test('prompt without the section is untouched', async ($, on) => {
  const s = await compose($, on, [{ id: 'intro', text: 'base', scope: 'shared' }])
  expect(s.map(x => x.id)).toEqual(['intro'])
})
