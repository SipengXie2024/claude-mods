#!/usr/bin/env bash
# E21: the model-unavailable question of a long task is asked in the architect's window. As in E14,
# the person names a model Magpie does not have, so the subagent ends on an API error and no rule
# offers a substitute. The question opens as a dialog in a pane attached to E3's architect, with 等待
# and one 改用 <model> per candidate; the person picks a 改用 option (the third option when there are
# three or more), and that label is recorded as the answer and handed to the architect as it stands.
# Nothing goes to Telegram before telegramAfterMinutes. Runs after E3 (and after E20, if both run) in
# an environment made by `e2e/setup.sh --forward`.
source "$(dirname "$0")/lib.sh"
task=$(cat "$E/e3.task")
id=$(task_field "$task" .id)
sid=$(task_field "$task" .owner.sessionId)
short=$(task_field "$task" .owner.jobShortId)
tr=$(transcript_of "$sid")
dbg="$E/state/debug/$id.txt"
check 'the task has a Telegram chat and a one-minute wait' test "$(task_field "$task" .telegram.chatId)/$(jq -r '.pluginConfigs["magpie-tasks@sipeng-mods"].options.telegramAfterMinutes' "$E/cfg/settings.json")" = 1/1
curls() { grep -c 'process.run (magpie-tasks): curl with' "$dbg" || true; }
unavailable() { jq '[.decisions[] | select(.kind == "model-unavailable")] | length' "$task"; }

start e21 "$E/proj" claude attach "$short"
wait_ready e21 120
check 'the architect is idle' wait_for 600 bash -c "claude agents --json --all | jq -e --arg s '$sid' '.[] | select(.sessionId == \$s) | .status == \"idle\"'"
u0=$(unavailable); sent0=$(curls)
type_line e21 '按我的指定用模型 codex/gpt-6-magpie-missing 委派一个子代理统计 greet.py 的行数，说明中写 [model-reason user: 测试不可用模型]。委派之后不要做别的。'
check 'a model-unavailable decision exists' wait_for 900 bash -c "[ \$(jq '[.decisions[] | select(.kind == \"model-unavailable\")] | length' '$task') -gt $u0 ]"
d=$(jq -c '[.decisions[] | select(.kind == "model-unavailable")] | sort_by(.createdAt) | last' "$task")
q=$(jq -r .id <<<"$d")
echo "options: $(jq -c .options <<<"$d")"
check 'its options are 等待 and the 改用 candidates' jq -e '.options[0] == "等待" and (.options | length >= 2) and (.options[1:] | all(startswith("改用 ")))' <<<"$d"
check 'the question opens as a dialog in the window' wait_for 30 dialog_open e21
tmux capture-pane -p -J -t e21 > "$E/e21.dialog"
check 'the dialog is the model-unavailable question with its options' bash -c "grep -qF '模型不可用' '$E/e21.dialog' && grep -qF '1. 等待' '$E/e21.dialog' && grep -qF \"2. $(jq -r '.options[1]' <<<"$d")\" '$E/e21.dialog'"
check 'the task waits for the person' test "$(task_field "$task" .state)" = waiting-user
# The third option when there is one, else the second: a 改用 option either way.
n=$(jq '.options | length' <<<"$d")
if [ "$n" -ge 3 ]; then pick=2; else pick=1; fi
label=$(jq -r --argjson i "$pick" '.options[$i]' <<<"$d")
echo "choosing option $((pick + 1)): $label"
for ((k = 0; k < pick; k++)); do sleep 1; key e21 Down; done
sleep 1; key e21 Enter
check 'the label chosen is recorded as the answer, from the window' wait_for 30 bash -c "jq -e --arg q '$q' --arg l '$label' '.decisions[\$q] | .answer == \$l and .via == \"window\"' '$task'"
answered=$(jq -s --arg q "$q" '(map(select(.type == "decision" and .decision == $q and .via == "window")) | last | .at) - (map(select(.type == "ask" and .decision == $q)) | first | .at)' "$(log_of "$task")")
echo "answered ${answered} ms after the question was asked"
check 'the architect reads the label as the answer' wait_for 120 grep -qF "The person answered decision $q (model-unavailable) in the window: $label. It was carried out: the person answered \\\"$label\\\"" "$tr"
check 'the task runs again' test "$(task_field "$task" .state)" = running
check 'nothing was sent to Telegram' test "$(curls)" = "$sent0"
check 'the decision has no Telegram message' test "$(jq -r --arg q "$q" '.decisions[$q].telegram' "$task")" = null
cleanup e21
finish
