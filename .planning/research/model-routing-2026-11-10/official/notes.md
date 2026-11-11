# Claude Fable 5.2 / Claude Mythos 5.2 官方资料要点（2026-11-10 抓取）

来源文件都在 `/tmp/route-2026-11-10/official/sources/`：
- `announcement.txt`：发布文章 https://www.anthropic.com/claude-fable-and-mythos-5-2 的正文（2026-11-09）
- `announcement-chart-data.txt`：从发布文章页面数据里取出的图表原始数据（每个档位的分数和每题成本）以及主基准表的 CSV
- `system-card.txt`：系统卡 PDF https://www.anthropic.com/document/claude-fable-5-2-mythos-5-2-system-card 的全文（264 页，`pdftotext -layout`）；PDF 原件和渲染的图页在 `raw/`
- `whats-new-fable-5-2.txt`、`overview-fable-5-2.txt`、`overview-mythos-5-2.txt`、`prompting-claude-fable-5-2.txt`、`effort.txt`、`rate-limits.txt`：platform.claude.com 文档的 `.md` 原文

所有页面都能直接访问，没有遇到拦截。`rows.json` 共 402 行。每一行的 quote 都用脚本核对过：去掉多余空白后，quote 必须是对应 source_file 的子串；除读图的行以外，分数也必须出现在 quote 里。有 66 行的数值取自系统卡图上的数字标注，这些行的 conditions 以 `FIGURE LABEL` 开头，quote 是图注原文。以下各档位曲线上没有数字标注，所以没有收录数值：OSWorld 各档位的部分得分和严格通过率（系统卡第 236、237 页），Chartography 带工具的各档位（第 231 页），BenchCAD 不带工具的各档位（第 234 页），以及 CVE Rediscovery 各档位的平均输出 token 数（第 254 页，横轴只有刻度，没有逐点标注；各档位每题成本见发布文章的图表数据）。`rows.json` 的 effort 字段只取 low/medium/high/xhigh/max 或 null；来源原话里的限定说明（例如“各模型最高可用档位”）放在 conditions 里。

键值规范：每个基准只用一个名称，模型名只用规范名称（例如“无防护”“早期快照”这类说明放在 conditions 里）。同一组（基准、模型、档位）出现多行时，分数相差不超过 0.06，脚本已检查。

## 3. Mythos 5.2 和 Fable 5.2 的区别：权重相同，只有安全防护不同

- 发布文章原文："Claude Fable and Claude Mythos are the same underlying model. Fable has strong cybersecurity and biology safeguards to guard against misuse, which allows us to make it available to all users."
- 系统卡第 5 节原文："Claude Fable 5.2 and Claude Mythos 5.2 share the same underlying model and differ only in the safeguards applied to them. ... Claude Mythos 5.2 is the same model with more permissive safeguards."
- Mythos 5.2 文档页的描述："Claude Mythos 5.2 is the same model as Claude Fable 5.2, available only to organizations verified through Anthropic's verification programs."；What's new 页面的表格写的是 "Same capabilities as Claude Fable 5.2"。
- **访问资格**：Mythos 5.2 只开放给通过 Cyber Verification Program 或 Life Sciences Verification Program 审核的组织。Claude Enterprise 用户可以通过 Claude Security 间接使用它。Mythos 的 fast mode 也只对这些项目的成员开放。
- **安全防护的区别**（系统卡 1.5 节、3.2 节）：Fable 5.2 有 CB（化学和生物）分类器，被拦截的请求回退到 Opus 5；有网络安全分类器，被拦截的请求回退到 Opus 4.8；还有一组针对前沿大模型研发的窄范围防护（例如某些加速器上的 kernel 开发），被拦截的请求回退到 Opus 5。在 API 上，回退需要开发者主动开启（`fallbacks`）；没有开启时，请求返回 `stop_reason: "refusal"`。Fable 5.2 允许在源代码中查找漏洞，但拦截在编译后的二进制文件中查找漏洞。发布文章说："Fable 5.2’s safeguards will block most cybersecurity-related tasks"。
- **误拦截减少**：发布文章说，相比 Fable 5.1，"about 55% fewer blocks ... about 60% fewer in cybersecurity and 40% fewer in biology"。
- **训练阶段的能力限制**（两个模型都受影响）：发布文章原文："in relevant areas, including accelerator kernel optimization and improving large language model architectures, Fable 5.2 and Claude Mythos 5.2 perform at about the level of Opus 5.5"。
- **价格和规格**：两者完全相同，都是 $8 / $40 每百万 token，缓存读取 $0.20，1M 上下文，最大输出 128k，默认 effort 为 `high`。Fast mode 价格为 $16 / $80，生成速度最多提高到 2.5 倍。两者都要求 30 天数据保留，没有明确授权时不提供零数据保留（ZDR）。
- **速率限制**（rate-limits 文档）：Fable 5.2 单独占一个额度池，Start 档为 4,000 RPM / 500k ITPM / 100k OTPM，Build 档为 10,000 / 1.5M / 300k，Scale 档为 13,000 / 4M / 800k。这比 Opus 5.5 低（Opus 5.5 的 Start 档 ITPM 为 2M，OTPM 为 400k）。原文："Claude Mythos 5.2, Claude Mythos 5.1, and Claude Mythos 5 share a separate combined limit."（文档没有给出 Mythos 额度的具体数值。）
- **思考块互读**：Fable 5.2 和 Mythos 5.2 可以读取彼此的思考块，其他模型都不能读取它们的思考块。所以路由器把对话从 Fable 5.2 切到 Opus 5.5、Fable 5.1 或回退模型时，之前的推理内容会丢失。Advisor 工具方面，Fable 5.2 作为执行者时，只接受 Fable 5.2 或 Mythos 5.2 担任 advisor。
- **评测口径**：系统卡里网络安全和生命科学的数字都是 Mythos 5.2（关闭防护）的结果。Fable 5.2 的分数是开启防护的结果，被拦截的请求由回退模型作答。例如 Terminal-Bench 4.0 中有 2.5% 的请求、影响 10% 的试次，Terminal-Bench-Science 中有 1.3% 的请求、影响 4.1% 的试次。同一基准上两者的分数：Terminal-Bench 4.0 上 Mythos 5.2（关闭防护）70.5，Fable 5.2（开启防护并回退）67.6，标准误都是 ±1.8；TB-Science 上 Mythos 5.2 75.3，Fable 5.2 74.6，按任务聚类的标准误都是 ±4.3。两次运行的唯一说明差别是防护的开关；把差距归因于防护和回退，是根据“权重相同”这一官方说法做的推断，原文没有直接这样说。

## 4. Anthropic 对 Fable 5.2 effort 档位的建议

- API 默认是 `high`。发布文章说 Claude 应用和 Claude Code 的默认是 **Medium**（原文："On Medium effort (the default in Claude apps and Claude Code)"）。
- Effort 文档原文："Start with `high`. Most of the gain in capability is already present at `high`, and above it, gains are uneven and depend on the task. Step up to `xhigh` for your hardest long-running coding and agentic work, where you’ve measured a gain. Step down to `medium` or `low` where your evals show quality holds. Reserve `max` for measuring the model’s ceiling and for the rare task where time and tokens don’t matter. At `max` ... It runs slower and costs more than at `xhigh`, often for only a small gain." 同样的建议也适用于 Mythos 5.2。
- Prompting 页面按工作类型给出的建议：
  - `low`：适合快速来回、需求明确的任务和大批量任务，例如快速的子 agent。原文："the model’s scores at `low` sat close to Claude Fable 5.1’s scores at higher effort levels"。
  - `medium`：适合交互式编程、聊天和日常知识工作。
  - `high`：适合难的编程、研究、agent 任务和长时间无人值守的运行，单轮明显比 `medium` 慢。
  - `xhigh`：原文："On Anthropic’s internal coding evaluations, it raised scores slightly and used many more tokens."
  - `max`：原文："best suits open-ended problems, such as scientific discovery and mathematics"。
- 原文："The step from `medium` to `high` raised scores on most of the coding and knowledge-work evaluations that Anthropic tracks."
- 在 `high` 及以上，模型几乎每次回复前都会思考，连回复问候也一样。在 `medium` 及以上，提示词里写"不要深思直接回答"不起作用；要减少思考只能降低 effort。Effort 几乎不改变回复长度。
- 支持在对话中途按消息切换 effort（beta 头 `mid-conversation-output-config-2026-07-01`），切换后提示缓存仍然有效。

## 这些资料对路由表和 effort 表的影响

1. **档位越高不一定分数越高**（都有原文出处）：
   - FrontierCode 2.0：xhigh 49.1，高于 max 45.7。max 档有 22/660 次超时，把超时按零分计算时 max 只有 44.4。
   - ARC-AGI-3 Standard harness：high 79.26，高于 max 65.66；Provider Adapter harness：high 97.72，高于 max 94.90。
   - CursorBench 4.0：xhigh 56.3，低于 high 56.9；max 60.0 最高，但 max 每题约 353k 输出 token，high 约 99k。
   - HealthBench：分数随 effort 上升略微下降，从 low 的 60.1 降到 max 的 58.8。
   - HealthBench Professional：五个档位都在 70.5–71.4 之间。
   - PhysicianBench：high、xhigh、max 三档之间的差异没有统计显著性；从 low 到 high 提高 6.8 分，95% 置信区间为 3.2–10.4。
2. **Fable 5.2 在 low/medium 档就很强的场景**：
   - HLE 带工具：low 68.4，已经超过 Opus 5.5 max 的 67.7，每题成本约 $0.19 对 $2.18。
   - HLE 不带工具：low 65.6，高于 Opus 5.5 max 的 64.4。
   - Chartography 不带工具：medium 66.4，高于 Opus 5.5 max 的 64.4，每题约 $0.035 对 $0.49。
   - WANDR：low 71.4 / medium 73.6，与 Opus 5.5 max 的 72.3 相当。
   - CVE Rediscovery（Mythos 5.2）：low 72.4，高于 Opus 5.5 high 的 70.0。
3. **Fable 5.2 只有在高档位才明显领先的场景**：
   - BenchCAD 2.1（带工具）：low 26.9 / medium 32.4 / high 61.0 / xhigh 74.1 / max 83.5。
   - AutomationBench：39.7 → 40.2 → 44.3 → 47.9 → 51.4。
   - FrontierCode：从 medium 37.6 升到 high 45.3 是最大的一步。
4. **Opus 5.5 不低于或超过 Fable 5.2 的基准**（适合路由到 Opus）：
   - GDPval-AA v2.1：Elo 1866 对 1831；Fable 5.2 xhigh 只有 1751。
   - AA-Briefcase Elo：1800 对 1785；不过按 rubric 通过率是 Fable 5.2 领先，66.1 对 61.2。
   - ProgramBench 长上下文编程：91.2 对 85.6。Fable 5.2 在 68% 的任务上没提交就耗尽了上下文；harness 显示剩余 token 后，Fable 5.2 升到 91.6，Opus 5.5 为 91.1。
   - DRACO 深度研究报告：在相近成本下，Fable 5.2 低于 Opus 5.5。Opus medium 83.9、high 85.0，Fable 5.2 low 81.6、medium 82.2、high 84.1；max 时两者为 87.7 对 87.4。按横轴刻度估读，Opus medium 每题约 $2，Fable 5.2 low 每题约 $2.4（图上没有标注成本数值）。
   - HealthBench：Sonnet 5.5、Opus 5.5、Fable 5.1、Haiku 5.5 的原始分都高于 Fable 5.2。
   - PhysicianBench：Opus 5.5 68.4，Fable 5.2 64.4，差距在噪声范围内。
   - Terminal-Bench 4.0：Opus 5.5（xhigh）66.4，Fable 5.2（max）67.6，差距在标准误范围内。
   - FrontierCode max 档：45.5 对 45.7；把超时算零分时 Fable 5.2 为 44.4，低于 Opus。
5. **竞品领先的项目**：
   - Gemini 4 Carbon 在 AutomationBench 上最高（53.9 对 Fable 5.2 的 51.4），见发布文章表格。
   - Harvey LAB-AA v1.1（法律）：GPT-6 Astra 8.6，Fable 5.2 7.2（过滤幻觉后的全通过率）。
   - ARC-AGI-3 Provider Adapter harness：GPT-6 Astra 在 max 档 98.6、在 high 档 99.9，Fable 5.2 在 high 档 97.72。在 Standard harness 上 Fable 5.2 领先（high 档 79.26 对 Astra max 档 62.7）。
6. **提前停止和过度谨慎**：
   - 系统卡 2.3.3 节原文："Claude Mythos 5.2 quit without running an experiment in 63% of sessions at medium effort"；"left doable, requested work undone in 6–13% of sessions at medium to xhigh effort, compared with 4% for Claude Fable 5.1"。
   - Prompting 页面说这种情况在 low/medium 档更常见，并给出了 "Finishing work" 系统提示词片段：在 medium 档回放测试中，没做完就停止的会话减少了大约一半，输出 token 增加约 30%。
   - 记忆和笔记里累积的谨慎规则会让模型不再重试，也会去请求其实不需要的审批。在多 agent 场景下更明显。
7. **编排和子 agent**：
   - 发布文章建议 Fable 5.2 担任 Advisor 或 Orchestrator。原文："For most coding and knowledge tasks, we recommend that users start with Claude Opus 5.5 ... upward to Fable or Mythos"。What's new 页面也说，Opus 在更高 effort 下仍达不到要求时，再换用 Fable 5.2。
   - 在 xhigh/max 档，Fable 5.2 会主动起子 agent 来审查自己的工作。子 agent 的开销可能占会话成本的很大一部分。
   - 多 agent 结果：在 DRACO 上，5 个 agent 的团队用 15 分钟预算，超过了单个 agent 用 60 分钟预算的结果。
8. **提示词中的代码归属说法改变行为**：提示词里不说明代码归谁时，模型倾向于在现有结构上叠加代码，只报告附近的问题而不修复。加上 "This codebase is yours" 后，合并重复代码的比例约为一半（不加时不到十分之一），输出 token 约为 1.5 倍，并且会出现没人要求的改动。
9. **提示词里写明的 token 预算会增加花费**：在 high/xhigh 档的编程任务上，去掉提示词里的大额 token 预算后，成本下降，表现相当。
10. **没有官方数据的类别**：
    - 代码审查：没有专门的基准。最接近的是 CVE Rediscovery（只有 Mythos 5.2）和 Uber 的引用证言（约 170 个审查 agent 做安全审计）。
    - 写作和聊天偏好：没有 Arena 类偏好分数。最接近的是 AA-Omniscience 事实性（Mythos 5.2 净分 0.72，是所有模型中最高的）、Real-World Finance v2 成对 Elo（1637 对 Opus 5.5 的 1571）和 GDPval / AA-Briefcase 成对 Elo。
    - 设计和视觉：只有 Chartography、BenchCAD 2.1、SWE-bench Multimodal（74.1）和 OSWorld 2.1。
    - 数学：系统卡里没有 AIME、FrontierMath、USAMO 或 IMO 的分数（已检索全文）。有一项无思维链数学时间跨度：Mythos 5.2 为 17.4 分钟，Mythos Preview 为 7.3 分钟。只有 Lean 形式化费马大定理（100 个 agent、18 小时得 0.35 对 Opus 5.5 的 0.21；1,000 个 agent 用较早快照在 30 小时内完成）和 STEM Professor Bench（max 档 61.8 对 Opus 5.5 的 53.7）。
11. 发布文章说，Fable 5.2 和 Mythos 5.2 的生成速度比 5.1 快最多 30%。
12. 系统卡的 AECI 能力指数（11 月 6 日拟合，max 档）：Mythos 5.2 177.12，Opus 5.5 174.78，Mythos 5.1 172.62。系统卡说 Mythos 5.2 的总体能力高于 Opus 5.5（原文："Claude Mythos 5.2’s general capabilities exceed those of Claude Opus 5.5, our previous capability frontier."）。
13. 脚本：`/tmp/route-2026-11-10/official-scripts/finalize_rows.py` 重新核对 `rows.json` 的每一行（quote 必须是来源文本的子串，分数必须出现在 quote 里，effort 只能取规定的档位值，同键重复行的分数必须一致）。
