import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { archiveFailure, buildHandoff, checkpointRoots, compactionInstructions, handoffLine, latestNotes, newCheckpointId, noteProblem, NOTES_LIMIT, NOTES_TOOL, PLUGIN_ID, project, PROTOCOL, PRUNE_KEEP_RECENT, PRUNE_MIN_CHARS, pruneForSummary } from '../src/core'

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
    // An older handoff without attributes still folds, without a count.
    const plain = `[context-memory checkpoint=${id}]\n上下文已压缩。`
    expect(handoffLine(plain)).toContain(id.slice(0, 8))
    expect(handoffLine(plain)).not.toContain('条记录（')
    expect(checkpointRoots([{ role: 'user', text: plain, toolUses: [] }])).toEqual([id])
    expect(messages.every(m => handoffLine(m.text) === null)).toBe(true)
  })

  test('the storage helper speaks the same protocol and reads the same marker', () => {
    const source = readFileSync(`${import.meta.dir}/../src/storage.py`, 'utf8')
    expect(Number(/^PROTOCOL = (\d+)$/m.exec(source)![1])).toBe(PROTOCOL)
    const id = newCheckpointId()
    const texts = [buildHandoff(id, 7, actualText, []).text, `[context-memory checkpoint=${id}]\nx`]
    const run = Bun.spawnSync(['python3', '-I', '-c',
      'import json,sys,importlib.util as u;s=u.spec_from_file_location("s",sys.argv[1]);m=u.module_from_spec(s);s.loader.exec_module(m);print(json.dumps([m.HANDOFF_MARK_RE.match(t).group(1) for t in json.loads(sys.stdin.read())]))',
      `${import.meta.dir}/../src/storage.py`], { stdin: Buffer.from(JSON.stringify(texts)) })
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout.toString())).toEqual([id, id])
  })

  test('an archive failure names its reason and how to step around the plugin', () => {
    const text = archiveFailure('database or disk is full')
    expect(text).toContain('database or disk is full')
    expect(text).toContain(`claude plugin disable ${PLUGIN_ID}`)
    expect(text).toContain('/reload-plugins')
  })

  test('the summary input points at long reproducible outputs and keeps everything else', () => {
    const { messages: input, pruned, before, after } = pruneForSummary(all)
    expect(pruned).toBeGreaterThan(0)
    expect(after).toBeLessThan(before)
    expect(input.length).toBe(all.length)
    const stub = /^\[context-memory: (Read|Grep|Glob) 的 (\d+) 字符输出/
    all.forEach((original, i) => {
      const got = input[i]!
      if (i >= all.length - PRUNE_KEEP_RECENT) expect(got).toBe(original)
      expect(got.toolUses.map(u => u.tool_use_id)).toEqual(original.toolUses.map(u => u.tool_use_id))
      expect((got.toolResults ?? []).map(r => r.tool_use_id)).toEqual((original.toolResults ?? []).map(r => r.tool_use_id))
      if (got === original) return
      expect('handle' in got).toBe(false)
      expect(got.text).toBe(original.text)
      got.toolUses.forEach((u, k) => {
        const o = original.toolUses[k]!
        if (u.text !== o.text) {
          const m = stub.exec(u.text!)!
          expect(m[1]).toBe(o.tool)
          expect(Number(m[2])).toBeGreaterThanOrEqual(PRUNE_MIN_CHARS)
        }
        if (!['Read', 'Grep', 'Glob'].includes(o.tool)) expect(u).toEqual(o)
      })
    })
    // Nothing to omit leaves the input as the engine handed it.
    const recent = all.slice(-PRUNE_KEEP_RECENT)
    expect(pruneForSummary(recent).messages.every((m, i) => m === recent[i])).toBe(true)
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
