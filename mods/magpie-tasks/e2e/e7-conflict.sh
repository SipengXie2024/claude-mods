#!/usr/bin/env bash
# E7 (plan section 12.2): two background subagents of E3's architect change the same file in the
# shared task worktree. The later one's write is refused and it is paused with a file-conflict
# decision; resolve_conflict separate gives it its own worktree and wakes it; its result is merged
# back into the task worktree when it reports done.
source "$(dirname "$0")/lib.sh"
task=$(cat "$E/e3.task")
id=$(task_field "$task" .id)
sid=$(task_field "$task" .owner.sessionId)
short=$(task_field "$task" .owner.jobShortId)
tr=$(transcript_of "$sid")
log=$(log_of "$task")
conflicts0=$(jq '[.decisions[] | select(.kind == "file-conflict")] | length' "$task")
applied0=$(jq -s 'map(select(.type == "integration" and .status == "applied")) | length' "$log")
starts0=$(jq -s 'map(select(.type == "integration-start")) | length' "$log")

start e7 "$E/proj" claude attach "$short"
wait_ready e7 120
# Claude Code refuses a foreground `sleep 60` (it asks for Monitor or a background run), which would
# end A's turn at once; a Python sleep keeps A running while B starts.
say_and_wait e7 "$tr" '委派后台子代理 A：把 greet.py 输出的词改成 hi，然后运行 `python3 -c "import time; time.sleep(60)"`，再运行 `python3 greet.py`。等工作副本中的 greet.py 出现 hi 之后，委派后台子代理 B：把 greet.py 输出的词改成 hey 并运行 `python3 greet.py`。B 的写入被拒后，调用 `resolve_conflict`，`agent_id` 为 B，`decision` 为 `separate`。' 1200

# A and B run in the background: the architect's turn may end before B's write is refused.
check 'a file-conflict decision exists' wait_for 900 bash -c "jq -e '[.decisions[] | select(.kind == \"file-conflict\")] | length > $conflicts0' '$task'"
decision=$(jq -c '[.decisions[] | select(.kind == "file-conflict")] | last' "$task")
b=$(jq -r '.data.agentId // empty' <<<"$decision")
check 'B was refused with the pause reason' wait_for 60 bash -c "grep -l 'magpie-tasks has paused you' '$E'/cfg/projects/*/*/subagents/agent-$b.jsonl"
check 'the architect was told about the conflict' grep -q 'File conflict in the task worktree' "$tr"
check 'the decision was resolved' wait_for 300 bash -c "jq -e --arg d '$(jq -r .id <<<"$decision")' '.decisions[\$d].resolvedAt != null' '$task'"
check "B's separate worktree exists" test -d "$E/wt/$id-$b"
check "B's record names the separate worktree" wait_for 30 bash -c "jq -e --arg b '$b' --arg w '$E/wt/$id-$b' '.agents[\$b].worktree == \$w' '$task'"
check 'B was woken through the relay' wait_for 60 log_has "$task" "map(select(.type == \"relay\" and .agentId == \"$b\" and .stage == \"delivered\")) | length > 0"
check 'a new integration-start and applied integration (B into the task worktree)' wait_for 900 log_has "$task" "(map(select(.type == \"integration-start\")) | length > $starts0) and (map(select(.type == \"integration\" and .status == \"applied\")) | length > $applied0)"
check 'the task worktree prints hey' wait_for 60 bash -c "cd '$E/wt/$id' && python3 greet.py | grep -qx hey"
a=$(jq -r --arg b "$b" '.agents | to_entries | map(.value) | sort_by(.startedAt) | .[] | select(.agentId != $b and .startedAt > 0) | .agentId' "$task" | tail -2 | head -1)
check 'A keeps the task worktree' test "$(jq -r --arg a "$a" '.agents[$a].worktree' "$task")" = "$E/wt/$id"
cleanup e7
finish
