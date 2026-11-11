# 当前可调用模型的任务路由调研

资料核对日期：2026-11-07。候选来自本机 `magpie models claude`，共 25 个目录条目，包含部分日期别名。本文使用公开测评、官方发布资料和系统卡；没有运行新的模型 benchmark，也没有修改路由配置。

证据包：[逐条证据 JSON](research/model-routing-2026-11-07/evidence.json)、[证据 CSV](research/model-routing-2026-11-07/evidence.csv)、[候选目录](research/model-routing-2026-11-07/catalog.json)、[原始文件及 SHA-256 清单](research/model-routing-2026-11-07/source-manifest.json)。证据包保存了 863 条记录及 38 份原始资料；同一模型在不同来源、档位和测试条件下的记录分别保留。这些记录数量不代表独立实验的数量。

## 建议的任务分工

本节是 2026-11-07 的分工建议。2026-11-10 Fable / Mythos 5.2 发布、Gemini 4 Argon 接入后，代码、科学、选模评估和写作的分工有变化，见文末“2026-11-10 补充”；现行规则以[路由表](model-routing-table.md)为准。

质量优先的主力组合是 **Opus 5.5、Astra、Sol 6.1**，并为 **Sonnet 5.5、Terra 6.1、Fable 5.1** 保留明确的专业任务入口。Haiku 5.5 和 Luna 6 适合作为边界明确的小任务候选；它们在困难任务上的平均成绩不足以支持普遍替代主力模型。

下表是依据公开证据形成的初始策略建议。**[NEEDS-EVIDENCE] 这些任务与模型的对应关系，以及建议的起始 effort，尚未通过用户自己的任务集验证为最优。** 测评结果与推断依据在后文分开列出。

| 用户任务 | 推荐模型与 effort | 具体依据及适用边界 |
| --- | --- | --- |
| 长期任务架构师：讨论目标、设计模块、判断关键细节 | **Opus 5.5 xhigh**；困难技术推理可建议 max | 工程实施、知识工作和对话偏好有多方面支持。没有直接测量“与你共同做架构设计”的同条件 benchmark；仍由用户在任务开始时确认。 |
| 修改真实代码库、复杂错误修复、多文件实施 | **Opus 5.5 xhigh**；困难任务 **max** | 同一 AA 环境的 FrontierCode 2.0 max 为 46.4%；Cognition 原生 Claude Code 环境为 45.5%，均位于本候选集前列。Astra xhigh/max 是有不同供应商背景的替代候选。 |
| 数据分析、模拟、数值计算、带代码工具的科学工作流 | **Astra high**；困难任务 **max** | AA Terminal-Bench-Science max 为 63.3%，CritPt hard 的 medium/high 为 72.0%/71.5%。科学工作流与纯物理题的最优档位不相同。 |
| 从数学论文提取的求解题、识别错误命题 | **Sol 6.1 max**，Astra max 为重要候选 | 当前 MathArena 的 Sol 分项支持这一选择。其数学求解、错误命题识别与正式证明是不同任务，不能共用一个总分。 |
| Lean 中构造新证明 | **Opus 5.5 high** 作为候选首选 | 当前 ArXivLean September：47.17% ±13.44%；Sol 6.1 max 为 35.85% ±12.91%。区间较宽、工具环境不同，选择仍需保持暂定性质。 |
| Lean 现有证明库的压缩与简化 | **Sol 6.1 max** | LeanLean October：Sol 压缩 50.45%，Opus high 为 47.34%，并检查数学结论保持。该任务包含依赖整理和代码简化。 |
| 阅读复杂 PDF、交叉比对文档与表格 | **Sol 6.1 high**；困难跨工具分析可用 Astra xhigh | AA GDP.pdf：Sol high 32.0%，Astra xhigh 32.2%，Opus high 28.8%。小差距不应解释为显著优胜，Sol 的位置得到官方文档任务测评补充。 |
| 网页、幻灯片、视觉呈现 | **Opus 5.5 high** | DesignArena overall 1450 Elo，Python-PPTX 1471 Elo；相应页面的 Sol max 为 1422/1401，Astra max 为 1393/1414。这是人类偏好证据，代码功能仍需验证。 |
| 复杂终端操作、环境配置、工具密集型任务 | **Sonnet 5.5 max** 作为专业候选 | AA Terminal-Bench 4.0 为 63.6%，Opus max 为 59.6%。任务样本有限，不据此泛化为所有软件工程都应选择 Sonnet。 |
| 多文件知识工作与文档成果制作 | **Sonnet 5.5 max** 或任务架构师继续使用 Opus | AA-Briefcase 1813 Elo，Opus max 1800；接近的分数适合支持候选资格，不能证明 Sonnet 对所有文章更好。 |
| 浏览器、桌面操作及视觉信息驱动的操作 | **Sol 6.1 high**；重复、边界明确的操作可选 **Terra 6.1 medium** | LiveBench browser 分项分别 93.3、93.1；该站档位未披露。Terra 官方 Agents’ Last Exam 在 medium 的结果提供补充依据。需要具体工具反馈验证操作结果。 |
| 普通独立代码审查或失败后的诊断 | **Opus 5.5 medium** 或 **Sol 6.1 medium** | CodePanel 当前缺陷召回 90%/89%，每个干净 PR 误报 1.7/0.9；两者统计上共享名次。官方 `/code-review` 保持官方模型与审查方法的配合，不能在展开后任意替换请求模型。 |
| 长时间自主执行、任务结构不断变化 | **Fable 5.1 xhigh** 保留为专门候选 | LiveBench long-agentic 为 77.9，Astra 77.5，Opus 72.8；缺少匹配档位和稳定性证据。Fable 在其他测试中不占普遍优势，需要用真实任务判断其份额。 |
| 小段摘要、结构化提取、简单分类 | **Haiku 5.5 / Luna 6** 保留为受验证约束的候选 | 有官方定位及部分执行能力证据，但没有充分的个人任务质量证据。入口任务归属错误可能影响后续工作，不能仅凭模型便宜就指定它承担 Telegram Router。 |

同一任务保持模型与上下文连续，任务阶段变化由架构师分派不同子任务。模型选择依据在任务创建时显示；这份调研不授权在已有任务中自动改用新策略。

## 可比较的分项成绩

### Artificial Analysis：同一发布版本的统一测评

下表均为 **max**，来自同一天读取的 AA v5.0.1 比较表。除 AA-Briefcase 为 Elo 外，其余是百分比分数；FrontierCode 是加权评分，不应一律称为“任务通过率”。

| 模型 | FrontierCode 2.0 | Terminal-Bench 4.0 | Science 0.1 | CritPt hard | HLE-Diamond | AA-Briefcase | GDP.pdf |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Opus 5.5 | 46.4 | 59.6 | 59.0 | 68.0 | 67.9 | 1800 | 26.2 |
| Astra | 42.4 | 59.1 | 63.3 | 70.5 | 63.8 | 1569 | 31.0 |
| Sol 6.1 | 40.6 | 56.1 | 58.1 | 69.5 | 58.8 | 1555 | 31.0 |
| Terra 6.1 | 42.3 | 55.6 | 57.6 | 68.0 | 47.3 | 1401 | 28.6 |
| Sonnet 5.5 | 41.7 | 63.6 | 53.3 | 59.0 | 53.3 | 1813 | 25.8 |
| Fable 5.1 | 31.6 | 52.0 | 43.3 | 52.5 | 60.1 | 1669 | 26.2 |
| Haiku 5.5 | 34.9 | 32.8 | 20.0 | 43.5 | 29.6 | 1574 | 20.8 |
| Luna 6 | 25.2 | 12.6 | 8.6 | 42.5 | 22.2 | 1337 | 22.8 |

直接来源：[Opus/Astra](https://artificialanalysis.ai/models/releases/comparisons/claude-opus-5-5-vs-gpt-6-astra)、[Opus/Sol](https://artificialanalysis.ai/models/releases/comparisons/gpt-6-1-sol-vs-claude-opus-5-5)、[Opus/Terra](https://artificialanalysis.ai/models/releases/comparisons/gpt-6-1-terra-vs-claude-opus-5-5)、[Opus/Sonnet](https://artificialanalysis.ai/models/releases/comparisons/claude-sonnet-5-5-vs-claude-opus-5-5)、[Opus/Fable](https://artificialanalysis.ai/models/releases/comparisons/claude-opus-5-5-vs-claude-fable-5-1)、[Haiku/Luna](https://artificialanalysis.ai/models/releases/comparisons/claude-haiku-5-5-vs-gpt-6-luna)。

这些任务测量的内容不同，不能相加成一个个人使用分数：[AA 方法](https://artificialanalysis.ai/methodology/intelligence-benchmarking)说明：

- FrontierCode 2.0：132 项真实仓库修改，每项三次，Stirrup 执行，维护者标准与隐藏检查共同评分。
- Terminal-Bench 4.0：66 项终端任务，每项三次，mini-swe-agent 执行，以全部测试通过为成功。
- Terminal-Bench-Science：70 项科学工作流，每项三次，涉及生命、物理、数学、工程和地球科学。
- CritPt hard：40 道研究级物理题的固定困难子集，允许代码执行。
- HLE-Diamond：1,000 道知识与推理题，无工具；它的混合成绩不能单独作为数学研究或联网检索能力。
- GDP.pdf：100 个文档任务，每项五次；提取完整文本并按接口限制提供页面图像，单轮无工具，检查全部任务标准是否满足。
- AA-Briefcase：知识工作任务，综合可验证标准、分析质量与呈现质量。每个任务独立运行，没有实时用户互动，也不继承模型此前提交的成果，因此对持续对话架构师属于间接证据。

### effort 必须进入路由表

同一模型加大 effort 的效果随任务变化。以下均为同一 AA 发布比较表：

| 模型与测试 | high | xhigh | max |
| --- | ---: | ---: | ---: |
| Opus 5.5 · FrontierCode 2.0 | 35.9 | 43.8 | 46.4 |
| Opus 5.5 · Terminal-Bench 4.0 | 56.6 | 59.6 | 59.6 |
| Opus 5.5 · Science 0.1 | 49.0 | 61.9 | 59.0 |
| Astra · Science 0.1 | 59.5 | 54.8 | 63.3 |
| Astra · CritPt hard | 71.5 | 71.0 | 70.5 |
| Sol 6.1 · GDP.pdf | 32.0 | 31.8 | 31.0 |
| Fable 5.1 · FrontierCode 2.0 | 30.3 | 35.7 | 31.6 |

Astra medium 的 CritPt hard 为 72.0%。这些点估计表明档位不能当作统一的质量阶梯；尚缺少足够的同条件重复结果来确定每个小差距是否稳定。路由建议选择的是“模型＋effort＋任务条件”。

### 真实代码库：Cognition 原榜交叉核对

[Cognition FrontierCode 2.0](https://cognition.com/frontiercode)的当前原榜：

| 模型 | effort | 执行环境 | 分数 |
| --- | --- | --- | ---: |
| Opus 5.5 | max | Claude Code | 45.5% |
| Astra | max | Codex | 42.8% |
| Sonnet 5.5 | max | Claude Code | 41.0% |
| Sol 6.1 | max | Codex | 39.0% |
| Sol 6 | max | Codex | 34.3% |
| Fable 5.1 | xhigh | Claude Code | 32.4% |
| Haiku 5.5 | max | Claude Code | 27.7% |
| Sol 5.6 | max | Codex | 27.6% |
| Opus 5 | xhigh | Claude Code | 26.7% |
| Luna 6 | max | Codex | 21.9% |
| Opus 4.8 | max | Claude Code | 14.7% |

每行展示该模型测得最高分的 effort。原榜与 AA 使用不同执行环境，分数分别保留。对用户而言，Claude Code 侧的结果更接近当前工具环境，但仍不是 Magpie 接入后的直接测量。

## 数学与科研的细分

[MathArena 的模型页](https://matharena.ai/models/openai_gpt_61_sol)提供了可直接比较的具体比赛分项：

| 测试 | Sol 6.1 max | Opus 5.5 high | 所衡量的能力 |
| --- | ---: | ---: | --- |
| ArXivMath September | 91.51% ±5.31% | 82.08% ±7.30% | 研究论文来源题目的最终答案 |
| BrokenArXiv September | 82.70% ±7.20% | 76.73% ±8.04% | 识别错误命题及其错误 |
| ArXivLean September | 35.85% ±12.91% | 47.17% ±13.44% | 生成经过 Lean 检查的研究级证明 |
| LeanLean October | 50.45% | 47.34% | 保持数学结果时缩减证明库的 Lean token 数 |

Opus 数据：[模型页](https://matharena.ai/models/anthropic_opus_55_high)。两者分别使用 Codex 0.159.0 和 Claude Code 2.1.280，经 OpenRouter 限定对应供应商；档位也不同。表中的误差为页面报告值，区间重叠时不宣称差异显著。

[ArXivMath/BrokenArXiv 方法](https://matharena.ai/arxiv_august/)区分求解与识别错误陈述；[ArXivLean](https://matharena.ai/arxivlean/)检查正式证明及原命题语义；[LeanLean October](https://matharena.ai/leanlean_october/)在 32 个仓库上检查压缩后的数学结果保持。LeanLean 的主要压缩来源还包括依赖整理；它不能直接代表新定理发现能力。该文对失败提交回溯窗口存在两小时/三小时两种表述，本文使用发布成绩，不据此重建运行条件。

[MathArena 综合页](https://matharena.ai/)的 expected performance 为 Sol 6.1 max 84.0% ±2.3%、Astra max 81.8% ±3.4%、Sol 6 max 79.9% ±2.9%。这个指标使用实测题目成绩，并用项目反应理论估计缺测题目的分数；它不是所有模型在完全相同题集上直接跑出的通过率。Sol 6 因此仍有数学任务候选价值。

Anthropic 的 [Sonnet 5.5 系统卡](https://www.anthropic.com/claude-sonnet-5-5-system-card)另有 ArXivMath August 内部测试：max、有代码工具时 Opus 5.5 96.9%、Sonnet 5.5 95.2%、Fable 5.1 92.1%，每题四次，关闭安全分类器。它与 MathArena 原榜的提示词、尝试次数、执行环境不同，不能与上表混排。

## 长任务、设计、对话与代码审查

### 长任务

[LiveBench 2.0 2026-10-25 原始 CSV](https://livebench.ai/data/20261025/table.csv)：

| 模型 | 长任务 | 编码 | 浏览器操作 | 数据分析 | 研究 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fable 5.1 | 77.9 | 97.7 | 89.8 | 80.3 | 82.0 |
| Astra | 77.5 | 93.7 | 91.3 | 83.0 | 85.2 |
| Opus 5.5 | 72.8 | 96.3 | 88.4 | 80.3 | 85.0 |
| Sol 6.1 | 68.7 | 96.0 | 93.3 | 82.7 | 83.5 |
| Sonnet 5.5 | 63.4 | 94.7 | 89.3 | 59.5 | 83.6 |
| Terra 6.1 | 48.6 | 94.3 | 93.1 | 82.3 | 73.9 |
| Haiku 5.5 | 40.0 | 91.4 | 69.5 | 53.1 | 81.9 |
| Luna 6 | 30.9 | 84.5 | 70.3 | 73.4 | 43.5 |

[方法页面](https://livebench.ai/#/methodology)的前端实现说明分项是一次运行中的平均任务成绩。原榜和 CSV 没有各模型 effort 字段；检索及前端检查也没有取得匹配的运行配置。因此这里作为补充证据，不能用 77.9 对 77.5 宣称 Fable 稳定胜过 Astra。

### 视觉设计与交流

[DesignArena overall](https://www.designarena.ai/leaderboard)于 2026-11-07 12:15 UTC 的榜单区：Opus 5.5 high 1450、Sol 6.1 max 1422、Astra max 1393、Fable 5.1 1331、Sonnet 5.5 1280 Elo。

[Python-PPTX](https://www.designarena.ai/leaderboard/agentic-slides)同日 12:13 UTC 的榜单区：Opus high 1471、Astra max 1414、Sol max 1401、Fable 1319 Elo。Fable 和 Sonnet 的相关行未标明 effort。

[执行环境](https://www.designarena.ai/methodology/agentic-harness)提供文件、终端、网页和预览工具，部分模型使用供应商原生文件编辑工具；[方法](https://www.designarena.ai/about)以人类匿名比较计分。它支持审美和成果偏好的判断，功能正确性需要单独验收。Python-PPTX 成绩对用户的 pptxgenjs 工作方式属于相近任务证据。

[Arena Text](https://arena.ai/leaderboard/chat/text)：Opus high 1505±6、Fable max 1504±6、Sol max 1483±6、Astra max 1475±6；[专家提示分项](https://arena.ai/leaderboard/chat/text/expert)分别为 1541±16、1532±15、1523±18、1519±15。专家分项区间明显重叠，只作为交流偏好证据，不能独立判定架构设计质量。

### 直接代码审查证据

[CodePanel 当前榜单](https://codepanel.ai/benchmarks)：

| 模型 | 缺陷召回率 | 每个干净 PR 的误报 |
| --- | ---: | ---: |
| Opus 5.5 | 90% | 1.7 |
| Sol 6.1 | 89% | 0.9 |
| Sonnet 5.5 | 77% | 2.0 |
| Luna 6 | 67% | 0.7 |
| Haiku 5.5 | 64% | 1.4 |

[方法](https://codepanel.ai/benchmarks/methodology)：共 62 个样本，主排名使用共同覆盖的 42 个缺陷样本和 15 个干净样本，单个 Bugs & Security reviewer，medium 或最接近的支持档位。来自相同供应商的裁判票被排除；多重比较使用配对检验。本次样本可靠检出召回差距约需 20 个百分点，以上模型共享名次；裁判与人类评价的一致性尚未在这次运行中验证。

这为 Opus 与 Sol 的独立审查候选资格提供依据。实际官方 `/code-review` 的提示词、内部复核流程与 effort 选择不同，其行为仍按官方流程处理。

## 全部候选的处理建议

| Magpie 模型 ID | 路由位置或保留理由 |
| --- | --- |
| `claude/claude-opus-5-5` | 架构师、困难代码、视觉成果、部分正式证明的主力。 |
| `claude/claude-fable-5-1` | 长任务候选；xhigh/max 按任务分别评价，不设置全局最高优先级。 |
| `claude/claude-sonnet-5-5` | 终端任务、知识工作成果、审查候选。 |
| `claude/claude-haiku-5-5` | 可明确验证的小任务候选，质量门槛由个人任务证据决定。 |
| `codex/gpt-6-astra` | 科学计算、困难综合工程和数学求解候选。 |
| `codex/gpt-6.1-sol` | 数学求解、错误命题识别、PDF、操作任务和独立代码审查主力。 |
| `codex/gpt-6.1-terra` | 视觉与电脑操作专用候选；max 的代码和科学分项也值得保留。 |
| `codex/gpt-6-luna` | 边界明确的小任务候选，复杂终端与科研任务成绩较弱。 |
| `codex/gpt-6-sol` | 保留数学任务候选与历史任务连续性；MathArena 仍有较高成绩。 |
| `codex/gpt-5.6-sol` | 保留手动选择、既有任务连续性和回归比较；本次证据未建立相对当前主力的稳定专长。 |
| `codex/gpt-5.6-terra` | 保留手动选择和历史任务；官方已有 Terra 6.1 的多项直接改进证据。 |
| `codex/gpt-5.6-luna` | 保留手动选择和历史任务；没有足够当前同条件证据给它单独自动路由入口。 |
| `claude/claude-opus-5` | 保留已有任务和供应商指定接替用途；当前代码榜分数低于 5.5。 |
| `claude/claude-opus-4-8` | 保留供应商指定接替用途与已有任务；不据历史成绩优先分配一般困难代码。 |
| `claude/claude-sonnet-5` | 保留供应商指定接替用途与已有任务。 |
| `claude/claude-fable-5` | 历史 FrontierCode 1.1 有范围控制方面的局部证据；与当前 2.0 分数不混排。 |
| `claude/claude-opus-4-7` | 保留手动选择、既有任务和历史比较；没有建立当前自动优先角色。 |
| `claude/claude-opus-4-6` | 同上。 |
| `claude/claude-sonnet-4-6` | 同上。 |
| `claude/claude-opus-4-5`、`claude/claude-opus-4-5-20251101` | 两个目录条目共同记录，评测不把日期别名重复算作独立能力证据。 |
| `claude/claude-sonnet-4-5`、`claude/claude-sonnet-4-5-20250929` | 保留历史任务及手动选择。 |
| `claude/claude-haiku-4-5`、`claude/claude-haiku-4-5-20251001` | 保留历史任务及手动选择。 |

供应商指定接替机制的依据见 [Opus 5.5 发布说明](https://www.anthropic.com/claude-opus-5-5)和 [Sonnet 5.5 发布说明](https://www.anthropic.com/claude-sonnet-5-5)。这些是供应商规定的运行行为，不应通过自定义模型路由绕过。目录可见不等于每个账户、每种任务都已经实际调用成功；本文没有执行调用探测。

## 路由表与 JEV 应保存的区别

现有 `research` 一项至少需要进一步表达：数学求解、识别错误命题、正式证明、科学工具执行、资料检索与综合。`code` 需要区分仓库修改、终端操作和代码审查；`design` 需要区分系统架构与视觉呈现。

建议把任务需求作为多个属性记录，并为每条规则保存：

- 任务目标、必要能力、工具环境、验收方式。
- 模型、effort、已知能力限制及适用条件。
- 支持该选择的测评版本、来源、运行环境与日期。
- 证据是直接对应任务，还是相近任务的间接依据。
- 任务的实际结果、用户自然反馈与偶尔评分。

新的校准讨论应围绕某条具体规则及其任务实例展开。来源分数更新、任务环境变化和用户反馈可以触发讨论；目录出现新模型本身不自动改变已经确认的选择原则。

## 解释数据时需要保留的条件

1. **公测执行环境不同。** AA 的统一执行方式、Cognition 的厂商原生 CLI、MathArena 的原生 CLI、官方研究环境都与 Magpie 路径存在差别。保留各自成绩与条件。
2. **测评版本会改变。** FrontierCode 1.1 与 2.0、Terminal-Bench 2.1 与 4.0、HLE 与 HLE-Diamond 的成绩不能混排。
3. **厂商与第三方结果分开。** OpenAI 声称 Terra 6.1 的 Science max 超过 Sol 6.1；同一 AA 表是 57.6% 对 58.1%。条件不足以解释差异，分别保存，不能推断谁永远更强。
4. **API 费用与订阅额度不同。** AA 综合 cost/task、单个科学任务成本、厂商 API 单价及 Codex/Claude 订阅用量各有口径。[Terra 发布页](https://openai.com/index/introducing-gpt-6-1-terra/)只明确同一订阅额度可完成更多任务，没有给出可直接套用到 Magpie 的比例。
5. **`ultra` 可能包含额外代理。** [GPT-5.6 发布说明](https://openai.com/index/gpt-5-6/)将 ultra 描述为默认协调四个代理。现有 JEV 引擎接口为 low 至 max；本文没有把 ultra 当作普通单代理的统一档位。
6. **架构师能力只有间接证据。** 对话偏好、知识工作和代码修改成绩可以支撑候选选择，仍需通过用户参与的长期任务校准判断是否合适。

取证时在用户 Mac 的 Chrome 中打开了 Arena 与 OpenAI Terra 发布页，浏览器标签仍保留。网页资料及数据解析在本机完成，没有运行新模型测评。

## 2026-11-10 补充：Fable / Mythos 5.2 与 Gemini 4 Argon

证据包：[research/model-routing-2026-11-10/](research/model-routing-2026-11-10/)，分为官方资料（official）、Artificial Analysis 逐档结果（aa）、其他榜单（boards）和 Gemini 4（gemini）四部分，每行附原文引用与来源文件。11 月 7 日以后，OpenAI 没有发布新模型；AA 已有的分数没有变化。

**Fable / Mythos 5.2。** 两者是同一个模型，只是安全限制不同；路由使用 Mythos 5.2，避免 Fable 在网络安全或生物内容上误判时转交较早的模型。按质量优先改用它的规则：

| 规则 | 原选择 | 新选择 | 依据 |
| --- | --- | --- | --- |
| 真实仓库修改 | Opus 5.5 xhigh | Mythos 5.2 high | AA FrontierCode 2.0 49.1% 对 43.8%；官方 FrontierSWE v2 69.9% 对 62.3% |
| 困难实现 | Opus 5.5 max | Mythos 5.2 xhigh | 官方 FrontierCode 在 xhigh 最高（49.1%） |
| 科学计算 / 困难科学 | Astra high / max | Mythos 5.2 high / max | AA Terminal-Bench-Science 70.0% / 73.3% 对 59.5% / 63.3% |
| 选模评估 | Opus 5.5 xhigh | Mythos 5.2 high | AA Intelligence Index 62 对 57 |

终端操作（Sonnet 5.5 max 63.6% 对 61.6%）、知识型交付物（Briefcase 1813 对 1785，区间不重叠）、文档分析（Sol 6.1 GDP.pdf 32.0% 对 21–27%）、电脑操作（LiveBench browser 93.3 对 86.9）不变。数学、Lean、审查、写作、设计的公开榜单还没有 5.2。

**Gemini 4 Argon。** 写作讲解改用 Argon high：Arena Text 总榜 1522±5，高于 Opus 5.5 的 1506±6，中文和专家分榜在误差范围内。代码审查与 Opus 5.5 相当（CodePanel 82% 对 90%，区间重叠，误报更少），列为 `review-second` 的第三个候选。代码、科学、数学、设计、电脑操作明显落后，不用于这些规则。

**思考强度。** 5.2 的逐档结果显示 medium 到 high 提升最大，xhigh 在代码和科学上不比 high 好，研究类分数一直升到 max。路由规则因此为每条规则写明起步、深入和提升顺序；JEV 为 Fable / Mythos 5.2 和 Argon 各建一张任务表（policy.v17）。
