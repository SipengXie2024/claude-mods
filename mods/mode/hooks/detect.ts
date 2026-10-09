// A repo looks like a paper when a .tex or .bib file, or a paper/ directory,
// sits at the root or up to two levels down. A subdirectory with its own .git is
// another project (e.g. papers under ~/sipeng when the session starts in ~), so
// the scan does not enter it.

export type Entry = { name: string; kind: 'file' | 'dir' | 'other' }
export type Lister = (path: string) => Promise<readonly Entry[]>

const PAPER_FILE = /\.(tex|bib)$/
const SKIP = new Set(['node_modules', 'target', 'build', 'dist', 'vendor'])
const DEPTH = 2

export async function looksLikePaper(list: Lister, root: string, depth = 0): Promise<boolean> {
  let entries: readonly Entry[]
  try {
    entries = await list(root)
  } catch {
    return false
  }
  if (depth > 0 && entries.some(e => e.name === '.git')) return false
  const dirs: string[] = []
  for (const e of entries) {
    if (e.kind === 'file' && PAPER_FILE.test(e.name)) return true
    if (e.kind !== 'dir' || e.name.startsWith('.') || SKIP.has(e.name)) continue
    if (e.name === 'paper') return true
    dirs.push(e.name)
  }
  if (depth >= DEPTH) return false
  for (const d of dirs) if (await looksLikePaper(list, `${root}/${d}`, depth + 1)) return true
  return false
}
