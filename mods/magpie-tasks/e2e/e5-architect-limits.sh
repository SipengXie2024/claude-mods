#!/usr/bin/env bash
# E5 (plan section 12.2; U9): the architect of E3's task is refused Edit of code and Bash that writes,
# and allowed to write .planning/findings.md and to run git status. U9: it stays in the project main
# directory (no native worktree of its own).
source "$(dirname "$0")/lib.sh"
task=$(cat "$E/e3.task")
id=$(task_field "$task" .id)
sid=$(task_field "$task" .owner.sessionId)
short=$(task_field "$task" .owner.jobShortId)
tr=$(transcript_of "$sid")
before_greet=$(cat "$E/proj/greet.py")

start e5 "$E/proj" claude attach "$short"
wait_ready e5 120
say_and_wait e5 "$tr" '请直接用 Edit 工具把 greet.py 里的 hello 改成 hi，不要委派子代理，也不要用其他工具；如果被拒绝，停下并原样告诉我拒绝理由。'
check '(1) Edit of greet.py refused' bash -c "source '$(dirname "$0")/lib.sh'; tool_errors '$tr' | grep -q 'is not one of them'"
check '(1) greet.py unchanged' test "$(cat "$E/proj/greet.py")" = "$before_greet"
say_and_wait e5 "$tr" '请用 Write 工具创建 .planning/findings.md，内容为一行 "# findings"；然后用 Edit 工具在它末尾加一行 e5-edit。'
check '(2) findings.md written and edited in the project main directory' grep -qx 'e5-edit' "$E/proj/.planning/findings.md"
say_and_wait e5 "$tr" '请用 Bash 运行 touch x（只运行这一条命令）；如果被拒绝，停下并告诉我拒绝理由。'
check '(3) touch x refused' bash -c "source '$(dirname "$0")/lib.sh'; tool_errors '$tr' | grep -q 'runs only read-only commands'"
check '(3) x was not created' test ! -e "$E/proj/x"
say_and_wait e5 "$tr" '请用 Bash 运行 git status，告诉我输出的第一行。'
check '(4) git status ran' bash -c "source '$(dirname "$0")/lib.sh'; tool_uses '$tr' | grep -qE '^Bash.*git( -C [^ ]+)? status'"
check '(4) git status was not refused (one Bash refusal: touch x)' test "$(tool_errors "$tr" | grep -c 'this command has')" -eq 1
# U9
row=$(agents_json | jq -c --arg s "$sid" '.[] | select(.sessionId == $s)')
check 'U9: the architect session still runs in the project main directory' test "$(jq -r .cwd <<<"$row")" = "$E/proj"
check 'U9: no native worktree under the project' test ! -e "$E/proj/.claude/worktrees"
wts=$(git -C "$E/proj" worktree list --porcelain | grep '^worktree ' | cut -d' ' -f2- | sort | tr '\n' ' ')
check "U9: worktrees are the project and the task worktree only ($wts)" test "$wts" = "$(printf '%s\n' "$E/proj" "$E/wt/$id" | sort | tr '\n' ' ')"
cleanup e5
finish
