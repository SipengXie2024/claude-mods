#!/usr/bin/env bash
# E22: startup recovery brings stopped architects back to their windows. Runs after E3 (and E20, E21,
# if they run) in an environment made by `e2e/setup.sh --forward` (chat `1`, a refused bot token,
# telegramAfterMinutes 1).
#
#   A  E3's task waits on an open window question: a subagent on a model Magpie does not have leaves
#      a model-unavailable question, and the architect is stopped before its minute runs out.
#   B  a second long task in the same project works in a Git worktree (E3's task changes the project
#      in place); its architect is stopped and the worktree removed, which recovery cannot resume from.
#
# A claude-magpie window then runs startup recovery. Both architects are resumed under their own
# session IDs: A stays waiting for the person, its dialog is back and its overdue question goes to
# Telegram at once; B gets an 'interrupted' decision (继续 / 暂停) as a dialog in its window and
# refuses model_route until the person answers, and lets it through after 继续. The window that ran
# recovery is the one that sends B's architect its requests (e2e/peer-send, the call the Router makes).
source "$(dirname "$0")/lib.sh"
taskA=$(cat "$E/e3.task")
idA=$(task_field "$taskA" .id)
sidA=$(task_field "$taskA" .owner.sessionId)
shortA=$(task_field "$taskA" .owner.jobShortId)
trA=$(transcript_of "$sidA")
dbgA="$E/state/debug/$idA.txt"
peer="$E/peer-send.json"
check 'the task has a Telegram chat and a one-minute wait' test "$(task_field "$taskA" .telegram.chatId)/$(jq -r '.pluginConfigs["magpie-tasks@sipeng-mods"].options.telegramAfterMinutes' "$E/cfg/settings.json")" = 1/1
curls() { grep -c 'process.run (magpie-tasks): curl with' "$1" || true; }
idle() { claude agents --json --all | jq -e --arg s "$1" '.[] | select(.sessionId == $s) | .status == "idle"' >/dev/null; }
# Not in a turn: idle, or `waiting` while a plugin dialog is open (such a session still takes a peer
# message, which starts a turn).
resting() { claude agents --json --all | jq -e --arg s "$1" '.[] | select(.sessionId == $s) | .status == "idle" or .status == "waiting"' >/dev/null; }
stopped() { claude agents --json --all | jq -e --arg s "$1" '.[] | select(.sessionId == $s) | .pid == null' >/dev/null; }
alive() { claude agents --json --all | jq -e --arg s "$1" '.[] | select(.sessionId == $s) | .pid != null' >/dev/null; }

# ---- A: a question left open in the window, the architect stopped within its minute ----------------
start e22a "$E/proj" claude attach "$shortA"
wait_ready e22a 120
check 'architect A is idle' wait_for 600 idle "$sidA"
check "A's subagents have come to rest" wait_for 600 jq -e '[.agents[] | select(.state == "running" or .state == "paused")] | length == 0' "$taskA"
u0=$(jq '[.decisions[] | select(.kind == "model-unavailable")] | length' "$taskA")
sent0=$(curls "$dbgA")
type_line e22a '按我的指定用模型 codex/gpt-6-magpie-missing 委派一个子代理统计 greet.py 的行数，说明中写 [model-reason user: 测试不可用模型]。委派之后不要做别的。'
check 'A has a new model-unavailable decision' wait_for 900 bash -c "[ \$(jq '[.decisions[] | select(.kind == \"model-unavailable\")] | length' '$taskA') -gt $u0 ]"
claude stop "$shortA" >/dev/null
qa=$(jq -r '[.decisions[] | select(.kind == "model-unavailable")] | sort_by(.createdAt) | last | .id' "$taskA")
askedA=$(jq -r --arg q "$qa" '.decisions[$q].askedAt' "$taskA")
echo "A: decision $qa asked at $askedA, stopped $(( $(date +%s%3N) - askedA )) ms later"
check 'A was stopped before its minute ran out' test "$(( $(date +%s%3N) - askedA ))" -lt 60000
check 'architect A stopped' wait_for 60 stopped "$sidA"
sentA=$(curls "$dbgA")
check 'A sent nothing to Telegram before it stopped' test "$sentA" = "$sent0"
check 'A waits for the person' test "$(task_field "$taskA" .state)" = waiting-user
check "A's question is open" test "$(jq -r --arg q "$qa" '.decisions[$q].resolvedAt' "$taskA")" = null
cleanup e22a

# ---- B: a second task in a worktree; stopped, its worktree removed ----------------------------------
before=$(tasks_with l-)
start e22b "$E/proj" "$LAUNCHER" --debug-file "$E/e22b.log"
wait_ready e22b
type_line e22b '列出 greet.py 的内容，只回复文件内容'
check 'the long-task dialog opens for B' wait_for 120 dialog_open e22b
sleep 1; key e22b Enter
check 'B is registered' wait_for 120 has_new_task l- "$before"
taskB=$(new_task l- "$before")
idB=$(task_field "$taskB" .id)
check 'B claims its task' wait_for 240 jq -e '.owner.jobShortId != null and .state == "running"' "$taskB"
sidB=$(task_field "$taskB" .owner.sessionId)
shortB=$(task_field "$taskB" .owner.jobShortId)
wtB=$(task_field "$taskB" .worktree.path)
echo "B: task $idB, session $shortB, worktree $wtB"
check 'B works in a Git worktree' test -d "$wtB"
first_turn() { local tr; tr=$(transcript_of "$sidB"); [ -n "$tr" ] && [ "$(turns "$tr")" -ge 1 ]; }
check "B's first turn has ended" wait_for 600 first_turn
cleanup e22b
claude stop "$shortB" >/dev/null
check 'architect B stopped' wait_for 60 stopped "$sidB"
git -C "$E/proj" worktree remove --force "$wtB"
check "B's worktree is gone" test ! -e "$wtB"
trB=$(transcript_of "$sidB")

# ---- recovery -------------------------------------------------------------------------------------
# A's question has waited its minute by now.
while [ $(( $(date +%s%3N) - askedA )) -lt 65000 ]; do sleep 1; done
rm -f "$E/state/state/recovery.json"
startedAt=$(date +%s%3N)
start e22p "$E" env PEER_SEND_FILE="$peer" claude-magpie --plugin-dir "$REPO/mods/magpie-tasks/e2e/peer-send" --debug-file "$E/e22p.log"
wait_ready e22p 120
check 'recovery resumed A, which keeps waiting' wait_for 240 log_has "$taskA" 'map(select(.type == "recovery" and .action == "keep-waiting")) | length >= 1'
check 'recovery asked B whether to continue and resumed it' wait_for 240 log_has "$taskB" 'map(select(.type == "recovery" and .reason == "interrupted")) | length == 1'
check 'architect A runs again under its own session ID' wait_for 120 alive "$sidA"
check 'architect B runs again under its own session ID' wait_for 120 alive "$sidB"
check 'A still waits for the person' test "$(task_field "$taskA" .state)" = waiting-user
qb=$(jq -r '[.decisions[] | select(.kind == "interrupted")] | last | .id' "$taskB")
echo "B: decision $qb: $(jq -r --arg q "$qb" '.decisions[$q].question' "$taskB")"
check 'B waits for the person on an interrupted decision' jq -e --arg q "$qb" '.state == "waiting-user" and .decisions[$q].options == ["继续", "暂停"] and .decisions[$q].resolvedAt == null' "$taskB"
check 'B was told what happened' wait_for 120 grep -qF 'It could not be resumed as it was' "$trB"
check 'the window that ran recovery reported nothing to Telegram' bash -c "! grep -q 'process.run (magpie-tasks): curl with' '$E/e22p.log'"
# A's question is overdue: it goes to Telegram once its session is back (the token is refused).
check "A's overdue question goes to Telegram at once" wait_for 60 log_has "$taskA" "map(select(.type == \"error\" and .during == \"telegram forward\" and .at > $startedAt)) | length >= 1"
backA=$(jq -s --arg q "$qa" "map(select(.type == \"ask\" and .decision == \$q and .at > $startedAt)) | first | .at" "$(log_of "$taskA")")
sentAt=$(jq -s "map(select(.type == \"error\" and .during == \"telegram forward\" and .at > $startedAt)) | first | .at" "$(log_of "$taskA")")
echo "A: question back in the window at $backA, sent ${sentAt} ($(( sentAt - backA )) ms later)"
check 'it was sent within seconds of the question coming back' test "$(( sentAt - backA ))" -lt 10000
check 'it was one send' test "$(curls "$dbgA")" = $((sentA + 1))

# ---- the dialogs are back in both windows -----------------------------------------------------------
start e22a "$E/proj" claude attach "$shortA"
wait_ready e22a 120
check "A's dialog is back in its window" wait_for 60 dialog_open e22a
check "A's dialog is the model-unavailable question" pane_has e22a '模型不可用'
start e22b "$E/proj" claude attach "$shortB"
wait_ready e22b 120
check "B's dialog is in its window" wait_for 60 dialog_open e22b
tmux capture-pane -p -J -t e22b > "$E/e22b.dialog"
check "B's dialog asks whether to continue" bash -c "grep -qF '任务中断' '$E/e22b.dialog' && grep -qF '1. 继续' '$E/e22b.dialog' && grep -qF '2. 暂停' '$E/e22b.dialog'"

# ---- B refuses model_route until the person answers --------------------------------------------------
# The engine drops a peer message identical to the sender's previous one, so the two requests differ.
route_request() { echo "请调用 mcp__magpie-tasks__model_route 委派一个子代理统计 greet.py 的行数（description $1）。只调用一次，不论结果如何都不要再调用别的工具，然后把这次调用的结果原样告诉我。"; }
send_b() {
  jq -n --arg to "$sidB" --arg text "$1" '{to: $to, text: $text}' > "$peer"
  wait_for 30 bash -c "jq -e '.isDelivered == true' '$peer.done'"
}
check 'B is at rest with its dialog open' wait_for 600 resting "$sidB"
echo "B's status with its dialog open: $(claude agents --json --all | jq -r --arg s "$sidB" '.[] | select(.sessionId == $s) | .status')"
t0=$(turns "$trB")
rm -f "$peer.done"
check 'the request reaches B' send_b "$(route_request 统计行数)"
check "B's turn ends" wait_for 600 bash -c "[ \$(grep -c '\"subtype\":\"turn_duration\"' '$trB') -gt $t0 ]"
check 'model_route was refused, naming the open decision' bash -c "source '$(dirname "$0")/lib.sh' >/dev/null; tool_errors '$trB' | grep -qF 'Refused: Delegating with model_route waits for decision $qb'"
refusals=$(tool_errors "$trB" | grep -cF 'Refused: Delegating with model_route' || true)
sleep 1; key e22b Enter
check '继续 from the window resolves the decision' wait_for 60 jq -e --arg q "$qb" '.decisions[$q] | .answer == "approve" and .via == "window"' "$taskB"
check 'B runs again' wait_for 30 jq -e '.state == "running"' "$taskB"
check 'B is told in a turn of its own' wait_for 120 grep -qF "The person answered decision $qb (interrupted) in the window: 继续" "$trB"
check 'B is idle again' wait_for 600 idle "$sidB"
t1=$(turns "$trB")
rm -f "$peer.done"
check 'the request reaches B again' send_b "$(route_request 统计行数之二)"
check "B's turn ends again" wait_for 600 bash -c "[ \$(grep -c '\"subtype\":\"turn_duration\"' '$trB') -gt $t1 ]"
check 'model_route is no longer refused' test "$(tool_errors "$trB" | grep -cF 'Refused: Delegating with model_route' || true)" = "$refusals"
check 'B called model_route after the answer' bash -c "source '$(dirname "$0")/lib.sh' >/dev/null; [ \$(tool_uses '$trB' | grep -c '^mcp__magpie-tasks__model_route') -ge 2 ]"
cleanup e22a e22b e22p
stop_background
finish
