#!/usr/bin/env bash
# E3 (plan section 12.2; U1, U4): the first message of a new claude-magpie window in a Git repository
# becomes a long task. No other task changes the repository in place, so the confirmation says the
# task works in the project directory itself; after the recommended model is chosen the plugin
# records a base commit of the directory under refs/magpie-tasks/ (no commit on any branch, no
# worktree), starts the architect in the background (it claims the task), and the launcher switches
# the window to that session. Returns once the architect's first turn has ended, and writes the task
# file path to $E/e3.task for E5–E7, E10, E12, E14.
# The architect keeps running for E5–E7, E10 and E14 (in that order); E14 stops it.
source "$(dirname "$0")/lib.sh"
mkdir -p "$E/proj"
( cd "$E/proj" && git init -q && printf 'print("hello")\n' > greet.py && git add . \
  && git -c user.email=e2e@magpie -c user.name=e2e commit -qm init )

n0=$(task_count)
start e3 "$E/proj" "$LAUNCHER" --debug-file "$E/e3.log"
wait_ready e3
type_line e3 '检查 greet.py 并只回复 ok'
check 'the long-task dialog opens' wait_for 120 dialog_open e3
dialog=$(tmux capture-pane -p -J -t e3)
check 'dialog says the task works in the project directory' grep -qF "直接修改：$E/proj" <<<"$dialog"
check 'dialog creates no repository' bash -c "! grep -qF '建立 Git 仓库' <<<'$dialog'"
check 'dialog says the window switches to the architect session' grep -qF '这个窗口随即切换到那个会话' <<<"$dialog"
sleep 1   # a key sent while the dialog is still being drawn is lost
key e3 Enter
claimed() { [ "$(task_count)" -gt "$n0" ] && jq -e '.owner.jobShortId != null' "$(newest_task)"; }
check 'the architect claims the task (U1)' wait_for 240 claimed
task=$(newest_task)
short=$(task_field "$task" .owner.jobShortId)
check 'the window switches to the architect session' wait_for 60 attached "$short"
check 'the window shows the architect session' wait_for 60 pane_has e3 "$E/state/debug/$(basename "$task" .json).txt"
echo "$task" > "$E/e3.task"
echo "task $task, background session $short"
check 'one commit only' test "$(git -C "$E/proj" rev-list --count HEAD)" -eq 1
id=$(task_field "$task" .id)
check 'the task works in the project directory' test "$(task_field "$task" .direct.dir)" = "$E/proj"
check 'its base commit is the base ref' test "$(git -C "$E/proj" rev-parse "refs/magpie-tasks/$id/base")" = "$(task_field "$task" .direct.baseCommit)"
check 'no task worktree' test ! -e "$E/wt/$id"
check 'task is running' test "$(task_field "$task" .state)" = running
owner=$(task_field "$task" .owner.sessionId)
row=$(agents_json | jq -c --arg cwd "$E/proj" '[.[] | select(.kind == "background" and .cwd == $cwd)] | last')
check 'owner is the background session in the project root' test "$(jq -r .sessionId <<<"$row")" = "$owner"
check 'launch claim was taken' test -z "$(ls -A "$E/state/claims" 2>/dev/null)"
model=$(task_field "$task" .architect.model)
check "Magpie served the architect session on $model" wait_for 120 usage_has "^$owner $model"
# U4: the plugin starts the architect with --debug-file <stateDir>/debug/<task>.txt.
check 'the task debug log shows the claim (U4)' grep -q "magpie-tasks: role bg-unclaimed (session $owner" "$E/state/debug/$(basename "$task" .json).txt"
# The scenarios after this one count the architect's turns from here on (say_and_wait); a first turn
# still running when they send their own prompt would be counted as the end of theirs.
first_turn_ended() { local tr; tr=$(transcript_of "$owner"); [ -n "$tr" ] && [ "$(turns "$tr")" -ge 1 ]; }
check "the architect's first turn has ended" wait_for 600 first_turn_ended
cleanup e3
finish
