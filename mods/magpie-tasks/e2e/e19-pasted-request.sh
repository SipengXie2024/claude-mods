#!/usr/bin/env bash
# E19: the first message of a new claude-magpie window holds pasted text, in a directory that is not a
# Git repository. The window wraps the paste in <pasted_content> tags, and the background session's
# engine escapes those tags on the way in (`<\pasted_content`), so the text its first prompt.submit
# hook reads is not the message the plugin passed to `--bg`. The architect still claims its task,
# because the claim is found by the task its marker line names, and the pasted text reaches it.
# Claude Code tags a paste only where the feature flag tengu_virtual_pancake is on, as it is in the
# person's own ~/.claude.json (cachedGrowthBookFeatures); the fresh config of setup.sh has no flag,
# so this scenario sets it.
source "$(dirname "$0")/lib.sh"
mkdir -p "$E/proj2"
printf 'hello\n' > "$E/proj2/notes.txt"
jq '.cachedGrowthBookFeatures = ((.cachedGrowthBookFeatures // {}) + { tengu_virtual_pancake: true })' "$E/cfg/.claude.json" > "$E/cfg/.claude.json.new" \
  && mv "$E/cfg/.claude.json.new" "$E/cfg/.claude.json"
paste="$E/e19.paste"
for i in $(seq 1 40); do echo "PASTE-SENTINEL-4711 line $i: 背景记录 $i，只供参考，不需要处理。"; done > "$paste"

transcript_has() { local f; f=$(transcript_of "$1"); [ -n "$f" ] && grep -q -- "$2" "$f"; }

n0=$(task_count)
start e19 "$E/proj2" "$LAUNCHER" --debug-file "$E/e19.log"
wait_ready e19
tmux send-keys -t e19 -l '检查 notes.txt 并只回复 ok。下面是粘贴的背景记录：'
sleep 0.5
tmux load-buffer -b e19 "$paste"
tmux paste-buffer -p -b e19 -t e19
check 'the window shows the paste as a pasted text' wait_for 30 pane_has e19 'Pasted text'
sleep 0.5
tmux send-keys -t e19 Enter
check 'the long-task dialog opens' wait_for 120 dialog_open e19
dialog=$(tmux capture-pane -p -J -t e19)
check 'dialog says the task works in the directory, which is not a Git repository' grep -qF "直接修改：$E/proj2（不是 Git 仓库" <<<"$dialog"
sleep 1   # a key sent while the dialog is still being drawn is lost
key e19 Enter
claimed() { [ "$(task_count)" -gt "$n0" ] && jq -e '.owner.jobShortId != null' "$(newest_task)"; }
check 'the architect claims the task' wait_for 240 claimed
task=$(newest_task)
short=$(task_field "$task" .owner.jobShortId)
check 'the window switches to the architect session' wait_for 60 attached "$short"
echo "task $task, background session $short"
check 'the window wrapped the paste in paste tags' grep -q '<pasted_content id=' "$task"
check 'task is running' test "$(task_field "$task" .state)" = running
owner=$(task_field "$task" .owner.sessionId)
check 'launch claim was taken' test -z "$(ls -A "$E/state/claims" 2>/dev/null)"
check 'the log records the claim and no claim failure' log_has "$task" 'map(.type) | (index("claim") != null) and (index("claim-failed") == null)'
check 'the task debug log shows the claim' grep -q "magpie-tasks: role bg-unclaimed (session $owner" "$E/state/debug/$(basename "$task" .json).txt"
check 'the architect received the pasted text' wait_for 120 transcript_has "$owner" PASTE-SENTINEL-4711
claude stop "$short" >/dev/null 2>&1 || true
cleanup e19
finish
