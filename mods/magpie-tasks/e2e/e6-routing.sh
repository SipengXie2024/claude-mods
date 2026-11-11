#!/usr/bin/env bash
# E6 (plan section 12.2; U8): subagents of E3's architect are routed by the rules: an implementation
# goes to code-change (Opus, in the task worktree, the marker as the brief's first line), a review to
# review, a second review by another model to review-second (Sol 6.1); an explicit model without a
# reason line is refused, with the person's reason it is taken; a Fable 5.1 subagent's own delegation
# (subagent-opus writes `opus` under a Fable parent) is routed by the rules on the same task.
source "$(dirname "$0")/lib.sh"
task=$(cat "$E/e3.task")
id=$(task_field "$task" .id)
sid=$(task_field "$task" .owner.sessionId)
short=$(task_field "$task" .owner.jobShortId)
tr=$(transcript_of "$sid")
agents() { jq -c '.agents | to_entries | map(.value) | sort_by(.startedAt) | .[]' "$task"; }
count() { jq '.agents | length' "$task"; }
nth() { jq -c --argjson n "$1" '.agents | to_entries | map(.value) | sort_by(.startedAt) | .[$n]' "$task"; }

start e6 "$E/proj" claude attach "$short"
wait_ready e6 120

n0=$(count)
say_and_wait e6 "$tr" '委派一个子代理：在工作副本里给 greet.py 加一个 main 函数并运行验证。等它完成后告诉我结果。' 900
a1=$(nth "$n0")
check '(1) routed by code-change' test "$(jq -r .ruleId <<<"$a1")" = code-change
check '(1) on Opus 5.5' test "$(jq -r .model <<<"$a1")" = claude/claude-opus-5-5
check '(1) xhigh or max' grep -qE '^(xhigh|max)$' <<<"$(jq -r .effort <<<"$a1")"
check '(1) works in the task worktree' test "$(jq -r .cwd <<<"$a1")" = "$E/wt/$id"
id1=$(jq -r .agentId <<<"$a1")
sub1=$(find "$E/cfg/projects" -name "agent-$id1.jsonl" | head -1)
check '(1) the brief starts with the task marker' bash -c "python3 -I -c 'import json,sys; d=json.loads(open(sys.argv[1]).readline()); c=d[\"message\"][\"content\"]; t=c if isinstance(c,str) else c[0][\"text\"]; sys.exit(0 if t.startswith(\"[magpie-tasks task=$id \") else 1)' '$sub1'"
check '(1) the worktree greet.py has a main function' grep -q 'def main' "$E/wt/$id/greet.py"

n1=$(count)
say_and_wait e6 "$tr" '委派子代理对这次修改做独立审查，等它完成后告诉我结论。' 900
a2=$(nth "$n1")
check '(2) routed by review' test "$(jq -r .ruleId <<<"$a2")" = review
check '(2) on Opus 5.5' test "$(jq -r .model <<<"$a2")" = claude/claude-opus-5-5
check '(2) medium or high' grep -qE '^(medium|high)$' <<<"$(jq -r .effort <<<"$a2")"

n2=$(count)
say_and_wait e6 "$tr" "用不同模型复核这次修改，委派说明里写 [review-of agent=$id1]。等它完成后告诉我结论。" 900
a3=$(nth "$n2")
check '(3) routed by review-second' test "$(jq -r .ruleId <<<"$a3")" = review-second
check '(3) on Sol 6.1' test "$(jq -r .model <<<"$a3")" = codex/gpt-6.1-sol

n3=$(count)
say_and_wait e6 "$tr" '用 Haiku 委派一个子代理统计 greet.py 的行数。委派时只指定模型，不要写任何理由行；如果被拒绝，停下并原样告诉我拒绝理由，不要重试。' 600
check '(4) no subagent started' test "$(count)" -eq "$n3"
check '(4) refused, asking for a model-reason line' bash -c "source '$(dirname "$0")/lib.sh'; tool_errors '$tr' | grep -q 'model-reason'"

say_and_wait e6 "$tr" '用 Haiku 委派一个子代理统计 greet.py 的行数，选 Haiku 是我指定的。' 600
a5=$(nth "$n3")
check '(5) on Haiku 5.5' test "$(jq -r .model <<<"$a5")" = claude/claude-haiku-5-5
check '(5) selection user' test "$(jq -r .selection.kind <<<"$a5")" = user

n5=$(count)
say_and_wait e6 "$tr" '用 Fable 5.1 委派一个子代理（我指定的模型），让它不指定模型再委派一个子代理统计 greet.py 的行数，等两层都完成后告诉我结果。' 1200
fable=$(jq -c '.agents | to_entries | map(.value) | map(select(.model == "claude/claude-fable-5-1")) | last' "$task")
check '(6) Fable subagent, selection user' test "$(jq -r .selection.kind <<<"$fable")" = user
fid=$(jq -r .agentId <<<"$fable")
nested=$(jq -c --arg p "$fid" '.agents | to_entries | map(.value) | map(select(.parentAgentId == $p)) | last' "$task")
check '(6) its delegation is recorded on the same task' test "$(jq -r .agentId <<<"$nested")" != null
check '(6) nested delegation routed by a rule' test "$(jq -r .selection.kind <<<"$nested")" = rule
check '(6) nested model is the rule model, not the alias opus' grep -q '/' <<<"$(jq -r .model <<<"$nested")"
check 'no recorded agent runs on the alias opus' test "$(jq '[.agents[] | select(.model == "opus")] | length' "$task")" -eq 0
echo "agents:"; agents | jq -c '{agentId, role, ruleId, model, effort, selection: .selection.kind, parentAgentId}'
cleanup e6
finish
