// brief.ts (plan section 12.1, brief row): the task marker and control lines, tg-router's request
// header, and the final lines agents end with. The answers below are real claude-magpie -p answers
// (claude/claude-opus-5-5, effort low, 2026-11-09, run from /tmp/f-gen/work) to briefs this module
// wrote: executorDone / executorBlocked to withRouting(<task>, executor marker, { cwd: null, daily: true }),
// acceptancePass to acceptanceBrief (no change), diagnosisUser to diagnosisBrief, assessmentRecommend to
// assessmentBrief, and assessmentConfirm to the person's reply resuming that assessment session.
// Variants with ASCII colons and extra spaces are made from these answers by text replacement.
import { expect, test } from 'claude-code/testing'
import { briefForJev } from '../src/dialogue'
import {
  assessmentBrief, handoffBrief, marker, parseDiagnosis, parseEffortLine, parseMarker, parseModelLine, parseModelReason, parseRequestHeader,
  parseReviewOf, parseRouteConfirm, parseStatus, parseVerdict, requestText, withRouting, type MarkerInfo,
  OUTCOME_NOTE, outcomeNote, stripOutcomeNote,
} from '../src/brief'
import { parseRules } from '../src/rules'
import { routingRules } from './data/jev-rules'
import { jevSpawnScheduler } from './data/jev-responses'

const ANSWERS: Record<string, { session: string; model: string; text: string }> = {
  "executorDone": {
    "session": "5b92fcdf-e255-4c06-aa20-04b656038433",
    "model": "claude/claude-opus-5-5",
    "text": "`/tmp/f-gen/work/greet.py` 共有 6 行。文件末尾带换行符，所以 `wc -l` 统计的数字就是实际行数。\n\n验证：\n`wc -l /tmp/f-gen/work/greet.py`：输出 6\n`tail -c1 /tmp/f-gen/work/greet.py | xxd`：最后一个字节是 0a，即换行符\n状态：已完成"
  },
  "executorBlocked": {
    "session": "867b2853-dcc6-4402-8e5c-2db106e10bb5",
    "model": "claude/claude-opus-5-5",
    "text": "测试没有跑起来，所以给不出通过数。\n\n`python3 -m pytest -q /tmp/f-gen/work` 失败，报错是 `/usr/bin/python3: No module named pytest`。原因是这台机器的系统 Python 里没有装 pytest（Python 的测试框架）。\n\n装上 pytest 也得不到通过数。`/tmp/f-gen/work` 里只有一个文件 `greet.py`，没有任何测试文件，pytest 会报告 0 个测试。如果你另有测试套件的位置，请告诉我路径。\n\n验证：\n`python3 -m pytest -q /tmp/f-gen/work` → 失败：`No module named pytest`\n`ls -a /tmp/f-gen/work` → 只有 `greet.py`，没有测试文件\n\n状态：受阻：系统 Python 没有安装 pytest，而且 `/tmp/f-gen/work` 里没有任何测试文件。"
  },
  "acceptancePass": {
    "session": "d5e5a556-b9ad-4cf8-8d3c-04d1efffdd78",
    "model": "claude/claude-opus-5-5",
    "text": "我重新运行了执行者的两条命令，结果一致，回答正确。\n\n- `wc -l /tmp/f-gen/work/greet.py` 输出 6。\n- `tail -c1 /tmp/f-gen/work/greet.py | xxd` 显示最后一个字节是 `0a`（换行符）。所以最后一行也有换行结尾，`wc -l` 没有少数一行。\n- 我另外用 `cat -A` 查看了全文（这个参数会在每行末尾显示 `$`）。文件共 6 行：2 行函数定义、2 个空行、2 行 `__main__` 代码块。数出来也是 6 行。\n\n用户要的是一个数字。执行者给出的 6 与上面的复核结果相同，附带的说明也属实。\n\n验收结论：通过"
  },
  "diagnosisUser": {
    "session": "f6d28e1b-b857-4ab7-9f74-d3a14f33f8f9",
    "model": "claude/claude-opus-5-5",
    "text": "真正的阻碍是 `/tmp/f-gen/work` 里根本没有测试套件。pytest 缺失只是次要问题，可以绕过。执行代理报告的两条事实我都复核过了，都成立。\n\n**证据**\n\n- **目录里没有测试代码。** `ls -la /tmp/f-gen/work` 显示只有一个 99 字节的 `greet.py`，内容是一个 `greet(name)` 函数和一个 `__main__` 入口。整个 `/tmp/f-gen` 下搜索不到任何 `test_*.py`、`*_test.py`、`conftest.py`、`pytest.ini` 或 `pyproject.toml`。`greet.py` 里也没有 doctest（写在函数说明文字里的 `>>>` 示例，可以当测试运行），`>>>` 出现 0 次。\n- **系统 Python 没有 pytest。** 运行 `python3 -m pytest --version` 输出 `/usr/bin/python3: No module named pytest`。不过机器上有 `uv`/`uvx`（在 `~/.local/bin`），可以临时调用 pytest，不需要改系统环境。\n\n就算用 `uvx pytest -q /tmp/f-gen/work` 跑起来，结果也只会是 \"no tests ran\"（0 个测试，pytest 的退出码是 5）。这回答不了\"多少个测试通过\"，因为要跑的测试不存在。\n\n问题出在任务的设置上：给的路径和实际内容对不上。执行代理的模型没有问题，它的判断正确，证据也完整，换模型或让原代理继续都不会改变结果。\n\n**下一步**：请用户确认测试套件的真实位置，或者先把测试文件放进 `/tmp/f-gen/work`。拿到路径后，原代理可以用 `uvx pytest -q <路径>` 运行并报告通过数。\n\n诊断建议：交给用户"
  },
  "assessmentRecommend": {
    "session": "c009e5cb-7539-4c70-8d86-72764d83be16",
    "model": "claude/claude-opus-5-5",
    "text": "推荐用 **Sol 6.1，推理强度 high**。\n\n**最接近的规则是 `document-analysis`**（阅读材料和表格，核对结论与来源 → Sol 6.1 / high）。这个任务的主要工作有三步：读懂一份中英文混合的转写稿，认出每段话是谁说的，再把内容整理成表格。这和该规则的范围一致。它的验收要求是数字经过核对、结论能追溯原文，这正好覆盖了这个任务最容易出错的地方：发言人归属是否正确，时长数字是否准确。\n\n**和该规则的差别有两点：**\n\n- **输入更简单。** 只有一份转写稿，没有多份 PDF 或互相冲突的来源，所以\"说明冲突来源\"这条验收基本用不上。\n- **多了一步计算，但很轻。** 发言时长占比的算法是：每人的发言时长相加，再除以会议总时长。这一步用一个脚本完成，并保留脚本和输入即可，不需要按科学计算的规则单独路由。\n\n**验收时建议重点检查：**\n\n- 同一个人的中文名、英文名或缩写，在表格里合并成同一个发言人。\n- 表格每一行都能对回转写稿的原文位置。\n- 所有人的占比加起来等于 100%，并且注明时长按什么算。\n\n**证据没有覆盖的部分：**\n\n- [E2] 是一般的文档推理测评，没有直接测过中英文混合转写稿的整理效果，也没有测过发言人识别的准确程度。\n- 转写稿如果没有时间戳（每段话开始和结束的时刻），\"发言时长\"就只能估算，例如按中文字数加英文词数折算。这是一个口径选择（用什么标准算时长），会直接改变占比结果，测评证据也不涉及。执行前最好由你确认口径；如果转写稿带时间戳，就没有这个问题。\n\n推荐模型：codex/gpt-6.1-sol / high"
  },
  "assessmentConfirm": {
    "session": "c009e5cb-7539-4c70-8d86-72764d83be16",
    "model": "claude/claude-opus-5-5",
    "text": "已确认：这个任务用 **Sol 6.1，推理强度 high** 执行。\n\n执行时请留意时长口径。如果转写稿带时间戳（每段话开始和结束的时刻），就按时间戳计算每人的发言时长。如果没有时间戳，需要先确定按什么标准折算，例如中文按字数、英文按词数，并在结果里写明，因为口径不同，占比也会不同。\n\n选模确认：codex/gpt-6.1-sol / high"
  }
}

// tg-router's worker briefs (mods/tg-router/src/prompts.ts workerBrief, generated 2026-11-09 for the
// saved Jev requests' briefs); in claude-magpie tg-router puts the request header above them (plan 10.1).
const WORKER_BRIEFS: { telegram: string; terminal: string } = {
  "telegram": "You are a worker for one task that came from a Telegram chat: \"实现调度逻辑\".\nThe person's original message is at the end of this prompt; read it, not only the title.\n\n- Your final answer of each turn is posted, as written, as a Telegram reply under that message.\n  Write it in Chinese, at most 100 words: the result first, then paths, links or commit ids.\n  Plain text only: Telegram shows Markdown marks such as ** and backquotes as typed.\n  Do not send or edit Telegram messages yourself; the host sends your answer. A file the\n  message carries as attachment_file_id is fetched with the channel's download_attachment tool.\n- If you need a decision from the person, end the turn with one concrete question and stop.\n- A later Telegram message about this task reaches you as a message in this conversation.\n  If one is not about this task, do not work on it: put a line\n  HANDBACK <its message_id>: <one-sentence reason>\n  in your final answer. The host gives it back to the Router and removes the line.\n- Before you edit a git repository that another task or a person may also be editing,\n  work in your own worktree and branch.\n- Do the whole task and verify it. Report failures as failures.\n\nThe original message:\n实现并验证调度逻辑：按 .planning/plan-scheduler.md 中已确认的设计，在 src/scheduler.ts 实现优先级队列调度（同一优先级按到达顺序执行），补充单元测试，运行 bun test 确认全部通过，报告修改的文件与测试结果。",
  "terminal": "You are a worker for one task the person typed in the terminal of the Router session: \"统计 greet.py 行数\".\nThe person's original message is at the end of this prompt; read it, not only the title.\n\n- Your final answer of each turn is shown to the person in that terminal. Write it in Chinese:\n  the result first, then paths, links or commit ids. Markdown is fine.\n- If you need a decision from the person, end the turn with one concrete question and stop.\n- A later message about this task reaches you as a message in this conversation.\n- Before you edit a git repository that another task or a person may also be editing,\n  work in your own worktree and branch.\n- Do the whole task and verify it. Report failures as failures.\n\nThe original message:\n统计 greet.py 有几行，只回答数字。"
}
const HEADER = '[magpie-tasks-request daily chat=7051661301 message=878 worker=tg-7051661301-878]'

const rules = parseRules(routingRules, { deepYes: 0.85 })
const text = (k: string) => ANSWERS[k]!.text
const asciiColons = (s: string) => s.replace(/：/g, ':')
const spaced = (s: string) => s.replace(/(状态|验证|验收结论|选模确认|诊断建议)：/g, '  $1 ：  ').replace(/\n/g, '  \n')
const info: MarkerInfo = { taskId: 'd-20261109-k3x9q2', role: 'executor', ruleId: 'code-change', rulesVersion: rules.version, model: 'claude/claude-opus-5-5', effort: 'xhigh' }

test('the marker round-trips, matches the JEV skip pattern, and briefForJev strips it', () => {
  const m = marker(info)
  expect(m).toBe('[magpie-tasks task=d-20261109-k3x9q2 role=executor rule=code-change rules=routing-rules.v7 model=claude/claude-opus-5-5 effort=xhigh]')
  expect(parseMarker(m)).toEqual(info)
  expect(parseMarker(marker({ ...info, ruleId: null }))!.ruleId).toBe(null)
  // JEV's MAGPIE_TASKS_MARKER (plan section 10.2)
  expect(/^\[magpie-tasks task=[^\]\s]+[^\]\n]*\]/.test(m)).toBe(true)
  const brief = jevSpawnScheduler.request.input[0]!.content
  const routed = withRouting(brief, info, { cwd: '/home/ubuntu/.local/share/magpie-tasks/worktrees/d-20261109-k3x9q2', daily: false, direct: null })
  expect(routed.split('\n')[0]).toBe(m)
  expect(parseMarker(routed)).toEqual(info)
  // Jev reads the brief as delegated: no marker, no appended task rules.
  expect(briefForJev(routed)).toBe(briefForJev(brief))
  expect(() => marker({ ...info, model: 'claude/claude opus' })).toThrow()
})

test('withRouting replaces a marker already at the start and keeps the brief whole', () => {
  const brief = jevSpawnScheduler.request.input[0]!.content
  const once = withRouting(brief, info, { cwd: null, daily: true, direct: null })
  const twice = withRouting(once, { ...info, effort: 'max' }, { cwd: null, daily: true, direct: null })
  expect(twice.split('\n')[0]).toBe(marker({ ...info, effort: 'max' }))
  expect(twice.match(/\[magpie-tasks task=/g)!.length).toBe(1)
  expect(twice.includes(brief)).toBe(true)
  expect(once.includes('mcp__magpie-tasks__open_project')).toBe(true)
  expect(once.includes('If open_project gave you a worktree, never commit there')).toBe(true)
  const long = withRouting(brief, info, { cwd: '/w/l-1', daily: false, direct: null })
  expect(long.includes('mcp__magpie-tasks__open_project')).toBe(false)
  expect(long.includes('`/w/l-1`')).toBe(true)
  expect(long.includes('- Commit and push when the person asks for it, in the project main directory and never in the task worktree')).toBe(true)
  // A task that changes the project directory in place works there and commits there when asked.
  const direct = withRouting(brief, info, { cwd: '/home/u/repo', daily: true, direct: { git: true } })
  expect(direct.includes('- Work in the project directory `/home/u/repo` itself')).toBe(true)
  expect(direct.includes('- Commit and push only when the person asks for it, in the project directory.')).toBe(true)
  expect(direct.includes('worktree')).toBe(false)
  const plain = withRouting(brief, info, { cwd: '/home/u/notes', daily: true, direct: { git: false } })
  expect(plain.includes('It is not a Git repository, so the plugin keeps no diff: name every file you change in your report.')).toBe(true)
  for (const routed of [once, long, direct, plain]) for (const line of ['状态：已完成', '状态：需要用户决定', '状态：进行中：', '验证：']) expect(routed.includes(line)).toBe(true)
  for (const routed of [once, long, direct, plain]) expect(routed.includes('Do not commit')).toBe(false)
  const check = withRouting(brief, { ...info, role: 'acceptance' }, { cwd: '/w/l-1', daily: false, direct: null })
  expect(check.includes('- Do not commit, push, create branches, stash or reset; you only check.')).toBe(true)
  const checkDirect = withRouting(brief, { ...info, role: 'acceptance' }, { cwd: '/home/u/repo', daily: true, direct: { git: true } })
  expect(checkDirect.includes('- The task changed the project directory `/home/u/repo` in place (your working directory); run the checks there.')).toBe(true)
  const assess = withRouting(brief, { ...info, role: 'assessment' }, { cwd: null, daily: true, direct: null })
  expect(assess.includes('状态：已完成')).toBe(false)
})

test('control lines: model reason, effort, review-of', () => {
  const brief = jevSpawnScheduler.request.input[0]!.content
  expect(parseModelReason(`${brief}\n[model-reason user: 用 Sol 6.1 做，我指定的]`)).toEqual({ kind: 'user', text: '用 Sol 6.1 做，我指定的' })
  expect(parseModelReason(`[model-reason evidence：诊断 a1 建议更换模型]\n${brief}`)).toEqual({ kind: 'evidence', text: '诊断 a1 建议更换模型' })
  expect(parseModelReason(`[model-reason user: ]\n${brief}`)).toBe(null)
  expect(parseModelReason(brief)).toBe(null)
  expect(parseEffortLine(`${brief}\n[effort max]`)).toBe('max')
  expect(parseEffortLine(`${brief}\n[effort extreme]`)).toBe(null)
  expect(parseModelLine(`${brief}\n[model codex/gpt-6.1-sol]\n[model-reason user: 用 Sol]`)).toBe('codex/gpt-6.1-sol')
  expect(parseModelLine(brief)).toBe(null)
  // The architect's own words about the line, from the E6 run of 2026-11-09, name no model.
  expect(parseModelLine('Your job: use the Agent tool to delegate ONE subagent, WITHOUT specifying any model (leave the model parameter out and add no [model ...] line)')).toBe(null)
  expect(parseModelLine('[model claude/claude-opus-5-5[1m]]\nwork')).toBe('claude/claude-opus-5-5[1m]')
  expect(briefForJev(`[model codex/gpt-6.1-sol]\n${brief}`)).toBe(briefForJev(brief))
  expect(parseReviewOf(brief)).toBe(null)
  expect(parseReviewOf(`${brief}\n[review-of agent=a83b0057bf058d018]\n[review-of model=codex/gpt-6.1-sol, claude/claude-opus-5-5[1m]]`))
    .toEqual({ agents: ['a83b0057bf058d018'], models: ['codex/gpt-6.1-sol', 'claude/claude-opus-5-5[1m]'] })
  expect(parseReviewOf(`${brief}\n[review-of model=codex/gpt-6.1-sol,claude/claude-opus-5-5]`)).toEqual({ agents: [], models: ['codex/gpt-6.1-sol', 'claude/claude-opus-5-5'] })
})

test('tg-router request header and the original message', () => {
  const tgBrief = `${HEADER}\n${WORKER_BRIEFS.telegram}`
  expect(parseRequestHeader(tgBrief)).toEqual({ chatId: '7051661301', messageId: 878, worker: 'tg-7051661301-878' })
  expect(requestText(tgBrief)).toBe(jevSpawnScheduler.request.input[0]!.content)
  expect(parseRequestHeader(WORKER_BRIEFS.telegram)).toBe(null)
  const tui = `[magpie-tasks-request daily chat=tui message=12 worker=tui-12]\n${WORKER_BRIEFS.terminal}`
  expect(parseRequestHeader(tui)).toEqual({ chatId: 'tui', messageId: 12, worker: 'tui-12' })
  expect(() => requestText(jevSpawnScheduler.request.input[0]!.content)).toThrow()
})

test('status lines: done with its verification block, blocked with its reason', () => {
  const done = { status: 'done', verification: ['`wc -l /tmp/f-gen/work/greet.py`：输出 6', '`tail -c1 /tmp/f-gen/work/greet.py | xxd`：最后一个字节是 0a，即换行符'] }
  expect(parseStatus(text('executorDone'))).toEqual(done)
  expect(parseStatus(spaced(text('executorDone')))).toEqual(done)
  expect(parseStatus(asciiColons(text('executorDone')))!.status).toBe('done')
  const blocked = parseStatus(text('executorBlocked'))!
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocker).toBe('系统 Python 没有安装 pytest，而且 `/tmp/f-gen/work` 里没有任何测试文件。')
  expect(blocked.verification).toEqual(['`python3 -m pytest -q /tmp/f-gen/work` → 失败：`No module named pytest`', '`ls -a /tmp/f-gen/work` → 只有 `greet.py`，没有测试文件'])
  expect(parseStatus(asciiColons(text('executorBlocked')))!.blocker).toBe('系统 Python 没有安装 pytest，而且 `/tmp/f-gen/work` 里没有任何测试文件。')
  expect(parseStatus(text('executorDone').replace('状态：已完成', '状态：需要用户决定'))).toEqual({ ...done, status: 'needs-user' })
  expect(parseStatus(text('acceptancePass'))).toBe(null)
  expect(parseStatus(text('executorDone').replace('状态：已完成', '状态：受阻：'))).toBe(null)
  // An executor waiting for its own background agent: no acceptance, no diagnosis.
  expect(parseStatus('深化改写正在后台进行，返回后再审查。\n\n状态：进行中：等待深化改写子代理返回结果')).toEqual({ status: 'working', verification: [] })
  expect(parseStatus('状态: 进行中: 等待后台测试')!.status).toBe('working')
  expect(parseStatus(text('executorDone').replace('状态：已完成', '状态：进行中：'))).toBe(null)
})

test('acceptance verdict, routing confirmation and diagnosis suggestion', () => {
  const pass = parseVerdict(text('acceptancePass'))!
  expect(pass.pass).toBe(true)
  expect(pass.notes.startsWith('我重新运行了执行者的两条命令')).toBe(true)
  expect(pass.notes.includes('验收结论')).toBe(false)
  expect(parseVerdict(spaced(asciiColons(text('acceptancePass'))))!.pass).toBe(true)
  expect(parseVerdict(text('acceptancePass').replace('验收结论：通过', '验收结论：不通过'))!.pass).toBe(false)
  expect(parseVerdict(text('executorDone'))).toBe(null)

  expect(parseRouteConfirm(text('assessmentRecommend'))).toBe(null)
  expect(parseRouteConfirm(text('assessmentConfirm'))).toEqual({ model: 'codex/gpt-6.1-sol', effort: 'high' })
  expect(parseRouteConfirm(spaced(asciiColons(text('assessmentConfirm'))))).toEqual({ model: 'codex/gpt-6.1-sol', effort: 'high' })
  // The assessment brief itself ends with the decline line it teaches.
  const tgBrief = `${HEADER}\n${WORKER_BRIEFS.telegram}`
  const header = parseRequestHeader(tgBrief)!
  const task = { id: 'd-20261109-k3x9q2', title: '实现调度逻辑', request: requestText(tgBrief), followUps: [], telegram: { chatId: header.chatId, rootMessageId: header.messageId, workerName: header.worker } }
  const brief = assessmentBrief(task, rules)
  expect(parseRouteConfirm(brief)).toBe('cancel')
  expect(brief.includes(requestText(tgBrief))).toBe(true)
  for (const r of rules.rules.filter(r => r.use === 'subagent')) expect(brief.includes(`- ${r.id}: ${r.condition}`)).toBe(true)
  // A person-chosen model: the assessment recommends its effort, and its confirmation names it.
  const chosen = assessmentBrief(task, rules, { model: 'codex/gpt-6.1-sol', reason: '这个用 Sol 6.1 做' })
  expect(chosen.includes('The person asked for the model Sol 6.1 (codex/gpt-6.1-sol) in their own words: "这个用 Sol 6.1 做"')).toBe(true)
  expect(brief.includes('The person asked for the model')).toBe(false)

  expect(parseDiagnosis(text('diagnosisUser'))).toEqual({ action: 'user' })
  expect(parseDiagnosis(asciiColons(text('diagnosisUser')))).toEqual({ action: 'user' })
  const replaced = text('diagnosisUser').replace('诊断建议：交给用户', '诊断建议：更换模型 codex/gpt-6-astra / xhigh')
  expect(parseDiagnosis(replaced)).toEqual({ action: 'replace', model: 'codex/gpt-6-astra', effort: 'xhigh' })
  expect(parseDiagnosis(spaced(asciiColons(replaced)))).toEqual({ action: 'replace', model: 'codex/gpt-6-astra', effort: 'xhigh' })
  expect(parseDiagnosis(text('diagnosisUser').replace('诊断建议：交给用户', '诊断建议：继续原代理'))).toEqual({ action: 'continue' })
  expect(parseDiagnosis(text('diagnosisUser').replace('诊断建议：交给用户', '诊断建议：更换模型 Sol'))).toBe(null)
})

test('plugin-written briefs of a Telegram task keep tg-router\'s follow-up and attachment rules', () => {
  const tgBrief = `${HEADER}\n${WORKER_BRIEFS.telegram}`
  const header = parseRequestHeader(tgBrief)!
  const task = { id: 'd-20261109-k3x9q2', title: '实现调度逻辑', request: requestText(tgBrief), followUps: [], telegram: { chatId: header.chatId, rootMessageId: header.messageId, workerName: header.worker } }
  const at = 1762650000000
  const previous = {
    agentId: 'a83b0057bf058d018', role: 'executor' as const, sessionId: 's', ruleId: 'code-change', rulesVersion: rules.version,
    selection: { kind: 'rule' as const, reason: 'rule code-change' }, judgment: null, model: 'claude/claude-opus-5-5', effort: 'xhigh' as const,
    efforts: [], contextSource: 'brief' as const, cwd: '/w', worktree: null, state: 'idle' as const, pendingRaises: [], filesTouched: [],
    reports: [{ at, status: 'blocked' as const, text: text('executorBlocked'), verification: [] }], startedAt: at,
  }
  const full = {
    ...task, schema: 1 as const, kind: 'daily' as const, state: 'running' as const, pausedByUser: false, createdAt: at, updatedAt: at,
    owner: { kind: 'agent' as const, agentId: previous.agentId, workerName: header.worker, routerSessionId: 's' },
    project: null, worktree: null, extraWorktrees: {}, agents: { [previous.agentId]: previous }, blockers: {}, decisions: {},
    deliverables: [], feedback: [], ratings: [], pendingRelays: {},
  }
  // The lines tg-router's worker brief teaches (its HANDBACK line is the one tg-router parses).
  const handbackLine = 'HANDBACK <its message_id>: <one-sentence reason>'
  expect(WORKER_BRIEFS.telegram.includes(handbackLine)).toBe(true)
  for (const b of [handoffBrief(full, { reason: 'its model is unavailable', previous }), assessmentBrief(task, rules)]) {
    expect(b.split('\n').includes(handbackLine)).toBe(true)
    expect(b.includes('fetched with the channel\'s download_attachment tool')).toBe(true)
  }
  const tui = assessmentBrief({ ...task, telegram: null }, rules)
  expect(tui.includes('HANDBACK')).toBe(false)
})

// What the executor is told of its last result (the person is told nothing of acceptance or integration).
const told = (d: Parameters<typeof outcomeNote>[0]['deliverables'][number], decisions: Parameters<typeof outcomeNote>[0]['decisions'] = {}) =>
  outcomeNote({ deliverables: [d], decisions, project: { root: '/home/u/repo' } })
const result = { at: 1, summary: '改好了', verification: [] }
const failedFixed = { agentId: 'acc', pass: false, notes: '数字不对', fixed: { at: 2, decisionId: 'q1' } }
const question = { id: 'q1', kind: 'fix-confirm' as const, createdAt: 2, question: '要整合吗？', options: ['整合', '不整合'], data: {} }

test('the executor\'s note names what became of its last result: applied with or without a check, a conflict, a passed answer', () => {
  const applied = { status: 'applied' as const, files: ['greet.py', 'test_greet.py'], at: 3 }
  expect(told({ ...result, integration: applied })).toEqual({ key: 'applied', text: `${OUTCOME_NOTE} Your last result needed no acceptance check, and its change was applied to /home/u/repo: greet.py, test_greet.py. Commit or push there only when the person asks. This line is from the task plugin, not from the person, and needs no reply.` })
  expect(told({ ...result, acceptance: { agentId: 'acc', pass: true, notes: '' }, integration: applied })!.text).toContain('passed the acceptance check, and its change was applied to /home/u/repo')
  expect(told({ ...result, acceptance: failedFixed, integration: applied }, { q1: { ...question, resolvedAt: 4, answer: 'approve: 整合' } })!.text).toContain('failed the acceptance check, and the person approved your fix, and its change was applied')
  const conflict = told({ ...result, integration: { status: 'conflict', files: ['greet.py'], at: 3 } })!
  expect([conflict.key, conflict.text.includes('could not be applied to /home/u/repo'), conflict.text.includes('(greet.py)')]).toEqual(['conflict', true, true])
  expect(told({ ...result, acceptance: { agentId: 'acc', pass: true, notes: '' } })!.key).toBe('passed')
  expect(told({ ...result, acceptance: { agentId: 'acc', pass: true, notes: '' }, integration: { status: 'empty', files: [], at: 3 } })!.key).toBe('passed')
})

test('nothing is told for an unchecked answer, a failed check not yet fixed, or an outcome already told', () => {
  expect(told(result)).toBeNull()
  expect(told({ ...result, check: { needed: false, p: 0.04, provider: 'jev' } })).toBeNull()
  expect(told({ ...result, acceptance: { agentId: 'acc', pass: false, notes: '数字不对' } })).toBeNull()
  expect(told({ ...result, acceptance: { agentId: 'acc', pass: false, notes: '数字不对', fixed: { at: 2 } } })).toBeNull()
  expect(told({ ...result, integration: { status: 'applied', files: ['greet.py'], at: 3 }, told: 'applied' })).toBeNull()
})

test('a fixed change is told as asked about, then as declined or applied once the person has answered', () => {
  expect(told({ ...result, acceptance: failedFixed }, { q1: question })!.key).toBe('fix-asked')
  expect(told({ ...result, acceptance: failedFixed, told: 'fix-asked' }, { q1: question })).toBeNull()
  expect(told({ ...result, acceptance: failedFixed, told: 'fix-asked' }, { q1: { ...question, resolvedAt: 4, answer: 'reject: 不整合' } })!.key).toBe('fix-declined')
  expect(told({ ...result, acceptance: failedFixed, told: 'fix-asked', integration: { status: 'applied', files: ['greet.py'], at: 5 } }, { q1: { ...question, resolvedAt: 4, answer: 'approve: 整合' } })!.key).toBe('applied')
})

test('the note comes off a message it was added to, and nothing else does', () => {
  const note = told({ ...result, integration: { status: 'applied', files: ['greet.py'], at: 3 } })!.text
  expect(stripOutcomeNote(`提交吧\n\n${note}`)).toBe('提交吧')
  expect(stripOutcomeNote('提交吧')).toBe('提交吧')
  expect(stripOutcomeNote(`${OUTCOME_NOTE} 是什么意思？\n\n第二段`)).toBe(`${OUTCOME_NOTE} 是什么意思？\n\n第二段`)
})
