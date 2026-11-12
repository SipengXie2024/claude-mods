#!/usr/bin/env bash
# E8 (plan section 12.2; U3): daily tasks typed in the Router's terminal. (a) a feature with a test:
# routed by code-change, the executor opens the project and works in the repository itself (no other
# task changes it in place), Jev judges the result worth a check, an acceptance subagent checks it,
# recording the result waits on a held project lock without the hook timing out, then records the
# change in place and moves the task's base; (b) a one-line edit: no acceptance, the change is
# recorded at once; (c) an answer with no change: no acceptance, no integration. The
# Router pane shows no acceptance or integration report for any of them: the executor is told with
# the next message that reaches it. (d) a request no rule matches: the routing assessment (Opus, xhigh)
# recommends, the person confirms, the executor runs on the recommendation.
source "$(dirname "$0")/lib.sh"
repo="$E/repo"
mkdir -p "$repo"
( cd "$repo" && git init -q && printf 'print("hello")\n' > greet.py && git add . \
  && git -c user.email=e2e@magpie -c user.name=e2e commit -qm init && echo '# note' >> README.md )
dailies() { ls "$E"/state/tasks/d-*.json 2>/dev/null | grep -v '\.log\.jsonl$' || true; }
newest_daily() { dailies | xargs -r ls -t | head -1; }
lockname="project-$(bun -e "import { fnv1a64 } from '$REPO/mods/magpie-tasks/src/io.ts'; console.log(fnv1a64('$(realpath "$repo")'))")"
lockdir="$E/state/locks/$lockname.lock"
dbg="$E/e8.log"
# The Router may give a request a task of its own or send it on to an open task as a follow-up, so
# (b) and (c) count entries over every daily task's log and take the task written last.
count_log() { cat "$E"/state/tasks/d-*.log.jsonl 2>/dev/null | jq -s "map(select($1)) | length"; }
more_log() { [ "$(count_log "$1")" -gt "$2" ]; }
UNCHECKED='.type == "check" and .needed == false'
ACCEPTANCES='.type == "spawn" and .role == "acceptance"'
APPLIED='.type == "integration" and .status == "in-place"'
INTEGRATIONS='.type == "integration"'
# magpie-tasks' own lines in the Router pane that speak of acceptance or integration.
reports() { tmux capture-pane -p -J -t e8 -S - | grep -F 'magpie-tasks ·' | grep -cE '验收|整合' || true; }
# The Router starts in $E: started in $HOME, it reads ~/.claude/settings.json as project settings,
# whose marketplace entry replaces the one setup.sh added and reloads every plugin from that path.
start e8 "$E" env MAGPIE_TASKS_ROLE=router TG_ROUTER_STATE_DIR="$E/tg" claude-magpie --model "'claude/claude-opus-5-5[1m]'" --plugin-dir "$REPO/mods/tg-router" --debug-file "$dbg"
wait_ready e8
check 'the Router session has role router' wait_for 60 debug_has "$dbg" 'magpie-tasks: role router'

# (a)
type_line e8 "在 $repo 里给 greet.py 加一个 --name 参数（默认 world），输出 hello <name>；再补一个 test_greet.py，用 subprocess 检查带参数和不带参数两种调用；运行测试验证"
check '(a) a daily task is recorded' wait_for 300 more_tasks d- 0
ta=$(newest_daily)
check '(a) its executor is routed by code-change' wait_for 120 bash -c "jq -e '[.agents[] | select(.role == \"executor\")][0].ruleId == \"code-change\"' '$ta'"
check '(a) the executor works in the repository in place' wait_for 900 bash -c "jq -e --arg r \"$(realpath "$repo")\" '.direct.dir == \$r and .worktree == null' '$ta'"
# Hold the project lock from here (an acceptance takes seconds) until the integration has waited on
# it, then 15 seconds more. The lock is a directory with owner.json, as lock.ts makes it.
mkdir "$lockdir" && printf '{"owner":"e2e-e8","at":%s}\n' "$(date +%s%3N)" > "$lockdir/owner.json"
check '(a) the result is judged worth a check' wait_for 1200 log_has "$ta" 'map(select(.type == "check" and .needed == true)) | length > 0'
check '(a) an acceptance subagent was started' wait_for 300 log_has "$ta" 'map(select(.type == "spawn" and .role == "acceptance")) | length > 0'
check '(a) the integration waits on the held lock' wait_for 900 debug_has "$dbg" "lock wait $lockname held by"
waited=$(date +%s%3N); sleep 15; rm -rf "$lockdir"
check '(a) the result in place is logged' wait_for 300 log_has "$ta" 'map(select(.type == "integration" and .status == "in-place")) | length > 0'
applied_at=$(jq -s '[.[] | select(.type == "integration" and .status == "in-place")][0].at' "$(log_of "$ta")")
check '(a) the integration finished at least 15 s after the lock wait began' test "$applied_at" -ge $((waited + 15000))
check '(a) no hook expired' bash -c "! grep -E 'magpie-tasks.*(expired|timed out|absent)' '$dbg'"
check '(a) the acceptance verdict is recorded' bash -c "jq -e '.deliverables | map(select(.acceptance != null)) | length > 0' '$ta'"
check '(a) greet.py greets the given name' bash -c "cd '$repo' && python3 greet.py --name Ann | grep -qx 'hello Ann'"
check '(a) the uncommitted README.md is kept' bash -c "git -C '$repo' status --porcelain | grep -qx '?? README.md' && grep -qx '# note' '$repo/README.md'"
check '(a) still one commit on the branch' test "$(git -C "$repo" rev-list --count HEAD)" -eq 1
base_ref=$(jq -r .direct.baseRef "$ta")
first_base=$(jq -s -r '[.[] | select(.type == "workspace")][0].baseCommit' "$(log_of "$ta")")
check '(a) the base ref moved past the first base commit' test "$(git -C "$repo" rev-parse "$base_ref")" != "$first_base"
check '(a) the Router pane has no acceptance or integration report' test "$(reports)" -eq 0

# (b)
unchecked=$(count_log "$UNCHECKED"); acceptances=$(count_log "$ACCEPTANCES"); applied=$(count_log "$APPLIED")
type_line e8 "在 $repo 里把 greet.py 输出里的 hello 改成 hi，并运行 python3 greet.py 验证"
check '(b) the result is judged to need no check' wait_for 1200 more_log "$UNCHECKED" "$unchecked"
tb=$(newest_daily)
check '(b) the result in place is logged' wait_for 300 more_log "$APPLIED" "$applied"
check '(b) no acceptance subagent' test "$(count_log "$ACCEPTANCES")" -eq "$acceptances"
check '(b) task done' wait_for 60 bash -c "jq -e '.state == \"done\"' '$tb'"
check '(b) greet.py says hi' bash -c "cd '$repo' && python3 greet.py | grep -qx 'hi world'"
check '(b) the Router pane has no acceptance or integration report' test "$(reports)" -eq 0
# When the Router sent (b) on to (a)'s executor, that message carried the note on (a)'s integration.
if [ "$tb" = "$ta" ]; then
  check '(b) the executor was told of the result of (a)' log_has "$ta" 'map(select(.type == "outcome-told" and .outcome == "in-place")) | length > 0'
fi

# (c)
unchecked=$(count_log "$UNCHECKED"); integrations=$(count_log "$INTEGRATIONS")
type_line e8 "统计 $repo/greet.py 有几行，只回答数字"
check '(c) the result is judged to need no check' wait_for 900 more_log "$UNCHECKED" "$unchecked"
tc=$(newest_daily)
check '(c) task done' wait_for 60 bash -c "jq -e '.state == \"done\"' '$tc'"
check '(c) no acceptance subagent' test "$(count_log "$ACCEPTANCES")" -eq "$acceptances"
check '(c) no integration' test "$(count_log "$INTEGRATIONS")" -eq "$integrations"
check '(c) the Router pane has no acceptance or integration report' test "$(reports)" -eq 0

# (d)
daily=$(dailies | wc -l)
type_line e8 '帮我为一个混合任务挑选模型：先读一份 PDF 论文的定理证明，再据此写一段 Rust 模拟代码，并画一张结果图。'
check '(d) a daily task of its own' wait_for 300 more_tasks d- "$daily"
td=$(newest_daily)
check '(d) the routing assessment runs on Opus at xhigh or above' wait_for 300 bash -c "jq -e '[.agents[] | select(.role == \"assessment\")][0] | .model == \"claude/claude-opus-5-5\" and (.effort == \"xhigh\" or .effort == \"max\")' '$td'"
check '(d) the task waits for the person' wait_for 900 bash -c "jq -e '.state == \"waiting-user\"' '$td'"
type_line e8 '确认'
check '(d) the executor runs on the confirmed recommendation' wait_for 900 bash -c "jq -e '[.agents[] | select(.role == \"executor\")][0].selection.kind == \"assessment-confirmed\"' '$td'"
echo "tasks: $ta $tb $tc $td"
cleanup e8
finish
