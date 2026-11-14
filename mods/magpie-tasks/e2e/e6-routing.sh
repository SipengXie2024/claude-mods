#!/usr/bin/env bash
# E6 (plan section 12.2; U8): subagents of E3's architect are routed by the rules: an implementation
# goes to code-change (in the project directory the task changes in place, the marker as the brief's
# first line), a review to a review rule, a second review naming the first reviewer to review-second on
# a model other than the first reviewer's; an explicit model without a reason line is refused, with the
# person's reason it is taken; a Fable 5.1 subagent's own delegation (subagent-opus writes `opus` under
# a Fable parent) is routed by the rules on the same task. Expected models and efforts come from the
# rules file and the judgment recorded on each agent (lib.sh rule_start).
source "$(dirname "$0")/lib.sh"
task=$(cat "$E/e3.task")
id=$(task_field "$task" .id)
sid=$(task_field "$task" .owner.sessionId)
short=$(task_field "$task" .owner.jobShortId)
tr=$(transcript_of "$sid")
agents() { jq -c '.agents | to_entries | map(.value) | sort_by(.startedAt) | .[]' "$task"; }
count() { jq '.agents | length' "$task"; }
ids() { jq -c '.agents | keys' "$task"; }
# started <ids before> [jq filter]: the first agent the architect itself started since (no parent),
# oldest first, among those the filter keeps; the architect may start more than the one asked for.
started() { jq -c --argjson old "$1" ".agents | to_entries | map(.value) | map(select((.agentId | IN(\$old[])) | not) | select(.parentAgentId == null) | select(${2:-true})) | sort_by(.startedAt) | .[0]" "$task"; }

start e6 "$E/proj" claude attach "$short"
wait_ready e6 120

i0=$(ids)
say_and_wait e6 "$tr" '委派一个子代理：给 greet.py 加一个 main 函数并运行验证。等它完成后告诉我结果。' 900
a1=$(started "$i0")
check '(1) routed by code-change' test "$(jq -r .ruleId <<<"$a1")" = code-change
want1=$(rule_start "$a1")
echo "(1) code-change for this judgment: $want1; recorded: $(jq -r '"\(.model) \(.effort)"' <<<"$a1")"
check "(1) on the rule's model and start effort ($want1)" test "$(jq -r '"\(.model) \(.effort)"' <<<"$a1")" = "$want1"
check '(1) works in the project directory' test "$(jq -r .cwd <<<"$a1")" = "$E/proj"
id1=$(jq -r .agentId <<<"$a1")
sub1=$(find "$E/cfg/projects" -name "agent-$id1.jsonl" | head -1)
check '(1) the brief starts with the task marker' bash -c "python3 -I -c 'import json,sys; d=json.loads(open(sys.argv[1]).readline()); c=d[\"message\"][\"content\"]; t=c if isinstance(c,str) else c[0][\"text\"]; sys.exit(0 if t.startswith(\"[magpie-tasks task=$id \") else 1)' '$sub1'"
check '(1) the project greet.py has a main function' grep -q 'def main' "$E/proj/greet.py"

# (2) The architect may name the implementer in its review brief ([review-of agent=…], as the
# model_route tool describes), which makes the first review a review-second one on a model other than
# the implementer's; without it the review rule takes it.
REVIEWS='.ruleId == "review" or .ruleId == "review-second"'
# review_second_model <reviewed model>: the model review-second picks for it (src/rules.ts
# reviewSecondTarget: the whenOriginalIncludes entry for that model, else `otherwise`).
review_second_model() { jq -r --arg o "$1" '.reviewSecond | .whenOriginalIncludes[$o] // .otherwise' "$RULES"; }
review_second_effort() { if [ "$(jq -r .judgment.deep <<<"$1")" = true ]; then rule_field review-second .deepEffort; else rule_field review-second .effort; fi; }
i1=$(ids)
say_and_wait e6 "$tr" '委派子代理对这次修改做独立审查，等它完成后告诉我结论。' 900
a2=$(started "$i1" "$REVIEWS")
check '(2) a review subagent is started' test "$(jq -r .agentId <<<"$a2")" != null
if [ "$(jq -r .ruleId <<<"$a2")" = review ]; then
  want2=$(rule_start "$a2")
else
  want2="$(review_second_model "$(jq -r .model <<<"$a1")") $(review_second_effort "$a2")"
fi
echo "(2) $(jq -r .ruleId <<<"$a2") for this judgment: $want2; recorded: $(jq -r '"\(.model) \(.effort)"' <<<"$a2")"
check "(2) on its rule's model and start effort ($want2)" test "$(jq -r '"\(.model) \(.effort)"' <<<"$a2")" = "$want2"
id2=$(jq -r .agentId <<<"$a2"); m2=$(jq -r .model <<<"$a2")

# (3) A second review by another model than the first reviewer's.
i2=$(ids)
say_and_wait e6 "$tr" "请再委派一个子代理，用和上一位审查者不同的模型复核这次修改；这是我要求的第二次审查，即使上一次审查已经用过不同模型也照做。委派说明里写 [review-of agent=$id2]。等它完成后告诉我结论。" 900
a3=$(started "$i2" "$REVIEWS")
want3="$(review_second_model "$m2") $(review_second_effort "$a3")"
echo "(3) review-second of $m2: $want3; recorded: $(jq -r '"\(.ruleId) \(.model) \(.effort) reviewOf \(.reviewOf)"' <<<"$a3")"
check '(3) routed by review-second' test "$(jq -r .ruleId <<<"$a3")" = review-second
check "(3) it reviews the first reviewer's model ($m2)" jq -e --arg m "$m2" '.reviewOf | index($m) != null' <<<"$a3"
check "(3) on the model and effort review-second gives ($want3)" test "$(jq -r '"\(.model) \(.effort)"' <<<"$a3")" = "$want3"
check '(3) a model other than the first reviewer'"'"'s' test "$(jq -r .model <<<"$a3")" != "$m2"

n3=$(count); i3=$(ids)
say_and_wait e6 "$tr" '用 Haiku 委派一个子代理统计 greet.py 的行数。委派时只指定模型，不要写任何理由行；如果被拒绝，停下并原样告诉我拒绝理由，不要重试。' 600
check '(4) no subagent started' test "$(count)" -eq "$n3"
check '(4) refused, asking for a model-reason line' bash -c "source '$(dirname "$0")/lib.sh'; tool_errors '$tr' | grep -q 'model-reason'"

say_and_wait e6 "$tr" '用 Haiku 委派一个子代理统计 greet.py 的行数，选 Haiku 是我指定的。' 600
a5=$(started "$i3")
check '(5) on Haiku 5.5' test "$(jq -r .model <<<"$a5")" = claude/claude-haiku-5-5
check '(5) selection user' test "$(jq -r .selection.kind <<<"$a5")" = user

i5=$(ids)
say_and_wait e6 "$tr" '用 Fable 5.1 委派一个子代理（我指定的模型），让它不指定模型再委派一个子代理统计 greet.py 的行数，等两层都完成后告诉我结果。' 1200
fable=$(started "$i5" '.model == "claude/claude-fable-5-1"')
check '(6) Fable subagent, selection user' test "$(jq -r .selection.kind <<<"$fable")" = user
fid=$(jq -r .agentId <<<"$fable")
# The architect's turn may end once the Fable subagent runs in the background, before that subagent
# has delegated: wait for the nested record.
nested_of() { jq -c --arg p "$fid" '.agents | to_entries | map(.value) | map(select(.parentAgentId == $p)) | sort_by(.startedAt) | .[0]' "$task"; }
check '(6) its delegation is recorded on the same task' wait_for 600 bash -c "jq -e --arg p '$fid' '[.agents[] | select(.parentAgentId == \$p)] | length > 0' '$task'"
nested=$(nested_of)
check '(6) nested delegation routed by a rule' test "$(jq -r .selection.kind <<<"$nested")" = rule
check '(6) nested model is the rule model, not the alias opus' grep -q '/' <<<"$(jq -r .model <<<"$nested")"
check 'no recorded agent runs on the alias opus' test "$(jq '[.agents[] | select(.model == "opus")] | length' "$task")" -eq 0
echo "agents:"; agents | jq -c '{agentId, role, ruleId, model, effort, selection: .selection.kind, parentAgentId}'
cleanup e6
finish
