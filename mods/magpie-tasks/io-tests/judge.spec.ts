// Rule, deep and blocker judgments with the real Jev (plan section 12.1, judge and blocker rows). The
// briefs are the routing table's section 4 example and one brief per Jev-option rule, written from
// the rule's condition. Results are printed for the record; judgment quality is measured by
// eval/rules-eval.ts (section 12.3), so no accuracy bar is set here. Every judgment must come from
// Jev: `$.model.complete` exists only inside hooks, so the substitute path is not reachable here
// (scenario E13 checks it) and the `complete` given below throws if it were taken.
//
// SAVE_JEV_DATA=1 also saves raw responses to tests/data/jev-spawn-*.json and jev-blocker-*.json for
// tests/judge.test.ts; regenerate the test modules afterwards with `bun eval/rules-eval.ts data`.
import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { delegationMessages } from '../src/dialogue'
import { buildRequest, type JevConfig, type JevMessage, type JevQuestion } from '../src/jev'
import { blockerQuestion, CHECK_YES, checkInput, decideRule, judgeBlocker, judgeCheck, judgeSpawn, spawnQuestions, type JudgeCtx } from '../src/judge'
import { loadRules } from '../src/rules'
import type { Blocker } from '../src/types'
import { PLUGIN_ROOT } from '../eval/rules-eval'
import { nodeIo } from './node-io'

const KEY_FILE = join(homedir(), '.config/jev-opus/openai-jev.key')
const JEV: JevConfig = { url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', keyFile: KEY_FILE, deadlineMs: 30000 }
const rules = await loadRules(nodeIo(), PLUGIN_ROOT)
const ctx: JudgeCtx = {
  io: nodeIo(),
  jev: JEV,
  complete: async () => { throw new Error('$.model.complete is available only inside a hook; Jev failed in this test') },
  evaluatorModel: 'claude/claude-opus-5-5',
  rules,
}
const SAVE = process.env['SAVE_JEV_DATA'] === '1'

async function saveRaw(file: string, input: JevMessage[], questions: JevQuestion[]): Promise<void> {
  const key = readFileSync(KEY_FILE, 'utf8').trim()
  const request = buildRequest(JEV.model, input, questions)
  const res = await fetch(JEV.url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  const body = await res.text()
  expect(res.status).toBe(200)
  writeFileSync(join(PLUGIN_ROOT, 'tests/data', file), JSON.stringify({ kind: 'decisions', at: new Date().toISOString(), request, status: res.status, body }, null, 2) + '\n')
}

// Routing table section 4, step 1: "实现并验证调度逻辑".
const EXAMPLE = '实现并验证调度逻辑：按 .planning/plan-scheduler.md 中已确认的设计，在 src/scheduler.ts 实现优先级队列调度（同一优先级按到达顺序执行），补充单元测试，运行 bun test 确认全部通过，报告修改的文件与测试结果。'
// Scenario E6 step 4's request, as a brief.
const LINE_COUNT = '统计 greet.py 有几行，只回答数字。'

const BRIEFS: Record<string, string> = {
  'code-change': '设计已经确定：在 mods/tg-router/src/telegram.ts 中把 stateDir 改为依次读取 TG_ROUTER_STATE_DIR、TELEGRAM_STATE_DIR 和默认目录。修改后运行 claude plugin test mods/tg-router，报告修改的文件和测试结果。',
  'review': '独立审查工作副本 /home/ubuntu/wt/l-1 中刚完成的整合模块改动（git diff base..HEAD），检查是否有缺陷：冲突时是否会修改主目录、二进制文件是否正确处理。只报告问题、位置和依据，不修改代码。',
  'code-read': '只读调研：阅读 ~/sipeng/letus 中 Merkle 索引的实现，说明节点怎样分层、插入一个键时会更新哪些哈希，并标出对应的文件与行号。不要修改任何文件。',
  'design-advice': '为上下文记忆插件设计压缩后的历史归档方案：比较按会话存进 SQLite 与按日期写 JSONL 两种做法在检索、并发写入和清理上的取舍，给出推荐方案、理由和风险。只出方案，不写代码。',
  'web-research': '上网收集 Gemini 4 Argon 公开发布的测评成绩（官方博客、Artificial Analysis、LiveBench），每个数字记下来源链接和访问日期，整理成一张表。',
  'machine-ops': '这台机器上 cargo build 报 openssl-sys 找不到 pkg-config，项目编译不过。请配置好编译环境（安装需要的系统包、设置环境变量），让 cargo build --release 成功，并报告执行过的命令。',
  'batch-judge': '按 /tmp/rules.md 中的标准，给 /tmp/batch-3.jsonl 里的 25 条委派说明逐条标注应走的规则和是否需要深入推理，输出一个 JSON 数组，每条附一句理由。',
  'explain-write': '根据 .planning/findings.md 中已经核实的测量结果，写一段 600 字左右的中文说明，向非技术读者解释为什么 Jev 改用对话上下文后任务类型判断提高了，引用具体数字。',
  'document-analysis': '阅读 docs/ 下的三份 PDF（两份基准测评报告和一份厂商白皮书），核对白皮书中“吞吐量提升 3.2 倍”的结论与两份报告表格中的数据是否一致，逐条列出每个数字的来源页码。',
  'visual-build': '做一个单页 HTML 仪表盘展示 magpie-tasks 的任务状态（运行中、等待用户、已完成），配色清晰、适配手机屏幕，用浏览器截图检查布局。',
  'translation': '按 glossary.md 的术语表和 style.md 的翻译规范，把 game/dialogue_0012.rpy 中的 150 条英文对白译成中文，保持变量名和标签不变，译完运行 check.py 校验格式。',
  'math': '数列 a_n 满足 a_1 = 1，a_{n+1} = a_n + 1/a_n。求极限 lim_{n→∞} (a_n^2 − 2n − (1/2)·ln n)，给出完整推导。',
  'science-compute': '用 Python 读取 data/trace.csv（约 50 万行延迟测量），按请求大小分桶计算中位数和 p90，再用对数线性模型拟合延迟与输入大小的关系，输出拟合参数、R² 和一张散点图。',
  'lean': '在 Lean 4 + Mathlib 中为下面的命题写出正式证明：theorem sum_odd (n : ℕ) : ∑ i in Finset.range n, (2 * i + 1) = n ^ 2。证明需要通过 lake build。',
  'computer-use': '在浏览器里登录团队的 Jira，把上周所有标记为 blocked 的工单逐个打开，阅读评论判断阻塞是否已经解除；已解除的改为 In Progress，并留言说明依据。',
}

test('every Jev-option rule has a brief', () => {
  expect(Object.keys(BRIEFS).sort()).toEqual(rules.rules.filter(r => r.jevOption).map(r => r.id).sort())
})

test('the routing table example and one brief per rule: Jev answers with every judgment field', async () => {
  const cases: [string, string][] = [['example (section 4)', EXAMPLE], ['line count (E6)', LINE_COUNT], ...Object.entries(BRIEFS)]
  const rows: string[] = []
  let agree = 0
  for (const [expected, brief] of cases) {
    const j = await judgeSpawn(ctx, delegationMessages([], [], brief))
    expect(j.provider).toBe('jev')
    expect(j.questionSet).toBe('rules-q.v5')
    expect([...rules.rules.filter(r => r.jevOption).map(r => r.id), 'none']).toContain(j.ruleChoice)
    expect(j.confidence).toBeGreaterThanOrEqual(0)
    expect(j.confidence).toBeLessThanOrEqual(1)
    expect(Object.keys(j.probabilities)).toHaveLength(16)
    expect(j.deepP).not.toBeNull()
    expect(j.deep).toBe(j.deepP! >= rules.thresholds.deepYes)
    expect(j.inputTokens).toBeGreaterThan(0)
    const d = decideRule(j, rules)
    if (j.ruleChoice === expected) agree++
    rows.push(`${expected.padEnd(22)} → ${j.ruleChoice.padEnd(22)} conf ${j.confidence.toFixed(2)}  deepP ${j.deepP!.toFixed(2)}  ${'ruleId' in d ? `route ${d.ruleId}` : 'none'}  ${j.latencyMs} ms`)
  }
  console.log(rows.join('\n'))
  console.log(`first choice equals the rule the brief was written for: ${agree} of ${Object.keys(BRIEFS).length}`)
  if (SAVE) {
    const input = (brief: string): JevMessage[] => delegationMessages([], [], brief)
    await saveRaw('jev-spawn-scheduler.json', input(EXAMPLE), spawnQuestions(rules))
    await saveRaw('jev-spawn-line-count.json', input(LINE_COUNT), spawnQuestions(rules))
    // A request no rule fits (a Telegram question about the person's own discussions), for the none cases.
    await saveRaw('jev-spawn-no-rule.json', input(readFileSync(join(PLUGIN_ROOT, 'tests/data/brief-deeper-question.txt'), 'utf8')), spawnQuestions(rules))
    // A brief Jev is less sure about, for the below-threshold case of tests/judge.test.ts.
    await saveRaw('jev-spawn-batch-judge.json', input(BRIEFS['batch-judge']!), spawnQuestions(rules))
    // A real brief on the border of two rules whose models differ (first choice below ruleConfidence),
    // for the ambiguous draw of tests/spawn.test.ts.
    await saveRaw('jev-spawn-border.json', input(readFileSync(join(PLUGIN_ROOT, 'tests/data/brief-border-formalize.txt'), 'utf8')), spawnQuestions(rules))
  }
}, 300000)

// Real briefs whose rule the person corrected (2026-11-10): a feasibility question about the
// provider mechanism is code reading, not a code change; designing and deriving a multiset digest
// is mathematics, not design advice.
const CORRECTED: [string, string, string][] = [
  ['provider feasibility', 'tests/data/brief-provider-feasibility.txt', 'code-read'],
  ['multiset digest design', 'tests/data/brief-multiset-design.txt', 'math'],
  ['multiset digest derivation', 'tests/data/brief-multiset-derive.txt', 'math'],
]

test('the briefs the person corrected get the rule they named', async () => {
  for (const [name, file, expected] of CORRECTED) {
    const j = await judgeSpawn(ctx, delegationMessages([], [], readFileSync(join(PLUGIN_ROOT, file), 'utf8')))
    console.log(`${name}: ${j.ruleChoice} ${j.confidence.toFixed(2)} (expected ${expected})`)
    expect([name, j.ruleChoice]).toEqual([name, expected])
    expect(j.confidence).toBeGreaterThanOrEqual(rules.thresholds.ruleConfidence)
  }
}, 120000)

const B1: Blocker = {
  id: 'b1',
  description: '依赖安装失败：npm install 报 ERESOLVE，无法解决 peer dependency 冲突',
  diagnoses: 1,
  modelChanges: 0,
  history: [{ at: 1762680000000, step: 'diagnosis', agentId: 'a1f00d', note: 'react 18 与 @testing-library/react 16 的 peer 要求冲突；建议锁定 @testing-library/react 15 后重试' }],
}
const SAME = '执行 npm install 时依赖解析又失败了（ERESOLVE could not resolve），@testing-library/react 要求的 react 版本和项目里的 react 18 冲突，安装没有完成。'
const OTHER = '依赖已经装好，但 bun test 有 3 个用例失败：parser.test.ts 第 42 行 expect(received).toBe(expected)，解析结果少了最后一个字段。'

test('blocker: the same failure in other words is b1, a different failure is new', async () => {
  const same = await judgeBlocker(ctx, [B1], SAME)
  const other = await judgeBlocker(ctx, [B1], OTHER)
  console.log(`same → ${same.blockerId} (confidence ${same.confidence.toFixed(2)}); other → ${other.blockerId ?? 'new'} (confidence ${other.confidence.toFixed(2)})`)
  expect(same.provider).toBe('jev')
  expect(other.provider).toBe('jev')
  expect(same.blockerId).toBe('b1')
  expect(other.blockerId).toBeNull()
  if (SAVE) {
    for (const [file, report] of [['jev-blocker-same.json', SAME], ['jev-blocker-new.json', OTHER]] as const) {
      const { question, input } = blockerQuestion([B1], report)
      await saveRaw(file, input, [question])
    }
  }
}, 120000)

// Turns of real daily tasks (2026-11-11) and of scenario E8, as daily.ts sends them: what the person
// asked, the executor's answer, the turn's tool calls and the diff waiting for integration.
const TURNS: [string, boolean, Parameters<typeof checkInput>[0]][] = [
  ['a conversational reply', false, {
    asked: 'Telegram 追问（message_id=1274）：\n让我很不安，我的能力在某种意义上却被这样的独裁公司掌握。',
    answer: '这种不安有道理：模型能做什么、不能做什么，由训练它的公司决定，用户只能事后发现。说明一下，我自己也是 Anthropic 的模型。\n\n好在你已经有不依赖单一公司的条件：\n\n1. Magpie 里能用 GPT-6 Astra 和 Sol 6.1。\n2. haichao 上自己部署了 DeepSeek 4.1，权重在你自己手里，没人能事后改动。\n3. 写算子用的资料、测试和性能记录都存在你自己的仓库里，换哪个模型都能接着用。\n\n把算子任务交给几家的模型各做一遍，用同一套测试和计时来比较，就不必依赖任何一家的说法。\n\n验证：无（这一条是回答问题，没有改动代码）\n状态：已完成',
    tools: 0,
    diffStat: null,
  }],
  ['an order carried out in one step', false, {
    asked: '推吧，快速到 master',
    answer: '已推送：GitHub 上 claude-mods 的 master 现在是 103713d，与本地一致。\n\n验证：\ngit push origin master：成功\ngit status -sb：与 origin/master 一致\n状态：已完成',
    tools: 1,
    diffStat: null,
  }],
  ['a one-line edit (E8 b)', false, {
    asked: '在 /tmp/mt-e2e/repo 里把 greet.py 的 hello 改成 hi，并运行 python3 greet.py 验证',
    answer: '已把 greet.py 里的 hello 改成 hi，运行后输出 hi。\n\n验证：\npython3 greet.py：输出 hi\n状态：已完成',
    tools: 4,
    diffStat: ' greet.py | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
  }],
  ['a new mod with tests', true, {
    asked: 'Telegram 追问（message_id=1270）：\n可以直接改写不调用',
    answer: '这个 mod 已经写好，叫 kernel-model-hint，在真实的 Fable 5.2 会话里确认过效果。原来那段提示词被整段替换，新的内容是：碰到算子优化任务时，先提醒你一次这个模型受过训练限制，并建议改用 Mythos 5.1。如果你不换，它照常干活，但会多查文档，每次改完都跑正确性测试并计时。普通业务代码和传统机器学习任务不会触发这条建议。\n\n验证：\nclaude plugin validate mods/kernel-model-hint：通过\nclaude plugin test mods/kernel-model-hint：3 项全部通过\n用 claude -p --model claude-fable-5-2 加载这个 mod，让模型逐字引用这一节：读出的是新内容\n状态：已完成',
    tools: 9,
    diffStat: ' .claude-plugin/marketplace.json                   |  5 ++++\n README.md                                         |  1 +\n mods/kernel-model-hint/.claude-plugin/plugin.json |  8 ++++++\n mods/kernel-model-hint/hooks/hooks.json           |  1 +\n mods/kernel-model-hint/hooks/register.test.ts     | 33 +++++++++++++++++++++++\n mods/kernel-model-hint/hooks/register.ts          | 29 ++++++++++++++++++++\n 6 files changed, 77 insertions(+)',
  }],
  ['settings changed on a service, with numbers read back (its acceptance failed)', true, {
    asked: '用户回复：开 Fast，并且额度耗完之后可以耗 credit',
    answer: readFileSync(join(PLUGIN_ROOT, 'tests/data/check-turn-service.txt'), 'utf8'),
    tools: 27,
    diffStat: null,
  }],
]

test('check: conversation, a one-step order and a one-line edit need no acceptance; a new mod and a service change with numbers do', async () => {
  for (const [name, expected, turn] of TURNS) {
    const c = await judgeCheck(ctx, checkInput(turn))
    console.log(`${name}: p ${c.p!.toFixed(2)} → ${c.check ? 'check' : 'no check'}`)
    expect(c.provider).toBe('jev')
    expect(c.check).toBe(c.p! >= CHECK_YES)
    expect([name, c.check]).toEqual([name, expected])
  }
}, 120000)
