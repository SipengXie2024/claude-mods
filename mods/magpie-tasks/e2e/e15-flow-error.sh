#!/usr/bin/env bash
# E15 (plan section 12.2): a flow hook error. The worktree directory is read-only, so making the task
# worktree fails after the person confirms: the window shows the error line and the drop, the message
# does not reach the model, the task is in state error with the cause, no background session starts,
# and the window stays open.
source "$(dirname "$0")/lib.sh"
mkdir -p "$E/proj3" && printf 'x\n' > "$E/proj3/a.txt"
bg_before=$(agents_json | jq '[.[] | select(.kind == "background")] | length')
chmod 500 "$E/wt"
start e15 "$E/proj3" claude-magpie --debug-file "$E/e15.log"
wait_ready e15
type_line e15 '检查 a.txt'
check 'the long-task dialog opens' wait_for 120 dialog_open e15
key e15 Enter
check 'the error line is shown' wait_for 120 pane_has e15 'magpie-tasks: 出错（任务'
check 'the message was dropped with the error' wait_for 30 pane_has e15 'Prompt dropped by a hook: magpie-tasks 出错：'
t=$(grep -l "\"root\": *\"$E/proj3\"" "$E"/state/tasks/l-*.json | head -1)
check 'the task is in state error' test "$(task_field "$t" .state)" = error
check 'the error names the worktree failure' bash -c "jq -r .error '$t' | grep -qiE 'worktree|Permission denied|mkdir'"
check 'the project is the one of this window' test "$(task_field "$t" .project.root)" = "$E/proj3"
check 'no new background session' test "$(agents_json | jq '[.[] | select(.kind == "background")] | length')" -eq "$bg_before"
check 'the window is still open' bash -c "source '$(dirname "$0")/lib.sh' >/dev/null; ! pane_dead e15"
chmod 700 "$E/wt"
type_line e15 '/exit'
cleanup e15
finish
