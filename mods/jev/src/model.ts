/** A Claude id or alias with its 1M-context suffix: `claude-opus-5-5[1m]`, `claude-haiku-4-5-20251001`, `opus`. */
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i
const ALIAS = /^(opus|sonnet|haiku|fable|mythos)(\[1m\])?$/i

const title = (family: string) => family[0]!.toUpperCase() + family.slice(1).toLowerCase()

/**
 * A model as the band names it: `claude-opus-5-5` → `Opus 5.5`,
 * `claude-fable-5-1[1m]` → `Fable 5.1 (1M)`, the alias `opus` → `Opus`.
 * Anything else (a gateway's `jev/…`, a provider's own id) as given.
 */
export function modelLabel(model: string): string {
  const id = CLAUDE_ID.exec(model)
  if (id) return `${title(id[1]!)} ${id[2]}${id[3] ? `.${id[3]}` : ''}${id[4] ? ' (1M)' : ''}`
  const alias = ALIAS.exec(model)
  if (alias) return `${title(alias[1]!)}${alias[2] ? ' (1M)' : ''}`
  return model
}
