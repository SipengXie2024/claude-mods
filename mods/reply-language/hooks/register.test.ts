import { test, expect } from 'claude-code/testing'

const world = (on: any, settings: Record<string, unknown>) => {
  const contexts: (readonly string[] | undefined)[] = []
  on('settings.read', () => ({ value: settings as never }))
  on('prompt.submit', ($: any, e: any) => (contexts.push(e.context), { text: e.text, context: e.context, origin: e.origin }))
  return contexts
}

test('a person\'s prompt gets the Chinese reminder', async ($, on) => {
  const contexts = world(on, { language: 'chinese' })
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as never)
  expect(contexts[0]).toEqual(['用中文回复用户。代码、命令、标识符和提交信息保持原样。'])
})

test('a task notification gets it too, after the context it already carries', async ($, on) => {
  const contexts = world(on, { language: 'chinese' })
  await $.prompt.submit({ text: '<task-notification>done</task-notification>', context: ['earlier'], wait: false, origin: { kind: 'task-notification' } } as never)
  expect(contexts[0]).toEqual(['earlier', '用中文回复用户。代码、命令、标识符和提交信息保持原样。'])
})

test('another language is named in English', async ($, on) => {
  const contexts = world(on, { language: 'japanese' })
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as never)
  expect(contexts[0]).toEqual(['Reply to the user in japanese. Code, commands, identifiers and commit messages stay as written.'])
})

test('no language setting, no reminder', async ($, on) => {
  const contexts = world(on, {})
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as never)
  expect(contexts[0]).toBeUndefined()
})
