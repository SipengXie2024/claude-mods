#!/usr/bin/env bash
# E13 (plan section 12.2): with the Jev key file missing, the Router's routing judgment is made by the
# evaluator model: the executor's judgment says substitute (key file missing), the routing note says
# so, and the task is accepted and integrated as usual. The option is restored afterwards.
source "$(dirname "$0")/lib.sh"
repo="$E/repo"
settings="$E/cfg/settings.json"
cp "$settings" "$E/settings.before-e13.json"
jq --arg k "$E/missing.key" '.pluginConfigs["magpie-tasks@sipeng-mods"].options.jevKeyFile = $k' "$E/settings.before-e13.json" > "$settings"
dailies() { ls "$E"/state/tasks/d-*.json 2>/dev/null | grep -v '\.log\.jsonl$' || true; }
n0=$(dailies | wc -l)
dbg="$E/e13.log"
start e13 "$HOME" env MAGPIE_TASKS_ROLE=router TG_ROUTER_STATE_DIR="$E/tg" claude-magpie --model "'claude/claude-opus-5-5[1m]'" --plugin-dir "$REPO/mods/tg-router" --debug-file "$dbg"
wait_ready e13
type_line e13 "在 $repo 里把 greet.py 的 hi 改成 hey，并运行 python3 greet.py 验证"
check 'a daily task is recorded' wait_for 300 more_tasks d- "$n0"
t=$(dailies | xargs -r ls -t | head -1)
check "the executor's judgment is the substitute's" wait_for 300 bash -c "jq -e '[.agents[] | select(.role == \"executor\")][0].judgment.provider == \"substitute\"' '$t'"
check 'the substitute reason is the missing key file' bash -c "jq -e '[.agents[] | select(.role == \"executor\")][0].judgment.substituteReason == \"key file missing\"' '$t'"
check 'the routing note says the evaluator judged' wait_for 120 pane_has e13 '由评估模型代为判断'
router=$(grep -o 'magpie-tasks: role router (session [0-9a-f-]*' "$dbg" | head -1 | awk '{print $NF}')
check 'Magpie served the evaluator model (Opus, effort low) in the Router session' usage_has "^$router claude/claude-opus-5-5 low"
check 'accepted and integrated' wait_for 1800 log_has "$t" 'map(select(.type == "integration" and .status == "applied")) | length > 0'
check 'greet.py prints hey' bash -c "cd '$repo' && python3 greet.py | grep -qx hey"
type_line e13 '/exit'
cleanup e13
cp "$E/settings.before-e13.json" "$settings"
finish
