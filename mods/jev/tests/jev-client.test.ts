import assert, { test } from './assert';
import type { JevMessage } from '../src/dialogue';
import { DECISIONS_URL, DEFAULT_DEADLINE_MS, JevClient, decisionsAnswers, decisionsRequest, validateAnswers, type JevIo, type JevQuestion } from '../src/jev';
import { TASK_QUESTIONS } from '../src/questions';

/** A question set with one question of each type (choice, score, noul), the shape the step questions of policy.v9 had. */
const STEP_QUESTIONS = {
  phase: { type: 'choice', instructions: 'Which phase?', criteria: { exploring: 'e', implementing: 'i', diagnosing: 'd', verifying: 'v', finishing: 'f' } },
  step_difficulty: { type: 'score', instructions: 'How hard?', criteria: ['0', '1', '2', '3', '4'] },
  stuck: { type: 'noul', instructions: 'Stuck?' },
} satisfies Record<string, JevQuestion>;

test('validateAnswers: absent entries are missing and excluded from answers', () => {
  const { answers, signals } = validateAnswers({}, TASK_QUESTIONS);
  assert.deepEqual(signals, { task_type: 'missing', deep: 'missing' });
  assert.deepEqual(answers, {});
  // null/absent raw payload → every question missing
  const none = validateAnswers(undefined, TASK_QUESTIONS);
  assert.deepEqual(none.signals, signals);
});

test('validateAnswers rejects instead of clamping: unknown choice, out-of-range score, out-of-range noul', () => {
  const { answers, signals } = validateAnswers(
    {
      task_type: { choice: 'not-a-type', confidence: 0.9 },
      deep: { noul: 0.3 },
    },
    TASK_QUESTIONS,
  );
  assert.deepEqual(signals, { task_type: 'invalid', deep: 'valid' });
  assert.equal(answers.task_type, undefined); // never replaced by the first category
  assert.deepEqual(answers.deep, { kind: 'noul', p: 0.3 });
  // old task.v2 kinds are no longer valid choices
  assert.equal(validateAnswers({ task_type: { choice: 'debugging', confidence: 0.9 } }, TASK_QUESTIONS).signals.task_type, 'invalid');
  assert.equal(validateAnswers({ deep: { noul: 1.2 } }, TASK_QUESTIONS).signals.deep, 'invalid'); // noul outside 0..1

  const score = validateAnswers({ step_difficulty: { score: 9, confidence: 0.5 } }, STEP_QUESTIONS);
  assert.equal(score.signals.step_difficulty, 'invalid');
  assert.equal(score.answers.step_difficulty, undefined); // never clamped to 4

  const bad = validateAnswers(
    { stuck: { noul: -1 }, step_difficulty: { score: 'hard' }, phase: 'exploring' },
    STEP_QUESTIONS,
  );
  assert.equal(bad.signals.stuck, 'invalid'); // noul outside 0..1
  assert.equal(bad.signals.step_difficulty, 'invalid'); // non-numeric score
  assert.equal(bad.signals.phase, 'invalid'); // present but not an object
});

test('validateAnswers snaps float noise at the score bounds but still rejects real violations', () => {
  const noisy = validateAnswers({ step_difficulty: { score: 4.00000002 } }, STEP_QUESTIONS);
  assert.equal(noisy.signals.step_difficulty, 'valid');
  assert.equal(noisy.answers.step_difficulty?.kind === 'score' && noisy.answers.step_difficulty.score, 4);
  const below = validateAnswers({ step_difficulty: { score: -1e-7 } }, STEP_QUESTIONS);
  assert.equal(below.answers.step_difficulty?.kind === 'score' && below.answers.step_difficulty.score, 0);
  assert.equal(validateAnswers({ step_difficulty: { score: 4.001 } }, STEP_QUESTIONS).signals.step_difficulty, 'invalid');
  assert.equal(validateAnswers({ step_difficulty: { score: -0.01 } }, STEP_QUESTIONS).signals.step_difficulty, 'invalid');
});

test('validateAnswers recomputes confidence from probabilities: (n·pmax − 1)/(n − 1)', () => {
  // 7 task kinds; unnormalized map (sums to 2) → pmax 0.5 → (7·0.5 − 1)/6 = 5/12
  const { answers } = validateAnswers(
    { task_type: { choice: 'code', confidence: 0.99, probabilities: { code: 1, research: 0.6, chat: 0.4 } } },
    TASK_QUESTIONS,
  );
  assert.ok(answers.task_type?.kind === 'choice' && Math.abs(answers.task_type.confidence - 5 / 12) < 1e-12);
  const certain = validateAnswers(
    { step_difficulty: { score: 2, confidence: 0.1, probabilities: { '2': 1 } } }, // certain → 1 despite server 0.1
    STEP_QUESTIONS,
  );
  assert.equal(certain.answers.step_difficulty?.kind === 'score' && certain.answers.step_difficulty.confidence, 1);
  // stored probabilities stay raw
  assert.deepEqual(answers.task_type?.kind === 'choice' && answers.task_type.probabilities, { code: 1, research: 0.6, chat: 0.4 });
  // uniform → 0, never negative
  const uniform = validateAnswers({ phase: { choice: 'exploring', confidence: 0.9, probabilities: { exploring: 0.2, implementing: 0.2, diagnosing: 0.2, verifying: 0.2, finishing: 0.2 } } }, STEP_QUESTIONS);
  assert.ok(uniform.answers.phase?.kind === 'choice' && Math.abs(uniform.answers.phase.confidence) < 1e-12);
});

test('validateAnswers keeps server confidence without probabilities or in server mode', () => {
  const none = validateAnswers({ phase: { choice: 'exploring', confidence: 0.7 } }, STEP_QUESTIONS);
  assert.equal(none.answers.phase?.kind === 'choice' && none.answers.phase.confidence, 0.7);
  const empty = validateAnswers({ phase: { choice: 'exploring', confidence: 0.7, probabilities: {} } }, STEP_QUESTIONS);
  assert.equal(empty.answers.phase?.kind === 'choice' && empty.answers.phase.confidence, 0.7);
  const zero = validateAnswers({ phase: { choice: 'exploring', confidence: 0.7, probabilities: { exploring: 0 } } }, STEP_QUESTIONS);
  assert.equal(zero.answers.phase?.kind === 'choice' && zero.answers.phase.confidence, 0.7);
  const server = validateAnswers(
    { phase: { choice: 'exploring', confidence: 0.7, probabilities: { exploring: 1 } } },
    STEP_QUESTIONS,
    { confidence: 'server' },
  );
  assert.equal(server.answers.phase?.kind === 'choice' && server.answers.phase.confidence, 0.7);
});

// A response api.openai.com/v1/decisions (gpt-6-luna) returned on 2026-10-29 to
// decisionsRequest(state, 'gpt-6-luna', TASK_QUESTIONS), recorded as is.
const DECISIONS_TASK_RESPONSE = {"model":"gpt-6-luna","answers":[{"type":"choice","name":"task_type","choice":"code","probabilities":[{"value":"chat","probability":0.0},{"value":"explain","probability":0.0},{"value":"operate","probability":0.0},{"value":"write","probability":0.0},{"value":"code","probability":1.0},{"value":"research","probability":0.0}],"confidence":1.0},{"type":"predicate","name":"deep","probability":0.9}],"usage":{"input_tokens":996,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0},"output_tokens":0,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":996}};

/** A conversation as the dialogue builder hands it to the client, newest message last. */
const INPUT: JevMessage[] = [
  { role: 'user', content: 'the date test fails on leap years' },
  { role: 'assistant', content: 'The parser drops Feb 29. Want me to fix it?' },
  { role: 'user', content: 'fix it' },
];

test('decisionsRequest: the conversation as a message array; noul as predicate, choice criteria as choices in the question set order, score criteria as levels', () => {
  const req = decisionsRequest(INPUT, 'gpt-6-luna', { ...TASK_QUESTIONS, step_difficulty: STEP_QUESTIONS.step_difficulty }) as {
    model: string; input: JevMessage[]; questions: Array<Record<string, unknown>>;
  };
  assert.equal(req.model, 'gpt-6-luna');
  assert.deepEqual(req.input, INPUT);
  assert.deepEqual(req.questions.map((q) => [q.name, q.type]), [['task_type', 'choice'], ['deep', 'predicate'], ['step_difficulty', 'score']]);
  const choices = req.questions[0]!.choices as Array<{ value: string; description: string }>;
  assert.deepEqual(choices.map((c) => c.value), ['chat', 'explain', 'operate', 'write', 'design', 'code', 'research']);
  assert.equal(choices.find((c) => c.value === 'code')!.description, TASK_QUESTIONS.task_type.criteria.code);
  assert.equal(req.questions[1]!.instructions, TASK_QUESTIONS.deep.instructions);
  assert.deepEqual(req.questions[2]!.levels, ['0', '1', '2', '3', '4'].map((c) => ({ label: c, description: c })));
});

test('decisionsRequest replaces lone surrogates, which make a request body invalid', () => {
  const req = decisionsRequest([{ role: 'user', content: 'bad \uD800 half 😀' }], 'gpt-6-luna', TASK_QUESTIONS) as { input: JevMessage[] };
  assert.equal(req.input[0]!.content, 'bad \uFFFD half 😀');
});

test('decisionsAnswers: a recorded Decisions response validates', () => {
  const { answers, signals } = validateAnswers(decisionsAnswers(DECISIONS_TASK_RESPONSE.answers), TASK_QUESTIONS);
  assert.deepEqual(signals, { task_type: 'valid', deep: 'valid' });
  assert.equal(answers.task_type?.kind === 'choice' && answers.task_type.choice, 'code');
  assert.equal(answers.task_type?.kind === 'choice' && answers.task_type.probabilities.code, 1);
  assert.deepEqual(answers.deep, { kind: 'noul', p: 0.9 });
  assert.deepEqual(decisionsAnswers(undefined), {}, 'no answers array: every question missing');
});

// The client's network and clock come from the hook that asks (JevIo); these
// tests hand it scripted replies in the Decisions response shape.

/** Per-question answers as a Decisions `answers` array. */
function decisions(answers: Record<string, Record<string, unknown>>): unknown[] {
  return Object.entries(answers).map(([name, a]) =>
    'noul' in a ? { type: 'predicate', name, probability: a.noul }
      : 'choice' in a ? { type: 'choice', name, ...a }
        : { type: 'score', name, ...a });
}

type Reply = { status?: number; body?: unknown; text?: string } | 'hang';

function fakeIo(handler: (req: { url: string; auth: string; body: Record<string, unknown> }) => Reply, opts: { deadlineFires?: boolean } = {}) {
  const io: JevIo & { hits: number; t: number } = {
    hits: 0,
    t: 10_000,
    async fetch(url, init) {
      io.hits++;
      const r = handler({ url, auth: init.headers.Authorization ?? '', body: JSON.parse(init.body) });
      if (r === 'hang') return new Promise(() => {});
      const status = r.status ?? 200;
      return { status, ok: status >= 200 && status < 300, text: r.text ?? JSON.stringify(r.body ?? {}) };
    },
    async now() { return io.t; },
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (opts.deadlineFires) { io.t += ms; resolve(); return; }
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
  return io;
}

test('JevClient posts the conversation to OpenAI Decisions and reads answers and cached tokens', async () => {
  let body: Record<string, unknown> = {};
  let auth = '';
  let url = '';
  const io = fakeIo((req) => {
    auth = req.auth;
    body = req.body;
    url = req.url;
    return { body: DECISIONS_TASK_RESPONSE };
  });
  const jev = new JevClient({ apiKey: 'apikey_test' });
  const r = await jev.ask(INPUT, TASK_QUESTIONS, io);
  assert.equal(r.failed, false);
  assert.equal(url, DECISIONS_URL);
  assert.equal(url, 'https://api.openai.com/v1/decisions');
  assert.equal(auth, 'Bearer apikey_test');
  assert.deepEqual(body.input, INPUT);
  assert.equal(body.model, 'gpt-6-luna');
  assert.deepEqual((body.questions as Array<{ name: string }>).map((q) => q.name), ['task_type', 'deep']);
  assert.equal(r.answers.task_type?.kind === 'choice' && r.answers.task_type.choice, 'code');
  assert.deepEqual(r.signals, { task_type: 'valid', deep: 'valid' });
  assert.equal(r.inputTokens, 996);
  assert.equal(r.cachedTokens, 0);
  assert.equal(r.provider, 'api.openai.com');
  const cached = await jev.ask(INPUT, TASK_QUESTIONS, fakeIo(() => ({ body: { ...DECISIONS_TASK_RESPONSE, usage: { input_tokens: 61492, input_tokens_details: { cached_tokens: 59444 } } } })));
  assert.equal(cached.inputTokens, 61492);
  assert.equal(cached.cachedTokens, 59444);
});

test('JevClient: HTTP 200 with empty answers fails — every signal missing, no stand-ins', async () => {
  const jev = new JevClient({ apiKey: 'apikey_test' });
  const r = await jev.ask(INPUT, TASK_QUESTIONS, fakeIo(() => ({ body: { model: 'gpt-6-luna', answers: [], usage: {} } })));
  assert.equal(r.failed, true);
  assert.deepEqual(r.signals, { task_type: 'missing', deep: 'missing' });
  assert.deepEqual(r.answers, {});
});

test('JevClient: partial validity keeps valid answers, marks the rest, and does not fail', async () => {
  const jev = new JevClient({ apiKey: 'apikey_test' });
  const r = await jev.ask(INPUT, STEP_QUESTIONS, fakeIo(() => ({ body: {
    answers: decisions({
      phase: { choice: 'bogus-phase', confidence: 0.99 },
      step_difficulty: { score: 2, confidence: 0.6 },
      stuck: { noul: 0.5 },
    }),
  } })));
  assert.equal(r.failed, false);
  assert.deepEqual(r.signals, { phase: 'invalid', step_difficulty: 'valid', stuck: 'valid' });
  assert.equal(r.answers.phase, undefined);
  assert.equal(r.answers.step_difficulty?.kind === 'score' && r.answers.step_difficulty.score, 2);
});

test('JevClient never throws: HTTP errors fail with empty answers and missing signals', async () => {
  const jev = new JevClient({ apiKey: 'apikey_bad' });
  const r = await jev.ask(INPUT, STEP_QUESTIONS, fakeIo(() => ({ status: 401, text: 'bad key' })));
  assert.equal(r.failed, true);
  assert.match(r.error ?? '', /401/);
  assert.deepEqual(r.answers, {});
  assert.deepEqual(r.signals, { phase: 'missing', step_difficulty: 'missing', stuck: 'missing' });
});

test('JevClient never throws: a non-JSON body or a rejected fetch fails', async () => {
  const jev = new JevClient({ apiKey: 'apikey_test', breakerThreshold: 99 });
  assert.equal((await jev.ask(INPUT, STEP_QUESTIONS, fakeIo(() => ({ text: '<html>' })))).failed, true);
  const io = fakeIo(() => ({ body: {} }));
  io.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const r = await jev.ask(INPUT, STEP_QUESTIONS, io);
  assert.equal(r.failed, true);
  assert.match(r.error ?? '', /ECONNREFUSED/);
});

test('JevClient enforces one overall deadline across the whole ask', async () => {
  const jev = new JevClient({ apiKey: 'apikey_test', deadlineMs: 80 });
  const r = await jev.ask(INPUT, TASK_QUESTIONS, fakeIo(() => 'hang', { deadlineFires: true }));
  assert.equal(r.failed, true);
  assert.equal(r.latencyMs, 80);
  assert.match(r.error ?? '', /deadline/i);
});

test('JevClient circuit breaker opens after N failures, skips fetch while open, probes after cooldown', async () => {
  const io = fakeIo(() => ({ status: 500, text: 'err' }));
  const jev = new JevClient({ apiKey: 'apikey_test', breakerThreshold: 3, breakerCooldownMs: 30_000 });
  for (let i = 0; i < 3; i++) {
    const r = await jev.ask(INPUT, TASK_QUESTIONS, io);
    assert.equal(r.failed, true);
    assert.equal(r.circuitOpen, undefined);
  }
  assert.equal(io.hits, 3);

  // Open: no fetch happens.
  const open = await jev.ask(INPUT, TASK_QUESTIONS, io);
  assert.equal(open.failed, true);
  assert.equal(open.circuitOpen, true);
  assert.equal(open.error, 'circuit open');
  assert.equal(io.hits, 3);

  // Cooldown elapsed: one real probe goes out, fails, and re-opens.
  io.t += 30_001;
  const probe = await jev.ask(INPUT, TASK_QUESTIONS, io);
  assert.equal(probe.failed, true);
  assert.equal(probe.circuitOpen, undefined);
  assert.equal(io.hits, 4);

  const again = await jev.ask(INPUT, TASK_QUESTIONS, io);
  assert.equal(again.circuitOpen, true);
  assert.equal(io.hits, 4);
});

test('JevClient circuit breaker closes when the recovery probe succeeds', async () => {
  const io = fakeIo(() => (io.hits <= 3 ? { status: 500, text: 'err' } : { body: { answers: decisions({ stuck: { noul: 0.1 } }) } }));
  const jev = new JevClient({ apiKey: 'apikey_test', breakerThreshold: 3, breakerCooldownMs: 30_000 });
  for (let i = 0; i < 3; i++) await jev.ask(INPUT, { stuck: STEP_QUESTIONS.stuck }, io);
  const open = await jev.ask(INPUT, { stuck: STEP_QUESTIONS.stuck }, io);
  assert.equal(open.circuitOpen, true);
  assert.equal(io.hits, 3);

  io.t += 30_001;
  const probe = await jev.ask(INPUT, { stuck: STEP_QUESTIONS.stuck }, io);
  assert.equal(probe.failed, false);
  assert.equal(io.hits, 4);

  // Closed again: calls flow normally.
  const r = await jev.ask(INPUT, { stuck: STEP_QUESTIONS.stuck }, io);
  assert.equal(r.failed, false);
  assert.equal(io.hits, 5);
});

test('JevClient without a key is disabled and fails fast', async () => {
  const io = fakeIo(() => ({ body: {} }));
  const jev = new JevClient({ apiKey: '' });
  assert.equal(jev.enabled, false);
  const r = await jev.ask(INPUT, TASK_QUESTIONS, io);
  assert.equal(r.failed, true);
  assert.equal(io.hits, 0);
  assert.deepEqual(r.signals, { task_type: 'missing', deep: 'missing' });
});

test('validateAnswers never inflates confidence from a partial probability map', () => {
  // only the chosen option reported: the other five kinds still hold 0.65 of the mass
  const { answers } = validateAnswers({ task_type: { choice: 'research', confidence: 0.2, probabilities: { research: 0.35 } } }, TASK_QUESTIONS);
  assert.ok(answers.task_type?.kind === 'choice' && answers.task_type.confidence < 0.6, JSON.stringify(answers.task_type));
});

const STUCK = { stuck: STEP_QUESTIONS.stuck };

test('the breaker resets its probe even when the probing hook\'s clock rejects', async () => {
  const io = fakeIo(() => (io.hits <= 1 ? { status: 503, text: 'down' } : { body: { answers: decisions({ stuck: { noul: 0.1 } }) } }));
  const jev = new JevClient({ apiKey: 'k', breakerThreshold: 1, breakerCooldownMs: 30_000 });
  assert.equal((await jev.ask(INPUT, STUCK, io)).failed, true);
  io.t += 31_000;
  // The probe's hook ends while it waits: its clock rejects after the first read.
  let reads = 0;
  const dying: JevIo = { fetch: (url, init) => io.fetch(url, init), sleep: (ms, signal) => io.sleep(ms, signal), now: async () => { if (++reads > 1) throw new Error('hook ended'); return io.t; } };
  const probe = await jev.ask(INPUT, STUCK, dying).then(() => 'answered', (e: Error) => e.message);
  assert.equal(probe, 'hook ended');
  for (const later of [62_000, 3_600_000]) {
    io.t = 10_000 + later;
    const r = await jev.ask(INPUT, STUCK, io);
    assert.equal(r.circuitOpen, undefined, `t+${later}`);
    assert.equal(r.failed, false, `t+${later}`);
  }
});

test('a rejected clock sleep is its own error, never a deadline', async () => {
  const io = fakeIo(() => 'hang');
  const rejecting: JevIo = { fetch: (url, init) => io.fetch(url, init), now: () => io.now(), sleep: () => Promise.reject(new Error('hook ended')) };
  const r = await new JevClient({ apiKey: 'k' }).ask(INPUT, STUCK, rejecting);
  assert.equal(r.failed, true);
  assert.equal(r.error, 'clock sleep rejected');
});

test('the deadline defaults to 10000 ms, above the 8.3 s measured for an 861K-token conversation', async () => {
  assert.equal(DEFAULT_DEADLINE_MS, 10_000);
  const r = await new JevClient({ apiKey: 'k' }).ask(INPUT, STUCK, fakeIo(() => 'hang', { deadlineFires: true }));
  assert.equal(r.latencyMs, 10_000);
  assert.equal(r.error, 'deadline exceeded');
});
