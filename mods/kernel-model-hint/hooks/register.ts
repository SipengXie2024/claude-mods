import type { Register } from 'claude-code'

// Claude Code adds a section (`llm_rnd_capabilities`) to the system prompt of
// Fable 5.2 and Mythos 5.2 saying their training limited accelerator kernel
// optimization and that this is not a reason to suggest a different model.
// The section is replaced by one that keeps the documentation advice and has
// the model suggest Mythos 5.1, which the note does not cover, for that work.

const isLimitSection = (s: { id: string; text: string }) =>
  s.id === 'llm_rnd_capabilities' || /accelerator kernel optimization/.test(s.text)

export const KERNEL_HINT = [
  '# Accelerator kernel work',
  '',
  'The training of Fable 5.2 and Mythos 5.2 included measures to limit advances in a narrow set of capabilities that could most directly accelerate AI development, like accelerator kernel optimization. Mythos 5.1 is not covered by these measures.',
  '',
  'When a task centers on accelerator kernel optimization (writing or tuning GPU or TPU kernels: CUDA, PTX, Triton, CUTLASS, CUDA-graph or memory-layout tuning of kernels), tell the user once, before starting that work, that this model was trained with these limits and suggest running the work on Mythos 5.1 instead (`/model claude-mythos-5-1`, or a subagent on that model). If the user stays on this model, help as usual, with less confidence in your preconceptions about kernels and more frequent lookups of documentation, and verify every kernel change with a correctness test and a measurement. Traditional ML and ordinary application code are not affected; do not suggest a different model for them.',
].join('\n')

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const i = out.sections.findIndex(isLimitSection)
    if (i < 0) return out
    const sections = [...out.sections]
    sections[i] = { ...sections[i], id: 'kernel-model-hint', text: KERNEL_HINT }
    return { sections }
  }).catch(($, e, next) => next(e))
}
