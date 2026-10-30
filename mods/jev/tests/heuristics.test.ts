import assert, { test } from './assert';
import { heuristicTaskProfile } from '../src/heuristics';
import { isDeep, setDeepThresholds, taskEffort } from '../src/policy';

test('task heuristics classify common requests', () => {
  assert.equal(heuristicTaskProfile('thanks!').taskType, 'chat');
  assert.equal(heuristicTaskProfile('The login test is failing with a TypeError, please fix it').taskType, 'code');
  assert.equal(heuristicTaskProfile('Design the architecture for a multi-region event bus and discuss trade-offs').taskType, 'research');
  assert.equal(heuristicTaskProfile('Implement a new /export endpoint that streams CSV').taskType, 'code');
  assert.equal(heuristicTaskProfile('Refactor the payment module into smaller files').taskType, 'code');
  assert.equal(heuristicTaskProfile('Write a README for the CLI').taskType, 'write');
  assert.equal(heuristicTaskProfile('Deploy the service to staging').taskType, 'operate');
  assert.equal(heuristicTaskProfile('What does the --force flag do?').taskType, 'explain');
});

test('task heuristics: kind confidence 0.5; deep 0.55 when a deep word matches, else 0.3', () => {
  const plain = heuristicTaskProfile('Implement a new feature that adds a settings page');
  assert.equal(plain.typeConfidence, 0.5);
  assert.equal(plain.source, 'heuristic');
  assert.equal(plain.deep, 0.3);
  const deep = heuristicTaskProfile('Design the architecture for a multi-region event bus and discuss trade-offs');
  assert.equal(deep.deep, 0.55);
  assert.equal(taskEffort(deep, { min: 'low', max: 'max' }).effort, 'xhigh', 'a deep heuristic research task starts one above high');
});

test('task heuristics: unmatched requests default to research', () => {
  for (const prompt of ['rename x to y', 'anything']) {
    const p = heuristicTaskProfile(prompt);
    assert.equal(p.taskType, 'research', prompt);
    assert.equal(p.deep, 0.3, prompt);
    assert.equal(taskEffort(p, { min: 'low', max: 'max' }).effort, 'high', prompt);
  }
});

test('task heuristics: priority research > code > design > write > operate > explain, first match wins (chat only matches a whole social reply)', () => {
  const cases: Array<[string, string]> = [
    ['review the fix for the crash', 'research'], // research beats code
    ['分析一下这个报错', 'research'],
    ['fix the typo in the README', 'code'], // code beats write
    ['写一个脚本批量重命名图片', 'code'],
    ['fix the chart script that crashes', 'code'], // code beats design
    ['把讲稿写进这页 PPT', 'design'], // design beats write
    ['write the deploy notes', 'write'], // write beats operate
    ['总结一下怎么部署', 'write'],
    ['what does it take to restart the server', 'operate'], // operate beats explain
    ['部署是什么意思', 'operate'],
    ['感谢，顺便修一下这个报错', 'code'], // thanks followed by a request is not chat
  ];
  for (const [prompt, type] of cases) assert.equal(heuristicTaskProfile(prompt).taskType, type, prompt);
});

test('task heuristics classify Chinese requests', () => {
  const cases: Array<[string, string]> = [
    ['感谢', 'chat'],
    ['好的', 'chat'],
    ['提交吧', 'operate'],
    ['把这个传到 gdrive 里', 'operate'],
    ['改一下这个配置里的端口', 'operate'],
    ['修一下这个报错', 'code'],
    ['登录接口报错了，帮我排查一下', 'code'],
    ['程序一启动就崩溃', 'code'],
    ['服务挂了，跑不通', 'code'],
    ['把这个模块重构成更小的文件', 'code'],
    ['实现一个导出 CSV 的新接口', 'code'],
    ['给 parser 写测试', 'code'],
    ['帮我把这段话翻译成英文', 'write'],
    ['写一封请假邮件', 'write'],
    ['这个参数干嘛的', 'explain'],
    ['Rust 的所有权是什么', 'explain'],
    ['TCP 和 UDP 的区别', 'explain'],
    ['调研一下 X', 'research'],
    ['调研一下几种向量索引的优缺点并对比', 'research'],
    ['帮我设计一个多租户系统的架构方案', 'research'],
    ['证明这个算法的时间复杂度是 O(n log n)', 'research'],
    ['为什么要和 Octopus 比？？', 'research'],
    ['做个 PPT 讲一下这个协议', 'design'],
    ['做一个讲解视频，配音用克隆的声音', 'design'],
    ['美化一下这个页面', 'design'],
    ['这张图配色太难看了', 'design'],
  ];
  for (const [prompt, type] of cases) assert.equal(heuristicTaskProfile(prompt).taskType, type, prompt);
});

test('a Chinese bug-fix request is code and not routed to low effort', () => {
  const p = heuristicTaskProfile('修复 date 库里失败的测试');
  assert.equal(p.taskType, 'code');
  assert.notEqual(taskEffort(p, { min: 'low', max: 'high' }).effort, 'low');
});

test('Chinese deep words set deep 0.55, plain requests 0.3', () => {
  assert.equal(heuristicTaskProfile('修一下这个报错').deep, 0.3);
  assert.equal(heuristicTaskProfile('这个参数干嘛的').deep, 0.3);
  assert.equal(heuristicTaskProfile('为什么要和 Octopus 比？？').deep, 0.55);
  assert.equal(heuristicTaskProfile('帮我设计一个多租户系统的架构方案').deep, 0.55);
  assert.equal(heuristicTaskProfile('这两个方案对比一下，哪个更合理').deep, 0.55);
});

test('heuristics: greetings are chat, editing a passage is write, 调研 counts as deep', () => {
  assert.equal(heuristicTaskProfile('你好').taskType, 'chat');
  assert.equal(heuristicTaskProfile('hi!').taskType, 'chat');
  assert.equal(heuristicTaskProfile('帮我改一下这段').taskType, 'write');
  const r = heuristicTaskProfile('调研一下 X');
  assert.equal(r.taskType, 'research');
  assert.equal(r.deep, 0.55);
});

test('heuristics: several social tokens are still chat; deep words follow the configured thresholds', () => {
  assert.equal(heuristicTaskProfile('好的，谢谢').taskType, 'chat');
  assert.equal(heuristicTaskProfile('ok thanks').taskType, 'chat');
  assert.equal(heuristicTaskProfile('ok, fix it').taskType, 'code');
  try {
    setDeepThresholds({ yes: 0.88, no: 0.3 });
    assert.ok(isDeep(heuristicTaskProfile('why is this slow?')), 'a deep word is deep under a calibrated yes');
    assert.ok(!isDeep(heuristicTaskProfile('rename x to y')));
  } finally {
    setDeepThresholds({ yes: 0.5, no: 0.3 });
  }
});
