import { expect, test } from 'claude-code/testing'

const reply = (text: string) => ({
  plugin: 'math-render',
  component: 'AssistantMessage',
  requestId: 'msg_1',
  props: { text, isFirstOfReply: true },
} as const)

test('the reply is drawn with its math rendered, on every surface', async ($, on) => {
  // This hook stands for the engine, which draws the reply's markdown.
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.component === 'AssistantMessage' ? e.props.text : ''} />
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...reply('so $E = mc^2$.'), surface })
    expect((await ui.find({ type: 'Markdown' }))?.text).toBe('so E = mc².')
    await ui.unmount()
  }
})

test('a reply without math reaches the engine as it was', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.component === 'AssistantMessage' ? e.props.text : ''} />
  })

  const ui = await $.ui.mount({ ...reply('costs $5 or $10'), surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('costs $5 or $10')
  await ui.unmount()
})
