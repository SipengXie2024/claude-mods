import assert, { test } from './assert';
import { modConfig, parseEnvFile } from '../src/config';
import { hash20 } from '../src/hash';

test('parseEnvFile: comments, export, quotes and trailing comments', () => {
  const env = parseEnvFile([
    '# Jev backend',
    'JEV_BASE_URL=http://127.0.0.1:18013/v1/systemone',
    'export JEV_API_KEY="k-123"',
    "JEV_OPUS_ABLATE='r1, stuck'",
    'JEV_DEADLINE_MS=3500   # p50 1.6 s',
    'not a line',
    '',
  ].join('\n'));
  assert.deepEqual(env, {
    JEV_BASE_URL: 'http://127.0.0.1:18013/v1/systemone',
    JEV_API_KEY: 'k-123',
    JEV_OPUS_ABLATE: 'r1, stuck',
    JEV_DEADLINE_MS: '3500',
  });
});

test('modConfig: jev-opus defaults; no key means heuristics only', () => {
  const c = modConfig({});
  assert.equal(c.jev, null);
  assert.deepEqual(c.bounds, { min: 'low', max: 'high' });
  assert.deepEqual(c.followUp, { mode: 'on', yes: 0.75, advisor: true });
  assert.equal(c.stepStateMax, 6000);
});

test('modConfig: the live .env keys', () => {
  const c = modConfig({
    JEV_BASE_URL: 'http://127.0.0.1:18013/v1/systemone', JEV_API_KEY: 'k', JEV_DEADLINE_MS: '3500',
    JEV_OPUS_MIN_EFFORT: 'medium', JEV_OPUS_MAX_EFFORT: 'max', JEV_OPUS_DEEP_YES: '0.61', JEV_OPUS_DEEP_NO: '0.2',
    JEV_OPUS_DISSATISFACTION: 'shadow', JEV_OPUS_DISSAT_YES: '0.8', JEV_OPUS_DISSAT_ADVISOR: '0', JEV_OPUS_ABLATE: 'R1,stuck',
    JEV_OPUS_STEP_STATE_MAX: '100',
  });
  assert.equal(c.jev?.baseUrl, 'http://127.0.0.1:18013/v1/systemone');
  assert.equal(c.jev?.deadlineMs, 3500);
  assert.deepEqual(c.bounds, { min: 'medium', max: 'max' });
  assert.deepEqual(c.deep, { yes: 0.61, no: 0.2 });
  assert.deepEqual(c.followUp, { mode: 'shadow', yes: 0.8, advisor: false });
  assert.deepEqual(c.ablate, ['r1', 'stuck']);
  assert.equal(c.stepStateMax, 6000, 'below the 3000 minimum falls back to the default');
  assert.equal(modConfig({ JEV_OPUS_DISSATISFACTION: '0' }).followUp.mode, null);
  assert.deepEqual(modConfig({ JEV_OPUS_MIN_EFFORT: 'max', JEV_OPUS_MAX_EFFORT: 'low' }).bounds, { min: 'low', max: 'max' }, 'misordered bounds swap');
});

test('hash20: stable 20-hex identities that differ for nearby inputs', () => {
  assert.match(hash20(''), /^[0-9a-f]{20}$/);
  assert.equal(hash20('Bash:npm test'), hash20('Bash:npm test'));
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(hash20(`Bash:npm test -- case-${i}`));
  assert.equal(seen.size, 2000);
  assert.notEqual(hash20('ab'), hash20('ba'));
  assert.notEqual(hash20('测试'), hash20('测验'));
});
