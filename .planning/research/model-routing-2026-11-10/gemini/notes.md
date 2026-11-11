# Gemini 4 Argon 公开测评证据，2026-11-10

行数据在 `rows.json`（565 行），由 `/tmp/route-2026-11-10/gemini-scripts/build_rows.py` 生成；脚本逐行检查 quote 是否出现在 source_file 中。(benchmark, model, effort) 在文件中不唯一，例如 FrontierCode 2.0 同时有 AA 自测值与 Cognition 榜单值，合并时要连同 `origin` 或 `source_url` 一起作键。`origin` 是在约定字段之外新增的字段，用来区分来源：`google-official`（Google 自己的发布表）、`anthropic-official`（Anthropic Fable 5.2 发布材料中的竞品列，取自 `official/rows.json`）、`aa`（Artificial Analysis）、`board`（任务清单内的第三方榜单）、`outside-list`（清单外的榜单：Vals、Snorkel、Epoch 模型页）。除 Argon 外，表中还收录了 Gemini 4 Carbon，以及新来源里出现的对照模型；对照模型在 AA 和清单内榜单上的数值仍以 `aa/`、`boards/` 的 rows.json 为准。所有页面都没有给出 Claude Mythos 5.2 的独立测评；Anthropic 发布页写明 "Claude Fable and Claude Mythos are the same underlying model"，下文凡用 Fable 5.2 代替 Mythos 5.2 的地方都会注明。

## Argon 是什么

- **家族位置**：Gemini 4 目前有两个型号，DeepMind 的 Gemini 页面（`sources/google-deepmind-models-gemini.txt`）只列 Argon 和 Carbon，Gemini API 文档里 Gemini 4 只有 `gemini-4-argon` 一个模型 ID（`sources/gapi-models.txt`、`gapi-latest-model.txt`）。Argon 是第一个发布的型号，Google 博客发布日期为 2026-09-30（`sources/google-blog-us-gemini-4-argon.txt`）。Carbon 于 2026-10-28 发布，Google 称其为 "our strongest model"，并写明 "Building on Gemini 4 Argon, which was launched two weeks ago"（`sources/google-blog-us-gemini-4-carbon.txt`）。两者标准价格相同，AA 测得 Carbon (High) 的 Intelligence Index 为 60，Argon (High) 为 50，每题成本 Carbon 7.76 美元、Argon 9.95 美元。Carbon 目前只开放给 Fairwind 计划中的一部分网络安全防御方，Argon 已经进入 Gemini API、AI Studio、Gemini App 和 Antigravity。
- **开放过程**：9 月 30 日先通过 Fairwind 计划开放给受信任的网络安全防御方；10 月 13 日起向 Google AI Pro 与 Ultra 订阅用户（Antigravity 桌面端和 CLI）、符合条件的 Gemini Enterprise 订阅以及 Gemini API 开放（`sources/ag-blog-argon.txt`）。模型卡发布于 2026 年 10 月 13 日（`sources/google-model-card-gemini-4-argon.txt`），MathArena 模型页也记为 2026-10-13。模型卡写明 Argon 是大规模稀疏 MoE 模型，"not a modification or a fine-tune of a prior model"，知识截止日期为 2026 年 3 月。
- **上下文与输出**：输入、思考、输出共用 1,048,576 个 token；同步请求默认最多输出 65,536 个 token，开启 long decode（后台执行或客户端续写）后单次回复最多约 1M token（`sources/gapi-models-gemini-4-argon.txt`、`gapi-thinking.txt`）。AA 记为 1M。
- **价格**：2026 年 11 月 30 日前为每百万输入 2 美元、输出 10 美元（思考 token 按输出计费），12 月 1 日起为 4 美元与 20 美元；缓存读取 0.10 美元，12 月 1 日起 0.20 美元；免费层不可用（`sources/gapi-pricing.txt`）。AA 的图表和每题成本一律按 4/20 美元的标准价计算。Epoch 模型页列出的 3.60/18 美元与 Google 文档不一致。
- **思考档位**：API 支持 `low`、`medium`、`high`，默认 `medium`（`sources/gapi-thinking.txt`）。Antigravity 文档同样提供 Low、Medium、High，文档里的模型选择器示意图中 Argon 默认勾选 High（`raw/ag-models.html`，`data-level-btn="High"` 带 `selected`）。
- **"trial" 的含义**：页面能确定的事实有三条。第一，Gemini API 把 `gemini-4-argon` 列为 Stable 版本，没有 preview 标记（`sources/gapi-models-gemini-4-argon.txt`）。第二，Antigravity 模型页给 Argon 加了 † 标记（HTML class 为 `model-trial-marker`），注释为 "Available with paid Google AI Pro plans or on trial with eligible premium devices"，选择器数据中 Argon 对 `proTrial` 档开放（`sources/ag-models.txt`、`raw/ag-models.html`）。第三，Antigravity 只公布按套餐划分的额度（Pro 每五小时刷新、另有每周上限，`sources/ag-plans.txt`），没有逐个模型的限额数字。所有已读页面都没有出现 `gemini-4-argon-trial` 这个名字，也没有单独的试用版模型或试用版测评。由此推断（页面没有直接写明）：Magpie 上游名中的 `-trial` 对应 Antigravity 的 Google AI Pro 试用权益这条接入路径，模型本身就是正式版 Argon。另外，AA 模型页仍写着 "No publicly available API"，与 Google 文档不一致；AA 9 月 30 日文章写的 "currently being rolled out to selected users and is not publicly available" 早于 10 月 13 日的开放。

## 各来源是否收录 Argon

| 来源 | Argon 是否在列 | 档位 | 说明 |
| --- | --- | --- | --- |
| Google 发布表（9 月 Argon 表、10 月 Carbon 表）与博客图表 | 是 | 自测项为最高思考档（high） | 第三方来源的数值不注明档位；表格对照列只有 Astra、Opus 5.5、Fable 5.1；Carbon 博客的 SEC-bench Pro 与 ExploitGym 图另含 Sol 6.1、Terra 6.1（图上读数，rows.json 已标注） |
| Anthropic Fable 5.2 发布材料 | 是（5 项） | 视项目而定 | FrontierSWE v2、CursorBench 4.0（medium）、Chartography、RoboDojo（high）、形态到分子匹配（Vertex 最高思考档） |
| Artificial Analysis | 是 | 只有 High | `/models/gemini-4-argon-low`、`-medium` 返回 404 |
| MathArena | ArXivMath、BrokenArXiv（8 至 10 月及汇总）、ArXivLean 9 月、LeanLean 10 月 | 未标注 | ArXivLean 6 月没有 Argon；表格带 ⚠️ "Model was released after competition release." |
| CodePanel | 是 | 未标注 | |
| DesignArena | Overall Agentic、Website | 未标注 | Python-PPTX Slides 榜没有 Argon |
| Arena Text（总榜、Expert、Coding、Chinese）、WebDev、Agent | 是 | High | |
| LiveBench 2.0（2026-11-06 版） | 是 | 未标注 | |
| Cognition FrontierCode 2.0 | 是 | low、medium、high 三档 | 数据来自页面加载的 `data.json`，榜单只显示最佳档 |
| Zapier AutomationBench | 是 | High、Medium | |
| OSWorld 官方榜、Snorkel OSWorld 2.0 榜 | 否 | | 官方榜最新条目为 2026-08-01；Argon 的 OSWorld 数值只有 Google 自测 |
| Terminal-Bench 4.0 / Terminal-Bench-Science 公开榜（tbench.ai 与 Snorkel 镜像） | 否 | | Google 方法说明写明 Argon 的这两项为自测 |
| 清单外：Vals Index v2.2、Snorkel Agents' Last Exam v1.1 与 WorkplaceAgents、Epoch 模型页 | 是 | ALE 标 High，其余未标注 | |

## 与当前规则逐项对照

差距是否超出误差，只在 Argon 与规则模型出现在同一榜单、并且页面给出区间时判断。厂商表之间不能互比：同一个 Fable 5.1 在 OSWorld 2.1 离线集上，Google 表写 76.8，Anthropic 表写 83.5；Sol 6.1 与 Terra 6.1 不在 Google 的任何一张表里。

**代码（规则：Mythos 5.2 high，以 Fable 5.2 代替）**：Argon 明显落后。Cognition FrontierCode 2.0 上 Argon 最佳为 high 26.30%（Devin CLI），Fable 5.2 high 45.29%、xhigh 49.11%（Claude Code），页面没有公布区间；AA 自己跑的 FrontierCode 2.0 为 25.7% 对 Fable 5.2 high 49.1%，两个独立来源方向一致。FrontierSWE v2（Epoch，high）55.0%，Anthropic 表中 Fable 5.2 为 69.9%。AA Terminal-Bench 4.0 为 57.1% 对 Fable 5.2 high 59.6%。CursorBench 4.0 上 Argon medium 52.8%（每题 4.39 美元），Fable 5.2 low 53.2%、high 56.9%。Arena WebDev 1683±10，Fable 5.2 为 1832±18（AutoEval），Opus 5.5 为 1818±12，区间不重叠。只有 LiveBench coding（Argon 85.7，Fable 5.2 79.2，无区间）和 Arena Text Coding（1553±10，与 Astra 1548±10、Opus 5.5 1546±11 区间重叠，Fable 5.2 不在该榜）显示 Argon 不落后。AA Coding Agent Index 中 Antigravity CLI + Argon 为 53.2，Claude Code + Opus 5.5 为 61.7（该榜没有 Fable 5.2）。

**科学（规则：Mythos 5.2）**：Argon 落后。AA Terminal-Bench-Science 0.1 为 52.9%，Fable 5.2 high 70.0%；CritPt v2 Hard 52.5% 对 73.0%；HLE-Diamond 56.7% 对 73.8%（AA 不给区间，差距都在 17 分以上）。Google 自测的 TB-Science 为 57.6%（6 倍验证超时），Anthropic 报告的 Mythos 5.2 为 75.3%，口径不同。Anthropic 的形态到分子匹配：Argon 25.2%，Mythos 5.2 35.2%。Epoch 的 GPQA Diamond 上 Argon 96%、Fable 5.2 94%，没有区间。

**数学、Lean 精简、文档、电脑操作（规则：Sol 6.1）**：
- 数学：MathArena ArXivMath 汇总 Argon 84.39±4.65，Sol 6.1 92.81±3.10，区间不重叠（Argon 上限 89.04，Sol 下限 89.71）；10 月单月 82.98±7.60 对 90.43±5.95，区间重叠。BrokenArXiv 汇总 47.89±6.21 对 83.09±4.59，10 月 39.81±9.23 对 80.25±7.51，差距远超区间。Epoch FrontierMath Tier 1-3 为 86% 对 94%，Tier 4 为 78% 对 100%（无区间）。
- Lean 精简：LeanLean 10 月 Argon 38.72%，Sol 50.45%，Opus 5.5 47.34%，没有区间；Argon 每题 79.79 美元，32 次触及限制的运行里有 22 次是 Argon（10 次 12 小时上限，12 次 100 美元预算）。
- 文档：AA GDP.pdf 为 21.8%，Sol 6.1 high 32.0%，无区间。Chartography（Surge 公布）Argon 71.6%，Sol 不在该表。LiveBench data_analysis 上 Argon 85.2，高于 Sol 82.7，无区间。
- 电脑操作：LiveBench browser 82.8，Sol 93.3、Terra 93.1。Google 自测 OSWorld 2.1 离线集 74.7%，Anthropic 系统卡图中 Sol 6.1 为 76.6%，两家口径不可比。
Sol 6.1 的成本也低得多：AA 上 Sol high 与 Argon 的 Intelligence Index 同为 50，每题成本 0.59 美元对 9.95 美元。

**终端与知识型交付物（规则：Sonnet 5.5）**：
- 终端：AA Terminal-Bench 4.0 为 57.1%，Sonnet 5.5 max 63.6%，无区间。公开 Terminal-Bench 榜没有 Argon。
- 知识型交付物：AA-Briefcase 1485（−10/+10），Sonnet 5.5 max 1813（−11/+12），GDPval-AA 1631±20 对 1838±23，两项差距都远超区间。业务流程自动化上 Argon 领先：Zapier AutomationBench Argon High 51.29%，Sonnet 5.5 Max 44.75%（无区间）；AA AutomationBench-AA 77.5% 对 71.8%。Vals Index v2.2 上 Argon 69.39%，Sonnet 70.85%（无区间）。Snorkel WorkplaceAgents 上 Argon 以 21.2% 排第一，Sol 6.1 15.0%、Opus 5.5 14.4%，Sonnet 5.5 不在该榜。LiveBench long_agentic 58.5，Sonnet 63.4。

**设计、写作、审查、Lean 证明（规则：Opus 5.5）**：
- 设计：DesignArena Overall Agentic Argon 1280（第 8），Opus 5.5 1462；页面误差以胜率百分点给出，按胜率比较，Argon 43.9%（±3.0%）对 Opus 74.0%（±2.1%），区间不重叠。Website 榜 Argon 1315，胜率 55.6%（±0.9%），Opus 5.5 1325，相差 10 Elo。LiveBench design 69.2，为所列模型最低，Opus 83.3。Arena WebDev 1683±10 对 1818±12。
- 写作：Argon 领先。Arena Text 总榜 Argon 1522±5（第 2），Opus 5.5 1506±6，区间不重叠（1517–1527 对 1500–1512）；Expert 1548±14 对 1544±16、Chinese 1584±16 对 1567±17，区间重叠。Fable 5.2 不在 Text 榜。
- 审查：CodePanel 捕获率 82%（71%–92%），Opus 5.5 90%（81%–97%），Sol 6.1 89%（80%–97%），区间重叠，同列第 1 档；误报每个干净 PR 1.1 次，Opus 1.7，Sol 0.9；每次审查 0.0527 美元，Opus 0.1525 美元，Sol 0.0401 美元。
- Lean 证明：ArXivLean 9 月 Argon 39.62±13.17，Opus 5.5 47.17±13.44，Sol 35.85±12.91，三者区间重叠。

**有边界的电脑操作（规则：Terra 6.1）**：LiveBench browser 82.8 对 93.1，无区间。Arena Agent 净改善 10.83%±0.87 对 12.10%±1.36，区间重叠，每题成本 0.77 美元对 0.82 美元。Agents' Last Exam v1.1（清单外，Google 把它归入电脑操作）通过率 40.2% 对 41.8%，评分 69.0% 对 69.8%，无区间，Sol 6.1 不在该榜。

## low / medium / high 的变化

| 来源 | low | medium | high | 说明 |
| --- | --- | --- | --- | --- |
| Cognition FrontierCode 2.0 Score | 21.47%（通过率 23.79%，3.98 美元，63k 输出 token） | 23.45%（26.06%，5.69 美元，124k） | 26.30%（29.09%，6.51 美元，149k） | 132 题，Devin CLI，无区间 |
| Zapier AutomationBench v1.0.6 | 无 | 50.08%（1.54 美元/题，标准价） | 51.29%（1.70 美元/题） | 无区间 |
| CursorBench 4.0（Anthropic 系统卡） | 无 | 52.8%（4.39 美元/题） | 无 | Cursor 中 Argon 的默认档 |
| AA、Arena、Snorkel ALE、Epoch FrontierSWE、Google 自测 | 无 | 无 | 有 | 只测 high；Google 博客的全部图表也没有分档结果，ExploitGym 图中 Argon 的 42.0% 与 39.5% 区分的是 10 小时与 6 小时的时间上限 |

两组有多档数据的测评都是逐档单调上升，每升一档提高 1 到 3 分；FrontierCode 上从 low 到 medium 输出 token 翻倍，分数只多 2 分。各档之间都没有公布区间，判断不了这些差距是否超出随机波动。作为参照，Carbon 在 FrontierCode 上 medium 40.00% 高于 high 37.48%，在 AA Intelligence Index 上 low/medium/high 为 54/58/60，Carbon 的档位规律不能直接套用到 Argon。

## 口径差异

- Google 9 月表与 10 月表不是同一版本：Vals Index 68.9%（未注版本）对 Vals Index v2.2 69.2%（Vals 页面今天为 69.39%）；Agent's Last Exam 通过率 39.5% 对 v1.1 评分 69.0%（Snorkel 现为通过率 40.2%、评分 69%）；OSWorld 2.0 离线部分分 69.2% 对 OSWorld 2.1 离线 74.7%。
- Google 自测与 AA 测得不同：Terminal-Bench 4.0 为 57.4%（Google 自测）、57.1%（AA）、57.6%（Vals 子项）；TB-Science 为 57.6%（Google 自测，6 倍验证超时）与 52.9%（AA）。
- AA 9 月 30 日文章里的 Intelligence Index 53、Briefcase 1494、每题 1.99 美元（折扣价）没有注明指数版本；AA 10 月 28 日的 Carbon 文章按 "Intelligence Index v5" 报告结果，Google 的 Carbon 博客称 v5.0 为 "recently updated"，所以 9 月 30 日的数值早于 v5，不能与现行 v5.0.1 的 50、1485、9.95 美元直接比较；rows.json 中这两行的 benchmark 名称带有版本说明。
- Argon 的 AA 每题成本在三处不同：9 月 30 日文章按标准价为 3.98 美元，10 月 28 日 Carbon 文章按标准价为 7.68 美元，模型页现为 9.95 美元（v5.0.1）。
- Vals 子项的列归属是按表头顺序和空白分隔推断的，rows.json 中已注明。
- 所有清单外来源（Vals、Snorkel、Epoch 模型页）在 rows.json 中标为 `outside-list`。

## 文件

- 行数据：`/tmp/route-2026-11-10/gemini/rows.json`
- 页面文本：`/tmp/route-2026-11-10/gemini/sources/`；Google 发布表图片与 PDF 渲染在 `/tmp/route-2026-11-10/gemini/raw/img/argon_table_original.png`、`raw/pdfimg/x/carbon-002.png`，与文本版逐项核对一致
- 复用的榜单文本：`/tmp/route-2026-11-10/boards/sources/`（Arena、DesignArena、LiveBench、CodePanel、MathArena、Zapier、Epoch FrontierSWE）与 `/tmp/route-2026-11-10/aa/sources/`（eval-briefcase、eval-gdpval）
- 脚本：`/tmp/route-2026-11-10/gemini-scripts/`
