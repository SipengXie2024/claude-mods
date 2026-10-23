import type { Effort } from './effort';
import type { JevResult } from './jev';
import type { Phase, TaskType } from './questions';

/**
 * Jev result plus the fields the validating client adds. On older clients
 * `signals` is absent and every answer is present (treat those as valid);
 * the validating client omits missing/invalid answers instead.
 */
export type JevResponse = JevResult & {
  /** per-question evidence quality; undefined means an older client */
  signals?: Record<string, 'valid' | 'missing' | 'invalid'>;
  /** circuit breaker open → Jev unavailable for this call */
  circuitOpen?: boolean;
};

export interface TaskProfile {
  taskType: TaskType;
  typeConfidence: number;
  /**
   * 0..1 probability that the request needs new reasoning (derive, design,
   * weigh a trade-off, diagnose, judge a claim). Journal records written
   * before task.v3 carry difficulty/stakes instead and no deep.
   */
  deep: number;
  source: 'jev' | 'heuristic';
}

export interface StepSignals {
  phase: Phase;
  phaseConfidence: number;
  /** 0 … 4, how hard the next step is */
  stepDifficulty: number;
  /** 0..1 */
  stuck: number;
  source: 'jev' | 'heuristic';
}

/**
 * What a Bash command does, judged from the FULL command:
 * `check` runs tests/builds/linters (its output is a verdict), `lookup` only
 * reads (source, diffs, logs — its output is never evidence of failure),
 * `compare` compares outputs (`cmp`, `diff`: exit status is a verdict, output
 * text is not), `quiet` changes files or VCS state without producing a
 * verdict, `other` is anything else (scripts, interpreters) whose output text
 * is ambiguous.
 */
export type CommandKind = 'check' | 'lookup' | 'compare' | 'quiet' | 'other';

/**
 * Why a call counts as failed (or suspect). Safe to journal: a fixed code,
 * never output text.
 * - tool-error: the tool reported an error (non-zero exit, hook failure)
 * - interrupted: the tool was interrupted
 * - check-summary: a check's own summary reports failures (e.g. `# fail 2`)
 * - check-output: a check printed a failure marker line and no summary
 * - output-text: failure-like text from a non-check command (suspect only)
 */
export type FailureCause = 'tool-error' | 'interrupted' | 'check-summary' | 'check-output' | 'output-text';

export interface ToolCallSummary {
  tool: string;
  /** one-line rendering of the input, e.g. the Bash command or file path */
  summary: string;
  failed: boolean;
  /**
   * Failure evidence when failed/suspect (the marker lines that were
   * detected, so fingerprinting and classification see the same text);
   * otherwise the truncated result.
   */
  result: string;
  /** test/check runner found in the FULL command (e.g. "npm test"), so any later run of the same suite matches */
  runner?: string;
  /** the tool_use id that produced this call */
  id?: string;
  /** Bash only: what the full command does */
  kind?: CommandKind;
  /** set when failed or suspect */
  cause?: FailureCause;
  /**
   * Output text looks like a failure, but the command is not a recognized
   * check and reported success. Evidence for the evaluator only: it never
   * opens a durable issue and never resolves one.
   */
  suspect?: boolean;
}

export interface StepContext {
  prompt: string;
  profile: TaskProfile;
  turn: number;
  current: Effort;
  consecutiveFailures: number;
  /** latest assistant text in this prompt (what it said it's doing) */
  assistantNote: string;
  lastBatch: ToolCallSummary[];
  /** compact one-liners of earlier batches, oldest first */
  trajectory: string[];
  /** most edits of one file in this prompt so far (stuck evidence at CHURN_EDITS) */
  fileEdits?: number;
}

/**
 * What the follow-up (fault) signal saw and did on a new prompt. Numbers and
 * effort levels only: it is journaled, so it must never carry text.
 */
export interface FollowUpRecord {
  /** Jev's probability that the new message faults the previous turn; absent when unavailable */
  p?: number;
  threshold: number;
  yes: boolean;
  /** highest effort used on the previous prompt */
  prevMax: Effort;
  /** consecutive prompts judged as faulting the previous turn, this one included */
  streak: number;
  /** consecutive faults on a previous prompt that already ran at the top level (min(xhigh, bounds.max)) */
  hiLosses: number;
  /** effort the task was raised to; absent when nothing was raised */
  raisedTo?: Effort;
  /** an advisor note was requested */
  advisor: boolean;
  /** recorded but not acted on (JEV_OPUS_DISSATISFACTION=shadow or the dissat ablation) */
  shadow: boolean;
  error?: string;
  latencyMs: number;
}

export interface EffortDecision {
  kind: 'task' | 'step';
  effort: Effort;
  previous: Effort | null;
  changed: boolean;
  reasons: string[];
  /** 'local' = the policy gate decided no Jev call could change the outcome */
  source: 'jev' | 'heuristic' | 'pinned' | 'local';
  jevLatencyMs: number;
  jevError?: string;
  /** which Jev endpoint answered (or failed last) */
  jevProvider?: string;
  /** the primary endpoint's error when the fallback was asked */
  jevFallbackFrom?: string;
  profile?: TaskProfile;
  signals?: StepSignals;
  policyVersion?: string;
  /** versions of the Jev question sets this decision could draw on */
  questionVersions?: { task?: string; step?: string; followup?: string };
  /** present on a task decision when the follow-up signal was asked */
  followUp?: FollowUpRecord;
  /** step decisions: the failure evidence behind this decision (safe to journal) */
  evidence?: DecisionEvidence;
}

/**
 * An open issue as the audit shows it. Hash prefixes, fixed codes, counts,
 * and tool ids only — never commands or output.
 */
export interface IssueAudit {
  /** short issue reference (fingerprint prefix) */
  id: string;
  cause?: FailureCause;
  /** tool_use id of the call that first reported it */
  toolId?: string;
  environment: boolean;
  attempts: number;
  tried: Effort[];
  /** tool batches since the issue was first observed (0 = this batch) */
  age: number;
  /** what resolves it */
  clears: 'check-passes' | 'command-succeeds';
}

export interface DecisionEvidence {
  /** issues still open after this batch: what can hold effort */
  open: IssueAudit[];
  /** clearing open reasoning issues would allow a step down after routine evidence, hysteresis and bounds */
  heldByIssues?: boolean;
  /** failed or suspect calls in this batch */
  observed: Array<{ toolId?: string; tool: string; kind?: CommandKind; cause?: FailureCause; outcome: 'failed' | 'suspect' | 'exploratory' }>;
}
