import { test, expect } from 'claude-code/testing'

import { looksLikePaper, type Entry } from './detect'
import { detectMode, mergeProfile, parseLocal } from './settings'

test('academic merge keeps unrelated keys and other plugins', () => {
  const local = { permissions: { additionalDirectories: ['../x'] }, enabledPlugins: { 'foo@bar': true } }
  const out = mergeProfile(local, 'academic') as any
  expect(out.permissions).toEqual({ additionalDirectories: ['../x'] })
  expect(out.enabledPlugins['foo@bar']).toBe(true)
  expect(out.enabledPlugins['superpower-writing@superpower-writing']).toBe(true)
  expect(out.enabledPlugins['superpower-planning@superpower-planning']).toBe(false)
  expect(out.skillOverrides['academic-writing-context']).toBe('on')
  expect(detectMode(out)).toBe('academic')
})

test('general writes the general values, so the choice is recorded', () => {
  const out = mergeProfile(mergeProfile({}, 'academic'), 'general') as any
  expect(detectMode(out)).toBe('general')
  expect(out.outputStyle).toBe('Plain')
  expect(out.skillOverrides['academic-writing-context']).toBe('off')
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
