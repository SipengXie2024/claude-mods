import assert, { test } from './assert';
import { modelLabel } from '../src/model';

test('modelLabel: a Claude id names its family and version', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('claude-opus-4-20250514'), 'Opus 4');
  assert.equal(modelLabel('claude-opus-5-5[1m]'), 'Opus 5.5 (1M)');
});

test('modelLabel: an alias is its family', () => {
  assert.equal(modelLabel('opus'), 'Opus');
  assert.equal(modelLabel('sonnet[1m]'), 'Sonnet (1M)');
});

test('modelLabel: anything else as given', () => {
  assert.equal(modelLabel('jev/claude-opus-5-5[1m]'), 'jev/claude-opus-5-5[1m]');
  assert.equal(modelLabel('us.anthropic.claude-opus-4-1-20250805-v1:0'), 'us.anthropic.claude-opus-4-1-20250805-v1:0');
  assert.equal(modelLabel('gpt-5'), 'gpt-5');
});
