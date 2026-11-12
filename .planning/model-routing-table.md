# 模型路由表

资料日期：2026-11-10，Gemini 4 Carbon 的资料 2026-11-12。规则日期：2026-11-12。适用于通过 Magpie 使用 Claude、Codex 与 Gemini 模型的任务设计。

这份表格给出模型选择建议、适用条件和验收方式。magpie-tasks 按它的规则文件 `mods/magpie-tasks/rules/routing-rules.json` 为子代理选择模型与思考强度。目标是优先保证任务完成质量；质量相近时，再考虑等待与额度消耗。

**[NEEDS-EVIDENCE] 任务与模型的对应关系、起始思考强度及备选顺序属于依据公开测评制定的策略，需要用个人任务记录校准。** 测评分数是已经核实的数据；它们对用户任务的适用程度在表中单独说明。

完整资料：[模型测评调研](model-routing-benchmark-report.md) · [系统行为约定](model-routing-design.md) · [原始证据表](research/model-routing-2026-11-07/evidence.csv) · [2026-11-10 新增证据](research/model-routing-2026-11-10/)

## 1. 先确定任务归属与角色

| 情况 | 处理方式 | 模型选择时机 |
| --- | --- | --- |
| Telegram 中出现独立的日常请求，且有适用规则 | 任务入口提供目标与约束，Jev 判断任务匹配的规则与难度，规则表选定模型与 effort；Router 展示理由并创建任务子代理 | 创建任务时按规则选择；子代理直接执行并接收后续补充 |
| 日常请求没有适用规则 | Router 按 `daily-default` 直接交给 Opus 5.5 执行 | 创建任务时选定；不评估，不等确认 |
| 日常任务的执行者不能按规则直接确定（指定的模型没有规则给出的强度、规则的模型不可用、独立复核缺少条件） | Router 按 `route-assessment` 创建评估子代理，取得模型、effort 与依据的推荐，转交用户 | 用户确认推荐后，才创建实际执行任务的子代理 |
| 消息继续已有任务 | 找到原负责人，把补充交给原代理；窗口与 Telegram 共用任务记录 | 保持原模型；任务需要持续设计讨论时，按下一行处理 |
| 日常任务本身发展为需要持续讨论关键设计的工作 | 原代理说明原因，Router 与用户讨论是否建立长期任务窗口；用户确认后交接任务记录与关键材料，并更新负责人 | 用户确认架构师模型；目标仍属原任务时保留任务身份与追问关联 |
| 新建需要持续讨论的长期任务 | 推荐架构师模型及理由，由用户确认；架构师负责设计、关键细节和验收 | 用户确认时选定，任务内保持稳定 |
| 架构师需要调查、实施或验证 | 按可独立验收的成果委派子代理 | 每项新委派独立选择 |
| 当前讨论出现独立的新目标 | 建议另开任务会话，并说明适合的架构师；用户决定是否接受 | 新任务建立时选择 |
| 使用官方 `/code-review` 等技能 | 保留官方技能的模型与执行流程配合 | 在符合该技能启动规则的前提下选择 |

架构师可以直接阅读关键代码、文档、差异和原始证据。实施子代理负责具体修改及验证。**普通实施子代理使用独立上下文，只接收任务说明和必要材料，不继承主对话全文。** 材料包含目标、约束、已确认设计、关键证据及原始材料位置；子代理可以按任务需要读取原始材料。同一任务的修复继续交给原子代理，保留它自己的任务历史。官方技能保留自身机制；用户明确要求复制完整会话的 fork 时，按该机制执行并记录上下文来源。

### 日常任务中的判断与分派

日常任务没有架构师时，Router 负责分派、传递报告和执行已确认的路由规则。评估子代理负责执行者不能按规则直接确定时的选模建议；诊断子代理负责失败证据的技术判断。它们交付依据及建议，Router 负责把建议落实到适用规则或交给用户决定。

- **没有匹配规则：** 日常请求多为一次性查询与简单操作，Router 按 `daily-default` 直接交给一般任务的默认模型 Opus 5.5 执行，不评估，也不等确认。
- **执行者不能按规则直接确定：** 用户指定的模型没有规则给出的强度、规则的模型不可用，或独立复核缺少条件时，评估子代理给出推荐模型、effort、任务匹配理由及证据限制。Router 等待用户确认后分派，记录本次例外及确认内容。规则表的正式调整仍通过用户参与的校准讨论进行。
- **执行没有进展：** 原代理交回任务要求、已有修改、验证结果与失败证据。Router 安排一次独立诊断，诊断者判断继续原代理、使用合适的替代实施模型，或需要用户决定。建议符合既定目标、验收条件和已有选模规则时，Router 可以说明理由后继续分派。
- **完成验收：** 执行者完成后，插件按 `review` 规则启动独立上下文的验收子代理检查一次，模型按下面第 2.1 节表后的验收订阅选择。通过后整合到项目；不通过时执行者修复，修复结果连同验收意见交给用户确认。
- **涉及用户决定：** 关键设计变化、超出已有规则的选模、缺少合适候选，或达到无进展的尝试上限时，Router 将证据和建议交回用户，受影响的工作等待决定。需要持续设计讨论时，使用任务归属表中的长期任务转换流程。

同一阻碍最多进行一次独立诊断和一次实施模型更换；次数随任务记录保存，更换代理后继续累计。没有合适替代模型时可以直接报告用户，无须用完次数。用户尚未确认的关键设计不自动实施，已经明确且不受影响的工作可以继续。

## 2. 主路由表

`effort` 表示模型的思考强度。子代理各行给出的是起步强度；Jev 读完整委派说明后判断需要深入推理时，改用该规则的深入强度（个别规则同时换用另一个模型）；`code-change` 在 Jev 的深入推理概率达到 0.95 时改用 Mythos 5.2；验收不通过或诊断后重新委派时，按该规则的提升顺序升到下一档（第 2.4 节）。`architect` 行的强度由 JEV 逐条判断。这些值用于新任务选择，同一任务进入另一个阶段不自动触发换模型。

子代理与主对话的起步原则不同。经插件派出的子代理无人值守，做错了没有人立刻看到，所以按质量优先起步：起步取公开逐档测评中质量不再明显上升的那一档，Opus 5.5 与 Mythos 5.2 最高从 high 起步，更高的档位在验收不通过或诊断后使用（第 2.4 节）；主对话和普通子代理有人在看，失败马上可见，所以由 JEV 从较低档位起步、失败后再提高。同一个模型做同一类事，两处的起步档位因此可以不同。

规则按实际委派的工作划分（2026-11-10）：2026-10-10 至 11-10 的 500 次子代理委派（不含官方技能自己派出的审查角度与复核代理），合并同一工作的重复派出后共 233 件。工作的难易不再分成两条规则，统一由 Jev 的“是否需要深入推理”判断。每条规则写明测评依据：测评能分出明显赢家时选赢家；前几名相差在误差以内或没有对应测评时，写明“待校准”，先用默认的 Opus 5.5，再按用户的评分调整。

### 2.1 插件流程中的角色

| 规则 ID | 任务条件 | 承担角色 | 推荐模型 / effort | 验收方式 | 证据与适用边界 |
| --- | --- | --- | --- | --- | --- |
| `architect` | 需要持续讨论目标、模块职责、关键约束和方案取舍 | 长期任务架构师 | **Opus 5.5**，用户确认；思考强度由 JEV 逐条判断 | 用户理解并认可关键设计，约束与未决问题有明确记录 | [E1]、[E2]、[E3]；综合间接证据，没有直接测试与用户共同设计的能力 |
| `route-assessment` | 日常任务的执行者不能按规则直接确定：指定的模型没有规则给出的强度，规则的模型不在 Magpie 的模型列表中，或独立复核缺少条件 | 评估子代理 | **Mythos 5.2 / high** | 推荐模型与 effort，解释任务匹配依据及限制；实际执行者等待用户确认后创建 | [E12]、[E13]；AA Intelligence Index high 62，Opus 5.5 xhigh 57；综合推理能力作为间接依据，本配置只用于准备选模建议 |
| `daily-default` | 日常请求没有匹配的执行规则 | 执行子代理 | **Opus 5.5 / medium** | 按任务说明完成，报告实际运行的验证及结果 | 用户决定（2026-11-10）：没有匹配规则的日常请求多为一次性查询与简单操作，直接由一般任务的默认模型执行，不再评估与确认；起步 medium 与 JEV 给 Opus 5.5 操作类任务的起步档位一致；没有针对这类任务的评测 |
| `review-second` | 委派说明写明要用不同模型复核或诊断，并用 [review-of …] 给出被复核的代理或模型 | 审查或诊断子代理 | 原模型为 **Sol 6.1** 时推荐 **Opus 5.5 / medium**；其他情况推荐 **Sol 6.1 / medium** | 先排除原模型，再检查候选是否适合任务；直接核查原始材料与证据 | [E4]；模型组合的额外收益仍需个人任务证据，普通任务不自动增加复核代理 |

`review-second` 的候选依次为首选（见上表）、Opus 5.5、Sol 6.1、Argon，强度都是 medium，Argon 用 medium 档的模型 `hakimi/gemini-4-argon-medium`；CodePanel 以 medium 测试每个模型，Argon 的缺陷捕获率 82%（71–92%）与 Opus 5.5 的 90%（81–97%）区间重叠，误报更少（[E4]、[E15]）。`review-second` 比较的是模型本身：别名、effort、模型 ID 末尾的档位和接入它的供应商都不区分，例如 `hakimi/gemini-4-argon-high` 与 `hakimi/gemini-4-argon-medium` 是同一个模型，`antigravity/gemini-4-argon` 与它们也是同一个模型。推荐候选必须满足任务能力与接口要求，并且当前可用。候选不满足要求时，按已有替代规则选择符合条件的其他模型；没有符合条件的候选时向用户报告并等待决定。涉及多个原模型时，排除本次明确要求独立复核的模型集合。

日常任务的验收子代理不固定使用 `review` 规则的 Opus 5.5：每次开始验收时，插件从 Magpie 读取各订阅的额度，选每周额度剩余比例最高的订阅，再用这个订阅中审查最合适的模型，强度仍按 `review` 规则。Claude 订阅用 Opus 5.5，Codex 订阅用 Sol 6.1，CodePanel 召回率分别为 90% 与 89%（[E4]）。某个订阅的 5 小时窗口或每周窗口已经用完时排在最后，比例相同时 Claude 订阅在前。这是用户的决定（2026-11-12），目的是减少 Anthropic 订阅的消耗。Argon 与 Carbon 不在其中：它们经 sub2api 的 `hakimi` 分组接入，Magpie 的额度接口没有这个账号的额度窗口，无法参与比较；Magpie 自己登录的 Antigravity 订阅对 Claude Code 的请求一律回答 Resource has been exhausted（2026-11-12 实测，Opus 5.5 与 Argon 都是如此，Magpie 说明这与剩余额度无关），验收子代理无法在上面运行。规则文件中对应 `acceptance` 一节。

### 2.2 常见工作

按 233 件工作中的出现次数排列：审查与诊断 51 件，读代码与调研 39 件，方案设计与建议 25 件，网上资料收集约 23 件，改代码并验证 22 件，机器操作与实验 20 件，批量判断与标注 17 件（42 次派出），文档与写作 13 件，文档材料核对约 10 件，视觉制作 5 件，翻译 4 件（221 次派出）。

| 规则 ID | 任务条件 | 承担角色 | 推荐模型 / effort | 验收方式 | 证据与适用边界 |
| --- | --- | --- | --- | --- | --- |
| `code-change` | 交付的是程序本身：新功能、修复、重构或测试，验收看程序的行为；设计已经明确 | 实施子代理 | **Opus 5.5 / high**；深入推理概率达到 0.95 时 **Mythos 5.2 / high** | 相关测试通过，实际行为符合要求，修改范围符合任务 | [E9]、[E12]、[E13]、[E14]、[E17]；短的编程题 Opus 5.5 更好（LiveBench coding 87.1，Mythos 5.2 的同一模型 Fable 5.2 为 79.2），长时间、大仓库的工作 Mythos 5.2 更好（官方 FrontierSWE v2 69.9%，Opus 62.3%；LiveBench long-agentic 82.9，Opus 72.8；AA FrontierCode 2.0 high 49.1%，Opus 5.5 xhigh 43.8%）；过去一个月判为 code-change 的 20 件委派中，Jev 深入推理概率达到 0.95 的 10 件中位数产出 142k token、运行 84 分钟，其余 10 件为 21k token、31 分钟（样本少，各件当时用的模型不同） |
| `review` | 检查已有的工作或成果（代码、文档、提示词、配置、别人的结论）有没有缺陷、核实结果是否属实，或查明失败原因 | 审查或诊断子代理 | **Opus 5.5 / medium** | 使用独立上下文；每项问题包含位置、触发条件和依据，区分已确认问题与待验证判断 | [E4]；CodePanel 缺陷召回率 Opus 5.5 90%（Sol 6.1 89%）；有不同模型要求时使用 `review-second`，官方审查技能遵循其自身流程 |
| `code-read` | 只读地研究代码、仓库或系统怎样工作，或判断某项改动能否实现，产出结论或说明，不做修改 | 调研子代理 | **Opus 5.5 / medium** | 结论对应到具体的文件与代码位置，区分已经核实的事实与推断 | 待校准：现有编程测评衡量的是修改代码，没有单独衡量只读理解的测评；用默认模型起步，按评分调整 |
| `design-advice` | 提出工程、产品或工作流程方面的方案与建议并比较取舍，或把任务改写成专业做法；成果是方案，不做实施；方案成立与否取决于数学或科学论证时不属于这一类 | 设计子代理 | **Mythos 5.2 / high** | 方案写明取舍、依据与限制，能直接用于决定 | [E12]、[E13]；间接依据：AA Intelligence Index high 62（Opus 5.5 xhigh 57），衡量综合推理；没有直接衡量方案质量的测评 |
| `web-research` | 上网收集资料、数据或测评成绩，并标明出处 | 研究子代理 | **Opus 5.5 / medium** | 每项资料有可访问的出处与访问日期，数字与原文一致 | [E16]、[E2]；待校准：LiveBench research Astra 85.2、Opus 5.5 85.0、Sonnet 5.5 83.6、Sol 6.1 83.5，前四名相差不到 2 分；BrowseComp 只有 OpenAI 自家模型的成绩；AA-Briefcase 知识交付 Sonnet 5.5 max 1813、Opus 1800 |
| `machine-ops` | 在机器上查询状态、配置环境、修复构建或运行测量实验 | 执行子代理 | **Sonnet 5.5 / max** | 命令实际成功，最终环境或程序状态符合要求；测量保留命令与原始输出 | [E2]、[E12]；AA Terminal-Bench 4.0 Sonnet 5.5 max 63.6%（xhigh 57.1%、high 43.9%），Opus 5.5 high 56.6%、max 59.6%，Fable 5.2 xhigh 61.6%；Sonnet 5.5 只在 max 领先 |
| `batch-judge` | 按同一套标准逐条判断、标注、评分或选择参数 | 执行子代理 | **Opus 5.5 / medium** | 每条结果符合给定标准，抽查结果一致；标准不清的条目单独列出 | 待校准：没有对应测评；用默认模型起步，按评分调整 |
| `explain-write` | 依据已有材料写笔记、讲解、说明或报告 | 写作子代理 | **Argon high / high** | 用户能理解，结论忠于材料，关键条件与数字保留 | [E3]、[E15]、[E18]；Arena Text 总榜 Argon high 1522±5（Opus 5.5 1506±6），中文与专家分榜分数更高但在误差范围内；Carbon high 1526±10，三项都与 Argon 区间重叠；Argon 经 sub2api 接入，档位由模型名决定，规则用 high 档，不再提升；主对话已有固定模型时保持原模型 |
| `document-analysis` | 阅读论文、PDF、多份材料或表格，核对数字与论断的出处 | 研究子代理 | **Sol 6.1 / high** | 关键结论能追溯原文，数字与引用经过核对，冲突来源得到说明 | [E2]；文档推理直接相关；开放网络搜索质量需要另外验证 |
| `visual-build` | 制作网页、幻灯片、动画或视频画面等需要视觉呈现的成果 | 实施子代理 | **Opus 5.5 / high** | 检查真实页面或渲染结果，同时验证内容、布局和功能 | [E8]；设计偏好测评，用户使用的具体制作工具可能不同 |
| `translation` | 按术语表和翻译规范批量翻译文本 | 执行子代理 | **Opus 5.5 / medium** | 术语与格式符合规范，抽查译文忠实原文；无法翻译的条目单独列出 | 待校准：没有翻译测评；这类工作此前由 DeepSeek-V4.1-Flash 运行，没有经过 Magpie |

需要深入推理的判断要有具体理由，例如“必须维持跨线程状态一致性”。任务文字较长或文件较多，本身不足以判断为需要深入推理。

Mythos 5.2 与 Fable 5.2 是同一个模型，区别只在安全限制（[E13]）。Fable 5.2 遇到网络安全或生物内容的误判时，会把请求交给较早的 Opus 4.8 或 Opus 5；Mythos 5.2 没有这种转交，所以规则使用 Mythos 5.2，Fable 5.2 的测评成绩同样适用。长上下文编码测评 ProgramBench 中，不告诉模型剩余上下文时 Opus 5.5 较高（91.2% 对 85.6%，Fable 5.2 在 68% 的任务中提交前用完上下文）；每一步显示剩余上下文后两者持平（91.6% 对 91.1%）（[E13]）。

### 2.3 少见工作

这四类在上述一个月里出现 0 到 4 件，但测评选出的模型各不相同，所以单独保留。

| 规则 ID | 任务条件 | 承担角色 | 推荐模型 / effort | 验收方式 | 证据与适用边界 |
| --- | --- | --- | --- | --- | --- |
| `math` | 求解数学问题、推导结果、设计需要数学论证的方案（例如密码学构造），或检查命题是否成立、寻找反例 | 研究子代理 | **Sol 6.1 / max** | 核对条件与推导，能独立计算的部分进行复核；反例或逻辑依据可以检查，保留原命题含义 | [E5]；MathArena 最终答案与错误命题识别测评；推导完整性需要另外检查 |
| `science-compute` | 用程序完成数据分析、数值计算、拟合或模拟 | 研究或实施子代理 | **Mythos 5.2 / high** | 保留输入、计算过程与复现命令，检查结果与单位、约束是否一致；关键假设与失败尝试完整交接 | [E12]、[E13]；AA Terminal-Bench-Science high 70.0%、max 73.3%（Astra high 59.5%、max 63.3%），CritPt hard high 73.0%（Astra 71.5%） |
| `lean` | 在 Lean 中构造新的正式证明，或简化已有证明 | 实施子代理 | **Opus 5.5 / high** | Lean 检查通过，原命题语义与允许的假设保持不变；简化符合用户的可读性要求 | [E6]、[E7]；构造证明 Opus 5.5 领先但样本误差较宽；简化证明 Sol 6.1 max 压缩成绩更好，可由架构师通过 model_route 推荐 |
| `computer-use` | 通过浏览器或桌面应用完成多步操作 | 实施子代理 | **Terra 6.1 / medium**；需要深入推理时 **Sol 6.1 / high** | 以实际页面、文件或应用状态验证完成情况，发现目标或权限变化时返回讨论 | [E9]、[E10]、[E11]；LiveBench browser Sol 6.1 93.3、Terra 6.1 93.1；目标与步骤明确时用 Terra 6.1，需要持续理解目标时用 Sol 6.1 |

“研究方向是否有价值”“实验能否支持论文结论”等决定由架构师与用户讨论。子代理可以提供论据、反例和分析结果。日常聊天、临时解释和相关追问由当前任务负责人处理；表中的规则用于确实需要创建新任务或子代理的情况。

### 2.4 起步、深入与提升的档位

每条规则写明三项：起步档位；Jev 判断需要深入推理时的起步档位；验收不通过或诊断后重新委派时依次提升的档位。Opus 5.5 与 Mythos 5.2 判为需要深入推理时也从 high 起步，xhigh、max 只在验收不通过、诊断后重新委派，或用户与架构师指定时使用：high 之后提升很小或下降，Opus 5.5 在 Terminal-Bench 4.0 上 high 56.6%、xhigh 59.6%、max 59.6%，Fable 5.2（与 Mythos 5.2 同一模型，[E13]）在 FrontierCode 2.0 上 high 49.1%、xhigh 47.6%、max 48.8%（[E12]）；本仓库的运行记录中，同一次运行从 high 提到 xhigh 后每条回复长约 1.3 倍，同一概率段里用 xhigh 的运行耗时中位数是 high 的 2 到 4.6 倍（[E17]）。`code-change` 按 Jev 的深入推理概率分模型：达到规则文件的 `thresholds.hardYes`（0.95）时交给 Mythos 5.2，其余交给 Opus 5.5，两者都从 high 起步。短的编程题 Opus 5.5 更好，长时间、大仓库的工作 Mythos 5.2 更好（[E9]、[E13]、[E14]）；概率达到 0.95 的委派运行规模最大，判为 code-change 的委派中同样如此（[E17]）。其他规则没有按任务大小区分模型的测评，不按概率分模型。Jev 调用失败、由评估模型代为判断时没有概率，`code-change` 交给 Opus 5.5。提升顺序只列有证据表明有用的档位。Mythos 5.2 的科学计算提升时跳过 xhigh：Terminal-Bench-Science 上 high 70.0%、xhigh 67.6%、max 73.3%（[E12]）。Sol 6.1 的文档材料核对深入时不提高：GDP.pdf 上 high 32.0%、xhigh 31.8%、max 31.0%（[E12]）。Sonnet 5.5 的机器操作只用 max：Terminal-Bench 4.0 上 high 43.9%、xhigh 57.1%、max 63.6%（[E12]）。经 sub2api 接入的 Argon 与 Carbon 由模型 ID 末尾的档位决定强度（如 `hakimi/gemini-4-carbon-medium`），请求里的强度不起作用：这类模型的子代理从这一档起步，深入推理、续接、验收不通过和诊断后重新委派都不改变它；后两种情况照常记下原因，记录里的强度保持这一档。规则文件给这类模型配的强度只能是 ID 里的档位，插件加载规则时检查。写作规则因此停在 high。其他规则没有逐档证据，按相邻档位依次提升。判断“需要深入推理”的门槛与 JEV 共用一个值，即 JEV 配置中的 `JEV_OPUS_DEEP_YES`。

| 规则 | 起步 | 深入时 | 提升顺序 |
| --- | --- | --- | --- |
| route-assessment | high | high | high → max |
| daily-default | medium | high | medium → high → xhigh → max |
| review-second | medium | high | medium → high → xhigh → max |
| code-change | high | high | high → xhigh → max |
| review | medium | high | medium → high → xhigh → max |
| code-read | medium | high | medium → high → xhigh → max |
| design-advice | high | high | high → xhigh → max |
| web-research | medium | high | medium → high → xhigh → max |
| machine-ops | max | max | max |
| batch-judge | medium | high | medium → high → xhigh → max |
| explain-write | high | high | high |
| document-analysis | high | high | high → xhigh → max |
| visual-build | high | high | high → xhigh → max |
| translation | medium | high | medium → high → xhigh → max |
| math | max | max | max |
| science-compute | high | high | high → max |
| lean | high | high | high → xhigh → max |
| computer-use | medium | high | medium → high → xhigh → max |

## 3. 保留候选与替代选择

这部分说明可选择的范围。备选模型需要符合当前任务条件；选中后交接必要上下文，不把全部候选依次运行一遍。

| 情况 | 可考虑的模型 | 使用条件 |
| --- | --- | --- |
| 仓库实施（`code-change`）的模型需要替代 | 先换同一规则的另一个模型（Opus 5.5 与 Mythos 5.2 互为替代），其次 Astra xhigh / max，再次 Carbon medium | 规则写明的两个模型可以自动互换，取规则提升顺序中不低于起步与当前档位的一档；Astra 同样具备真实仓库修改测评支持（[E1]），取不低于当前档位的一档，由架构师依据任务和失败证据调整；Carbon 的 AA FrontierCode 2.0 medium 39.5%、high 40.6%（Astra xhigh 41.4%），Cognition 榜 medium 40.00% 高于 high 37.48%，所以用 medium（[E18]） |
| Mythos 5.2 的科学计算需要替代模型 | Astra high / max，其次 Carbon high | Terminal-Bench-Science Astra high 59.5%、max 63.3%（[E2]），取不低于当前档位的一档；Carbon high 64.8%，CritPt hard 69.0%（Astra high 71.5%）（[E18]） |
| 选模评估需要替代模型 | Carbon high，其次 Opus 5.5 xhigh | 与首选 Mythos 5.2 同一依据：AA Intelligence Index Carbon high 60、Opus 5.5 xhigh 57（[E12]、[E18]） |
| Sonnet 5.5 的机器操作需要替代模型 | Carbon high | Terminal-Bench 4.0 Carbon high 65.2%、Sonnet 5.5 max 63.6%、Opus 5.5 max 59.6%；66 题，差距在 1 题左右，不足以替换首选（[E12]、[E18]） |
| Sol 6.1 的文档材料核对需要替代模型 | Carbon medium | GDP.pdf Carbon medium 29.6%（high 28.4%），Sol 6.1 high 32.0%，Fable 5.2 high 21.8%（[E12]、[E18]） |
| Argon 的写作讲解需要替代模型 | Opus 5.5 high / xhigh / max | Arena Text 中文与专家分榜与 Argon 在误差范围内（[E3]、[E15]）；Argon 不可用或 hakimi 账号的额度用完时自动接手，取不低于当前档位的一档；Carbon 与 Argon 用同一个账号的额度，不作为写作替代 |
| 数学求解需要替代模型 | Astra max 或 Sol 6.1 | 重新核对是数学答案求解还是其他工作；Sol 6.1 档位依照数学规则 |
| 普通独立审查需要另一名实施者 | Opus 5.5 medium 或 Sol 6.1 medium | 两者都有直接审查证据；不把更换模型等同于问题已经解决 |
| 长时间自主执行、目标包含连续变化的子问题 | Mythos 5.2 high | 保留为专门候选；LiveBench long-agentic 82.9（Opus 5.5 72.8，[E14]），官方 Remote Labor Index high 41.3%（[E13]）；官方建议长时间无人值守任务用 high |
| 小段摘要、结构化提取、简单分类 | Haiku 5.5、Luna 6 | 官方定位支持候选资格；本表不指定缺少任务证据的默认 effort。可由用户指定，可由架构师推荐、经 Jev 判断后采用，或在校准中确定具体任务和验收要求 |
| 数学任务中的额外候选 | Sol 6 | MathArena 仍有较高成绩；不单凭版本号移除其候选资格 |
| 已有长期任务使用旧型号 | 原模型 | 保留任务连续性；需要更换时说明理由和交接内容 |

Telegram Router 使用 Opus 5.5，思考强度由 JEV 逐条判断。公开测评没有直接衡量“消息归属判断”的项目，这一选择按质量优先确定。完整候选及旧型号用途见[调研报告](model-routing-benchmark-report.md)。

## 4. 多种能力混合时怎样选

1. **先写清成果与验收条件。** 例如“实现并验证调度逻辑”，包含算法理解、代码修改和测试。
2. **确定决定验收结果的主要能力，同时检查其他必需能力。** 不只看最近一次工具调用，也不按用户消息中的单个关键词决定。
3. **选能完成整个委派的模型。** 实现与验证通常留在同一子代理中；能够独立验收的调查、资料核对等成果才单独委派。
4. **记录匹配理由。** 一项任务可以同时需要代码、数学、文档理解；Jev 的判断应保留这些需求，而非只留下一个大类名称。
5. **信息不足时补充任务说明。** 能从代码或任务记录核实的事实直接核实；缺少用户目标或关键约束时再询问用户。长期任务没有适用规则时，架构师补充任务条件后重新委派，或通过 `model_route` 推荐模型、effort 与理由，由 Jev 判断推荐是否适合这项任务。日常请求没有适用规则时，按 `daily-default` 交给 Opus 5.5 执行。
6. **落在两条规则边界上的工作随机交给综合能力排前三的模型（并列的都收）。** Jev 的首选规则置信度低于 `ruleConfidence`，而概率最高的两项都是规则、两条规则给出的模型不同时，这项工作横跨两类，专项测评定不了谁更合适。插件从 Mythos 5.2 high、Carbon high、Opus 5.5 xhigh、Astra max 中均匀随机选一个（规则文件的 `ambiguous`；依据 AA Intelligence Index v5.0.1：Mythos 5.2 high 62、Carbon high 60，Opus 5.5 xhigh 57 与 Astra max 57 并列第三，其后 Sol 6.1 与 Sonnet 5.5 55、Argon high 50），记录为 `ambiguous`，以便用评分比较这几个模型在这类工作上的表现（用户决定，2026-11-11）。两项中有一项是“无规则”、或两条规则用同一个模型时，仍按上一条处理。

## 5. 所有规则共同遵循的约定

| 事项 | 约定 |
| --- | --- |
| 用户指定 | 用户明确指定的模型优先。若接口或官方技能不支持这一选择，说明实际限制，由用户决定如何处理。 |
| 官方技能 | 保留技能的上下文机制、模型与执行流程配合；普通子代理规则不能直接覆盖这些固定行为。 |
| 架构师模型 | 长期任务开始时推荐并由用户确认；候选为 Opus 5.5（默认推荐）、Mythos 5.2、Astra、Sol 6.1。日常任务发展为长期设计工作时也使用这一确认流程，同一长期任务保持稳定。 |
| 子代理续接 | 同一任务的补充和修复继续交给原代理，保留它自己的任务历史。新建普通实施子代理使用独立上下文。 |
| 思考强度 | 子代理使用规则中的起步强度，由插件设置：需要深入推理时改用规则的深入强度，验收不通过或诊断后重新委派时按规则的提升顺序升一档（第 2.4 节）。架构师与 Router 由 JEV 逐条判断。子代理按质量优先起步，主对话由 JEV 从较低档位起步、失败后提高，两者分工见第 2 节。 |
| 单次选模调整 | 架构师通过 `model_route` 委派，可以推荐模型、effort 并写明理由，但不能自行指定。Jev 把推荐与路由表的选择放在一起判断，参考路由表对两个模型的说明（包括“只在用户指定时使用”这类限制）；Jev 选中推荐且置信度不低于规则门槛时采用推荐，否则采用路由表的选择，Jev 调用失败时也采用路由表的选择。日常任务的诊断建议在已有规则内可自动执行；超出规则的模型推荐等待用户确认。通用规则的调整需要用户参与。 |
| 关键设计变化 | 有架构师时，由其核查证据并与用户讨论；日常任务没有架构师时，由诊断者或原代理提供证据与建议，Router 转交用户。需要持续设计讨论时，提出建立长期任务及架构师。受影响工作等待决定。 |
| 模型不可用或额度耗尽 | 有证据支持且符合已有规则的替代模型可在说明原因后接手；没有合适替代时，由用户决定等待或接受其他模型。 |
| 没有进展 | 同一阻碍最多一次独立诊断加一次实施模型更换，次数随任务记录累计；长期任务由架构师调配，日常任务由 Router 按诊断建议及规则分派。仍无进展或没有合适候选时，暂停受影响工作并与用户讨论。 |
| 信息交接 | 包含目标、约束、已确认设计、关键原始证据、实际修改、验证结果和未解决问题；架构师及承担本次判断的评估者、诊断者能直接检查关键材料。 |
| 信息展示 | 每个新任务显示一次任务名称、模型、effort 和选择理由；续接不重复，更换时说明原因。 |

## 6. 校准时记录什么

每条路由选择关联具体任务与规则 ID，保留以下内容：

| 记录项 | 用途 |
| --- | --- |
| 任务目标、必需能力、约束和验收方式 | 判断该任务是否真的适合所匹配的规则 |
| 任务身份、当前负责人、日常或长期状态、用户确认内容 | 保持追问归属，记录长期任务转换及例外选模的确认 |
| 角色、模型、effort、工具环境、规则版本和选择理由 | 解释这次选择及其运行条件 |
| 被复核模型与复核模型的具体标识、上下文来源 | 核对不同模型要求及独立上下文要求是否满足 |
| 交付成果、验证结果、失败原因和实际返工 | 判断完成质量，区分模型问题、环境问题和任务说明问题 |
| 同一阻碍的标识、诊断次数和实施模型更换次数 | 检查自动尝试上限，更换代理后继续累计 |
| 用户自然反馈，以及偶尔给出的可跳过评分 | 理解个人偏好与满意程度；保留原话，校准时确认解释 |
| 可取得的 token、缓存、耗时和订阅用量信息 | 分别观察消耗，保留各自计量口径 |
| 关键设计决定与模型更换原因 | 检查架构师是否遵守约束，避免把整体结果简单归给某个子代理 |

每两周检查时，还按 Jev 的深入推理概率分三段（低于 0.85、0.85–0.95、0.95 以上），按规则、模型和起步档位统计任务数、验收不通过或诊断后提高强度的次数和更换模型的次数。同一格 14 天内有 3 个任务需要提高或换模型时，提醒用户考虑把这一段的起步提高一档；`code-change` 交给 Opus 5.5 的 0.85–0.95 段出现这种情况时，提醒用户考虑把 `hardYes` 往下调。提醒同时列出每一格的计数，零次提高的格子供用户判断起步是否偏高。规则文件的 `ratingPriority` 列出结果还没有在用户任务上比较过的设置：`code-change` 交给 Opus 5.5 的任务，以及 Opus 5.5、Mythos 5.2 判为需要深入推理、起步限在 high 的任务；每天的评分邀请先从这些任务中选；按第 4 节第 6 条随机分配的边界工作也优先邀请评分。每次检查还累计列出边界工作中每个被选模型的任务数、评分数与平均分、提高强度次数和更换模型次数；每个被选模型都有至少 3 个评过分的任务时，即使没有其他发现也提醒用户比较。

每两周检查一次记录。有具体任务证据支持调整讨论时，通过 Telegram 提醒用户并展示案例；用户可以随时主动发起校准。规则调整由用户参与确认。缺少评价的任务保留为“用户尚未评价”。额外模型对比实验需要单独确定执行范围。

## 7. 证据索引

| 索引 | 已核实的主要结果 | 使用时保留的条件 |
| --- | --- | --- |
| [E1] | AA FrontierCode 2.0：Opus xhigh 43.8%、max 46.4%；Astra xhigh 41.4%、max 42.4%。[Cognition 原榜](https://cognition.com/frontiercode)：Opus max 45.5%、Astra max 42.8%。 | AA 使用统一测试环境；Cognition 分别使用 Claude Code、Codex。版本与工具条件不同的分数分别保存。 |
| [E2] | Science：Astra high 59.5%、max 63.3%；Terminal-Bench：Sonnet max 63.6%；AA-Briefcase：Sonnet max 1813、Opus max 1800；GDP.pdf：Sol high 32.0%。 | 不同分项衡量不同能力。Briefcase 为 Elo，其他所列为百分比分数；GDP.pdf 与知识工作测试没有实时用户互动。 |
| [E3] | Arena Text：Opus high 1506±6、Fable 5.1 max 1503±6；专家分项的模型区间明显重叠。 | 人类交流偏好；对架构设计和个人中文讲解偏好属于间接证据。 |
| [E4] | CodePanel：Opus 召回率 90%、误报 1.7；Sol 89%、0.9。 | 单个审查者，medium 或最近支持档位；42 个共同缺陷样本、15 个干净样本，两者共享统计名次。官方 `/code-review` 使用不同流程。 |
| [E5] | MathArena 8–10 月合计：ArXivMath Sol 6.1 max 92.81%±3.10%、Opus 5.5 high 82.61%±4.72%；BrokenArXiv Sol 83.09%±4.59%、Opus 77.30%±5.23%。 | 指定测试分项；使用原生工具环境，结果不直接衡量研究方向价值或完整证明质量。Mythos/Fable 5.2 尚未进入 MathArena。 |
| [E6] | Opus high：ArXivLean September 47.17%±13.44%；Sol max 35.85%±12.91%。 | 区间较宽，档位及工具版本不同，不能据点估计宣称稳定优胜。 |
| [E7] | LeanLean October：Sol max 压缩 50.45%，Opus high 47.34%，检查数学结果保持。 | 现有证明库压缩；需要另行检查用户要求的可读性和简化质量。 |
| [E8] | DesignArena：Opus high overall 1450 Elo、Python-PPTX 1471 Elo。 | 人类匿名偏好；页面与幻灯片的实际功能、内容正确性仍需验证。 |
| [E9] | LiveBench 2026-11-06 版：browser Sol 6.1 93.3、Terra 6.1 93.1、Astra 91.3、Fable 5.2 86.9；long-agentic Fable 5.2 82.9、Astra 75.6、Fable 5.1 74.2、Opus 72.8。 | 单次运行的分项均分；公开表格没有匹配的 effort 信息，没有置信区间，作为补充证据。 |
| [E10] | Sol 6.1 官方发布说明包含 PDF、自动化、电脑操作和事实准确性测评。 | 厂商研究环境与实际 Magpie 路径不同；需要与独立分项共同解释。 |
| [E11] | Terra 6.1 官方 Agents’ Last Exam medium 表现接近 Astra，并有视觉与电脑操作改进。 | 厂商测评；文字说明没有提供足以在用户环境中复现优势的全部条件。 |
| [E12] | AA v5.0.1 Fable 5.2 逐档（low / medium / high / xhigh / max）：Intelligence Index 54 / 56 / 62 / 62 / 65；FrontierCode 2.0 38.4 / 41.3 / 49.1 / 47.6 / 48.8；Terminal-Bench 4.0 54.5 / 55.1 / 59.6 / 61.6 / 59.6；Terminal-Bench-Science 53.8 / 60.5 / 70.0 / 67.6 / 73.3；CritPt hard 60.0 / 61.5 / 73.0 / 73.5 / 76.5；AA-Briefcase 1563 / 1622 / 1677 / 1738 / 1785；GDP.pdf 26.8 / 23.8 / 21.8 / 21.4 / 24.2。对照：Opus 5.5 FrontierCode xhigh 43.8、max 46.4；Astra Terminal-Bench-Science high 59.5、max 63.3；Sonnet 5.5 Terminal-Bench max 63.6、Briefcase max 1813；Sol 6.1 GDP.pdf high 32.0。Terminal-Bench 4.0 逐档：Sonnet 5.5 high 43.9 / xhigh 57.1 / max 63.6，Opus 5.5 high 56.6 / xhigh 59.6 / max 59.6。 | AA 统一测试环境；AA 没有测 Mythos 5.2。只有 Briefcase 与 GDPval 给出置信区间。每题成本 Fable 5.2 high 约为 Opus 5.5 xhigh 的 1.5 倍（FrontierCode 9.64 对 6.49 美元）。 |
| [E13] | Anthropic Fable/Mythos 5.2 发布资料与系统卡：两者“share the same underlying model and differ only in the safeguards”；FrontierCode 2.0 xhigh 49.1%（Opus 5.5 45.5%）；FrontierSWE v2 69.9%（Opus 62.3%）；Terminal-Bench-Science 74.6%（Mythos 75.3%，Astra 68.1%）；OSWorld 2.1 89.3%（Opus 87.2%）；Remote Labor Index high 41.3%（Opus 21.3%）；ProgramBench 不显示剩余上下文时 Opus 5.5 91.2%、Fable 5.2 85.6%，显示后 91.1%、91.6%。 | 厂商测评，Fable 5.2、Opus 5.5 带安全限制运行；对照模型的分数与公开榜单不完全一致（Opus Terminal-Bench-Science 58.7% 对公开榜 63.3%）。 |
| [E15] | Gemini 4 Argon（high）：Arena Text 总榜 1522±5（Opus 5.5 1506±6），中文 1584±16（Opus 1567±17），专家 1548±14（Opus 1544±16）；CodePanel 捕获率 82%（71–92%），误报每个干净 PR 1.1（Opus 1.7）；AA Intelligence Index 50；FrontierCode 2.0 low / medium / high 21.5% / 23.5% / 26.3%（Cognition）；DesignArena 胜率 43.9%（Opus 74.0%）；MathArena ArXivMath 8–10 月 84.39%±4.65%。 | Argon 只有 low、medium、high 三档，逐档数据只有 FrontierCode 与 AutomationBench。规则经 sub2api 的 `hakimi` 分组（Google AI Ultra 账号）使用 Argon：sub2api 按模型名定档位，Magpie 里每一档是一个模型 ID（`hakimi/gemini-4-argon-high` 等）。 |
| [E14] | LiveBench 2026-11-06 版 coding：Opus 5.5 87.1、Fable 5.2 79.2；long-agentic 见 [E9]。 | 没有置信区间与档位信息；coding 分项为较短的编程题，不等同于真实仓库修改。 |
| [E16] | LiveBench 2026-10-25 版 research：Astra 85.2、Opus 5.5 85.0、Sonnet 5.5 83.6、Sol 6.1 83.5；data_analysis：Astra 83.0、Sol 6.1 82.7、Terra 6.1 82.3、Fable 5.1 80.3、Opus 5.5 80.3。 | 单次运行的分项均分，没有置信区间与档位信息；research 分项不等同于开放网络的资料收集。 |
| [E17] | 本仓库 2026-11-10 统计 2026-10-10 至 11-10 的 233 件子代理委派的运行记录（`findings.md`，同日的 Measurement 条目）：Jev 深入推理概率低于 0.5 的委派中位数产出 3k token、运行 6.0 分钟，0.95 以上为 28k token、12.3 分钟；概率与产出量的等级相关 0.33，与每条回复长度 0.33（委派说明字数分别为 0.39、0.26）；同一次运行从 high 提到 xhigh 后每条回复长约 1.3 倍（19 次运行的中位数）；Opus 5.5 在概率 0.5–0.95 与 0.95 以上两段，用 xhigh 的运行耗时中位数为 23.4、25.8 分钟，用 high 的为 5.1、12.5 分钟；判为 code-change 的 20 件中，概率达到 0.95 的 10 件中位数产出 142k token、运行 84 分钟，其余 10 件为 21k token、31 分钟。 | 只有运行规模与耗时，没有结果质量；强度由当时的委派者选择，较难的任务更可能被给了 xhigh。 |
| [E18] | Gemini 4 Carbon，AA v5.0.1 逐档（low / medium / high）：Intelligence Index 54 / 58 / 60；FrontierCode 2.0 29.6 / 39.5 / 40.6；Terminal-Bench 4.0 62.6 / 60.6 / 65.2；Terminal-Bench-Science 61.9 / 62.4 / 64.8；CritPt hard 65.0 / 69.0 / 69.0；GDP.pdf 28.6 / 29.6 / 28.4。Cognition FrontierCode 2.0 low / medium / high 31.88% / 40.00% / 37.48%。Arena Text（High）总榜 1526±10、中文 1585±30、专家 1568±30。DesignArena Overall Agentic 1303（Opus 5.5 high 1440）。LiveBench 2026-11-06 版 browser 80.0（Terra 6.1 93.1）、coding 91.0（Opus 5.5 87.1）。 | 2026-11-10 起向 Google AI Ultra 订阅开放（Antigravity），Gemini API 推荐的默认档位是 medium；规则经 sub2api 的 `hakimi` 分组使用，每一档是一个 Magpie 模型 ID。AA 的这些分项没有区间；CodePanel 与 MathArena 没有收录 Carbon。Google 的网络安全测评成绩只在 Fairwind 渠道取得，其他渠道加强了网络安全滥用防护。AA、Cognition 与 Arena 的数值取自 `research/model-routing-2026-11-10/gemini/`，其余为 2026-11-12 访问的页面。 |

本表保留实际测评中的小差距和不确定性，不把公开排名直接写成用户任务上的成功保证。API 标价、benchmark 每任务费用和订阅额度分别记录。

## 8. 模型名称与 Magpie ID

| 表中名称 | Magpie 模型 ID |
| --- | --- |
| Opus 5.5 | `claude/claude-opus-5-5` |
| Sonnet 5.5 | `claude/claude-sonnet-5-5` |
| Mythos 5.2 | `claude/claude-mythos-5-2` |
| Haiku 5.5 | `claude/claude-haiku-5-5` |
| Astra | `codex/gpt-6-astra` |
| Sol 6.1 | `codex/gpt-6.1-sol` |
| Terra 6.1 | `codex/gpt-6.1-terra` |
| Luna 6 | `codex/gpt-6-luna` |
| Sol 6 | `codex/gpt-6-sol` |
| Argon high | `hakimi/gemini-4-argon-high` |
| Argon medium | `hakimi/gemini-4-argon-medium` |
| Carbon high | `hakimi/gemini-4-carbon-high` |
| Carbon medium | `hakimi/gemini-4-carbon-medium` |

[E1]: https://artificialanalysis.ai/models/releases/comparisons/claude-opus-5-5-vs-gpt-6-astra
[E2]: model-routing-benchmark-report.md
[E3]: https://arena.ai/leaderboard/chat/text
[E4]: https://codepanel.ai/benchmarks
[E5]: https://matharena.ai/models/openai_gpt_61_sol
[E6]: https://matharena.ai/models/anthropic_opus_55_high
[E7]: https://matharena.ai/leanlean_october/
[E8]: https://www.designarena.ai/leaderboard
[E9]: https://livebench.ai/
[E10]: https://openai.com/index/introducing-gpt-6-1-sol/
[E11]: https://openai.com/index/introducing-gpt-6-1-terra/
[E12]: https://artificialanalysis.ai/models/claude-fable-5-2
[E13]: https://www.anthropic.com/claude-fable-and-mythos-5-2
[E14]: https://livebench.ai/
[E15]: https://arena.ai/leaderboard/chat/text
[E16]: https://livebench.ai/
[E17]: findings.md
[E18]: https://artificialanalysis.ai/models/gemini-4-carbon
