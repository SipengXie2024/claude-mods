#!/usr/bin/env bash
# E1 (plan section 12.2): where the plugin is active. Plain `claude -p` and `claude-magpie -p` are
# inactive; an interactive claude-magpie window is a candidate whose first message opens the
# long-task dialog: two architect candidates (the recommended one first), the entry to the other
# candidates and the ordinary-session choice. Esc drops the message and records nothing, the next
# message asks again, and the ordinary-session choice runs the message in the window unrecorded.
source "$(dirname "$0")/lib.sh"
cd "$E"

claude -p --model claude/claude-haiku-5-5 --debug-file "$E/e1-plain.log" '回复 ok' >/dev/null 2>&1
claude-magpie -p --model claude/claude-haiku-5-5 --debug-file "$E/e1-p.log" '回复 ok' >/dev/null 2>&1
check 'plain claude -p: magpie-tasks inactive' debug_has "$E/e1-plain.log" 'magpie-tasks: role inactive'
check 'claude-magpie -p: magpie-tasks inactive' debug_has "$E/e1-p.log" 'magpie-tasks: role inactive'
check 'no task recorded by -p runs' test "$(task_count)" -eq 0

start e1 "$E" claude-magpie --model claude/claude-haiku-5-5 --debug-file "$E/e1.log"
wait_ready e1
check 'interactive window: role candidate' wait_for 30 debug_has "$E/e1.log" 'magpie-tasks: role candidate'
type_line e1 '回复 ok'
check 'the long-task dialog opens' wait_for 120 dialog_open e1
dialog=$(pane e1)
# The numbered options: two models, the other-candidates entry, the ordinary-session entry, then
# the dialog's own two entries.
options=$(grep -E '^\s*(❯ )?[0-9]+\. ' <<<"$dialog" | sed -E 's/^\s*(❯ )?[0-9]+\. //')
models='^(Opus 5\.5|Mythos 5\.2|Astra 6\.2|Neon)(（推荐）)?$'
check 'dialog offers two architect models' test "$(grep -cE "$models" <<<"$options")" -eq 2
check 'the first option is the recommended model' grep -qE '^(Opus 5\.5|Mythos 5\.2|Astra 6\.2|Neon)（推荐）$' <<<"$(head -1 <<<"$options")"
check "the other options: other candidates, ordinary session, the dialog's own entries" test "$(grep -vE "$models" <<<"$options")" = $'选择其他架构师模型\n不用架构师（普通会话）\nType something.\nChat about this'
key e1 Escape
check 'Esc drops the message' wait_for 30 pane_has e1 'magpie-tasks: 已取消'
check 'no task recorded after Esc' test "$(task_count)" -eq 0
# The dropped text is back in the input box; sending it again asks again.
wait_for 10 dialog_closed e1
key e1 Enter
check 'the next message asks again' wait_for 120 dialog_open e1
key e1 Escape
sleep 2
check 'still no task' test "$(task_count)" -eq 0
# The ordinary-session choice (the fourth option): the message runs in this window, nothing recorded.
wait_for 10 dialog_closed e1
key e1 Enter
check 'the third message asks again' wait_for 120 dialog_open e1
all_turns() { cat "$E"/cfg/projects/*/*.jsonl 2>/dev/null | grep -c '"subtype":"turn_duration"' || true; }
before=$(all_turns)
key e1 4
check 'ordinary session announced' wait_for 30 pane_has e1 'magpie-tasks: 本会话按普通会话运行，不登记为长期任务'
check 'the window answers the message itself' wait_for 120 bash -c "[ \"\$(cat '$E'/cfg/projects/*/*.jsonl 2>/dev/null | grep -c '\"subtype\":\"turn_duration\"')\" -gt $before ]"
check 'no task recorded for an ordinary session' test "$(task_count)" -eq 0
type_line e1 '/exit'
cleanup e1
finish
