import { clampEffort, fromRank, maxEffort, minEffort, rank, type Effort } from './effort';
import type { TaskType } from './questions';
import type { FollowUpRecord, StepSignals, TaskProfile } from './types';

/**
 * Pure mapping from evidence and Jev signals to an effort level, for Opus and
 * Mythos alike.
 *
 * Task starts follow Anthropic's five-level effort guidance as the user
 * applies it (policy.v9, 2026-10-21): `low` for simple edits and operations,
 * `medium` for everyday questions and documents, `high` (the Claude Code
 * default) for coding and research, `xhigh` for work that needs something
 * worked out on top of that, and `max` only after xhigh has failed twice on
 * the same issue, since max costs far more and does not always beat xhigh.
 * Every task starts at or above its kind's floor; bounds apply after that.
 * Steps never run below the task's own level: phase only explains, it never
 * lowers.
 */

export interface Bounds {
  min: Effort;
  max: Effort;
}

/** Version of this policy, recorded on every decision for provenance. */
export const POLICY_VERSION = 'policy.v9';

/**
 * Rules an A/B run can switch off to measure them:
 * r1 = deep raises a task one level (at least high), r4 = step difficulty lifts effort,
 * stuck = the stuck jump, dissat = the follow-up fault signal runs in shadow
 * (asked and recorded, never acted on). Set once at startup from
 * JEV_OPUS_ABLATE; every decision records them via policyVersion().
 */
export const ABLATABLE = ['r1', 'r4', 'stuck', 'dissat'] as const;
export type Ablation = (typeof ABLATABLE)[number];
let ablated = new Set<Ablation>();

export function setAblations(list: readonly string[]): void {
  ablated = new Set(list.filter((x): x is Ablation => (ABLATABLE as readonly string[]).includes(x)));
}

export function getAblations(): Ablation[] {
  return ABLATABLE.filter((x) => ablated.has(x));
}

/** POLICY_VERSION plus any switched-off rules, e.g. "policy.v6-ablate:r1,stuck". */
export function policyVersion(): string {
  const off = getAblations();
  return off.length ? `${POLICY_VERSION}-ablate:${off.join(',')}` : POLICY_VERSION;
}

/** Misordered bounds are a configuration error: swap them rather than crash. */
export function normalizeBounds(b: Bounds): Bounds {
  return rank(b.min) <= rank(b.max) ? b : { min: b.max, max: b.min };
}

const MEDIUM = 1, HIGH = 2, XHIGH = 3, MAX = 4;

export interface TypePrefs {
  floor: Effort;
  base: Effort;
}

/**
 * Per-kind start and floor, from the effort table the user keeps (Anthropic's
 * guidance for the 5.x models): simple edits and operations low; everyday
 * questions and document work medium; coding (PRs, tests) and research
 * (surveys, comparisons, anything that must look things up, which low
 * tends to skip) high. Not yet fitted to measured outcomes.
 */
export const TYPE_PREFS: Record<TaskType, TypePrefs> = {
  chat: { floor: 'low', base: 'low' },
  explain: { floor: 'low', base: 'medium' },
  operate: { floor: 'low', base: 'low' },
  write: { floor: 'low', base: 'medium' },
  research: { floor: 'medium', base: 'high' },
  code: { floor: 'medium', base: 'high' },
};

/** Start and floor used when the task kind itself is not trusted: the general default level. */
export const UNTRUSTED_TYPE: TypePrefs = { floor: 'low', base: 'high' };

/** Start and floor follow the kind when heuristics decided or Jev is reasonably sure. */
const TYPE_TRUST = 0.35;
/**
 * deep at or above `yes` starts a non-code task at high; at or below `no` it
 * counts as confidently not deep, which no rule currently acts on. Each Jev backend spreads
 * its probabilities differently (ruling + Qwen3.6-35B-A3B says 0.77 on average
 * for deep prompts and 0.41 for the rest), so the CLI sets them once at startup
 * from JEV_OPUS_DEEP_YES / JEV_OPUS_DEEP_NO; library callers and tests keep the
 * neutral defaults.
 */
export const DEEP_DEFAULTS = { yes: 0.5, no: 0.3 } as const;
let deepThresholds: { yes: number; no: number } = { ...DEEP_DEFAULTS };

export function setDeepThresholds(t: { yes: number; no: number }): void {
  const ok = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
  deepThresholds = ok(t.yes) && ok(t.no) && t.no < t.yes ? { yes: t.yes, no: t.no } : { ...DEEP_DEFAULTS };
}

export function getDeepThresholds(): { yes: number; no: number } {
  return { ...deepThresholds };
}

/** A deep value that counts as neither yes nor no under the current thresholds. */
export function unknownDeep(): number {
  return (deepThresholds.yes + deepThresholds.no) / 2;
}

/** Profiles journaled before task.v3 have no deep: treat it as unknown. */
function deepOf(p: TaskProfile): number {
  return typeof p.deep === 'number' && Number.isFinite(p.deep) ? p.deep : unknownDeep();
}

export function typeTrusted(p: TaskProfile): boolean {
  return (p.source === 'heuristic' || p.typeConfidence >= TYPE_TRUST) && Object.hasOwn(TYPE_PREFS, p.taskType);
}

export function isDeep(p: TaskProfile): boolean {
  return deepOf(p) >= deepThresholds.yes;
}

export function typePrefs(p: TaskProfile): TypePrefs {
  let prefs = typeTrusted(p) ? TYPE_PREFS[p.taskType] : UNTRUSTED_TYPE;
  if (isDeep(p) && !ablated.has('r1')) {
    // Working something out costs one level over the kind's start, at least
    // high: a bug traced across files or an architecture rewrite is xhigh
    // work, a document that needs a design decision is high. An untrusted
    // kind only reaches high: xhigh needs to know what the work is. Max is
    // never a task start; it comes from step escalation alone.
    const trusted = typeTrusted(p);
    const base = trusted ? maxEffort(fromRank(rank(prefs.base) + 1), 'high') : maxEffort(prefs.base, 'high');
    prefs = { ...prefs, base: minEffort(base, 'xhigh') };
  }
  return prefs;
}

export function taskEffort(p: TaskProfile, bounds: Bounds): { effort: Effort; reasons: string[] } {
  const reasons: string[] = [];
  const prefs = typePrefs(p);
  const trusted = typeTrusted(p);
  let r = rank(prefs.base);
  const label = trusted ? p.taskType : 'untyped';
  if (isDeep(p)) reasons.push(`${label}, needs deep reasoning (${deepOf(p).toFixed(2)}) → ${prefs.base}${ablated.has('r1') ? ' (r1 off)' : ''}`);
  else reasons.push(trusted ? `${p.taskType} → ${prefs.base}` : `kind unsure (${p.typeConfidence.toFixed(2)}) → ${prefs.base}`);

  if (r < rank(prefs.floor)) { r = rank(prefs.floor); reasons.push(`${label} floor ${prefs.floor}`); }

  const nb = normalizeBounds(bounds);
  const effort = clampEffort(fromRank(r), nb.min, nb.max);
  if (effort !== fromRank(r)) reasons.push(`bounded to ${effort}`);
  return { effort, reasons };
}

/** What the reducer observed, distilled for the policy. */
export interface StepEvidence {
  /** unresolved issues that are not environment blockers */
  unresolved: number;
  /** a non-environment issue failed again this batch (stalled recovery) */
  repeated: boolean;
  /** effort levels already tried on the non-environment issues that failed this batch */
  triedOnFailure: readonly Effort[];
  /** most batches any non-environment issue failing this batch has failed at xhigh */
  xhighAttempts: number;
  /** attempts so far on the most-retried unresolved issue */
  maxAttempts: number;
  /** every failure this batch was an environment blocker */
  environmentOnly: boolean;
  /** positive evidence that the next step is routine */
  routineOk: boolean;
  /** most edits of one file in this prompt so far (absent = not tracked) */
  fileEdits?: number;
}

/**
 * Edits of the same file within one prompt that count as stuck evidence
 * (borrowed from jev-pilot): rewriting one file again and again while an
 * issue stays open is going in circles, whatever the evaluator says.
 */
export const CHURN_EDITS = 4;

export function stepTarget(
  base: Effort,
  s: StepSignals,
  ev: StepEvidence,
  current: Effort,
): { effort: Effort; reasons: string[]; heldByIssues?: boolean } {
  const reasons: string[] = [];
  let heldByIssues = false;
  const b = rank(base);
  const c = rank(current);
  let r = b;

  const trustPhase = s.source === 'heuristic' || s.phaseConfidence >= 0.3;
  if (trustPhase) {
    // Phases never move effort: reading to understand a problem or writing the
    // final synthesis needs the task's level, and a failed check already
    // raises effort below.
    reasons.push(`${s.phase} → task level`);
  } else {
    reasons.push(`phase unclear (${s.phaseConfidence.toFixed(2)}) → task level`);
  }

  if (ablated.has('r4')) { /* step difficulty ignored */ }
  else if (s.stepDifficulty >= 3.25 && r < HIGH) { r = HIGH; reasons.push(`hard step ${s.stepDifficulty.toFixed(1)} → high`); }
  else if (s.stepDifficulty >= 2.4 && r < MEDIUM) { r = MEDIUM; reasons.push(`step ${s.stepDifficulty.toFixed(1)} → medium`); }

  // Failures escalate relative to the effort already tried on them, never the
  // initial estimate: a repeated unresolved failure goes one level above the
  // highest effort that has already failed on that issue.
  if (ev.triedOnFailure.length) {
    const tried = Math.max(c, ...ev.triedOnFailure.map(rank));
    const floor = tried + 1;
    if (r < floor) {
      r = floor;
      reasons.push(ev.repeated
        ? `same failure already lost at ${fromRank(tried)} → ${fromRank(floor)}`
        : `failed step → ${fromRank(floor)}`);
    }
  }

  const churn = (ev.fileEdits ?? 0) >= CHURN_EDITS;
  const stuck = s.stuck >= 0.7 || ev.maxAttempts >= 3 || churn;
  if (stuck && ev.unresolved > 0 && !ablated.has('stuck')) {
    // Raising works best as a large jump: go at least two levels up, at least high.
    r = Math.max(r, b + 2, HIGH);
    reasons.push(`stuck (${s.stuck.toFixed(2)}, ${ev.maxAttempts} attempts${churn ? `, one file edited ${ev.fileEdits}×` : ''}) → escalate`);
  }

  // Environment blockers hold the current effort; they never drive escalation.
  if (ev.environmentOnly) {
    if (r !== c) reasons.push('environment blocker → hold');
    r = c;
  }

  // De-escalation needs positive evidence: no unresolved reasoning issues and
  // a routine next step. A successful read or a finishing phase alone never
  // lowers effort while an issue remains open.
  if (r < c) {
    if (ev.unresolved > 0) {
      r = c;
      heldByIssues = true;
      reasons.push(`${ev.unresolved} unresolved issue(s) → hold ${current}`);
    } else if (s.phase === 'diagnosing' || !ev.routineOk) {
      r = c;
      reasons.push('no routine evidence → hold');
    }
  }

  // Never below the task's own level.
  r = Math.max(r, b);

  // Escalation stops at xhigh unless xhigh has lost twice on the same issue
  // (or the agent is badly stuck). Anthropic's Opus 5.5 guidance treats two
  // xhigh failures as the point where xhigh is exhausted. A task already
  // running at max keeps it.
  let cap = XHIGH;
  if (ev.xhighAttempts >= 2 || (ev.unresolved > 0 && s.stuck >= 0.9 && !ablated.has('stuck')) || b === MAX || c === MAX) cap = MAX;
  cap = Math.max(cap, b);
  // Say why an escalation reason above stops short, so the trail matches the effort.
  if (r > cap) reasons.push('max only after xhigh fails twice → xhigh');
  r = Math.min(r, cap);

  return { effort: fromRank(r), reasons, ...(heldByIssues ? { heldByIssues } : {}) };
}

/**
 * Anti-flapping: raises apply at once; after a raise the level is held for
 * one more step; decreases step down one level at a time (except when the
 * work is finishing, which drops straight to the target).
 */
export function applyHysteresis(
  current: Effort,
  target: Effort,
  hold: number,
  finishing: boolean,
): { effort: Effort; hold: number; note?: string } {
  const c = rank(current), t = rank(target);
  if (t > c) return { effort: target, hold: 1 };
  if (t === c) return { effort: current, hold: Math.max(0, hold - 1) };
  if (hold > 0 && !finishing) return { effort: current, hold: hold - 1, note: `holding ${current} after escalation` };
  if (finishing) return { effort: target, hold: 0 };
  const next = fromRank(c - 1);
  return { effort: next, hold: 0, note: next !== target ? `stepping down toward ${target}` : undefined };
}

/**
 * Probability at or above which a new message counts as faulting the previous
 * turn. The CLI sets it from JEV_OPUS_DISSAT_YES; library callers and tests keep
 * DISSAT_DEFAULT, which no probability reaches, so the signal never fires.
 */
export const DISSAT_DEFAULT = 1.01;
let dissatThreshold = DISSAT_DEFAULT;

export function setDissatThreshold(v: number): void {
  dissatThreshold = Number.isFinite(v) && v >= 0 && v <= 1 ? v : DISSAT_DEFAULT;
}

export function getDissatThreshold(): number {
  return dissatThreshold;
}

/** The previous prompt's outcome, read from the journal of the current branch. */
export interface FollowUpHistory {
  /** highest effort used on the previous prompt */
  prevMax: Effort;
  /** the previous prompt was itself judged as faulting the turn before it */
  prevDissatisfied: boolean;
  prevStreak: number;
  prevHiLosses: number;
}

export interface FollowUpInput extends FollowUpHistory {
  /** Jev's fault probability; null when the evaluator failed or answered invalidly */
  p: number | null;
  /** the task level taskEffort chose */
  base: Effort;
  bounds: Bounds;
  shadow: boolean;
  /** JEV_OPUS_DISSAT_ADVISOR allows the advisor note */
  advisorOption: boolean;
  /** the request offers a callable advisor tool */
  advisorAvailable: boolean;
}

/**
 * Start level for a prompt that says the previous turn got something wrong:
 * one level above the highest effort the previous prompt used, never more.
 * `max` follows the step rule: only after the top level (xhigh, or bounds.max
 * when lower) has been faulted on two prompts in a row. Once the previous
 * prompt already ran at max, or the top level lost twice, only a second opinion
 * is left: the advisor note.
 */
export function followUpEffort(i: FollowUpInput): { effort: Effort; reasons: string[]; followUp: Omit<FollowUpRecord, 'latencyMs' | 'error'> } {
  const threshold = dissatThreshold;
  const shadow = i.shadow || ablated.has('dissat');
  const yes = i.p !== null && i.p >= threshold;
  const nb = normalizeBounds(i.bounds);
  const hi = Math.min(XHIGH, rank(nb.max));
  const prev = rank(i.prevMax);
  const hiLosses = yes && prev >= hi ? (i.prevDissatisfied ? i.prevHiLosses : 0) + 1 : 0;
  const streak = yes ? (i.prevDissatisfied ? i.prevStreak + 1 : 1) : 0;
  const advisor = yes && !shadow && i.advisorOption && i.advisorAvailable && (i.prevMax === 'max' || hiLosses >= 2);

  const reasons: string[] = [];
  let effort = i.base;
  let raisedTo: Effort | undefined;
  if (yes) {
    let r = prev + 1;
    const gated = r === MAX && hiLosses < 2;
    if (gated) r = XHIGH;
    const target = clampEffort(fromRank(Math.max(rank(i.base), r)), nb.min, nb.max);
    const said = `your last message says the agent got it wrong (${i.p!.toFixed(2)})`;
    if (shadow) {
      reasons.push(`shadow: ${said}, not acted on`);
    } else {
      effort = target;
      if (rank(effort) > rank(i.base)) raisedTo = effort;
      if (gated && effort === 'xhigh') reasons.push(`${said} → stays xhigh: max only after xhigh fails twice`);
      else if (raisedTo && prev < MAX && effort === fromRank(prev + 1)) reasons.push(`${said} → ${effort} (one above ${i.prevMax})`);
      else reasons.push(`${said} → ${effort}${raisedTo ? '' : ' (task level)'}`);
      if (rank(fromRank(Math.max(rank(i.base), r))) > rank(effort)) reasons.push(`bounded to ${effort}`);
      if (advisor) reasons.push('advisor nudge');
    }
  }
  return {
    effort,
    reasons,
    followUp: {
      ...(i.p !== null ? { p: i.p } : {}), threshold, yes, prevMax: i.prevMax, streak, hiLosses,
      ...(raisedTo ? { raisedTo } : {}), advisor, shadow,
    },
  };
}
