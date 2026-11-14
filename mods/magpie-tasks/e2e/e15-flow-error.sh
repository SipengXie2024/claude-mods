#!/usr/bin/env bash
# E15 (plan section 12.2): a flow hook error. The repository's object store is read-only, so the base
# commit of the project directory fails after the person confirms: the window shows the error line
# and the drop, the message does not reach the model, the task is in state error with the cause, no
# background session starts, the window stays open, and nothing goes to Telegram (the failure is
# shown in this window only; in an environment from `setup.sh --forward` the task has a chat).
source "$(dirname "$0")/lib.sh"
mkdir -p "$E/proj3"
( cd "$E/proj3" && git init -q && printf 'x\n' > a.txt && git add . \
  && git -c user.email=e2e@magpie -c user.name=e2e commit -qm init && printf 'y\n' > b.txt )
bg_before=$(agents_json | jq '[.[] | select(.kind == "background")] | length')
chmod -R a-w "$E/proj3/.git/objects"
start e15 "$E/proj3" claude-magpie --debug-file "$E/e15.log"
wait_ready e15
type_line e15 '检查 a.txt'
check 'the long-task dialog opens' wait_for 120 dialog_open e15
key e15 Enter
check 'the error line is shown' wait_for 120 pane_has e15 'magpie-tasks: 出错（任务'
check 'the message was dropped with the error' wait_for 30 pane_has e15 'Prompt dropped by a hook: magpie-tasks 出错：'
t=$(grep -l "\"root\": *\"$E/proj3\"" "$E"/state/tasks/l-*.json | head -1)
check 'the task is in state error' test "$(task_field "$t" .state)" = error
check 'the error names the failed snapshot' bash -c "jq -r .error '$t' | grep -qiE 'insufficient permission|Permission denied|unable to'"
check 'the project is the one of this window' test "$(task_field "$t" .project.root)" = "$E/proj3"
check 'no new background session' test "$(agents_json | jq '[.[] | select(.kind == "background")] | length')" -eq "$bg_before"
check 'the window is still open' bash -c "source '$(dirname "$0")/lib.sh' >/dev/null; ! pane_dead e15"
echo "task chat: $(task_field "$t" .telegram.chatId)"
check 'nothing was sent to Telegram' bash -c "! grep -q 'process.run (magpie-tasks): curl with' '$E/e15.log'"
chmod -R u+w "$E/proj3/.git/objects"
type_line e15 '/exit'
cleanup e15
finish
