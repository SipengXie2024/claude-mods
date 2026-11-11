import assert, { test } from './assert';
import { keyFilePath, modConfig, parseEnvFile } from '../src/config';
import { hash20 } from '../src/hash';

test('parseEnvFile: comments, export, quotes and trailing comments', () => {
  const env = parseEnvFile([
    '# Jev',
    'JEV_API_KEY_FILE=~/.config/jev-opus/openai-jev.key',
    'export JEV_API_KEY="k-123"',
    "JEV_OPUS_ABLATE='r1, stuck'",
    'JEV_DEADLINE_MS=3500   # p50 1.6 s',
    'JEV_OPUS_DEEP_YES="0.85" # gpt-6-luna',
    "JEV_MODEL='gpt-6-luna'   # the Decisions model",
    'not a line',
    '',
  ].join('\n'));
  assert.deepEqual(env, {
    JEV_API_KEY_FILE: '~/.config/jev-opus/openai-jev.key',
    JEV_API_KEY: 'k-123',
    JEV_OPUS_ABLATE: 'r1, stuck',
    JEV_DEADLINE_MS: '3500',
    JEV_OPUS_DEEP_YES: '0.85',
    JEV_MODEL: 'gpt-6-luna',
  });
});

test('modConfig: defaults; no key means heuristics only', () => {
  const c = modConfig({});
  assert.equal(c.jevKeyFile, null);
  assert.equal(c.staleKey, false);
  assert.deepEqual(c.jev, { model: 'gpt-6-luna', deadlineMs: 10_000, breakerThreshold: 3, breakerCooldownMs: 30_000, confidence: 'recompute' });
  assert.deepEqual(c.bounds, { min: 'low', max: 'high' });
  assert.deepEqual(c.followUp, { mode: 'on', yes: 0.75, advisor: true });
  assert.equal(c.explore, 0.1);
});

test('modConfig: the key comes from JEV_API_KEY_FILE only; JEV_API_KEY is noted as stale and never taken as a key', () => {
  assert.equal(modConfig({ JEV_API_KEY_FILE: '~/.config/jev-opus/openai-jev.key' }).jevKeyFile, '~/.config/jev-opus/openai-jev.key');
  assert.deepEqual([modConfig({ JEV_API_KEY: 'k' }).jevKeyFile, modConfig({ JEV_API_KEY: 'k' }).staleKey], [null, true]);
  assert.deepEqual([modConfig({ JEV_API_KEY: 'k', JEV_API_KEY_FILE: '/keys/jev' }).jevKeyFile, modConfig({ JEV_API_KEY: 'k', JEV_API_KEY_FILE: '/keys/jev' }).staleKey], ['/keys/jev', true]);
  assert.equal(modConfig({ JEV_API_KEY: '  ' }).staleKey, false, 'a blank value is none');
  assert.ok(!JSON.stringify(modConfig({ JEV_API_KEY: 'k-123' })).includes('k-123'), 'the value is not kept');
});

test('keyFilePath: ~/ is the home folder, a relative path the config folder', () => {
  assert.equal(keyFilePath('~/.config/jev-opus/openai-jev.key', '/home/u', '/cfg'), '/home/u/.config/jev-opus/openai-jev.key');
  assert.equal(keyFilePath('/keys/jev', '/home/u', '/cfg'), '/keys/jev');
  assert.equal(keyFilePath('openai-jev.key', '/home/u', '/cfg'), '/cfg/openai-jev.key');
});

test('modConfig: the live .env keys', () => {
  const c = modConfig({
    JEV_API_KEY_FILE: '~/.config/jev-opus/openai-jev.key', JEV_MODEL: 'gpt-6-luna-2', JEV_DEADLINE_MS: '3500',
    JEV_OPUS_MIN_EFFORT: 'medium', JEV_OPUS_MAX_EFFORT: 'max', JEV_OPUS_DEEP_YES: '0.61', JEV_OPUS_DEEP_NO: '0.2',
    JEV_OPUS_DISSATISFACTION: 'shadow', JEV_OPUS_DISSAT_YES: '0.8', JEV_OPUS_DISSAT_ADVISOR: '0', JEV_OPUS_ABLATE: 'R1,stuck',
    JEV_OPUS_EXPLORE: '0.25',
  });
  assert.equal(c.jev.model, 'gpt-6-luna-2');
  assert.equal(c.jev.deadlineMs, 3500);
  assert.deepEqual(c.bounds, { min: 'medium', max: 'max' });
  assert.deepEqual(c.deep, { yes: 0.61, no: 0.2 });
  assert.deepEqual(c.followUp, { mode: 'shadow', yes: 0.8, advisor: false });
  assert.deepEqual(c.ablate, ['r1', 'stuck']);
  assert.equal(c.explore, 0.25);
  assert.equal(modConfig({ JEV_OPUS_EXPLORE: '0' }).explore, 0);
  assert.equal(modConfig({ JEV_OPUS_EXPLORE: '1.5' }).explore, 0.1, 'outside 0..1 falls back to the default');
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
