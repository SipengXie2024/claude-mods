---
name: verify
description: Verify changes to mods/magpie-heads-up — manifest validation, unit tests, and a live tmux claude-magpie session verifying /heads-up now, AbovePrompt rendering alongside jev, and hotkey expand/dismiss.
---

# Verify `mods/magpie-heads-up`

1. Manifest and hooks validation (use the direct binary because `claude` may be aliased with flags):
```bash
/home/ubuntu/.local/bin/claude plugin validate /home/ubuntu/sipeng/claude-mods/mods/magpie-heads-up
```

2. Unit tests:
```bash
/home/ubuntu/.local/bin/claude plugin test /home/ubuntu/sipeng/claude-mods/mods/magpie-heads-up
```

3. Live interactive tmux check under `claude-magpie`:
```bash
SESS="verify-headsup-$$"
tmux new-session -d -s "$SESS" -x 130 -y 40 "claude-magpie --model hakimi/gemini-4-neon"
# Wait until prompt is ready, send one substantive turn, wait for "· done ",
# then send "/heads-up now", wait for "展开说明" in `tmux capture-pane -t "$SESS" -p`,
# press "1" to verify expansion and "0" to verify dismissal, and check `jev`'s band stays visible.
# Clean up when finished:
tmux kill-session -t "$SESS"
```

4. Effort-sync cache hit check on `codex/gpt-6.2-astra` (where caches are keyed per effort level):
Launch `claude-magpie --model codex/gpt-6.2-astra`, run one chat turn (JEV sets `low`), then `/heads-up now`, and verify in `~/.config/magpie/usage.jsonl` that the fork row carries `effort: "low"` (matching the main turn) and `cache_read > 0`.

Remove temporary test entries if desired via `/heads-up clear` or restoring `~/.claude/plugins/store/magpie-heads-up_*.json`.
