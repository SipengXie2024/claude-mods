import type { Effort } from './effort';
import type { JevAnswer, JevLike } from './jev';
import { heuristicTaskProfile } from './heuristics';
import { followUpEffort, normalizeBounds, policyVersion, taskEffort, unknownDeep, type Bounds, type FollowUpHistory } from './policy';
import { FOLLOWUP_QUESTIONS, FOLLOWUP_SET_VERSION, TASK_QUESTIONS, TASK_SET_VERSION, TASK_TYPES, type TaskType } from './questions';
import type { EffortDecision, FollowUpRecord, JevResponse, TaskProfile } from './types';

/** Prefix of at most n UTF-16 units that never ends on half a surrogate pair. */
export function cut(s: string, n: number): string {
  let end = Math.max(0, Math.min(n, s.length));
  const last = s.charCodeAt(end - 1);
  if (end < s.length && last >= 0xd800 && last <= 0xdbff) end--;
  return s.slice(0, end);
}

/** Surrogate-safe clip that states how much was dropped. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = cut(s, n);
  return `${head}…[+${s.length - head.length} chars]`;
}

/**
 * Surrogate-safe clip that keeps both ends. A prompt often puts the request
 * after a long paste, so the tail carries the ask; the marker between the
 * two parts states how much was dropped.
 */
export function clipEnds(s: string, head: number, tail: number): string {
  if (s.length <= head + tail) return s;
  const front = cut(s, head);
  let start = Math.max(front.length, s.length - tail);
  const first = s.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start++;
  const back = s.slice(start);
  return `${front}…[+${s.length - front.length - back.length} chars]…${back}`;
}

/** Lone surrogates (e.g. from a caller's naive slice) crash some Jev servers; replace them. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (s: string) => s.replace(LONE_SURROGATE, '\uFFFD');

// The evaluator always gets the full request (JEV_OPUS_EVALUATOR_CONTENT=full
// in jev-opus): the self-hosted Jev's thresholds were calibrated on it.
// One departure from the calibrated state: long prompts keep their tail
// (clipEnds) instead of only their head, so a request written after a
// paste still reaches the evaluator. The thresholds were not re-run on it.

const QUESTION_VERSIONS = { task: TASK_SET_VERSION, followup: FOLLOWUP_SET_VERSION };

/**
 * An answer is usable when it is present and not marked missing/invalid by the
 * validating client. Older clients have no `signals` map: a present answer
 * counts as valid. Anything else keeps the local estimate for that field —
 * never a neutral default.
 */
function validAnswer(res: JevResponse, name: string): JevAnswer | undefined {
  const a = res.answers[name];
  if (a === undefined) return undefined;
  const status = res.signals?.[name];
  return status === undefined || status === 'valid' ? a : undefined;
}

export function taskState(prompt: string, conversationNote?: string): string {
  let s = `USER REQUEST TO A CODING AGENT:\n${clipEnds(prompt.trim(), 2200, 800)}`;
  if (conversationNote) s += `\n\nEARLIER IN THIS CONVERSATION (context only):\n${clip(conversationNote, 1500)}`;
  return wellFormed(s);
}

/** State for the follow-up (dissatisfaction) question: an optional summary of the previous turn, then the new message. */
export function followUpState(summary: string | null, prompt: string): string {
  const latest = `USER'S LATEST MESSAGE:\n${clipEnds(prompt.trim(), 1500, 500)}`;
  return wellFormed(summary ? `CONVERSATION SO FAR (context only, may be partial):\n${summary}\n\n${latest}` : latest);
}

/** What routeTask needs to ask and act on the follow-up signal for a new prompt. */
export interface FollowUpAsk extends FollowUpHistory {
  /** followUpSummary of the previous turn */
  summary: string | null;
  shadow: boolean;
  advisorOption: boolean;
  advisorAvailable: boolean;
}

/** The follow-up error recorded when only the fallback endpoint answered: its answer never raises. */
export const FALLBACK_IGNORED = 'fallback answer ignored';

export class EffortRouter {
  /**
   * The evaluator for the next decision. A hooks module reaches the network
   * only through the hook that runs, so the caller binds it per decision
   * (useJev); one loop's decisions never overlap, so the field is never shared.
   */
  private jev: JevLike | null;
  private model: string | null = null;
  bounds: Bounds;

  constructor(opts: { jev: JevLike | null; bounds: Bounds }) {
    this.jev = opts.jev && opts.jev.enabled ? opts.jev : null;
    this.bounds = normalizeBounds(opts.bounds);
  }

  useJev(jev: JevLike | null): void {
    this.jev = jev && jev.enabled ? jev : null;
  }

  /** The model the next decision is for: the start comes from that model's table. */
  useModel(model: string | null): void {
    this.model = model;
  }

  get usingJev(): boolean {
    return this.jev !== null;
  }

  /**
   * The start level for a prompt (or a subagent's brief). An answer from the
   * fallback endpoint sets the task kind only: its deep and its follow-up
   * verdict never raise.
   */
  async routeTask(prompt: string, previous: Effort | null, conversationNote?: string, followUp?: FollowUpAsk): Promise<EffortDecision> {
    const bounds = normalizeBounds(this.bounds);

    let profile: TaskProfile = heuristicTaskProfile(prompt);
    let jevLatencyMs = 0;
    let jevError: string | undefined;
    let jevProvider: string | undefined;
    let jevFallbackFrom: string | undefined;
    // The follow-up question is a separate ask in parallel: the task ask and its
    // state stay exactly as calibrated.
    const [res, fault] = await Promise.all([
      this.jev ? this.jev.ask(taskState(prompt, conversationNote), TASK_QUESTIONS) as Promise<JevResponse> : null,
      this.jev && followUp ? this.askFollowUp(followUp.summary, prompt) : null,
    ]);
    if (res) {
      jevLatencyMs = res.latencyMs;
      jevProvider = res.provider;
      jevFallbackFrom = res.fallbackFrom;
      if (res.failed || res.circuitOpen) {
        jevError = res.error ?? 'jev circuit open';
      } else {
        const t = validAnswer(res, 'task_type');
        const dp = validAnswer(res, 'deep');
        const typed = t?.kind === 'choice' && t.choice in TASK_TYPES ? t : undefined;
        // The fallback's deep counts like the primary's: with the primary down it is the only reading of how hard the work is.
        const deeped = dp?.kind === 'noul' ? dp : undefined;
        if (typed || deeped) {
          profile = {
            taskType: (typed?.choice ?? profile.taskType) as TaskType,
            typeConfidence: typed ? typed.confidence : profile.typeConfidence,
            // Without a usable Jev deep answer the local guess may still say deep, but a
            // missing answer must never be recorded as confidently not deep.
            deep: deeped ? deeped.p : Math.max(profile.deep, unknownDeep()),
            source: 'jev',
          };
        } else {
          jevError = 'jev returned no usable answers';
        }
      }
    }

    const task = taskEffort(profile, bounds, this.model);
    let { effort } = task;
    const reasons = [...task.reasons];
    if (jevFallbackFrom !== undefined && profile.source === 'jev') reasons.push('fallback answer');
    let followUpRecord: FollowUpRecord | undefined;
    if (followUp && fault) {
      const f = followUpEffort({ ...followUp, p: fault.p, base: effort, bounds });
      effort = f.effort;
      reasons.push(...f.reasons);
      followUpRecord = { ...f.followUp, latencyMs: fault.latencyMs, ...(fault.error ? { error: fault.error } : {}), ...(fault.continues !== null ? { continues: fault.continues } : {}) };
    }
    return {
      kind: 'task', effort, previous, changed: effort !== previous, reasons,
      source: profile.source, jevLatencyMs, jevError, jevProvider, jevFallbackFrom, profile,
      policyVersion: policyVersion(), questionVersions: { ...QUESTION_VERSIONS },
      ...(followUpRecord ? { followUp: followUpRecord } : {}),
    };
  }

  /**
   * Never throws: a failed follow-up ask means no signal, never a failed task
   * decision. The fallback's fault verdict is ignored; its reading of whether
   * the message carries on the task counts, since it holds no raise of its own.
   */
  private async askFollowUp(summary: string | null, prompt: string): Promise<{ p: number | null; continues: number | null; latencyMs: number; error?: string }> {
    try {
      const res = (await this.jev!.ask(followUpState(summary, prompt), FOLLOWUP_QUESTIONS)) as JevResponse;
      if (res.failed || res.circuitOpen) return { p: null, continues: null, latencyMs: res.latencyMs, error: res.error ?? 'jev circuit open' };
      const c = validAnswer(res, 'continues');
      const continues = c?.kind === 'noul' && Number.isFinite(c.p) ? c.p : null;
      if (res.fallbackFrom !== undefined) return { p: null, continues, latencyMs: res.latencyMs, error: FALLBACK_IGNORED };
      const d = validAnswer(res, 'dissatisfied');
      return d?.kind === 'noul' && Number.isFinite(d.p)
        ? { p: d.p, continues, latencyMs: res.latencyMs }
        : { p: null, continues, latencyMs: res.latencyMs, error: 'jev returned no usable answers' };
    } catch (err) {
      return { p: null, continues: null, latencyMs: 0, error: (err as Error).message || 'jev ask failed' };
    }
  }

  /** Profile of the task being worked on when no decision carried one. */
  lastProfileFallback(prompt: string): TaskProfile {
    return heuristicTaskProfile(prompt);
  }
}
