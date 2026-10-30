/**
 * Label authors that are models, never a person: `claude-draft` (one model's
 * draft) and `opus+sonnet` (two independent models that agreed). Any other
 * non-empty `by` is a person who decided the label.
 */
export const MODEL_LABELERS: ReadonlySet<string> = new Set(['claude-draft', 'opus+sonnet'])

export const isPerson = (by: string | null | undefined): boolean => !!by && !MODEL_LABELERS.has(by)
