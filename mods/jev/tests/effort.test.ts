import assert, { test } from './assert';
import { describeBounds, effortAuto, effortTag } from '../src/effort';

test('effortTag: a range, a lower bound, a single level, anywhere in the prompt, any case', () => {
  assert.deepEqual(effortTag('[effort xhigh..max] rewrite the parser'), { min: 'xhigh', max: 'max' });
  assert.deepEqual(effortTag('rewrite the parser [effort >=xhigh]'), { min: 'xhigh' });
  assert.deepEqual(effortTag('[effort max]'), { min: 'max', max: 'max' });
  assert.deepEqual(effortTag('[ Effort  LOW .. High ]'), { min: 'low', max: 'high' });
  assert.deepEqual(effortTag('先看 [effort >= high] 这个'), { min: 'high' });
});

test('effortTag: nothing without a tag or with a level that is not one', () => {
  assert.equal(effortTag('use high effort for this'), null);
  assert.equal(effortTag('[effort ultra]'), null);
  assert.equal(effortTag('[effort]'), null);
  assert.equal(effortTag('effort: xhigh..max'), null);
});

test('describeBounds', () => {
  assert.equal(describeBounds({ min: 'xhigh', max: 'max' }), 'xhigh..max');
  assert.equal(describeBounds({ min: 'max', max: 'max' }), 'max');
});

test('decision 5: [effort auto] cancels a /effort pin and is no range', () => {
  assert.equal(effortAuto('[effort auto] 继续'), true);
  assert.equal(effortAuto('go on [ Effort AUTO ]'), true);
  assert.equal(effortAuto('[effort high]'), false);
  assert.equal(effortTag('[effort auto]'), null);
});
