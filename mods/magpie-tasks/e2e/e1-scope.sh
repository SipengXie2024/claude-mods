#!/usr/bin/env bash
# E1 (plan section 12.2): where the plugin is active. Plain `claude -p` and `claude-magpie -p` are
# inactive; an interactive claude-magpie window is a candidate whose first message opens the
# long-task dialog with exactly the four architect candidates; Esc drops the message and records
# nothing, and the next message asks again.
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
for name in 'Opus 5.5' 'Mythos 5.2' 'Astra' 'Sol 6.1'; do
  check "dialog offers $name" grep -qF "$name" <<<"$dialog"
done
# The numbered options: the four models, then the dialog's own two entries.
options=$(grep -E '^\s*(❯ )?[0-9]+\. ' <<<"$dialog" | sed -E 's/^\s*(❯ )?[0-9]+\. //')
check 'dialog offers exactly four models' test "$(grep -cE '^(Opus 5\.5|Mythos 5\.2|Astra|Sol 6\.1)(（推荐）)?$' <<<"$options")" -eq 4
check "the other options are the dialog's free-text and chat entries only" test "$(grep -vE '^(Opus 5\.5|Mythos 5\.2|Astra|Sol 6\.1)(（推荐）)?$' <<<"$options")" = $'Type something.\nChat about this'
check 'one option is marked recommended' grep -qF '（推荐）' <<<"$dialog"
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
type_line e1 '/exit'
cleanup e1
finish
