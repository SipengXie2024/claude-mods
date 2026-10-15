import { describe, expect, test } from 'claude-code/testing'
import { describeTool, parseChannelTag, redact, renderFinal, renderLive, type Turn } from '../src/card'

const turn = (o: Partial<Turn> = {}): Turn => ({
  chatId: '1', startedAt: 0, tools: 0, recent: [], dirty: false, lastEditAt: 0, done: false, ...o,
})

describe('channel tag', () => {
  test('reads chat_id and message_id', () => {
    const text = '<channel source="plugin:telegram:telegram" chat_id="7051661301" message_id="878" user="V" ts="x">\nhi\n</channel>'
    expect(parseChannelTag(text)).toEqual({ chatId: '7051661301', messageId: 878 })
  })
  test('a tag without chat_id gives null', () => {
    expect(parseChannelTag('<channel source="plugin:telegram:telegram">hi</channel>')).toBe(null)
    expect(parseChannelTag('plain prompt')).toBe(null)
  })
})

describe('tool labels', () => {
  test('Bash shows the description, never the command', () => {
    const label = describeTool({ tool: 'Bash', command: 'curl -H "Authorization: Bearer abc" https://x', description: '拉取接口' })
    expect(label).toBe('Bash · 拉取接口')
    expect(label).not.toContain('curl')
  })
  test('file tools show the file name only', () => {
    expect(describeTool({ tool: 'Edit', file_path: '/home/ubuntu/secret/dir/parser.rs' })).toBe('Edit parser.rs')
  })
  test('MCP tools show the name only', () => {
    expect(describeTool({ tool: 'mcp__x__send', text: 'private' })).toBe('mcp__x__send')
  })
})

describe('redact', () => {
  test('hides key shapes', () => {
    const s = redact('a sk-ant-api03-abcdefghijk b ghp_0123456789abcdef c Bearer xyz.123 d API_KEY=hunter2 e')
    expect(s).not.toContain('abcdefghijk')
    expect(s).not.toContain('0123456789abcdef')
    expect(s).not.toContain('xyz.123')
    expect(s).not.toContain('hunter2')
    expect(s).toContain('API_KEY=***')
  })
  test('hides a long random string, keeps normal words', () => {
    const s = redact('运行测试 token 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc')
    expect(s).toContain('运行测试')
    expect(s).not.toContain('9f8e7d6c5b4a')
  })
})

describe('card text', () => {
  test('live card: elapsed, count, current and recent', () => {
    const t = turn({ tools: 23, current: { label: 'Bash · 运行测试', since: 212_000 }, recent: ['Read a.rs ✓', 'Edit a.rs ✓'] })
    expect(renderLive(t, 252_000)).toBe('🔄 已跑 4 分 12 秒 · 23 个工具\n当前：Bash · 运行测试（已 40 秒）\n最近：Read a.rs ✓ · Edit a.rs ✓')
  })
  test('final lines for each end', () => {
    const t = turn({ tools: 53, recent: ['Bash · 跑测试 ✗'] })
    expect(renderFinal(t, 'answer', 843_000)).toBe('✅ 完成 · 14 分 3 秒 · 53 个工具')
    expect(renderFinal(t, 'aborted', 360_000)).toBe('⚠️ 被中断 · 6 分 · 最后在：Bash · 跑测试')
    expect(renderFinal(t, 'error', 160_000)).toBe('❌ 出错 · 2 分 40 秒 · API error · 最后在：Bash · 跑测试')
  })
})
