// Registry against a real state directory (plan section 12.1, registry row).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fnv1a64, newId } from '../src/io'
import { Registry } from '../src/registry'
import type { AgentRecord, Claim, Options, TaskRecord } from '../src/types'
import { nodeIo } from './node-io'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mt-registry-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function options(stateDir: string): Options {
  return {
    gatewayUrl: 'http://127.0.0.1:3425',
    stateDir,
    worktreeDir: join(stateDir, 'worktrees'),
    jevUrl: 'https://api.openai.com/v1/decisions',
    jevModel: 'gpt-6-luna',
    jevKeyFile: join(process.env.HOME!, '.config/jev-opus/openai-jev.key'),
    jevDeadlineMs: 10_000,
    evaluatorModel: 'claude/claude-opus-5-5',
    launcher: 'claude-magpie',
    claudeBin: 'claude',
    telegramStateDir: join(process.env.HOME!, '.claude/channels/telegram-live'),
    telegramChatId: '',
    timezone: 'Asia/Shanghai',
    ratingHour: 21,
  }
}

function longTask(id: string, sessionId: string, projectRoot: string): Omit<TaskRecord, 'schema' | 'createdAt' | 'updatedAt'> {
  return {
    id,
    kind: 'long',
    title: '检查 greet.py 并只回复 ok',
    state: 'starting',
    pausedByUser: false,
    request: '检查 greet.py 并只回复 ok',
    followUps: [],
    project: { root: projectRoot, gitInitByPlugin: true },
    worktree: null,
    extraWorktrees: {},
    owner: { kind: 'session', sessionId, previousSessionIds: [], model: 'claude/claude-opus-5-5', contextMemoryFingerprint: 'absent' },
    telegram: null,
    agents: {},
    blockers: {},
    decisions: {},
    deliverables: [],
    feedback: [],
    ratings: [],
    pendingRelays: {},
  }
}

function agent(agentId: string, sessionId: string, cwd: string): AgentRecord {
  return {
    agentId,
    role: 'implementer',
    sessionId,
    ruleId: 'code-change',
    rulesVersion: 'routing-rules.v1',
    selection: { kind: 'rule', reason: 'code-change' },
    judgment: null,
    model: 'claude/claude-opus-5-5',
    effort: 'xhigh',
    efforts: [{ at: Date.now(), from: null, to: 'xhigh', reason: 'rule' }],
    contextSource: 'brief',
    cwd,
    worktree: cwd,
    state: 'running',
    pendingRaises: [],
    filesTouched: [],
    reports: [],
    startedAt: Date.now(),
  }
}

function logTypes(stateDir: string, id: string): string[] {
  return readFileSync(join(stateDir, 'tasks', `${id}.log.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l).type)
}

test('create, get, update and log write the record and its log', async () => {
  const dir = join(root, 'basic')
  const reg = new Registry(nodeIo(), options(dir), 'session-a')
  const id = newId('l', Date.now())
  expect(id).toMatch(/^l-\d{8}-[0-9a-z]{6}$/)

  const created = await reg.create(longTask(id, 'session-a', dir))
  expect(created.schema).toBe(1)
  expect(created.createdAt).toBe(created.updatedAt)
  expect(await reg.get(id)).toEqual(created)
  expect(await reg.get('l-20000101-absent')).toBeUndefined()
  await expect(reg.create(longTask(id, 'session-a', dir))).rejects.toThrow(`task ${id} already exists`)

  const updated = await reg.update(id, t => { t.state = 'running' }, { type: 'state', from: 'starting', to: 'running' })
  expect(updated.state).toBe('running')
  expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
  expect((await reg.get(id))!.state).toBe('running')
  await reg.log(id, { type: 'telegram', messageId: 42 })
  await expect(reg.log('l-20000101-absent', { type: 'error' })).rejects.toThrow('does not exist')

  expect(logTypes(dir, id)).toEqual(['created', 'state', 'telegram'])
  const last = JSON.parse(readFileSync(join(dir, 'tasks', `${id}.log.jsonl`), 'utf8').trim().split('\n')[2]!)
  expect(last.session).toBe('session-a')
  expect(last.messageId).toBe(42)
  expect(typeof last.at).toBe('number')

  // list reads task records only: not logs, patches or temporary files
  expect(readdirSync(join(dir, 'tasks')).sort()).toEqual([`${id}.json`, `${id}.log.jsonl`])
  expect((await reg.list()).map(t => t.id)).toEqual([id])
  expect(await reg.list(t => t.state === 'done')).toEqual([])
  expect(existsSync(join(dir, 'locks'))).toBe(true)
  expect(readdirSync(join(dir, 'locks'))).toEqual([])
  await expect(reg.get('../escape')).rejects.toThrow('invalid ID')
}, 20_000)

test('20 concurrent updates from separate sessions all land', async () => {
  const dir = join(root, 'concurrent')
  const opts = options(dir)
  const id = newId('l', Date.now())
  await new Registry(nodeIo(), opts, 'creator').create(longTask(id, 'creator', dir))

  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    new Registry(nodeIo(), opts, `session-${i}`).update(id, t => {
      t.followUps.push({ at: Date.now(), source: 'window', text: `追问 ${i}` })
    }, { type: 'feedback', n: i })))

  const t = (await new Registry(nodeIo(), opts, 'reader').get(id))!
  expect(t.followUps.map(f => f.text).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `追问 ${i}`).sort())
  const types = logTypes(dir, id)
  expect(types).toHaveLength(21)
  expect(types.filter(x => x === 'feedback')).toHaveLength(20)
}, 60_000)

test('a claim is taken once and expired claims are removed', async () => {
  const dir = join(root, 'claims')
  const opts = options(dir)
  const now = Date.now()
  const message = '检查 greet.py 并只回复 ok\n\n[magpie-tasks architect task=l-20261109-abc123 worktree=/tmp/wt]'
  const launch: Claim = { id: newId('c', now), kind: 'launch', taskId: 'l-20261109-abc123', cwd: '/tmp/proj', createdAt: now, expiresAt: now + 600_000, promptHash: fnv1a64(message) }
  const expired: Claim = { id: newId('c', now), kind: 'takeover', taskId: 'l-20261109-def456', cwd: '/tmp/proj', createdAt: now - 200_000, expiresAt: now - 80_000, fromSessionId: 'old-session' }
  const writer = new Registry(nodeIo(), opts, 'writer')
  await writer.putClaim(launch)
  await writer.putClaim(expired)
  expect(readdirSync(join(dir, 'claims')).sort()).toEqual([`${expired.id}.json`, `${launch.id}.json`].sort())

  // The expired claim matches but is not handed out; it is removed.
  expect(await writer.takeClaim(c => c.kind === 'takeover', now)).toBeUndefined()
  expect(readdirSync(join(dir, 'claims'))).toEqual([`${launch.id}.json`])

  const hash = fnv1a64(message)
  const taken = await Promise.all(['bg-1', 'bg-2', 'bg-3'].map(s =>
    new Registry(nodeIo(), opts, s).takeClaim(c => c.kind === 'launch' && c.cwd === '/tmp/proj' && c.promptHash === hash, Date.now())))
  expect(taken.filter(c => c !== undefined)).toEqual([launch])
  expect(readdirSync(join(dir, 'claims'))).toEqual([])

  expect(await new Registry(nodeIo(), options(join(root, 'no-claims')), 'x').takeClaim(() => true, now)).toBeUndefined()
}, 30_000)

test('the Telegram index starts empty and keeps what updateIndex writes', async () => {
  const dir = join(root, 'index')
  const reg = new Registry(nodeIo(), options(dir), 'router')
  expect(await reg.readIndex()).toEqual({ schema: 1, messages: {}, workers: {}, agents: {} })

  await reg.updateIndex(x => {
    x.messages['123456:77'] = { taskId: 'd-20261109-aaaaaa', kind: 'magpie' }
    x.workers['greet-hi'] = { taskId: 'd-20261109-aaaaaa', ownerAgentId: 'agent-1', long: false }
    x.agents['agent-1'] = 'greet-hi'
  })
  await Promise.all([
    reg.updateIndex(x => { x.messages['123456:78'] = { taskId: 'l-20261109-bbbbbb', kind: 'long', decisionId: 'q-20261109-cccccc' } }),
    new Registry(nodeIo(), options(dir), 'architect').updateIndex(x => { x.agents['agent-2'] = 'greet-hi' }),
  ])

  const index = await reg.readIndex()
  expect(index.messages).toEqual({
    '123456:77': { taskId: 'd-20261109-aaaaaa', kind: 'magpie' },
    '123456:78': { taskId: 'l-20261109-bbbbbb', kind: 'long', decisionId: 'q-20261109-cccccc' },
  })
  expect(index.workers['greet-hi']).toEqual({ taskId: 'd-20261109-aaaaaa', ownerAgentId: 'agent-1', long: false })
  expect(index.agents).toEqual({ 'agent-1': 'greet-hi', 'agent-2': 'greet-hi' })
  expect(JSON.parse(readFileSync(join(dir, 'index', 'telegram.json'), 'utf8'))).toEqual(index)
}, 20_000)

test('the session index follows a session ID change; byAgent finds agents from a fresh process', async () => {
  const dir = join(root, 'sessions')
  const opts = options(dir)
  const reg = new Registry(nodeIo(), opts, 'fg-session')
  const id = newId('l', Date.now())
  await reg.create(longTask(id, 'fg-session', dir))
  expect((await reg.bySession('fg-session'))?.id).toBe(id)
  expect(await reg.bySession('bg-session')).toBeUndefined()

  await reg.update(id, t => {
    if (t.owner.kind !== 'session') throw new Error('not a session owner')
    t.owner.previousSessionIds.push(t.owner.sessionId)
    t.owner.sessionId = 'bg-session'
    t.owner.jobShortId = 'e21efae8'
    t.state = 'running'
  }, { type: 'rekey', from: 'fg-session', to: 'bg-session' })

  const fresh = new Registry(nodeIo(), opts, 'bg-session')
  const t = (await fresh.bySession('bg-session'))!
  expect(t.id).toBe(id)
  expect(t.owner).toMatchObject({ kind: 'session', sessionId: 'bg-session', previousSessionIds: ['fg-session'] })
  expect((await fresh.bySession('fg-session'))?.id).toBe(id)
  expect(JSON.parse(readFileSync(join(dir, 'index', 'sessions.json'), 'utf8'))).toEqual({ 'fg-session': id, 'bg-session': id })
  expect(logTypes(dir, id)).toEqual(['created', 'rekey'])

  const wt = join(dir, 'worktrees', id)
  await fresh.update(id, x => { x.agents['a1b2c3'] = agent('a1b2c3', 'bg-session', wt) }, { type: 'spawn', agentId: 'a1b2c3' })
  const found = await new Registry(nodeIo(), opts, 'other').byAgent('a1b2c3')
  expect(found?.task.id).toBe(id)
  expect(found?.agent.worktree).toBe(wt)
  expect(await fresh.byAgent('unknown-agent')).toBeUndefined()
}, 20_000)

test('state files read as the given empty value until written', async () => {
  const dir = join(root, 'state')
  const reg = new Registry(nodeIo(), options(dir), 'router')
  expect(await reg.readState('declined', { sessions: {} })).toEqual({ sessions: {} })
  await reg.lock('declined', async () => {
    const declined = await reg.readState<{ sessions: Record<string, number> }>('declined', { sessions: {} })
    declined.sessions['resumed-session'] = 1762650000000
    await reg.writeState('declined', declined)
  })
  expect(await reg.readState('declined', { sessions: {} })).toEqual({ sessions: { 'resumed-session': 1762650000000 } })
  expect(readdirSync(join(dir, 'state'))).toEqual(['declined.json'])
}, 20_000)
