import type { Register } from 'claude-code'

/** Main-loop models whose subagents should run on Opus instead of inheriting. */
const PREMIUM = /fable|mythos/i

export const register: Register = on => {
  // Forks always inherit the parent's model, and a workflow agent's content
  // cannot be rewritten here (the Workflow PreToolUse guard covers those).
  // An explicit non-premium choice (e.g. `haiku`) is kept.
  on('agent.spawn', ($, e, next) =>
    PREMIUM.test(e.parentModel) && !e.fork && !e.workflow && (e.model === undefined || PREMIUM.test(e.model))
      ? next({ ...e, model: 'opus' })
      : next(e),
  ).catch(($, e, next) => next(e))
}
