// Workspace trust for the architect's project (plan section 9.2). `claude --bg` refuses a Git
// repository that Claude Code has not recorded as trusted ("Workspace not trusted", 2026-11-09), and
// a window run with --dangerously-skip-permissions never shows the trust dialog, so the record is
// never made there. Claude Code offers no command to set it: the person's confirmation in the
// long-task dialog is taken as trusting the project, and the flag is written into the global config
// (<config dir>/.claude.json, or ~/.claude.json without CLAUDE_CONFIG_DIR), the same field the trust
// dialog sets.
import type { Io } from './io'
import { expandHome } from './io'

export async function globalConfigPath(io: Io): Promise<string> {
  const dir = await io.env('CLAUDE_CONFIG_DIR')
  if (dir !== undefined && dir !== '') return `${dir.replace(/\/+$/, '')}/.claude.json`
  const home = await io.env('HOME')
  if (home === undefined || home === '') throw new Error('neither CLAUDE_CONFIG_DIR nor HOME is set')
  return expandHome('~/.claude.json', home)
}

function projects(config: unknown, path: string): Record<string, Record<string, unknown>> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error(`${path} is not a JSON object`)
  const p = (config as Record<string, unknown>)['projects']
  if (p === undefined) return {}
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error(`${path}: projects is not an object`)
  return p as Record<string, Record<string, unknown>>
}

export function isTrusted(text: string, root: string, path = '.claude.json'): boolean {
  return projects(JSON.parse(text), path)[root]?.['hasTrustDialogAccepted'] === true
}

// The config text with `root` trusted, every other field kept, in Claude Code's own layout
// (two-space indent).
export function withTrust(text: string, root: string, path = '.claude.json'): string {
  const config = JSON.parse(text) as Record<string, unknown>
  const all = projects(config, path)
  config['projects'] = { ...all, [root]: { ...(all[root] ?? {}), hasTrustDialogAccepted: true } }
  return JSON.stringify(config, null, 2)
}

// Whether the project is already trusted; read before the dialog so it can say what confirming does.
export async function projectTrusted(io: Io, root: string): Promise<boolean> {
  const path = await globalConfigPath(io)
  return (await io.exists(path)) && isTrusted(await io.read(path), root, path)
}

// Records the project as trusted: the new text goes to a file beside the config and is renamed over
// it, so a reader never sees half a file. Claude Code sessions write this file too; one that wrote
// between the read and the rename would lose its change, so the window is kept to these few calls,
// and the file is read back to confirm the flag stayed.
export async function trustProject(io: Io, root: string): Promise<void> {
  const path = await globalConfigPath(io)
  const before = await io.read(path)
  if (isTrusted(before, root, path)) return
  const tmp = `${path}.magpie-tasks.${await io.now()}`
  await io.write(tmp, withTrust(before, root, path))
  const r = await io.run(['sh', '-c', 'chmod --reference="$1" "$2" && mv "$2" "$1"', 'sh', path, tmp])
  if (r.exitCode !== 0) throw new Error(`recording ${root} as trusted in ${path} failed: ${r.stderr.trim()}`)
  if (!isTrusted(await io.read(path), root, path)) throw new Error(`${path} was rewritten while ${root} was being recorded as trusted; the flag is missing`)
}
