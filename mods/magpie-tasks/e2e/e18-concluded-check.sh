#!/usr/bin/env bash
# E18: a message to an acceptance agent after its verdict. On 2026-11-12 (task sbrsuo) an acceptance
# passed a result and the task was done; four minutes later another task's worker asked that agent a
# question with SendMessage, which reaches every agent of the session, finished ones included. The
# resumed turn's first step marked the agent running again, and its answer, which had no 验收结论 line,
# was read as a second verdict: the Router showed 出错. (a) A daily task with a test gets its
# acceptance. (b) A second request has a worker ask the acceptance agent about its check with
# SendMessage; the Router may give it a task of its own or send it on to the first task's worker, and
# either way another agent of the session writes to the concluded one. The agent's turn goes through
# the plugin's hooks (an `effort` entry after the verdict) and ends as a turn logged after the
# conclusion; the verdict, the agent's reports and its state stay as they were, and nothing errs.
source "$(dirname "$0")/lib.sh"
repo="$E/repo"
mkdir -p "$repo"
( cd "$repo" && git init -q && printf 'print("hello")\n' > greet.py && git add . \
  && git -c user.email=e2e@magpie -c user.name=e2e commit -qm init )
dailies() { ls "$E"/state/tasks/d-*.json 2>/dev/null | grep -v '\.log\.jsonl$' || true; }
newest_daily() { dailies | xargs -r ls -t | head -1; }
dbg="$E/e18.log"
all_settled() { for f in $(dailies); do settled "$f" || return 1; done; }
# The task's turn is over and nothing of it runs: done, or waiting for the person after a failed acceptance.
settled() { jq -e '(.state == "done" or .state == "waiting-user") and ([.agents[] | select(.state == "running")] | length == 0)' "$1"; }

start e18 "$E" env MAGPIE_TASKS_ROLE=router TG_ROUTER_STATE_DIR="$E/tg" claude-magpie --model "'claude/claude-opus-5-5[1m]'" --plugin-dir "$REPO/mods/tg-router" --debug-file "$dbg"
wait_ready e18
check 'the Router session has role router' wait_for 60 debug_has "$dbg" 'magpie-tasks: role router'

# (a)
type_line e18 "在 $repo 里给 greet.py 加一个 --name 参数（默认 world），输出 hello <name>；再补一个 test_greet.py，用 subprocess 检查带参数和不带参数两种调用；运行测试验证"
check '(a) a daily task is recorded' wait_for 300 more_tasks d- 0
ta=$(newest_daily)
check '(a) its acceptance gives a verdict' wait_for 1500 log_has "$ta" 'map(select(.type == "acceptance")) | length > 0'
check '(a) the task settles' wait_for 1500 settled "$ta"
acc=$(jq -r '[.agents[] | select(.role == "acceptance")][0].agentId' "$ta")
accname=$(jq -r --arg a "$acc" '.agents[$a].name' "$ta")
verdict() { jq -c --arg a "$acc" '[.deliverables[] | select(.acceptance.agentId == $a) | .acceptance]' "$ta"; }
before=$(verdict)
reports=$(jq --arg a "$acc" '.agents[$a].reports | length' "$ta")
echo "acceptance agent: $accname ($acc), verdict $before"

# (b)
# after_verdict <jq filter>: the filter over the first task's log entries after the agent's verdict.
after_verdict() { jq -e -s --arg a "$acc" "(map(.type == \"acceptance\" and .agentId == \$a) | index(true)) as \$i | .[\$i + 1:] | $1" "$(log_of "$ta")"; }
type_line e18 "请用 SendMessage 工具给名为 $accname 的代理发一条消息，问它刚才检查的是哪个文件、它的结论是什么；等它回复后，把它的回复原样告诉我"
check '(b) the acceptance agent'"'"'s turn ends, logged after its conclusion' wait_for 900 after_verdict 'map(select(.type == "turn-end" and .agentId == $a and .afterConclusion == true)) | length == 1'
check '(b) that turn went through the plugin'"'"'s first-step hook' after_verdict 'map(select(.type == "effort" and .agentId == $a)) | length > 0'
check '(b) every daily task settles' wait_for 900 all_settled
no_error() { ! cat "$E"/state/tasks/d-*.log.jsonl | jq -e -s 'map(select(.type == "error")) | length > 0'; }
verdicts() { jq -s --arg a "$acc" 'map(select(.type == "acceptance" and .agentId == $a)) | length' "$(log_of "$ta")"; }
no_router_error() { ! tmux capture-pane -p -J -t e18 -S - | grep -F 'magpie-tasks' | grep -qF '出错'; }
check '(b) no error is logged' no_error
check '(b) the agent gave one verdict' test "$(verdicts)" = 1
check '(b) its verdict is unchanged' test "$(verdict)" = "$before"
check '(b) the acceptance agent is done, its reports unchanged' jq -e --arg a "$acc" --argjson n "$reports" '.agents[$a].state == "done" and (.agents[$a].reports | length) == $n' "$ta"
check '(b) the Router pane shows no error' no_router_error
echo "first task log after the verdict:"; after_verdict '.[] | {type, agentId, reason, afterConclusion}' | jq -c .
echo "pane:"; pane e18 | tail -40
cleanup e18
finish
