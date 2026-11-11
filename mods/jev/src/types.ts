import type { Effort } from './effort';
import type { JevResult } from './jev';
import type { TaskType } from './questions';

/**
 * Jev result plus the fields the validating client adds. Without `signals`
 * every present answer counts as valid; the validating client omits
 * missing/invalid answers instead.
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
  /** Jev's probability that the message carries on the previous turn's task; absent when unavailable */
  continues?: number;
  error?: string;
  latencyMs: number;
}

export interface EffortDecision {
  /** task: a turn's start level; step: a later request's level under a /effort pin */
  kind: 'task' | 'step';
  effort: Effort;
  previous: Effort | null;
  changed: boolean;
  reasons: string[];
  /** 'local' = decided without asking Jev (a continuation, a ladder step) */
  source: 'jev' | 'heuristic' | 'pinned' | 'local';
  jevLatencyMs: number;
  jevError?: string;
  /** which Jev service answered (or failed) */
  jevProvider?: string;
  /** what Jev read: the conversation's message count, and the input tokens OpenAI counted and read from its cache */
  jevUsage?: { messages: number; inputTokens: number; cachedTokens: number };
  profile?: TaskProfile;
  policyVersion?: string;
  /** versions of the Jev question sets this decision could draw on */
  questionVersions?: { task?: string; followup?: string };
  /** present on a task decision when the follow-up signal was asked */
  followUp?: FollowUpRecord;
  /** the start level exploration moved, and the level the policy chose */
  explore?: { p: number; from: Effort; to: Effort };
  /** a repeat check failure from the previous turn (a subagent's previous run) raised this start */
  carry?: { from: Effort; to: Effort; checks: number };
}
