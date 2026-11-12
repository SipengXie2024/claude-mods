#!/usr/bin/env bash
# E16: what a worker says about the session's other tasks. The engine's reminder a worker gets when it
# starts names every agent a message can reach, the ones that answered long ago among them; on
# 2026-11-12 a worker took it for what runs and told the person, 17 minutes later, that a finished task
# would be cut off by a restart. (a) While one task's worker runs a five-minute job, a second request
# asks whether a restart would cut anything off: its worker calls session_agents, which lists the first
# worker as running. (b) Once both tasks have ended, a third request asks again: the tool lists nothing
# running, though that worker's reminder names both earlier workers. (c) The Router, asked the same
# with no work beside it, calls the tool itself. An acceptance that fails on the way wakes its
# executor: the plugin's message to a worker is not the Router's SendMessage, which tg-router refuses.
source "$(dirname "$0")/lib.sh"
repo="$E/repo"
mkdir -p "$repo"
( cd "$repo" && git init -q && printf 'print("hello")\n' > greet.py && git add . \
  && git -c user.email=e2e@magpie -c user.name=e2e commit -qm init )
dailies() { ls "$E"/state/tasks/d-*.json 2>/dev/null | grep -v '\.log\.jsonl$' || true; }
newest_daily() { dailies | xargs -r ls -t | head -1; }
dbg="$E/e16.log"
# Every session_agents call of the session, oldest first: "<time> <agent name, or router for the main
# conversation> <answer>", the answer's lines joined by " / ".
calls() {
  python3 -I -c '
import glob, json, os, sys
rows = []
paths = glob.glob(os.path.join(sys.argv[1], "*", "*", "subagents", "agent-*.jsonl")) + glob.glob(os.path.join(sys.argv[1], "*", "*.jsonl"))
for path in paths:
    meta = path[:-len(".jsonl")] + ".meta.json"
    name = json.load(open(meta)).get("name", "?") if os.path.exists(meta) else "router"
    asked = {}
    for line in open(path):
        d = json.loads(line)
        m = d.get("message")
        # a transcript also keeps the messages of each request, without a time: the same calls again
        if "timestamp" not in d or not isinstance(m, dict) or not isinstance(m.get("content"), list): continue
        for b in m["content"]:
            if not isinstance(b, dict): continue
            if b.get("type") == "tool_use" and b["name"].endswith("session_agents"): asked[b["id"]] = d["timestamp"]
            if b.get("type") == "tool_result" and b.get("tool_use_id") in asked:
                c = b.get("content")
                text = c if isinstance(c, str) else "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
                rows.append((asked.pop(b["tool_use_id"]), name, text.replace("\n", " / ")))
for r in sorted(rows): print(" ".join(r))' "$E/cfg/projects"
}
worker_calls() { calls | grep -v '^[^ ]* router ' || true; }
router_calls() { calls | grep '^[^ ]* router ' || true; }
# <worker|router>_has <regex>: one of its calls matches; last_<worker|router>_has: its newest call does.
worker_has() { worker_calls > "$E/.calls"; grep -qE -- "$1" "$E/.calls"; }
last_worker_has() { worker_calls | tail -1 > "$E/.last"; grep -qE -- "$1" "$E/.last"; }
last_router_has() { router_calls | tail -1 > "$E/.last"; grep -qE -- "$1" "$E/.last"; }
more_worker_calls() { [ "$(worker_calls | wc -l)" -gt "$1" ]; }
more_router_calls() { [ "$(router_calls | wc -l)" -gt "$1" ]; }
all_settled() { for f in $(dailies); do settled "$f" || return 1; done; }
# The task's turn is over and nothing of it runs: done, or waiting for the person after a failed acceptance.
settled() { jq -e '(.state == "done" or .state == "waiting-user") and ([.agents[] | select(.state == "running")] | length == 0)' "$1"; }

start e16 "$E" env MAGPIE_TASKS_ROLE=router TG_ROUTER_STATE_DIR="$E/tg" claude-magpie --model "'claude/claude-opus-5-5[1m]'" --plugin-dir "$REPO/mods/tg-router" --debug-file "$dbg"
wait_ready e16
check 'the Router session has role router' wait_for 60 debug_has "$dbg" 'magpie-tasks: role router'

# (a)
type_line e16 "依次运行三次命令 python3 -c 'import time; time.sleep(100)'，每次都在前台等它结束再运行下一次，不要放到后台；全部结束后只回答三个退出码"
check '(a) the long-running task is recorded' wait_for 300 more_tasks d- 0
ta=$(newest_daily)
check '(a) its executor has started' wait_for 300 bash -c "jq -e '[.agents[] | select(.role == \"executor\")] | length > 0' '$ta'"
wa=$(jq -r .owner.workerName "$ta")
type_line e16 "统计 $repo/greet.py 有几行。另外我马上要重启这个 Router 会话，告诉我重启会不会打断别的正在运行的后台任务"
check '(a) the question is a task of its own' wait_for 300 more_tasks d- 1
tb=$(newest_daily)
check '(a) its worker asks for the session'"'"'s agents' wait_for 600 more_worker_calls 0
check '(a) the first worker is listed as running' worker_has " / - $wa \\([^)]*\\): RUNNING, "
check '(a) the count names a running agent' worker_has ': [1-9][0-9]* of [0-9]+ running\.'
check '(a) the long-running task ends' wait_for 1200 settled "$ta"
check '(a) the second task ends' wait_for 600 settled "$tb"
check '(a) no message of the plugin to a worker was refused' bash -c "! grep -qF '没有收到消息' '$dbg'"

# (b)
before=$(worker_calls | wc -l)
type_line e16 "统计 $repo/greet.py 有几个字符。另外我马上要重启这个 Router 会话，告诉我此刻还有没有别的后台任务在运行"
check '(b) a worker asks for the session'"'"'s agents again' wait_for 900 more_worker_calls "$before"
check '(b) nothing is listed as running' last_worker_has '(: 0 of [0-9]+ running\.|no agent other than you)'
check '(b) the first worker is not listed as running' bash -c "! grep -qE ' / - $wa \\([^)]*\\): RUNNING, ' '$E/.last'"
check '(b) the third request ends' wait_for 900 all_settled

# (c)
before=$(router_calls | wc -l)
type_line e16 "我马上要重启这个 Router 会话，现在重启会不会打断正在运行的后台任务？"
check '(c) the Router asks for the session'"'"'s agents itself' wait_for 300 more_router_calls "$before"
check '(c) it is answered that nothing runs' last_router_has '(: 0 of [0-9]+ running\.|no agent other than you)'
sleep 30   # the Router's answer follows its tool call
echo "calls:"; calls
echo "tasks: $(dailies | tr '\n' ' ')"
echo "pane:"; pane e16 | tail -60
cleanup e16
finish
