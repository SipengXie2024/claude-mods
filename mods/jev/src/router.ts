import { clampEffort, isEffort, rank, type Effort } from './effort';
import type { JevAnswer, JevLike } from './jev';
import { heuristicStepSignals, heuristicTaskProfile } from './heuristics';
import {
  applyHysteresis, followUpEffort, normalizeBounds, policyVersion, stepTarget, taskEffort, unknownDeep,
  type Bounds, type FollowUpHistory, type StepEvidence,
} from './policy';
import {
  FOLLOWUP_QUESTIONS, FOLLOWUP_SET_VERSION, PHASES, STEP_QUESTIONS, STEP_SET_VERSION, TASK_QUESTIONS, TASK_SET_VERSION, TASK_TYPES,
  type Phase, type TaskType,
} from './questions';
import { auditIssues, emptyCore, isEnvironmentFailure, isExploratoryFailure, reasoningIssues, reduceBatch, reviveCore, serializeCore, type CoreState } from './state';
import type { DecisionEvidence, EffortDecision, FollowUpRecord, JevResponse, StepContext, StepSignals, TaskProfile, ToolCallSummary } from './types';

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

// The evaluator always gets the full request and tool-call state
// (JEV_OPUS_EVALUATOR_CONTENT=full in jev-opus): the self-hosted Jev's
// thresholds were calibrated on it. The summary-only state is not ported.
// One departure from the calibrated state: long prompts keep their tail
// (clipEnds) instead of only their head, so a request written after a
// paste still reaches the evaluator. The thresholds were not re-run on it.

/**
 * Upper bound on the step state sent to Jev (JEV_OPUS_STEP_STATE_MAX); the
 * oldest tool calls are dropped first. The minimum leaves room for the fixed
 * header (up to ~1.9k chars) plus the latest calls.
 */
export const STEP_STATE_DEFAULT = 6_000;
export const STEP_STATE_MIN = 3_000;
let stepStateMax = STEP_STATE_DEFAULT;

export function setStepStateMax(n: number): void {
  stepStateMax = Number.isFinite(n) && n >= STEP_STATE_MIN ? Math.floor(n) : STEP_STATE_DEFAULT;
}

const SAFE_TOOL_NAMES = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'Agent']);

const QUESTION_VERSIONS = { task: TASK_SET_VERSION, step: STEP_SET_VERSION, followup: FOLLOWUP_SET_VERSION };

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
  if (conversationNote) s += `\n\nEARLIER IN THIS CONVERSATION (context only):\n${clip(conversationNote, 800)}`;
  return wellFormed(s);
}

/** State for the follow-up (dissatisfaction) question: an optional summary of the previous turn, then the new message. */
export function followUpState(summary: string | null, prompt: string): string {
  const latest = `USER'S LATEST MESSAGE:\n${clipEnds(prompt.trim(), 1500, 500)}`;
  return wellFormed(summary ? `CONVERSATION SO FAR (context only, may be partial):\n${summary}\n\n${latest}` : latest);
}

/** Share of the step-state cap the unresolved-issue list may take. */
const ISSUES_SHARE = 0.2;

/** Room kept for the "(N earlier tool calls omitted)" line when calls are dropped. */
const OMITTED_RESERVE = 48;

/**
 * Evaluator state for one step, at most `maxChars` long (default
 * JEV_OPUS_STEP_STATE_MAX). The header always survives; then the most recent
 * tool calls, newest first; earlier-step history only gets what is left.
 */
export function stepState(ctx: StepContext, opts: { maxChars?: number } = {}): string {
  const max = opts.maxChars ?? stepStateMax;
  const head = [
    `TASK: ${clipEnds(ctx.prompt.trim(), 900, 300)}`,
    // consecutiveFailures counts steps whose batch had a failure, not calls.
    `STEP ${ctx.turn} · effort in force: ${ctx.current} · consecutive steps with a failed tool call: ${ctx.consecutiveFailures}`,
  ];
  if (ctx.assistantNote) head.push(`AGENT SAID: ${clip(ctx.assistantNote.trim(), 500)}`);
  head.push('TOOL CALLS JUST MADE:');
  const calls = ctx.lastBatch.map((c) => {
    const outcome = c.failed ? 'FAILED' : c.suspect ? 'ok (output mentions failures; not a recognized check, unverified)' : 'ok';
    return `- ${c.tool} ${clip(c.summary, 200)} → ${outcome}: ${clip(c.result.replace(/\s+/g, ' '), 400)}`;
  });
  const earlier = ctx.trajectory.slice(-6);

  const whole = [...head, ...calls];
  if (earlier.length) whole.push(`EARLIER STEPS:\n${earlier.join('\n')}`);
  const full = whole.join('\n');
  if (full.length <= max) return wellFormed(full);

  // Each kept line costs its length plus one newline.
  let budget = max - head.join('\n').length - OMITTED_RESERVE;
  const kept: string[] = [];
  for (let i = calls.length - 1; i >= 0 && calls[i]!.length + 1 <= budget; i--) {
    kept.unshift(calls[i]!);
    budget -= calls[i]!.length + 1;
  }
  const keptSteps: string[] = [];
  budget -= '\nEARLIER STEPS:'.length;
  for (let i = earlier.length - 1; i >= 0 && earlier[i]!.length + 1 <= budget; i--) {
    keptSteps.unshift(earlier[i]!);
    budget -= earlier[i]!.length + 1;
  }
  const lines = [...head];
  const omitted = calls.length - kept.length;
  if (omitted > 0) lines.push(`(${omitted} earlier tool call${omitted === 1 ? '' : 's'} omitted)`);
  lines.push(...kept);
  if (keptSteps.length) lines.push(`EARLIER STEPS:\n${keptSteps.join('\n')}`);
  // Only a cap smaller than the header itself reaches this hard cut.
  return wellFormed(cut(lines.join('\n'), max));
}

/** Cap on one EARLIER STEPS line, so a batch of many parallel calls cannot crowd out the rest of the history. */
export const TRAJECTORY_LINE_MAX = 300;

/** One EARLIER STEPS line for a finished batch: counts first, then failed calls, so both survive the cap. */
export function trajectoryLine(turn: number, effort: Effort, batch: readonly ToolCallSummary[]): string {
  const failed = batch.filter((c) => c.failed);
  const ordered = [...failed, ...batch.filter((c) => !c.failed)];
  const calls = ordered.map((c) => `${c.tool} ${cut(c.summary, 60)} ${c.failed ? 'FAILED' : 'ok'}`).join('; ');
  const counts = batch.length > 1 ? `${batch.length} calls, ${failed.length} FAILED: ` : '';
  // clip appends its `…[+N chars]` marker past the limit; keep the whole line within the cap.
  return clip(`step ${turn} @${effort}: ${counts}${calls}`, TRAJECTORY_LINE_MAX - 16);
}

/** What routeTask needs to ask and act on the follow-up signal for a new prompt. */
export interface FollowUpAsk extends FollowUpHistory {
  /** followUpSummary of the previous turn */
  summary: string | null;
  shadow: boolean;
  advisorOption: boolean;
  advisorAvailable: boolean;
}

export interface RouterSnapshot {
  v: number;
  [key: string]: unknown;
}

export class EffortRouter {
  /**
   * The evaluator for the next decision. A hooks module reaches the network
   * only through the hook that runs, so the caller binds it per decision
   * (useJev); one loop's decisions never overlap, so the field is never shared.
   */
  private jev: JevLike | null;
  bounds: Bounds;
  pinned: Effort | null;
  private hold = 0;
  private base: Effort = 'medium';
  private core: CoreState = emptyCore();

  constructor(opts: { jev: JevLike | null; bounds: Bounds; pinned?: Effort | null }) {
    this.jev = opts.jev && opts.jev.enabled ? opts.jev : null;
    this.bounds = normalizeBounds(opts.bounds);
    this.pinned = opts.pinned ?? null;
  }

  useJev(jev: JevLike | null): void {
    this.jev = jev && jev.enabled ? jev : null;
  }

  /** Raise the task level later steps build on (a short acknowledgement keeps the previous prompt's level). */
  raiseBase(effort: Effort): void {
    if (rank(effort) > rank(this.base)) this.base = effort;
  }

  get usingJev(): boolean {
    return this.jev !== null;
  }

  async routeTask(prompt: string, previous: Effort | null, conversationNote?: string, followUp?: FollowUpAsk): Promise<EffortDecision> {
    this.core = emptyCore(); // a new prompt is a fresh decision, no carried-over recovery state
    this.hold = 0;
    if (this.pinned) return this.pinnedDecision('task', previous);
    const bounds = normalizeBounds(this.bounds);

    let profile: TaskProfile = heuristicTaskProfile(prompt);
    let jevLatencyMs = 0;
    let jevError: string | undefined;
    // The follow-up question is a separate ask in parallel: the task ask and its
    // state stay exactly as calibrated.
    const [res, fault] = await Promise.all([
      this.jev ? this.jev.ask(taskState(prompt, conversationNote), TASK_QUESTIONS) as Promise<JevResponse> : null,
      this.jev && followUp ? this.askFollowUp(followUp.summary, prompt) : null,
    ]);
    if (res) {
      jevLatencyMs = res.latencyMs;
      if (res.failed || res.circuitOpen) {
        jevError = res.error ?? 'jev circuit open';
      } else {
        const t = validAnswer(res, 'task_type');
        const dp = validAnswer(res, 'deep');
        const typed = t?.kind === 'choice' && t.choice in TASK_TYPES ? t : undefined;
        const deeped = dp?.kind === 'noul' ? dp : undefined;
        if (typed || deeped) {
          profile = {
            taskType: (typed?.choice ?? profile.taskType) as TaskType,
            typeConfidence: typed ? typed.confidence : profile.typeConfidence,
            // Without a Jev deep answer the local guess may still say deep, but a
            // missing answer must never be recorded as confidently not deep.
            deep: deeped ? deeped.p : Math.max(profile.deep, unknownDeep()),
            source: 'jev',
          };
        } else {
          jevError = 'jev returned no usable answers';
        }
      }
    }

    const task = taskEffort(profile, bounds);
    let { effort } = task;
    const reasons = [...task.reasons];
    let followUpRecord: FollowUpRecord | undefined;
    if (followUp && fault) {
      const f = followUpEffort({ ...followUp, p: fault.p, base: effort, bounds });
      effort = f.effort;
      reasons.push(...f.reasons);
      followUpRecord = { ...f.followUp, latencyMs: fault.latencyMs, ...(fault.error ? { error: fault.error } : {}) };
    }
    this.base = effort;
    return {
      kind: 'task', effort, previous, changed: effort !== previous, reasons,
      source: profile.source, jevLatencyMs, jevError, profile,
      policyVersion: policyVersion(), questionVersions: { ...QUESTION_VERSIONS },
      ...(followUpRecord ? { followUp: followUpRecord } : {}),
    };
  }

  /** Never throws: a failed follow-up ask means no signal, never a failed task decision. */
  private async askFollowUp(summary: string | null, prompt: string): Promise<{ p: number | null; latencyMs: number; error?: string }> {
    try {
      const res = (await this.jev!.ask(followUpState(summary, prompt), FOLLOWUP_QUESTIONS)) as JevResponse;
      if (res.failed || res.circuitOpen) return { p: null, latencyMs: res.latencyMs, error: res.error ?? 'jev circuit open' };
      const d = validAnswer(res, 'dissatisfied');
      return d?.kind === 'noul' && Number.isFinite(d.p)
        ? { p: d.p, latencyMs: res.latencyMs }
        : { p: null, latencyMs: res.latencyMs, error: 'jev returned no usable answers' };
    } catch (err) {
      return { p: null, latencyMs: 0, error: (err as Error).message || 'jev ask failed' };
    }
  }

  async routeStep(ctx: StepContext): Promise<EffortDecision> {
    // Reduce the tool batch into evidence first, so even a pinned decision
    // keeps the recovery history current if the pin is later lifted.
    const { state, outcome } = reduceBatch(this.core, ctx.lastBatch, ctx.current);
    this.core = state;
    if (this.pinned) return this.pinnedDecision('step', ctx.current);
    const bounds = normalizeBounds(this.bounds);

    const reasoning = reasoningIssues(this.core);
    const failing = [...outcome.newIssues, ...outcome.repeated].filter((i) => !i.environment);
    const triedOnFailure = [...new Set(failing.flatMap((i) => i.tried))];
    const xhighAttempts = failing.reduce((m, i) => Math.max(m, i.xhighAttempts), 0);
    const evidence = (routineOk: boolean): StepEvidence => ({
      unresolved: reasoning.length,
      repeated: outcome.repeated.some((i) => !i.environment),
      triedOnFailure,
      xhighAttempts,
      maxAttempts: reasoning.reduce((m, i) => Math.max(m, i.attempts), 0),
      environmentOnly: outcome.environmentOnly,
      routineOk,
      ...(ctx.fileEdits !== undefined ? { fileEdits: ctx.fileEdits } : {}),
    });

    // A failure that justified escalation now passes, and nothing else is open:
    // the escalation did its job. That is positive evidence for stepping down,
    // and it releases the post-raise hold (the hold only exists to give an
    // escalation time to work).
    const recovered = outcome.resolved.some((i) => !i.environment) && reasoning.length === 0;
    if (recovered) this.hold = 0;

    // Exploratory lookups that failed don't steer the phase toward diagnosing.
    const judged = outcome.exploratoryFailures ? { ...ctx, lastBatch: ctx.lastBatch.map((c) => (c.failed && isExploratoryFailure(c) ? { ...c, failed: false } : c)) } : ctx;
    const local = heuristicStepSignals(judged, { ignoreFailures: outcome.environmentOnly });
    const localRoutine = local.phase !== 'diagnosing' || recovered;
    let signals: StepSignals = local;
    let routineOk = localRoutine;
    let target = stepTarget(this.base, local, evidence(routineOk), ctx.current);

    let jevLatencyMs = 0;
    let jevError: string | undefined;
    let source: EffortDecision['source'] = this.jev ? 'local' : 'heuristic';

    // Selective Jev: ask only when the answer could change the decision — a
    // failure, a proposed downgrade, stalled recovery, or an unclear phase.
    const proposedDown = rank(target.effort) < rank(ctx.current);
    const consult = outcome.failedCalls > 0 || outcome.suspectFailures > 0 || proposedDown || local.phaseConfidence < 0.5;

    if (this.jev && consult) {
      const res = (await this.jev.ask(this.stepAskState(judged), STEP_QUESTIONS)) as JevResponse;
      jevLatencyMs = res.latencyMs;
      if (res.failed || res.circuitOpen) {
        jevError = res.error ?? 'jev circuit open';
        source = 'heuristic';
      } else {
        const ph = validAnswer(res, 'phase');
        const sd = validAnswer(res, 'step_difficulty');
        const st = validAnswer(res, 'stuck');
        const phased = ph?.kind === 'choice' && ph.choice in PHASES ? ph : undefined;
        const scored = sd?.kind === 'score' ? sd : undefined;
        const stucked = st?.kind === 'noul' ? st : undefined;
        if (phased || scored || stucked) {
          signals = {
            phase: (phased?.choice ?? local.phase) as Phase,
            phaseConfidence: phased?.confidence ?? local.phaseConfidence,
            stepDifficulty: scored ? scored.score : local.stepDifficulty,
            stuck: stucked ? stucked.p : local.stuck,
            source: 'jev',
          };
          source = 'jev';
          // Routine evidence from Jev needs a confident, valid answer; missing
          // or weak evidence never justifies a downgrade on its own.
          routineOk = recovered ? true
            : phased && phased.confidence >= 0.6 ? phased.choice !== 'diagnosing'
            : scored && scored.confidence >= 0.6 ? scored.score < 2.25
              : localRoutine;
        } else {
          jevError = 'jev returned no usable answers';
          source = 'heuristic';
        }
      }
      target = stepTarget(this.base, signals, evidence(routineOk), ctx.current);
    }

    // Count an issue hold only if clearing the issues would permit a lower
    // final effort. Routine evidence, hysteresis and bounds can also block it.
    const finishing = signals.phase === 'finishing';
    let heldByIssues = false;
    if (target.heldByIssues) {
      const withoutIssues = stepTarget(this.base, signals, { ...evidence(routineOk), unresolved: 0 }, ctx.current);
      const unheld = applyHysteresis(ctx.current, withoutIssues.effort, this.hold, finishing);
      heldByIssues = rank(clampEffort(unheld.effort, bounds.min, bounds.max)) < rank(ctx.current);
    }

    // Hysteresis first, then the legal range: bounds always apply last.
    const h = applyHysteresis(ctx.current, target.effort, this.hold, finishing);
    this.hold = h.hold;
    const effort = clampEffort(h.effort, bounds.min, bounds.max);
    const reasons = recovered ? ['failing check now passes → release hold', ...target.reasons]
      : outcome.failedCalls > 0 && !outcome.environmentOnly ? ['failing checks → recovery effort', ...target.reasons]
        : [...target.reasons];
    if (h.note) reasons.push(h.note);
    if (effort !== h.effort) reasons.push(`bounded to ${effort}`);
    return {
      kind: 'step', effort, previous: ctx.current, changed: effort !== ctx.current, reasons,
      source, jevLatencyMs, jevError, signals, profile: ctx.profile,
      policyVersion: policyVersion(), questionVersions: { ...QUESTION_VERSIONS },
      evidence: this.evidence(ctx, heldByIssues && effort === ctx.current),
    };
  }

  /** The audit trail for a step: open issues and this batch's failure observations. */
  private evidence(ctx: StepContext, heldByIssues: boolean): DecisionEvidence {
    const observed: DecisionEvidence['observed'] = [];
    for (const c of ctx.lastBatch) {
      const outcome = c.failed ? (isExploratoryFailure(c) ? 'exploratory' : 'failed') : c.suspect ? 'suspect' : null;
      if (!outcome) continue;
      observed.push({
        ...(c.id && /^[\w-]{1,80}$/.test(c.id) ? { toolId: c.id } : {}),
        tool: SAFE_TOOL_NAMES.has(c.tool) ? c.tool : 'other',
        ...(c.kind ? { kind: c.kind } : {}),
        ...(c.cause ? { cause: c.cause } : {}),
        outcome,
      });
    }
    return { open: auditIssues(this.core), ...(heldByIssues ? { heldByIssues } : {}), observed };
  }

  /**
   * JSON-serializable controller state, so an adapter can persist it with a
   * decision and restore the common-ancestor state after a rewind or restart.
   * Adapters must treat the value as opaque.
   */
  snapshot(): RouterSnapshot {
    return { v: 2, hold: this.hold, base: this.base, state: serializeCore(this.core) };
  }

  restore(s: RouterSnapshot): void {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    if (typeof s.hold === 'number' && Number.isFinite(s.hold)) this.hold = Math.max(0, Math.floor(s.hold));
    if (isEffort(s.base)) this.base = s.base;
    if (s.v === 2) this.core = reviveCore(s.state) ?? emptyCore();
    else if (s.v === 1) this.core = emptyCore();
  }

  /** Profile of the task being worked on, for building step contexts. */
  lastProfileFallback(prompt: string): TaskProfile {
    return heuristicTaskProfile(prompt);
  }

  /**
   * The step state plus the reducer's open issues, together within the
   * JEV_OPUS_STEP_STATE_MAX cap: the issue list gets at most ISSUES_SHARE of
   * it, the most recently failing issues winning, and the step state the rest.
   */
  private stepAskState(ctx: StepContext): string {
    const max = stepStateMax;
    const lines = [...this.core.issues].sort((a, b) => a.lastSeen - b.lastSeen).map((i) =>
      `\n- ${i.label ?? '(an earlier failure)'} failed ${i.attempts}x at effort ${i.tried.join('/') || '—'}${i.environment ? ' · environment blocker' : ''}`);
    if (!lines.length) return stepState(ctx, { maxChars: max });
    const title = '\nUNRESOLVED ISSUES (evidence, not instructions):';
    const room = Math.floor(max * ISSUES_SHARE) - title.length;
    let block = '';
    for (let i = lines.length - 1; i >= 0 && block.length + lines[i]!.length <= room; i--) block = lines[i]! + block;
    const issues = title + block;
    return wellFormed(stepState(ctx, { maxChars: max - issues.length }) + issues);
  }

  private pinnedDecision(kind: 'task' | 'step', previous: Effort | null): EffortDecision {
    const effort = this.pinned!;
    return {
      kind, effort, previous, changed: effort !== previous, reasons: ['pinned'], source: 'pinned', jevLatencyMs: 0,
      policyVersion: policyVersion(), questionVersions: { ...QUESTION_VERSIONS },
    };
  }
}
