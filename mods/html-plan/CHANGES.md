# Changes against upstream html-plan 1.0.0

Upstream: anthropics/claude-plugins-community, `html-plan/skills/html-plan` (marketplace checkout at
`~/.claude/plugins/marketplaces/claude-community`). `README.upstream.md` is the upstream plugin README.

- `runtime/htmlplan.js`: a `ZH` string table and `T()` near the top; every user-visible string and the
  response template go through `T()`. `ZH_ON` is true when `<html lang="zh…">`.
- `runtime/pack.mjs`: `wc()` counts two CJK characters as one word; `SENT_END` / `SENT_SPLIT` accept `。？！`;
  the `<h1>` check accepts CJK sentence punctuation.
- `SKILL.md`: the Words section tells the writer to use the reader's language and `<html lang="zh">`.

To take an upstream update: copy `skills/` over, re-apply the three edits, run `node --check` on both files.
