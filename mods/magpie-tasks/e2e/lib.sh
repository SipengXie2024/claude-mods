# Shared helpers of the magpie-tasks scenario scripts (plan section 12.2). Source it from a scenario
# with E set to a directory made by e2e/setup.sh. Each check prints PASS or FAIL; `finish` exits
# non-zero when any check failed. With FAIL_FAST=1 the scenario stops at its first failed check and
# leaves its tmux sessions open: later checks wait on what the failed one stands for, each to its
# full time limit.
set -uo pipefail
: "${E:?export E=<directory printed by e2e/setup.sh>}"
REPO=${REPO:-$HOME/sipeng/claude-mods}
export CLAUDE_CONFIG_DIR="$E/cfg"
export MAGPIE_TASKS_STATE_DIR="$E/state"
export JEV_OPUS_CONFIG_DIR="$E/jev"
failed=0

check() {
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then echo "PASS $name"; return; fi
  echo "FAIL $name"; failed=1
  if [ "${FAIL_FAST:-0}" = 1 ]; then echo "STOPPED at the first failed check"; exit 1; fi
}
finish() { [ $failed = 0 ] && echo "ALL PASS" || echo "SOME CHECKS FAILED"; exit $failed; }

# start <tmux session> <directory> <command...>: an interactive session in its own pane.
start() {
  local name=$1 dir=$2; shift 2
  tmux new-session -d -s "$name" -x 220 -y 60 \
    "cd '$dir' && env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT CLAUDE_CONFIG_DIR='$E/cfg' MAGPIE_TASKS_STATE_DIR='$E/state' JEV_OPUS_CONFIG_DIR='$E/jev' $*"
  tmux set -t "$name" remain-on-exit on >/dev/null
}
# The launcher of this repository: a window started with it goes on with the background session of
# the long task its first message becomes (bin/claude-magpie).
LAUNCHER="$REPO/mods/magpie-tasks/bin/claude-magpie"
# The launcher opened background session <short id> in a terminal (it execs `claude attach`).
attached() { pgrep -f "^claude attach $1\$" >/dev/null; }
type_line() { tmux send-keys -t "$1" -l "$2"; sleep 0.5; tmux send-keys -t "$1" Enter; }
key() { tmux send-keys -t "$1" "$2"; }
pane() { tmux capture-pane -p -J -t "$1" -S -300 2>/dev/null; }
pane_has() { pane "$1" | grep -qF -- "$2"; }
# A question dialog ($.ui.ask) is on the visible screen.
dialog_open() { tmux capture-pane -p -t "$1" 2>/dev/null | grep -qF 'Esc to cancel' && sleep 1; }
dialog_closed() { ! dialog_open "$1"; }
pane_dead() { [ "$(tmux display -p -t "$1" '#{pane_dead}' 2>/dev/null)" = 1 ]; }
# wait_for <seconds> <command...>: polls once a second until the command succeeds.
wait_for() {
  local n=$1 i; shift
  for ((i = 0; i < n; i++)); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
# The interactive prompt is ready (the bypass-permissions footer is drawn).
wait_ready() { wait_for "${2:-90}" pane_has "$1" 'bypass permissions on'; }

task_files() { ls "$E"/state/tasks/*.json 2>/dev/null | grep -v '\.log\.jsonl$' || true; }
task_count() { task_files | wc -l; }
newest_task() { task_files | xargs -r ls -t | head -1; }
task_field() { jq -r "$2" "$1"; }
log_of() { echo "${1%.json}.log.jsonl"; }
log_has() { jq -e -s "$2" "$(log_of "$1")"; }
agents_json() { claude agents --json --all 2>/dev/null; }
# A plugin debug line in a debug log (lines the plugin writes start with `magpie-tasks: `).
debug_has() { grep -qE -- "$2" "$1" 2>/dev/null; }

# Stops background sessions this scenario directory started and closes the given tmux sessions.
cleanup() {
  for s in "$@"; do tmux kill-session -t "$s" 2>/dev/null || true; done
}
stop_background() {
  agents_json | jq -r '.[] | select(.kind == "background" and .pid != null) | .id' | while read -r id; do
    claude stop "$id" >/dev/null 2>&1 || true
  done
}

# Magpie requests of the last two hours as "session requested_model effort" lines.
usage_rows() {
  magpie usage --csv --last 2h | python3 -I -c '
import csv, sys
for r in csv.DictReader(sys.stdin):
    print(r["session"], r["requested_model"], r["effort"])'
}

# The transcript of a session in this config directory.
transcript_of() { find "$E/cfg/projects" -name "$1.jsonl" 2>/dev/null | head -1; }
# Completed main-conversation turns of a transcript.
turns() { local n; n=$(grep -c '"subtype":"turn_duration"' "$1" 2>/dev/null); echo "${n:-0}"; }
# say_and_wait <tmux> <transcript> <text> [seconds]: sends a prompt in an attached pane and waits
# until the session has completed one more turn.
say_and_wait() {
  local before; before=$(turns "$2")
  type_line "$1" "$3"
  wait_for "${4:-600}" bash -c "[ \$(grep -c '\"subtype\":\"turn_duration\"' '$2' 2>/dev/null || echo 0) -gt $before ]"
}
# Tool results of a transcript that a hook refused or that failed, as text.
tool_errors() {
  python3 -I -c '
import json, sys
for line in open(sys.argv[1]):
    d = json.loads(line)
    m = d.get("message")
    if not isinstance(m, dict) or not isinstance(m.get("content"), list): continue
    for b in m["content"]:
        if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
            c = b.get("content")
            print(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False))' "$1"
}
# Tool uses of a transcript as "name<TAB>input json".
tool_uses() {
  python3 -I -c '
import json, sys
for line in open(sys.argv[1]):
    d = json.loads(line)
    m = d.get("message")
    if not isinstance(m, dict) or not isinstance(m.get("content"), list): continue
    for b in m["content"]:
        if isinstance(b, dict) and b.get("type") == "tool_use":
            print(b["name"] + "\t" + json.dumps(b.get("input"), ensure_ascii=False))' "$1"
}

# Task records whose ID starts with a prefix (l- or d-), and a wait until there are more than n.
tasks_with() { ls "$E"/state/tasks/"$1"*.json 2>/dev/null | grep -v '\.log\.jsonl$' || true; }
more_tasks() { [ "$(tasks_with "$1" | wc -l)" -gt "$2" ]; }
# The task a scenario's message creates, whatever earlier scenarios left in the same environment:
# take `before=$(tasks_with d-)` before sending it, then `new_task d- "$before"` is the record of the
# first task created since (by createdAt), empty while there is none; has_new_task waits on it.
new_task() {
  tasks_with "$1" | grep -vxF -f <(printf '%s\n' "$2") | xargs -r jq -r '"\(.createdAt) \(input_filename)"' | sort -n | head -1 | cut -d' ' -f2-
}
has_new_task() { [ -n "$(new_task "$1" "$2")" ]; }
# Expected routing from the rules file (rules/routing-rules.json, the authority on models and efforts):
# rule_field <rule id> <jq path>, e.g. rule_field code-change .effort.
RULES="$REPO/mods/magpie-tasks/rules/routing-rules.json"
rule_field() { jq -r --arg r "$1" ".rules[] | select(.id == \$r) | $2" "$RULES"; }
# rule_start <agent record json>: "<model> <effort>" the agent's rule gives for its recorded judgment
# (src/rules.ts ruleModel and startEffort): hardModel once Jev's deep probability reaches hardYes,
# deepModel and deepEffort for a brief judged deep, else the rule's model and effort.
rule_start() {
  jq -r --slurpfile R "$RULES" '. as $a | ($R[0].rules[] | select(.id == $a.ruleId)) as $r
    | (($a.judgment.deepP // -1) >= $R[0].thresholds.hardYes) as $hard | ($a.judgment.deep == true) as $deep
    | (if $hard and $r.hardModel != null then $r.hardModel elif $deep and $r.deepModel != null then $r.deepModel else $r.model end) as $m
    | "\($m) \(if $deep then $r.deepEffort else $r.effort end)"' <<<"$1"
}
# usage_has <regex>: a Magpie usage row (as usage_rows prints it) matches. The rows go through a file:
# with pipefail, `grep -q` closing the pipe early would fail the check.
usage_has() { usage_rows > "$E/.usage"; grep -qE -- "$1" "$E/.usage"; }
