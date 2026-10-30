import assert, { test } from './assert';
import type { JevLike, JevQuestion } from '../src/jev';
import { FOLLOWUP_QUESTIONS, FOLLOWUP_SET_VERSION, TASK_QUESTIONS, TASK_SET_VERSION } from '../src/questions';
import { clipEnds, EffortRouter, FALLBACK_IGNORED, followUpState, taskState, type FollowUpAsk } from '../src/router';
import type { JevResponse } from '../src/types';
import { DISSAT_DEFAULT, POLICY_VERSION, setDeepThresholds, setDissatThreshold, DEEP_DEFAULTS } from '../src/policy';

type Answer = Record<string, unknown>;
type AskResponse = { answers?: Record<string, unknown>; signals?: Record<string, 'valid' | 'missing' | 'invalid'>; circuitOpen?: boolean; fallbackFrom?: string };

/** Scriptable Jev stub speaking the validating-client contract (absent answers + signals map). */
function stubJev(handler: (state: string, questions: Record<string, JevQuestion>) => AskResponse | 'fail' | null) {
  const calls: string[] = [];
  const jev: JevLike & { calls: string[] } = {
    enabled: true,
    calls,
    async ask(state: string, questions: Record<string, JevQuestion>) {
      calls.push(state);
      const r = handler(state, questions);
      if (r === 'fail' || r === null) {
        return { answers: {}, failed: true, error: 'jev down', latencyMs: 1, inputTokens: 0 };
      }
      const res: JevResponse = {
        answers: (r.answers ?? {}) as JevResponse['answers'],
        failed: false, latencyMs: 1, inputTokens: 0,
      };
      if (r.signals) res.signals = r.signals;
      if (r.circuitOpen) res.circuitOpen = true;
      if (r.fallbackFrom) res.fallbackFrom = r.fallbackFrom;
      return res;
    },
  };
  return jev;
}

const choice = (value: string, confidence = 0.9): Answer => ({ kind: 'choice', choice: value, confidence, probabilities: {} });
const noul = (p: number): Answer => ({ kind: 'noul', p });
const allValid = (names: string[]) => Object.fromEntries(names.map((n) => [n, 'valid' as const]));

const lowTask = (jev: JevLike | null = null) => new EffortRouter({ jev, bounds: { min: 'low', max: 'max' } });

// The mod always sends the full request (jev-opus JEV_OPUS_EVALUATOR_CONTENT=full).
test('the evaluator gets the full request', () => {
  assert.match(taskState('Fix PRIVATE_EXAMPLE_TOKEN'), /PRIVATE_EXAMPLE_TOKEN/);
});

test('decisions carry policy and question-set versions', async () => {
  const t = await lowTask().routeTask('hi', null);
  assert.equal(t.policyVersion, POLICY_VERSION);
  assert.equal(POLICY_VERSION, 'policy.v12');
  assert.deepEqual(t.questionVersions, { task: TASK_SET_VERSION, followup: FOLLOWUP_SET_VERSION });
});

test('a stub Jev returning {} keeps the local estimate', async () => {
  const d = await lowTask(stubJev(() => ({}))).routeTask('fix the crash in parser.ts', null);
  assert.equal(d.source, 'heuristic');
  assert.equal(d.jevError, 'jev returned no usable answers');
  assert.equal(d.effort, 'medium');
});

test('invalid signals keep the local estimate; present answers on old clients count as valid', async () => {
  // Validating client: deep answer present but flagged invalid → ignored.
  const invalid = stubJev(() => ({
    answers: { deep: noul(0.9) },
    signals: { task_type: 'missing', deep: 'invalid' },
  }));
  const t = await lowTask(invalid).routeTask('thanks', null);
  assert.equal(t.effort, 'low', 'invalid deep must not escalate the task');
  assert.equal(t.source, 'heuristic', 'nothing usable was merged');

  // Old client (no signals map): a present answer is applied.
  const legacy = stubJev(() => ({ answers: { task_type: choice('research'), deep: noul(0.9) } }));
  const t2 = await lowTask(legacy).routeTask('thanks', null);
  assert.equal(t2.effort, 'xhigh', 'a present answer on an old client counts as valid (deep research)');
  assert.equal(t2.source, 'jev');
});

test('circuitOpen is treated as Jev unavailable', async () => {
  const d = await lowTask(stubJev(() => ({ circuitOpen: true }))).routeTask('fix the crash in parser.ts', null);
  assert.equal(d.source, 'heuristic');
  assert.equal(d.jevError, 'jev circuit open');
});

test('decision 6: a fallback answer counts like the primary\'s, deep included, and says it came from the fallback', async () => {
  setDeepThresholds({ yes: 0.72, no: 0.38 });
  try {
    const answer = (fallbackFrom?: string) => stubJev((_s, q) => ({
      answers: { task_type: choice('code'), deep: noul(0.95) }, signals: allValid(Object.keys(q)), ...(fallbackFrom ? { fallbackFrom } : {}),
    }));
    const primary = await lowTask(answer()).routeTask('rewrite the scheduler', null);
    assert.equal(primary.effort, 'xhigh', 'the primary\'s deep raises code to xhigh');
    const fallback = await lowTask(answer('deadline exceeded')).routeTask('rewrite the scheduler', null);
    assert.equal(fallback.effort, 'xhigh', 'the fallback\'s deep raises code the same way');
    assert.equal(fallback.profile?.taskType, 'code');
    assert.equal(fallback.source, 'jev');
    assert.ok(fallback.reasons.includes('fallback answer'), fallback.reasons.join('; '));
    assert.equal(fallback.profile!.deep, 0.95);
  } finally {
    setDeepThresholds({ ...DEEP_DEFAULTS });
  }
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('every question tells Jev that the state is evidence, not instructions', () => {
  for (const set of [TASK_QUESTIONS, FOLLOWUP_QUESTIONS]) {
    for (const [name, q] of Object.entries(set)) assert.match(q.instructions, /untrusted evidence/, name);
  }
});

test('clipEnds keeps the tail of a long prompt and says how much was dropped', () => {
  const prompt = `<pasted_content>${'log line\n'.repeat(1000)}</pasted_content>\n帮我看看最后一行报错是什么原因`;
  assert.equal(clipEnds('short', 3, 3), 'short');
  const s = clipEnds(prompt, 2200, 800);
  assert.ok(s.startsWith('<pasted_content>'));
  assert.ok(s.endsWith('帮我看看最后一行报错是什么原因'), 'the request after the paste survives');
  const m = s.match(/…\[\+(\d+) chars\]…/);
  assert.ok(m, 'drop marker between head and tail');
  assert.equal(s.length - m![0].length + Number(m![1]), prompt.length, 'kept + dropped = whole');
  for (const state of [taskState(prompt), followUpState(null, prompt)]) {
    assert.ok(state.includes('帮我看看最后一行报错是什么原因'), state.slice(-80));
  }
  assert.ok(taskState(prompt).length <= 3100);
  assert.ok(followUpState(null, prompt).length < 2100);
});

test('clipEnds never splits a surrogate pair at either boundary', () => {
  for (const pad of ['', 'a']) {
    const s = pad + '😀'.repeat(500);
    for (const [head, tail] of [[101, 50], [100, 51], [7, 7], [1, 1]] as const) {
      const out = clipEnds(s, head, tail);
      assert.ok(!LONE_SURROGATE.test(out), `pad=${JSON.stringify(pad)} head=${head} tail=${tail}`);
      assert.ok(out.length <= head + tail + 24);
    }
  }
});

const complaint = (over: Partial<FollowUpAsk> = {}): FollowUpAsk => ({
  summary: 'PREVIOUS USER REQUEST: fix the date test', prevMax: 'medium', prevDissatisfied: false, prevStreak: 0, prevHiLosses: 0,
  shadow: false, advisorOption: true, advisorAvailable: true, ...over,
});

/** Answers task and follow-up questions by which set is asked. */
const faultJev = (p: number | 'fail' | 'throw', deep = 0.1, fallbackFrom?: string) => stubJev((_s, q) => {
  if ('dissatisfied' in q) {
    if (p === 'throw') throw new Error('socket hang up');
    return p === 'fail' ? 'fail' : { answers: { dissatisfied: noul(p) }, signals: allValid(['dissatisfied']), ...(fallbackFrom ? { fallbackFrom } : {}) };
  }
  return { answers: { task_type: choice('code'), deep: noul(deep) }, signals: allValid(Object.keys(q)), ...(fallbackFrom ? { fallbackFrom } : {}) };
});

async function withDissat(fn: () => Promise<void>): Promise<void> {
  setDissatThreshold(0.98);
  try { await fn(); } finally { setDissatThreshold(DISSAT_DEFAULT); }
}

test('follow-up: the task and follow-up asks run concurrently', async () => {
  await withDissat(async () => {
    const asked: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const jev: JevLike = {
      enabled: true,
      async ask(_state, q) {
        asked.push('dissatisfied' in q ? 'followup' : 'task');
        await gate;
        const answers: Record<string, Answer> = 'dissatisfied' in q ? { dissatisfied: noul(0.99) } : { task_type: choice('code'), deep: noul(0.1) };
        return { answers: answers as JevResponse['answers'], failed: false, latencyMs: 3, inputTokens: 0 };
      },
    };
    const r = new EffortRouter({ jev, bounds: { min: 'low', max: 'max' } });
    const pending = r.routeTask('还是不对', 'medium', undefined, complaint());
    await Promise.resolve();
    assert.deepEqual(asked.sort(), ['followup', 'task'], 'both asks are in flight before either answers');
    release();
    const d = await pending;
    assert.equal(d.effort, 'high');
    assert.equal(d.followUp?.latencyMs, 3);
  });
});

test('follow-up: the task ask is byte-identical with and without the follow-up signal', async () => {
  await withDissat(async () => {
    const withIt = faultJev(0.99);
    const without = faultJev(0.99);
    const a1 = await new EffortRouter({ jev: withIt, bounds: { min: 'low', max: 'max' } }).routeTask('这个还是不行', 'medium', undefined, complaint({ prevMax: 'high' }));
    const a2 = await new EffortRouter({ jev: without, bounds: { min: 'low', max: 'max' } }).routeTask('这个还是不行', 'medium');
    assert.equal(withIt.calls.length, 2);
    assert.equal(without.calls.length, 1);
    assert.ok(withIt.calls.includes(without.calls[0]!), 'the same task state was sent');
    assert.ok(withIt.calls.some((st) => st.startsWith('CONVERSATION SO FAR') && st.includes('这个还是不行')));
    assert.deepEqual(a1.profile, a2.profile);
    assert.equal(a2.followUp, undefined);
    assert.equal(a1.effort, 'xhigh');
    assert.equal(a2.effort, 'medium');
  });
});

test('follow-up: a failed, invalid or throwing follow-up ask raises nothing and leaves the task decision alone', async () => {
  await withDissat(async () => {
    for (const p of ['fail', 'throw'] as const) {
      const d = await new EffortRouter({ jev: faultJev(p), bounds: { min: 'low', max: 'max' } }).routeTask('不对', 'medium', undefined, complaint());
      assert.equal(d.effort, 'medium', p);
      assert.equal(d.jevError, undefined, p);
      assert.equal(d.source, 'jev', p);
      assert.equal(d.followUp?.yes, false, p);
      assert.ok(!('p' in d.followUp!), p);
      assert.ok(d.followUp?.error, p);
    }
    const invalid = stubJev((_s, q) => 'dissatisfied' in q
      ? { answers: { dissatisfied: noul(0.99) }, signals: { dissatisfied: 'invalid' } }
      : { answers: { task_type: choice('code'), deep: noul(0.1) }, signals: allValid(Object.keys(q)) });
    const d = await new EffortRouter({ jev: invalid, bounds: { min: 'low', max: 'max' } }).routeTask('不对', 'medium', undefined, complaint());
    assert.equal(d.effort, 'medium');
    assert.equal(d.followUp?.error, 'jev returned no usable answers');
  });
});

test('decision 6: a follow-up verdict from the fallback endpoint never raises', async () => {
  await withDissat(async () => {
    const d = await new EffortRouter({ jev: faultJev(0.99, 0.1, 'Jev HTTP 503'), bounds: { min: 'low', max: 'max' } })
      .routeTask('不对，还是报错', 'medium', undefined, complaint({ prevMax: 'high' }));
    assert.equal(d.effort, 'medium');
    assert.equal(d.followUp?.yes, false);
    assert.equal(d.followUp?.error, FALLBACK_IGNORED);
    assert.equal(d.followUp?.raisedTo, undefined);
  });
});
