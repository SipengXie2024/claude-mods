#!/usr/bin/env bash
# E10 (plan section 12.2): E3's architect is stopped while its task is running; the next claude-magpie
# window's startup recovery resumes it under its own session ID with the recovery message. Runs before
# E14, which leaves the task waiting for the person (recovery resumes such a task too, with another
# message: E22).
source "$(dirname "$0")/lib.sh"
task=$(cat "$E/e3.task")
sid=$(task_field "$task" .owner.sessionId)
short=$(task_field "$task" .owner.jobShortId)
tr=$(transcript_of "$sid")
claude stop "$short" >/dev/null
check 'the architect session stopped' wait_for 60 bash -c "source '$(dirname "$0")/lib.sh'; agents_json | jq -e --arg s '$sid' '.[] | select(.sessionId == \$s) | .pid == null'"
check 'the task stays running' test "$(task_field "$task" .state)" = running
rm -f "$E/state/state/recovery.json"
before=$(jq -s 'map(select(.type == "recovery")) | length' "$(log_of "$task")")
start e10 "$E" claude-magpie --model claude/claude-haiku-5-5 --debug-file "$E/e10.log"
wait_ready e10
check 'a recovery entry in the task log' wait_for 180 bash -c "[ \$(jq -s 'map(select(.type == \"recovery\")) | length' '$(log_of "$task")') -gt $before ]"
check 'the architect runs again under its own session ID' wait_for 120 bash -c "source '$(dirname "$0")/lib.sh'; agents_json | jq -e --arg s '$sid' '.[] | select(.sessionId == \$s) | .pid != null'"
check 'it received the recovery message' wait_for 120 grep -q 'magpie-tasks recovery] This session was interrupted' "$tr"
type_line e10 '/exit'
cleanup e10
finish
