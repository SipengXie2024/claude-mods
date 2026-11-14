#!/usr/bin/env bash
# E20: a long task's questions reach the person in the architect's window first and on Telegram only
# when nobody answers there. Runs after E3 in an environment made by `e2e/setup.sh --forward` (the
# task's Telegram chat is `1`, the bot token is one Telegram refuses, telegramAfterMinutes is 1), in
# a tmux pane attached to E3's background architect.
#
#   1. Two subagents the architect delegates change greet.py: the later one is paused, the question
#      opens as a dialog in the window, and the option chosen there is carried out. Nothing is sent
#      to Telegram. Meanwhile the running subagent's view shows its band with the run's progress.
#   2. The architect calls AskUserQuestion: the plugin shows the dialog, and the answer chosen in the
#      window comes back to the model as the tool's result.
#   3. A second conflict is left unanswered: after a minute the plugin sends the question to
#      Telegram (a real request, answered 401 Unauthorized, which the task log keeps). A Telegram
#      reply, delivered the way the Router delivers one (e2e/peer-send makes the same
#      $.session.send), is carried out; the dialog still open in the window then only gets a line.
#      The architect's answer to that reply is refused by Telegram too, which marks the task `error`.
source "$(dirname "$0")/lib.sh"
task=$(cat "$E/e3.task")
id=$(task_field "$task" .id)
sid=$(task_field "$task" .owner.sessionId)
short=$(task_field "$task" .owner.jobShortId)
tr=$(transcript_of "$sid")
log=$(log_of "$task")
dbg="$E/state/debug/$id.txt"
peer="$E/peer-send.json"
check 'the task has a Telegram chat and a one-minute wait' test "$(task_field "$task" .telegram.chatId)/$(jq -r '.pluginConfigs["magpie-tasks@sipeng-mods"].options.telegramAfterMinutes' "$E/cfg/settings.json")" = 1/1

# Telegram sends of the architect session: each is one curl run of the plugin.
curls() { grep -c 'process.run (magpie-tasks): curl with' "$dbg" || true; }
conflicts() { jq '[.decisions[] | select(.kind == "file-conflict")] | length' "$task"; }
newest_conflict() { jq -c '[.decisions[] | select(.kind == "file-conflict")] | sort_by(.createdAt) | last' "$task"; }
agents_at_rest() { jq -e '[.agents[] | select(.state == "running" or .state == "paused")] | length == 0' "$task"; }
# delegate <first word> <second word> <seconds the first subagent sleeps>
delegate() {
  type_line e20 "委派后台子代理 A：把 greet.py 输出的词改成 $1，然后运行 \`python3 -c \"import time; time.sleep($3)\"\`，再运行 \`python3 greet.py\`。等 greet.py 出现 $1 之后，委派后台子代理 B：把 greet.py 输出的词改成 $2 并运行 \`python3 greet.py\`。B 的写入被拒后不要调用 resolve_conflict，也不要再做别的，等用户回答。"
}

start e20 "$E/proj" claude attach "$short"
wait_ready e20 120
start e20p "$E" env PEER_SEND_FILE="$peer" claude-magpie --plugin-dir "$REPO/mods/magpie-tasks/e2e/peer-send"
wait_ready e20p 120

# ---- 1. a file conflict asked and answered in the window -------------------------------------------
c0=$(conflicts); sent0=$(curls)
delegate hi hey 100
check 'a file-conflict decision exists' wait_for 600 bash -c "[ \$(jq '[.decisions[] | select(.kind == \"file-conflict\")] | length' '$task') -gt $c0 ]"
d1=$(newest_conflict); q1=$(jq -r .id <<<"$d1"); b1=$(jq -r .data.agentId <<<"$d1"); a1=$(jq -r .data.otherAgentId <<<"$d1")
check 'the first subagent, started by model_route, is seen by the tool-call hook (its edit is recorded)' test "$(jq -r --arg a "$a1" '.agents[$a].filesTouched | length' "$task")" -ge 1
check 'the question opens as a dialog in the window' wait_for 30 dialog_open e20
tmux capture-pane -p -J -t e20 > "$E/e20.dialog"
check 'the dialog shows the question and its two options' bash -c "grep -qF '文件冲突' '$E/e20.dialog' && grep -qF '改动了同一个文件' '$E/e20.dialog' && grep -qF '1. 单独副本' '$E/e20.dialog' && grep -qF '2. 等待前一方' '$E/e20.dialog'"
check 'the task log records the question as asked in the window' log_has "$task" "map(select(.type == \"ask\" and .decision == \"$q1\" and .channel == \"window\")) | length == 1"
check 'one notification was raised for it' wait_for 20 log_has "$task" 'map(select(.type == "window-notify")) | length >= 1'
echo "notification: $(jq -c -s 'map(select(.type == "window-notify")) | last | {sent, channel, reason}' "$log")"
sleep 1; key e20 Down; sleep 1; key e20 Enter
check 'the option chosen in the window is carried out' wait_for 60 bash -c "jq -e --arg q '$q1' '.decisions[\$q] | .answer == \"wait\" and .via == \"window\"' '$task'"
check 'the architect is told in a turn of its own' wait_for 120 grep -qF "The person answered decision $q1 (file-conflict) in the window: 等待前一方" "$tr"
check 'nothing was sent to Telegram' test "$(curls)" = "$sent0"
check 'the decision has no Telegram message' test "$(jq -r --arg q "$q1" '.decisions[$q].telegram' "$task")" = null
# The running subagent's view: its band with the time taken, the tool calls and the latest one.
key e20 Down; sleep 1; key e20 Down; sleep 1; key e20 Enter
check "the subagent's band shows the run's progress" wait_for 30 bash -c "tmux capture-pane -p -t e20 | grep -qE '◆ magpie-tasks · .* · [0-9hms]+ · [0-9]+ tools? · [A-Za-z_]+'"
echo "band: $(tmux capture-pane -p -t e20 | grep -F '◆ magpie-tasks' | sed 's/ *\[-\] *$//; s/ *$//')"
key e20 Up; sleep 1; key e20 Enter
check 'the paused subagent is woken once the other has finished' wait_for 400 log_has "$task" "map(select(.type == \"resume\" and .agentId == \"$b1\" and .decision == \"$q1\")) | length == 1"
check 'both subagents come to rest' wait_for 400 agents_at_rest

# ---- 2. the architect's own question ---------------------------------------------------------------
check 'the architect is idle' wait_for 300 bash -c "claude agents --json --all | jq -e --arg s '$sid' '.[] | select(.sessionId == \$s) | .status == \"idle\"'"
t0=$(turns "$tr")
type_line e20 '现在调用 AskUserQuestion 工具问我一个问题：喜欢茶还是咖啡？选项为“茶”和“咖啡”。得到回答后只回复我选了什么。'
check 'the question opens as a dialog' wait_for 120 dialog_open e20
check "the dialog shows the architect's question" pane_has e20 '喜欢茶还是咖啡'
sleep 1; key e20 Down; sleep 1; key e20 Enter
check 'the turn ends' wait_for 120 bash -c "[ \$(grep -c '\"subtype\":\"turn_duration\"' '$tr') -gt $t0 ]"
check 'the answer came back as the tool result' pane_has e20 '喜欢茶还是咖啡？ → 咖啡'
check 'the task log records the answer from the window' log_has "$task" 'map(select(.type == "answer" and .via == "window")) | length >= 1'
check 'nothing was sent to Telegram' test "$(curls)" = "$sent0"

# ---- 3. a question nobody answers goes to Telegram; Telegram answers; the dialog is stale -----------
c1=$(conflicts)
delegate hello hola 170
check 'a second file-conflict decision exists' wait_for 600 bash -c "[ \$(jq '[.decisions[] | select(.kind == \"file-conflict\")] | length' '$task') -gt $c1 ]"
d2=$(newest_conflict); q2=$(jq -r .id <<<"$d2")
check 'its dialog opens' wait_for 30 dialog_open e20
check 'nothing is sent while the minute runs' test "$(curls)" = "$sent0"
forwarded="map(select(.type == \"error\" and .during == \"telegram forward\")) | length >= 1"
check 'after the wait the question goes to Telegram, which refuses the token (401)' wait_for 100 log_has "$task" "$forwarded"
echo "send record: $(jq -c -s 'map(select(.type == "error" and .during == "telegram forward")) | last | {during, error}' "$log")"
waited=$(jq -s --arg q "$q2" '(map(select(.type == "error" and .during == "telegram forward")) | last | .at) - (map(select(.type == "ask" and .decision == $q)) | first | .at)' "$log")
echo "sent ${waited} ms after the question was asked"
check 'the send came a minute after the question, not before' test "$waited" -ge 60000 -a "$waited" -lt 80000
check 'it was one send' test "$(curls)" = $((sent0 + 1))
check 'the question is still open in the window' bash -c "dialog_open() { tmux capture-pane -p -t e20 | grep -qF 'Esc to cancel'; }; dialog_open && jq -e --arg q '$q2' '.decisions[\$q].resolvedAt == null' '$task'"
# The Telegram reply, as the Router hands it to the architect (router.ts architectText).
jq -n --arg to "$sid" --arg text "[magpie-tasks telegram chat=1 message=4242 decision=$q2 answer=wait]"$'\n''等待前一方' '{to: $to, text: $text}' > "$peer"
check 'the reply is delivered to the architect session' wait_for 30 bash -c "jq -e '.isDelivered == true' '$peer.done'"
check 'the Telegram answer is carried out' wait_for 120 bash -c "jq -e --arg q '$q2' '.decisions[\$q] | .answer == \"wait\" and .via == \"telegram\"' '$task'"
check 'the dialog is still open in the window' bash -c "tmux capture-pane -p -t e20 | grep -qF 'Esc to cancel'"
sleep 1; key e20 Enter
check 'the stale dialog only gets the line' wait_for 30 pane_has e20 '这个问题已经在 Telegram 上按「等待前一方」决定，这次回答没有再执行。'
check 'the answer stays the one from Telegram, with no separate copy' bash -c "jq -e --arg q '$q2' '(.decisions[\$q] | .answer == \"wait\" and .via == \"telegram\") and (.extraWorktrees | length == 0)' '$task'"
check "the architect's answer to the reply was sent to Telegram and refused" wait_for 300 log_has "$task" 'map(select(.type == "error" and .during == "turn.complete" and (.error | contains("HTTP 401")))) | length >= 1'
cleanup e20 e20p
finish
