#!/usr/bin/env bash
# E14 (plan section 12.2; U11): the person names a model Magpie does not have. The delegation is taken
# as the person's choice; the subagent ends on an API error; the plugin records the StopFailure
# category on the agent (failed, model-unavailable), opens a model-unavailable decision and tells
# the architect, and starts no substitute; the question opens as a dialog in the attached window. It
# runs last of E3's scenarios (after E10), since it leaves the task waiting for the person.
source "$(dirname "$0")/lib.sh"
task=$(cat "$E/e3.task")
sid=$(task_field "$task" .owner.sessionId)
short=$(task_field "$task" .owner.jobShortId)
tr=$(transcript_of "$sid")
n0=$(jq '.agents | length' "$task")
start e14 "$E/proj" claude attach "$short"
wait_ready e14 120
say_and_wait e14 "$tr" '按我的指定用模型 codex/gpt-6-magpie-missing 委派一个子代理统计 greet.py 的行数，说明中写 [model-reason user: 测试不可用模型]。' 900
agent=$(jq -c '.agents | to_entries | map(.value) | map(select(.model == "codex/gpt-6-magpie-missing")) | last' "$task")
check 'the delegation was taken (selection user)' test "$(jq -r .selection.kind <<<"$agent")" = user
check 'the agent failed as model-unavailable' wait_for 300 bash -c "jq -e '.agents | to_entries | map(.value) | map(select(.model == \"codex/gpt-6-magpie-missing\")) | last | .state == \"failed\" and .failure.kind == \"model-unavailable\"' '$task'"
echo "StopFailure category: $(jq -r '.agents | to_entries | map(.value) | map(select(.model == "codex/gpt-6-magpie-missing")) | last | .failure.error' "$task")"
check 'a model-unavailable decision' bash -c "jq -e '[.decisions[] | select(.kind == \"model-unavailable\")] | length > 0' '$task'"
check 'the question opens as a dialog in the window' wait_for 30 dialog_open e14
check 'the dialog is the model-unavailable question' pane_has e14 '模型不可用'
check 'the architect was told' grep -q 'codex/gpt-6-magpie-missing' "$tr"
check 'no substitute was started' test "$(jq '[.agents[] | select(.selection.kind == "unavailable-substitute")] | length' "$task")" -eq 0
cleanup e14
# E14 is the last scenario that needs E3's architect (E12 reads only records): stop it.
stop_background
finish
