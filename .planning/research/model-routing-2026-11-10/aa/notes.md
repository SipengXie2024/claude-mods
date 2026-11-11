# Artificial Analysis 独立测评：2026-11-10 采集说明

## 数据范围与版本

- 采集日期 2026-11-10，全部页面用 curl 直接从 artificialanalysis.ai 取得（HTTP 200，没有遇到 Cloudflare 拦截）。原始 HTML 在 `html/`，转换后的文本在 `sources/`，行数据在 `rows.json`（2611 行），页面上为空的单元格列在 `absent_cells.json`，生成脚本在 `scripts/`。
- 行数据的来源分三类：各模型全部档位的对比页表格（`sources/lvl-*.txt`）；AA-Briefcase 与 GDPval-AA 排行榜（带 95% 置信区间）；页面内嵌数据（`sources/embedded-model-records.txt` 与 `sources/coding-agents-embedded.txt`，逐行保存原始数值）。内嵌数据中的 432 个测评分数与表格逐一核对，全部一致；表格与 8 个发布对比页（`rel-*`）的 996 个单元格核对，全部一致。
- Intelligence Index 版本为 **v5.0.1**，与 2026-11-07 采集时相同。9 项测评与权重（`sources/methodology.txt`）：AA-Briefcase v1.1 15%、AutomationBench-AA 5%、GDP.pdf 5%、FrontierCode 2.0 15%、Terminal-Bench 4.0 10%、Terminal-Bench-Science 0.1 15%、CritPt v2 (Hard Subset) 10%、AA-Omniscience v1.1 15%、HLE-Diamond 10%。
- 新增模型：Claude Fable 5.2 于 2026-11-09 上线，AA 测了 low / medium / high / xhigh / max 五个档位。2026-11-07 之后 AA 没有再加入其他 OpenAI 或 Anthropic 模型（AA-Briefcase 排行榜按发布日期筛选，Nov 2026 只有 Fable 5.2；GPT-6 Sol Daybreak Blue 在 11-07 的来源中已经出现）。
- Claude Mythos 5.2 不在 AA：`/models/claude-mythos-5-2` 与 `/models/claude-mythos-5-2-max` 返回 404，模型列表页内嵌的全部 Claude slug 中没有 mythos，AA 文章列表（最新一篇为 2026-11-09）也没有 Fable 5.2 或 Mythos 5.2 的文章。
- "Default Fallback"：Fable 5.2、Fable 5.1、Opus 5.5、Sonnet 5.5 的所有档位都带这个标签。AA 在 Coding Agents 页解释安全拒答的两种结果："Blocked" 表示该次尝试终止，"Fallback means another model finished it"，并注明 "Safety and fallback behaviour is provider-configurable"。AA 页面没有给出 Fable 5.2 在 Intelligence Index 各测评中的回退比例。
- GPT-6 Sol 只有 max 档有 Intelligence Index 完整结果（44）。xhigh / high / medium / low 四档只有 Briefcase、AutomationBench、Terminal-Bench 4.0、GDP.pdf、Terminal-Bench-Science 五项，没有 Index、成本、token 与耗时；non-reasoning 档另外多一项 HLE-Diamond（9.5%）。GPT-6 Sol (Daybreak Blue, max) 有模型页，所有测评单元格为空。
- 不确定度：只有 AA-Briefcase、GDPval-AA 给出 95% 置信区间。其他测评的页面没有误差范围，因此下文几个百分点以内的差距不能判定为显著。

## 与 2026-11-07 数据的比较

旧数据中 582 行 AA 记录全部对上（`diff_vs_2026-11-07.json` 与 `diff_slug_rows.txt`）。

- 所有准确率类测评、Intelligence Index、每题成本和每题输出 token 全部不变。
- AA-Briefcase Elo 有三处变动 1 到 2 分：Opus 5.5 max 1800→1801，Haiku 5.5 max 1574→1573，GPT-6.1 Terra max 1401→1403，都远小于各自约 ±10 的置信区间。
- Time per Task 有 33 处变化，例如 GPT-6 Astra max 20.9→22.8 分钟，GPT-6.1 Sol max 21.7→19.5 分钟，Claude Haiku 5.5 max 16.1→14.8 分钟。AA 说明输出速度取过去 5 天各工作负载的平均值，耗时由输出 token 除以输出速度得到，因此这一列随日期浮动。

## 各测评领先者（只计入本次列出的 OpenAI / Anthropic 模型）

| 测评 | 第一 | 次于第一的其他模型 | 差距 | 说明 |
| --- | --- | --- | --- | --- |
| Intelligence Index | Fable 5.2 max 65 | Opus 5.5 max 59 | 6 | Fable 5.2 前三档占前三；全站 Gemini 4 Carbon (High) 60 排第四 |
| AA-Briefcase v1.1 (Elo) | Sonnet 5.5 max 1813 (−11/+12) | Opus 5.5 max 1801 (±10) | 12 | Fable 5.2 max 1785 (−12/+13) 第三。Sonnet 与 Opus、Opus 与 Fable 5.2 的区间重叠；Sonnet 下界 1802 高于 Fable 5.2 上界 1798 |
| AutomationBench-AA | Fable 5.2 max 76.4% | Sonnet 5.5 max 71.8% | 4.6 | 全站第一 Gemini 4 Carbon (High) 77.8% |
| Terminal-Bench 4.0 | Sonnet 5.5 max 63.6% | Fable 5.2 xhigh 61.6% | 2.0 | 全站第一 Kimi K3.1 Pro 67.2%，第二 Gemini 4 Carbon (High) 65.2% |
| FrontierCode 2.0 | Fable 5.2 high 49.1% | Opus 5.5 max 46.4% | 2.7 | Fable 5.2 high 高于自身 max 48.8% |
| AA-Omniscience v1.1 | Fable 5.2 max 67 | Opus 5.5 max 48 | 19 | Fable 5.2 low 也有 63 |
| GDP.pdf (All-pass) | Astra xhigh 32.2% | Sol 6.1 high 32.0% | 0.2 | 全站第一 Muse Wonder Full (Max) 32.6%；Fable 5.2 最高 26.8%（low） |
| HLE-Diamond | Fable 5.2 max 80.2% | Opus 5.5 max 67.9% | 12.3 | |
| CritPt v2 (Hard Subset) | Fable 5.2 max 76.5% | Astra medium 72.0% | 4.5 | |
| Terminal-Bench-Science 0.1 | Fable 5.2 max 73.3% | Astra max 63.3% | 10.0 | |
| Capability Index（六个行业） | Fable 5.2 max | Opus 5.5 max | 5.3 到 7.5 | 金融 64.7 对 59.4，战略运营 67.4 对 61.4，法律 63.3 对 58.0，医疗 65.4 对 57.9，工程 72.6 对 65.3，经济 66.5 对 60.3。Fable 5.2 的医疗分只有 max 档，其余档位页面显示 "--" |
| GDPval-AA v2.1 (Elo，不计入 Index) | Opus 5.5 max 1866 (±26) | Sonnet 5.5 max 1838 (±23) | 28 | Fable 5.2 max 1831 (±27)，三者区间两两重叠 |
| Coding Agent Index v2.0 | Claude Code + Opus 5.5 max 61.7 | Claude Code + Sonnet 5.5 max 59.3 | 2.4 | 31 个配置中没有 Fable 5.2；Codex 侧最高为 Astra max 54.7 |
| AA-AnalystAgent pass^5（不计入 Index） | Fable 5.1 max、Sonnet 5.5 max 并列 57.5% | Opus 5.5 max 56.2% | 1.3 | 只测了各模型 max 档；Fable 5.2 没有结果。全站第一 Gemini 3.7 Flash (High) 60.0% |
| ITBench-AA SRE（不计入 Index） | Fable 5.1 max 49.5% | GPT-6 Sol max 49.4% | 0.1 | 所列模型中只有 4 个配置有结果，Fable 5.2 没有 |
| Harvey LAB-AA（不计入 Index） | Astra max 8.6% | Fable 5.2 max 7.2% | 1.4 | 法律任务的幻觉门控全通过率，各模型都很低 |
| CritPt v2 完整 70 题（不计入 Index） | Fable 5.2 max 86.3% | Astra max 83.1% | 3.2 | 内嵌数据只覆盖部分档位；评测页写明 Fable 5.2 xhigh 84.9% 第二、Astra medium 84.0% 第三 |

APEX-Agents-AA 与 EnterpriseOps-Gym-AA 页面中，所列模型的所有配置都没有分数。

## Fable 5.2 从 low 到 max 的变化

| 指标 | low | medium | high | xhigh | max |
| --- | --- | --- | --- | --- | --- |
| Intelligence Index | 54 | 56 | 62 | 62 | 65 |
| AA-Briefcase (Elo) | 1563 | 1622 | 1677 | 1738 | 1785 |
| AutomationBench-AA | 68.0 | 68.8 | 71.4 | 74.2 | 76.4 |
| Terminal-Bench 4.0 | 54.5 | 55.1 | 59.6 | 61.6 | 59.6 |
| FrontierCode 2.0 | 38.4 | 41.3 | 49.1 | 47.6 | 48.8 |
| AA-Omniscience | 63 | 64 | 64 | 65 | 67 |
| GDP.pdf | 26.8 | 23.8 | 21.8 | 21.4 | 24.2 |
| HLE-Diamond | 60.8 | 66.3 | 73.8 | 75.8 | 80.2 |
| CritPt v2 Hard | 60.0 | 61.5 | 73.0 | 73.5 | 76.5 |
| Terminal-Bench-Science | 53.8 | 60.5 | 70.0 | 67.6 | 73.3 |
| GDPval-AA v2.1 (Elo) | 1546 | 1591 | 1718 | 1751 | 1831 |
| Index 每题成本 (USD) | 3.10 | 3.80 | 9.08 | 14.83 | 26.54 |
| Index 每题输出 token | 35.9k | 43.1k | 97.8k | 162k | 274k |
| Index 每题耗时 (分钟) | 6.5 | 8.3 | 17.7 | 26.3 | 46.4 |
| FrontierCode 每题成本 (USD) | 2.12 | 2.69 | 9.64 | 21.41 | 43.37 |
| Terminal-Bench 4.0 每题成本 (USD) | 4.34 | 5.25 | 13.47 | 20.81 | 31.59 |
| Terminal-Bench-Science 每题成本 (USD) | 8.78 | 10.98 | 24.28 | 31.37 | 45.21 |
| Briefcase 每题成本 (USD) | 5.62 | 6.84 | 15.49 | 28.56 | 59.35 |

- medium→high 的提升最大：Index +6，FrontierCode +7.8，HLE +7.5，CritPt +11.5，Terminal-Bench-Science +9.5，GDPval +127 Elo；Index 每题成本从 3.80 美元升到 9.08 美元（约 2.4 倍）。
- high→xhigh：Index 每题成本增加 63%（9.08→14.83 美元），Index 不变（62）。各项变化为 Briefcase +61 Elo、AutomationBench +2.8、Terminal-Bench 4.0 +2.0、HLE +2.0、GDPval +33 Elo、Omniscience +1、CritPt +0.5、FrontierCode −1.5、Terminal-Bench-Science −2.4、GDP.pdf −0.4。
- xhigh→max：Index 每题成本增加 79%（14.83→26.54 美元），耗时 26.3→46.4 分钟。Index +3、HLE +4.4、Terminal-Bench-Science +5.7、CritPt +3.0、Briefcase +47 Elo、GDPval +80 Elo；Terminal-Bench 4.0 从 61.6 降到 59.6。
- 按 Index 计，low（54，3.10 美元）高于 Opus 5.5 high（52，3.46 美元）；high（62，9.08 美元）高于 Opus 5.5 max（59，10.04 美元）。
- 不单调的项目：GDP.pdf 在 low 档最高；Terminal-Bench 4.0 的峰值在 xhigh；FrontierCode 与 Terminal-Bench-Science 的 high 都高于 xhigh。

## Fable 5.2 与路由表现有选择的对照

- 代码修改（表中为 Opus 5.5 xhigh / max）：Fable 5.2 high 在 FrontierCode 2.0 上 49.1%，高于 Opus 5.5 max 46.4% 与 xhigh 43.8%；FrontierCode 每题成本 9.64 美元，Opus max 13.46 美元、xhigh 6.49 美元。Terminal-Bench 4.0 上 Fable 5.2 high 与 Opus 5.5 xhigh / max 同为 59.6%。Coding Agent Index（Claude Code 环境）还没有 Fable 5.2 的结果。
- 终端操作（表中为 Sonnet 5.5 max）：Sonnet 5.5 max 63.6% 仍是所列模型中最高，Fable 5.2 xhigh 61.6%；Terminal-Bench 4.0 每题成本 Sonnet max 12.65 美元，Fable 5.2 xhigh 20.81 美元。
- 科学计算（表中为 Astra high / max）：Terminal-Bench-Science 上 Fable 5.2 high 70.0%、max 73.3%，高于 Astra max 63.3% 与 high 59.5%；CritPt v2 Hard 上 Fable 5.2 max 76.5% 高于 Astra high 71.5%。Terminal-Bench-Science 每题成本 Astra max 17.48 美元，Fable 5.2 high 24.28 美元、max 45.21 美元。
- 知识工作交付（表中为 Sonnet 5.5 max）：Briefcase 上 Sonnet 5.5 max 1813 仍居首，Fable 5.2 max 1785，两者区间不重叠；GDPval-AA 上 Opus 5.5 max 1866 居首。Briefcase 每题成本 Sonnet max 20.47 美元，Fable 5.2 max 59.35 美元。
- 文档分析（表中为 Sol 6.1 high）：GDP.pdf 上 Sol 6.1 high 32.0%，Fable 5.2 各档 21.4% 到 26.8%，明显较低。
- 长时间自主执行候选（表中为 Fable 5.1 xhigh）：Fable 5.2 xhigh 在九项中的八项高于 Fable 5.1 xhigh（Index 62 对 50，Terminal-Bench-Science 67.6 对 40.5），只有 GDP.pdf 较低（21.4% 对 26.2%）；Index 每题成本 14.83 美元对 10.85 美元。
