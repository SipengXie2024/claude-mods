# GPT-6 Astra、GPT-6.1 Sol、Fable / Mythos 5.2 与 Gemini 4 Argon 的推理强度策略

`policy.v17` 为这几个模型使用各自的任务表，支持原始模型名称及 Magpie 的 `codex/gpt-6-astra`、`codex/gpt-6.1-sol`、`claude/claude-mythos-5-2`、`antigravity/gemini-4-argon` 标识。每条用户消息判断一次，同一轮的所有模型请求保持该档位。Fable 5.2 与 Mythos 5.2 是同一个模型，只是安全限制不同，共用一张表；JEV 只为 Mythos 会话设置强度，Fable 会话保持原样。

## 公开测量

数据于 2026-11-06 从 Artificial Analysis 的模型比较页面读取。以下百分比来自同一评测的不同推理档位。AA-Briefcase 是知识工作综合评分，包含分析、呈现和任务要求满足程度；它不能直接测出某一篇文章或某一种视觉设计的最优档位。

| 模型与评测 | low | medium | high | xhigh | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Astra · FrontierCode 2.0 | 26% | 37% | 40% | 41% | 42% |
| Astra · Terminal-Bench 4.0 | 42% | 49% | 54% | 60% | 59% |
| Astra · HLE-Diamond | 45% | 53% | 59% | 62% | 64% |
| Astra · Terminal-Bench Science 0.1 | 37% | 53% | 60% | 55% | 63% |
| Astra · AA-Briefcase v1.1 | 1256 | 1461 | 1505 | 1544 | 1569 |
| Sol 6.1 · FrontierCode 2.0 | 20% | 33% | 37% | 39% | 41% |
| Sol 6.1 · Terminal-Bench 4.0 | 31% | 48% | 52% | 54% | 56% |
| Sol 6.1 · HLE-Diamond | 38% | 46% | 52% | 56% | 59% |
| Sol 6.1 · Terminal-Bench Science 0.1 | 11% | 37% | 46% | 50% | 58% |
| Sol 6.1 · AA-Briefcase v1.1 | 1114 | 1360–1361 | 1469 | 1503 | 1555 |

Sol medium 的 AA-Briefcase 分数在两个比较页面分别显示为 1360 和 1361，因此记录为范围。比较页面会更新。

从 xhigh 到 max，Astra 的整套评测平均输出量从 26.7k 增加到 52k tokens，平均任务费用从 $3.66 增加到 $6.24；Sol 从 30.2k 增加到 67.8k tokens，平均任务费用从 $0.76 增加到 $1.27。费用和输出量属于整套评测的加权平均值，不能作为单个科学计算任务的费用。

来源：

- [Astra high / low](https://artificialanalysis.ai/models/comparisons/gpt-6-astra-high-vs-gpt-6-astra-low)
- [Astra high / medium](https://artificialanalysis.ai/models/comparisons/gpt-6-astra-high-vs-gpt-6-astra-medium)
- [Astra max / xhigh](https://artificialanalysis.ai/models/comparisons/gpt-6-astra-vs-gpt-6-astra-xhigh)
- [Sol 6.1 medium / low](https://artificialanalysis.ai/models/comparisons/gpt-6-1-sol-medium-vs-gpt-6-1-sol-low)
- [Sol 6.1 high / medium](https://artificialanalysis.ai/models/comparisons/gpt-6-1-sol-high-vs-gpt-6-1-sol-medium)
- [Sol 6.1 max / xhigh](https://artificialanalysis.ai/models/comparisons/gpt-6-1-sol-vs-gpt-6-1-sol-xhigh)
- [OpenAI GPT-6.1 Sol 发布说明](https://openai.com/index/introducing-gpt-6-1-sol/)：提供 DeepSWE、AutomationBench、科学计算和事实准确性结果。其研究环境与当前 Claude Code / Magpie 环境不同。

## 任务策略

下面是依据测量和用户偏好制定的策略。[NEEDS-EVIDENCE] 这些档位尚未通过用户任务集验证为最优选择。尤其是解释、写作和视觉设计，使用知识工作综合评测作为间接依据。

| 任务类型 | Astra 普通 / 复杂 | Sol 6.1 普通 / 复杂 |
| --- | --- | --- |
| 聊天 | low / low | low / low |
| 常规操作 | low / medium | low / medium |
| 解释 | medium / high | high / xhigh |
| 写作 | medium / high | high / xhigh |
| 视觉设计 | medium / high | high / xhigh |
| 编程 | medium / xhigh | medium / xhigh |
| 研究 | high / max | high / max |

两者的编程任务都从 medium 开始：low 到 medium 的编程成绩提升明显。复杂编程使用 xhigh；普通代码的失败还可以通过检查结果触发后续升级。Sol 的知识工作从 high 开始，是用户明确选择的质量与等待时间取舍。两者的困难研究允许直接 max，依据是科学计算测试的提升及用户对更高消耗的明确接受。

复杂任务沿用 JEV 的 `deep` 判断阈值。类型置信度不足时从 high 开始。配置范围、消息中的 `[effort …]` 和用户手动 `/effort` 设置继续生效。JEV 使用引擎接口支持的 low、medium、high、xhigh、max 五档。失败升级、同一任务的档位继承及探索概率沿用现有配置。

## Fable / Mythos 5.2

数据于 2026-11-10 从 Artificial Analysis v5.0.1 的 Fable 5.2 逐档页面读取；AA 没有测 Mythos 5.2。Anthropic 系统卡写明两者 "share the same underlying model and differ only in the safeguards"。

| 评测 | low | medium | high | xhigh | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| FrontierCode 2.0 | 38.4% | 41.3% | 49.1% | 47.6% | 48.8% |
| Terminal-Bench 4.0 | 54.5% | 55.1% | 59.6% | 61.6% | 59.6% |
| Terminal-Bench Science 0.1 | 53.8% | 60.5% | 70.0% | 67.6% | 73.3% |
| CritPt v2 hard | 60.0% | 61.5% | 73.0% | 73.5% | 76.5% |
| HLE-Diamond | 60.8% | 66.3% | 73.8% | 75.8% | 80.2% |
| AutomationBench-AA | 68.0% | 68.8% | 71.4% | 74.2% | 76.4% |
| AA-Briefcase v1.1 | 1563 | 1622 | 1677 | 1738 | 1785 |
| GDP.pdf | 26.8% | 23.8% | 21.8% | 21.4% | 24.2% |

Anthropic 自己的 FrontierCode 2.0 逐档结果为 34.2% / 37.6% / 45.3% / 49.1% / 45.7%，最高在 xhigh；AA 的最高在 high。两家都显示 medium 到 high 提升最大。

据此的任务表：代码 medium 起步，深入时 high；研究 high 起步，深入时 max（研究类分数一直升到 max，Anthropic 也建议 max 用于开放的科学和数学问题）；操作 low 起步，深入时直接 high（low 与 medium 几乎相同）；解释、写作、设计 medium 起步，深入时 high；聊天 low。Anthropic 说明 high 及以上档位每次回复前都会思考，打招呼也不例外，所以简单对话保持 low；low 和 medium 档更容易在长任务中途停下。

来源：

- [Fable 5.2 各档位（AA）](https://artificialanalysis.ai/models/claude-fable-5-2)
- [Anthropic Fable / Mythos 5.2 发布页](https://www.anthropic.com/claude-fable-and-mythos-5-2)
- 原始页面文字与逐行证据：仓库 `.planning/research/model-routing-2026-11-10/`

## Gemini 4 Argon

Argon 只有 low、medium、high 三档，Google 的默认档位是 medium；请求更高档位时，Magpie 按 high 发送（2026-11-10 实测 `--effort max` 在用量记录中为 high）。公开的逐档数据只有两项：

| 评测 | low | medium | high |
| --- | ---: | ---: | ---: |
| FrontierCode 2.0（Cognition） | 21.5% | 23.5% | 26.3% |
| Zapier AutomationBench | — | 50.1% | 51.3% |

Arena Text（总榜 1522±5，高于 Opus 5.5 的 1506±6）与 Artificial Analysis 只测了 high。据此的任务表：解释、写作、设计、代码 medium 起步，深入时 high；研究 high 起步；操作 low 起步，深入时 medium；聊天 low。数据很少，需要用评分校准。

经 sub2api 的 Antigravity 网关接入的模型（Magpie 的 `hakimi` 供应商）由模型名决定档位，请求里的强度不起作用，Magpie 把每一档登记成一个模型，如 `hakimi/gemini-4-argon-high`、`hakimi/gemini-4-carbon-medium`、`hakimi/claude-opus-5-5-low`。名字以 `-minimal`、`-low`、`-medium`、`-high`、`-xhigh` 或 `-max` 结尾的模型，JEV 不设置强度。

来源：仓库 `.planning/research/model-routing-2026-11-10/gemini/`
