---
name: verify
description: Verify changes to mods/magpie-code-mode — manifest validation, hook tests, real Bun Unix-socket worker tests, and live claude-magpie sessions verifying tool hiding, parallel execution, cross-turn persistence, and clean shutdown.
---

# Verify `mods/magpie-code-mode`

1. Manifest and hooks validation:
```bash
/home/ubuntu/.local/bin/claude plugin validate /home/ubuntu/sipeng/claude-mods/mods/magpie-code-mode
```

2. Hook unit tests:
```bash
/home/ubuntu/.local/bin/claude plugin test /home/ubuntu/sipeng/claude-mods/mods/magpie-code-mode
```

3. Real Bun VM worker integration tests (Unix domain socket + real filesystem/bash):
```bash
bun test /home/ubuntu/sipeng/claude-mods/mods/magpie-code-mode/tests/worker.spec.ts
```

4. Live `-p` parallel tool execution check on both Gemini and Astra:
```bash
for M in hakimi/gemini-4-neon codex/gpt-6.2-astra; do
  D=$(mktemp -d /tmp/cm-verify-XXXXXX)
  env -u CLAUDE_CODE_AUTO_COMPACT_WINDOW claude-magpie -p --model "$M" \
    "请用你的代码执行工具在 ${D} 里并行写入 a.txt（hello world）和 b.txt（42），用 edit 把 world 改成 magpie，再并行读取并返回结果。"
  grep -qx "hello magpie" "$D/a.txt" && grep -qx "42" "$D/b.txt"
done
```

5. Live interactive tmux check for cross-turn REPL variable persistence, `/code-mode status`, and clean `/exit` socket cleanup:
```bash
SESS="verify-codemode-$$"
tmux new-session -d -s "$SESS" -x 130 -y 42 "cd /home/ubuntu/sipeng/claude-mods && env -u CLAUDE_CODE_AUTO_COMPACT_WINDOW claude-magpie --model hakimi/gemini-4-neon"
# Turn 1: define `const secretNum = 20261126;`
# Turn 2: compute `secretNum * 2` without redefining it -> expect `40522252` in <repl-output eval="2">
# Run `/code-mode status` -> verify running worker PID, eval count >= 2, and `secretNum` in globals
# Run `/exit` -> verify no `/tmp/magpie-cm-*.sock` remains
tmux kill-session -t "$SESS" 2>/dev/null || true
```
