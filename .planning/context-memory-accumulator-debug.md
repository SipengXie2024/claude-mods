# accumulator 上下文交接失败排查

日期：2026-11-07。
任务范围：修复用户报告的 context-memory 压缩失败；原 accumulator 会话只读，复现使用分叉会话和独立数据库。

## 已确认

- 原会话：`7d34dd6d-2a70-4f34-8a16-74f39b46d5d2`，名称 accumulator，目录 `/home/ubuntu/sipeng/blockchain-catchup`。
- 2026-11-07 13:17:53 UTC 手动压缩返回通用失败提示。
- 原插件数据库已保存检查点 `94a8cc97e40399668a5e69d6fcd043e1`，881 条输入；没有 handoff。同步成功，无不完整末行。
- 真实输入快照 5,461,165 字节；正文与工具结果渲染共 1,938,364 字符。当前整理算法得到 59 段，首段 19,738 字符。
- 原会话进程 1242465 使用 Claude Code 2.1.319，启动环境没有 Anthropic API 密钥或网关地址；全局 settings 中 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`。
- 在独立分叉 `e2254f2b-10ad-4860-a166-712ac803b366` 复现：归档成功，首个 `$.model.complete` 请求收到 HTTP 429、`rate_limit_error`、消息 `Error`；原生压缩没有执行。
- 复现日志：`/tmp/context-memory-accumulator-bmrhfo1e/debug.log`。原始会话没有被此复现修改。

## 对照依据

`mods/jev/hooks/register.tsx:711` 把 Claude Code 身份说明放在独立的第一个 system block，再放任务规则；`mods/jev/src/recap.ts:25` 记录了关闭 attribution header 时订阅请求对该身份说明的要求。

context-memory 把身份说明和所有规则合在一个字符串中。当前对照试验仅改变 system block 的分组，使用 accumulator 原始首段输入、同一账号、同一 Opus 模型及相同请求参数。

## 验证状态

- 隔离复现：HTTP 429 已确认。
- 对照结果：合并 system 文本返回 HTTP 429；身份说明独立成块成功（输入 11319 tokens，输出 2512 tokens，正文 3415 字符）；再次合并仍返回 HTTP 429，且没有模型用量。
- 根因：当前直接订阅及 `CLAUDE_CODE_ATTRIBUTION_HEADER=0` 配置要求独立的 Claude Code 身份说明块。context-memory 将身份说明与任务规则合并，服务端拒绝该格式。
- 修复：`NOTES_SYSTEM` 使用两个独立文本块；API 失败信息保留 HTTP 状态及错误类型，并显示在压缩失败提示中。
- 回归：真实响应驱动的请求检查先出现 2 个失败，修复后与既有核心检查合计 12 项通过；严格类型检查通过。
- 真实直接订阅验证：会话 `6fe09413-4b2a-41d8-9d81-f77d9eff0f68` 完成普通读取、交接整理、手动压缩、关闭后 resume、history_search/read，未出现 context-memory hook 错误。输出 `/tmp/context-memory-accumulator-bmrhfo1e/verified/`。
- accumulator 原会话未由本次修复执行压缩；验证包含其真实第一段请求，完整 881 条内容没有在修复后重跑。
