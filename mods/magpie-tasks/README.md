# magpie-tasks

claude-magpie 会话的长期任务与子代理路由插件。设计依据见仓库的 `.planning/model-routing-implementation.md` 与 `.planning/plan-magpie-tasks.md`。

## 用途

- **长期任务。** 每个交互式 `claude-magpie` 新窗口的第一条消息登记为一个长期任务：Jev 推荐架构师模型（Opus 5.5、Astra 或 Sol 6.1），用户在确认对话中选定后，插件确定任务的工作目录（见下面的“工作目录”），以 `claude-magpie --bg` 启动架构师后台会话，前台窗口随即结束，`claude attach <id>` 可以重新打开。用 `claude-magpie --resume` 恢复一个没有登记的已有会话时，插件询问一次是否接管为长期任务。
- **工作目录。** 任务第一次修改某个项目时，插件确定它在哪里修改。没有其他进行中的任务在直接修改这个项目时，任务直接修改项目目录本身；在 Git 仓库中，插件为当时的目录内容做一个基线提交（挂在 `refs/magpie-tasks/` 下，不在任何分支上，也不动用户的暂存区），用它区分这个任务的改动。已有任务在直接修改同一个项目时，后来的任务得到一份 Git 工作副本，结果验收后再应用到项目。不是 Git 仓库的目录总是直接修改，插件不建立仓库，只记录子代理用文件工具改过的文件。一个已结束的直接修改任务被后续消息恢复时，如果项目已被另一个任务直接修改，它先转到一份工作副本。
- **架构师的限制。** 架构师留在项目主目录，只能写 `.planning/findings.md`、`CONTEXT.md`、`.planning/plan-*.md` 与 `.planning/*.html`，Bash 只能运行只读命令、html-plan 的打包和发布命令，以及在项目主目录直接运行的 `git add`、`git commit`、`git push`（不带 `-C` 和 `-c`）；实施交给子代理，它们在任务的工作目录中修改。架构师有 `task_status`、`report_outcome`、`integrate`、`notify_user`、`resolve_conflict` 五个工具；`integrate` 把工作副本的改动应用到项目主目录的工作区，直接修改的任务则把已在项目目录里的改动记为结果，都不做提交。 `notify_user` 分三种：`decision` 请用户决定，`result` 报告完成的一部分，`done` 表示整个任务完成，任务随即关闭。
- **提交与推送。** 用户要求时，架构师和执行任务的工作者在项目主目录提交和推送；任务工作副本里的提交是插件的快照，带有用户未提交的文件，所以从不在工作副本里提交或推送。直接修改项目目录的工作者，改动随时可以提交；在工作副本中的改动要等回合结束、插件整合到主目录之后才能提交，用户再说一次即可；工作者从下一条消息后的说明行得知结果如何处理。验收和诊断的工作者只检查，不提交。
- **子代理路由。** 架构师与 Telegram Router 启动的每个子代理按 `rules/routing-rules.json` 的 19 条规则选择模型：Jev 判断适用的规则和是否需要深入推理（它读到发起委派的那段对话、委派说明里提到的文件和委派说明本身），插件设置模型与每一步的思考强度（续接、验收不通过、诊断后重新委派时提高）；Jev 在两条用不同模型的规则之间拿不准时，从 Mythos 5.2、Opus 5.5、Astra 中随机选一个，评分用来比较它们。指定模型的委派必须写 `[model-reason user: …]` 或 `[model-reason evidence: …]`。子代理说明的第一行是任务标记 `[magpie-tasks task=…]`，JEV 据此跳过这些子代理。
- **日常任务。** Router 派发的 Telegram 或终端任务登记为日常任务：执行者每完成一轮，Jev 判断这一轮的成果是否值得独立检查（依据用户这一轮的话、回答、工具调用次数和改动统计）；对话式的回答、交还和一两行的机械修改不验收，其余由验收子代理检查一次。验收子代理按 `review` 规则检查，模型取每周额度剩余比例最高的订阅中审查最合适的模型（规则文件的 `acceptance` 一节：Claude 订阅用 Opus 5.5，Codex 订阅用 Sol 6.1；某个限制窗口已经用完的订阅排在最后，比例相同时按列出的顺序），每次开始验收时从 Magpie 的 `/v1/magpie/quotas` 读取额度。直接修改的改动已经在项目目录里，验收在改完之后进行，结束时插件把改动记为结果；工作副本中的改动整合到项目。验收通过、记录和整合都不通知用户：结果由插件附在下一条发给执行者的消息后面（`[magpie-tasks note]` 一行），执行者据此知道改动如何处理。验收不通过时执行者修复：修复后的回答和直接修改的改动直接结束任务，工作副本中修复后的改动等用户确认后整合，同一份修复只保留一个待确认的问题；用户之后再提新的要求，执行者下一次报告完成时重新判断是否验收。用户只在需要决定时收到消息（整合冲突、返工后的改动是否整合）。受阻时做一次独立诊断，必要时更换一次模型；没有匹配规则时先由评估子代理推荐模型并等用户确认。 任务有待用户决定的问题时，用户发给这个任务的话（回复问题那条消息、回复任务的其他消息、Router 转交的消息，包括终端里输入的）只要能读成对问题的回答，插件就直接执行，读不出来时交给执行者。
- **回收与重启。** 日常任务完成或放弃后，它的工作副本连同基线引用被删除（直接修改项目目录的任务没有工作副本，不受影响）：Router 启动时和之后每 15 分钟检查一次，每个 claude-magpie 窗口启动时也检查一次；之后用户再追问，执行者再调用 `open_project`，按项目当前状态重新确定工作目录。长期任务的架构师调用 `notify_user done` 后任务关闭，同一检查在架构师会话空闲满 10 分钟后停止它，下一次检查删除工作副本；用户再发消息时任务重新打开，会话恢复，工作副本按项目当前状态在原路径重建。Router 重启后沿用同一个会话 ID：启动时插件重新载入这个会话以前启动的子代理，使被回复唤醒的子代理照常受路由、写入限制和回合结束处理；仍在进行却已没有子代理在运行的任务视为被重启中断，被中断的验收或诊断自动重新开始，执行者的工作则告诉用户，用户回复后执行者接着做。架构师会话启动和恢复时都带 `CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=1`，不为后台子代理生成进度摘要。
- **其他。** 长期任务的两个子代理在同一个工作目录中修改同一文件时暂停后来的一方并询问（让它在单独的工作副本中继续需要 Git）；路由过的子代理因模型不可用结束时按规则安排替代或询问用户；会话启动时恢复被中断的架构师；Router 每天邀请一次评分，每两周检查一次规则是否需要校准。

## 生效条件与角色

插件在 `session.start` 判定会话角色：

| 角色 | 条件 | 插件的处理 |
| --- | --- | --- |
| `inactive` | `ANTHROPIC_BASE_URL` 不是 Magpie 网关（普通 `claude`），或 `-p` 一次性调用，或安装顺序错误 | 不做任何处理 |
| `router` | 环境变量 `MAGPIE_TASKS_ROLE=router`（`claude-telegram` 设置） | 注册 Router 工具，路由日常任务的子代理，处理对插件消息的回复，定时评分与校准 |
| `architect` | 会话 ID 是某个任务登记的架构师，或接管认领成功的 `/bg` 副本 | 工具限制、子代理路由、Telegram 回复 |
| `bg-unclaimed` | 其他后台会话 | 第一条消息按启动认领决定是否成为架构师 |
| `candidate` | 其余交互式 claude-magpie 会话 | 第一条消息进入长期任务或接管流程 |
| `unmanaged` | 用户自己启动的后台会话、拒绝接管的会话等 | 不做任何处理 |

所有 claude-magpie 后台会话都直接编辑启动目录：插件在合并设置时为带 Magpie 网关的 `flag` 层加上 `worktree.bgIsolation: "none"`。

## 配置项

在 `/plugin` 的插件选项或 `settings.json` 的 `pluginConfigs["magpie-tasks@sipeng-mods"].options` 中设置，`~` 表示主目录：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `gatewayUrl` | `http://127.0.0.1:3425` | Magpie 网关地址 |
| `stateDir` | `~/.config/magpie-tasks` | 任务记录、日志、认领、索引与锁 |
| `worktreeDir` | `~/.local/share/magpie-tasks/worktrees` | 任务工作副本（需要时才建立） |
| `jevUrl`、`jevModel` | `https://api.openai.com/v1/decisions`、`gpt-6-luna` | Jev |
| `jevKeyFile` | `~/.config/jev-opus/openai-jev.key` | Jev 密钥文件；插件只读取，不保存密钥 |
| `jevDeadlineMs` | `10000` | 超过后由评估模型代为判断 |
| `evaluatorModel` | `claude/claude-opus-5-5` | Jev 不可用时代为判断的模型 |
| `launcher`、`claudeBin` | `claude-magpie`、`claude` | 启动与恢复后台会话的命令 |
| `telegramStateDir` | `~/.claude/channels/telegram-live` | 读取机器人令牌（`.env`）与默认聊天（`access.json`） |
| `telegramChatId` | 空 | 从窗口开始的任务的通知聊天；为空时取 `access.json` 中 `allowFrom` 的唯一一项；`tui` 表示只在会话窗口中显示 |
| `timezone`、`ratingHour` | `Asia/Shanghai`、`21` | 每天评分邀请的当地时刻 |

## 记录位置

```
<stateDir>/tasks/<任务 ID>.json         任务记录
<stateDir>/tasks/<任务 ID>.log.jsonl    任务日志（只追加）
<stateDir>/claims/                      待认领记录
<stateDir>/index/telegram.json          Telegram 索引（tg-router 只读，MAGPIE_TASKS_STATE_DIR 指向 stateDir 时读取同一份）
<stateDir>/index/sessions.json          会话 ID 到任务
<stateDir>/state/                       评分、校准、恢复与拒绝接管的状态
<stateDir>/locks/                       跨会话的目录锁
<worktreeDir>/<任务 ID>/                 任务工作副本，只在另一个任务直接修改同一项目时建立；任务完成后连同基线引用一起删除
refs/magpie-tasks/<任务 ID>/base         任务的基线提交（项目仓库中，不在任何分支上）
```

调试日志中插件的行以 `magpie-tasks: ` 开头（`claude --debug-file <路径>`）。

## 安装

```
claude plugin marketplace add ~/sipeng/claude-mods
claude plugin install jev@sipeng-mods --scope user
claude plugin install subagent-opus@sipeng-mods --scope user
claude plugin install magpie-tasks@sipeng-mods --scope user
```

magpie-tasks 必须在 jev 与 subagent-opus 之后安装：同一字段由最内层的插件决定，`claude plugin install` 把新插件放在 `enabledPlugins` 末尾，成为最内层。顺序错误时会话启动显示错误，插件不生效；修正方法是卸载后重新安装 magpie-tasks。Telegram Router 由 `examples/claude-telegram/claude-telegram` 启动。

## 检查

```
claude plugin validate mods/magpie-tasks
claude plugin test mods/magpie-tasks
bunx tsc -p mods/magpie-tasks/tsconfig.json
(cd mods/magpie-tasks/io-tests && bun install) && bunx tsc -p mods/magpie-tasks/io-tests/tsconfig.json
bun test mods/magpie-tasks/io-tests        # 真实文件系统、Git 与 Jev 请求
```

端到端场景脚本在 `e2e/` 中（`e2e/lib.sh` 说明共用的环境）：它们在独立的 `CLAUDE_CONFIG_DIR` 中安装插件并启动真实会话。Jev 规则判定的标注与评分：`bun mods/magpie-tasks/eval/rules-eval.ts extract|sheet|score`。验收判断在已有验收记录上的结果：`bun mods/magpie-tasks/eval/check-eval.ts`。
