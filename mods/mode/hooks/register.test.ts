import { test, expect } from 'claude-code/testing'

import { looksLikePaper, type Entry } from './detect'
import { detectMode, mergeProfile, parseLocal } from './settings'
import { ACADEMIC_ID } from './register'
import { PLANNING as PLANNING_ID, WRITING as WRITING_ID } from './profiles'

test('academic merge keeps unrelated keys and other plugins', () => {
  const local = { permissions: { additionalDirectories: ['../x'] }, enabledPlugins: { 'foo@bar': true } }
  const out = mergeProfile(local, 'academic') as any
  expect(out.permissions).toEqual({ additionalDirectories: ['../x'] })
  expect(out.enabledPlugins['foo@bar']).toBe(true)
  expect(out.enabledPlugins['superpower-writing@superpower-writing']).toBe(true)
  expect(out.enabledPlugins['superpower-planning@superpower-planning']).toBe(false)
  expect(detectMode(out)).toBe('academic')
})

test('general writes the general values, so the choice is recorded', () => {
  const out = mergeProfile(mergeProfile({}, 'academic'), 'general') as any
  expect(detectMode(out)).toBe('general')
  expect(out.outputStyle).toBe('Plain')
})

test('academic merge replaces the old academic output style with Plain', () => {
  const old = { enabledPlugins: { [WRITING_ID]: true, [PLANNING_ID]: false }, outputStyle: 'superpower-writing:Academic Research Assistant' }
  const out = mergeProfile(old, 'academic') as any
  expect(out.outputStyle).toBe('Plain')
  expect(JSON.stringify(out)).not.toBe(JSON.stringify(old))
  expect(JSON.stringify(mergeProfile(out, 'academic'))).toBe(JSON.stringify(out))
})

test('detectMode: empty file is unset; old academic-setup files read as academic', () => {
  expect(detectMode(parseLocal(undefined))).toBe('unset')
  const old = {
    enabledPlugins: { 'superpower-writing@superpower-writing': true, 'superpower-planning@superpower-planning': false },
    outputStyle: 'superpower-writing:Academic Research Assistant',
  }
  expect(detectMode(old)).toBe('academic')
  expect(detectMode({ enabledPlugins: { 'superpower-writing@superpower-writing': true } })).toBe('custom')
})

test('parseLocal refuses broken JSON', () => {
  expect(() => parseLocal('{ nope')).toThrow()
})

const tree: Record<string, Entry[]> = {
  '/a': [{ name: 'src', kind: 'dir' }, { name: 'docs', kind: 'dir' }, { name: 'node_modules', kind: 'dir' }],
  '/a/src': [{ name: 'main.rs', kind: 'file' }],
  '/a/docs': [{ name: 'paper', kind: 'dir' }],
  '/b': [{ name: 'src', kind: 'dir' }, { name: 'node_modules', kind: 'dir' }],
  '/b/src': [{ name: 'deep', kind: 'dir' }],
  '/b/src/deep': [{ name: 'x', kind: 'dir' }],
  '/b/src/deep/x': [{ name: 'too-deep.tex', kind: 'file' }],
  '/b/node_modules': [{ name: 'a.bib', kind: 'file' }],
  '/c': [{ name: 'refs.bib', kind: 'file' }],
  '/home': [{ name: '.git', kind: 'dir' }, { name: 'work', kind: 'dir' }],
  '/home/work': [{ name: 'thesis', kind: 'dir' }],
  '/home/work/thesis': [{ name: '.git', kind: 'dir' }, { name: 'main.tex', kind: 'file' }],
}
const list = async (p: string) => {
  const e = tree[p]
  if (!e) throw new Error(`no ${p}`)
  return e
}

test('looksLikePaper: paper/ two levels down, .bib at root', async () => {
  expect(await looksLikePaper(list, '/a')).toBe(true)
  expect(await looksLikePaper(list, '/c')).toBe(true)
})

test('looksLikePaper: ignores node_modules and files deeper than two levels', async () => {
  expect(await looksLikePaper(list, '/b')).toBe(false)
})

test('looksLikePaper: a nested git repo is another project, even from a repo root', async () => {
  expect(await looksLikePaper(list, '/home')).toBe(false)
  expect(await looksLikePaper(list, '/home/work/thesis')).toBe(true)
})

const composeIn = async ($: any, on: any, settings: string | undefined) => {
  on('session.root', () => ({ value: '/repo' }))
  on('fs.read', (_: any, e: any) => {
    if (e.path.endsWith('/prompts/academic.md')) return { value: '# Academic mode stub' }
    if (e.path !== '/repo/.claude/settings.local.json' || settings === undefined) throw new Error('ENOENT')
    return { value: settings }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  return out.sections as { id: string; text: string }[]
}
const ids = (sections: { id: string }[]) => sections.map(s => s.id)

test('academic repo: the academic prompt file is appended to the system prompt', async ($, on) => {
  const sections = await composeIn($, on, JSON.stringify(mergeProfile({}, 'academic')))
  expect(ids(sections)).toEqual(['intro', ACADEMIC_ID])
  expect(sections[1].text).toBe('# Academic mode stub')
})

test('general or unset repo: the system prompt is left alone', async ($, on) => {
  expect(ids(await composeIn($, on, undefined))).toEqual(['intro'])
})
