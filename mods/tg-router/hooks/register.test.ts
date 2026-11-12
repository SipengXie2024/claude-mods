import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

// The engine's $ drives the mod; the test's hooks stand for the files, the
// clock and the Telegram Bot API beneath it.

const STATE = '/state/telegram-live'
const TOKEN = '123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ'

type Call = { method: string; body: Record<string, any>; argv: readonly string[] }

// The Bot API request a curl configuration on standard input describes (src/telegram.ts).
function curlRequest(config: string): { method: string; body: Record<string, any> } {
  const value = (key: string) => {
    const m = new RegExp(`^${key} = "((?:[^"\\\\]|\\\\.)*)"$`, 'm').exec(config)
    if (!m) throw new Error(`no ${key} in the curl configuration`)
    return m[1]!.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t', v: '\v' } as Record<string, string>)[c] ?? c)
  }
  return { method: value('url').split('/').pop()!, body: JSON.parse(value('data-binary')) }
}

interface World {
  calls: Call[]
  /** what each $.agent.spawn was asked */
  spawns: Record<string, any>[]
  /** what each $.session.send carried */
  sendsToAgents: Record<string, any>[]
  /** whether a session.send reaches its worker */
  deliver: boolean
  /** magpie-tasks takes the follow-up as an answer to the task's open question and tells the person this */
  handled?: string
  /** a hook beneath refuses every spawn */
  denySpawn: boolean
  /** prompts that reached the core: the Router's input */
  routed: { text: string; context?: readonly string[]; origin: any }[]
  /** names the mod registered as tools */
  registered: string[]
  /** each registered tool's input schema, by name */
  schemas: Record<string, any>
  clock: ReturnType<typeof mock.clock>
  /** what Telegram answers next */
  fail: 'no' | 'http400' | 'throw' | 'notModified'
}

function world(on: On, o: { token?: boolean; magpie?: boolean } = {}): World {
  const w: World = { calls: [], spawns: [], sendsToAgents: [], deliver: true, denySpawn: false, routed: [], registered: [], schemas: {}, clock: mock.clock(on, { now: 1_000 }), fail: 'no' }
  // the kit's spawn answers no agentId; each spawn's loop is `a-<n>` in the agent list
  on('agent.spawn', ($, e) => {
    if (w.denySpawn) return { deny: 'no workers now' }
    w.spawns.push(e)
    return { model: e.model ?? 'inherit' }
  })
  on('agent.list', () => ({
    value: w.spawns.map((sp, i) => ({ id: `a-${i + 1}`, name: sp.name, description: sp.description, type: 'general-purpose', status: 'running' })),
  }))
  on('session.send', ($, e) => {
    w.sendsToAgents.push(e)
    if (w.handled !== undefined) return { isDelivered: false as const, reason: `magpie-tasks answered a decision: ${w.handled}` }
    return w.deliver ? { isDelivered: true as const } : { isDelivered: false as const, reason: 'no agent by that id' }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => (w.registered.push(e.name), (w.schemas[e.name] = e.inputSchema), { value: { tool: `mcp__tg-router__${e.name}` } }))
  // claude-magpie starts the session against the Magpie gateway (src/magpie.ts MAGPIE_GATEWAY)
  mock.env(on, { HOME: '/home/u', TELEGRAM_STATE_DIR: STATE, ...(o.magpie ? { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425' } : {}) })
  mock.store(on)
  on('fs.read', ($, e) =>
    e.path === `${STATE}/.env` && o.token !== false
      ? { value: `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_ACCESS_MODE=x\n` }
      : { deny: `ENOENT ${e.path}` })
  let nextId = 500
  on('process.run', ($, e) => {
    if (e.argv[0] !== 'curl') throw new Error(`unexpected command ${e.argv[0]}`)
    w.calls.push({ ...curlRequest(e.init?.stdin ?? ''), argv: e.argv })
    if (w.fail === 'throw') throw new Error('network down')
    const answer = (status: number, text: string) => ({ value: { exitCode: 0, stdout: `${text}\n${status}`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (w.fail === 'http400') return answer(400, '{"ok":false,"description":"Bad Request: chat not found"}')
    if (w.fail === 'notModified') return answer(400, '{"ok":false,"description":"Bad Request: message is not modified"}')
    return answer(200, JSON.stringify({ ok: true, result: { message_id: nextId++ } }))
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    w.routed.push({ text: e.text, context: e.context, origin: e.origin })
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    return String((e as { command?: string }).command).includes('fail')
      ? { isError: true as const, result: 'Exit code 1', text: 'Exit code 1' }
      : { result: { stdout: '', stderr: '', interrupted: false } as never, text: 'ok' }
  })
  return w
}

const TAG = (chat = '7051661301', mid = '878') => `<channel source="tg-channel" chat_id="${chat}" message_id="${mid}" user="V">\n跑测试\n</channel>`
const REPLY = (mid: string, replyTo: string, body = '别改测试文件', chat = '7051661301') =>
  `<channel source="tg-channel" chat_id="${chat}" message_id="${mid}" reply_to_message_id="${replyTo}" user="V">\n${body}\n</channel>`
const CHANNEL = { kind: 'channel' as const, server: 'tg-channel' }

async function telegramTurn($: any, turnId: string, text = TAG()) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'channel', server: 'tg-channel' } })
  await $.turn.start({ text, turnId })
}
async function terminalTurn($: any, turnId: string) {
  await $.prompt.submit({ text: 'run the long job', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'run the long job', turnId })
}
const bash = ($: any, description: string, command = 'herdr pane list', agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, description, ...(agentId ? { agentId } : {}) })
const complete = ($: any, turnId: string, reason = 'answer', durationMs = 45_000) =>
  $.turn.complete({ turnId, answer: 'done', durationMs, isAborted: reason === 'aborted', reason })
const sends = (w: World) => w.calls.filter((c) => c.method === 'sendMessage')
const edits = (w: World) => w.calls.filter((c) => c.method === 'editMessageText')

test('the bot token reaches curl on standard input, never in its arguments', async ($, on) => {
  const w = world(on)
  await telegramTurn($, 't-token')
  await bash($, '运行全部单元测试')
  await w.clock.advance(33_000)
  expect(sends(w).length).toBe(1)
  expect(sends(w)[0]!.argv).toEqual(['curl', '--config', '-'])
})

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
    await bash($, 'ls', 'herdr pane list')
    await w.clock.advance(5_000)
    await complete($, 't-short', 'answer', 5_000)
    await w.clock.advance(60_000)
    expect(w.calls.length).toBe(0)
  })

  test('a terminal turn sends nothing, however long', async ($, on) => {
    const w = world(on)
    await terminalTurn($, 't-term')
    await bash($, 'build', 'tmux list-panes')
    await w.clock.advance(300_000)
    await complete($, 't-term')
    await w.clock.advance(10)
    expect(w.calls.length).toBe(0)
  })

  test('a channel prompt folded into a running turn does not arm the next terminal turn', async ($, on) => {
    const w = world(on)
    await $.prompt.submit({ text: TAG(), wait: false, origin: { kind: 'channel', server: 'tg-channel' } })
    await terminalTurn($, 't-after')
    await w.clock.advance(60_000)
    await complete($, 't-after')
    await w.clock.advance(10)
    expect(w.calls.length).toBe(0)
  })
})

describe('subagent turns', () => {
  test('a subagent turn that starts first does not take the Router turn\'s card', async ($, on) => {
    const w = world(on)
    await $.prompt.submit({ text: TAG(), wait: false, origin: CHANNEL })
    await $.turn.start({ text: 'helper', turnId: 's-1', agentId: 'a-9' })
    await $.turn.start({ text: TAG(), turnId: 'r-1' })
    await w.clock.advance(31_000)
    expect(sends(w).length).toBe(1)
    await $.turn.complete({ turnId: 's-1', agentId: 'a-9', answer: '', durationMs: 31_000, isAborted: false, reason: 'answer' })
    await complete($, 'r-1')
    await w.clock.advance(10)
    expect(edits(w).at(-1)!.body.text).toContain('✅ 完成')
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
})

describe('ends', () => {
  test('aborted and error lines name the last step', async ($, on) => {
    const w = world(on)
    await telegramTurn($, 't-abort')
    await bash($, '跑测试', 'herdr fail')
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
    await bash($, '用 API_KEY=hunter2 调接口', 'tmux send-keys "curl -H x-api-key:sk-ant-secretsecret https://api" Enter')
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

const DISPATCH = 'mcp__tg-router__dispatch'
const FORWARD = 'mcp__tg-router__forward'

/** A request reaches the Router and is dispatched; resolves the dispatch result. */
async function dispatched($: any, w: World, mid = '878') {
  await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true })
  await $.prompt.submit({ text: TAG('7051661301', mid), wait: false, origin: CHANNEL })
  await $.turn.start({ text: TAG('7051661301', mid), turnId: `r-${mid}` })
  const r = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: mid, title: '改 recap 超时', ack: '收到：改 jev 的 recap 超时。' } as never)
  await $.turn.complete({ turnId: `r-${mid}`, answer: '', durationMs: 2_000, isAborted: false, reason: 'answer' })
  return r
}

describe('dispatch', () => {
  test('a new request reaches the Router with its rules and the open tasks', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true })
    await $.prompt.submit({ text: TAG(), wait: false, origin: CHANNEL })
    expect(w.routed.length).toBe(1)
    const ctx = w.routed[0]!.context!.join('\n')
    expect(ctx).toContain('You are the Router')
    expect(ctx).toContain('Recent tasks, newest first, at most 8; an answered task can still be continued:\n（没有）')
  })

  test('dispatch starts an Opus worker with the original message and posts the ack under it', async ($, on) => {
    const w = world(on)
    const r = await dispatched($, w)
    expect(JSON.stringify(r)).toContain('tg-7051661301-878')
    expect(w.spawns.length).toBe(1)
    expect(w.spawns[0]!.model).toBe('opus')
    expect(w.spawns[0]!.name).toBe('tg-7051661301-878')
    expect(w.spawns[0]!.prompt).toContain('跑测试')
    expect(w.spawns[0]!.prompt).toContain('改 recap 超时')
    const ack = sends(w)[0]!.body
    expect(ack).toMatchObject({ chat_id: '7051661301', text: '收到：改 jev 的 recap 超时。', disable_notification: false })
    expect(ack.reply_parameters.message_id).toBe(878)
  })

  test('a message the session never received cannot be dispatched', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true })
    const r = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '999', title: 't', ack: 'a' } as never)
    expect(r.deny).toContain('999')
    expect(w.spawns.length).toBe(0)
  })

  test('the open task shows in the Router context of the next request', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    await $.prompt.submit({ text: TAG('7051661301', '900'), wait: false, origin: CHANNEL })
    expect(w.routed.at(-1)!.context!.join('\n')).toContain('改 recap 超时（进行中')
  })
})

describe('reload', () => {
  test('without a session.start (the mod was reloaded), a Telegram message registers dispatch', async ($, on) => {
    const w = world(on)
    await $.prompt.submit({ text: TAG(), wait: false, origin: CHANNEL })
    expect(w.registered).toEqual(['dispatch', 'forward'])
    await $.prompt.submit({ text: TAG('7051661301', '879'), wait: false, origin: CHANNEL })
    expect(w.registered).toEqual(['dispatch', 'forward']) // once
    const r = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '878', title: 't', ack: 'a' } as never)
    expect(JSON.stringify(r)).toContain('tg-7051661301-878')
    expect(w.spawns.length).toBe(1)
  })
})

describe('follow-ups', () => {
  test('a reply to the ack goes to the worker, not the Router', async ($, on) => {
    const w = world(on)
    await dispatched($, w) // the ack is message 500
    const before = w.routed.length
    const r = await $.prompt.submit({ text: REPLY('901', '500'), wait: false, origin: CHANNEL })
    expect(r.drop).toContain('改 recap 超时')
    expect(w.routed.length).toBe(before)
    expect(w.sendsToAgents.at(-1)).toMatchObject({ to: 'tg-7051661301-878' })
    // the whole tag: a photo or file the reply carries is in its attributes
    expect(w.sendsToAgents.at(-1)!.text).toBe(`Telegram 追问（message_id=901）：\n${REPLY('901', '500')}`)
  })

  test('a reply to the follow-up itself also reaches the worker', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    await $.prompt.submit({ text: REPLY('901', '878'), wait: false, origin: CHANNEL })
    const r = await $.prompt.submit({ text: REPLY('902', '901', '还有'), wait: false, origin: CHANNEL })
    expect(r.drop).toBeTruthy()
    expect(w.sendsToAgents.length).toBe(2)
  })

  test('a reply to a message of no task reaches the Router', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    const before = w.routed.length
    await $.prompt.submit({ text: REPLY('903', '12'), wait: false, origin: CHANNEL })
    expect(w.routed.length).toBe(before + 1)
    expect(w.sendsToAgents.length).toBe(0)
  })

  test('a gone worker: the person is told and the Router gets the message to dispatch again', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    w.deliver = false
    await $.prompt.submit({ text: REPLY('904', '878'), wait: false, origin: CHANNEL })
    expect(sends(w).at(-1)!.body.text).toContain('原来的 worker 已经不在了')
    expect(sends(w).at(-1)!.body.reply_parameters.message_id).toBe(904)
    const routed = w.routed.at(-1)!
    expect(routed.text).toContain('message_id="904"')
    expect(routed.context!.join('\n')).toContain('is gone')
    // the Router can dispatch it
    const r = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '904', title: '重派', ack: '收到。' } as never)
    expect(JSON.stringify(r)).toContain('tg-7051661301-904')
  })

  test('a HANDBACK line returns the follow-up to the Router and stops routing it to the worker', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    await $.prompt.submit({ text: REPLY('905', '878', '另外帮我订个会议室'), wait: false, origin: CHANNEL })
    const answer = '391\nHANDBACK 905: 和改超时无关'
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer, durationMs: 3_000, isAborted: false, reason: 'answer' })
    await w.clock.advance(10)
    const back = w.routed.at(-1)!
    expect(back.text).toContain('理由：和改超时无关')
    expect(back.text).toContain('另外帮我订个会议室')
    expect(sends(w).at(-1)!.body.text).toBe('391') // the line is not posted
    expect(back.context!.join('\n')).toContain('You are the Router') // the rules ride beside it too
    const again = await $.prompt.submit({ text: REPLY('906', '905'), wait: false, origin: CHANNEL })
    expect(again.drop).toBe(undefined)
    // the Router can dispatch the handed-back message
    const r = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '905', title: '订会议室', ack: '收到。' } as never)
    expect(JSON.stringify(r)).toContain('tg-7051661301-905')
  })

  test('a HANDBACK line cannot hand back the request itself or a message of no task', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    const before = w.routed.length
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer: 'HANDBACK 878: x\nHANDBACK 12: y', durationMs: 3_000, isAborted: false, reason: 'answer' })
    await w.clock.advance(10)
    expect(w.routed.length).toBe(before)
    expect(sends(w).at(-1)!.body.text).not.toContain('HANDBACK 878') // only the ack went out: nothing left to post
  })
})

describe('forward', () => {
  /** A message that replies to nothing reaches the Router, which forwards it to the worker of 878. */
  async function forwarded($: any, w: World, mid = '910', worker = 'tg-7051661301-878') {
    await $.prompt.submit({ text: TAG('7051661301', mid), wait: false, origin: CHANNEL })
    await $.turn.start({ text: TAG('7051661301', mid), turnId: `r-${mid}` })
    return $.tool.call({ tool: FORWARD, chat_id: '7051661301', message_id: mid, worker } as never)
  }

  test('the Router sees each open task with its worker name and the forward rule', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    await $.prompt.submit({ text: TAG('7051661301', '910'), wait: false, origin: CHANNEL })
    const ctx = w.routed.at(-1)!.context!.join('\n')
    expect(ctx).toContain('worker tg-7051661301-878')
    expect(ctx).toContain(FORWARD)
  })

  test('a forwarded message reaches the worker, the person is told, and a reply to that note routes there too', async ($, on) => {
    const w = world(on)
    await dispatched($, w) // the ack is message 500
    const r = await forwarded($, w)
    expect(JSON.stringify(r)).toContain('已转给 worker tg-7051661301-878')
    expect(w.sendsToAgents.at(-1)).toMatchObject({ to: 'tg-7051661301-878', text: `Telegram 追问（message_id=910）：\n${TAG('7051661301', '910')}` })
    const note = sends(w).at(-1)!.body
    expect(note.text).toContain('改 recap 超时')
    expect(note.reply_parameters.message_id).toBe(910)
    const again = await $.prompt.submit({ text: REPLY('911', '501'), wait: false, origin: CHANNEL })
    expect(again.drop).toBeTruthy()
    // the message was used: it can no longer be dispatched
    const d = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '910', title: 't', ack: 'a' } as never)
    expect(JSON.stringify(d)).toContain('没有等待派发')
  })

  test('a forward to no open task of this chat is refused and the message stays dispatchable', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    const r = await forwarded($, w, '910', 'tg-111-1')
    expect(JSON.stringify(r)).toContain('没有名为 tg-111-1')
    expect(w.sendsToAgents.length).toBe(0)
    const d = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '910', title: 't', ack: 'a' } as never)
    expect(JSON.stringify(d)).toContain('tg-7051661301-910')
  })

  test('a forward to a gone worker asks the Router to dispatch, and the new worker takes the task over', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    w.deliver = false
    const r = await forwarded($, w)
    expect(JSON.stringify(r)).toContain('is gone')
    w.deliver = true
    await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '910', title: '接着改', ack: '收到。' } as never)
    expect(w.spawns.at(-1)!.prompt).toContain('you take it over')
  })

  test('a worker cannot call forward', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    const r = await $.tool.call({ tool: FORWARD, chat_id: '7051661301', message_id: '878', worker: 'tg-7051661301-878', agentId: 'a-1' } as never)
    expect(JSON.stringify(r)).toContain('只给 Router 用')
  })
})

describe('dispatch failures and gone workers', () => {
  test('a refused spawn is no dispatch: no ack, no task, and the message can still be dispatched', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true })
    await $.prompt.submit({ text: TAG(), wait: false, origin: CHANNEL })
    w.denySpawn = true
    const r = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '878', title: 't', ack: 'a' } as never)
    expect(r.deny).toContain('no workers now')
    expect(sends(w).length).toBe(0)
    const reply = await $.prompt.submit({ text: REPLY('901', '878'), wait: false, origin: CHANNEL })
    expect(reply.drop).toBe(undefined) // no task holds 878
    w.denySpawn = false
    const again = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '878', title: 't', ack: 'a' } as never)
    expect(JSON.stringify(again)).toContain('tg-7051661301-878')
  })

  test('the same message_id in two chats makes two tasks', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true })
    await $.prompt.submit({ text: TAG('111', '42'), wait: false, origin: CHANNEL })
    await $.prompt.submit({ text: TAG('222', '42'), wait: false, origin: CHANNEL })
    await $.tool.call({ tool: DISPATCH, chat_id: '111', message_id: '42', title: 'a', ack: 'a' } as never)
    await $.tool.call({ tool: DISPATCH, chat_id: '222', message_id: '42', title: 'b', ack: 'b' } as never)
    expect(w.spawns.map((sp) => sp.name)).toEqual(['tg-111-42', 'tg-222-42'])
    await $.prompt.submit({ text: REPLY('43', '42', '追问', '111'), wait: false, origin: CHANNEL })
    expect(w.sendsToAgents.at(-1)).toMatchObject({ to: 'tg-111-42' })
  })

  test('a gone worker: the new worker gets the task\'s request and takes over its thread', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    w.deliver = false
    await $.prompt.submit({ text: REPLY('904', '878', '再加个测试'), wait: false, origin: CHANNEL })
    w.deliver = true
    await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '904', title: '接着改', ack: '收到。' } as never)
    const brief = w.spawns.at(-1)!.prompt as string
    expect(brief).toContain('跑测试') // the original request
    expect(brief).toContain('再加个测试')
    const r = await $.prompt.submit({ text: REPLY('905', '500', '提交了吗'), wait: false, origin: CHANNEL }) // the old ack
    expect(r.drop).toBeTruthy()
    expect(w.sendsToAgents.at(-1)).toMatchObject({ to: 'tg-7051661301-904' })
  })

  test('two replies to one gone worker both dispatch', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    w.deliver = false
    await $.prompt.submit({ text: REPLY('904', '878', '一'), wait: false, origin: CHANNEL })
    await $.prompt.submit({ text: REPLY('905', '878', '二'), wait: false, origin: CHANNEL })
    w.deliver = true
    for (const mid of ['904', '905']) {
      const r = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: mid, title: mid, ack: '收到。' } as never)
      expect(JSON.stringify(r)).toContain(`tg-7051661301-${mid}`)
    }
  })
})

describe('answers', () => {
  test('a worker answer is posted under the request, and a reply to it reaches the worker', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    const answer = '改好了：超时 10 秒，测试通过。/home/ubuntu/sipeng/claude-mods/mods/jev/hooks/register.ts 提交 0123456789abcdef0123456789abcdef01234567'
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer, durationMs: 20_000, isAborted: false, reason: 'answer' })
    const ans = sends(w).at(-1)!.body
    expect(ans).toMatchObject({ text: answer, disable_notification: false }) // paths and commit ids intact
    expect(ans.reply_parameters.message_id).toBe(878)
    const r = await $.prompt.submit({ text: REPLY('907', '501', '提交了吗'), wait: false, origin: CHANNEL })
    expect(r.drop).toBeTruthy()
  })

  test('the answer to a follow-up replies to that follow-up', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer: '第一版好了', durationMs: 5_000, isAborted: false, reason: 'answer' })
    await $.prompt.submit({ text: REPLY('908', '878', '再加个测试'), wait: false, origin: CHANNEL })
    await $.turn.complete({ turnId: 'w2', agentId: 'a-1', answer: '加好了', durationMs: 5_000, isAborted: false, reason: 'answer' })
    expect(sends(w).at(-1)!.body.reply_parameters.message_id).toBe(908)
  })

  test('a worker card appears after 30 s and ends with the final line; the answer follows', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    await w.clock.advance(31_000)
    const card = sends(w).at(-1)!.body
    expect(card.text).toBe('🔄 已跑 30 秒') // the host shows a worker's calls to no hook of this mod
    expect(card.disable_notification).toBe(true)
    expect(card.reply_parameters.message_id).toBe(878)
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer: '好了', durationMs: 40_000, isAborted: false, reason: 'answer' })
    await w.clock.advance(10)
    expect(edits(w).at(-1)!.body.text).toBe('✅ 完成 · 40 秒')
    expect(sends(w).at(-1)!.body.text).toBe('好了')
  })

  test('a short run that fails says so in one line', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer: '', durationMs: 3_000, isAborted: false, reason: 'error' })
    expect(sends(w).at(-1)!.body.text).toBe('❌ 出错 · 3 秒 · API error')
  })

  test('a long answer is clipped to what Telegram accepts', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer: '字'.repeat(5000), durationMs: 3_000, isAborted: false, reason: 'answer' })
    const text = sends(w).at(-1)!.body.text as string
    expect(text.length).toBeLessThan(4096)
    expect(text).toContain('后面还有 1000 字')
  })

  test('an answer of HANDBACK lines alone posts nothing', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    await $.prompt.submit({ text: REPLY('905', '878', '另外帮我订个会议室'), wait: false, origin: CHANNEL })
    const before = sends(w).length
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer: 'HANDBACK 905: 无关', durationMs: 3_000, isAborted: false, reason: 'answer' })
    expect(sends(w).length).toBe(before)
  })

  test('an answer Telegram refused reaches the Router through the completion notice', async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    w.fail = 'http400'
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer: '好了', durationMs: 3_000, isAborted: false, reason: 'answer' })
    w.fail = 'no'
    const r = await $.prompt.submit({ text: '<task-notification><task-id>a-1</task-id>好了</task-notification>', wait: false, origin: { kind: 'task-notification' } })
    expect(r.drop).toBe(undefined)
    expect(w.routed.at(-1)!.context!.join('\n')).toContain('could not be posted')
  })

  test("a worker's completion notice does not wake the Router", async ($, on) => {
    const w = world(on)
    await dispatched($, w)
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer: '好了', durationMs: 3_000, isAborted: false, reason: 'answer' })
    const before = w.routed.length
    const r = await $.prompt.submit({ text: '<task-notification><task-id>a-1</task-id>done</task-notification>', wait: false, origin: { kind: 'task-notification' } })
    expect(r.drop).toBeTruthy()
    expect(w.routed.length).toBe(before)
  })
})

describe('the Router does no work', () => {
  test('edits, other commands and Agent are refused in the main loop', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true })
    for (const call of [
      { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' },
      { tool: 'Bash', command: 'ls' },
      { tool: 'Bash', command: 'herdr pane list; rm -rf /tmp/x' },
      { tool: 'Bash', command: 'tmux capture-pane -p > /tmp/out' },
      { tool: 'Agent', prompt: 'do it', description: 'd' },
      { tool: 'Read', file_path: '/home/u/notes.md' },
    ]) {
      const r = await $.tool.call(call as never)
      expect(r.deny).toBeTruthy()
    }
  })

  test('pane commands, the channel tools and photos from the inbox are allowed', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true })
    for (const call of [
      { tool: 'Bash', command: 'herdr pane list | grep claude | head -3' },
      { tool: 'Bash', command: 'tmux list-panes && tmux capture-pane -p -t 2' },
      { tool: 'mcp__tg-channel__reply', chat_id: '1', text: 'hi' },
      { tool: 'Read', file_path: `${STATE}/inbox/photo.jpg` },
      // magpie-tasks' list of the session's agents: the Router asks it before it says what runs
      { tool: 'mcp__magpie-tasks__session_agents' },
    ]) {
      const r = await $.tool.call(call as never)
      expect(r.deny).toBe(undefined)
    }
  })

  test('a worker keeps every tool but cannot dispatch', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true })
    const edit = await $.tool.call({ tool: 'Bash', command: 'make test', agentId: 'a-9' } as never)
    expect(edit.deny).toBe(undefined)
    const d = await $.tool.call({ tool: DISPATCH, chat_id: '7051661301', message_id: '1', title: 't', ack: 'a', agentId: 'a-9' } as never)
    expect(d.deny).toContain('只给 Router 用')
  })
})

describe('messages typed in the terminal', () => {
  const COMPOSER = { kind: 'composer' as const }
  const typed = async ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: COMPOSER })
  const terminalId = (w: World) => /message_id "(\d+)"/.exec(w.routed.at(-1)!.context!.join('\n'))![1]!

  test('a typed message reaches the Router as a request it can dispatch, with the open terminal tasks', async ($, on) => {
    const w = world(on)
    await typed($, '把 jev 的超时改成 10 秒')
    const ctx = w.routed.at(-1)!.context!.join('\n')
    expect(ctx).toContain('typed in its terminal')
    expect(ctx).toContain('chat_id "tui"')
    expect(ctx).toContain('Recent terminal tasks, newest first, at most 8; an answered task can still be continued:\n（没有）')
    const r = await $.tool.call({ tool: DISPATCH, chat_id: 'tui', message_id: terminalId(w), title: '改超时', ack: '收到。' } as never)
    expect(JSON.stringify(r)).toContain(`tui-${terminalId(w)}`)
    expect(w.spawns[0]!.prompt).toContain('typed in the terminal')
    expect(w.spawns[0]!.prompt).toContain('把 jev 的超时改成 10 秒')
    expect(sends(w).length).toBe(0) // no Telegram ack
    await typed($, '再看看测试')
    expect(w.routed.at(-1)!.context!.join('\n')).toContain('改超时（进行中')
  })

  test("a terminal worker's answer reaches the Router as the plugin's prompt, and its completion notice is dropped", async ($, on) => {
    const w = world(on)
    await typed($, '盘点待办')
    const id = terminalId(w)
    await $.tool.call({ tool: DISPATCH, chat_id: 'tui', message_id: id, title: '盘点', ack: '收到。' } as never)
    await w.clock.advance(40_000)
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer: '**三件事**没做', durationMs: 40_000, isAborted: false, reason: 'answer' })
    await w.clock.advance(10)
    expect(w.calls.length).toBe(0) // no card, no answer to Telegram
    const shown = w.routed.at(-1)!
    expect(shown.origin).toMatchObject({ kind: 'plugin', name: 'tg-router' })
    expect(shown.text).toContain(`worker tui-${id}（盘点）的回答`)
    expect(shown.text).toContain('**三件事**没做')
    const before = w.routed.length
    const r = await $.prompt.submit({ text: `<task-notification><task-id>a-1</task-id>tui-${id} done</task-notification>`, wait: false, origin: { kind: 'task-notification' } })
    expect(r.drop).toBeTruthy()
    expect(w.routed.length).toBe(before)
  })

  test('the Router still does no work for a typed message', async ($, on) => {
    world(on)
    await typed($, '直接改一下文件')
    const r = await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' } as never)
    expect(r.deny).toBeTruthy()
  })

  test('outside claude-magpie dispatch offers no model, refuses one, and starts the worker on Opus', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true })
    expect(Object.keys(w.schemas['dispatch']!.properties)).toEqual(['chat_id', 'message_id', 'title', 'ack'])
    await typed($, '用 Sonnet 看看这个报错')
    const id = terminalId(w)
    expect(w.routed.at(-1)!.context!.join('\n')).not.toContain('[tg-router terminal message_id=')
    const refused = await $.tool.call({ tool: DISPATCH, chat_id: 'tui', message_id: id, title: '看报错', ack: '收到。', model: 'claude/claude-sonnet-5-5', model_reason: '用 Sonnet 看看这个报错' } as never)
    expect(refused.deny).toContain('只在 claude-magpie 下可用')
    expect(w.spawns.length).toBe(0)
    await $.tool.call({ tool: DISPATCH, chat_id: 'tui', message_id: id, title: '看报错', ack: '收到。' } as never)
    expect(w.spawns[0]!.model).toBe('opus')
  })

  test('under claude-magpie each typed message carries its message_id for magpie-tasks, and a named model goes with its reason', async ($, on) => {
    const w = world(on, { magpie: true })
    await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true })
    expect(Object.keys(w.schemas['dispatch']!.properties)).toEqual(['chat_id', 'message_id', 'title', 'ack', 'model', 'model_reason'])
    await typed($, '用 Sonnet 看看这个报错')
    const first = terminalId(w)
    expect(w.routed.at(-1)!.context).toContain(`[tg-router terminal message_id=${first}]`)
    await typed($, '再看看测试')
    const second = terminalId(w)
    expect(second).not.toBe(first)
    expect(w.routed.at(-1)!.context).toContain(`[tg-router terminal message_id=${second}]`)
    await $.tool.call({ tool: DISPATCH, chat_id: 'tui', message_id: first, title: '看报错', ack: '收到。', model: 'claude/claude-sonnet-5-5', model_reason: '用 Sonnet 看看这个报错' } as never)
    // The Agent input takes only aliases, so the named model travels in the brief for magpie-tasks.
    expect(w.spawns[0]!.model).toBe(undefined)
    expect(w.spawns[0]!.prompt).toContain('[model claude/claude-sonnet-5-5]\n[model-reason user: 用 Sonnet 看看这个报错]')
  })
})

describe('terminal follow-ups, open questions and restarts', () => {
  const COMPOSER = { kind: 'composer' as const }
  const typed = async ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: COMPOSER })
  const terminalId = (w: World) => /message_id "(\d+)"/.exec(w.routed.at(-1)!.context!.join('\n'))![1]!
  /** A typed request dispatched, its worker answered; resolves the worker name. */
  async function answeredTerminal($: any, w: World): Promise<string> {
    await typed($, '盘点待办')
    const id = terminalId(w)
    await $.tool.call({ tool: DISPATCH, chat_id: 'tui', message_id: id, title: '盘点', ack: '收到。' } as never)
    await $.turn.complete({ turnId: 'w1', agentId: 'a-1', answer: '三件事没做', durationMs: 4_000, isAborted: false, reason: 'answer' })
    return `tui-${id}`
  }

  test('the Router forwards a typed follow-up with forward: the worker reads it as a terminal follow-up and nothing goes to Telegram', async ($, on) => {
    const w = world(on)
    const worker = await answeredTerminal($, w)
    await typed($, '第二件先做')
    const id = terminalId(w)
    const ctx = w.routed.at(-1)!.context!.join('\n')
    expect(ctx).toContain(`call ${FORWARD} with chat_id "tui", message_id "${id}"`)
    expect(ctx).toContain('Do not use SendMessage for it.')
    const r = await $.tool.call({ tool: FORWARD, chat_id: 'tui', message_id: id, worker } as never)
    expect(JSON.stringify(r)).toContain(`已转给 worker ${worker}`)
    expect(w.sendsToAgents.at(-1)).toMatchObject({ to: worker, text: `终端 追问（message_id=${id}）：\n第二件先做` })
    await w.clock.advance(60_000)
    expect(w.calls.length).toBe(0) // no note, no card
  })

  test('a SendMessage of the Router to a worker is refused with the forward call to make instead', async ($, on) => {
    const w = world(on)
    const worker = await answeredTerminal($, w)
    const r = await $.tool.call({ tool: 'SendMessage', to: worker, message: '第二件先做', summary: 's' } as never)
    expect(r.deny).toContain(FORWARD)
    expect(r.deny).toContain(`worker 填 ${worker}`)
    expect(w.sendsToAgents.length).toBe(0)
    const other = await $.tool.call({ tool: 'SendMessage', to: 'someone-else', message: 'hi', summary: 's' } as never)
    expect(other.deny).toBeUndefined()
  })

  test('words magpie-tasks takes as the answer to the open question are handled, not lost, on both paths', async ($, on) => {
    const w = world(on, { magpie: true })
    on('fs.exists', () => ({ value: false })) // magpie-tasks has written no index yet
    const worker = await answeredTerminal($, w)
    w.handled = '好的，正在整合，结果会单独报告。'
    await typed($, '整合')
    const r = await $.tool.call({ tool: FORWARD, chat_id: 'tui', message_id: terminalId(w), worker } as never)
    expect(JSON.stringify(r)).toContain('took this message as the person\'s answer')
    expect(JSON.stringify(r)).toContain('好的，正在整合')
    // the task is not lost: a later follow-up still goes to its worker
    w.handled = undefined
    await typed($, '再看一下')
    const again = await $.tool.call({ tool: FORWARD, chat_id: 'tui', message_id: terminalId(w), worker } as never)
    expect(JSON.stringify(again)).toContain(`已转给 worker ${worker}`)
    // a Telegram reply to the task's ack
    await dispatched($, w) // the ack is message 500
    w.handled = '好的，不整合；改动保留在工作副本。'
    const reply = await $.prompt.submit({ text: REPLY('920', '500', '不整合'), wait: false, origin: CHANNEL })
    expect(reply.drop).toContain('不整合；改动保留')
    expect(sends(w).some((c) => String(c.body.text).includes('原来的 worker 已经不在'))).toBe(false)
  })

  const restored = (agentId: string, name: string) => `<task-notification>\n<task-id>${agentId}</task-id>\n<status>stopped</status>\n<summary>Background agent "Resuming agent ${name}" didn't finish before the previous session ended</summary>\n<note>No completion record was found for it after it was re-dispatched via SendMessage in the previous session.</note>\n</task-notification>`

  test("a restart's notice that an answered worker did not finish is rewritten; one about a cut-off run is kept", async ($, on) => {
    const w = world(on)
    const worker = await answeredTerminal($, w)
    const kept = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: restored('a-1', worker) }] } } as never)
    const text = JSON.stringify(kept)
    expect(text).toContain(`Worker ${worker} (\\"盘点\\") had answered before the session restarted`)
    expect(text).not.toContain('No completion record')
    // a run cut off by the restart ended aborted: its notice stands
    await typed($, '继续')
    await $.tool.call({ tool: FORWARD, chat_id: 'tui', message_id: terminalId(w), worker } as never)
    await $.turn.complete({ turnId: 'w2', agentId: 'a-1', answer: '', durationMs: 4_000, isAborted: true, reason: 'aborted' })
    const cut = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: restored('a-1', worker) }] } } as never)
    expect(JSON.stringify(cut)).toContain('No completion record')
  })

  test('a message the Router never dispatched is forgotten after a day', async ($, on) => {
    const w = world(on)
    await typed($, '你好')
    const id = terminalId(w)
    await w.clock.advance(25 * 3600_000)
    await typed($, '在吗')
    const r = await $.tool.call({ tool: DISPATCH, chat_id: 'tui', message_id: id, title: 't', ack: 'a' } as never)
    expect(JSON.stringify(r)).toContain('没有等待派发的消息')
  })
})
