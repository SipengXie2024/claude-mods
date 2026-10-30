import assert, { test } from './assert';
import {
  ABLATABLE, DISSAT_DEFAULT, exploreStart, followUpEffort, getAblations, getDeepThresholds, getDissatThreshold, ladderRaise, MAX_RAISES, policyVersion, setAblations, isDeep,
  modelScale, normalizeBounds, setDeepThresholds, setDissatThreshold, taskEffort, TYPE_PREFS, typePrefs, typeTrusted, type Bounds, type FollowUpInput,
} from '../src/policy';
import { EFFORT_LEVELS, rank, type Effort } from '../src/effort';
import type { TaskProfile } from '../src/types';
import type { TaskType } from '../src/questions';

const ALL: Bounds = { min: 'low', max: 'max' };
const UP_TO_HIGH: Bounds = { min: 'low', max: 'high' };

const profile = (p: Partial<TaskProfile>): TaskProfile => ({
  taskType: 'code', typeConfidence: 0.8, deep: 0.2, source: 'jev', ...p,
});
const OPUS55 = 'claude-opus-5-5';
const HIGH_DEFAULT_MODELS = ['claude-mythos-5-1', 'claude-opus-4-8', null] as const;

test('model scale: the 5.5 models read the default-medium table; Mythos, Fable, earlier Opus and an unknown model the default-high one', () => {
  for (const m of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5', 'opus']) assert.equal(modelScale(m), 'medium-default', m);
  for (const m of ['claude-mythos-5-1', 'claude-fable-5-1', 'claude-opus-5', 'claude-opus-4-8', null]) assert.equal(modelScale(m), 'high-default', String(m));
});

test('task: each kind starts at its base on its model\'s table (Opus 5.5 low where failures show, Mythos a step up)', () => {
  const opus55: Array<[TaskType, Effort]> = [
    ['chat', 'low'], ['operate', 'low'], ['explain', 'medium'], ['write', 'medium'], ['design', 'low'], ['code', 'low'], ['research', 'medium'],
  ];
  const highDefault: Array<[TaskType, Effort]> = [
    ['chat', 'low'], ['operate', 'low'], ['explain', 'medium'], ['write', 'medium'], ['design', 'medium'], ['code', 'medium'], ['research', 'high'],
  ];
  for (const [taskType, effort] of opus55) {
    assert.equal(taskEffort(profile({ taskType }), ALL, OPUS55).effort, effort, `Opus 5.5 ${taskType}`);
    assert.equal(taskEffort(profile({ taskType, source: 'heuristic', typeConfidence: 0.5 }), ALL, OPUS55).effort, effort, `Opus 5.5 heuristic ${taskType}`);
  }
  for (const model of HIGH_DEFAULT_MODELS) {
    for (const [taskType, effort] of highDefault) assert.equal(taskEffort(profile({ taskType }), ALL, model).effort, effort, `${model} ${taskType}`);
  }
});

test('task: without deep reasoning the task level never exceeds its base, whatever the kind and model', () => {
  for (const [model, scale] of [[OPUS55, 'medium-default'], ['claude-mythos-5-1', 'high-default']] as const) {
    for (const taskType of ['chat', 'explain', 'operate', 'write', 'design', 'research', 'code'] as const) {
      for (const deep of [0, 0.3, 0.49]) {
        assert.equal(taskEffort(profile({ taskType, deep }), ALL, model).effort, TYPE_PREFS[scale][taskType].base, `${model} ${taskType} ${deep}`);
      }
    }
  }
});

test('task: a task that needs something worked out starts at its kind\'s deep level, never at max', () => {
  const opus55: Array<[TaskType, Effort]> = [
    ['chat', 'low'], ['operate', 'medium'], ['explain', 'high'], ['write', 'high'], ['design', 'medium'], ['code', 'high'], ['research', 'xhigh'],
  ];
  const highDefault: Array<[TaskType, Effort]> = [
    ['chat', 'low'], ['operate', 'medium'], ['explain', 'high'], ['write', 'high'], ['design', 'high'], ['code', 'xhigh'], ['research', 'xhigh'],
  ];
  for (const [taskType, effort] of opus55) assert.equal(taskEffort(profile({ taskType, typeConfidence: 0.9, deep: 0.99 }), ALL, OPUS55).effort, effort, `Opus 5.5 ${taskType}`);
  for (const [taskType, effort] of highDefault) assert.equal(taskEffort(profile({ taskType, typeConfidence: 0.9, deep: 0.99 }), ALL, 'claude-mythos-5-1').effort, effort, `Mythos ${taskType}`);
  const d = taskEffort(profile({ taskType: 'write', typeConfidence: 0.9, deep: 0.62 }), ALL, OPUS55);
  assert.ok(d.reasons.some((r) => r.includes('deep reasoning')), d.reasons.join('; '));
  assert.deepEqual(typePrefs(profile({ taskType: 'research', typeConfidence: 0.9, deep: 0.6 }), OPUS55), { floor: 'medium', base: 'xhigh', deep: 'xhigh' });
});

test('task: code on Opus 5.5 starts low (raised when a check fails again), on the default-high table at medium', () => {
  assert.deepEqual(typePrefs(profile({ taskType: 'code' }), OPUS55), { floor: 'low', base: 'low', deep: 'high' });
  assert.deepEqual(typePrefs(profile({ taskType: 'code' })), { floor: 'medium', base: 'medium', deep: 'xhigh' });
});

test('task: low kind confidence skips the kind range for the untrusted one (the general default, high; deep adds nothing)', () => {
  assert.equal(taskEffort(profile({ taskType: 'chat', typeConfidence: 0.1 }), ALL).effort, 'high');
  assert.equal(taskEffort(profile({ taskType: 'chat', typeConfidence: 0.1, deep: 0.8 }), ALL).effort, 'high');
});

test('task: an old journaled profile without deep (task.v2 fields) is an untrusted kind and does not throw', () => {
  const old = { taskType: 'analysis', typeConfidence: 0.9, difficulty: 2, stakes: 0.1, source: 'jev' } as unknown as TaskProfile;
  assert.equal(typeTrusted(old), false);
  assert.equal(isDeep(old), false, 'missing deep counts as 0.4: neither deep nor confidently shallow');
  assert.deepEqual(typePrefs(old), { floor: 'low', base: 'high', deep: 'high' });
  const d = taskEffort(old, ALL);
  assert.equal(d.effort, 'high');
  // a known v3 kind with a missing or non-finite deep keeps its start and does not throw
  const noDeep = { taskType: 'chat', typeConfidence: 0.9, source: 'jev' } as unknown as TaskProfile;
  assert.deepEqual(typePrefs(noDeep), { floor: 'low', base: 'low', deep: 'low' });
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.9, deep: Number.NaN })), { floor: 'low', base: 'low', deep: 'low' });
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

test('kind trust: start follows the kind from 0.35', () => {
  const chat = { floor: 'low', base: 'low', deep: 'low' };
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.8, deep: 0.1 })), chat);
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.44, deep: 0.1 })), chat);
  // not deep (deep < 0.5): the kind's base
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.9, deep: 0.4 })), chat);
  assert.deepEqual(typePrefs(profile({ taskType: 'research', typeConfidence: 0.6, deep: 0.2 })), { floor: 'medium', base: 'high', deep: 'xhigh' });
  assert.deepEqual(typePrefs(profile({ taskType: 'write', typeConfidence: 0.9, deep: 0.35 })), { floor: 'low', base: 'medium', deep: 'high' });
  assert.deepEqual(typePrefs(profile({ taskType: 'code', typeConfidence: 0.4 })), { floor: 'medium', base: 'medium', deep: 'xhigh' });
  assert.deepEqual(typePrefs(profile({ taskType: 'write', typeConfidence: 0.5, deep: 0.3, source: 'heuristic' })), { floor: 'low', base: 'medium', deep: 'high' });
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.5, deep: 0.1, source: 'heuristic' })), chat);
  assert.equal(typeTrusted(profile({ taskType: 'chat', typeConfidence: 0.2, source: 'heuristic' })), true);
  // below 0.35 a Jev kind is not trusted at all
  assert.equal(typeTrusted(profile({ taskType: 'chat', typeConfidence: 0.2 })), false);
  assert.deepEqual(typePrefs(profile({ taskType: 'chat', typeConfidence: 0.2 })), { floor: 'low', base: 'high', deep: 'high' });
});


const KINDS = ['chat', 'explain', 'operate', 'write', 'research', 'code'] as const;

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
  try {
    setDeepThresholds({ yes: 0.88, no: 0.3 });
    assert.deepEqual([...ABLATABLE], ['r1', 'dissat']);
    assert.equal(policyVersion(), 'policy.v12');
    assert.equal(taskEffort(deepResearch, ALL).effort, 'xhigh');

    setAblations(['r1']);
    assert.equal(taskEffort(deepResearch, ALL).effort, 'high');
    // r2, r4 and stuck no longer exist: they are ignored like any unknown name
    setAblations(['r2', 'r4', 'stuck']);
    assert.deepEqual(getAblations(), []);
    assert.equal(policyVersion(), 'policy.v12');

    setAblations(['dissat', 'bogus', 'r1']);
    assert.deepEqual(getAblations(), ['r1', 'dissat']);
    assert.equal(policyVersion(), 'policy.v12-ablate:r1,dissat');
  } finally {
    setAblations([]);
    setDeepThresholds({ yes: 0.5, no: 0.3 });
  }
});

test('decision 3: the ladder raises one level at a time, max only from xhigh, never past the bounds', () => {
  assert.equal(ladderRaise('medium', ALL), 'high');
  assert.equal(ladderRaise('high', ALL), 'xhigh');
  assert.equal(ladderRaise('xhigh', ALL), 'max');
  assert.equal(ladderRaise('max', ALL), null);
  assert.equal(ladderRaise('high', UP_TO_HIGH), null);
  assert.equal(ladderRaise('medium', { min: 'xhigh', max: 'max' }), 'xhigh', 'a raise lands inside the range');
  for (const from of EFFORT_LEVELS) {
    const to = ladderRaise(from, ALL);
    if (to) assert.equal(rank(to), rank(from) + 1, from);
  }
  assert.equal(MAX_RAISES, 2);
});

test('decision 7: exploration moves the start one level up or down inside medium..max, with probability p', () => {
  // roll < p explores; coin < 0.5 is down
  assert.equal(exploreStart('high', ALL, 0.1, 0.05, 0.2), 'medium');
  assert.equal(exploreStart('high', ALL, 0.1, 0.05, 0.7), 'xhigh');
  assert.equal(exploreStart('high', ALL, 0.1, 0.1, 0.7), null, 'roll ≥ p: no exploration');
  assert.equal(exploreStart('high', ALL, 0, 0, 0.7), null, 'p 0 never explores');
  assert.equal(exploreStart('medium', ALL, 1, 0.5, 0.2), null, 'below medium is outside the range');
  assert.equal(exploreStart('max', ALL, 1, 0.5, 0.7), null, 'above max does not exist');
  assert.equal(exploreStart('xhigh', ALL, 1, 0.5, 0.7), 'max');
  assert.equal(exploreStart('high', UP_TO_HIGH, 1, 0.5, 0.7), null, 'the configured bounds hold');
  assert.equal(exploreStart('low', ALL, 1, 0.5, 0.7), 'medium');
  // equal odds: over a uniform coin, half the moves go each way
  const moves = Array.from({ length: 100 }, (_, i) => exploreStart('high', ALL, 1, 0, (i + 0.5) / 100));
  assert.equal(moves.filter((m) => m === 'medium').length, 50);
  assert.equal(moves.filter((m) => m === 'xhigh').length, 50);
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
    assert.equal(policyVersion(), 'policy.v12-ablate:dissat');
    const ablated = followUpEffort(fu());
    assert.equal(ablated.effort, 'medium');
    assert.equal(ablated.followUp.shadow, true);
    assert.equal(ablated.followUp.yes, true);
  });
});
