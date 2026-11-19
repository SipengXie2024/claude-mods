# GPT-6 / 6.2 Astra、GPT-6.1 / 6.2 Sol、Fable / Mythos 5.2 与 Gemini 4 Argon、Carbon、Neon、Hydrogen 的推理强度策略

`policy.v18` 为这几个模型使用各自的任务表，支持原始模型名称及 Magpie 的 `codex/gpt-6-astra`、`codex/gpt-6.2-astra`、`codex/gpt-6.1-sol`、`codex/gpt-6.2-sol`、`claude/claude-mythos-5-2`、`hakimi/gemini-4-argon`、`hakimi/gemini-4-carbon`、`hakimi/gemini-4-neon`、`hakimi/gemini-4-hydrogen` 等标识（`antigravity/` 前缀与 `[1m]` 后缀同样识别）。每条用户消息判断一次，同一轮的所有模型请求保持该档位。Fable 5.2 与 Mythos 5.2 是同一个模型，只是安全限制不同，共用一张表；JEV 只为 Mythos 会话设置强度，Fable 会话保持原样。

## GPT-6 Astra 与 GPT-6.1 Sol：公开测量

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

## GPT-6 Astra 与 GPT-6.1 Sol：任务策略

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

来源：仓库 `.planning/research/model-routing-2026-11-10/gemini/`

## GPT-6.2 Astra 与 GPT-6.2 Sol

数据于 2026-11-19 从 Artificial Analysis v5.0.1 的逐档记录读取。两个模型都有 low、medium、high、xhigh、max 五档，OpenAI 的默认档位是 medium。Astra 的 `-900k` 与 `[1m]` 后缀、Sol 的 `[1m]` 后缀同样识别。

| 模型与评测 | low | medium | high | xhigh | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| 6.2 Astra · Intelligence Index | 46 | 57 | 60 | 62 | 62 |
| 6.2 Astra · FrontierCode-AA 2.0 | 32.7% | 46.6% | 47.1% | 49.0% | 45.4% |
| 6.2 Astra · Terminal-Bench 4.0 | 51.0% | 58.6% | 60.1% | 64.1% | 64.1% |
| 6.2 Astra · Terminal-Bench Science 0.1 | 51.0% | 74.8% | 75.2% | 78.6% | 78.1% |
| 6.2 Astra · CritPt v2 hard | 61.0% | 67.5% | 71.5% | 70.5% | 71.5% |
| 6.2 Astra · HLE-Diamond | 47.7% | 56.0% | 65.9% | 67.3% | 72.2% |
| 6.2 Astra · AA-Briefcase v1.1 | 1039 | 1408 | 1570 | 1594 | 1643 |
| 6.2 Astra · AutomationBench-AA | 68.6% | 72.8% | 76.0% | 76.1% | 77.2% |
| 6.2 Astra · GDP.pdf | 28.0% | 28.4% | 28.6% | 28.0% | 29.8% |
| 6.2 Astra · 每题费用 | $0.66 | $1.62 | $2.07 | $2.52 | $4.00 |
| 6.2 Astra · 每题分钟 | 1.9 | 4.5 | 6.1 | 7.5 | 13.9 |
| 6.2 Sol · Intelligence Index | 41 | 53 | 55 | 56 | 57 |
| 6.2 Sol · FrontierCode-AA 2.0 | 31.4% | 41.4% | 40.2% | 42.8% | 44.4% |
| 6.2 Sol · Terminal-Bench 4.0 | 37.9% | 56.1% | 58.6% | 56.1% | 60.1% |
| 6.2 Sol · Terminal-Bench Science 0.1 | 37.1% | 60.5% | 67.6% | 66.7% | 67.6% |
| 6.2 Sol · CritPt v2 hard | 58.0% | 64.0% | 61.5% | 62.5% | 62.5% |
| 6.2 Sol · HLE-Diamond | 34.5% | 50.7% | 58.3% | 61.8% | 64.0% |
| 6.2 Sol · AA-Briefcase v1.1 | 1230 | 1495 | 1541 | 1580 | 1612 |
| 6.2 Sol · AutomationBench-AA | 63.2% | 70.3% | 69.9% | 70.6% | 71.3% |
| 6.2 Sol · GDP.pdf | 28.6% | 29.2% | 28.8% | 28.4% | 30.0% |
| 6.2 Sol · 每题费用 | $0.18 | $0.41 | $0.56 | $0.65 | $1.01 |
| 6.2 Sol · 每题分钟 | 1.5 | 3.3 | 4.7 | 5.4 | 8.7 |

每题费用与分钟数是 AA 整套评测的平均值。据此的任务表：

| 任务类型 | 6.2 Astra 普通 / 复杂 | 6.2 Sol 普通 / 复杂 |
| --- | --- | --- |
| 聊天 | low / low | low / low |
| 常规操作 | low / high | medium / high |
| 解释 | high / xhigh | high / xhigh |
| 写作 | high / xhigh | high / xhigh |
| 视觉设计 | high / xhigh | high / xhigh |
| 编程 | medium / xhigh | medium / xhigh |
| 研究 | high / max | high / max |

两者的编程都从 medium 起步：FrontierCode 从 low 到 medium 提升最大（Astra 32.7% → 46.6%，Sol 31.4% → 41.4%），复杂编程用 xhigh，Astra 的 FrontierCode 与 Terminal-Bench 4.0 都在 xhigh 达到最高。解释、写作、设计从 high 起步：Astra 的 AA-Briefcase 在 high 从 1408 跳到 1570，每题只要 6.1 分钟；Sol 的 Briefcase 在 high 为 1541。研究 high 起步，深入时 max：HLE-Diamond 一直升到 max（Astra 72.2%，Sol 64.0%）。Astra 的操作 low 起步（Terminal-Bench 4.0 low 已有 51.0%），Sol 的操作 medium 起步（low 只有 37.9%，medium 56.1%），深入时都用 high。

来源：

- [6.2 Astra 各档位（AA）](https://artificialanalysis.ai/models/comparisons/gpt-6-2-astra-vs-gpt-6-2-astra-xhigh-vs-gpt-6-2-astra-high-vs-gpt-6-2-astra-medium-vs-gpt-6-2-astra-low)
- [6.2 Sol 各档位（AA）](https://artificialanalysis.ai/models/comparisons/gpt-6-2-sol-vs-gpt-6-2-sol-xhigh-vs-gpt-6-2-sol-high-vs-gpt-6-2-sol-medium-vs-gpt-6-2-sol-low)

## Gemini 4 Carbon、Neon 与 Hydrogen

数据于 2026-11-19 从 Artificial Analysis v5.0.1 的逐档比较页面读取。Carbon 与 Argon 一样只有 low、medium、high 三档；Neon 与 Hydrogen 有 low、medium、high、xhigh 四档，没有 max。

| 模型与评测 | low | medium | high | xhigh |
| --- | ---: | ---: | ---: | ---: |
| Carbon · Intelligence Index | 54 | 58 | 60 | — |
| Carbon · FrontierCode-AA 2.0 | 29.6% | 39.5% | 40.6% | — |
| Carbon · FrontierCode 2.0（Cognition） | 31.88% | 40.00% | 37.48% | — |
| Carbon · Terminal-Bench 4.0 | 62.6% | 60.6% | 65.2% | — |
| Carbon · Terminal-Bench Science 0.1 | 61.9% | 62.4% | 64.8% | — |
| Carbon · CritPt v2 hard | 65.0% | 69.0% | 69.0% | — |
| Carbon · HLE-Diamond | 61.9% | 67.4% | 69.1% | — |
| Carbon · AA-Briefcase v1.1 | 1567 | 1602 | 1611 | — |
| Carbon · AutomationBench-AA | 63.5% | 77.6% | 77.8% | — |
| Carbon · GDP.pdf | 28.6% | 29.6% | 28.4% | — |
| Carbon · 每题费用 | $7.19 | $6.59 | $7.76 | — |
| Carbon · 每题分钟 | 30.4 | 29.6 | 37.2 | — |
| Neon · Intelligence Index | 44 | 55 | 60 | 61 |
| Neon · FrontierCode-AA 2.0 | 26.9% | 36.9% | 43.3% | 44.4% |
| Neon · Terminal-Bench 4.0 | 32.8% | 54.5% | 61.6% | 63.6% |
| Neon · Terminal-Bench Science 0.1 | 27.1% | 54.8% | 65.7% | 70.0% |
| Neon · CritPt v2 hard | 62.0% | 61.5% | 59.0% | 60.5% |
| Neon · HLE-Diamond | 54.2% | 63.6% | 68.4% | 71.3% |
| Neon · AA-Briefcase v1.1 | 1297 | 1518 | 1632 | 1700 |
| Neon · AutomationBench-AA | 76.0% | 77.8% | 79.2% | 79.3% |
| Neon · GDP.pdf | 31.4% | 32.8% | 33.4% | 28.0% |
| Neon · 每题费用 | $0.75 | $1.90 | $3.74 | $6.44 |
| Neon · 每题分钟 | 3.7 | 8.3 | 14.8 | 21.5 |
| Hydrogen · Intelligence Index | 27 | 41 | 51 | 54 |
| Hydrogen · FrontierCode-AA 2.0 | 9.3% | 31.5% | 36.3% | 39.0% |
| Hydrogen · Terminal-Bench 4.0 | 6.6% | 29.3% | 54.0% | 53.5% |
| Hydrogen · Terminal-Bench Science 0.1 | 2.4% | 15.2% | 41.4% | 49.5% |
| Hydrogen · CritPt v2 hard | 48.0% | 61.0% | 61.5% | 66.0% |
| Hydrogen · HLE-Diamond | 32.2% | 47.7% | 54.9% | 58.8% |
| Hydrogen · AA-Briefcase v1.1 | 947 | 1296 | 1497 | 1568 |
| Hydrogen · AutomationBench-AA | 60.5% | 72.0% | 74.4% | 76.1% |
| Hydrogen · GDP.pdf | 28.2% | 32.8% | 30.0% | 27.6% |
| Hydrogen · 每题费用 | $0.29 | $0.80 | $1.87 | $3.16 |
| Hydrogen · 每题分钟 | 1.5 | 4.2 | 8.6 | 15.2 |

据此的任务表：

| 任务类型 | Carbon 普通 / 复杂 | Neon 普通 / 复杂 | Hydrogen 普通 / 复杂 |
| --- | --- | --- | --- |
| 聊天 | low / low | low / low | low / low |
| 常规操作 | low / high | medium / high | high / high |
| 解释 | medium / high | medium / high | medium / high |
| 写作 | medium / high | medium / high | medium / high |
| 视觉设计 | medium / high | medium / high | medium / high |
| 编程 | medium / high | medium / high | medium / xhigh |
| 研究 | high / high | high / xhigh | high / xhigh |

Carbon 的任务表不超过 high。它的 Terminal-Bench 4.0 在 low 已有 62.6%，所以操作 low 起步，深入时 high；编程 medium 起步（FrontierCode 29.6% → 39.5%）；各档的每题时间都在 30 分钟上下，费用也接近，深入时直接用 high。

Neon 的操作从 medium 起步：Terminal-Bench 4.0 在 low 只有 32.8%，medium 为 54.5%。解释、写作、设计 medium 起步、深入时 high：文档材料核对（GDP.pdf）在 high 最高（33.4%），到 xhigh 反而降到 28.0%，medium 每题 8.3 分钟、high 14.8 分钟。编程 medium 起步、深入时 high（FrontierCode 43.3%）；xhigh 的 44.4% 只高出 1.1 个百分点，留给失败后的提升。深入研究用 xhigh（HLE-Diamond 71.3%、Terminal-Bench Science 70.0%）。

Hydrogen 的 low 与 medium 在终端操作和编程上很弱（Terminal-Bench 4.0 6.6%、29.3%，high 54.0%；FrontierCode 9.3%、31.5%），所以操作从 high 起步、最低 medium，编程 medium 起步、深入时 xhigh（39.0%）。深入研究用 xhigh（CritPt 66.0%、HLE-Diamond 58.8%）。

[NEEDS-EVIDENCE] 这五个模型的档位与 Astra、Sol 6.1 一样，尚未通过用户任务集验证为最优选择；解释、写作和设计仍以知识工作综合评测为间接依据。

来源：

- [Neon 各档位与 Carbon（AA）](https://artificialanalysis.ai/models/comparisons/gemini-4-neon-vs-gemini-4-neon-high-vs-gemini-4-neon-medium-vs-gemini-4-neon-low-vs-gemini-4-carbon)，页面文字存于仓库 `.planning/research/model-routing-2026-11-19/aa-cmp-neon.txt`
- [Hydrogen 各档位（AA）](https://artificialanalysis.ai/models/comparisons/gemini-4-hydrogen-vs-gemini-4-hydrogen-high-vs-gemini-4-hydrogen-medium-vs-gemini-4-hydrogen-low-vs-claude-sonnet-5-5)，页面文字存于 `.planning/research/model-routing-2026-11-19/aa-cmp-hydrogen.txt`
- Carbon 的 Cognition FrontierCode：仓库 `.planning/research/model-routing-2026-11-10/gemini/`

## 经 hakimi 接入的 Gemini 模型

Magpie 的 `hakimi` 供应商经 sub2api 的 Antigravity 网关接入 Gemini 模型。不带档位的模型 ID（`hakimi/gemini-4-argon`、`hakimi/gemini-4-carbon`、`hakimi/gemini-4-neon`、`hakimi/gemini-4-hydrogen`）由 sub2api 按请求里的强度选择上游档位：Argon 与 Carbon 高于 high 的请求按 high 运行，Neon 与 Hydrogen 的 max 请求按 xhigh 运行。JEV 为这些不带档位的 ID 设置强度。带档位的 ID（名字以 `-minimal`、`-low`、`-medium`、`-high`、`-xhigh` 或 `-max` 结尾，如 `hakimi/gemini-4-carbon-medium`、`hakimi/claude-opus-5-5-low`）由模型名决定档位，请求里的强度不起作用，JEV 不设置强度。

JEV 不按模型限制档位：失败后的提升和用户指定的范围可以把请求提到模型没有的档位，这时由上游按它的最高档运行。
