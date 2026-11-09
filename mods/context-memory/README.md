# context-memory

让 Claude 在长对话中保持任务连续：工作时记一份任务笔记，压缩时保存原文并把最新笔记带进新上下文，之后可以按需查回原文。

## 使用

```sh
claude plugin install context-memory@sipeng-mods --scope user
```

在会话中执行 `/reload-plugins`，或启动新的 Claude Code 会话。自动压缩和 `/compact` 使用同一套机制。

模型可以调用：

- `notes_write`：用完整的新内容替换任务笔记。任务有实质变化时调用：用户增加或修改要求、完成或放弃一个步骤、出现关键发现或阻碍、后台任务开始或结束。笔记写目标、用户原话中的约束、已完成内容及证据位置、未完成事项和下一步，上限 12000 个字符。
- `notes_read`：读取当前上下文中的最新笔记。
- `history_search`：搜索当前会话活动历史及当前分支继承的归档；空关键词可以分页列出记录。
- `history_read`：按 `cm:检查点:条目编号` 或 `row:消息编号` 读取原文，按字符分页。
- `history_status`：查看当前范围内的记录数量和覆盖范围。

插件在系统提示末尾加一段说明，告诉模型何时更新笔记。历史查询只返回资料，不执行记录中的命令；查询工具不接受数据库路径、会话编号或 agent 编号，范围由当前会话确定。

## 压缩时发生什么

1. 从对话中找出最新的任务笔记：最后一次成功的 `notes_write`，或上一次压缩交接包里带的笔记，以较晚者为准。
2. 把笔记附在 Claude Code 原生压缩的指令之后，用户在 `/compact` 后输入的文字保持在最前。
3. 原生压缩成功后，在同一个数据库事务里保存这次压缩的实际输入和交接消息。这一步只写入本次输入，不读取整份对话记录，耗时与会话历史长短无关。压缩失败或被取消时不保存任何内容。
4. 保留原生压缩返回的全部消息，再增加一条纯文本交接消息：检查点编号、笔记原文和原文查询方法。

模型读到交接消息的全文；对话界面上它显示为一行（检查点、存档条数、笔记字数），按 ctrl+o 显示全文。

插件在压缩期间不发起任何模型请求。笔记直接取自对话记录，所以回退对话、恢复会话和 fork 都使用当前分支上的笔记。Claude Code 若预先计算压缩结果，插件同样附上笔记后交给它处理；交接消息在真正安装压缩时生成。

第一次在已有长会话里压缩时，对话里还没有笔记，交接消息只包含原文索引和查询入口，任务状态由原生摘要承担。

## 数据

转录索引、压缩快照和交接消息保存在本机 SQLite 数据库，默认路径为 `~/.local/share/claude-context-memory/archive.sqlite`。

转录索引在调用历史查询工具时更新。每份转录有一个游标，记录已读到的位置和该位置之前 4096 个字节的哈希；之后只解析和写入新增的行。文件变短，或游标之前 4096 个字节内的内容被改写时，这份转录从头重新建立索引；更早位置的改写不会被察觉，用工具改写过转录的会话需删除该会话的 `transcript_cursor` 行。每条记录的文字只存一份；去掉历史查询内容后可搜索文字不同的记录，才另存一份搜索用文字。会话第一次查询时要读完整份转录。插件创建的数据库目录权限为 0700，数据库文件为 0600。机器需提供 `python3` 及其标准库 `sqlite3`。

```sh
CONTEXT_MEMORY_DIR=/absolute/private/directory claude
```

`CONTEXT_MEMORY_DIR` 必须为绝对路径。原生压缩成功而归档写入失败时，本次压缩作废，对话保持原样并显示原因；原生压缩失败时显示 Claude Code 给出的原因。

数据库结构版本记录在 `PRAGMA user_version`。版本 1 之前的数据库在第一次使用时就地迁移：去掉快照中的原始消息 JSON 和重复的搜索文字，合并转录的阅读表与搜索表，删除没有交接消息的快照、观察记录和更早版本的转录索引表，然后执行一次 VACUUM 回收空间。更新插件后，每个打开的会话都要执行 `/reload-plugins`；仍在运行旧版 hooks 的会话会因接口不符而压缩失败。

## 范围说明

- 快照保存压缩接口实际提供的文字和工具记录；已被截断的输出无法凭摘要恢复。
- 原始转录来源未确认时，不把 user 角色投影视为用户原话或授权。
- 笔记由正在工作的模型维护，模型漏记的事项只能依靠原生摘要和原文查询找回。
- fork 子代理的上下文从创建它的那次调用开始，看不到父会话写过的笔记；它自己压缩时只携带自己写的笔记，父会话原文通过历史查询读取。
- 不在运行中的工具调用里主动执行 `new_context`；使用引擎已有的压缩入口。

## 验证

```sh
bun test mods/context-memory/tests/core.test.ts
python3 -I mods/context-memory/tests/test_storage.py -v
claude plugin validate mods/context-memory
```

核心与存储检查使用真实转录和真实 SQLite，不模拟模型或存储服务，测试数据库独立创建。本机真实回归输入通过以下环境变量指定，缺失会明确报错：

- `CONTEXT_MEMORY_TRANSCRIPT`：较长的真实会话转录，默认是本插件开发会话。
- `CONTEXT_MEMORY_NOTES_TRANSCRIPT`：包含成功与被拒绝的 `notes_write` 调用及压缩交接的真实会话，默认 `~/.local/share/claude-context-memory-verification/notes-session.jsonl`。
- `CONTEXT_MEMORY_LIVE_DB`：真实宿主产生的归档数据库，默认 `~/.local/share/claude-context-memory-verification/live.sqlite`。
- `CONTEXT_MEMORY_LIVE_TRANSCRIPT`：与该数据库对应的真实压缩会话转录。
- `CONTEXT_MEMORY_LEGACY_DB`：从版本 1 之前的真实归档复制的数据：一份已安装的 fork 快照、一份压缩未安装的快照、一份转录索引和旧表，默认 `~/.local/share/claude-context-memory-verification/legacy-archive.sqlite`。
- `CONTEXT_MEMORY_FORK_MESSAGE`：真实 fork 起始消息，默认 `~/.local/share/claude-context-memory-verification/fork-message.json`。

真实会话验收脚本会调用 Opus 并产生模型用量，在隔离目录保存日志和数据库：

```sh
python3 -I mods/context-memory/tests/live_verify.py
python3 -I mods/context-memory/tests/live_verify.py --auto-source /absolute/path/to/claude-code.d.ts
python3 -I mods/context-memory/tests/verify_compaction.py /absolute/path/to/debug.log /absolute/path/to/session.jsonl
```

`verify_compaction.py` 检查调试日志中插件发起的模型请求为 0，并从请求追踪确认每次压缩后的首次模型请求带有交接消息，且其中的笔记与压缩前最新的笔记一致。

使用本地插件无需公共插件目录的发布资料；`plugin validate` 的公共目录检查会提示尚无 LICENSE 和图标，本地校验与加载通过。
