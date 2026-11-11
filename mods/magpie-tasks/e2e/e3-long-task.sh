#!/usr/bin/env bash
# E3 (plan section 12.2; U1, U4): the first message of a new claude-magpie window in a directory that
# is not a Git repository becomes a long task. The confirmation names the repository the plugin will
# create; after the recommended model is chosen the plugin commits a baseline, makes the task
# worktree, starts the architect in the background (it claims the task), and the window exits
# showing `claude attach <id>`. Writes the task file path to $E/e3.task for E5–E7, E10, E12, E14.
# The architect keeps running for E5–E7, E10 and E14 (in that order); E14 stops it.
source "$(dirname "$0")/lib.sh"
mkdir -p "$E/proj"
printf 'print("hello")\n' > "$E/proj/greet.py"

start e3 "$E/proj" claude-magpie --debug-file "$E/e3.log"
wait_ready e3
type_line e3 '检查 greet.py 并只回复 ok'
check 'the long-task dialog opens' wait_for 120 dialog_open e3
dialog=$(tmux capture-pane -p -J -t e3)
check 'dialog says a Git repository will be created' grep -qF '建立 Git 仓库' <<<"$dialog"
check 'dialog counts 1 file' grep -qF '1 个文件' <<<"$dialog"
sleep 1   # a key sent while the dialog is still being drawn is lost
key e3 Enter
check 'the foreground window exits (U1)' wait_for 240 pane_dead e3
out=$(pane e3)
check 'the pane keeps the claude attach line' grep -qE 'claude attach [0-9a-f]{8}' <<<"$out"
short=$(grep -oE 'claude attach [0-9a-f]{8}' <<<"$out" | tail -1 | awk '{print $3}')
task=$(newest_task)
echo "$task" > "$E/e3.task"
echo "task $task, background session $short"
check 'baseline commit in the new repository' bash -c "git -C '$E/proj' log --format=%s | grep -qx 'magpie-tasks baseline'"
check 'one commit only' test "$(git -C "$E/proj" rev-list --count HEAD)" -eq 1
id=$(task_field "$task" .id)
check 'task worktree exists' test -d "$E/wt/$id"
check 'task is running' test "$(task_field "$task" .state)" = running
owner=$(task_field "$task" .owner.sessionId)
row=$(agents_json | jq -c --arg cwd "$E/proj" '[.[] | select(.kind == "background" and .cwd == $cwd)] | last')
check 'owner is the background session in the project root' test "$(jq -r .sessionId <<<"$row")" = "$owner"
check 'owner short id matches the attach line' test "$(task_field "$task" .owner.jobShortId)" = "$short"
check 'launch claim was taken' test -z "$(ls -A "$E/state/claims" 2>/dev/null)"
model=$(task_field "$task" .architect.model)
check "Magpie served the architect session on $model" wait_for 120 usage_has "^$owner $model"
# U4: the plugin starts the architect with --debug-file <stateDir>/debug/<task>.txt.
check 'the task debug log shows the claim (U4)' grep -q "magpie-tasks: role bg-unclaimed (session $owner" "$E/state/debug/$(basename "$task" .json).txt"
cleanup e3
finish
