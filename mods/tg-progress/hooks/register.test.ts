import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

// The engine's $ drives the mod; the test's hooks stand for the files, the
// clock and the Telegram Bot API beneath it.

const STATE = '/state/telegram-live'
const TOKEN = '123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ'

type Call = { method: string; body: Record<string, any> }

interface World {
  calls: Call[]
  clock: ReturnType<typeof mock.clock>
  /** what Telegram answers next */
  fail: 'no' | 'http400' | 'throw' | 'notModified'
}

function world(on: On, o: { token?: boolean } = {}): World {
  const w: World = { calls: [], clock: mock.clock(on, { now: 1_000 }), fail: 'no' }
  mock.env(on, { HOME: '/home/u', TELEGRAM_STATE_DIR: STATE })
  on('fs.read', ($, e) =>
    e.path === `${STATE}/.env` && o.token !== false
      ? { value: `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_ACCESS_MODE=x\n` }
      : { deny: `ENOENT ${e.path}` })
  let nextId = 500
  on('http.fetch', ($, e) => {
    const method = e.url.split('/').pop()!
    w.calls.push({ method, body: JSON.parse(e.init?.body ?? '{}') })
    if (w.fail === 'throw') throw new Error('network down')
    if (w.fail === 'http400') return { value: { status: 400, ok: false, headers: {}, text: '{"ok":false,"description":"Bad Request: chat not found"}' } }
    if (w.fail === 'notModified') return { value: { status: 400, ok: false, headers: {}, text: '{"ok":false,"description":"Bad Request: message is not modified"}' } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, result: { message_id: nextId++ } }) } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) =>
    (e as { command?: string }).command === 'false'
      ? { isError: true as const, result: 'Exit code 1', text: 'Exit code 1' }
      : { result: { stdout: '', stderr: '', interrupted: false } as never, text: 'ok' })
  return w
}

const TAG = (chat = '7051661301', mid = '878') => `<channel source="plugin:telegram:telegram" chat_id="${chat}" message_id="${mid}" user="V">\n跑测试\n</channel>`

async function telegramTurn($: any, turnId: string, text = TAG()) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'channel', server: 'plugin:telegram:telegram' } })
  await $.turn.start({ text, turnId })
}
async function terminalTurn($: any, turnId: string) {
  await $.prompt.submit({ text: 'run the long job', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'run the long job', turnId })
}
const bash = ($: any, description: string, command = 'make test', agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, description, ...(agentId ? { agentId } : {}) })
const complete = ($: any, turnId: string, reason = 'answer', durationMs = 45_000) =>
  $.turn.complete({ turnId, answer: 'done', durationMs, isAborted: reason === 'aborted', reason })
const sends = (w: World) => w.calls.filter((c) => c.method === 'sendMessage')
const edits = (w: World) => w.calls.filter((c) => c.method === 'editMessageText')

describe('when a card appears', () => {
  test('a telegram turn over 30 s sends one card, replying to the request', async ($, on) => {
    const w = world(on)
    await telegramTurn($, 't-long')
    await bash($, '运行全部单元测试')
    await w.clock.advance(29_000)
    expect(sends(w).length).toBe(0)
    await w.clock.advance(4_000)
    expect(sends(w).length).toBe(1)
    const s = sends(w)[0]!.body
    expect(s.chat_id).toBe('7051661301')
    expect(s.reply_parameters).toEqual({ message_id: 878, allow_sending_without_reply: true })
    expect(s.parse_mode).toBe(undefined)
    expect(s.text).toContain('🔄 已跑')
    expect(s.text).toContain('1 个工具')
    expect(s.text).toContain('最近：Bash · 运行全部单元测试 ✓')
    await w.clock.advance(120_000)
    expect(sends(w).length).toBe(1)
    await complete($, 't-long', 'answer', 155_000)
    await w.clock.advance(10)
    const last = edits(w).at(-1)!.body
    expect(last).toMatchObject({ chat_id: '7051661301', message_id: 500, text: '✅ 完成 · 2 分 35 秒 · 1 个工具' })
  })

  test('a telegram turn under 30 s sends nothing', async ($, on) => {
    const w = world(on)
    await telegramTurn($, 't-short')
    await bash($, 'ls')
    await w.clock.advance(5_000)
    await complete($, 't-short', 'answer', 5_000)
    await w.clock.advance(60_000)
    expect(w.calls.length).toBe(0)
  })

  test('a terminal turn sends nothing, however long', async ($, on) => {
    const w = world(on)
    await terminalTurn($, 't-term')
    await bash($, 'build')
    await w.clock.advance(300_000)
    await complete($, 't-term')
    await w.clock.advance(10)
    expect(w.calls.length).toBe(0)
  })

  test('a channel prompt folded into a running turn does not arm the next terminal turn', async ($, on) => {
    const w = world(on)
    await $.prompt.submit({ text: TAG(), wait: false, origin: { kind: 'channel', server: 'plugin:telegram:telegram' } })
    await terminalTurn($, 't-after')
    await w.clock.advance(60_000)
    await complete($, 't-after')
    await w.clock.advance(10)
    expect(w.calls.length).toBe(0)
  })
})

describe('edits', () => {
  test('edits only after a tool event, at least 10 s apart; a quiet minute refreshes once', async ($, on) => {
    const w = world(on)
    await telegramTurn($, 't-edit')
    await w.clock.advance(31_000)
    expect(sends(w).length).toBe(1)
    await w.clock.advance(20_000)
    expect(edits(w).length).toBe(0) // nothing changed
    await bash($, 'a')
    await bash($, 'b')
    await w.clock.advance(2_000)
    expect(edits(w).length).toBe(1)
    await bash($, 'c')
    await w.clock.advance(4_000)
    expect(edits(w).length).toBe(1) // under 10 s since the last edit
    await w.clock.advance(6_000)
    expect(edits(w).length).toBe(2)
    await w.clock.advance(62_000)
    expect(edits(w).length).toBe(3) // heartbeat
    await complete($, 't-edit')
    await w.clock.advance(10)
  })

  test('subagent tools add to the count but keep the Agent row', async ($, on) => {
    const w = world(on)
    await telegramTurn($, 't-sub')
    await w.clock.advance(31_000)
    await bash($, '子代理里的命令', 'make', 'agent-1')
    await w.clock.advance(10_000)
    const text = edits(w).at(-1)!.body.text as string
    expect(text).toContain('1 个工具')
    expect(text).not.toContain('子代理里的命令')
    await complete($, 't-sub')
    await w.clock.advance(10)
  })
})

describe('ends', () => {
  test('aborted and error lines name the last step', async ($, on) => {
    const w = world(on)
    await telegramTurn($, 't-abort')
    await bash($, '跑测试', 'false')
    await w.clock.advance(31_000)
    await complete($, 't-abort', 'aborted', 360_000)
    await w.clock.advance(10)
    expect(edits(w).at(-1)!.body.text).toBe('⚠️ 被中断 · 6 分 · 最后在：Bash · 跑测试')

    await telegramTurn($, 't-err')
    await w.clock.advance(31_000)
    await complete($, 't-err', 'error', 160_000)
    await w.clock.advance(10)
    expect(edits(w).at(-1)!.body.text).toBe('❌ 出错 · 2 分 40 秒 · API error')
  })
})

describe('safety', () => {
  test('the card never holds the command, and secrets in a description are hidden', async ($, on) => {
    const w = world(on)
    await telegramTurn($, 't-safe')
    await bash($, '用 API_KEY=hunter2 调接口', 'curl -H "x-api-key: sk-ant-secretsecret" https://api')
    await w.clock.advance(31_000)
    const all = JSON.stringify(w.calls.map((c) => c.body))
    expect(all).not.toContain('curl')
    expect(all).not.toContain('sk-ant-secretsecret')
    expect(all).not.toContain('hunter2')
    expect(all).toContain('API_KEY=***')
    await complete($, 't-safe')
    await w.clock.advance(10)
  })

  test('Telegram errors do not fail the turn or its tools', async ($, on) => {
    const w = world(on)
    await telegramTurn($, 't-fail')
    w.fail = 'throw'
    await w.clock.advance(31_000)
    const r = await bash($, 'ok')
    expect(r.text).toBe('ok')
    w.fail = 'http400'
    await w.clock.advance(10_000)
    const done = await complete($, 't-fail')
    expect(done.text).toBe('done')
    await w.clock.advance(10)
  })

  test('no token: no request at all', async ($, on) => {
    const w = world(on, { token: false })
    await telegramTurn($, 't-notoken')
    await w.clock.advance(40_000)
    await complete($, 't-notoken')
    await w.clock.advance(10)
    expect(w.calls.length).toBe(0)
  })
})
