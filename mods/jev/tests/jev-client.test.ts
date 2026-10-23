import assert, { test } from './assert';
import { JevClient, JevFallback, parseAnswers, validateAnswers, type JevIo } from '../src/jev';
import { STEP_QUESTIONS, TASK_QUESTIONS } from '../src/questions';

// Legacy lenient parser — still exported for scripted JevLike stubs elsewhere.
test('parseAnswers clamps values and rejects unknown choices', () => {
  const a = parseAnswers(
    {
      task_type: { choice: 'not-a-type', confidence: 3 },
      deep: { noul: -1 },
    },
    TASK_QUESTIONS,
  );
  assert.deepEqual(a.task_type, { kind: 'choice', choice: 'chat', confidence: 1, probabilities: {} });
  assert.equal(a.deep?.kind === 'noul' && a.deep.p, 0);
  const s = parseAnswers({ step_difficulty: { score: 9, confidence: 0.5 } }, STEP_QUESTIONS);
  assert.equal(s.step_difficulty?.kind === 'score' && s.step_difficulty.score, 4);
});

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
  // 6 task kinds; unnormalized map (sums to 2) → pmax 0.5 → (6·0.5 − 1)/5 = 2/5
  const { answers } = validateAnswers(
    { task_type: { choice: 'code', confidence: 0.99, probabilities: { code: 1, research: 0.6, chat: 0.4 } } },
    TASK_QUESTIONS,
  );
  assert.ok(answers.task_type?.kind === 'choice' && Math.abs(answers.task_type.confidence - 2 / 5) < 1e-12);
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

// The client's network and clock come from the hook that asks (JevIo); these
// fakes stand where jev-opus ran a local HTTP server. Retries, a caller's
// AbortSignal and the OpenRouter provider are not ported, nor their tests.

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

test('JevClient sends the System-1 wire format and parses answers', async () => {
  let body: Record<string, unknown> = {};
  let auth = '';
  const io = fakeIo((req) => {
    auth = req.auth;
    body = req.body;
    return { body: {
      model: 'jev-latest',
      answers: { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.2, confidence: 0.7 }, stuck: { noul: 0.2 } },
      usage: { input_tokens: 120, output_tokens: 0 },
    } };
  });
  const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: 'http://jev.test/v1/systemone', model: 'jev-latest' });
  const r = await jev.ask('state text', STEP_QUESTIONS, io);
  assert.equal(r.failed, false);
  assert.equal(auth, 'Bearer apikey_test');
  assert.equal(body.state, 'state text');
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(Object.keys(body.questions as object), ['phase', 'step_difficulty', 'stuck']);
  assert.equal(r.answers.phase?.kind === 'choice' && r.answers.phase.choice, 'diagnosing');
  assert.deepEqual(r.signals, { phase: 'valid', step_difficulty: 'valid', stuck: 'valid' });
  assert.equal(r.inputTokens, 120);
});

test('JevClient: HTTP 200 with empty answers fails — every signal missing, no stand-ins', async () => {
  const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: 'http://jev.test' });
  const r = await jev.ask('s', TASK_QUESTIONS, fakeIo(() => ({ body: { model: 'jev-latest', answers: {}, usage: {} } })));
  assert.equal(r.failed, true);
  assert.deepEqual(r.signals, { task_type: 'missing', deep: 'missing' });
  assert.deepEqual(r.answers, {});
});

test('JevClient: partial validity keeps valid answers, marks the rest, and does not fail', async () => {
  const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: 'http://jev.test' });
  const r = await jev.ask('s', STEP_QUESTIONS, fakeIo(() => ({ body: {
    answers: {
      phase: { choice: 'bogus-phase', confidence: 0.99 },
      step_difficulty: { score: 2, confidence: 0.6 },
      stuck: { noul: 0.5 },
    },
  } })));
  assert.equal(r.failed, false);
  assert.deepEqual(r.signals, { phase: 'invalid', step_difficulty: 'valid', stuck: 'valid' });
  assert.equal(r.answers.phase, undefined);
  assert.equal(r.answers.step_difficulty?.kind === 'score' && r.answers.step_difficulty.score, 2);
});

test('JevClient never throws: HTTP errors fail with empty answers and missing signals', async () => {
  const jev = new JevClient({ apiKey: 'apikey_bad', baseUrl: 'http://jev.test' });
  const r = await jev.ask('s', STEP_QUESTIONS, fakeIo(() => ({ status: 401, text: 'bad key' })));
  assert.equal(r.failed, true);
  assert.match(r.error ?? '', /401/);
  assert.deepEqual(r.answers, {});
  assert.deepEqual(r.signals, { phase: 'missing', step_difficulty: 'missing', stuck: 'missing' });
});

test('JevClient never throws: a non-JSON body or a rejected fetch fails', async () => {
  const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: 'http://jev.test', breakerThreshold: 99 });
  assert.equal((await jev.ask('s', STEP_QUESTIONS, fakeIo(() => ({ text: '<html>' })))).failed, true);
  const io = fakeIo(() => ({ body: {} }));
  io.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const r = await jev.ask('s', STEP_QUESTIONS, io);
  assert.equal(r.failed, true);
  assert.match(r.error ?? '', /ECONNREFUSED/);
});

test('JevClient enforces one overall deadline across the whole ask', async () => {
  const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: 'http://jev.test', deadlineMs: 80 });
  const r = await jev.ask('s', TASK_QUESTIONS, fakeIo(() => 'hang', { deadlineFires: true }));
  assert.equal(r.failed, true);
  assert.equal(r.latencyMs, 80);
  assert.match(r.error ?? '', /deadline/i);
});

test('JevClient circuit breaker opens after N failures, skips fetch while open, probes after cooldown', async () => {
  const io = fakeIo(() => ({ status: 500, text: 'err' }));
  const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: 'http://jev.test', breakerThreshold: 3, breakerCooldownMs: 30_000 });
  for (let i = 0; i < 3; i++) {
    const r = await jev.ask('s', TASK_QUESTIONS, io);
    assert.equal(r.failed, true);
    assert.equal(r.circuitOpen, undefined);
  }
  assert.equal(io.hits, 3);

  // Open: no fetch happens.
  const open = await jev.ask('s', TASK_QUESTIONS, io);
  assert.equal(open.failed, true);
  assert.equal(open.circuitOpen, true);
  assert.equal(open.error, 'circuit open');
  assert.equal(io.hits, 3);

  // Cooldown elapsed: one real probe goes out, fails, and re-opens.
  io.t += 30_001;
  const probe = await jev.ask('s', TASK_QUESTIONS, io);
  assert.equal(probe.failed, true);
  assert.equal(probe.circuitOpen, undefined);
  assert.equal(io.hits, 4);

  const again = await jev.ask('s', TASK_QUESTIONS, io);
  assert.equal(again.circuitOpen, true);
  assert.equal(io.hits, 4);
});

test('JevClient circuit breaker closes when the recovery probe succeeds', async () => {
  const io = fakeIo(() => (io.hits <= 3 ? { status: 500, text: 'err' } : { body: { answers: { stuck: { noul: 0.1 } } } }));
  const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: 'http://jev.test', breakerThreshold: 3, breakerCooldownMs: 30_000 });
  for (let i = 0; i < 3; i++) await jev.ask('s', { stuck: STEP_QUESTIONS.stuck }, io);
  const open = await jev.ask('s', { stuck: STEP_QUESTIONS.stuck }, io);
  assert.equal(open.circuitOpen, true);
  assert.equal(io.hits, 3);

  io.t += 30_001;
  const probe = await jev.ask('s', { stuck: STEP_QUESTIONS.stuck }, io);
  assert.equal(probe.failed, false);
  assert.equal(io.hits, 4);

  // Closed again: calls flow normally.
  const r = await jev.ask('s', { stuck: STEP_QUESTIONS.stuck }, io);
  assert.equal(r.failed, false);
  assert.equal(io.hits, 5);
});

test('JevClient without a key is disabled and fails fast', async () => {
  const io = fakeIo(() => ({ body: {} }));
  const jev = new JevClient({ apiKey: '', baseUrl: 'http://jev.test' });
  assert.equal(jev.enabled, false);
  const r = await jev.ask('s', TASK_QUESTIONS, io);
  assert.equal(r.failed, true);
  assert.equal(io.hits, 0);
  assert.deepEqual(r.signals, { task_type: 'missing', deep: 'missing' });
});

test('validateAnswers never inflates confidence from a partial probability map', () => {
  // only the chosen option reported: the other five kinds still hold 0.65 of the mass
  const { answers } = validateAnswers({ task_type: { choice: 'research', confidence: 0.2, probabilities: { research: 0.35 } } }, TASK_QUESTIONS);
  assert.ok(answers.task_type?.kind === 'choice' && answers.task_type.confidence < 0.6, JSON.stringify(answers.task_type));
});

const PRIMARY = 'http://primary.test/v1/systemone';
const FALLBACK = 'http://127.0.0.1:18016/v1/systemone';
const STUCK = { stuck: STEP_QUESTIONS.stuck };
const answered = { body: { answers: { stuck: { noul: 0.1 } } } };

function chain(opts: { primary?: Partial<ConstructorParameters<typeof JevClient>[0]>; fallback?: Partial<ConstructorParameters<typeof JevClient>[0]> } = {}) {
  return new JevFallback(
    new JevClient({ apiKey: 'primary-key', baseUrl: PRIMARY, ...opts.primary }),
    new JevClient({ apiKey: 'fallback-key', baseUrl: FALLBACK, ...opts.fallback }),
  );
}

test('JevFallback: a primary answer is returned as is and the fallback is never fetched', async () => {
  const urls: string[] = [];
  const io = fakeIo((req) => (urls.push(req.url), answered));
  const r = await chain().ask('s', STUCK, io);
  assert.equal(r.failed, false);
  assert.equal(r.provider, 'primary.test');
  assert.equal(r.fallbackFrom, undefined);
  assert.deepEqual(urls, [PRIMARY]);
});

test('JevFallback: an HTTP error at the primary is answered by the fallback, with the primary error kept', async () => {
  const io = fakeIo((req) => (req.url === PRIMARY ? { status: 500, text: 'err' } : answered));
  const r = await chain().ask('s', STUCK, io);
  assert.equal(r.failed, false);
  assert.equal(r.provider, '127.0.0.1:18016');
  assert.equal(r.fallbackFrom, 'Jev HTTP 500');
  assert.equal(r.answers.stuck?.kind === 'noul' && r.answers.stuck.p, 0.1);
  assert.equal(io.hits, 2);
});

test('JevFallback: a primary past its deadline falls back, and the latency is the sum of both', async () => {
  // deadlineFires advances the fake clock by each client's deadline, the fallback's included.
  const io = fakeIo((req) => (req.url === PRIMARY ? 'hang' : answered), { deadlineFires: true });
  const r = await chain({ primary: { deadlineMs: 3_000 }, fallback: { deadlineMs: 500 } }).ask('s', STUCK, io);
  assert.equal(r.failed, false);
  assert.equal(r.fallbackFrom, 'deadline exceeded');
  assert.equal(r.latencyMs, 3_500);
  assert.equal(io.hits, 2);
});

test('JevFallback: an open primary circuit goes straight to the fallback without a primary fetch', async () => {
  const io = fakeIo((req) => (req.url === PRIMARY ? { status: 500, text: 'err' } : answered));
  const c = chain({ primary: { breakerThreshold: 2 } });
  await c.ask('s', STUCK, io);
  await c.ask('s', STUCK, io);
  assert.equal(io.hits, 4);
  const r = await c.ask('s', STUCK, io);
  assert.equal(r.failed, false);
  assert.equal(r.fallbackFrom, 'circuit open');
  assert.equal(io.hits, 5, 'only the fallback was fetched');
});

test('JevFallback: when both fail the result is the fallback failure, its error unchanged', async () => {
  const io = fakeIo((req) => ({ status: req.url === PRIMARY ? 500 : 503, text: 'err' }));
  const r = await chain().ask('s', STUCK, io);
  assert.equal(r.failed, true);
  assert.equal(r.error, 'Jev HTTP 503');
  assert.equal(r.fallbackFrom, 'Jev HTTP 500');
  assert.equal(r.provider, '127.0.0.1:18016');
  assert.deepEqual(r.signals, { stuck: 'missing' });
});
