export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface RoutingEntry {
  readonly id: string
  readonly when: string
  readonly model: string
  readonly effort: EffortLevel
  readonly escalation?: string
  readonly substitutes?: string
}

// Derived from routing-rules.v10 (2026-11-19) plus Mythos 5.1 GPU/TPU kernel guidance.
export const ROUTING_TABLE: readonly RoutingEntry[] = [
  {
    id: 'code-change',
    when: 'Implement features, bug fixes, refactors, or tests with clear design',
    model: 'claude/claude-opus-5-5',
    effort: 'high',
    escalation: 'Large repo / long-horizon hard coding: claude/claude-mythos-5-2 (high)',
    substitutes: 'codex/gpt-6.2-astra (xhigh/max), hakimi/gemini-4-neon (xhigh)',
  },
  {
    id: 'design-advice',
    when: 'Architecture, engineering/product trade-offs, workflow plans (no code edits)',
    model: 'claude/claude-mythos-5-2',
    effort: 'high',
    escalation: 'Deep trade-offs: xhigh/max',
  },
  {
    id: 'gpu-kernel',
    when: 'GPU/TPU kernels & low-level acceleration (CUDA, PTX, Triton, CUTLASS, CUDA graphs, memory layout)',
    model: 'claude/claude-mythos-5-1',
    effort: 'high',
    escalation: '5.1 is free of 5.2 kernel training restrictions; raise to xhigh for hard kernels',
  },
  {
    id: 'review',
    when: 'Code/doc/config review, defect hunt, root-cause diagnosis, fact verification',
    model: 'claude/claude-opus-5-5',
    effort: 'medium',
    escalation: 'Deep audit: high; independent second-model review: codex/gpt-6.1-sol (medium) if original used Claude, else claude/claude-opus-5-5 (medium)',
  },
  {
    id: 'code-read',
    when: 'Read-only codebase exploration, tracing callers, feasibility analysis',
    model: 'claude/claude-opus-5-5',
    effort: 'medium',
    escalation: 'Complex systems: high',
  },
  {
    id: 'machine-ops',
    when: 'Server status checks, environment setup, build fixes, running benchmarks/experiments',
    model: 'claude/claude-sonnet-5-5',
    effort: 'max',
    escalation: 'Always pin max for Sonnet 5.5 on ops',
  },
  {
    id: 'math',
    when: 'Math problem solving, derivations, cryptographic constructions, counterexamples',
    model: 'codex/gpt-6.2-astra',
    effort: 'max',
    substitutes: 'codex/gpt-6.2-sol (max), hakimi/gemini-4-carbon (high)',
  },
  {
    id: 'lean',
    when: 'Formal Lean proofs (constructing new proofs or simplifying existing ones)',
    model: 'codex/gpt-6.2-astra',
    effort: 'max',
    escalation: 'Proof simplification: codex/gpt-6.1-sol (max) is also strong',
    substitutes: 'codex/gpt-6.2-sol (max), hakimi/gemini-4-carbon (high)',
  },
  {
    id: 'science-compute',
    when: 'Programmatic data analysis, numerical computation, fitting, simulation',
    model: 'codex/gpt-6.2-astra',
    effort: 'xhigh',
    escalation: 'Hard compute: max',
    substitutes: 'claude/claude-mythos-5-2 (high/max, strong on physics), hakimi/gemini-4-neon (xhigh)',
  },
  {
    id: 'document-analysis',
    when: 'Reading papers, PDFs, multi-doc corpora, tables; verifying cited numbers & claims',
    model: 'hakimi/gemini-4-neon',
    effort: 'high',
    escalation: 'Keep at high (score drops at xhigh)',
  },
  {
    id: 'explain-write',
    when: 'Writing notes, tutorials, technical explanations, or reports from existing material',
    model: 'hakimi/gemini-4-argon',
    effort: 'high',
  },
  {
    id: 'visual-build',
    when: 'Web pages, slide decks, animations, charts, or designed video frames',
    model: 'claude/claude-opus-5-5',
    effort: 'high',
  },
  {
    id: 'web-research',
    when: 'Web search for docs, specs, benchmarks, and dated sources',
    model: 'claude/claude-opus-5-5',
    effort: 'medium',
    escalation: 'Deep synthesis: high',
  },
  {
    id: 'batch-judge',
    when: 'Rubric-based bulk grading, labeling, or terminology-locked batch translation',
    model: 'claude/claude-opus-5-5',
    effort: 'medium',
    escalation: 'Ambiguous cases: high',
  },
  {
    id: 'computer-use',
    when: 'Multi-step browser or desktop UI operations',
    model: 'codex/gpt-6.1-terra',
    effort: 'medium',
    escalation: 'Goal needs continual interpretation: codex/gpt-6.1-sol (high)',
  },
]

export function renderRoutingTable(availableBareIds?: ReadonlySet<string>): string {
  const rows = [
    '| Task | When | Default `[model]` & `[effort]` | Escalation / Substitutes |',
    '| --- | --- | --- | --- |',
  ]
  for (const r of ROUTING_TABLE) {
    const missing = availableBareIds !== undefined && availableBareIds.size > 0 && !availableBareIds.has(r.model)
    const primary = missing
      ? `\`${r.model}\` (unavailable) · \`${r.effort}\``
      : `\`${r.model}\` · \`${r.effort}\``
    const notes: string[] = []
    if (r.escalation) notes.push(r.escalation)
    if (r.substitutes) notes.push(`Alt: ${r.substitutes}`)
    rows.push(`| \`${r.id}\` | ${r.when} | ${primary} | ${notes.join('; ') || '—'} |`)
  }
  return rows.join('\n')
}
