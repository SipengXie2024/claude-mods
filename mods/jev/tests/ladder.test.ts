import assert, { test } from './assert';
import { Ladder } from '../src/ladder';

test('decision 3: a first failure opens nothing that raises; a rerun with no change in between is no repeat', () => {
  const l = new Ladder();
  assert.equal(l.noteCheck('a', true).outcome, 'first-failure');
  assert.equal(l.noteCheck('a', true).outcome, 'rerun-failure');
  assert.deepEqual(l.repeatFailing(), []);
});

test('decision 3/4: the same check failing again after a code change is a repeat, each one needing its own change', () => {
  const l = new Ladder();
  l.noteCheck('a', true);
  l.noteEdit();
  const second = l.noteCheck('a', true);
  assert.deepEqual([second.outcome, second.failures], ['repeat-failure', 2]);
  assert.equal(l.noteCheck('a', true).outcome, 'rerun-failure', 'no change since the repeat');
  l.noteEdit();
  assert.equal(l.noteCheck('a', true).outcome, 'repeat-failure');
  assert.deepEqual(l.repeatFailing(), ['a']);
});

test('decision 4: an edit before a check first fails does not count; another check\'s failure is its own', () => {
  const l = new Ladder();
  l.noteEdit();
  l.noteCheck('a', true);
  assert.equal(l.noteCheck('b', true).outcome, 'first-failure');
  l.noteEdit();
  assert.equal(l.noteCheck('b', true).outcome, 'repeat-failure');
  assert.equal(l.noteCheck('a', true).outcome, 'repeat-failure', 'the edit came after a\'s failure too');
});

test('a pass clears the check, and says whether a raise was made for it', () => {
  const l = new Ladder();
  l.noteCheck('a', true);
  l.noteEdit();
  l.noteCheck('a', true);
  l.markRaised('a');
  assert.deepEqual(l.noteCheck('a', false), { outcome: 'pass', failures: 0, passedAfterRaise: true });
  assert.equal(l.open, 0);
  assert.deepEqual(l.repeatFailing(), []);
  assert.equal(l.noteCheck('a', true).outcome, 'first-failure', 'after a pass the next failure starts over');
  assert.deepEqual(l.noteCheck('c', false), { outcome: 'pass', failures: 0, passedAfterRaise: false });
});
