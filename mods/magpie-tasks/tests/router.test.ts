// The Router's dispatch (plan section 12.1, router row): which handler a Telegram reply goes to by
// the index kind of the message it replies to, on real channel blocks; the hand-over text the
// architect session parses; the long-task context; and the hand-over brief of a promoted task.
import { expect, test } from 'claude-code/testing'
import { parseTelegramMarker } from '../src/architect'
import { peerDelivery1217 } from './data/peer-deliveries'
import { architectText, channelText, decisionDelivery, demoteAfterFailedLaunch, followUpBody, promotable, promotionBrief, replyRoute, routerContext, terminalHint, workerHint } from '../src/router'
import { parseChannelTag } from '../src/telegram'
import type { TaskRecord, TelegramIndex } from '../src/types'
import { channelImage1043, channelPlain953, channelReply1108, channelReply1110 } from './data/channel-blocks'
import { routingRules } from './data/jev-rules'
import { parseRules } from '../src/rules'

const RULES = parseRules(routingRules, { deepYes: 0.85 })

const CHAT = '7051661301'
const NOW = Date.parse('2026-11-09T12:00:00Z')

// The index as magpie-tasks writes it (section 7.5): message 1105 is a long task's message, 1109 a
// daily routing note; the worker tg-7051661301-953 belongs to a daily task, tg-7051661301-900 to a
// task promoted to a long one.
function index(kind1105: TelegramIndex['messages'][string], kind1109: TelegramIndex['messages'][string]): TelegramIndex {
  return {
    schema: 1,
    messages: { [`${CHAT}:1105`]: kind1105, [`${CHAT}:1109`]: kind1109 },
    workers: {
      'tg-7051661301-953': { taskId: 'd-20261101-aaaaaa', ownerAgentId: 'a83b0057bf058d018', long: false },
      'tg-7051661301-900': { taskId: 'd-20261031-bbbbbb', ownerAgentId: 'a4923915573cfbe20', long: true },
    },
    agents: { a83b0057bf058d018: 'tg-7051661301-953', a4923915573cfbe20: 'tg-7051661301-900' },
  }
}

const reply1108 = parseChannelTag(channelReply1108)!   // replies to 1105
const reply1110 = parseChannelTag(channelReply1110)!   // replies to 1109, text 去吧
const plain953 = parseChannelTag(channelPlain953)!

test('each index kind of the replied-to message picks its handler', () => {
  const long = { taskId: 'l-20261105-cccccc', kind: 'long' } as const
  const magpie = { taskId: 'd-20261101-aaaaaa', kind: 'magpie' } as const
  expect(replyRoute(index(long, magpie), reply1108, reply1108.body, null)).toEqual({ to: 'architect', taskId: 'l-20261105-cccccc' })
  expect(replyRoute(index(long, magpie), reply1110, reply1110.body, null)).toEqual({ to: 'executor', taskId: 'd-20261101-aaaaaa' })
  const longDecision = { taskId: 'l-20261105-cccccc', kind: 'long', decisionId: 'q-20261105-x1y2z3' } as const
  expect(replyRoute(index(longDecision, magpie), reply1108, reply1108.body, null)).toEqual({ to: 'architect-decision', taskId: 'l-20261105-cccccc', decisionId: 'q-20261105-x1y2z3' })
  const dailyDecision = { taskId: 'd-20261101-aaaaaa', kind: 'decision', decisionId: 'q-20261105-d4e5f6' } as const
  expect(replyRoute(index(long, dailyDecision), reply1110, reply1110.body, null)).toEqual({ to: 'daily-decision', taskId: 'd-20261101-aaaaaa', decisionId: 'q-20261105-d4e5f6' })
  const rating = { taskId: 'd-20261101-aaaaaa', kind: 'rating' } as const
  // 去吧 under an invitation is not a score: the Router reads it.
  expect(replyRoute(index(long, rating), reply1110, reply1110.body, null)).toEqual({ to: 'rating-other', taskId: 'd-20261101-aaaaaa' })
  expect(replyRoute(index(long, rating), reply1110, '4', null)).toEqual({ to: 'rating', taskId: 'd-20261101-aaaaaa', score: 4 })
  // A message that replies to nothing, or to a message of no index entry, is the Router's.
  expect(replyRoute(index(long, magpie), plain953, plain953.body, null)).toEqual({ to: 'router' })
  expect(replyRoute(index(long, magpie), { chatId: '1', replyTo: 1105 }, reply1108.body, null)).toEqual({ to: 'router' })
})

test('评分 N scores the task of any message it replies to, also one of tg-router\'s own', () => {
  const long = { taskId: 'l-20261105-cccccc', kind: 'long' } as const
  const magpie = { taskId: 'd-20261101-aaaaaa', kind: 'magpie' } as const
  expect(replyRoute(index(long, magpie), reply1108, '评分 5', null)).toEqual({ to: 'rating', taskId: 'l-20261105-cccccc', score: 5 })
  // A reply to tg-router's answer: magpie-tasks has no entry, tg-router named the worker.
  expect(replyRoute(index(long, magpie), { chatId: CHAT, replyTo: 958 }, '评分 2', 'tg-7051661301-953')).toEqual({ to: 'rating', taskId: 'd-20261101-aaaaaa', score: 2 })
  expect(replyRoute(index(long, magpie), plain953, '评分 2', null)).toEqual({ to: 'rating-no-task' })
  // A bare digit only scores under an invitation.
  expect(replyRoute(index(long, magpie), reply1110, '2', null)).toEqual({ to: 'executor', taskId: 'd-20261101-aaaaaa' })
})

test('a reply tg-router hands on for a promoted worker goes to the architect', () => {
  const long = { taskId: 'l-20261105-cccccc', kind: 'long' } as const
  const magpie = { taskId: 'd-20261101-aaaaaa', kind: 'magpie' } as const
  expect(replyRoute(index(long, magpie), { chatId: CHAT, replyTo: 905 }, '继续', 'tg-7051661301-900')).toEqual({ to: 'architect', taskId: 'd-20261031-bbbbbb' })
  expect(replyRoute(index(long, magpie), { chatId: CHAT, replyTo: 958 }, '继续', 'tg-7051661301-953')).toEqual({ to: 'router' })
  expect(workerHint(['[magpie-tasks] other context', '[tg-router worker=tg-7051661301-900]'])).toBe('tg-7051661301-900')
  expect(workerHint(undefined)).toBeNull()
})

test('the hand-over text is what the architect session parses, photo path included', () => {
  const tag = parseChannelTag(channelImage1043)!
  const text = architectText(channelText(tag), { chatId: tag.chatId, messageId: tag.messageId })
  expect(text.split('\n')[0]).toBe('[magpie-tasks telegram chat=7051661301 message=1043]')
  expect(parseTelegramMarker(text)).toEqual({
    chatId: '7051661301', messageId: 1043,
    body: '排查一下这个排查一下这个问题，我们哪台机器又触发告警了？\nimage_path: /home/ubuntu/.claude/channels/telegram-live/inbox/1793844899621-AQADIRdrG800YFd-.jpg',
  })
  const answer = architectText(reply1110.body, { chatId: CHAT, messageId: 1110 }, { id: 'q-20261105-x1y2z3', answer: 'separate' })
  expect(parseTelegramMarker(answer)).toEqual({ chatId: CHAT, messageId: 1110, decision: { id: 'q-20261105-x1y2z3', answer: 'separate' }, body: '去吧' })
  // Delivered by $.session.send, the same text arrives inside the engine's peer framing.
  expect(parseTelegramMarker(peerDelivery1217)).toEqual({ chatId: '7051661301', messageId: 1217, body: '把这条转给 greet 那个长期任务群：greet.py 现在输出什么？' })
  // A message typed in the Router's terminal carries no marker: the answer stays in the architect's window.
  expect(architectText('greet.py 现在输出什么？', null)).toBe('greet.py 现在输出什么？')
  expect(parseTelegramMarker(architectText('greet.py 现在输出什么？', null))).toBeNull()
})

test('a follow-up tg-router sends a worker is recorded as the person\'s words, without the channel tag', () => {
  // tg-router's followUp(messageId, text) around the whole channel prompt it received.
  expect(followUpBody(`Telegram 追问（message_id=1110）：\n${channelReply1110}`)).toEqual({ messageId: 1110, body: '去吧' })
  expect(followUpBody(`Telegram 追问（message_id=1043）：\n${channelImage1043}`)?.body).toBe('排查一下这个排查一下这个问题，我们哪台机器又触发告警了？\nimage_path: /home/ubuntu/.claude/channels/telegram-live/inbox/1793844899621-AQADIRdrG800YFd-.jpg')
  expect(followUpBody('worker 交回了这条消息，理由：不是这个任务')).toBeNull()
})

function long(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schema: 1, id, kind: 'long', title: '整理 greet', state: 'running', pausedByUser: false, createdAt: NOW - 3600_000, updatedAt: NOW - 25 * 60_000,
    request: '检查 greet.py', followUps: [], project: { root: '/tmp/mt/proj' },
    worktree: { path: `/tmp/mt/wt/${id}`, baseRef: `refs/magpie-tasks/${id}/base`, baseCommit: '0'.repeat(40) }, extraWorktrees: {},
    owner: { kind: 'session', sessionId: '455258f7-73cb-4580-a3fb-e7a7cece7995', jobShortId: '455258f7', previousSessionIds: [], model: 'codex/gpt-6.1-sol', contextMemoryFingerprint: 'c0ffee00c0ffee00' },
    architect: { model: 'codex/gpt-6.1-sol', recommendation: { model: 'codex/gpt-6.1-sol', reason: 'r', limits: 'l', judgment: null }, userChoice: 'Sol 6.1（推荐）', confirmedAt: NOW - 3600_000, source: 'new' },
    telegram: { chatId: CHAT }, agents: {}, blockers: {}, decisions: {}, deliverables: [], feedback: [], ratings: [], pendingRelays: {},
    ...over,
  }
}

test('the Router context lists open long tasks, the three rules, and the model rule with every Magpie ID', () => {
  const ctx = routerContext([long('l-20261109-a1b2c3')], NOW, RULES)
  expect(ctx).toContain('- l-20261109-a1b2c3 "整理 greet": architect codex/gpt-6.1-sol, running, last activity 25 min ago')
  expect(ctx).toContain('mcp__magpie-tasks__forward_long')
  expect(ctx).toContain('mcp__magpie-tasks__recommend_architect')
  expect(ctx).toContain('mcp__magpie-tasks__promote_task')
  expect(ctx).toContain('with model set to that model\'s Magpie ID and model_reason set to the person\'s own words')
  for (const [id, m] of Object.entries(RULES.models)) expect(ctx).toContain(`${id} (${m.name})`)
  expect(routerContext([], NOW, RULES)).toContain('(none)')
})

test('a promoted task\'s brief carries the request, follow-ups, reports, checks and open questions', () => {
  const t = long('d-20261101-aaaaaa', {
    kind: 'daily',
    request: '在 ~/repo 里把 greet.py 的 hello 改成 hi，并运行 python3 greet.py 验证',
    followUps: [{ at: NOW, source: 'telegram', text: '顺便加个 main 函数' }],
    owner: { kind: 'agent', agentId: 'a83b0057bf058d018', workerName: 'tg-7051661301-953', routerSessionId: 'ea51be77-1737-4bd6-b055-119673529472' },
    agents: { a83b0057bf058d018: {
      agentId: 'a83b0057bf058d018', name: 'tg-7051661301-953', role: 'executor', sessionId: 'ea51be77-1737-4bd6-b055-119673529472', ruleId: 'code-change', rulesVersion: 'routing-rules.v1',
      selection: { kind: 'rule', reason: 'Jev' }, judgment: null, model: 'claude/claude-opus-5-5', effort: 'xhigh', efforts: [], contextSource: 'brief', cwd: '/tmp/mt/wt/d', worktree: '/tmp/mt/wt/d',
      state: 'idle', pendingRaises: [], filesTouched: [], reports: [{ at: NOW, status: 'needs-user', text: '需要先确认 main 的签名\n状态：需要用户决定', verification: [] }], startedAt: NOW,
    } },
    decisions: { 'q-20261109-aaaaaa': { id: 'q-20261109-aaaaaa', kind: 'fix-confirm', createdAt: NOW, question: '要整合修复后的改动吗？', options: ['整合', '不整合'], data: {} } },
  })
  const brief = promotionBrief(t, { worker: 'tg-7051661301-953', confirmation: '好，用 Opus 当架构师' })
  expect(brief).toContain('The person confirmed the architect with these words: "好，用 Opus 当架构师"')
  expect(brief).toContain('在 ~/repo 里把 greet.py 的 hello 改成 hi，并运行 python3 greet.py 验证')
  expect(brief).toContain('- (telegram) 顺便加个 main 函数')
  expect(brief).toContain('report (needs-user): 需要先确认 main 的签名')
  expect(brief).toContain('Task worktree: /tmp/mt/wt/d-20261101-aaaaaa')
  expect(brief).toContain('- q-20261109-aaaaaa fix-confirm: 要整合修复后的改动吗？ (options: 整合 / 不整合)')
})

test('a typed message is found by the message_id tg-router gave it', () => {
  // tg-router's terminalContext and terminalHintLine (mods/tg-router/src/magpie.ts) beside the prompt
  const context = ['You are the Router of this session, and this message was typed in its terminal.', '[tg-router terminal message_id=1794038667762]']
  expect(terminalHint(context)).toBe(1794038667762)
  expect(terminalHint(['[tg-router worker=tg-7051661301-953]'])).toBeNull()
  expect(terminalHint(undefined)).toBeNull()
})

test('an approved interruption hands the architect the message that did not arrive, with the person\'s reply', () => {
  const original = channelText(parseChannelTag(channelImage1043)!)
  const interrupted = {
    id: 'q-20261109-c3d4e5', kind: 'interrupted' as const, createdAt: NOW, options: ['继续', '暂停'],
    question: '无法把消息交给长期任务「整理 greet」（l-20261109-a1b2c3）的架构师',
    data: { reason: '会话 455258f7 不在 claude agents 列表中', sessionId: '455258f7-73cb-4580-a3fb-e7a7cece7995', message: original, chatId: CHAT, messageId: '1043' },
  }
  const delivered = decisionDelivery(interrupted, 'approve', reply1110.body)
  const text = architectText(delivered, { chatId: CHAT, messageId: 1110 }, { id: interrupted.id, answer: 'approve' })
  const parsed = parseTelegramMarker(text)!
  expect(parsed.decision).toEqual({ id: 'q-20261109-c3d4e5', answer: 'approve' })
  expect(parsed.body.startsWith(original)).toBe(true)
  expect(parsed.body.endsWith('replied: 去吧')).toBe(true)
  // A rejection, or another kind of decision, carries the reply alone.
  expect(decisionDelivery(interrupted, 'reject', reply1110.body)).toBe('去吧')
  expect(decisionDelivery({ ...interrupted, kind: 'no-progress' }, 'approve', reply1110.body)).toBe('去吧')
})

test('a promotion whose architect did not start is undone, so promote_task can be asked again', () => {
  const t = long('d-20261101-aaaaaa', {
    owner: { kind: 'agent', agentId: 'a83b0057bf058d018', workerName: 'tg-7051661301-953', routerSessionId: 'ea51be77-1737-4bd6-b055-119673529472' },
  })
  // promoteTool's write before the launch: kind long, the architect chosen, the executor unchanged
  expect(promotable(t)).toBe(false)
  demoteAfterFailedLaunch(t, 'claude --bg exited 1: no such model')
  expect(promotable(t)).toBe(true)
  expect(t.architect).toBeUndefined()
  expect(t.state).toBe('error')
  expect(t.error).toBe('promotion failed: claude --bg exited 1: no such model')
  // launchArchitect's own failure already set the state and its reason; that reason stays
  const failed = long('d-20261101-bbbbbb', { state: 'error', error: 'architect 455258f7 did not claim the task: not claimed within 60 seconds', owner: t.owner })
  demoteAfterFailedLaunch(failed, 'not claimed within 60 seconds')
  expect(failed.error).toBe('architect 455258f7 did not claim the task: not claimed within 60 seconds')
  expect(promotable(failed)).toBe(true)
})
