import { expect, test } from 'claude-code/testing'

import { splitInsight } from '../src/split'

const reply = (text: string) => ({
  plugin: 'insight-box',
  component: 'AssistantMessage',
  requestId: 'msg_1',
  props: { text, isFirstOfReply: true },
} as const)

const body = '正文一段。\n\n★ 思路\n- 为什么这样做\n- 对你的意义\n★'

test('the marked block is drawn in a bordered box, on every surface', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.component === 'AssistantMessage' ? e.props.text : ''} />
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...reply(body), surface })
    const marks = await ui.findAll({ type: 'Markdown' })
    expect(marks.map(m => m.text)).toEqual(['正文一段。', '- 为什么这样做\n- 对你的意义'])
    expect((await ui.find({ type: 'Box', borderStyle: 'round' }))).toBeTruthy()
    await ui.unmount()
  }
})

test('a reply without the block reaches the engine as it was', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.component === 'AssistantMessage' ? e.props.text : ''} />
  })

  const ui = await $.ui.mount({ ...reply('只有正文'), surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('只有正文')
  await ui.unmount()
})

test('the older ruled format and an indented close line are both read', () => {
  const s = splitInsight('前文\n\n`★ 思路 ─────`\n- 甲\n- 乙\n  `────────`\n后文')
  expect(s).toEqual({ before: '前文', title: '思路', body: '- 甲\n- 乙', after: '后文' })
})

test('a block still streaming runs to the end of the text', () => {
  expect(splitInsight('前文\n★ 思路\n- 甲')?.body).toBe('- 甲')
})
