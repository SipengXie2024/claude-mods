import { describe, expect, test } from 'claude-code/testing'
import { isPaneCommand } from '../src/gate'
import * as tasks from '../src/tasks'

function memory(): tasks.Kv {
  const m = new Map<string, unknown>()
  return { get: async (k) => structuredClone(m.get(k)), set: async (k, v) => void m.set(k, structuredClone(v)) }
}

const DAY = 24 * 3600_000

describe('task records', () => {
  test('a reply to any recorded message finds the task', async () => {
    const kv = memory()
    await tasks.create(kv, { name: 'tg-1', title: 't', chatId: '9', rootId: 1, request: 'r', messageIds: [1], createdAt: 0 })
    await tasks.addMessage(kv, 'tg-1', 5, 10)
    expect((await tasks.byMessage(kv, '9', 5))?.name).toBe('tg-1')
    expect(await tasks.byMessage(kv, '8', 5)).toBe(undefined) // another chat
    await tasks.removeMessage(kv, 'tg-1', 5)
    expect(await tasks.byMessage(kv, '9', 5)).toBe(undefined)
  })

  test('a task goes 14 days after its last message, not before', async () => {
    const kv = memory()
    await tasks.create(kv, { name: 'tg-1', title: 'old', chatId: '9', rootId: 1, request: 'r', messageIds: [1], createdAt: 0 })
    await tasks.create(kv, { name: 'tg-2', title: 'new', chatId: '9', rootId: 2, request: 'r', messageIds: [2], createdAt: 0 })
    await tasks.addMessage(kv, 'tg-2', 3, 10 * DAY)
    expect(await tasks.prune(kv, 14 * DAY)).toBe(0)
    expect(await tasks.prune(kv, 14 * DAY + 1)).toBe(1)
    expect(await tasks.byMessage(kv, '9', 1)).toBe(undefined)
    expect((await tasks.byMessage(kv, '9', 3))?.name).toBe('tg-2')
  })

  test('writes that overlap all land', async () => {
    const m = new Map<string, unknown>()
    // each store call yields a few times, as a round trip to the host would
    const slow = async () => {
      for (let i = 0; i < 3; i++) await Promise.resolve()
    }
    const kv: tasks.Kv = {
      get: async (k) => (await slow(), structuredClone(m.get(k))),
      set: async (k, v) => (await slow(), void m.set(k, structuredClone(v))),
    }
    await tasks.create(kv, { name: 'tg-1', title: 'a', chatId: '9', rootId: 1, request: 'r', messageIds: [1], createdAt: 0 })
    await tasks.create(kv, { name: 'tg-2', title: 'b', chatId: '9', rootId: 2, request: 'r', messageIds: [2], createdAt: 0 })
    await Promise.all([tasks.addMessage(kv, 'tg-1', 10, 1), tasks.addMessage(kv, 'tg-2', 20, 1), tasks.setState(kv, 'tg-1', 'idle', 1)])
    expect((await tasks.byMessage(kv, '9', 10))?.name).toBe('tg-1')
    expect((await tasks.byMessage(kv, '9', 20))?.name).toBe('tg-2')
    expect((await tasks.byName(kv, 'tg-1'))?.state).toBe('idle')
  })

  test('the id of a worker loop is learned once', async () => {
    const kv = memory()
    await tasks.create(kv, { name: 'tg-1', title: 't', chatId: '9', rootId: 1, request: 'r', messageIds: [1], createdAt: 0 })
    expect(await tasks.byAgent(kv, 'a-1')).toBe(undefined)
    await tasks.setAgent(kv, 'tg-1', 'a-1')
    expect((await tasks.byAgent(kv, 'a-1'))?.name).toBe('tg-1')
  })
})

describe('pane commands', () => {
  test('herdr and tmux, chained or piped into filters', () => {
    expect(isPaneCommand('herdr pane list')).toBe(true)
    expect(isPaneCommand('tmux list-panes -a | grep claude | head -3')).toBe(true)
    expect(isPaneCommand('herdr pane rename 2 implementer && tmux ls')).toBe(true)
  })
  test('anything else, substitution or redirection is refused', () => {
    expect(isPaneCommand('ls')).toBe(false)
    expect(isPaneCommand('herdr pane list; rm -rf ~')).toBe(false)
    expect(isPaneCommand('tmux ls | sh')).toBe(false)
    expect(isPaneCommand('tmux send-keys "$(cat ~/.env)"')).toBe(false)
    expect(isPaneCommand('tmux capture-pane -p > /tmp/x')).toBe(false)
    expect(isPaneCommand('')).toBe(false)
  })
  test('a background `&`, a tmux command that runs a shell, and sort -o are refused', () => {
    expect(isPaneCommand('tmux ls & rm -rf /tmp/x')).toBe(false)
    expect(isPaneCommand('tmux run-shell "cat ~/.env"')).toBe(false)
    expect(isPaneCommand('tmux -L work if-shell true "touch x"')).toBe(false)
    expect(isPaneCommand('tmux pipe-pane -t 2 "tee log"')).toBe(false)
    expect(isPaneCommand('tmux list-panes | sort -o /tmp/x')).toBe(false)
    expect(isPaneCommand('tmux list-panes | sort -k2')).toBe(true)
  })
})
