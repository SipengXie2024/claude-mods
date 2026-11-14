// Where a long task's questions and notices go (src/channel.ts): the wait before Telegram as a
// function of the plugin's clock, what a dialog label stands for, the line a later answer gets, the
// questions of an AskUserQuestion call, and what the architect is told about all of it. Times are
// milliseconds on the plugin's clock (io.now()); T0 is 2026-11-13 04:00:00 UTC. The decisions are
// the ones src/architect.ts writes: a file conflict (fileConflict), an integration conflict
// (integrationConflict) and a blocker out of diagnoses (noProgress).
import { expect, test } from 'claude-code/testing'
import { isArchitectQuestion } from '../src/architect'
import { afterMs, answerLabel, asksInWindow, decidedLine, forwardWhen, openWindowDecision, optionAnswer, parseQuestions, questionText, routeNote, SEPARATE, WAIT, windowOptions } from '../src/channel'
import { architectContext } from '../src/session'
import { TOOL_SPECS } from '../src/tools'
import type { Decision, TaskRecord } from '../src/types'

const T0 = 1794542400000
const MIN = 60_000
const TEN = afterMs({ telegramAfterMinutes: 10 })
const CHAT = '5550001'

const conflict: Decision = {
  id: 'q-20261113-aaa111', kind: 'file-conflict', createdAt: T0,
  question: '长期任务「greet」（l-20261113-zzyzxo）：实施子代理「改成 hey」和仍在运行的实施子代理「改成 hi」改动了同一个文件 greet.py。已暂停后启动的实施子代理「改成 hey」。让它在单独的工作副本中继续，还是等实施子代理「改成 hi」完成后再继续？',
  options: [SEPARATE, WAIT], data: { agentId: 'ac77881ff6b69b608', otherAgentId: 'a92952f59ae89de8a', path: '/tmp/proj/greet.py', cause: 'same-file' },
}
const waitOnly: Decision = { ...conflict, id: 'q-20261113-aaa222', options: [WAIT] }
const integration: Decision = {
  id: 'q-20261113-bbb111', kind: 'integration-conflict', createdAt: T0 + MIN,
  question: '长期任务「greet」（l-20261113-zzyzxo）的改动没能应用到 /tmp/proj：与那里已有的改动冲突。冲突文件：greet.py。\n处理好冲突后回复“重试”，或回复“放弃”保留工作副本、不整合。',
  options: ['重试', '放弃'], data: { source: '/tmp/wt/l-20261113-zzyzxo', target: '/tmp/proj', baseRef: 'refs/magpie-tasks/l-20261113-zzyzxo/base', files: 'greet.py' },
}
const noProgress: Decision = {
  id: 'q-20261113-ccc111', kind: 'no-progress', createdAt: T0 + 2 * MIN,
  question: '长期任务「greet」（l-20261113-zzyzxo）没有进展：阻碍 b1（测试机连不上）已经做过一次独立诊断，架构师又申报了一次诊断。受影响的工作已暂停，请和架构师商量下一步。',
  options: ['同意架构师的方案', '不同意'], data: { blockerId: 'b1', agentId: 'a92952f59ae89de8a', outcome: 'diagnosis' },
}

test('a question answered within the wait never goes to Telegram: until then the timer has time left', () => {
  const asked = { chatId: CHAT, sent: false, telegramTurn: false, askedAt: T0, afterMs: TEN }
  expect(forwardWhen({ ...asked, now: T0 })).toEqual({ when: 'later', inMs: 10 * MIN })
  expect(forwardWhen({ ...asked, now: T0 + 9 * MIN + 59_000 })).toEqual({ when: 'later', inMs: 1000 })
})

test('an unanswered question goes to Telegram when the wait is over', () => {
  const asked = { chatId: CHAT, sent: false, telegramTurn: false, askedAt: T0, afterMs: TEN }
  expect(forwardWhen({ ...asked, now: T0 + 10 * MIN })).toEqual({ when: 'now' })
  expect(forwardWhen({ ...asked, now: T0 + 3 * 60 * MIN })).toEqual({ when: 'now' })
  // The option telegramAfterMinutes sets the wait.
  expect(forwardWhen({ ...asked, afterMs: afterMs({ telegramAfterMinutes: 1 }), now: T0 + 59_000 })).toEqual({ when: 'later', inMs: 1000 })
  expect(forwardWhen({ ...asked, afterMs: afterMs({ telegramAfterMinutes: 1 }), now: T0 + MIN })).toEqual({ when: 'now' })
})

test('a turn a Telegram message started sends at once; nothing goes twice, to a terminal-only chat, or without a chat', () => {
  const asked = { chatId: CHAT, sent: false, telegramTurn: true, askedAt: T0, now: T0, afterMs: TEN }
  expect(forwardWhen(asked)).toEqual({ when: 'now' })
  expect(forwardWhen({ ...asked, sent: true })).toEqual({ when: 'never' })
  expect(forwardWhen({ ...asked, chatId: 'tui' })).toEqual({ when: 'never' })
  expect(forwardWhen({ ...asked, chatId: undefined })).toEqual({ when: 'never' })
  expect(forwardWhen({ ...asked, telegramTurn: false, chatId: 'tui', now: T0 + 60 * MIN })).toEqual({ when: 'never' })
})

test('after a restart a question keeps the rest of its wait, and an overdue one goes at once', () => {
  // Asked at T0; the session came back four minutes later, then again after twenty-five.
  const asked = { chatId: CHAT, sent: false, telegramTurn: false, askedAt: T0, afterMs: TEN }
  expect(forwardWhen({ ...asked, now: T0 + 4 * MIN })).toEqual({ when: 'later', inMs: 6 * MIN })
  expect(forwardWhen({ ...asked, now: T0 + 25 * MIN })).toEqual({ when: 'now' })
  // It went to Telegram before the restart: the restart sends nothing more.
  expect(forwardWhen({ ...asked, sent: true, now: T0 + 25 * MIN })).toEqual({ when: 'never' })
})

test('a dialog offers the question\'s options, and each label stands for the answer the decision takes', () => {
  expect(windowOptions(conflict)).toEqual(['单独副本', '等待前一方'])
  expect(optionAnswer(conflict, '单独副本')).toBe('separate')
  expect(optionAnswer(conflict, '等待前一方')).toBe('wait')
  expect(optionAnswer(integration, '重试')).toBe('approve')
  expect(optionAnswer(integration, '放弃')).toBe('reject')
  expect(optionAnswer(noProgress, '同意架构师的方案')).toBe('approve')
  expect(optionAnswer(noProgress, '不同意')).toBe('reject')
  // Text typed under the dialog's Other is read by Jev (null here).
  expect(optionAnswer(conflict, '让它等着吧')).toBeNull()
  // A question with one option gets a second one that leaves it open ($.ui.ask takes two at least).
  expect(windowOptions(waitOnly)).toEqual(['等待前一方', '稍后回答'])
  expect(optionAnswer(waitOnly, '等待前一方')).toBe('wait')
  expect(optionAnswer(waitOnly, '稍后回答')).toBe('later')
  expect(optionAnswer(conflict, '稍后回答')).toBeNull()
})

// What src/unavailable.ts asks when a subagent's model is unavailable and no rule offers a substitute
// (the E14 subagent on codex/gpt-6-magpie-missing, chosen by the person), and what startup recovery
// asks about a task it cannot resume as it was (src/recovery.ts interruptedDecision).
const unavailable: Decision = {
  id: 'q-20261113-ddd111', kind: 'model-unavailable', createdAt: T0 + 5 * MIN,
  question: '「greet」的实施子代理「统计行数」（codex/gpt-6-magpie-missing）不可用（model_not_found），这是你指定的模型。可以等待，或改用其他模型（可选：Opus 5.5、Sol 6.1、Mythos 5.2）。',
  options: ['等待', '改用 Opus 5.5', '改用 Sol 6.1', '改用 Mythos 5.2'], data: { agentId: 'a5b6c7d8e9f001122', error: 'model_not_found', effort: 'high', candidates: 'claude/claude-opus-5-5,codex/gpt-6.1-sol,claude/claude-mythos-5-2' },
}
const interrupted: Decision = {
  id: 'q-20261113-eee111', kind: 'interrupted', createdAt: T0 + 6 * MIN, askedAt: T0 + 6 * MIN,
  question: '长期任务「greet」（l-20261113-zzyzxo）中断后无法自动恢复：工作副本 /tmp/wt/l-20261113-zzyzxo 不存在。请检查后选择“继续”，任务接着运行；选择“暂停”则保持暂停。',
  options: ['继续', '暂停'], data: { reason: '工作副本 /tmp/wt/l-20261113-zzyzxo 不存在' },
}

test('the dialog kinds are the plugin\'s questions, the unavailable model and the interruption among them; words typed in the window answer the one asked last', () => {
  for (const kind of ['file-conflict', 'integration-conflict', 'no-progress', 'fix-confirm', 'model-unavailable', 'interrupted'] as const) expect(asksInWindow({ kind })).toBe(true)
  for (const kind of ['model-change-confirm', 'route-confirm'] as const) expect(asksInWindow({ kind })).toBe(false)
  const withDecisions = (decisions: Decision[]) => ({ decisions: Object.fromEntries(decisions.map(d => [d.id, d])) }) as unknown as TaskRecord
  expect(openWindowDecision(withDecisions([conflict, integration, noProgress]))?.id).toBe(noProgress.id)
  expect(openWindowDecision(withDecisions([conflict, { ...noProgress, resolvedAt: T0 + 3 * MIN, answer: 'approve', via: 'window' }, integration]))?.id).toBe(integration.id)
  expect(openWindowDecision(withDecisions([unavailable, conflict]))?.id).toBe(unavailable.id)
  expect(openWindowDecision(withDecisions([interrupted, unavailable]))?.id).toBe(interrupted.id)
  expect(openWindowDecision(withDecisions([{ ...unavailable, resolvedAt: T0 + 7 * MIN, answer: '等待', via: 'window' }]))).toBeUndefined()
})

test('a model-unavailable answer is the label chosen, whichever option it is; the interruption\'s two options are continue and pause', () => {
  expect(windowOptions(unavailable)).toEqual(['等待', '改用 Opus 5.5', '改用 Sol 6.1', '改用 Mythos 5.2'])
  expect(optionAnswer(unavailable, '等待')).toBe('等待')
  expect(optionAnswer(unavailable, '改用 Opus 5.5')).toBe('改用 Opus 5.5')
  expect(optionAnswer(unavailable, '改用 Sol 6.1')).toBe('改用 Sol 6.1')
  expect(optionAnswer(unavailable, '改用 Mythos 5.2')).toBe('改用 Mythos 5.2')
  // Words typed under the dialog's Other are the person's answer as they stand, as on Telegram.
  expect(optionAnswer(unavailable, ' 先用 Astra 吧 ')).toBe('先用 Astra 吧')
  expect(optionAnswer(unavailable, '  ')).toBeNull()
  // With no candidate the question has one option and a second that leaves it open.
  const alone = { ...unavailable, options: ['等待'] }
  expect(windowOptions(alone)).toEqual(['等待', '稍后回答'])
  expect(optionAnswer(alone, '稍后回答')).toBe('later')
  expect(optionAnswer(alone, '等待')).toBe('等待')
  expect(optionAnswer(interrupted, '继续')).toBe('approve')
  expect(optionAnswer(interrupted, '暂停')).toBe('reject')
  expect(decidedLine(resolved(unavailable, '改用 Sol 6.1', 'window'))).toBe('这个问题已经在窗口里按「改用 Sol 6.1」决定，这次回答没有再执行。')
  expect(decidedLine(resolved(unavailable, '用 Sol 吧', 'telegram'))).toBe('这个问题已经在 Telegram 上按「用 Sol 吧」决定，这次回答没有再执行。')
  expect(decidedLine(resolved(interrupted, 'reject', 'window'))).toBe('这个问题已经在窗口里按「暂停」决定，这次回答没有再执行。')
})

const resolved = (d: Decision, answer: string, via: Decision['via']): Decision => ({ ...d, resolvedAt: T0 + MIN, answer, via })

test('a later answer from the other side gets one line naming where and how the question was decided', () => {
  expect(decidedLine(resolved(conflict, 'wait', 'telegram'))).toBe('这个问题已经在 Telegram 上按「等待前一方」决定，这次回答没有再执行。')
  expect(decidedLine(resolved(conflict, 'separate', 'window'))).toBe('这个问题已经在窗口里按「单独副本」决定，这次回答没有再执行。')
  expect(decidedLine(resolved(integration, 'reject', 'window'))).toBe('这个问题已经在窗口里按「放弃」决定，这次回答没有再执行。')
  expect(decidedLine(resolved(conflict, 'wait', 'architect'))).toBe('这个问题已经由架构师按「等待前一方」决定，这次回答没有再执行。')
  expect(answerLabel({ ...noProgress, answer: 'approve' })).toBe('同意架构师的方案')
})

test('the note the architect reads names where the person was asked', () => {
  const opts = { telegramAfterMinutes: 10 }
  expect(routeNote('window-then-telegram', opts)).toBe('The person was asked in the window; unanswered for 10 minutes, the question goes to Telegram too.')
  expect(routeNote('both', opts)).toBe('The person was asked in the window and on Telegram.')
  expect(routeNote('window', opts)).toBe('The person was asked in the window (the task has no Telegram chat).')
})

// The call Opus 5.5 made in the architect session of /tmp/mt-e2e-qg8n on 2026-11-13 (debug log).
const TEA = { questions: [{ question: '喜欢茶还是咖啡？', header: '饮品', multiSelect: false, options: [{ label: '茶', description: '选择茶' }, { label: '咖啡', description: '选择咖啡' }] }], tool: 'AskUserQuestion', tool_use_id: 'toolu_01EHTzPXe5Tpmqp8EgG8jUeU' }

test('the questions of an AskUserQuestion call are read with what each option means under the question', () => {
  const [q] = parseQuestions(TEA.questions)
  expect(q).toEqual({ question: '喜欢茶还是咖啡？', header: '饮品', multiSelect: false, options: [{ label: '茶', description: '选择茶' }, { label: '咖啡', description: '选择咖啡' }] })
  expect(questionText(q!)).toBe('喜欢茶还是咖啡？\n· 茶：选择茶\n· 咖啡：选择咖啡')
  expect(questionText({ ...q!, options: [{ label: '茶', description: '' }, { label: '咖啡', description: '' }] })).toBe('喜欢茶还是咖啡？')
  expect(() => parseQuestions([])).toThrow('non-empty array')
  expect(() => parseQuestions(undefined)).toThrow('non-empty array')
  expect(() => parseQuestions([{ question: '', options: [] }])).toThrow('question 1 has no text')
  expect(() => parseQuestions([{ question: '茶？', options: [{ label: '茶' }] }])).toThrow('at least two options')
  expect(() => parseQuestions([{ question: '茶？', options: [{ label: '茶' }, {}] }])).toThrow('option 2 of question 1 has no label')
})

test('the take-over is for the architect model\'s own call, not for a dialog a plugin raised', () => {
  expect(isArchitectQuestion(TEA)).toBe(true)
  // A plugin's $.ui.ask reaches tool.call under an ID the engine makes (same log: the probe dialog).
  expect(isArchitectQuestion({ questions: [{ question: 'probe Q1: pick one?', header: 'probe', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }], tool: 'AskUserQuestion', tool_use_id: 'toolu_plugin_ceb3768629d24991b782e75f50e664ea' })).toBe(false)
})

test('the architect is told to ask with AskUserQuestion and what notify_user is for, with the configured wait', () => {
  const task = { id: 'l-20261113-zzyzxo', title: 'greet', project: { root: '/tmp/proj' }, direct: { dir: '/tmp/proj', baseRef: 'refs/magpie-tasks/l-20261113-zzyzxo/base', baseCommit: 'fd7efb6' }, worktree: null, extraWorktrees: {}, blockers: {}, decisions: {} } as unknown as TaskRecord
  const text = architectContext(task, { worktreeDir: '/tmp/wt', telegramAfterMinutes: 7 })
  expect(text).toContain('Ask what they must decide with AskUserQuestion')
  expect(text).toContain('when nobody answers within 7 minutes, sends it to Telegram too')
  expect(text).toContain('goes to Telegram when they send this session nothing within 7 minutes')
  expect(text).toContain('Markdown is fine')
  expect(text).not.toContain('reaches the person on Telegram')
  expect(TOOL_SPECS.notify_user.inputSchema['properties']).toEqual({ kind: { type: 'string', enum: ['result', 'done'] }, text: { type: 'string', description: 'The message, in Chinese.' } })
  expect(TOOL_SPECS.notify_user.description).toContain('a question to the person is an AskUserQuestion call')
  expect(TOOL_SPECS.notify_user.description).not.toContain('Markdown')
  expect(TOOL_SPECS.integrate.description).toContain('in the window, and on Telegram when nobody answers there')
})
