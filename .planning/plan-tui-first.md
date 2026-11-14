# magpie-tasks: TUI 为主、Telegram 在人离开窗口时补充

用户主要在 TUI（终端窗口）里和长期任务的架构师对话，通常在 herdr 或 tmux 里同时开几个窗口，各自连着一个会话；Telegram 只偶尔用。用户的决定（2026-11-13）：从窗口开始的长期任务，问题先在窗口里用选项对话框问，在窗口里的回答直接执行；一段时间没人回答，再转发到 Telegram。

## 现状（改动前的代码事实）

- `src/telegram.ts:145-153`：`telegramChatId` 为空时取 `access.json` 的唯一 `allowFrom`，所以窗口任务默认带 Telegram 聊天；`tui` 才只在窗口显示（`src/session.ts:45-50` `telegramReport`）。
- `src/architect.ts` `askPerson`：插件自己的决定（文件冲突 401、整合冲突 501/519/537、诊断次数用完 796）一律经 `telegramReport` 发出，附给架构师的说明写死“The person was asked on Telegram”。结构化回答只从 Telegram 标记 `TELEGRAM_MARK` 解析（`decisionFromTelegram`）；窗口输入只记为 follow-up。
- `src/tools.ts:59,63` 与 `src/session.ts:564` `architectContext`：`integrate`、`notify_user` 的说明和每轮上下文写死 Telegram、纯文本。
- `src/launch.ts:28` `ARCHITECT_ENV` 关闭子代理进度摘要。原因（提交 6633b55）：每个后台子代理约每 30 秒发一次带完整上下文的摘要请求，在 claude-magpie 下每次起一个约 270 MB、存活约 200 秒的 `claude -p`，每个运行中的子代理 1.5 到 1.8 GB。这个原因仍然成立，所以不恢复引擎摘要。
- `src/gate.ts` `readOnlyRefusal`：拒绝任何反斜杠、任何 `>`/`<`、`cd`。
- 插件 API：`$.ui.ask(question, { options, header, multiSelect })` 弹出 AskUserQuestion 对话框，被关闭时 reject，插件无法从自己这边关闭它；`$.ui.notify(text, { title })` 按用户的 `preferredNotifChannel` 发一次系统通知（终端响铃、iTerm2、kitty、ghostty 等）。

## 设计

### 1. 先在窗口问，10 分钟没人回答再发 Telegram

插件无法判断用户是否在看某个窗口：
- 在 herdr 或 tmux 里，每个窗口的 `claude attach` 一直连着。用户看着别的窗口，甚至断开 tmux 或 SSH 离开电脑，进程仍在多路复用器里运行，`$.session.surfaces()` 照样返回 `terminal`。
- 插件 API 没有终端焦点或用户空闲的信号：`session.attach` / `session.detach` 只带 `surface`、`clientId` 和窗口尺寸（`SessionAttachInput`、`SessionDetachInput`）。

所以每个要用户回答的问题先在窗口里问，同时用 `$.ui.notify` 发一次通知，让 tmux 或 herdr 标出是哪个窗口在等（herdr 把出现提问对话框的 agent 标成 `blocked`）；10 分钟内没有回答，再把同一个问题发到 Telegram。渠道选择不使用 `surfaces()`。

### 2. 渠道规则（长期任务）

| 场景 | 处理 |
| --- | --- |
| 插件的决定（文件冲突、整合冲突、诊断次数用完、返工后是否整合） | 立刻在窗口用 `$.ui.ask` 弹出选项对话框并 `$.ui.notify`；10 分钟没回答再发 Telegram。哪边先回答就执行哪边 |
| 架构师自己的问题 | 架构师用 AskUserQuestion。插件在架构师主对话的 `tool.call` `AskUserQuestion` 上接管：自己调用 `$.ui.ask` 弹出同一个对话框并 `$.ui.notify`，10 分钟没回答再发 Telegram，把先到的回答作为工具结果交给模型。`notify_user` 只保留 `result` 和 `done` |
| `notify_user result/done` | 窗口里一行 `ui.log` 加 `$.ui.notify`；之后 10 分钟内用户没有给这个会话发任何消息或回答，再发 Telegram |
| 当前这一轮由 Telegram 消息开始 | 用户此刻在 Telegram 上：本轮的问题和通知立刻同时发到窗口和 Telegram，不等 10 分钟；这一轮的回答照旧发回 Telegram，纯文本 |
| 子代理的模型不可用，规则里没有能接手的模型（`src/unavailable.ts`） | 和插件的决定一样，在架构师窗口弹出对话框，选项“等待”和“改用 <模型>”。选中的那一项原样记为回答，交给架构师安排（和它读 Telegram 回复一样），不折算成同意或不同意 |
| 规则里有接手模型时的通知；架构师这一轮因 API 错误结束；context-memory 归档失败 | 和 `notify_user` 的通知一样：窗口里一行加 `$.ui.notify`，10 分钟内用户没给这个会话发消息再发 Telegram |
| 登记任务或接管会话失败（前台窗口的第一条消息流程，`src/session.ts`） | 只显示在这个窗口：用户刚在这里输入了消息或回答了对话框 |
| 启动恢复发现长期任务无法自动恢复（`src/recovery.ts`，工作目录不存在、git status 失败或整合中断） | 不论哪个会话运行恢复，都恢复这个任务的架构师会话，告诉它中断的情况；“继续 / 暂停”作为任务的决定在它的窗口弹出，和插件的决定一样 10 分钟没回答再发 Telegram。这个决定没有回答之前，插件拒绝这个任务的委派（`model_route` 和 Agent）与 `integrate`，任务保持暂停 |
| 启动恢复遇到在等用户回答（`waiting-user`）、架构师进程已不在的长期任务 | 恢复它的架构师会话，让没有回答的问题回到它的窗口：等待时间已过的立即发 Telegram，没过的按剩余时间计时。任务继续等用户回答 |
| 启动恢复发现架构师会话没有完成认领 | 运行恢复的是 claude-magpie 窗口时只显示在这个窗口（用户刚打开它）；是 Router 时发 Telegram |

上面的规则覆盖插件为长期任务给用户发的每一条消息。Router 自己的消息（Telegram 发来的日常任务的消息、把 Telegram 消息转交长期任务时的说明、评分邀请和校准提醒）不属于长期任务的窗口，照旧走 Telegram。

- `telegramChatId = tui` 保持“从不发 Telegram”的含义；没有 Telegram 聊天的任务只在窗口里等。
- Telegram 先回答时，窗口里的对话框留着（插件关不掉它）；用户之后在对话框里选择或按 Esc，插件不再执行，窗口里一行说明“这个问题已经在 Telegram 上按 X 决定”。Telegram 后到的回答同样只得到这句说明。
- 对话框被关闭（reject）而 Telegram 还没回答：问题保持未回答，计时照旧，窗口里一行说明可以直接打字回答。
- 窗口里打的字，如果能读成对某个未回答决定的回答，插件直接执行（复用日常任务已有的判定 `predicate`/判断逻辑），读不出来时照常交给架构师。
- 计时在架构师会话的进程里；会话重启时，未回答且已超过 10 分钟的问题立即发 Telegram，未满的按剩余时间继续计时（问题的提出时间记在决定上）。

### 3. 给架构师的说明

- `architectContext` 写明：要用户决定的事用 AskUserQuestion 问，插件负责在窗口和 Telegram 之间转发；结果和结论写在回答里，Markdown 可用；整个任务完成或有值得用户回来看的结果时用 `notify_user`。
- `notify_user`、`integrate` 的工具说明改成上面的渠道规则（先窗口，10 分钟后 Telegram）。纯文本、不用 Markdown 的要求只放在 Telegram 来的消息的上下文里（`architect.ts:114` 已有）。
- 插件附给架构师的冲突说明写实际去向（“已在窗口里问，10 分钟没回答会发到 Telegram”或“已在窗口和 Telegram 上问”）。

### 4. 窗口里看得到子代理在做什么

不恢复引擎的进度摘要。插件在每个路由过的子代理的状态行（`src/band.ts` 已画模型、档位、规则、done）上加上：已运行时间、工具调用次数、最近一次工具调用（工具名加一个简短参数，如文件名或命令的第一个词）。这些来自插件已经看到的 `tool.call` 事件，不发模型请求。

### 5. 架构师只读命令白名单放宽无害写法

- `cd <目录> &&` 开头允许（只改工作目录）。
- 只允许 `2>/dev/null` 和 `2>&1` 两种重定向，其余 `>`、`<` 照旧拒绝。
- 单引号内的反斜杠允许（shell 在单引号内不解释反斜杠）；单引号外照旧拒绝。
- 拒绝说明的命令列表同步更新。

## 验证

- 单元测试与 io-tests：每类问题和通知的计时与转发（10 分钟内回答不发 Telegram、超时发出、Telegram 开始的轮次立即发出）、窗口回答执行决定、两边先后回答只执行一次、会话重启后的剩余计时、白名单新放行与仍拒绝的例子（`cd x && rm y` 拒绝在 rm，`> file` 拒绝，`rg '\('` 放行，`rg "\("` 拒绝，`ls 2>/dev/null` 放行）。计时用可注入的时钟（插件已有 `io.now()`），不用假数据。
- 端到端（`e2e/` 现有框架，独立 `CLAUDE_CONFIG_DIR`），在 tmux 窗口里 `claude attach` 真实的后台架构师会话：
  - 触发一次文件冲突，确认对话框弹出、`$.ui.notify` 发出（记下在 tmux 里的效果）、选择后决定执行、没有 Telegram 发送。
  - 架构师调用 AskUserQuestion，确认对话框照常弹出、回答作为工具结果回到模型。
  - 把插件选项 `telegramAfterMinutes`（转发到 Telegram 前等待的分钟数，默认 10，写进 README 的配置表）设成 1，不回答，确认问题走 Telegram 发送路径（测试聊天或检查发送记录），Telegram 回答后决定执行，窗口里的旧对话框再回答只得到说明。
  - 窗口里的状态行截图或 transcript 证明子代理进度可见。
- herdr 是否把 `claude attach` 的窗口识别为 Claude Code 并在对话框出现时标成 `blocked`：在 herdr 里实测一次，结果写进 `.planning/findings.md`。
- README 相应段落更新。
