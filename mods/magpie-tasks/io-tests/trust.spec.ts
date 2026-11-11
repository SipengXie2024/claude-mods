// trustProject on a real file: a copy of this host's ~/.claude.json layout in a scratch config dir,
// reached through CLAUDE_CONFIG_DIR as Claude Code itself does.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globalConfigPath, isTrusted, projectTrusted, trustProject, withTrust } from '../src/trust'
import { nodeIo } from './node-io'

const dir = mkdtempSync(join(tmpdir(), 'mt-trust-'))
const saved = process.env['CLAUDE_CONFIG_DIR']
process.env['CLAUDE_CONFIG_DIR'] = dir
afterAll(() => {
  if (saved === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = saved
  rmSync(dir, { recursive: true, force: true })
})

const before = {
  numStartups: 412,
  theme: 'dark',
  projects: {
    '/home/ubuntu/sipeng/claude-mods': { allowedTools: [], hasTrustDialogAccepted: true, lastCost: 1.5 },
    '/tmp/e9proj': { allowedTools: [], mcpServers: {}, hasTrustDialogAccepted: false },
  },
}

test('an untrusted project is recorded as trusted, every other field kept, mode kept', async () => {
  const io = nodeIo()
  const path = join(dir, '.claude.json')
  writeFileSync(path, JSON.stringify(before, null, 2), { mode: 0o600 })
  expect(await globalConfigPath(io)).toBe(path)
  expect(await projectTrusted(io, '/tmp/e9proj')).toBe(false)
  expect(await projectTrusted(io, '/home/ubuntu/sipeng/claude-mods')).toBe(true)
  await trustProject(io, '/tmp/e9proj')
  await trustProject(io, '/tmp/new-project')
  const after = JSON.parse(readFileSync(path, 'utf8'))
  expect(after.projects['/tmp/e9proj']).toEqual({ allowedTools: [], mcpServers: {}, hasTrustDialogAccepted: true })
  expect(after.projects['/tmp/new-project']).toEqual({ hasTrustDialogAccepted: true })
  expect(after.projects['/home/ubuntu/sipeng/claude-mods']).toEqual(before.projects['/home/ubuntu/sipeng/claude-mods'])
  expect(after.numStartups).toBe(412)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readFileSync(path, 'utf8')).toBe(withTrust(withTrust(JSON.stringify(before), '/tmp/e9proj'), '/tmp/new-project'))
})

test('a config that is not an object, or whose projects is not an object, is an error', () => {
  expect(() => isTrusted('[]', '/x')).toThrow('not a JSON object')
  expect(() => withTrust('{"projects": 3}', '/x')).toThrow('projects is not an object')
  expect(isTrusted('{}', '/x')).toBe(false)
})
