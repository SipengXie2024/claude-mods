import { test, expect } from 'claude-code/testing'

const bash = async ($: any, on: any, command: string) => {
  let ran = false
  on('tool.call', { tool: 'Bash' }, () => ((ran = true), { result: { stdout: '', stderr: '', interrupted: false } }))
  const r = await $.tool.call({ tool: 'Bash', command })
  return { ran, text: String(r.text ?? r.deny ?? '') }
}

test('sleep then tail of a task output file is blocked', async ($, on) => {
  const r = await bash($, on, 'sleep 30 && tail -5 /tmp/claude-1000/x/tasks/b1.output')
  expect(r.ran).toBe(false)
  expect(r.text).toContain('background-task output file')
})

test('sleep N && cat is blocked', async ($, on) => {
  const r = await bash($, on, 'sleep 5 && cat log.txt')
  expect(r.ran).toBe(false)
  expect(r.text).toContain('polling antipattern')
})

test('bounded retry loop passes', async ($, on) => {
  const r = await bash($, on, 'for i in {1..30}; do curl -sf localhost:8080 && break; sleep 1; done')
  expect(r.ran).toBe(true)
})

test('plain read passes', async ($, on) => {
  expect((await bash($, on, 'tail -5 build.log')).ran).toBe(true)
})
