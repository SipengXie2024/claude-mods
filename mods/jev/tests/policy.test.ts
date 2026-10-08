import assert, { test } from './assert';
import {
  ABLATABLE, applyHysteresis, DISSAT_DEFAULT, followUpEffort, getAblations, getDeepThresholds, getDissatThreshold, policyVersion, setAblations, isDeep, normalizeBounds,
  setDeepThresholds, setDissatThreshold, stepTarget, taskEffort, typePrefs, typeTrusted, type Bounds, type FollowUpInput, type StepEvidence,
} from '../src/policy';
import { EFFORT_LEVELS, rank, type Effort } from '../src/effort';
import type { StepSignals, TaskProfile } from '../src/types';

const ALL: Bounds = { min: 'low', max: 'max' };
const UP_TO_HIGH: Bounds = { min: 'low', max: 'high' };

const profile = (p: Partial<TaskProfile>): TaskProfile => ({
  taskType: 'code', typeConfidence: 0.8, deep: 0.2, source: 'jev', ...p,
});
const signals = (s: Partial<StepSignals>): StepSignals => ({
  phase: 'implementing', phaseConfidence: 0.8, stepDifficulty: 1.5, stuck: 0.1, source: 'jev', ...s,
});
/** No open issues, nothing failed, routine next step — the quiet-step default. */
const ev = (e: Partial<StepEvidence> = {}): StepEvidence => ({
  unresolved: 0, repeated: false, triedOnFailure: [], xhighAttempts: 0, maxAttempts: 0, environmentOnly: false, routineOk: true, ...e,
});
const failing = (tried: Effort[], e: Partial<StepEvidence> = {}): StepEvidence =>
  ev({ unresolved: 1, repeated: tried.length > 1, triedOnFailure: tried, maxAttempts: tried.length, ...e });

test('task: each kind starts at its base (chat low, code/explain/operate/write/research medium)', () => {
  const starts: Array<[TaskProfile['taskType'], Effort]> = [
    ['chat', 'low'], ['explain', 'medium'], ['operate', 'medium'], ['write', 'medium'], ['research', 'medium'], ['code', 'medium'],
  ];
  for (const [taskType, effort] of starts) {
    assert.equal(taskEffort(profile({ taskType }), ALL).effort, effort, taskType);
    assert.equal(taskEffort(profile({ taskType, source: 'heuristic', typeConfidence: 0.5 }), ALL).effort, effort, `heuristic ${taskType}`);
  }
});

test('task: without deep reasoning the task level never exceeds its base, whatever the kind', () => {
  for (const taskType of ['chat', 'explain', 'operate', 'write', 'research', 'code'] as const) {
    for (const deep of [0, 0.3, 0.49]) {
      assert.ok(['low', 'medium'].includes(taskEffort(profile({ taskType, deep }), ALL).effort), `${taskType} ${deep}`);
    }
  }
});

test('task: deep ≥ 0.5 starts a non-code task at high; deep code stays at medium', () => {
  for (const taskType of ['chat', 'explain', 'operate', 'write', 'research'] as const) {
    const p = profile({ taskType, typeConfidence: 0.9, deep: 0.6 });
    assert.equal(taskEffort(p, ALL).effort, 'high', taskType);
  }
  const deepCode = profile({ taskType: 'code', typeConfidence: 0.9, deep: 0.99 });
  assert.equal(taskEffort(deepCode, ALL).effort, 'medium');
  assert.deepEqual(typePrefs(profile({ taskType: 'write', typeConfidence: 0.9, deep: 0.5 })), { floor: 'low', base: 'high' });
  assert.deepEqual(typePrefs(profile({ taskType: 'explain', typeConfidence: 0.9, deep: 0.9 })), { floor: 'low', base: 'high' });
  const d = taskEffort(profile({ taskType: 'write', typeConfidence: 0.9, deep: 0.62 }), ALL);
  assert.ok(d.reasons.some((r) => r.includes('deep reasoning')), d.reasons.join('; '));
  // deep never goes above high at task level: xhigh/max only come from step escalation
  assert.equal(taskEffort(profile({ taskType: 'research', deep: 1 }), ALL).effort, 'high');
});

test('task: code is floored at medium', () => {
  assert.deepEqual(typePrefs(profile({ taskType: 'code' })), { floor: 'medium', base: 'medium' });
  assert.equal(taskEffort(profile({ taskType: 'code', deep: 0 }), ALL).effort, 'medium');
});

test('task: low kind confidence skips the kind range for the untrusted one', () => {
  assert.equal(taskEffort(profile({ taskType: 'chat', typeConfidence: 0.1 }), ALL).effort, 'medium');
  assert.equal(taskEffort(profile({ taskType: 'chat', typeConfidence: 0.1, deep: 0.8 }), ALL).effort, 'high');
});

test('task: an old journaled profile without deep (task.v2 fields) is an untrusted kind and does not throw', () => {
  const old = { taskType: 'analysis', typeConfidence: 0.9, difficulty: 2, stakes: 0.1, source: 'jev' } as unknown as TaskProfile;
  assert.equal(typeTrusted(old), false);
  assert.equal(isDeep(old), false, 'missing deep counts as 0.4: neither deep nor confidently shallow');
  assert.deepEqual(typePrefs(old), { floor: 'low', base: 'medium' });
  const d = taskEffort(old, ALL);
  assert.equal(d.effort, 'medium');
  // a known v3 kind with a missing or non-finite deep keeps its start and does not throw
  const noDeep = { taskType: 'chat', typeConfidence: 0.9, source: 'jev' } as unknown as TaskProfile;
  assert.deepEqual(typePrefs(noDeep), { floor: 'low', base: 'low' });
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.9, deep: Number.NaN })), { floor: 'low', base: 'low' });
});

test('task: bounds clamp the task level', () => {
  assert.equal(taskEffort(profile({ taskType: 'research', deep: 0.9 }), { min: 'low', max: 'medium' }).effort, 'medium');
  assert.equal(taskEffort(profile({ taskType: 'chat', typeConfidence: 0.9, deep: 0.1 }), { min: 'medium', max: 'max' }).effort, 'medium');
  assert.equal(taskEffort(profile({ taskType: 'write', deep: 0.9 }), UP_TO_HIGH).effort, 'high');
});

test('task: misordered bounds are swapped, not fatal', () => {
  assert.deepEqual(normalizeBounds({ min: 'high', max: 'low' }), { min: 'low', max: 'high' });
  assert.deepEqual(normalizeBounds(ALL), ALL);
  assert.equal(taskEffort(profile({ taskType: 'research', deep: 0.9 }), { min: 'high', max: 'low' }).effort, 'high');
  assert.equal(taskEffort(profile({ taskType: 'chat', typeConfidence: 0.9, deep: 0.1 }), { min: 'high', max: 'low' }).effort, 'low');
});

test('step: no phase moves effort; a diagnosing step without a failed check stays at the task level', () => {
  assert.equal(stepTarget('high', signals({ phase: 'exploring' }), ev(), 'high').effort, 'high');
  assert.equal(stepTarget('high', signals({ phase: 'verifying' }), ev(), 'high').effort, 'high');
  assert.equal(stepTarget('medium', signals({ phase: 'diagnosing' }), ev(), 'medium').effort, 'medium');
  // the failure floor still raises a diagnosing step that follows a failed check
  assert.equal(stepTarget('medium', signals({ phase: 'diagnosing' }), failing(['medium']), 'medium').effort, 'high');
  assert.equal(stepTarget('medium', signals({ phase: 'implementing' }), ev(), 'medium').effort, 'medium');
});

test('step: finishing and trivial steps keep the task level', () => {
  assert.equal(stepTarget('xhigh', signals({ phase: 'finishing', stepDifficulty: 1 }), ev(), 'xhigh').effort, 'xhigh');
  assert.equal(stepTarget('medium', signals({ phase: 'exploring', stepDifficulty: 0.4 }), ev(), 'medium').effort, 'medium');
});

test('step: a hard next step lifts to high even while exploring', () => {
  assert.equal(stepTarget('medium', signals({ phase: 'exploring', stepDifficulty: 3.6 }), ev(), 'medium').effort, 'high');
});

test('step: a new failure escalates one above the current attempt', () => {
  const e = failing(['medium']);
  assert.equal(stepTarget('medium', signals({}), e, 'medium').effort, 'high');
  assert.equal(stepTarget('low', signals({}), failing(['low']), 'low').effort, 'medium');
});

test('step: a repeated failure escalates above the highest effort already tried', () => {
  // not anchored to the base estimate: tried low+medium → high even though base is low
  assert.equal(stepTarget('low', signals({}), failing(['low', 'medium']), 'medium').effort, 'high');
  assert.equal(stepTarget('low', signals({}), failing(['low', 'medium', 'high']), 'high').effort, 'xhigh');
  // one xhigh failure holds at xhigh; the second failure at xhigh on the same issue opens max
  assert.equal(stepTarget('low', signals({}), failing(['low', 'medium', 'high', 'xhigh'], { xhighAttempts: 1 }), 'xhigh').effort, 'xhigh');
  assert.equal(stepTarget('low', signals({}), failing(['low', 'medium', 'high', 'xhigh'], { xhighAttempts: 2 }), 'xhigh').effort, 'max');
});

test('step: unresolved issues block de-escalation; routine evidence is required', () => {
  // exploring would normally drop a level — an open issue holds the effort
  assert.equal(stepTarget('medium', signals({ phase: 'exploring' }), ev({ unresolved: 1 }), 'high').effort, 'high');
  // and with no issues, a non-routine next step still cannot lower effort
  assert.equal(stepTarget('medium', signals({ phase: 'diagnosing' }), ev({ routineOk: false }), 'high').effort, 'high');
  assert.equal(stepTarget('medium', signals({ phase: 'implementing' }), ev({ routineOk: false }), 'high').effort, 'high');
});

test('step: environment blockers hold the current effort and never escalate', () => {
  assert.equal(stepTarget('medium', signals({ phase: 'diagnosing', stepDifficulty: 3 }), ev({ environmentOnly: true }), 'medium').effort, 'medium');
  assert.equal(stepTarget('high', signals({ phase: 'exploring' }), ev({ environmentOnly: true }), 'high').effort, 'high');
});

test('step: stuck escalates by two from the task level', () => {
  assert.equal(stepTarget('low', signals({ phase: 'diagnosing', stuck: 0.8 }), ev({ unresolved: 1 }), 'low').effort, 'high');
  assert.equal(stepTarget('medium', signals({ phase: 'diagnosing', stuck: 0.8 }), ev({ unresolved: 2, maxAttempts: 2 }), 'medium').effort, 'xhigh');
});

test('step: never below the task level', () => {
  assert.equal(stepTarget('xhigh', signals({ phase: 'exploring', stepDifficulty: 0.2 }), ev(), 'medium').effort, 'xhigh');
});

test('step: every kind escalates past high on repeated failures, to max after xhigh fails twice', () => {
  // confident, shallow research: no kind ceiling below xhigh
  const d = stepTarget('medium', signals({}), failing(['medium', 'high']), 'high');
  assert.equal(d.effort, 'xhigh');
  assert.equal(stepTarget('medium', signals({}), failing(['medium', 'high', 'xhigh'], { xhighAttempts: 2 }), 'xhigh').effort, 'max');
  assert.equal(stepTarget('high', signals({}), failing(['high', 'xhigh'], { xhighAttempts: 2 }), 'xhigh').effort, 'max');
});

test('kind trust: start follows the kind from 0.35', () => {
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.8, deep: 0.1 })), { floor: 'low', base: 'low' });
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.44, deep: 0.1 })), { floor: 'low', base: 'low' });
  // not deep (deep < 0.5): no deep lift
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.9, deep: 0.4 })), { floor: 'low', base: 'low' });
  assert.deepEqual(typePrefs(profile({ taskType: 'research', typeConfidence: 0.6, deep: 0.2 })), { floor: 'low', base: 'medium' });
  assert.deepEqual(typePrefs(profile({ taskType: 'write', typeConfidence: 0.9, deep: 0.35 })), { floor: 'low', base: 'medium' });
  assert.deepEqual(typePrefs(profile({ taskType: 'code', typeConfidence: 0.4 })), { floor: 'medium', base: 'medium' });
  assert.deepEqual(typePrefs(profile({ taskType: 'write', typeConfidence: 0.5, deep: 0.3, source: 'heuristic' })), { floor: 'low', base: 'medium' });
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.5, deep: 0.1, source: 'heuristic' })), { floor: 'low', base: 'low' });
  assert.equal(typeTrusted(profile({ taskType: 'chat', typeConfidence: 0.2, source: 'heuristic' })), true);
  // below 0.35 a Jev kind is not trusted at all
  assert.equal(typeTrusted(profile({ taskType: 'chat', typeConfidence: 0.2 })), false);
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.2 })), { floor: 'low', base: 'medium' });
});

test('chat: a confident, shallow chat task escalates freely on repeated failures', () => {
  const d = taskEffort(profile({ taskType: 'chat', typeConfidence: 0.9, deep: 0.1 }), ALL);
  assert.equal(d.effort, 'low');
  assert.equal(stepTarget(d.effort, signals({}), failing(['low', 'medium']), 'medium').effort, 'high');
  assert.equal(stepTarget(d.effort, signals({}), failing(['low', 'medium', 'high']), 'high').effort, 'xhigh');
  assert.equal(stepTarget(d.effort, signals({}), failing(['high', 'xhigh'], { xhighAttempts: 2 }), 'xhigh').effort, 'max');
});

test('step: low phase confidence keeps the task level', () => {
  assert.equal(stepTarget('high', signals({ phase: 'exploring', phaseConfidence: 0.1 }), ev(), 'high').effort, 'high');
});

test('hysteresis: raise now, hold one step, then step down one level at a time', () => {
  let h = applyHysteresis('low', 'high', 0, false);
  assert.deepEqual([h.effort, h.hold], ['high', 1]);
  h = applyHysteresis('high', 'low', h.hold, false);
  assert.deepEqual([h.effort, h.hold], ['high', 0]);
  h = applyHysteresis('high', 'low', h.hold, false);
  assert.equal(h.effort, 'medium');
  h = applyHysteresis('medium', 'low', h.hold, false);
  assert.equal(h.effort, 'low');
});

test('hysteresis: finishing drops straight to target even during a hold', () => {
  assert.equal(applyHysteresis('high', 'low', 1, true).effort, 'low');
});

/* ---------- per-kind {floor, base} ---------- */

const KINDS = ['chat', 'explain', 'operate', 'write', 'research', 'code'] as const;

test('v3 step: max needs xhigh already lost twice (or stuck ≥ 0.9)', () => {
  assert.equal(stepTarget('high', signals({ phase: 'diagnosing' }), failing(['high', 'xhigh'], { xhighAttempts: 2 }), 'xhigh').effort, 'max');
  // xhigh never tried: escalation stops at xhigh
  assert.equal(stepTarget('high', signals({ phase: 'diagnosing' }), failing(['medium', 'high']), 'high').effort, 'xhigh');
  assert.equal(stepTarget('high', signals({ phase: 'diagnosing', stuck: 0.95 }), ev({ unresolved: 1, maxAttempts: 1 }), 'xhigh').effort, 'max');
});

test('v4: bounds low..high clamp every kind, confidence and deep to ≤ high', () => {
  for (const taskType of KINDS) {
    for (const deep of [0, 0.3, 0.55, 1]) {
      for (const typeConfidence of [0.2, 0.9]) {
        const e = taskEffort(profile({ taskType, deep, typeConfidence }), UP_TO_HIGH).effort;
        assert.ok(['low', 'medium', 'high'].includes(e), `${taskType} ${deep} ${typeConfidence} → ${e}`);
      }
    }
  }
});

test('deep thresholds are per-backend and fall back to neutral defaults when invalid', () => {
  const write08 = profile({ taskType: 'write', typeConfidence: 0.9, deep: 0.8 });
  try {
    setDeepThresholds({ yes: 0.88, no: 0.3 });
    assert.deepEqual(getDeepThresholds(), { yes: 0.88, no: 0.3 });
    // 0.8 is below the calibrated yes: a confident, not-deep-enough write stays medium
    assert.equal(taskEffort(write08, ALL).effort, 'medium');
    assert.equal(taskEffort(profile({ taskType: 'write', typeConfidence: 0.9, deep: 0.9 }), ALL).effort, 'high');
    setDeepThresholds({ yes: 0.2, no: 0.6 });
    assert.deepEqual(getDeepThresholds(), { yes: 0.5, no: 0.3 });
  } finally {
    setDeepThresholds({ yes: 0.5, no: 0.3 });
  }
});

test('ablations switch off exactly one rule each and are recorded in the policy version', () => {
  const deepResearch = profile({ taskType: 'research', typeConfidence: 0.9, deep: 0.95 });
  const stuckFail = ev({ unresolved: 1, maxAttempts: 1 });
  try {
    setDeepThresholds({ yes: 0.88, no: 0.3 });
    assert.deepEqual([...ABLATABLE], ['r1', 'r4', 'stuck', 'dissat']);
    assert.equal(policyVersion(), 'policy.v8');
    assert.equal(taskEffort(deepResearch, ALL).effort, 'high');
    assert.equal(stepTarget('medium', signals({ stepDifficulty: 3.5 }), ev(), 'medium').effort, 'high');
    assert.equal(stepTarget('medium', signals({ phase: 'diagnosing', stuck: 0.8 }), stuckFail, 'medium').effort, 'xhigh');

    setAblations(['r1']);
    assert.equal(taskEffort(deepResearch, ALL).effort, 'medium');
    // r2 no longer exists: it is ignored like any unknown name
    setAblations(['r2']);
    assert.deepEqual(getAblations(), []);
    assert.equal(policyVersion(), 'policy.v8');
    setAblations(['r4']);
    assert.equal(stepTarget('medium', signals({ stepDifficulty: 3.5 }), ev(), 'medium').effort, 'medium');
    setAblations(['stuck']);
    assert.equal(stepTarget('medium', signals({ phase: 'diagnosing', stuck: 0.8 }), stuckFail, 'medium').effort, 'medium');
    assert.equal(stepTarget('high', signals({ phase: 'diagnosing', stuck: 0.95 }), ev({ unresolved: 1, maxAttempts: 1 }), 'xhigh').effort, 'xhigh');

    setAblations(['stuck', 'bogus', 'r1']);
    assert.deepEqual(getAblations(), ['r1', 'stuck']);
    assert.equal(policyVersion(), 'policy.v8-ablate:r1,stuck');
  } finally {
    setAblations([]);
    setDeepThresholds({ yes: 0.5, no: 0.3 });
  }
});

test('step: an escalation stopped by the two-xhigh-failures gate says so', () => {
  const d = stepTarget('medium', signals({ phase: 'diagnosing' }), ev({ unresolved: 1, repeated: true, triedOnFailure: ['xhigh'], xhighAttempts: 1 }), 'xhigh');
  assert.equal(d.effort, 'xhigh');
  assert.ok(d.reasons.includes('max only after xhigh fails twice → xhigh'), d.reasons.join('; '));
});

/* ---------- follow-up fault signal ---------- */

/** A confident complaint after a medium prompt, advisor allowed and callable. */
const fu = (over: Partial<FollowUpInput> = {}): FollowUpInput => ({
  p: 0.99, base: 'medium', prevMax: 'medium', prevDissatisfied: false, prevStreak: 0, prevHiLosses: 0,
  bounds: ALL, shadow: false, advisorOption: true, advisorAvailable: true, ...over,
});

function withDissat(fn: () => void): void {
  setDissatThreshold(0.98);
  try { fn(); } finally { setDissatThreshold(DISSAT_DEFAULT); setAblations([]); }
}

test('follow-up: the library default never fires; invalid thresholds fall back to it', () => {
  assert.equal(getDissatThreshold(), DISSAT_DEFAULT);
  const d = followUpEffort(fu({ p: 1 }));
  assert.equal(d.effort, 'medium');
  assert.equal(d.followUp.yes, false);
  setDissatThreshold(1.5);
  assert.equal(getDissatThreshold(), DISSAT_DEFAULT);
  setDissatThreshold(Number.NaN);
  assert.equal(getDissatThreshold(), DISSAT_DEFAULT);
});

test('follow-up: below the threshold or without an answer nothing is raised', () => {
  withDissat(() => {
    const low = followUpEffort(fu({ p: 0.9, prevDissatisfied: true, prevStreak: 2, prevHiLosses: 1 }));
    assert.equal(low.effort, 'medium');
    assert.deepEqual(low.followUp, { p: 0.9, threshold: 0.98, yes: false, prevMax: 'medium', streak: 0, hiLosses: 0, advisor: false, shadow: false });
    assert.deepEqual(low.reasons, []);
    const none = followUpEffort(fu({ p: null }));
    assert.equal(none.effort, 'medium');
    assert.equal(none.followUp.yes, false);
    assert.ok(!('p' in none.followUp));
  });
});

test('follow-up: a complaint starts one level above the previous prompt\'s highest effort', () => {
  withDissat(() => {
    const m = followUpEffort(fu());
    assert.equal(m.effort, 'high');
    assert.equal(m.followUp.raisedTo, 'high');
    assert.equal(m.followUp.streak, 1);
    assert.equal(m.followUp.hiLosses, 0);
    assert.deepEqual(m.reasons, ['your last message says the agent got it wrong (0.99) → high (one above medium)']);
    const h = followUpEffort(fu({ prevMax: 'high', prevDissatisfied: true, prevStreak: 1 }));
    assert.equal(h.effort, 'xhigh');
    assert.equal(h.followUp.streak, 2);
    assert.equal(h.followUp.hiLosses, 0);
    assert.equal(h.followUp.advisor, false);
  });
});

test('follow-up: xhigh stays xhigh on the first complaint; the second reaches max and asks for the advisor', () => {
  withDissat(() => {
    const first = followUpEffort(fu({ prevMax: 'xhigh' }));
    assert.equal(first.effort, 'xhigh');
    assert.equal(first.followUp.hiLosses, 1);
    assert.equal(first.followUp.advisor, false);
    assert.deepEqual(first.reasons, ['your last message says the agent got it wrong (0.99) → stays xhigh: max only after xhigh fails twice']);
    const second = followUpEffort(fu({ prevMax: 'xhigh', prevDissatisfied: true, prevStreak: 1, prevHiLosses: 1 }));
    assert.equal(second.effort, 'max');
    assert.equal(second.followUp.hiLosses, 2);
    assert.equal(second.followUp.advisor, true);
    assert.ok(second.reasons.includes('advisor nudge'));
    // A complaint in between that was not a fault breaks the run: hiLosses restarts.
    assert.equal(followUpEffort(fu({ prevMax: 'xhigh', prevDissatisfied: false, prevHiLosses: 1 })).followUp.hiLosses, 1);
  });
});

test('follow-up: a complaint after max keeps max and asks for the advisor; without the advisor it only raises', () => {
  withDissat(() => {
    const m = followUpEffort(fu({ prevMax: 'max' }));
    assert.equal(m.effort, 'max');
    assert.equal(m.followUp.advisor, true);
    for (const off of [{ advisorAvailable: false }, { advisorOption: false }]) {
      const d = followUpEffort(fu({ prevMax: 'xhigh', prevDissatisfied: true, prevHiLosses: 1, ...off }));
      assert.equal(d.effort, 'max');
      assert.equal(d.followUp.advisor, false);
      assert.ok(!d.reasons.includes('advisor nudge'));
    }
  });
});

test('follow-up: bounds.max high caps the raise; a second complaint at high asks for the advisor', () => {
  withDissat(() => {
    const first = followUpEffort(fu({ prevMax: 'high', bounds: UP_TO_HIGH }));
    assert.equal(first.effort, 'high');
    assert.equal(first.followUp.raisedTo, 'high');
    assert.equal(first.followUp.hiLosses, 1);
    assert.equal(first.followUp.advisor, false);
    assert.ok(first.reasons.includes('bounded to high'), first.reasons.join('; '));
    const second = followUpEffort(fu({ prevMax: 'high', bounds: UP_TO_HIGH, prevDissatisfied: true, prevStreak: 1, prevHiLosses: 1 }));
    assert.equal(second.effort, 'high');
    assert.equal(second.followUp.hiLosses, 2);
    assert.equal(second.followUp.advisor, true);
  });
});

test('follow-up: a task level above the raise is kept; bounds.min still applies', () => {
  withDissat(() => {
    const kept = followUpEffort(fu({ base: 'xhigh', prevMax: 'low' }));
    assert.equal(kept.effort, 'xhigh');
    assert.ok(!('raisedTo' in kept.followUp));
    assert.equal(kept.followUp.yes, true);
    const floored = followUpEffort(fu({ base: 'low', prevMax: 'low', bounds: { min: 'high', max: 'max' } }));
    assert.equal(floored.effort, 'high');
  });
});

test('follow-up property: a raise is at most one above the previous prompt, and max needs two top-level losses', () => {
  withDissat(() => {
    for (const prevMax of EFFORT_LEVELS) for (const base of EFFORT_LEVELS) for (const max of EFFORT_LEVELS)
      for (const prevDissatisfied of [false, true]) for (const prevHiLosses of [0, 1, 2]) {
        const bounds: Bounds = { min: 'low', max };
        if (rank(base) > rank(max)) continue;
        const d = followUpEffort(fu({ prevMax, base, bounds, prevDissatisfied, prevHiLosses, prevStreak: prevDissatisfied ? 1 : 0 }));
        const where = `${prevMax}/${base}/${max}/${prevDissatisfied}/${prevHiLosses}`;
        assert.ok(rank(d.effort) >= rank(base), where);
        assert.ok(rank(d.effort) <= rank(max), where);
        if (d.followUp.raisedTo) {
          assert.ok(rank(d.effort) <= rank(prevMax) + 1, where);
          if (d.effort === 'max') assert.ok(d.followUp.hiLosses >= 2 || prevMax === 'max', where);
        }
      }
  });
});

test('follow-up: shadow mode and the dissat ablation record the signal but never act', () => {
  withDissat(() => {
    const shadow = followUpEffort(fu({ prevMax: 'max', shadow: true }));
    assert.equal(shadow.effort, 'medium');
    assert.deepEqual(shadow.followUp, { p: 0.99, threshold: 0.98, yes: true, prevMax: 'max', streak: 1, hiLosses: 1, advisor: false, shadow: true });
    setAblations(['dissat']);
    assert.equal(policyVersion(), 'policy.v8-ablate:dissat');
    const ablated = followUpEffort(fu());
    assert.equal(ablated.effort, 'medium');
    assert.equal(ablated.followUp.shadow, true);
    assert.equal(ablated.followUp.yes, true);
  });
});
