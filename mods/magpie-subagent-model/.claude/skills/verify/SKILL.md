---
name: verify
description: Verify changes to mods/magpie-subagent-model — manifest validation, unit tests, and a live claude-magpie subagent spawn check verifying the routing table prompt and [model]/[effort] routing in Magpie logs.
---

# Verify `mods/magpie-subagent-model`

1. Manifest and hooks validation (use the direct binary because `claude` may be aliased with flags):
```bash
/home/ubuntu/.local/bin/claude plugin validate /home/ubuntu/sipeng/claude-mods/mods/magpie-subagent-model
```

2. Unit tests:
```bash
/home/ubuntu/.local/bin/claude plugin test /home/ubuntu/sipeng/claude-mods/mods/magpie-subagent-model
```

3. Live end-to-end check under `claude-magpie` (verify routing table visibility and real `[model]` + `[effort]` routing in Magpie's routing log):
```bash
LOG="/home/ubuntu/.config/magpie/routing/$(date -u +%Y-%m-%d).jsonl"
BEFORE=$(wc -l < "$LOG")
claude-magpie -p --model hakimi/gemini-4-neon \
  "1) From your Task routing table, name the model and effort for machine-ops and gpu-kernel. 2) Spawn one Agent subagent with [model claude/claude-sonnet-5-5] and [effort max] that replies with exactly SONNET_OK (no tools)." \
  < /dev/null
tail -n +"$((BEFORE + 1))" "$LOG" | python3 -c "import sys,json; [print(r.get('model'), r.get('effort'), r.get('sub'), r.get('status')) for r in (json.loads(l) for l in sys.stdin)]"
```
Confirm a subagent row shows `claude/claude-sonnet-5-5 max <sub-id> 200`.
