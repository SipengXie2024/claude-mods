import type { Register } from 'claude-code'

// Workflow agents inherit the main-loop model unless each agent() call pins
// one, and agent.spawn can only deny a workflow agent (not rewrite its model),
// which would fail the run halfway. So the whole Workflow call is checked
// up front: under a Fable or Mythos main loop, every agent() call must carry a literal
// model: 'opus' in its own argument list. A pin only in meta.phases
// (display-only), in a shared opts variable, or in a comment does not count.

/** Main-loop models whose workflow agents must be pinned to Opus. */
const PREMIUM = /fable|mythos/i
const AGENT_CALL = /\bagent\s*\(/g
const OPUS_PIN = /model\s*:\s*['"]opus['"]/
const QUOTES = new Set(["'", '"', '`'])

/** Blank out // and /* *\/ comments (string-aware), keeping offsets and newlines. */
function stripComments(text: string): string {
  const out = text.split('')
  let state: string | null = null // null | quote char | '//' | '/*'
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i)
    if (state !== null && QUOTES.has(state)) {
      if (c === '\\') i++
      else if (c === state) state = null
    } else if (state === '//') {
      if (c === '\n') state = null
      else out[i] = ' '
    } else if (state === '/*') {
      if (c === '*' && text[i + 1] === '/') {
        out[i] = out[i + 1] = ' '
        i++
        state = null
      } else if (c !== '\n') out[i] = ' '
    } else if (QUOTES.has(c)) state = c
    else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      state = text[i + 1] === '/' ? '//' : '/*'
      out[i] = out[i + 1] = ' '
      i++
    }
  }
  return out.join('')
}

/** Offset of the ')' closing the '(' at openPos, skipping string contents. */
function matchingParen(text: string, openPos: number): number | undefined {
  let depth = 0
  let quote: string | null = null
  for (let i = openPos; i < text.length; i++) {
    const c = text.charAt(i)
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (QUOTES.has(c)) quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return undefined
}

/** [line, snippet] for each agent() call whose own arguments lack model: 'opus'. */
export function unpinnedAgentCalls(script: string): Array<[number, string]> {
  const clean = stripComments(script)
  const violations: Array<[number, string]> = []
  for (const m of clean.matchAll(AGENT_CALL)) {
    const start = m.index
    const close = matchingParen(clean, start + m[0].length - 1)
    if (close === undefined) continue // unbalanced: fail open for this call
    if (OPUS_PIN.test(clean.slice(start, close + 1))) continue
    const line = clean.slice(0, start).split('\n').length
    const raw = clean.slice(start, Math.min(close + 1, start + 90)).split(/\s+/).join(' ')
    violations.push([line, raw.length > 70 ? `${raw.slice(0, 70)}…` : raw])
  }
  return violations
}

export const register: Register = on => {
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const model = await $.session.model()
    if (!PREMIUM.test(model)) return next(e)

    let script = e.script ?? ''
    if (e.scriptPath) script = await $.fs.read(e.scriptPath).catch(() => '')
    if (!script) {
      return {
        deny:
          `Main session model is ${model} and this Workflow call carries no readable ` +
          "script (named workflow, or scriptPath could not be read), so the opus pins cannot be " +
          "verified. Inline the script with model: 'opus' in every agent() call's opts, or ask " +
          'the user to switch the session to Opus via /model.',
      }
    }

    const violations = unpinnedAgentCalls(script)
    if (violations.length === 0) return next(e)
    const spots = violations.map(([ln, sn]) => `  - line ${ln}: ${sn}`).join('\n')
    return {
      deny:
        `Main session model is ${model}. Workflow subagents inherit the session model ` +
        `unless each agent() call pins one, so these agent() calls would run on ${model}:\n${spots}\n` +
        "Fix: add model: 'opus' to the opts object of EACH call listed above and re-send the " +
        "workflow. The pin must be a literal model: 'opus' inside that call's own argument list — " +
        'a pin only in meta.phases (display-only) or in a shared opts variable is not detected; ' +
        'inline it at each call site.',
    }
  }).catch(($, e, next) => next(e))
}
