import type { JevMessage } from './dialogue';
import { latestUserText } from './dialogue';
import type { Effort } from './effort';
import type { JevAnswer, JevLike } from './jev';
import { heuristicTaskProfile } from './heuristics';
import { followUpEffort, normalizeBounds, policyVersion, taskEffort, unknownDeep, type Bounds, type FollowUpHistory } from './policy';
import { FOLLOWUP_QUESTIONS, FOLLOWUP_SET_VERSION, TASK_QUESTIONS, TASK_SET_VERSION, TASK_TYPES, type TaskType } from './questions';
import type { EffortDecision, FollowUpRecord, JevResponse, TaskProfile } from './types';

const QUESTION_VERSIONS = { task: TASK_SET_VERSION, followup: FOLLOWUP_SET_VERSION };

/** The input when a turn has no user message to read (a turn no prompt started, an empty brief). */
const NOTHING_TO_READ: JevMessage = { role: 'user', content: '(continuing an earlier task)' };

/**
 * An answer is usable when it is present and not marked missing/invalid by the
 * validating client. A result without a `signals` map counts a present answer
 * as valid. Anything else keeps the local estimate for that field — never a
 * neutral default.
 */
function validAnswer(res: JevResponse, name: string): JevAnswer | undefined {
  const a = res.answers[name];
  if (a === undefined) return undefined;
  const status = res.signals?.[name];
  return status === undefined || status === 'valid' ? a : undefined;
}

/** What routeTask needs to act on the follow-up questions for a person's new message. */
export interface FollowUpAsk extends FollowUpHistory {
  shadow: boolean;
  advisorOption: boolean;
  advisorAvailable: boolean;
}

export class EffortRouter {
  /**
   * The evaluator for the next decision. A hooks module reaches the network
   * only through the hook that runs, so the caller binds it per decision
   * (useJev); one loop's decisions never overlap, so the field is never shared.
   */
  private jev: JevLike | null;
  /** Why Jev is off for this decision, when it should have been on (an unreadable key file). */
  private jevOff: string | null = null;
  private model: string | null = null;
  bounds: Bounds;

  constructor(opts: { jev: JevLike | null; bounds: Bounds }) {
    this.jev = opts.jev && opts.jev.enabled ? opts.jev : null;
    this.bounds = normalizeBounds(opts.bounds);
  }

  useJev(jev: JevLike | null, off: string | null = null): void {
    this.jev = jev && jev.enabled ? jev : null;
    this.jevOff = this.jev ? null : off;
  }

  /** The model the next decision is for: the start comes from that model's table. */
  useModel(model: string | null): void {
    this.model = model;
  }

  get usingJev(): boolean {
    return this.jev !== null;
  }

  /**
   * The start level for the turn whose newest message ends `dialogue`: a
   * person's prompt, a slash command's body, or a subagent's brief or its new
   * message on a resumed run. One request asks the task questions and, with
   * `followUp`, the follow-up questions. A failed ask leaves the heuristics'
   * reading of the newest message, and the decision says why.
   */
  async routeTask(dialogue: readonly JevMessage[], previous: Effort | null, followUp?: FollowUpAsk): Promise<EffortDecision> {
    const bounds = normalizeBounds(this.bounds);
    const input = dialogue.length > 0 ? dialogue : [NOTHING_TO_READ];
    let profile: TaskProfile = heuristicTaskProfile(latestUserText(input));
    let jevLatencyMs = 0;
    let jevError: string | undefined = this.jevOff ?? undefined;
    let jevProvider: string | undefined;
    let jevUsage: EffortDecision['jevUsage'];
    let fault: { p: number | null; continues: number | null; error?: string } | null = null;

    if (this.jev) {
      const questions = followUp ? { ...TASK_QUESTIONS, ...FOLLOWUP_QUESTIONS } : TASK_QUESTIONS;
      const res = (await this.jev.ask(input, questions)) as JevResponse;
      jevLatencyMs = res.latencyMs;
      jevProvider = res.provider;
      jevUsage = { messages: input.length, inputTokens: res.inputTokens, cachedTokens: res.cachedTokens };
      if (res.failed || res.circuitOpen) {
        jevError = res.error ?? 'jev circuit open';
        if (followUp) fault = { p: null, continues: null, error: jevError };
      } else {
        const t = validAnswer(res, 'task_type');
        const dp = validAnswer(res, 'deep');
        const typed = t?.kind === 'choice' && t.choice in TASK_TYPES ? t : undefined;
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
        if (followUp) {
          const d = validAnswer(res, 'dissatisfied');
          const c = validAnswer(res, 'continues');
          const p = d?.kind === 'noul' && Number.isFinite(d.p) ? d.p : null;
          fault = {
            p,
            continues: c?.kind === 'noul' && Number.isFinite(c.p) ? c.p : null,
            ...(p === null ? { error: 'jev returned no usable answers' } : {}),
          };
        }
      }
    }

    const task = taskEffort(profile, bounds, this.model);
    let { effort } = task;
    const reasons = [...task.reasons];
    let followUpRecord: FollowUpRecord | undefined;
    if (followUp && fault) {
      const f = followUpEffort({ ...followUp, p: fault.p, base: effort, bounds });
      effort = f.effort;
      reasons.push(...f.reasons);
      followUpRecord = { ...f.followUp, latencyMs: jevLatencyMs, ...(fault.error ? { error: fault.error } : {}), ...(fault.continues !== null ? { continues: fault.continues } : {}) };
    }
    return {
      kind: 'task', effort, previous, changed: effort !== previous, reasons,
      source: profile.source, jevLatencyMs, jevError, jevProvider, profile,
      ...(jevUsage ? { jevUsage } : {}),
      policyVersion: policyVersion(), questionVersions: { ...QUESTION_VERSIONS },
      ...(followUpRecord ? { followUp: followUpRecord } : {}),
    };
  }

  /** Profile of the task being worked on when no decision carried one. */
  lastProfileFallback(prompt: string): TaskProfile {
    return heuristicTaskProfile(prompt);
  }
}
