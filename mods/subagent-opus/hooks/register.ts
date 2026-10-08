import type { Register } from 'claude-code'

const FABLE = /fable/i

export const register: Register = on => {
  // Forks always inherit the parent's model, and a workflow agent's content
  // cannot be rewritten here (the Workflow PreToolUse guard covers those).
  // An explicit non-Fable choice (e.g. `haiku`) is kept.
  on('agent.spawn', ($, e, next) =>
    FABLE.test(e.parentModel) && !e.fork && !e.workflow && (e.model === undefined || FABLE.test(e.model))
      ? next({ ...e, model: 'opus' })
      : next(e),
  ).catch(($, e, next) => next(e))
}
