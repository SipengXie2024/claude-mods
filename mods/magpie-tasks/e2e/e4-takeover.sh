#!/usr/bin/env bash
# E4 (plan section 12.2; U6): resuming an existing claude-magpie session asks once whether to take it
# over as a long task. (a) Declined: recorded by session ID, and the next resume of the same session
# is not asked again (interactive --resume keeps the session ID). (b) Accepted: after the answer the
# session goes to the background with /bg; the copy claims the task (new session ID as owner, the old
# one in previousSessionIds) and gets the architect context.
source "$(dirname "$0")/lib.sh"
p2="$E/proj2"
mkdir -p "$p2"
( cd "$p2" && git init -q && echo 'print("two")' > two.py && git add . && git -c user.email=e2e@magpie -c user.name=e2e commit -qm init )
cd "$p2"
A=$(claude-magpie -p --model claude/claude-haiku-5-5 --output-format json '回复 ok' | jq -r .session_id)
B=$(claude-magpie -p --model claude/claude-haiku-5-5 --output-format json '回复 ok' | jq -r .session_id)
echo "sessions A=$A B=$B"
check '-p runs record no task' test "$(task_count)" -eq "$(ls "$E"/state/tasks/*.json 2>/dev/null | grep -vc '\.log\.jsonl$')"

# (a) decline, then resume again
start e4a "$p2" claude-magpie --resume "$A" --model claude/claude-opus-5-5 --debug-file "$E/e4a.log"
wait_ready e4a
check '(a) the resumed session keeps its ID' wait_for 30 debug_has "$E/e4a.log" "magpie-tasks: role candidate \\(session $A"
trA=$(transcript_of "$A")
answered() { [ "$(turns "$trA")" -gt "$1" ]; }
tasks0=$(tasks_with l- | wc -l)
type_line e4a '回复 ok'
check '(a) the takeover dialog opens' wait_for 60 dialog_open e4a
n=$(turns "$trA")
key e4a Down; sleep 0.5; key e4a Enter
check '(a) declined: recorded in state/declined.json' wait_for 60 bash -c "jq -e --arg a '$A' '.sessions[\$a] != null' '$E/state/state/declined.json'"
check '(a) the message is answered' wait_for 180 answered "$n"
type_line e4a '/exit'; sleep 3; cleanup e4a
start e4a2 "$p2" claude-magpie --resume "$A" --model claude/claude-opus-5-5 --debug-file "$E/e4a2.log"
wait_ready e4a2
n=$(turns "$trA")
type_line e4a2 '再回复 ok'
check '(a) second resume: the message is answered' wait_for 180 answered "$n"
check '(a) second resume: no dialog was shown' bash -c "! tmux capture-pane -p -J -t e4a2 -S -200 | grep -qF '接管'"
check '(a) no task was recorded for the declined session' test "$(tasks_with l- | wc -l)" -eq "$tasks0"
type_line e4a2 '/exit'; sleep 3; cleanup e4a2

# (b) accept
n0=$(tasks_with l- | wc -l)
start e4b "$p2" claude-magpie --resume "$B" --model claude/claude-opus-5-5 --debug-file "$E/e4b.log"
wait_ready e4b
type_line e4b '回复 ok'
check '(b) the takeover dialog opens' wait_for 60 dialog_open e4b
key e4b Enter
check '(b) a task is recorded' wait_for 120 more_tasks l- "$n0"
t=$(tasks_with l- | xargs -r ls -t | head -1)
check '(b) the session goes to the background' wait_for 300 pane_has e4b 'backgrounded · '
short=$(pane e4b | grep -oE 'backgrounded · [0-9a-f]{8}' | tail -1 | awk '{print $3}')
check '(b) the copy claimed the task (U6)' wait_for 120 bash -c "jq -e --arg b '$B' '.owner.previousSessionIds | index(\$b) != null' '$t'"
newsid=$(task_field "$t" .owner.sessionId)
check '(b) the new owner is the background copy' test "${newsid:0:8}" = "$short"
cleanup e4b
start e4c "$p2" claude attach "$short"
wait_ready e4c 120
wait_for 60 bash -c "find '$E/cfg/projects' -name '$newsid.jsonl' | grep -q ."
tr=$(transcript_of "$newsid")
say_and_wait e4c "$tr" '现在你的职责是什么？一句话回答。' 300
check '(b) the next prompt carries the architect context' grep -q 'You are the architect of long task' "$tr"
cleanup e4c
claude stop "$short" >/dev/null
finish
