#!/usr/bin/env bash
# E8 (plan section 12.2; U3): daily tasks typed in the Router's terminal. (a) a code change: routed by
# code-change, the executor opens a worktree, an acceptance subagent checks it, the integration waits
# on a held project lock without the hook timing out, then applies to the repository's working tree
# only; (b) an answer with no change: acceptance without a worktree, no integration; (c) a request no
# rule matches: the routing assessment (Opus, xhigh) recommends, the person confirms, the executor
# runs on the recommendation.
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

start e8 "$HOME" env MAGPIE_TASKS_ROLE=router TG_ROUTER_STATE_DIR="$E/tg" claude-magpie --model "'claude/claude-opus-5-5[1m]'" --plugin-dir "$REPO/mods/tg-router" --debug-file "$dbg"
wait_ready e8
check 'the Router session has role router' wait_for 60 debug_has "$dbg" 'magpie-tasks: role router'

# (a)
type_line e8 "在 $repo 里把 greet.py 的 hello 改成 hi，并运行 python3 greet.py 验证"
check '(a) a daily task is recorded' wait_for 300 more_tasks d- 0
ta=$(newest_daily)
check '(a) its executor is routed by code-change' wait_for 120 bash -c "jq -e '[.agents[] | select(.role == \"executor\")][0].ruleId == \"code-change\"' '$ta'"
check '(a) the executor opened a worktree' wait_for 900 bash -c "jq -e '.worktree != null' '$ta'"
# Hold the project lock from here (an acceptance takes seconds) until the integration has waited on
# it, then 15 seconds more. The lock is a directory with owner.json, as lock.ts makes it.
mkdir "$lockdir" && printf '{"owner":"e2e-e8","at":%s}\n' "$(date +%s%3N)" > "$lockdir/owner.json"
check '(a) an acceptance subagent was started' wait_for 1200 log_has "$ta" 'map(select(.type == "spawn" and .role == "acceptance")) | length > 0'
check '(a) the integration waits on the held lock' wait_for 900 debug_has "$dbg" "lock wait $lockname held by"
waited=$(date +%s%3N); sleep 15; rm -rf "$lockdir"
check '(a) applied integration logged' wait_for 300 log_has "$ta" 'map(select(.type == "integration" and .status == "applied")) | length > 0'
applied_at=$(jq -s '[.[] | select(.type == "integration" and .status == "applied")][0].at' "$(log_of "$ta")")
check '(a) the integration finished at least 15 s after the lock wait began' test "$applied_at" -ge $((waited + 15000))
check '(a) no hook expired' bash -c "! grep -E 'magpie-tasks.*(expired|timed out|absent)' '$dbg'"
check '(a) the acceptance verdict is recorded' bash -c "jq -e '.deliverables | map(select(.acceptance != null)) | length > 0' '$ta'"
check '(a) greet.py prints hi' bash -c "cd '$repo' && python3 greet.py | grep -qx hi"
check '(a) the uncommitted README.md is kept' bash -c "git -C '$repo' status --porcelain | grep -qx '?? README.md' && grep -qx '# note' '$repo/README.md'"
check '(a) still one commit on the branch' test "$(git -C "$repo" rev-list --count HEAD)" -eq 1
base_ref=$(jq -r .worktree.baseRef "$ta")
check '(a) the base ref moved past the base commit' test "$(git -C "$repo" rev-parse "$base_ref")" != "$(jq -r .worktree.baseCommit "$ta")"
check '(a) the Router pane shows the integration report' pane_has e8 '已整合到'

# (b)
type_line e8 "统计 $repo/greet.py 有几行，只回答数字"
check '(b) a second daily task' wait_for 300 more_tasks d- 1
tb=$(newest_daily)
check '(b) a rule routed it to an executor (not the routing assessment)' wait_for 300 bash -c "jq -e '[.agents[] | select(.role == \"executor\")] | length > 0' '$tb'"
check '(b) acceptance without a change' wait_for 900 log_has "$tb" 'map(select(.type == "spawn" and .role == "acceptance")) | length > 0'
acc_cwd=$(jq -r '[.agents[] | select(.role == "acceptance")][0].cwd' "$tb")
check '(b) the acceptance cwd is not a worktree' bash -c "[[ '$acc_cwd' != '$E/wt/'* ]]"
check '(b) task done' wait_for 300 bash -c "jq -e '.state == \"done\"' '$tb'"
check '(b) no integration' bash -c "! jq -e -s 'map(select(.type == \"integration\")) | length > 0' '$(log_of "$tb")'"

# (c)
type_line e8 '帮我为一个混合任务挑选模型：先读一份 PDF 论文的定理证明，再据此写一段 Rust 模拟代码，并画一张结果图。'
check '(c) a third daily task' wait_for 300 more_tasks d- 2
tc=$(newest_daily)
check '(c) the routing assessment runs on Opus at xhigh or above' wait_for 300 bash -c "jq -e '[.agents[] | select(.role == \"assessment\")][0] | .model == \"claude/claude-opus-5-5\" and (.effort == \"xhigh\" or .effort == \"max\")' '$tc'"
check '(c) the task waits for the person' wait_for 900 bash -c "jq -e '.state == \"waiting-user\"' '$tc'"
type_line e8 '确认'
check '(c) the executor runs on the confirmed recommendation' wait_for 900 bash -c "jq -e '[.agents[] | select(.role == \"executor\")][0].selection.kind == \"assessment-confirmed\"' '$tc'"
echo "tasks: $ta $tb $tc"
cleanup e8
finish
