#!/usr/bin/env bash
# E13 (plan section 12.2): with the Jev key file missing, the Router's routing judgment is made by the
# evaluator model: the executor's judgment says substitute (key file missing), the routing note says
# so, and the task's change is recorded as usual: `in-place` when the task changes the repository
# itself, `applied` when it works in a worktree (README, 工作目录). The option is restored afterwards.
# It changes E8's repository when there is one (greet.py then prints `hi world`), else makes its own.
source "$(dirname "$0")/lib.sh"
repo="$E/repo"
if [ ! -d "$repo/.git" ]; then
  mkdir -p "$repo"
  ( cd "$repo" && git init -q && printf 'print("hi")\n' > greet.py && git add . \
    && git -c user.email=e2e@magpie -c user.name=e2e commit -qm init )
fi
# What greet.py prints is the expectation, with its word hi as hey: earlier scenarios decide the rest.
said=$(cd "$repo" && python3 greet.py)
want=$(sed -E 's/\bhi\b/hey/' <<<"$said")
check "greet.py prints hi before ($said)" grep -qw hi <<<"$said"
settings="$E/cfg/settings.json"
cp "$settings" "$E/settings.before-e13.json"
jq --arg k "$E/missing.key" '.pluginConfigs["magpie-tasks@sipeng-mods"].options.jevKeyFile = $k' "$E/settings.before-e13.json" > "$settings"
before=$(tasks_with d-)
dbg="$E/e13.log"
start e13 "$HOME" env MAGPIE_TASKS_ROLE=router TG_ROUTER_STATE_DIR="$E/tg" claude-magpie --model "'claude/claude-opus-5-5[1m]'" --plugin-dir "$REPO/mods/tg-router" --debug-file "$dbg"
wait_ready e13
type_line e13 "在 $repo 里把 greet.py 的 hi 改成 hey，并运行 python3 greet.py 验证"
check 'a daily task is recorded' wait_for 300 has_new_task d- "$before"
t=$(new_task d- "$before")
check "the executor's judgment is the substitute's" wait_for 300 bash -c "jq -e '[.agents[] | select(.role == \"executor\")][0].judgment.provider == \"substitute\"' '$t'"
check 'the substitute reason is the missing key file' bash -c "jq -e '[.agents[] | select(.role == \"executor\")][0].judgment.substituteReason == \"key file missing\"' '$t'"
check 'the routing note says the evaluator judged' wait_for 120 pane_has e13 '由评估模型代为判断'
router=$(grep -o 'magpie-tasks: role router (session [0-9a-f-]*' "$dbg" | head -1 | awk '{print $NF}')
# The evaluator's own request for the routing judgment: the Router session's Magpie row on the
# evaluator model that went out when the plugin's first `$.model.complete` call began (its debug line
# gives the end and the duration). Magpie's rows have whole seconds and other requests of the session
# share the model, so a row counts only within a second of the call's start.
evaluator_rows() {
  magpie usage --csv --last 2h | python3 -I -c '
import csv, datetime as dt, re, sys
calls = []
for line in open(sys.argv[1]):
    m = re.match(r"(\S+) \[DEBUG\] \$\.model\.complete \(magpie-tasks\): (\S+) answered in (\d+)ms", line)
    if m:
        end = dt.datetime.fromisoformat(m[1].replace("Z", "+00:00"))
        start = (end - dt.timedelta(milliseconds=int(m[3]))).replace(microsecond=0)
        calls.append((m[2], start, start + dt.timedelta(seconds=1)))
calls = calls[:1]
for r in csv.DictReader(sys.stdin):
    if r["session"] != sys.argv[2]: continue
    at = dt.datetime.fromisoformat(r["time"].replace("Z", "+00:00"))
    for model, start, end in calls:
        if r["requested_model"] == model and start <= at <= end:
            print(r["time"], r["requested_model"], "effort=" + r["effort"], "output_tokens=" + r["output_tokens"])' "$dbg" "$router"
}
evaluator_on() { evaluator_rows > "$E/.evaluator"; grep -q " $1 " "$E/.evaluator"; }
# Its effort is not checked: Claude Code sends a `$.model.complete` request's effort as the request's top-level `output_config.effort`, and Magpie's usage records only the effort a main conversation puts inside its messages, so the evaluator's row has no effort (findings 2026-11-13, "Magpie's usage log shows no effort for a plugin's `$.model.complete` request").
check 'Magpie served the evaluator model (Opus) for the substitute judgment in the Router session' wait_for 60 evaluator_on claude/claude-opus-5-5
echo "evaluator request: $(cat "$E/.evaluator")"
check 'its change is recorded' wait_for 1800 log_has "$t" 'map(select(.type == "integration" and (.status == "in-place" or .status == "applied"))) | length > 0'
# The workspace kind of the repository: the task's placement of it (workspace.ts).
mode=$(jq -r -s --arg r "$(realpath "$repo")" '[.[] | select(.type == "workspace" and .dir == $r)][0].mode' "$(log_of "$t")")
case $mode in direct) status=in-place ;; worktree) status=applied ;; *) status="(no placement of $repo)" ;; esac
echo "workspace $mode, expected integration $status"
check "it is recorded as its workspace kind requires ($status)" log_has "$t" "map(select(.type == \"integration\" and .status == \"$status\")) | length > 0"
check "greet.py prints $want" bash -c "cd '$repo' && [ \"\$(python3 greet.py)\" = '$want' ]"
type_line e13 '/exit'
cleanup e13
cp "$E/settings.before-e13.json" "$settings"
finish
