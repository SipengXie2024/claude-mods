import assert, { test } from './assert';
import { checkId } from '../src/describe';
import { Ladder } from '../src/ladder';
import { productionToolResults } from './fixtures';

// Commands from a 2026-09-28 production session (tests/fixtures.ts) whose
// output looked like failures. policy.v10 judges a check by its exit code
// alone, so what matters is which of them are checks at all.

test('production false alarms: source, diff and history reads are no checks, so their output can never raise', () => {
  for (const c of [...productionToolResults.falseFailures, ...productionToolResults.suspectOnly]) {
    const id = checkId(c.command);
    if (id === null) continue;
    // A judged check among them succeeded: exit 0 is a pass, whatever it printed.
    const l = new Ladder();
    assert.equal(l.noteCheck(id, false).outcome, 'pass', c.case);
  }
  const judged = [...productionToolResults.falseFailures, ...productionToolResults.suspectOnly].filter((c) => checkId(c.command) !== null);
  assert.deepEqual(judged.map((c) => c.case), [], 'every one of them pipes or reads');
});

test('decision 4: genuine failures behind a pipe are not judged, since the pipe hides the exit code', () => {
  for (const c of productionToolResults.genuineFailures) assert.equal(checkId(c.command), null, c.case);
  // The same suites run plainly are checks.
  assert.ok(checkId('cd /repo/docs/frontierharness; python3 -m pytest') !== null);
  assert.ok(checkId('cd /repo/agents/clause-fg/packages/runtime && npx tsc --noEmit -p . && npm test') !== null);
});
