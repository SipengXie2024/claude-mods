# 模型路由表规则核对

对象：[模型路由表](/home/ubuntu/sipeng/claude-mods/.planning/model-routing-table.md)。核对日期：2026-11-09。

文档 SHA-256：`4a4db22a860b1bd4039fe84cb7cfd85e0a449aa0470a16ef9684ad98c701ea76`。

核对方式为文档规则推演与 Markdown 结构检查。模型路由尚未接入运行配置。

## 用户确定的处理方式

- 日常任务没有进展：由独立诊断子代理检查证据并提出建议；在既定目标、验收条件和已有路由规则内，Telegram Router 可以继续分派。涉及关键设计变化或缺少合适方案时交回用户决定。
- 日常任务没有匹配规则：系统准备模型与 effort 的推荐及依据，用户确认后创建实际执行者。本次例外保留记录，通用规则通过用户参与的校准讨论调整。

## 情景核对

| 情景 | 文档规定的结果 | 对应位置 |
| --- | --- | --- |
| Telegram 日常任务仍围绕原目标，但开始需要持续讨论模块职责和整体方案 | 与用户讨论是否建立长期任务；用户确认架构师模型后交接关键材料，保留任务身份和追问关联 | [任务归属](/home/ubuntu/sipeng/claude-mods/.planning/model-routing-table.md:18) |
| 新日常任务目标清楚，但没有适用的执行规则 | `route-assessment` 负责准备推荐；Router 等待用户确认后创建执行者 | [日常判断与分派](/home/ubuntu/sipeng/claude-mods/.planning/model-routing-table.md:26)、[评估规则](/home/ubuntu/sipeng/claude-mods/.planning/model-routing-table.md:45) |
| 没有架构师的日常任务执行没有进展 | 诊断者负责技术判断，Router 根据适用规则继续分派；同一阻碍最多一次诊断、一次实施模型更换，次数随任务累计 | [无进展规则](/home/ubuntu/sipeng/claude-mods/.planning/model-routing-table.md:118) |
| Sol 6.1 完成任务，明确要求另一个模型复核 | 排除原模型，推荐符合任务要求的 Opus 5.5 / medium；别名或 effort 变化仍视为同一模型 | [复核规则](/home/ubuntu/sipeng/claude-mods/.planning/model-routing-table.md:50) |
| 所有适合复核的候选都被排除或不可用 | 向用户报告限制并等待决定；维持不同模型的要求 | [模型选择条件](/home/ubuntu/sipeng/claude-mods/.planning/model-routing-table.md:52) |
| 创建普通实施子代理，或续接它的任务 | 新建时只接收独立任务说明和必要材料，不继承主对话全文；续接时保留自身任务历史 | [上下文约定](/home/ubuntu/sipeng/claude-mods/.planning/model-routing-table.md:24) |

## 结构检查结果

- 19 个唯一规则 ID，包含用于未覆盖任务的 `route-assessment`。
- 11 项证据引用均能解析；本地文档链接存在。
- 9 个模型 ID 均在已核实的 Magpie 候选目录中。
- 8 个主体章节及各表格列数完整。
- 任务记录包含负责人、用户确认内容、原模型与复核模型、上下文来源，以及同一阻碍的诊断和模型更换次数。

[系统行为约定](/home/ubuntu/sipeng/claude-mods/.planning/model-routing-design.md)与以上选择一致。测评数据与建议适用条件见[调研报告](/home/ubuntu/sipeng/claude-mods/.planning/model-routing-benchmark-report.md)。
