# magpie-tasks

claude-magpie 会话的长期任务与子代理路由插件。设计依据见仓库的 `.planning/model-routing-implementation.md` 与 `.planning/plan-magpie-tasks.md`。

## 用途

- **长期任务。** 每个交互式 `claude-magpie` 新窗口的第一条消息登记为一个长期任务：Jev 推荐架构师模型（Opus 5.5、Astra 或 Sol 6.1），用户在确认对话中选定后，插件为项目建立 Git 工作副本（不是仓库时先建立仓库并提交一份基线快照），以 `claude-magpie --bg` 启动架构师后台会话，前台窗口随即结束，`claude attach <id>` 可以重新打开。用 `claude-magpie --resume` 恢复一个没有登记的已有会话时，插件询问一次是否接管为长期任务。
- **架构师的限制。** 架构师留在项目主目录，只能写 `.planning/findings.md`、`CONTEXT.md`、`.planning/plan-*.md` 与 `.planning/*.html`，Bash 只能运行只读命令和 html-plan 的打包、发布命令；实施交给子代理，它们在任务工作副本中修改。架构师有 `task_status`、`report_outcome`、`integrate`、`notify_user`、`resolve_conflict` 五个工具；`integrate` 把工作副本的改动应用到项目主目录的工作区，不做提交。
- **子代理路由。** 架构师与 Telegram Router 启动的每个子代理按 `rules/routing-rules.json` 的 19 条规则选择模型：Jev 判断适用的规则和是否需要深入推理，插件设置模型与每一步的思考强度（续接、验收不通过、诊断后重新委派时提高）。指定模型的委派必须写 `[model-reason user: …]` 或 `[model-reason evidence: …]`。子代理说明的第一行是任务标记 `[magpie-tasks task=…]`，JEV 据此跳过这些子代理。
- **日常任务。** Router 派发的 Telegram 或终端任务登记为日常任务：执行者完成后由验收子代理检查，通过后整合到项目；受阻时做一次独立诊断，必要时更换一次模型；没有匹配规则时先由评估子代理推荐模型并等用户确认。
- **其他。** 同一工作副本中两个子代理修改同一文件时暂停后来的一方并询问；路由过的子代理因模型不可用结束时按规则安排替代或询问用户；会话启动时恢复被中断的架构师；Router 每天邀请一次评分，每两周检查一次规则是否需要校准。

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
| `worktreeDir` | `~/.local/share/magpie-tasks/worktrees` | 任务工作副本 |
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
<worktreeDir>/<任务 ID>/                 任务工作副本（基线提交只挂在 refs/magpie-tasks/ 下，不在任何分支上）
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

端到端场景脚本在 `e2e/` 中（`e2e/lib.sh` 说明共用的环境）：它们在独立的 `CLAUDE_CONFIG_DIR` 中安装插件并启动真实会话。Jev 规则判定的标注与评分：`bun mods/magpie-tasks/eval/rules-eval.ts extract|sheet|score`。
