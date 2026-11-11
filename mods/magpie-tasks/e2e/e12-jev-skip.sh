#!/usr/bin/env bash
# E12 (plan section 12.2): JEV leaves every subagent magpie-tasks routed to the plugin: each such agent
# has `skip` rows (reason magpie-tasks) in JEV's journal and no prompt or step rows; Magpie served
# the effort the plugin recorded; the architect's and the Router's main conversations still have
# JEV's own rows. Reads the records E6 and E8 left.
source "$(dirname "$0")/lib.sh"
journal=$(ls "$E"/jev/mod-journal-*.jsonl 2>/dev/null)
check 'JEV wrote its journal under $E/jev' test -n "$journal"
rows() { cat $journal | jq -c "$1"; }
# JEV routes Opus, Mythos, GPT-6 Astra and GPT-6.1 Sol and leaves every other model alone (no rows at
# all), so a skip row is expected for those four only.
jev_model() { grep -qE '^(claude/claude-opus|claude/claude-mythos|codex/gpt-6-astra$|codex/gpt-6\.1-sol$)' <<<"$1"; }
# Both loops read through process substitution so that a failed check reaches `finish`.
while read -r a m; do
  ran=$(find "$E/cfg/projects" -name "agent-$a.jsonl" | head -1)
  [ -z "$ran" ] && continue
  steps=$(rows "select(.agent == \"$a\" and (.event == \"prompt\" or .event == \"step\"))" | wc -l)
  skips=$(rows "select(.agent == \"$a\" and .event == \"skip\" and .reason == \"magpie-tasks\")" | wc -l)
  if jev_model "$m"; then
    check "agent $a ($m): skip rows ($skips), no prompt or step rows ($steps)" test "$skips" -ge 1 -a "$steps" -eq 0
  else
    check "agent $a ($m, not a JEV model): no prompt or step rows ($steps)" test "$steps" -eq 0
  fi
done < <(for t in $(task_files); do jq -r '.agents[] | "\(.agentId) \(.model)"' "$t"; done | sort -u)
arch=$(task_field "$(cat "$E/e3.task")" .owner.sessionId)
check 'the architect main conversation has JEV prompt rows' test "$(rows "select(.session == \"$arch\" and .agent == \"main\" and .event == \"prompt\")" | wc -l)" -ge 1
router=$(grep -o 'magpie-tasks: role router (session [0-9a-f-]*' "$E/e8.log" | head -1 | awk '{print $NF}')
check 'the Router main conversation has JEV prompt rows' test "$(rows "select(.session == \"$router\" and .agent == \"main\" and .event == \"prompt\")" | wc -l)" -ge 1
# Magpie's record of each routed agent's requests: requested model and effort in the agent's session.
usage=$(usage_rows)
while read -r s m eff; do
  check "Magpie served $m at $eff in session $s" awk -v s="$s" -v m="$m" -v e="$eff" '$1 == s && ($2 == m || $2 == m "[1m]") && $3 == e { found = 1 } END { exit !found }' <<<"$usage"
done < <(for t in $(task_files); do jq -r '.agents[] | "\(.sessionId) \(.model) \(.effort)"' "$t"; done | sort -u)
finish
