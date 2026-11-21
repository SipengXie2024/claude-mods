---
name: verify
description: Check a change to the magpie-tasks plugin end to end - typecheck, unit tests, io-tests with real files, git and Jev, and a live scenario window in tmux. Use after changing anything under mods/magpie-tasks (session flows, routing rules, dialogs).
---

# Verify magpie-tasks

Run from the repository root (or the task worktree root). `command` bypasses a shell alias
that puts options before `plugin` (`claude plugin test` refuses to run then). `.claude-plugin/types/` and
`io-tests/node_modules/` are git-ignored: in a fresh worktree copy the types from the main checkout
before the first `tsc` run, or `tsc` finds no `noEmit` setting and writes `.js` files next to every
`.ts` file.

```
cp -r ~/sipeng/claude-mods/mods/magpie-tasks/.claude-plugin/types mods/magpie-tasks/.claude-plugin/   # worktree only
(cd mods/magpie-tasks/io-tests && bun install)
bunx tsc -p mods/magpie-tasks/tsconfig.json
bunx tsc -p mods/magpie-tasks/io-tests/tsconfig.json
command claude plugin validate mods/magpie-tasks
command claude plugin test mods/magpie-tasks
bun test mods/magpie-tasks/io-tests
```

After editing `rules/routing-rules.json`, regenerate the test copy first:
`(cd mods/magpie-tasks && bun eval/rules-eval.ts data)`. `io-tests/rules.spec.ts` compares every
rule's condition, acceptance and evidence, and the section 2.4 effort table, with
`.planning/model-routing-table.md` word for word.

The io-tests read Magpie's live launch settings (`~/.config/magpie/claude-launch/settings.json`)
for model aliases. When Magpie maps the `opus` alias to a non-Claude model, the alias tests in
`model.spec.ts` and `rules.spec.ts` fail; to check the rest, run them with `HOME` pointing at a
directory whose `.config/magpie/claude-launch/settings.json` is a copy with
`ANTHROPIC_DEFAULT_OPUS_MODEL` set to `claude/claude-opus-5-5[1m]` and whose `.config/jev-opus`
links to the real one.

## Live window

The scenario scripts start real `claude-magpie` sessions in tmux against the Magpie gateway on
127.0.0.1:3425. `REPO` makes the environment install the plugins from the checkout under test:

```
export E=$(REPO=$PWD bash mods/magpie-tasks/e2e/setup.sh)
bash mods/magpie-tasks/e2e/e1-scope.sh      # dialog pages, Esc, the ordinary-session choice
```

E1 uses Haiku 5.5 and records no task; it ends with `ALL PASS`. Delete `$E` afterwards. Scenarios
that launch background architects (E3 and later) cost more; `e2e/lib.sh` and README "检查" describe
them.
