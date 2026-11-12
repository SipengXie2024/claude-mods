// Subagent views and delegation inputs as Jev reads them (plan section 12.1, dialogue row). Input:
// real `$.session.messages({ as: 'api' })` dumps of the 2026-11-09 interface probe and real briefs,
// copied to tests/data.
import { expect, test } from 'claude-code/testing'
import { FILE_HEAD, briefForJev, briefPaths, delegationMessages, endedTurn, spawningDialogue, subagentDialogue } from '../src/dialogue'
import type { JevMessage } from '../src/jev'
import { dump006, dump032, dump034, dump044, dump047, dump048, type Dump } from './data/api-dumps'
import { briefHey, briefMultisetDesign, briefProviderFeasibility } from './data/briefs'

const ALL: Record<string, Dump> = { dump006, dump032, dump034, dump044, dump047, dump048 }
const users = (d: JevMessage[]) => d.filter(m => m.role === 'user').map(m => m.content)
const startsWith = (a: JevMessage[], b: JevMessage[]) => a.length >= b.length && b.every((m, i) => a[i]!.role === m.role && a[i]!.content === m.content)

test('a subagent\'s first view is its brief', () => {
  expect(subagentDialogue(dump006.api)).toEqual([
    { role: 'user', content: 'Run the Bash command `echo chk-sub-321` and report exactly what it printed. Do nothing else.' },
  ])
})

test('the last item of a view taken at turn.complete is the answer turn.complete reported', () => {
  for (const [name, dump] of Object.entries(ALL)) {
    if (dump.event?.answer === undefined) continue
    const last = subagentDialogue(dump.api).at(-1)!
    expect([name, last.role, last.content]).toEqual([name, 'assistant', dump.event.answer.trim()])
  }
})

test('a finished subagent resumed by the coordinator: the wrapper goes, the message stays, newest before the answer', () => {
  expect(subagentDialogue(dump032.api)).toEqual([
    { role: 'user', content: 'Run the Bash command `echo chk-sub-321` and report exactly what it printed. Do nothing else.' },
    { role: 'assistant', content: 'The command printed: `chk-sub-321`' },
    { role: 'user', content: 'CHK-FOLLOWUP-888: now run echo chk-sub-follow-999 and report what it printed.' },
    { role: 'assistant', content: dump032.event!.answer!.trim() },
  ])
})

test('a coordinator message delivered inside a tool result while the subagent ran is kept after the brief', () => {
  const d = subagentDialogue(dump048.api)
  expect(d[0]!.content.startsWith('Run this Bash command in the foreground exactly as written')).toBe(true)
  expect(d[1]).toEqual({ role: 'user', content: 'CHK-FOLLOWUP-WORKING: after that, also run echo chk-sub2-extra and report it.' })
})

test('the turn a subagent ended: the message that resumed it and the tool calls since; a message that arrived while it worked belongs to the turn it arrived in', () => {
  expect(endedTurn(dump032.api, [])).toEqual({ asked: 'CHK-FOLLOWUP-888: now run echo chk-sub-follow-999 and report what it printed.', tools: 1 })
  // 048: the brief's command, then two more after the mid-turn message and the background task's event.
  expect(endedTurn(dump048.api, [])).toEqual({ asked: 'CHK-FOLLOWUP-WORKING: after that, also run echo chk-sub2-extra and report it.', tools: 3 })
})

test('a message that starts with one of the plugin\'s own heads is not what the person asked: the turn reaches back to the brief', () => {
  expect(endedTurn(dump032.api, ['CHK-FOLLOWUP-888'])).toEqual({ asked: 'Run the Bash command `echo chk-sub-321` and report exactly what it printed. Do nothing else.', tools: 2 })
})

test('task events: same id and summary with another result are both kept (034 msg10, msg48); an identical copy is kept once (048 msg0, msg4)', () => {
  const main = users(subagentDialogue(dump034.api)).filter(t => t.startsWith('Background task event: Agent "Run echo chk-sub-321" finished'))
  expect(main).toHaveLength(2)
  expect(main[0]!.endsWith('The command printed: `chk-sub-321`')).toBe(true)
  expect(main[1]!.endsWith('The command printed: `chk-sub-follow-999`')).toBe(true)
  const sub = subagentDialogue(dump048.api)
  const events = users(sub).filter(t => t.startsWith('Background task event: '))
  expect(events).toHaveLength(1)
  expect(sub.at(-2)!.content).toBe(events[0]!)
})

test('reminders, task-notification markup, tool traffic and the coordinator wrapper never reach Jev', () => {
  for (const [name, dump] of Object.entries(ALL)) {
    const text = subagentDialogue(dump.api).map(m => m.content).join('\n')
    for (const gone of ['<system-reminder', '<task-notification>', '<tool-use-id>', 'The coordinator sent a message while you were working', '[SYSTEM NOTIFICATION']) {
      expect([name, gone, text.includes(gone)]).toEqual([name, gone, false])
    }
  }
})

test('a later view of the same subagent starts with the earlier one (OpenAI reads it from the cache)', () => {
  expect(startsWith(subagentDialogue(dump032.api), subagentDialogue(dump006.api))).toBe(true)
  expect(startsWith(subagentDialogue(dump048.api), subagentDialogue(dump047.api).slice(0, 2))).toBe(true)
  expect(startsWith(subagentDialogue(dump047.api), [subagentDialogue(dump044.api)[0]!])).toBe(true)
})

const MARKER = '[magpie-tasks task=l-20261109-k3x9qa role=implementer rule=code-change rules=routing-rules.v1 model=claude/claude-opus-5-5 effort=xhigh]'

test('briefForJev removes the routing control lines and tokens, and nothing else', () => {
  const brief = [
    MARKER,
    '[magpie-tasks-request daily chat=8812 message=953 worker=tg-953]',
    '[model-reason user: 用 Haiku，我指定的]',
    '[effort high]',
    '[review-of agent=a83b0057bf058d018]',
    '',
    'Add a main function to greet.py and run it. [review-of model=codex/gpt-6.1-sol,claude/claude-opus-5-5]',
    '',
    '',
    'Mention of `[magpie-tasks task=` in a quote stays.',
  ].join('\n')
  expect(briefForJev(brief)).toBe('Add a main function to greet.py and run it.\n\n\nMention of `[magpie-tasks task=` in a quote stays.')
  expect(briefForJev('Run the Bash command `echo chk-sub-321`.\n[effort none]')).toBe('Run the Bash command `echo chk-sub-321`.\n[effort none]')
})

test('the brief of a routed subagent reaches Jev without its marker; later items are untouched', () => {
  // dump032 with its brief block carrying the marker line magpie-tasks writes first.
  const routed = JSON.parse(JSON.stringify(dump032.api).replace('Run the Bash command `echo chk-sub-321`', `${MARKER}\\nRun the Bash command \`echo chk-sub-321\``)) as Dump['api']
  expect(JSON.stringify(routed)).toContain(MARKER)
  expect(subagentDialogue(routed)).toEqual(subagentDialogue(dump032.api))
})

test('a tg-router worker brief reaches Jev as the person\'s own words, without the title and the fixed instructions', () => {
  const words = '去那个 claude mods 文件夹下面，看看能不能支持这么一个事情：改造 cloudcode 的 provider 机制，让它同时能满足用 anthropic 的订阅；然后我在 /models 切换的时候，也能把 codex 订阅里的模型引入进来。'
  expect(briefForJev(briefProviderFeasibility)).toBe(words)
  // The same brief as magpie-tasks routes it: marker first, task rules appended.
  const routed = `[magpie-tasks task=d-20261104-a1b2c3 role=executor rule=code-read rules=routing-rules.v4 model=claude/claude-opus-5-5 effort=medium]\n${briefProviderFeasibility}\n\n[magpie-tasks task-rules] Task rules from magpie-tasks (task d-20261104-a1b2c3):\n- Work only in the task worktree.`
  expect(briefForJev(routed)).toBe(words)
  // An architect's own brief has no such line and keeps its text.
  expect(briefForJev(briefHey)).toBe(briefHey)
})

test('briefPaths: the absolute paths a brief names, in order, without the punctuation after them', () => {
  expect(briefPaths(briefMultisetDesign)).toEqual([
    '/home/ubuntu/.agents/skills/formalize-and-substitute/SKILL.md',
    '/home/ubuntu/sipeng/blockchain-catchup',
    '/tmp/formalize-and-substitute-workspace/iteration-1/eval-multiset-pq-digest/with_skill/outputs/report.md',
    '/tmp/fas-run-multiset-with/',
  ])
  // Relative paths (`_classics/txt-flow/`, `meta/papers.tsv`) name none.
  expect(briefPaths(briefMultisetDesign).some(p => p.includes('txt-flow') || p.includes('papers.tsv'))).toBe(false)
  expect(briefPaths(briefHey)).toEqual(['/home/ubuntu/.local/share/magpie-tasks/worktrees/l-20261109-5vf47x'])
})

test('a delegation reaches Jev as the spawning conversation, the named files, then the brief', () => {
  const dialogue = spawningDialogue(dump034.api, false)
  const files = [{ path: '/home/ubuntu/.agents/skills/formalize-and-substitute/SKILL.md', text: briefHey }]
  const input = delegationMessages(dialogue, files, briefMultisetDesign)
  expect(input.slice(0, dialogue.length)).toEqual(dialogue)
  expect(input[dialogue.length]).toEqual({ role: 'user', content: `${FILE_HEAD} ${files[0]!.path}\n${briefHey}` })
  expect(input.at(-1)).toEqual({ role: 'user', content: briefForJev(briefMultisetDesign) })
  expect(input).toHaveLength(dialogue.length + 2)
  // A brief without a conversation (the eval sheet, the io tests) is the brief message alone.
  expect(delegationMessages([], [], briefProviderFeasibility)).toEqual([{ role: 'user', content: briefForJev(briefProviderFeasibility) }])
})

test('the spawning conversation of a delegating subagent is its own view, its brief through briefForJev', () => {
  expect(spawningDialogue(dump006.api, true)).toEqual(subagentDialogue(dump006.api))
  expect(spawningDialogue(dump048.api, true)).toEqual(subagentDialogue(dump048.api))
  // The main loop's view keeps the person's first message as typed.
  expect(spawningDialogue(dump034.api, false)[0]!.role).toBe('user')
  expect(users(spawningDialogue(dump034.api, false))).toEqual(users(subagentDialogue(dump034.api)))
})
