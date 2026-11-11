// Launching and listing background sessions (plan section 12.1, session/launch row): the argv of
// `claude-magpie --bg`, the development-only --plugin-dir, the short ID in real `claude --bg` output
// (copied from /tmp/magpie-probe-env-2ulG/runs, 2026-11-09), and the real `claude agents --json --all`
// output of this host.
import { expect, test } from 'claude-code/testing'
import { launchArgv, parseAgents, parseBackgrounded, pluginDirArg, resumedCopy } from '../src/launch'
import type { Options } from '../src/types'
import { agentsAll20261109 } from './data/agents'
import { installedPluginsE2e, installedPluginsHome, installedPluginsProbe } from './data/installed-plugins'

// The manifest's defaults (.claude-plugin/plugin.json), with ~ expanded for this host.
const OPTS: Options = {
  gatewayUrl: 'http://127.0.0.1:3425',
  stateDir: '/home/ubuntu/.config/magpie-tasks',
  worktreeDir: '/home/ubuntu/.local/share/magpie-tasks/worktrees',
  jevUrl: 'https://api.openai.com/v1/decisions',
  jevModel: 'gpt-6-luna',
  jevKeyFile: '/home/ubuntu/.config/jev-opus/openai-jev.key',
  jevDeadlineMs: 10000,
  evaluatorModel: 'claude/claude-opus-5-5',
  launcher: 'claude-magpie',
  claudeBin: 'claude',
  telegramStateDir: '/home/ubuntu/.claude/channels/telegram-live',
  telegramChatId: '',
  timezone: 'Asia/Shanghai',
  ratingHour: 21,
}

// magpie-bg/launch.txt: `claude-magpie --bg` of a new session.
const LAUNCH = 'backgrounded · b6721b8e\n  claude agents             list sessions\n  claude attach b6721b8e    open in this terminal\n  claude logs b6721b8e      show recent output\n  claude stop b6721b8e      stop this session\n'
// magpie-bg-resume/launch.txt: a resume with flags, which started a copy.
const COPY = 'note: background session b6721b8e keeps its own saved options, so the flags you passed started a copy as e0bcc445. Without flags, the same command continues b6721b8e itself.\nbackgrounded · e0bcc445\n  claude agents             list sessions\n  claude attach e0bcc445    open in this terminal\n  claude logs e0bcc445      show recent output\n  claude stop e0bcc445      stop this session\n'
// magpie-bg-resume/launch3-plain-claude.txt: plain `claude --bg --resume` of the stopped session.
const WOKE = 'note: woke session b6721b8e with its saved options (--settings, --plugin-dir, --debug-file, --model).\nbackgrounded · b6721b8e · bgok single word response\n  claude agents             list sessions\n  claude attach b6721b8e    open in this terminal\n  claude logs b6721b8e      show recent output\n  claude stop b6721b8e      stop this session\n'

test('the launch argv drops the nested-session markers, names the task debug file and adds --plugin-dir only in development', () => {
  const message = '整理 greet.py\n\n[magpie-tasks architect task=l-20261109-a1b2c3 worktree=/w/l-20261109-a1b2c3]'
  expect(launchArgv(OPTS, { model: 'claude/claude-opus-5-5[1m]', message, pluginDir: null, debugFile: '/s/debug/l-20261109-a1b2c3.txt' })).toEqual([
    'env', '-u', 'CLAUDECODE', '-u', 'CLAUDE_CODE_SESSION_ID', '-u', 'CLAUDE_CODE_ENTRYPOINT',
    'claude-magpie', '--bg', '--model', 'claude/claude-opus-5-5[1m]', '--debug-file', '/s/debug/l-20261109-a1b2c3.txt', message,
  ])
  const dev = launchArgv(OPTS, { model: 'codex/gpt-6.1-sol', message, pluginDir: '/home/ubuntu/sipeng/claude-mods/mods/magpie-tasks', debugFile: '/s/debug/x.txt' })
  expect(dev.slice(7)).toEqual(['claude-magpie', '--bg', '--model', 'codex/gpt-6.1-sol', '--debug-file', '/s/debug/x.txt', '--plugin-dir', '/home/ubuntu/sipeng/claude-mods/mods/magpie-tasks', message])
})

test('an installed plugin needs no --plugin-dir; a development folder does', () => {
  // Installed (the e2e config), the session loads it by itself, whatever its root; not installed
  // (the home config of 2026-11-09), it was loaded with --plugin-dir and the background session needs that too.
  expect(pluginDirArg('/home/ubuntu/sipeng/claude-mods/mods/magpie-tasks', installedPluginsE2e)).toBeNull()
  expect(pluginDirArg('/home/ubuntu/sipeng/claude-mods/mods/magpie-tasks', installedPluginsHome)).toBe('/home/ubuntu/sipeng/claude-mods/mods/magpie-tasks')
  expect(pluginDirArg('/home/ubuntu/.claude/plugins-dev/magpie-tasks', installedPluginsProbe)).toBe('/home/ubuntu/.claude/plugins-dev/magpie-tasks')
  expect(() => pluginDirArg('/x', {})).toThrow()
})

test('parseBackgrounded reads the short ID of real claude --bg output', () => {
  expect(parseBackgrounded(LAUNCH)).toBe('b6721b8e')
  expect(parseBackgrounded(COPY)).toBe('e0bcc445')
  expect(parseBackgrounded(WOKE)).toBe('b6721b8e')
  expect(parseBackgrounded('error: unknown option --bogus\n')).toBeNull()
  expect(parseBackgrounded('backgrounded - b6721b8e')).toBeNull()
})

test('a resume continued the session only when it printed the session\'s own short ID', () => {
  // The full ID of the probe session b6721b8e (/tmp/magpie-probe-env-2ulG/out/b6721b8e-00cb-4406-a867-bcf77416382e.json).
  const SESSION = 'b6721b8e-00cb-4406-a867-bcf77416382e'
  expect(resumedCopy(WOKE, SESSION)).toBeNull()
  expect(resumedCopy(COPY, SESSION)).toBe('e0bcc445')
  // The same output without the copy note: the printed ID alone tells.
  expect(resumedCopy(COPY.slice(COPY.indexOf('backgrounded')), SESSION)).toBe('e0bcc445')
  expect(resumedCopy('error: unknown option --bogus\n', SESSION)).toBeNull()
})

test('parseAgents reads every row of the real claude agents --json --all output', () => {
  const rows = parseAgents(agentsAll20261109)
  const raw = JSON.parse(agentsAll20261109) as Record<string, unknown>[]
  expect(rows).toHaveLength(raw.length)
  for (const [i, row] of rows.entries()) {
    expect(row.sessionId).toBe(raw[i]!['sessionId'])
    expect(row.id).toBe(row.sessionId.slice(0, 8))
    // A background row's own id is the first 8 hex digits of its session ID.
    if (raw[i]!['id'] !== undefined) expect(raw[i]!['id']).toBe(row.id)
    // No pid: the process has ended.
    expect(row.pid).toBe(raw[i]!['pid'] === undefined ? null : raw[i]!['pid'])
  }
  const shapes = new Set(rows.map(r => `${r.kind}/${r.state ?? '-'}/${r.status ?? '-'}/${r.pid === null ? 'stopped' : 'process'}`))
  expect([...shapes].sort()).toEqual(['background/done/-/stopped', 'background/failed/-/stopped', 'background/working/idle/process', 'interactive/-/busy/process', 'interactive/-/idle/process'])
  // A session waiting for the person lists as "waiting" (the real Router window of 2026-11-09).
  const waiting = { ...(JSON.parse(agentsAll20261109) as Record<string, unknown>[]).find(r => r['kind'] === 'interactive')!, status: 'waiting' }
  expect(parseAgents(JSON.stringify([waiting]))[0]!.status).toBe('waiting')
  expect(() => parseAgents('{"agents": []}')).toThrow('not an array')
  expect(() => parseAgents('[{"cwd": "/tmp"}]')).toThrow('sessionId')
})
