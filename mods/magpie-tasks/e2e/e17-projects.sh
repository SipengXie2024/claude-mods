#!/usr/bin/env bash
# E17: one daily task typed in the Router's terminal changes two repositories. The executor names
# each with open_project and the task works in both (in place: no other task changes them), each
# with its own base; the change of each is recorded as its part of the result, and the task is done.
source "$(dirname "$0")/lib.sh"
a="$E/repo"
b="$E/proj2"
for r in "$a" "$b"; do
  mkdir -p "$r"
  ( cd "$r" && git init -q && printf 'print("hello")\n' > greet.py && git add . \
    && git -c user.email=e2e@magpie -c user.name=e2e commit -qm init )
done
ra=$(realpath "$a"); rb=$(realpath "$b")
dbg="$E/e17.log"
# The Router starts in $E, as in e8-daily.sh.
start e17 "$E" env MAGPIE_TASKS_ROLE=router TG_ROUTER_STATE_DIR="$E/tg" claude-magpie --model "'claude/claude-opus-5-5[1m]'" --plugin-dir "$REPO/mods/tg-router" --debug-file "$dbg"
wait_ready e17
check 'the Router session has role router' wait_for 60 debug_has "$dbg" 'magpie-tasks: role router'

type_line e17 "把 $a 和 $b 这两个仓库里 greet.py 输出的 hello 都改成 hi，各自运行 python3 greet.py 验证"
check 'a daily task is recorded' wait_for 300 more_tasks d- 0
t=$(newest_task)
check 'the task works on both repositories' wait_for 900 bash -c "jq -e --arg a '$ra' --arg b '$rb' '([.project.root] + [.more[]?.project.root] | sort) == ([\$a, \$b] | sort)' '$t'"
check 'both are changed in place' jq -e '.worktree == null and .direct.dir == .project.root and (.more | length) == 1 and .more[0].worktree == null and .more[0].direct.dir == .more[0].project.root' "$t"
check 'the log holds one placement per repository' log_has "$t" 'map(select(.type == "workspace" and .mode == "direct")) | length == 2'
second=$(jq -r '.more[0].project.root' "$t")
check 'the second repository has a base ref of its own' git -C "$second" rev-parse --verify -q "refs/magpie-tasks/$(jq -r .id "$t")/p2/base"
check 'the task is done' wait_for 1800 bash -c "jq -e '.state == \"done\"' '$t'"
check 'the result holds the change of both repositories' jq -e --arg a "$ra" --arg b "$rb" '[.deliverables[].integration.parts[]? | select(.status == "in-place" and (.files | index("greet.py") != null)) | .root] | unique == ([$a, $b] | sort)' "$t"
check 'both greet.py say hi' bash -c "[ \"\$(cd '$a' && python3 greet.py)\" = hi ] && [ \"\$(cd '$b' && python3 greet.py)\" = hi ]"
check 'no hook expired' bash -c "! grep -E 'magpie-tasks.*(expired|timed out|absent)' '$dbg'"
echo "task: $t"
cleanup e17
finish
