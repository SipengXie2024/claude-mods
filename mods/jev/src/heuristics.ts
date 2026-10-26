import type { TaskType } from './questions';
import type { TaskProfile } from './types';
import { getDeepThresholds } from './policy';

/** The task profile used when Jev is disabled or unreachable. */

// Chinese alternatives sit outside the \b group: \b only sees ASCII word characters, so it never matches around CJK text.
// Ordered by the task.v3 tie-break (research > code > write > operate > explain > chat): the first match wins.
const SOCIAL = '(?:thanks?|thank you|ok(?:ay)?|hi|hello|hey|好的?|可以|感谢|谢谢|哈哈|收到|嗯|你好|早|晚安)';
const TYPE_PATTERNS: Array<[TaskType, RegExp]> = [
  ['research', /\b(review|analy[sz]e|compare|research|investigate|audit|evaluate|benchmark|architect(ure)?|design|trade-?offs?|prove|proof|derive|improve)\b|调研|分析|评审|审阅|对比|比较|研究|架构|设计|权衡|选型|证明|推导|改进|合理吗|对不对|怎么看/i],
  ['code', /\b(bug|fix|crash|error|exception|stack ?trace|fail(s|ing|ed)?|regression|refactor|implement|function|script|regex|unit tests?)\b|修复|修一下|报错|崩溃|排查|跑不通|挂了|重构|实现|函数|脚本|代码|单测|写测试|加测试|补测试/i],
  // Bare 写 is writing only when no code artifact follows in the same clause, so 写一个脚本 is caught as code above.
  ['write', /\b(write|draft|rewrite|summari[sz]e|translate|email|essay|blog|readme|docs?|documentation|paper|rebuttal)\b|写(?![^，。,.;；\n]*(脚本|函数|代码|程序|正则|配置|模块|服务|接口|测试|类))|翻译|润色|总结|摘要|文档|邮件|论文|改写|这段|这句|措辞/i],
  ['operate', /\b(run|install|deploy|upload|push|commit|restart|start|stop|clean ?up|sync|upgrade|config)\b|提交|推送|部署|安装|上传|传到|同步|重启|启动|停止|清理|运行|跑一下|配置/i],
  ['explain', /^(what|who|when|where|which|how (do|does|can|to)|explain|define)\b|是什么|什么是|干嘛|怎么用|区别|啥意思|解释/i],
  // One or more social tokens and nothing else: 好的，谢谢 and "ok thanks" are chat too.
  ['chat', new RegExp(`^${SOCIAL}(?:[\\s,，、!！。.~]+${SOCIAL})*[\\s!！。.~]*$`, 'i')],
];

const DEEP_WORDS = /\b(why|whether|design|trade-?offs?|compare|prove|derive|root cause|architect(ure)?|improve)\b|为什么|是否|调研|设计|权衡|对比|比较|证明|推导|原因|架构|合理|改进/i;

/** A deep word counts as deep and its absence as not deep under whatever thresholds are configured. */
function heuristicDeep(matched: boolean): number {
  const t = getDeepThresholds();
  return matched ? Math.max(0.55, t.yes) : Math.min(0.3, t.no);
}

export function heuristicTaskProfile(prompt: string): TaskProfile {
  const text = prompt.trim();
  // Unmatched requests default to research: a mid-level start.
  let taskType: TaskType = 'research';
  for (const [type, re] of TYPE_PATTERNS) {
    if (re.test(text)) { taskType = type; break; }
  }
  return {
    taskType,
    typeConfidence: 0.5,
    deep: heuristicDeep(DEEP_WORDS.test(text)),
    source: 'heuristic',
  };
}
