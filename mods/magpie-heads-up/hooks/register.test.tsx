import { test, expect, mock } from 'claude-code/testing'
import {
  DEFAULT_MAGPIE_GATEWAY,
  buildDiscussDraft,
  isMagpieGateway,
  lineKey,
  looksToSkipAfter,
  parseProposal,
} from '../src/protocol'

const MAGPIE_ENV = { ANTHROPIC_BASE_URL: DEFAULT_MAGPIE_GATEWAY }

const ABOVE_MOUNT = {
  plugin: 'magpie-heads-up',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

function wireHost(on: any, opts?: { surfaces?: string[]; belowText?: string }) {
  const registered: string[] = []
  const store = new Map<string, unknown>()
  let invalidations = 0
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: opts?.surfaces ?? ['terminal'] }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('command.register', (_: any, e: any) => {
    registered.push(e.name)
    return { value: undefined }
  })
  on('ui.invalidate', () => {
    invalidations += 1
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{opts?.belowText ?? 'jev-band'}</Text>
  })
  return { registered, store, getInvalidations: () => invalidations }
}

function collectText(tree: any): string {
  if (tree == null) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(collectText).join('')
  if (typeof tree === 'object') {
    const parts: string[] = []
    if (tree.type === 'Markdown' && typeof tree.props?.text === 'string') parts.push(tree.props.text)
    if (tree.type === 'Button' && typeof tree.props?.label === 'string') parts.push(`[${tree.props.hotkey ?? ''}:${tree.props.label}]`)
    if (tree.children) parts.push(collectText(tree.children))
    if (tree.props?.children) parts.push(collectText(tree.props.children))
    return parts.join('')
  }
  return ''
}

test('protocol parser handles none, Heads up, You should know, inline tags, and unparsable text', () => {
  expect(parseProposal('learn: none')).toEqual({ kind: 'none' })
  expect(parseProposal('learn: none.')).toEqual({ kind: 'none' })
  expect(parseProposal('random text without prefix')).toEqual({ kind: 'unparsable' })

  const offer = parseProposal([
    'learn: 新配置把缓存上限降到 200k，长对话会更早压缩。',
    'tag: Heads up',
    'explain:',
    '**上下文上限变化**',
    '这个改动把 autoCompactWindow 设成 200k。',
  ].join('\n'))
  expect(offer).toEqual({
    kind: 'offer',
    tag: 'Heads up',
    line: '新配置把缓存上限降到 200k，长对话会更早压缩。',
    explanation: '**上下文上限变化**\n这个改动把 autoCompactWindow 设成 200k。',
  })

  const inline = parseProposal('learn: "Prompt caching bills writes at 1.25x." tag: You should know')
  expect(inline).toEqual({
    kind: 'offer',
    tag: 'You should know',
    line: 'Prompt caching bills writes at 1.25x.',
    explanation: undefined,
  })

  expect(looksToSkipAfter(0)).toBe(0)
  expect(looksToSkipAfter(1)).toBe(0)
  expect(looksToSkipAfter(2)).toBe(0)
  expect(looksToSkipAfter(3)).toBe(1)
  expect(looksToSkipAfter(4)).toBe(2)
  expect(looksToSkipAfter(5)).toBe(4)
  expect(looksToSkipAfter(8)).toBe(16)
  expect(looksToSkipAfter(20)).toBe(16)

  expect(lineKey('Test Line.')).toBe('test line')
  expect(isMagpieGateway('http://localhost:3425/')).toBe(true)
  expect(isMagpieGateway('https://api.anthropic.com')).toBe(false)

  const draft = buildDiscussDraft('Heads up', '测试提醒', '**标题**\n正文')
  expect(draft).toContain('> Heads up · 测试提醒')
  expect(draft).toContain('> **标题**')
})

test('native Claude (unset ANTHROPIC_BASE_URL): plugin stays completely silent', async ($, on) => {
  mock.env(on, {})
  const host = wireHost(on, { belowText: 'jev-band' })
  let forkCalls = 0
  on('model.fork', () => {
    forkCalls += 1
    return { value: { isAnswered: true, text: 'learn: should not happen\ntag: Heads up' } }
  })

  await $.session.start({ cwd: '/tmp', isInteractive: true })
  expect(host.registered).toEqual([])
  const rendered = await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: ABOVE_MOUNT.props })
  expect(collectText(rendered)).toBe('jev-band')
  expect(forkCalls).toBe(0)
})

test('claude-magpie: /heads-up now runs fork, renders offer beside below band, expands and fills prompt', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  const host = wireHost(on, { belowText: 'jev-band-preserved' })
  let filledText = ''
  let boxText = ''
  let toasted = ''

  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: [
        'learn: 新的路由表把文档分析固定在 Neon high，不再自动升到 xhigh。',
        'tag: Heads up',
        'explain:',
        '**Neon 文档分析锁定 high**',
        'Neon 在 GDP.pdf 上 high 为 33.4%，升到 xhigh 反而降到 28.0%。',
      ].join('\n'),
    },
  }))
  on('prompt.read', () => ({ value: { text: boxText, cursor: boxText.length } }))
  on('prompt.fill', (_: any, e: any) => {
    filledText = e.text
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('ui.toast', (_: any, e: any) => {
    toasted = e.text
    return { value: undefined }
  })

  await $.session.start({ cwd: '/tmp', isInteractive: true })
  expect(host.registered).toEqual(['heads-up'])

  const runRes = await $.command.run({ command: 'heads-up', args: 'now', origin: { kind: 'composer' } })
  expect(runRes.text).toContain('发现一条提醒')

  // Offer card renders together with the underlying jev band.
  const ui = await $.ui.mount(ABOVE_MOUNT)
  const offerText = collectText(await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: ABOVE_MOUNT.props }))
  expect(offerText).toContain('Heads up · 新的路由表把文档分析固定在 Neon high')
  expect(offerText).toContain('jev-band-preserved')

  // Press "1" (展开说明) to expand inline explanation.
  await ui.press({ key: 'explain' })
  await new Promise(r => setTimeout(r, 20))
  await ui.unmount()

  const ui2 = await $.ui.mount(ABOVE_MOUNT)
  const explainedText = collectText(await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: ABOVE_MOUNT.props }))
  expect(explainedText).toContain('Neon 文档分析锁定 high')
  expect(explainedText).toContain('jev-band-preserved')

  // Busy composer prevents overwriting user draft.
  boxText = '用户正在输入的内容'
  await ui2.press({ key: 'discuss' })
  await new Promise(r => setTimeout(r, 20))
  expect(filledText).toBe('')
  expect(toasted).toContain('输入框已有内容')

  // Empty composer fills draft and clears card.
  boxText = ''
  await ui2.press({ key: 'discuss' })
  await new Promise(r => setTimeout(r, 20))
  await ui2.unmount()

  expect(filledText).toContain('> Heads up · 新的路由表把文档分析固定在 Neon high')
  expect(filledText).toContain('> **Neon 文档分析锁定 high**')

  const afterTree = await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: ABOVE_MOUNT.props })
  expect(collectText(afterTree)).toBe('jev-band-preserved')
})

test('claude-magpie: /heads-up off, on, clear, and status commands', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  wireHost(on)
  await $.session.start({ cwd: '/tmp', isInteractive: true })

  const offRes = await $.command.run({ command: 'heads-up', args: 'off', origin: { kind: 'composer' } })
  expect(offRes.text).toContain('已关闭')

  const statusOff = await $.command.run({ command: 'heads-up', args: 'status', origin: { kind: 'composer' } })
  expect(statusOff.text).toContain('已关闭')

  const onRes = await $.command.run({ command: 'heads-up', args: 'on', origin: { kind: 'composer' } })
  expect(onRes.text).toContain('已开启')

  const clearRes = await $.command.run({ command: 'heads-up', args: 'clear', origin: { kind: 'composer' } })
  expect(clearRes.text).toContain('已清除')
})

test('claude-magpie: offer without inline explanation fetches explanation via second fork', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  wireHost(on)
  let forkCount = 0
  on('model.fork', () => {
    forkCount += 1
    if (forkCount === 1) {
      return { value: { isAnswered: true, text: 'learn: 未显式传 effort 时会沿用主线程档位。\ntag: You should know' } }
    }
    return { value: { isAnswered: true, text: '**沿用主线程思考强度**\n这样不会触发整段上下文缓存重建。' } }
  })

  await $.session.start({ cwd: '/tmp', isInteractive: true })
  await $.command.run({ command: 'heads-up', args: 'now', origin: { kind: 'composer' } })

  const ui = await $.ui.mount(ABOVE_MOUNT)
  await ui.press({ key: 'explain' })
  await new Promise(r => setTimeout(r, 20))
  await ui.unmount()

  const explainedTree = await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: ABOVE_MOUNT.props })
  expect(forkCount).toBe(2)
  expect(collectText(explainedTree)).toContain('沿用主线程思考强度')
})

test('claude-magpie: turn.step triggers automatic check on step 6 and clears ignored offer after 2 prompts', async ($, on) => {
  mock.env(on, MAGPIE_ENV)
  wireHost(on, { belowText: 'jev-band' })
  let forkCalls = 0
  on('model.fork', () => {
    forkCalls += 1
    return {
      value: {
        isAnswered: true,
        text: 'learn: 自动触发的第 6 步提醒。\ntag: Heads up',
      },
    }
  })
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' }
  })

  await $.session.start({ cwd: '/tmp', isInteractive: true })

  // Step 3 should not trigger (default checkEvery = 6).
  for await (const _ of $.turn.step({ index: 3, turnId: 't1', model: 'hakimi/gemini-4-neon' })) {}
  expect(forkCalls).toBe(0)

  // Step 6 triggers background fork.
  for await (const _ of $.turn.step({ index: 6, turnId: 't1', model: 'hakimi/gemini-4-neon' })) {}
  await new Promise(r => setTimeout(r, 20))
  expect(forkCalls).toBe(1)

  const shown = await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: ABOVE_MOUNT.props })
  expect(collectText(shown)).toContain('自动触发的第 6 步提醒')

  // Ignore the offer across 2 user prompts -> cleared on next turn's step 0.
  await $.prompt.submit({ text: '继续第一步', origin: { kind: 'composer' } })
  for await (const _ of $.turn.step({ index: 0, turnId: 't2', model: 'hakimi/gemini-4-neon' })) {}
  const stillShown = await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: ABOVE_MOUNT.props })
  expect(collectText(stillShown)).toContain('自动触发的第 6 步提醒')

  await $.prompt.submit({ text: '继续第二步', origin: { kind: 'composer' } })
  for await (const _ of $.turn.step({ index: 0, turnId: 't3', model: 'hakimi/gemini-4-neon' })) {}
  const cleared = await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: ABOVE_MOUNT.props })
  expect(collectText(cleared)).toBe('jev-band')
})
