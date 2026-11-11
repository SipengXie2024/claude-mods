#!/usr/bin/env bash
# E2 (plan sections 9.15, 12.2): magpie-tasks runs inside jev and subagent-opus when installed after
# them; moved before jev in enabledPlugins it shows the order error and stays inactive.
source "$(dirname "$0")/lib.sh"
cd "$E"
settings="$E/cfg/settings.json"

start e2a "$E" claude-magpie --model claude/claude-haiku-5-5 --debug-file "$E/e2a.log"
wait_ready e2a
wait_for 30 debug_has "$E/e2a.log" 'magpie-tasks: role '
chain=$(grep -o '\$ built for [^ ]*' "$E/e2a.log" | head -1 | sed 's/^\$ built for //')
echo "chain: $chain"
pos() { tr ',' '\n' <<<"$chain" | grep -nx "$1" | cut -d: -f1; }
check 'magpie-tasks after jev in the chain (inner)' test "$(pos magpie-tasks)" -gt "$(pos jev)"
check 'magpie-tasks after subagent-opus in the chain (inner)' test "$(pos magpie-tasks)" -gt "$(pos subagent-opus)"
check 'installed in order: role candidate' debug_has "$E/e2a.log" 'magpie-tasks: role candidate'
type_line e2a '/exit'
cleanup e2a

cp "$settings" "$E/settings.before-e2.json"
jq '.enabledPlugins |= ({"magpie-tasks@sipeng-mods": .["magpie-tasks@sipeng-mods"]} + del(.["magpie-tasks@sipeng-mods"]))' "$E/settings.before-e2.json" > "$settings"
start e2b "$E" claude-magpie --model claude/claude-haiku-5-5 --debug-file "$E/e2b.log"
wait_ready e2b
check 'wrong order: error shown' wait_for 30 pane_has e2b 'magpie-tasks 没有生效'
check 'wrong order: role inactive' debug_has "$E/e2b.log" 'magpie-tasks: role inactive: magpie-tasks 没有生效'
type_line e2b '/exit'
cleanup e2b
cp "$E/settings.before-e2.json" "$settings"
finish
