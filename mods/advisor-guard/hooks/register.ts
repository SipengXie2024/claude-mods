import type { Register } from 'claude-code'

// The advisor is a server-side tool: the API runs it inside the request, so no
// tool.call hook ever sees it and a mod cannot refuse it or drop its tool
// definition. Under a Fable or Mythos main loop every consultation pays for a
// second premium model over the whole transcript, so the instructions that
// push the model to consult it are replaced with the sentence Claude Code
// itself sends to contexts that must not use the advisor. Two places carry
// them: the `advisor_tool` reminder injected into the main loop's messages,
// and any advisor section of the system prompt (checked per request model).

/** Models under which the advisor must not be consulted. */
const PREMIUM = /fable|mythos/i
const NEVER = 'Never consult the advisor tool.'

const isAdvisorSection = (s: { id: string; text: string }) =>
  /advisor/i.test(s.id) || /^#\s*Advisor Tool\b/m.test(s.text)

export const register: Register = on => {
  on('prompt.attachment', { type: 'advisor_tool' }, async ($, e, next) => {
    // Subagents run on their own model (Opus under subagent-opus): left alone.
    if (e.agentId !== undefined || !PREMIUM.test(await $.session.model())) return next(e)
    return { text: `# Advisor Tool\n\n${NEVER}` }
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (!PREMIUM.test(e.model)) return out
    return {
      sections: [
        ...out.sections.filter(s => !isAdvisorSection(s)),
        { id: 'advisor-guard:never', text: `# Advisor Tool\n\n${NEVER}`, scope: 'session' as const },
      ],
    }
  }).catch(($, e, next) => next(e))
}
