import assert, { test } from './assert';
import { isRoutedModel, modelLabel, openAIModelScale } from '../src/model';

test('Magpie 的 Astra 和 GPT-6.1 Sol 使用各自策略并接入判断', () => {
  for (const model of ['gpt-6-astra', 'codex/gpt-6-astra', 'gpt-6-astra-900k']) {
    assert.equal(openAIModelScale(model), 'astra');
    assert.equal(isRoutedModel(model), true);
  }
  for (const model of ['gpt-6.1-sol', 'codex/gpt-6.1-sol']) {
    assert.equal(openAIModelScale(model), 'sol-6.1');
    assert.equal(isRoutedModel(model), true);
  }
});

test('模型识别遵守版本范围与网关边界', () => {
  for (const model of ['codex/gpt-6-sol', 'codex/gpt-5.6-sol', 'codex/gpt-6.1-terra', 'codex/gpt-6-luna', 'gpt-6-astra-preview', 'claude/claude-fable-5-1']) {
    assert.equal(openAIModelScale(model), null, model);
    assert.equal(isRoutedModel(model), false, model);
  }
  for (const model of ['jev/gpt-6-astra', 'jev/gpt-6.1-sol', 'jev/claude-opus-5-5']) assert.equal(isRoutedModel(model), false, model);
  for (const model of ['claude/claude-opus-5-5', 'claude-mythos-5-1']) assert.equal(isRoutedModel(model), true, model);
});

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

test('Gemini 4 Argon under Magpie is routed; other Gemini models are not', () => {
  for (const model of ['antigravity/gemini-4-argon', 'gemini-4-argon', 'antigravity/gemini-4-argon-trial']) assert.equal(isRoutedModel(model), true, model);
  for (const model of ['antigravity/gemini-3.8-flash', 'antigravity/gemini-3.1-pro-low', 'antigravity/gemini-4-carbon']) assert.equal(isRoutedModel(model), false, model);
});

test('a model whose ID names its reasoning level is left at that level', () => {
  for (const model of ['hakimi/gemini-4-argon-high', 'hakimi/gemini-4-argon-medium', 'hakimi/gemini-4-carbon-low', 'hakimi/claude-opus-5-5-high', 'hakimi/claude-sonnet-5-5-medium[1m]']) assert.equal(isRoutedModel(model), false, model);
  for (const model of ['claude/claude-opus-5-5', 'claude-mythos-5-2[1m]', 'codex/gpt-6-astra-900k', 'codex/gpt-6.1-sol']) assert.equal(isRoutedModel(model), true, model);
});
