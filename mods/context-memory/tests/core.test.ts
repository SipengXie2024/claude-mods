import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildHandoff, checkpointRoots, compactionInstructions, handoffLine, latestNotes, newCheckpointId, noteProblem, NOTES_LIMIT, NOTES_TOOL, project } from '../src/core'

// The input is the actual conversation in which this plugin was requested.
const source = process.env.CONTEXT_MEMORY_TRANSCRIPT ?? '/home/ubuntu/.claude/projects/-home-ubuntu-sipeng-re-test/e84c9c29-5d2e-444c-b954-11c546adedaa.jsonl'
const verification = `${process.env.HOME}/.local/share/claude-context-memory-verification`

function sessionMessages(path: string) {
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const results = new Map<string, { text: string; isError?: true }>()
  for (const r of rows) {
    if (r.type !== 'user' || !Array.isArray(r.message?.content)) continue
    for (const b of r.message.content) {
      if (b.type === 'tool_result') results.set(b.tool_use_id, { text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), ...(b.is_error ? { isError: true as const } : {}) })
    }
  }
  return { rows, messages: rows.filter(r => ['user', 'assistant'].includes(r.type) && r.message?.content).map(r => ({
    role: r.type as 'user' | 'assistant',
    text: typeof r.message.content === 'string' ? r.message.content : r.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'),
    toolUses: (Array.isArray(r.message.content) ? r.message.content : []).filter((b: any) => b.type === 'tool_use').map((b: any) => ({ tool_use_id: b.id, tool: b.name, input: b.input, ...results.get(b.id) })),
    toolResults: (Array.isArray(r.message.content) ? r.message.content : []).filter((b: any) => b.type === 'tool_result').map((b: any) => ({ tool_use_id: b.tool_use_id, text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), isError: b.is_error })),
    handle: r.uuid,
  })) }
}

const { rows, messages: all } = sessionMessages(source)
const messages = all.slice(0, 30)
const checkpoint = rows.find(r => typeof r.uuid === 'string').uuid.replaceAll('-', '').slice(0, 32)
const actualText = messages.find(m => m.text.trim() && m.text.length < 2000)!.text

describe('real conversation projection', () => {
  test('archives text and tool records without retaining engine handles or mutating source', () => {
    expect(messages.length).toBeGreaterThan(0)
    const before = JSON.stringify(messages)
    const result = project(messages)
    expect(result[0].text).toBe(messages[0].text)
    expect(result.every(m => !('handle' in m))).toBe(true)
    expect(JSON.stringify(messages)).toBe(before)
    expect(result.map(m => m.toolUses)).toEqual(messages.map(m => m.toolUses))
  })

  test('a handoff carries its marker and the task note verbatim, with no replayed tools', () => {
    const handoff = buildHandoff(checkpoint, messages.length, actualText, [])
    expect(checkpointRoots([handoff])).toEqual([checkpoint])
    expect(latestNotes([handoff])).toBe(actualText)
    expect(handoff.toolUses).toEqual([])
    expect(handoff.role).toBe('user')
    expect('handle' in handoff).toBe(false)
    expect(latestNotes([buildHandoff(checkpoint, messages.length, null, [])])).toBeNull()
    expect(checkpointRoots(messages)).toEqual([])
  })

  test('a handoff is drawn as one line naming its checkpoint, count and note', () => {
    const id = newCheckpointId()
    expect(id).toMatch(/^[a-f0-9]{32}$/)
    expect(newCheckpointId()).not.toBe(id)
    const line = handoffLine(buildHandoff(id, messages.length, actualText, []).text)!
    expect(line).toContain(id.slice(0, 8))
    expect(line).toContain(`${messages.length} 条记录`)
    expect(line).toContain(`笔记 ${actualText.length} 字`)
    expect(line).not.toContain('\n')
    expect(handoffLine(buildHandoff(id, 3, null, []).text)).toContain('没有任务笔记')
    expect(handoffLine(`[context-memory checkpoint=${id}]\n这是创建该 fork 时的父会话输入快照，共 3 条。`)).toContain('fork')
    expect(messages.every(m => handoffLine(m.text) === null)).toBe(true)
  })

  test('the summarizer keeps the person\'s own instructions ahead of the note', () => {
    expect(compactionInstructions(undefined, null)).toBeUndefined()
    expect(compactionInstructions(actualText, null)).toBe(actualText)
    const combined = compactionInstructions(actualText, actualText)!
    expect(combined.startsWith(`${actualText}\n\n`)).toBe(true)
    expect(combined).toContain(`--- task note ---\n${actualText}\n--- end of task note ---`)
  })

  test('notes reject empty text, marker text and text over the limit', () => {
    expect(noteProblem(actualText)).toBeNull()
    expect(noteProblem('   ')).not.toBeNull()
    expect(noteProblem(buildHandoff(checkpoint, 1, null, []).text)).toContain('[context-memory')
    const longest = all.map(m => m.text).filter(t => !t.includes('[context-memory')).sort((a, b) => b.length - a.length)[0]!
    expect(longest.length).toBeGreaterThan(NOTES_LIMIT)
    expect(noteProblem(longest)).toContain(String(NOTES_LIMIT))
  })

  test('recognizes a real fork prompt that also carries the parent tool result', () => {
    const message = JSON.parse(readFileSync(process.env.CONTEXT_MEMORY_FORK_MESSAGE ?? `${verification}/fork-message.json`, 'utf8'))
    expect(message.toolResults.length).toBeGreaterThan(0)
    expect(checkpointRoots([message])).toEqual(['700b22369e2d0ad1e2235b4ff8fe12f8'])
    expect(latestNotes([message])).toBeNull()
  })

  test('a real session yields the last accepted note and ignores refused ones', () => {
    const live = sessionMessages(process.env.CONTEXT_MEMORY_NOTES_TRANSCRIPT ?? `${verification}/notes-session.jsonl`)
    const calls = live.messages.flatMap(m => m.toolUses.filter((u: any) => u.tool === NOTES_TOOL))
    const accepted = calls.filter((u: any) => !u.isError)
    expect(accepted.length).toBeGreaterThan(0)
    expect(calls.some((u: any) => u.isError)).toBe(true)
    const beforeFirstHandoff = live.messages.slice(0, live.messages.findIndex(m => m.role === 'user' && m.text.includes('上下文已压缩')))
    expect(latestNotes(beforeFirstHandoff)).toBe(beforeFirstHandoff.flatMap(m => m.toolUses).filter((u: any) => u.tool === NOTES_TOOL && !u.isError).at(-1)!.input.text)
  })
})
