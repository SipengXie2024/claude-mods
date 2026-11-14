# magpie-tasks

claude-magpie 会话的长期任务与子代理路由插件。设计依据见仓库的 `.planning/model-routing-implementation.md` 与 `.planning/plan-magpie-tasks.md`。

## 用途

- **长期任务。** 每个交互式 `claude-magpie` 新窗口的第一条消息登记为一个长期任务：Jev 推荐架构师模型（Opus 5.5、Astra 或 Sol 6.1），用户在确认对话中选定后，插件确定任务的工作目录（见下面的“工作目录”），以 `claude-magpie --bg` 启动架构师后台会话，窗口随即切换到这个后台会话，继续显示架构师的工作并接收输入；离开窗口（`←`、`/exit` 或关闭终端）后任务仍在后台运行，`claude attach <id>` 重新打开。用 `claude-magpie --resume` 恢复一个没有登记的已有会话时，插件询问一次是否接管为长期任务；接管后的会话在本轮回答结束时转入后台，窗口同样切换过去。窗口的切换由启动脚本 `bin/claude-magpie` 完成（见“安装”）；用 Magpie 自带的 `claude-magpie` 启动时，前台窗口在登记后结束，用 `claude attach <id>` 重新打开。
- **工作目录。** 任务第一次修改某个项目时，插件确定它在哪里修改。没有其他进行中的任务在直接修改这个项目时，任务直接修改项目目录本身；在 Git 仓库中，插件为当时的目录内容做一个基线提交（挂在 `refs/magpie-tasks/` 下，不在任何分支上，也不动用户的暂存区），用它区分这个任务的改动。已有任务在直接修改同一个项目时，后来的任务得到一份 Git 工作副本，结果验收后再应用到项目。不是 Git 仓库的目录总是直接修改，插件不建立仓库，只记录子代理用文件工具改过的文件。一个已结束的直接修改任务被后续消息恢复时，如果项目已被另一个任务直接修改，它先转到一份工作副本。
- **架构师的限制。** 架构师留在项目主目录，只能写 `.planning/findings.md`、`CONTEXT.md`、`.planning/plan-*.md` 与 `.planning/*.html`，Bash 只能运行只读命令、html-plan 的打包和发布命令，以及在项目主目录直接运行的 `git add`、`git commit`、`git push`（不带 `-C` 和 `-c`，也不跟在 `cd` 后面）；实施交给子代理，它们在任务的工作目录中修改。只读命令可以用 `&&`、`||`、`;`、`|` 连接，开头可以有一个 `cd <目录> &&`；重定向只接受 `2>/dev/null` 和 `2>&1`，反斜杠只能出现在单引号内（如 `rg '\('`），命令替换一律拒绝。架构师有 `model_route`、`task_status`、`report_outcome`、`integrate`、`notify_user`、`resolve_conflict` 六个工具；`integrate` 把工作副本的改动应用到项目主目录的工作区，直接修改的任务则把已在项目目录里的改动记为结果，都不做提交。`notify_user` 分两种：`result` 报告完成的一部分，`done` 表示整个任务完成，任务随即关闭；要用户决定的事，架构师用 AskUserQuestion 提问。
- **窗口与 Telegram。** 长期任务的问题和通知先到架构师的窗口，Telegram 在没有人回答时补上。插件无法判断有没有人在看某个窗口（herdr 或 tmux 里的 `claude attach` 一直连着，`$.session.surfaces()` 始终返回 `terminal`），所以按时间处理：插件自己的问题（文件冲突、整合冲突、同一个阻碍的诊断或模型更换次数用完、返工后的改动是否整合、子代理的模型不可用而规则里没有能接手的模型、启动恢复无法按原样恢复的任务是否继续）立刻在窗口里弹出选项对话框，并发一次系统通知；`telegramAfterMinutes` 分钟（默认 10）内没有回答，同一个问题再发到 Telegram。哪一边先回答就执行哪一边的回答，另一边之后的回答只得到一行“这个问题已经在 Telegram 上（或在窗口里）按某个选项决定”的说明；窗口里的对话框插件关不掉，Telegram 先回答后它留在原处，之后在里面选择或按 Esc 都只得到这行说明。对话框被关闭而问题还没有回答时，问题保持未回答、计时照旧，直接在窗口里打字回答即可：窗口里输入的话能读成对未回答问题的回答时，插件直接执行，读不出来时照常交给架构师。架构师调用 AskUserQuestion 时由插件接管：对话框照常出现在窗口里，超时后问题发到 Telegram，先到的回答作为工具结果交给架构师；在窗口里关闭对话框视为用户不回答。`notify_user` 的内容在窗口里显示一行并发一次系统通知，之后 `telegramAfterMinutes` 分钟内用户没有给这个会话发任何消息或回答，再发到 Telegram；插件自己的通知也这样发出：规则里有接手模型时子代理模型不可用的通知、架构师这一轮因 API 错误结束、context-memory 归档失败，以及架构师会话里长期任务流程出错的报告。登记任务或接管会话失败（前台窗口的第一条消息流程）只显示在那个窗口里，不发 Telegram。由 Telegram 消息开始的一轮里，问题和通知立刻同时发到窗口和 Telegram，这一轮的回答照旧以纯文本发回 Telegram。问题的提出时间记在任务记录里：架构师会话重启后，未回答的问题重新在窗口里弹出，已经超过等待时间的立即发到 Telegram，其余按剩余时间继续计时。`telegramChatId` 为 `tui` 的任务从不发 Telegram。
- **提交与推送。** 用户要求时，架构师和执行任务的工作者在项目主目录提交和推送；任务工作副本里的提交是插件的快照，带有用户未提交的文件，所以从不在工作副本里提交或推送。直接修改项目目录的工作者，改动随时可以提交；在工作副本中的改动要等回合结束、插件整合到主目录之后才能提交，用户再说一次即可；工作者从下一条消息后的说明行得知结果如何处理。验收和诊断的工作者只检查，不提交。
- **子代理路由。** 架构师用 `model_route` 委派（子代理在这次调用返回之后、架构师的下一次请求之前启动，所以它的每次工具调用都经过插件的写入范围检查和文件冲突检查），架构师与 Telegram Router 启动的每个子代理按 `rules/routing-rules.json` 的 19 条规则选择模型：Jev 判断适用的规则和是否需要深入推理（它读到发起委派的那段对话、委派说明里提到的文件和委派说明本身），插件设置模型与每一步的思考强度（续接、验收不通过、诊断后重新委派时提高；模型 ID 末尾带档位的模型，如 `hakimi/gemini-4-carbon-medium`，始终按那一档运行）；Jev 在两条用不同模型的规则之间拿不准时，从 Mythos 5.2、Carbon、Opus 5.5、Astra 中随机选一个，评分用来比较它们。指定模型的委派必须写 `[model-reason user: …]` 或 `[model-reason evidence: …]`。子代理说明的第一行是任务标记 `[magpie-tasks task=…]`，JEV 据此跳过这些子代理。
- **日常任务。** Router 派发的 Telegram 或终端任务登记为日常任务：执行者每完成一轮，Jev 判断这一轮的成果是否值得独立检查（依据用户这一轮的话、回答、工具调用次数和改动统计）；对话式的回答、交还和一两行的机械修改不验收，其余由验收子代理检查一次。用户叫执行者停下或不必再做剩下的部分时，执行者以 `状态：已停止` 结束回答：这个回答就是结果，不验收，改动按结果处理。是否验收的判断和验收针对开始时的那份结果，诊断针对开始时的那次受阻报告；它们结束前执行者又开始干活（用户给它发了消息、叫停或中断了它，或者换了执行者），判断结果、验收结论或诊断建议只留在任务记录和日志里，不发起验收，不唤醒执行者，不询问用户，也不整合。验收子代理按 `review` 规则检查，模型取每周额度剩余比例最高的订阅中审查最合适的模型（规则文件的 `acceptance` 一节：Claude 订阅用 Opus 5.5，Codex 订阅用 Sol 6.1；某个限制窗口已经用完的订阅排在最后，比例相同时按列出的顺序），每次开始验收时从 Magpie 的 `/v1/magpie/quotas` 读取额度。验收子代理和诊断子代理只以第一次带结论行的回答为结论；之后其他代理用 SendMessage 发给它的消息和它的回答只记入任务日志，结论不变。直接修改的改动已经在项目目录里，验收在改完之后进行，结束时插件把改动记为结果；工作副本中的改动整合到项目。验收通过、记录和整合都不通知用户：结果由插件附在下一条发给执行者的消息后面（`[magpie-tasks note]` 一行），执行者据此知道改动如何处理。验收不通过时执行者修复：修复后的回答和直接修改的改动直接结束任务，工作副本中修复后的改动等用户确认后整合，同一份修复只保留一个待确认的问题；用户之后再提新的要求，执行者下一次报告完成时重新判断是否验收。用户只在需要决定时收到消息（整合冲突、返工后的改动是否整合）。受阻时做一次独立诊断，必要时更换一次模型。没有规则适用的请求按 `daily-default` 规则的模型运行，不做评估；路由无法决定时（例如请求指定了一个没有规则给出思考强度的模型，或者规则选中的模型不在 Magpie 的模型列表里），先由评估子代理推荐模型并等用户确认。任务有待用户决定的问题时，用户发给这个任务的话（回复问题那条消息、回复任务的其他消息、Router 转交的消息，包括终端里输入的）只要能读成对问题的回答，插件就直接执行，读不出来时交给执行者。
- **回收与重启。** 日常任务完成或放弃后，它的工作副本连同基线引用被删除（直接修改项目目录的任务没有工作副本，不受影响）：Router 启动时和之后每 15 分钟检查一次，每个 claude-magpie 窗口启动时也检查一次；之后用户再追问，执行者再调用 `open_project`，按项目当前状态重新确定工作目录。长期任务的架构师调用 `notify_user done` 后任务关闭，同一检查在架构师会话空闲满 10 分钟后停止它，下一次检查删除工作副本；用户再发消息时任务重新打开，会话恢复，工作副本按项目当前状态在原路径重建。Router 重启后沿用同一个会话 ID：启动时插件重新载入这个会话以前启动的子代理，使被回复唤醒的子代理照常受路由、写入限制和回合结束处理；仍在进行却已没有子代理在运行的任务视为被重启中断：被中断的验收或诊断自动重新开始；叫停的结果和判断为不需验收的结果，整合被中断时自动整合完；执行者的工作，以及执行者在结果或受阻报告之后又开始干活时被中断的验收或诊断，则告诉用户，用户回复后执行者接着做。架构师会话启动和恢复时都带 `CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=1`，不为后台子代理生成进度摘要。子代理在做什么由插件显示：打开一个路由过的子代理的视图时，输入框上方的状态行除了模型、思考强度和规则，还有这次运行已用的时间、工具调用次数和最近一次工具调用（如 `Sonnet 5.5 · ◆ magpie-tasks · MAX · machine-ops · 1m02s · 3 tools · Bash python3`），数据来自插件看到的工具调用，不发模型请求。
- **其他代理的状态。** 子代理启动时，会话提醒里有一份能通过 SendMessage 联系的代理名单，早已交了回答的代理也在其中。子代理的回答要说别的任务、工作者或验收正在运行、已经结束或会被重启打断之前，先调用 `session_agents`：它按调用那一刻的状态列出会话里其他每个代理是否在运行，以及它所属的任务和上一次回答的结束状态。没有调用就不写这类话。Router 和架构师的主对话也能调用这个工具。
- **多个项目。** 一个任务可以修改多个项目：子代理每要修改一个项目，就对它调用一次 `open_project`，插件按上面“工作目录”的规则为这个项目单独确定在哪里修改，之前打开的项目继续可写；长期任务的第一个项目是架构师所在的项目。同一个任务的 `open_project` 调用逐个处理，子代理并行打开几个项目时，每个项目各占一项登记。子代理只能写任务已打开项目的工作目录和 Git 仓库之外的路径：写到某个工作副本对应的项目主目录时，拒绝理由指向副本；写到还没有打开的仓库时，拒绝理由要求先对它调用 `open_project`。只做检查的子代理（验收、诊断）不能为任务打开新项目。改动、补丁、验收和整合都按项目进行：验收说明逐个项目列出改动和补丁文件；架构师的 `integrate` 和日常任务结束时的整合逐个项目处理，某个项目与当前文件冲突时其余项目照常处理，用户收到的问题只涉及冲突的项目。任务结束后各项目的工作副本连同基线引用被删除，项目仍记在任务上；之后要修改哪个项目，就再对它调用 `open_project`（重新打开的长期任务，第一个项目的工作副本在原路径重建）。任务的第二个及以后的项目，工作副本在 `<任务 ID>-p<序号>`，基线引用在 `refs/magpie-tasks/<任务 ID>/p<序号>/base`。
- **模型不可用。** 路由过的子代理因模型不可用（Magpie 已经重试并换过账号）结束时，规则里有能接手的模型就由它接手：日常任务直接换上，长期任务由架构师按插件给的建议安排，用户收到一条通知。没有能接手的模型、或者模型是用户自己指定的，就问用户：选项是“等待”和每个“改用 <模型>”。长期任务的这个问题和插件的其他问题一样先在架构师窗口里弹出对话框；用户选中的那一项（第几项都一样，在对话框的“其他”里写的话也算）原样记为回答，交给架构师安排，不折算成同意或不同意。窗口里打的字能读成其中一个选项时按那一项处理，读不出来时交给架构师；Telegram 上的回复也作为回答，两边先到的那个生效。
- **启动恢复。** 每个 claude-magpie 窗口和 Router 启动时检查一次（10 分钟内只运行一次）：架构师进程已不在的长期任务，恢复它的架构师会话（沿用原会话 ID）。在等用户回答的任务恢复后，没有回答的问题回到它的窗口，等待时间已过的立即发 Telegram，其余按剩余时间计时，任务继续等用户。工作目录不存在、git status 失败或有一次整合开始后没有完成记录的任务，架构师会话同样被恢复，并被告知中断的情况；“继续 / 暂停”作为任务的决定在它的窗口里问，和插件的其他问题一样计时。这个决定没有回答之前，插件拒绝这个任务的委派（`model_route` 和架构师的 Agent 工具）与 `integrate`，拒绝理由写明是哪个决定；“继续”之后任务接着运行，“暂停”之后任务保持暂停。Router 无法把 Telegram 消息交给架构师时记下的同类决定由 Router 在 Telegram 上问，回答之前同样拒绝委派和整合。架构师会话启动后没有完成认领的任务标为出错：运行恢复的是 claude-magpie 窗口时这件事只显示在那个窗口里，是 Router 时发 Telegram。
- **其他。** 长期任务的两个子代理在同一个工作目录中修改同一文件时暂停后来的一方并询问（先在窗口里问，见“窗口与 Telegram”；让它在单独的工作副本中继续需要 Git；单独副本只复制任务的第一个工作目录，其他项目里的文件冲突只能等前一方完成）；Router 每天邀请一次评分，每两周检查一次规则是否需要校准。

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
| `telegramAfterMinutes` | `10` | 长期任务的问题和通知在窗口里等待多少分钟没有回答后再发到 Telegram |
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

把 [`bin/claude-magpie`](bin/claude-magpie) 复制到 `PATH` 中的目录（如 `~/.local/bin/`），替换 `magpie claude launcher add` 生成的同名脚本。它在终端里启动 `magpie claude run` 时给窗口一个交接文件（环境变量 `MAGPIE_TASKS_HANDOFF`）：插件把长期任务后台会话的短 ID 写进去，前台会话结束后脚本在同一个终端执行 `claude attach <短 ID>`。没有终端的调用（`-p`、插件自己的 `--bg` 启动）与 `magpie claude run` 完全相同。再次运行 `magpie claude launcher add` 会把它换回 Magpie 自带的脚本，需要重新复制。

## 检查

```
claude plugin validate mods/magpie-tasks
claude plugin test mods/magpie-tasks
bunx tsc -p mods/magpie-tasks/tsconfig.json
(cd mods/magpie-tasks/io-tests && bun install) && bunx tsc -p mods/magpie-tasks/io-tests/tsconfig.json
bun test mods/magpie-tasks/io-tests        # 真实文件系统、Git 与 Jev 请求
```

端到端场景脚本在 `e2e/` 中（`e2e/lib.sh` 说明共用的环境）：它们在独立的 `CLAUDE_CONFIG_DIR` 中安装插件并启动真实会话。`e2e/e20-window-first.sh`（文件冲突和架构师自己的问题）、`e2e/e21-unavailable-window.sh`（模型不可用的问题）和 `e2e/e22-recovery-window.sh`（启动恢复把架构师和它的问题带回窗口，中断的任务在回答前拒绝委派）检查窗口优先的提问，接在 E3 之后运行，用 `e2e/setup.sh --forward` 建立环境：任务的 Telegram 聊天是 `1`、机器人令牌是 Telegram 拒绝的令牌、等待时间是 1 分钟，所以发往 Telegram 的请求是真实的，但到不了任何人，Telegram 回答 401；`e2e/peer-send` 是场景用的小插件，按 Router 转交 Telegram 消息的方式给架构师会话发消息。Jev 规则判定的标注与评分：`bun mods/magpie-tasks/eval/rules-eval.ts extract|sheet|score`。验收判断在已有验收记录上的结果：`bun mods/magpie-tasks/eval/check-eval.ts`。
