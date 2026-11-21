#!/usr/bin/env bash
# E4 (plan section 12.2; U6): resuming an existing claude-magpie session asks once whether to take it
# over as a long task. (a) Declined: recorded by session ID, and the next resume of the same session
# is not asked again (interactive --resume keeps the session ID). (a2) The same through /resume typed
# in a window that had already started: the process goes on under the resumed session's ID, and the
# decline is recorded under that ID. (b2) Accepted after /resume in a running launcher window: the task
# names the resumed session as the earlier owner; the architect session resumed with /resume in
# another window is the architect again. (b) Accepted: after the answer the
# session goes to the background with /bg; the copy claims the task (new session ID as owner, the old
# one in previousSessionIds), the launcher switches the window to the copy, and the copy gets the
# architect context.
source "$(dirname "$0")/lib.sh"
p2="$E/proj2"
mkdir -p "$p2"
( cd "$p2" && git init -q && echo 'print("two")' > two.py && git add . && git -c user.email=e2e@magpie -c user.name=e2e commit -qm init )
cd "$p2"
A=$(claude-magpie -p --model claude/claude-haiku-5-5 --output-format json '回复 ok' | jq -r .session_id)
B=$(claude-magpie -p --model claude/claude-haiku-5-5 --output-format json '回复 ok' | jq -r .session_id)
C=$(claude-magpie -p --model claude/claude-haiku-5-5 --output-format json '回复 ok' | jq -r .session_id)
D=$(claude-magpie -p --model claude/claude-haiku-5-5 --output-format json '回复 ok' | jq -r .session_id)
echo "sessions A=$A B=$B C=$C D=$D"
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

# (a2) decline after /resume in a running window, then /resume it again in another window
trC=$(transcript_of "$C")
answeredC() { [ "$(turns "$trC")" -gt "$1" ]; }
for w in e4r e4r2; do
  start $w "$p2" claude-magpie --model claude/claude-opus-5-5 --debug-file "$E/$w.log"
  wait_ready $w
  check "($w) the window decided its role first" wait_for 60 debug_has "$E/$w.log" 'magpie-tasks: role candidate'
  type_line $w "/resume $C"
  check "($w) the plugin follows the switch" wait_for 60 debug_has "$E/$w.log" "magpie-tasks: session switched to $C \\(resume\\)"
  check "($w) the resumed session is a candidate" wait_for 30 debug_has "$E/$w.log" "magpie-tasks: role candidate \\(session $C"
  n=$(turns "$trC")
  type_line $w '回复 ok'
  if [ $w = e4r ]; then
    check '(a2) the takeover dialog opens' wait_for 60 dialog_open $w
    key $w Down; sleep 0.5; key $w Enter
    check '(a2) declined under the resumed session ID' wait_for 60 bash -c "jq -e --arg c '$C' '.sessions[\$c] != null' '$E/state/state/declined.json'"
  fi
  check "($w) the message is answered" wait_for 180 answeredC "$n"
  [ $w = e4r2 ] && check '(a2) second /resume: no dialog was shown' bash -c "! tmux capture-pane -p -J -t e4r2 -S -200 | grep -qF '接管'"
  type_line $w '/exit'; sleep 3; cleanup $w
done
check '(a2) no task was recorded for the declined session' test "$(tasks_with l- | wc -l)" -eq "$tasks0"

# (b) accept
n0=$(tasks_with l- | wc -l)
start e4b "$p2" "$LAUNCHER" --resume "$B" --model claude/claude-opus-5-5 --debug-file "$E/e4b.log"
wait_ready e4b
type_line e4b '回复 ok'
check '(b) the takeover dialog opens' wait_for 60 dialog_open e4b
key e4b Enter
check '(b) a task is recorded' wait_for 120 more_tasks l- "$n0"
t=$(tasks_with l- | xargs -r ls -t | head -1)
check '(b) the copy claimed the task (U6)' wait_for 420 bash -c "jq -e --arg b '$B' '.owner.previousSessionIds | index(\$b) != null' '$t'"
newsid=$(task_field "$t" .owner.sessionId)
short=$(task_field "$t" .owner.jobShortId)
check '(b) the new owner is the background copy' test "${newsid:0:8}" = "$short"
check '(b) the window switches to the background copy' wait_for 60 attached "$short"
cleanup e4b
start e4c "$p2" claude attach "$short"
wait_ready e4c 120
# The copy writes its own transcript file when its first prompt arrives. The history it copied
# holds the takeover turn: one completed turn and one architect context.
type_line e4c '现在你的职责是什么？一句话回答。'
check '(b) the copy writes its transcript' wait_for 120 bash -c "find '$E/cfg/projects' -name '$newsid.jsonl' | grep -q ."
tr=$(transcript_of "$newsid")
answered_b() { [ "$(turns "$tr")" -ge 2 ]; }
check '(b) the copy answers the prompt' wait_for 300 answered_b
contexts() { jq -s '[.[] | select(.type == "attachment") | tostring | select(contains("You are the architect of long task"))] | length' "$tr"; }
check '(b) the next prompt carries the architect context' test "$(contexts)" -ge 2
cleanup e4c
claude stop "$short" >/dev/null

# (b2) accept after /resume in a running launcher window
n0=$(tasks_with l- | wc -l)
start e4s "$p2" "$LAUNCHER" --model claude/claude-opus-5-5 --debug-file "$E/e4s.log"
wait_ready e4s
check '(b2) the window decided its role first' wait_for 60 debug_has "$E/e4s.log" 'magpie-tasks: role candidate'
type_line e4s "/resume $D"
check '(b2) the plugin follows the switch' wait_for 60 debug_has "$E/e4s.log" "magpie-tasks: session switched to $D \\(resume\\)"
type_line e4s '回复 ok'
check '(b2) the takeover dialog opens' wait_for 60 dialog_open e4s
key e4s Enter
check '(b2) a task is recorded' wait_for 120 more_tasks l- "$n0"
t2=$(tasks_with l- | xargs -r ls -t | head -1)
check '(b2) the copy claimed the task taken over from the resumed session' wait_for 420 bash -c "jq -e --arg d '$D' '.owner.previousSessionIds | index(\$d) != null' '$t2'"
newsid2=$(task_field "$t2" .owner.sessionId)
short2=$(task_field "$t2" .owner.jobShortId)
check '(b2) the window switches to the background copy' wait_for 60 attached "$short2"
cleanup e4s
start e4u "$p2" claude attach "$short2"
wait_ready e4u 120
type_line e4u '一句话回答：你现在的职责是什么？'
check '(b2) the copy writes its transcript' wait_for 120 bash -c "find '$E/cfg/projects' -name '$newsid2.jsonl' | grep -q ."
tr2=$(transcript_of "$newsid2")
answered2() { [ "$(turns "$tr2")" -gt "$1" ]; }
check '(b2) the copy answers the prompt' wait_for 300 answered2 1
cleanup e4u
claude stop "$short2" >/dev/null; sleep 5
# the architect session, resumed with /resume in a window that had already started
start e4v "$p2" claude-magpie --model claude/claude-opus-5-5 --debug-file "$E/e4v.log"
wait_ready e4v
check '(b2) the second window decided its role first' wait_for 60 debug_has "$E/e4v.log" 'magpie-tasks: role candidate'
type_line e4v "/resume $newsid2"
check '(b2) the resumed architect session is the architect' wait_for 60 debug_has "$E/e4v.log" "magpie-tasks: role architect \\(session $newsid2"
n=$(turns "$tr2")
type_line e4v '一句话回答：你负责哪个长期任务？'
check '(b2) the architect answers' wait_for 300 answered2 "$n"
check '(b2) no takeover dialog for the architect session' bash -c "! tmux capture-pane -p -J -t e4v -S -200 | grep -qF '接管这个会话'"
check '(b2) still one task for the session' test "$(tasks_with l- | wc -l)" -eq "$((n0 + 1))"
type_line e4v '/exit'; sleep 3; cleanup e4v
finish
