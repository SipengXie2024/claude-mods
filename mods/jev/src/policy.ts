import { clampEffort, fromRank, maxEffort, minEffort, rank, shift, type Effort } from './effort';
import { isArgon, openAIModelScale, type OpenAIModelScale } from './model';
import type { TaskType } from './questions';
import type { FollowUpRecord, TaskProfile } from './types';

/**
 * Pure mapping from evidence and Jev signals to an effort level
 * (policy.v17, 2026-11-10).
 *
 * The start comes from the task kind, read from a table per model: a level
 * name is not the same amount of thinking on every model, and Opus 5.5
 * (default medium) and Mythos 5.1 / earlier Opus (default high) have their
 * own published per-level results. The tables follow Anthropic's cost
 * guidance, start low and raise on failure, where a failure shows itself (a
 * check fails, the person says it is wrong); work whose mistakes look like
 * right answers (explanations, prose, research) starts a step higher, since
 * nothing would raise it. A kind that needs something worked out (deep)
 * starts at its own deeper level. Sources and numbers:
 * ~/.config/jev-opus/eval/effort-sources.md. A prompt whose kind is not
 * trusted starts at high: such prompts are mostly short or lean on earlier
 * context, and the person's own labels put most of them at high or above.
 * Every task starts at or above its kind's floor; bounds apply after that.
 * The level is decided once per prompt and holds for every request of its
 * turn, on Opus and Mythos alike. A check that fails again after the model
 * changed code and still fails when the turn ends starts the next prompt
 * that continues the work one level up.
 */

export interface Bounds {
  min: Effort;
  max: Effort;
}

/** Version of this policy, recorded on every decision for provenance. */
export const POLICY_VERSION = 'policy.v17';

/**
 * Rules an A/B run can switch off to measure them:
 * r1 = deep raises a task one level (at least high), dissat = the follow-up
 * fault signal runs in shadow (asked and recorded, never acted on). Set once at startup from
 * JEV_OPUS_ABLATE; every decision records them via policyVersion().
 */
export const ABLATABLE = ['r1', 'dissat'] as const;
export type Ablation = (typeof ABLATABLE)[number];
let ablated = new Set<Ablation>();

export function setAblations(list: readonly string[]): void {
  ablated = new Set(list.filter((x): x is Ablation => (ABLATABLE as readonly string[]).includes(x)));
}

export function getAblations(): Ablation[] {
  return ABLATABLE.filter((x) => ablated.has(x));
}

/** POLICY_VERSION plus any switched-off rules, e.g. "policy.v11-ablate:r1,dissat". */
export function policyVersion(): string {
  const off = getAblations();
  return off.length ? `${POLICY_VERSION}-ablate:${off.join(',')}` : POLICY_VERSION;
}

/** Misordered bounds are a configuration error: swap them rather than crash. */
export function normalizeBounds(b: Bounds): Bounds {
  return rank(b.min) <= rank(b.max) ? b : { min: b.max, max: b.min };
}

const XHIGH = 3, MAX = 4;

export interface TypePrefs {
  floor: Effort;
  base: Effort;
  /** the start when the task needs something worked out */
  deep: Effort;
}

/**
 * Which table a model follows: Opus, Sonnet and Haiku 5.5 default to medium;
 * Mythos and Fable 5.2 (one model, two safeguard settings) have their own;
 * other Mythos, Fable and earlier Opus models default to high.
 * GPT-6 Astra 和 GPT-6.1 Sol 分别使用各自的任务表。
 */
export type ModelScale = 'medium-default' | 'high-default' | 'fable-5.2' | 'argon' | OpenAIModelScale;

export function modelScale(model: string | null): ModelScale {
  const openAI = openAIModelScale(model);
  if (openAI !== null) return openAI;
  if (model !== null && /claude-(fable|mythos)-5-2(?:\[1m\])?$/i.test(model)) return 'fable-5.2';
  if (isArgon(model)) return 'argon';
  return model !== null && /claude-(opus|sonnet|haiku)-5-5|^(opus|sonnet|haiku)(\[1m\])?$/i.test(model) ? 'medium-default' : 'high-default';
}

/**
 * Start levels per kind, for each model scale. Opus 5.5: coding starts low
 * (SWE-bench Pro subset: low 87.4%, and low then high on the failures about
 * 97%), research at medium (DRACO: low 13.3 points below medium), reading and
 * shaping visuals low (its low reads charts better than Opus 5 at its
 * highest); bug hunts and deep research go to high and xhigh. Operations and
 * design start at medium: the person's labels put 5 of 11 operations and 8 of
 * 9 design prompts that started low at medium or above (eval/context-report.md,
 * 2026-11-09). Mythos 5.1
 * (Fable 5.1's numbers) and earlier Opus: research and visuals at high
 * (DeepResearch Bench II, Chartography), coding from medium up to xhigh, where
 * Fable 5.1 scores best on FrontierCode and Terminal-Bench.
 *
 * Fable / Mythos 5.2 (Artificial Analysis v5.0.1 per-level runs, low / medium /
 * high / xhigh / max, 2026-11-10): coding gains most from medium to high
 * (FrontierCode 2.0 38.4 / 41.3 / 49.1 / 47.6 / 48.8; Anthropic's own run
 * peaks at xhigh, 49.1), so code starts at medium and deep code at high.
 * Research keeps rising to max (HLE-Diamond 60.8 / 66.3 / 73.8 / 75.8 / 80.2,
 * CritPt hard 60.0 / 61.5 / 73.0 / 73.5 / 76.5, Terminal-Bench-Science 53.8 /
 * 60.5 / 70.0 / 67.6 / 73.3), and Anthropic names max for open-ended science and
 * mathematics: research starts at high, deep research at max. Operations are
 * level from low to medium (AutomationBench-AA 68.0 / 68.8 / 71.4, Terminal-Bench
 * 4.0 54.5 / 55.1 / 59.6), so they start low and deep operations skip to high.
 * Prose and knowledge work rise steadily (AA-Briefcase 1563 / 1622 / 1677 /
 * 1738 / 1785) and start at medium. At high and above the model thinks before
 * every reply, a greeting included, so chat stays low.
 *
 * Gemini 4 Argon offers low / medium / high only (Google's default medium);
 * Magpie sends a higher request as high (2026-11-10: `--effort max` → high).
 * Per-level data is thin: FrontierCode 2.0 21.5 / 23.5 / 26.3 and Zapier
 * AutomationBench medium 50.1 / high 51.3; its Arena Text results (1522 ± 5
 * overall, above Opus 5.5) are at high. Prose, design and code start at medium
 * and go to high when deep; research starts at high; operations stay low and
 * go to medium; chat low. To be recalibrated on the person's ratings.
 *
 * GPT-6 Astra (Artificial Analysis per-level runs, low / medium / high / xhigh /
 * max): its low falls far below medium on coding (FrontierCode 2.0 26 / 37 /
 * 40 / 41 / 42, Terminal-Bench 4.0 42 / 49 / 54 / 60 / 59), so code starts at
 * medium and deep code at xhigh, where Terminal-Bench peaks. Knowledge-work
 * deliverables gain most from low to medium (AA-Briefcase Elo 1256 / 1462 /
 * 1505), so prose and explanations start at medium. Research starts at high
 * (HLE-Diamond 45 / 53 / 59 / 62 / 64). Routine operations stay low (OpenAI:
 * low for "execution-oriented coding" and tool use). No per-level visual
 * benchmark exists; OpenAI names medium for slides.
 * Astra 和 Sol 的困难研究从 max 开始：Terminal-Bench Science 的 xhigh/max
 * 分别为 55/63 和 50/58。Sol 的解释、写作、设计从 high 开始，复杂任务用
 * xhigh；AA-Briefcase 的 medium/high/xhigh 为 1360/1469/1503。
 * 任务类型与评测的对应属于策略推断，来源与限制记录在 ../BENCHMARKS.md。
 */
export const TYPE_PREFS: Record<ModelScale, Record<TaskType, TypePrefs>> = {
  'medium-default': {
    chat: { floor: 'low', base: 'low', deep: 'low' },
    operate: { floor: 'low', base: 'medium', deep: 'high' },
    explain: { floor: 'low', base: 'medium', deep: 'high' },
    write: { floor: 'low', base: 'medium', deep: 'high' },
    design: { floor: 'low', base: 'medium', deep: 'high' },
    code: { floor: 'low', base: 'low', deep: 'high' },
    research: { floor: 'medium', base: 'medium', deep: 'xhigh' },
  },
  'high-default': {
    chat: { floor: 'low', base: 'low', deep: 'low' },
    operate: { floor: 'low', base: 'low', deep: 'medium' },
    explain: { floor: 'low', base: 'medium', deep: 'high' },
    write: { floor: 'low', base: 'medium', deep: 'high' },
    design: { floor: 'medium', base: 'medium', deep: 'high' },
    code: { floor: 'medium', base: 'medium', deep: 'xhigh' },
    research: { floor: 'medium', base: 'high', deep: 'xhigh' },
  },
  'fable-5.2': {
    chat: { floor: 'low', base: 'low', deep: 'low' },
    operate: { floor: 'low', base: 'low', deep: 'high' },
    explain: { floor: 'low', base: 'medium', deep: 'high' },
    write: { floor: 'low', base: 'medium', deep: 'high' },
    design: { floor: 'low', base: 'medium', deep: 'high' },
    code: { floor: 'low', base: 'medium', deep: 'high' },
    research: { floor: 'medium', base: 'high', deep: 'max' },
  },
  argon: {
    chat: { floor: 'low', base: 'low', deep: 'low' },
    operate: { floor: 'low', base: 'low', deep: 'medium' },
    explain: { floor: 'low', base: 'medium', deep: 'high' },
    write: { floor: 'low', base: 'medium', deep: 'high' },
    design: { floor: 'low', base: 'medium', deep: 'high' },
    code: { floor: 'low', base: 'medium', deep: 'high' },
    research: { floor: 'medium', base: 'high', deep: 'high' },
  },
  astra: {
    chat: { floor: 'low', base: 'low', deep: 'low' },
    operate: { floor: 'low', base: 'low', deep: 'medium' },
    explain: { floor: 'low', base: 'medium', deep: 'high' },
    write: { floor: 'low', base: 'medium', deep: 'high' },
    design: { floor: 'low', base: 'medium', deep: 'high' },
    code: { floor: 'medium', base: 'medium', deep: 'xhigh' },
    research: { floor: 'medium', base: 'high', deep: 'max' },
  },
  'sol-6.1': {
    chat: { floor: 'low', base: 'low', deep: 'low' },
    operate: { floor: 'low', base: 'low', deep: 'medium' },
    explain: { floor: 'low', base: 'high', deep: 'xhigh' },
    write: { floor: 'low', base: 'high', deep: 'xhigh' },
    design: { floor: 'low', base: 'high', deep: 'xhigh' },
    code: { floor: 'medium', base: 'medium', deep: 'xhigh' },
    research: { floor: 'medium', base: 'high', deep: 'max' },
  },
};

/** Start and floor used when the task kind itself is not trusted. */
export const UNTRUSTED_TYPE: TypePrefs = { floor: 'low', base: 'high', deep: 'high' };

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
  return (p.source === 'heuristic' || p.typeConfidence >= TYPE_TRUST) && Object.hasOwn(TYPE_PREFS['medium-default'], p.taskType);
}

export function isDeep(p: TaskProfile): boolean {
  return deepOf(p) >= deepThresholds.yes;
}

/** The kind's start and floor on this model, the deep start when the task needs something worked out (ablation r1 drops that). */
export function typePrefs(p: TaskProfile, model: string | null = null): TypePrefs {
  const prefs = typeTrusted(p) ? TYPE_PREFS[modelScale(model)][p.taskType] : UNTRUSTED_TYPE;
  return isDeep(p) && !ablated.has('r1') ? { ...prefs, base: prefs.deep } : prefs;
}

export function taskEffort(p: TaskProfile, bounds: Bounds, model: string | null = null): { effort: Effort; reasons: string[] } {
  const reasons: string[] = [];
  const prefs = typePrefs(p, model);
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

/** Start levels exploration may move to. */
export const EXPLORE_RANGE: Bounds = { min: 'medium', max: 'max' };

/**
 * Exploration of the start level: with probability `p` (`roll` < p) move
 * one level up or down (`coin` < 0.5 is down), equal odds. A move that would
 * leave medium..max or the bounds is no exploration: the start stays.
 * `roll` and `coin` are uniform draws in [0, 1).
 */
export function exploreStart(from: Effort, bounds: Bounds, p: number, roll: number, coin: number): Effort | null {
  if (!(roll < p)) return null;
  const to = shift(from, coin < 0.5 ? -1 : 1);
  const nb = normalizeBounds(bounds);
  const lo = Math.max(rank(EXPLORE_RANGE.min), rank(nb.min));
  const hi = Math.min(rank(EXPLORE_RANGE.max), rank(nb.max));
  return to !== from && rank(to) >= lo && rank(to) <= hi ? to : null;
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
