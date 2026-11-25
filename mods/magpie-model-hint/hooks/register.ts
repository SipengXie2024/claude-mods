import type { PromptComposeSection, Register } from 'claude-code'

// When Claude Code runs through claude-magpie on a non-Claude model (e.g.
// hakimi/gemini-4-neon, codex/gpt-6.2-astra), append a concise system-prompt
// guide showing how to delegate complex engineering, deep audits, and GPU/TPU
// kernel work to Claude Mythos 5.2, Mythos 5.1, or Fable via Magpie.

export const SECTION_ID = 'magpie-model-hint'
export const DEFAULT_MAGPIE_GATEWAY = 'http://127.0.0.1:3425'

const CLAUDE_FAMILY = /claude|opus|sonnet|haiku|fable|mythos/i

export const MAGPIE_CLAUDE_HINT = [
  '# Delegating to Claude Models via Magpie',
  '',
  'You are running on a non-Claude model through the `claude-magpie` gateway. The Magpie backend can invoke any configured model, including the strongest Claude models.',
  '',
  '## How to invoke',
  '',
  '- `Agent` tool: its `model` enum only accepts `sonnet`, `opus`, `haiku`, or `fable` (not `mythos` or provider-prefixed Magpie IDs). Use `model: "fable"` or `model: "opus"` when a standard Claude subagent suffices.',
  '- `Bash` tool (for Mythos or any explicit Magpie model ID):',
  '  `claude-magpie --dangerously-skip-permissions --model <model-id> -p "<brief>" < /dev/null`',
  '  Always include `< /dev/null` so the child process never blocks reading stdin. Use `run_in_background: true` for heavy or long-running tasks.',
  '',
  '## Model selection',
  '',
  '- `claude/claude-mythos-5-2` (or `Agent` with `model: "fable"`): complex system architecture, heavy code implementation, and deep security or correctness audits.',
  '- `claude/claude-mythos-5-1`: GPU/TPU kernel writing and low-level acceleration (CUDA, PTX, Triton, CUTLASS, CUDA graphs, memory-layout tuning) — 5.1 is free of 5.2\'s kernel training restrictions.',
  '',
  '## Delegation discipline',
  '',
  '- Handle straightforward lookups, small edits, and routine questions directly; reserve heavy models for work that genuinely needs them.',
  '- Give each delegated task a clear, self-contained brief: goal, exact file paths, hard constraints (such as cloud GPU budget limits and forbidden actions), and concrete acceptance criteria.',
].join('\n')

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1')
}

export function isNonClaudeModel(model: string | undefined): boolean {
  if (typeof model !== 'string') return false
  const trimmed = model.trim()
  if (trimmed === '') return false
  return !CLAUDE_FAMILY.test(trimmed)
}

export function isMagpieGateway(baseUrl: string | undefined, gatewayUrl: string = DEFAULT_MAGPIE_GATEWAY): boolean {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return false
  return normalizeUrl(baseUrl) === normalizeUrl(gatewayUrl)
}

export const register: Register = (on, options) => {
  const configuredGateway = typeof options?.gatewayUrl === 'string' && options.gatewayUrl.trim() !== ''
    ? options.gatewayUrl.trim()
    : DEFAULT_MAGPIE_GATEWAY

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (!isNonClaudeModel(e.model)) return out
    const baseUrl = await $.env.get('ANTHROPIC_BASE_URL')
    if (!isMagpieGateway(baseUrl, configuredGateway)) return out
    if (out.sections.some(s => s.id === SECTION_ID)) return out
    const section: PromptComposeSection = { id: SECTION_ID, text: MAGPIE_CLAUDE_HINT, scope: 'session' }
    return { sections: [...out.sections, section] }
  }).catch(($, e, next) => next(e))
}
