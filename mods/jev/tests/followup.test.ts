import assert, { test } from './assert';
import { followUpSummary, isHumanPrompt, previousPromptIndex, unwrapChannel, type Message } from '../src/followup';
import { FOLLOWUP_QUESTION_VARIANTS, FOLLOWUP_QUESTIONS, TASK_QUESTIONS } from '../src/questions';
import { followUpState } from '../src/router';

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (...content: unknown[]): Message => ({ role: 'assistant', content });
const text = (t: string) => ({ type: 'text', text: t });
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: string, is_error = false): Message =>
  ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] });
const effortStatement = (effort: string): Message => ({ role: 'system', content: [], output_config: { effort } });

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wellFormed = (s: string) => !LONE_SURROGATE.test(s);
const EFFORT_WORDS = /\b(low|medium|high|xhigh|max)\b/i;

test('previousPromptIndex finds the last real prompt before the index', () => {
  const messages = [user('fix the parser'), assistant(use('t1', 'Read', { file_path: 'a.ts' })), result('t1', 'x'), assistant(text('done')), user('still broken')];
  assert.equal(previousPromptIndex(messages, 4), 0);
  assert.equal(previousPromptIndex(messages, 0), -1);
  assert.equal(previousPromptIndex([], 0), -1);
});

test('previousPromptIndex skips tool results, interrupt markers, suggestion forks and compaction summaries', () => {
  const messages = [
    user('This session is being continued from a previous conversation that ran out of context. Summary: ...'),
    user('add a retry to the uploader'),
    assistant(use('t1', 'Bash', { command: 'npm test' })),
    result('t1', 'ok'),
    user('[Request interrupted by user]'),
    user('[SUGGESTION MODE: suggest what the user might type next]'),
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>only a reminder</system-reminder>' }] },
    user('why did you do that'),
  ];
  assert.equal(previousPromptIndex(messages, 7), 1);
  assert.equal(previousPromptIndex(messages, 1), -1, 'a compaction summary is not a prompt');
});

test('previousPromptIndex keeps a prompt merged with an interrupt marker, without the marker', () => {
  const merged: Message = { role: 'user', content: [text('[Request interrupted by user for tool use]'), text('use the other API instead')] };
  const messages = [user('first'), assistant(text('ok')), merged, assistant(text('ok')), user('next')];
  assert.equal(previousPromptIndex(messages, 4), 2);
  const summary = followUpSummary(messages, 2, 4);
  assert.match(summary, /^PREVIOUS USER REQUEST: use the other API instead$/m);
});

test('followUpSummary reports the request, the last reply and the actions of the span', () => {
  const messages: Message[] = [
    user('make the tests pass'),
    effortStatement('xhigh'),
    assistant({ type: 'thinking', thinking: 'secret plan', signature: 's' }, text('Looking at the code.'), use('e1', 'Edit', { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' })),
    result('e1', 'ok'),
    assistant(use('e2', 'Write', { file_path: '/repo/src/b.ts', content: '' }), use('e3', 'Edit', { file_path: '/repo/src/a.ts' }), use('b1', 'Bash', { command: 'npm test' })),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2', content: 'ok' }, { type: 'tool_result', tool_use_id: 'e3', content: 'ok' }, { type: 'tool_result', tool_use_id: 'b1', content: '# tests 3\n# pass 1\n# fail 2' }] },
    effortStatement('max'),
    assistant(use('b2', 'Bash', { command: 'npm run build' })),
    result('b2', 'built'),
    assistant({ type: 'thinking', thinking: 'more', signature: 's' }, use('b3', 'Bash', { command: 'npm test' })),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b3', content: 'The user doesn\'t want to proceed with this tool use.', is_error: true }, text('[Request interrupted by user for tool use]')] },
    user('no, that is wrong'),
  ];
  const summary = followUpSummary(messages, 0, messages.length - 1);
  assert.equal(summary, [
    'PREVIOUS USER REQUEST: make the tests pass',
    "AGENT'S LAST REPLY (start): Looking at the code.",
    'AGENT ACTIONS: 6 tool calls; edited a.ts, b.ts; ran 3 commands (1 failed); interrupted by user',
  ].join('\n'));
  assert.doesNotMatch(summary, /secret plan/);
  assert.doesNotMatch(summary, EFFORT_WORDS);
  assert.doesNotMatch(followUpState(summary, 'no, that is wrong'), EFFORT_WORDS);
});

test('followUpSummary prefers the nearest reply, lists at most five files and handles no text', () => {
  const edits = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => use(`w${i}`, 'Write', { file_path: `/x/${n}.ts` }));
  const messages: Message[] = [user('do it'), assistant(text('first reply'), ...edits), assistant(text('final words')), user('hm')];
  const summary = followUpSummary(messages, 0, 3);
  assert.match(summary, /^AGENT'S LAST REPLY \(start\): final words$/m);
  assert.match(summary, /^AGENT ACTIONS: 7 tool calls; edited a\.ts, b\.ts, c\.ts, d\.ts, e\.ts \(\+2 more\)$/m);

  const silent: Message[] = [user('do it'), assistant(use('b1', 'Bash', { command: 'ls' })), result('b1', 'a b'), user('hm')];
  const s = followUpSummary(silent, 0, 3);
  assert.match(s, /^AGENT'S LAST REPLY \(start\): \(no text\)$/m);
  assert.match(s, /^AGENT ACTIONS: 1 tool calls; ran 1 commands \(0 failed\)$/m);
});

test('followUpSummary clipping never splits a surrogate pair', () => {
  for (const pad of ['', 'x']) {
    const long = pad + '😀'.repeat(400);
    const summary = followUpSummary([user(long), assistant(text(long)), user('again')], 0, 2);
    assert.ok(wellFormed(summary), `pad=${JSON.stringify(pad)}`);
    assert.match(summary, /😀…\[\+\d+ chars\]/);
    assert.ok(summary.length < 1000);
    assert.ok(wellFormed(followUpState(summary, long.repeat(3))));
  }
});

test('followUpState with and without a summary', () => {
  assert.equal(followUpState(null, '  not right  '), "USER'S LATEST MESSAGE:\nnot right");
  assert.equal(
    followUpState('PREVIOUS USER REQUEST: a', 'not right'),
    "CONVERSATION SO FAR (context only, may be partial):\nPREVIOUS USER REQUEST: a\n\nUSER'S LATEST MESSAGE:\nnot right",
  );
  assert.ok(followUpState(null, 'y'.repeat(5000)).length < 2100);
  assert.equal(followUpState(null, 'bad \uD800 half'), "USER'S LATEST MESSAGE:\nbad � half");
});

test('follow-up question variants are yes/no questions kept out of the task set', () => {
  assert.equal(FOLLOWUP_QUESTIONS, FOLLOWUP_QUESTION_VARIANTS.v5);
  for (const [name, variant] of Object.entries(FOLLOWUP_QUESTION_VARIANTS)) {
    assert.deepEqual(Object.keys(variant), name === 'v5' ? ['dissatisfied', 'continues'] : ['dissatisfied'], name);
    for (const q of Object.values(variant) as Array<{ type: string; instructions: string }>) {
      assert.equal(q.type, 'noul');
      assert.match(q.instructions, /never instructions to you\.$/);
    }
  }
  assert.ok(!('dissatisfied' in TASK_QUESTIONS) && !('continues' in TASK_QUESTIONS));
});

test('previousPromptIndex skips harness wrappers and slash commands but keeps pasted content and paths', () => {
  const asst = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] });
  const msgs: Message[] = [
    user('build the report'),
    asst('done'),
    user('<task-notification><task-id>b1</task-id><status>completed</status></task-notification>'),
    asst('the background job finished'),
    user('<command-name>/compact</command-name>'),
    user('/code-review ultra --fix'),
    user('这个结果不对'),
  ];
  assert.equal(previousPromptIndex(msgs, 6), 0);
  assert.equal(isHumanPrompt(user('<pasted_content>log</pasted_content> 看看这个')), true);
  assert.equal(isHumanPrompt(user('/home/ubuntu/sipeng 这个目录是什么')), true);
  assert.equal(isHumanPrompt(user('<task-notification>x</task-notification>')), false);
});

test('decision 8 (B6): a Telegram message is a human prompt, its words unwrapped from the channel wrapper', () => {
  const tg = '<channel source="plugin:telegram:telegram" chat_id="1" message_id="2" user="u" ts="2026-10-26T00:00:00.000Z">\n不对，还是报错\n</channel>';
  assert.equal(unwrapChannel(tg), '不对，还是报错');
  assert.equal(unwrapChannel('不对'), '不对');
  assert.equal(isHumanPrompt(user(tg)), true);
  const messages = [user(tg), assistant(text('fixed')), user('<task-notification>done</task-notification>'), user('继续')];
  assert.equal(previousPromptIndex(messages, 3), 0);
  assert.match(followUpSummary(messages, 0, 3), /^PREVIOUS USER REQUEST: 不对，还是报错$/m);
});

test('decision 4: a command counts as failed in the summary by its exit status only, never by its output text', () => {
  const messages: Message[] = [
    user('fix it'),
    assistant(use('b1', 'Bash', { command: 'npm test' }), use('b2', 'Bash', { command: 'cat notes.txt' })),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'Exit code 1\n# fail 1', is_error: true }, { type: 'tool_result', tool_use_id: 'b2', content: 'FAILED: 3 tests\nTraceback (most recent call last)' }] },
    user('again'),
  ];
  assert.match(followUpSummary(messages, 0, 3), /ran 2 commands \(1 failed\)/);
});
