// conflict.ts on real inputs (plan section 12.1, conflict row).
import { describe, expect, test } from 'claude-code/testing'
import { findConflict, isCheckCommand, porcelainChanged, touchedPaths } from '../src/conflict'

// `git status --porcelain=v1 -z --untracked-files=all > file` (git 2.43.0), copied here byte for byte,
// in a repository made by:
//   git init -q; mkdir -p src docs; printf 'print("hello")\n' > greet.py; printf 'a\n' > "src/my file.txt"
//   printf 'old\n' > docs/old-name.md; printf 'x\n' > keep.txt; git add -A; git commit -qm init
// BEFORE, after: printf 'b\n' >> "src/my file.txt"; git mv docs/old-name.md docs/new-name.md
//   mkdir notes; printf 'n\n' > "notes/todo list.md"
// (a modified file whose name has a space, a staged rename, an untracked file in a new directory).
const BEFORE = "R  docs/new-name.md\u0000docs/old-name.md\u0000 M src/my file.txt\u0000?? notes/todo list.md\u0000"
// AFTER, after: printf 'print("hi")\n' > greet.py; printf 'new\n' > "src/new file.ts"; rm keep.txt
//   printf 'c\n' >> "src/my file.txt"
const AFTER = "R  docs/new-name.md\u0000docs/old-name.md\u0000 M greet.py\u0000 D keep.txt\u0000 M src/my file.txt\u0000?? notes/todo list.md\u0000?? src/new file.ts\u0000"
// RENAMED, after: git mv greet.py hello.py
const RENAMED = "R  docs/new-name.md\u0000docs/old-name.md\u0000RM hello.py\u0000greet.py\u0000 D keep.txt\u0000 M src/my file.txt\u0000?? notes/todo list.md\u0000?? src/new file.ts\u0000"
// The same state as RENAMED from `git status --porcelain=v1 --untracked-files=all`, without -z.
const RENAMED_NO_Z = "R  docs/old-name.md -> docs/new-name.md\nRM greet.py -> hello.py\n D keep.txt\n M \"src/my file.txt\"\n?? \"notes/todo list.md\"\n?? \"src/new file.ts\"\n"

// Commands from a real Claude Code session and a sanitized 2026-09-28 production session, copied from
// mods/jev/tests/fixtures.ts (dateDebugCommands; productionToolResults falseFailures, suspectOnly and
// genuineFailures). JEV judges none of them a check: each pipes its output or only reads.
const SESSION_COMMANDS: string[] = [
  "ls -A && cat > package.json <<'EOF'\n{\"type\":\"module\",\"scripts\":{\"test\":\"node --test\"}}\nEOF\ncat > dates.js <<'EOF'\nexport function isLeapYear(y) { return y % 4 === 0 && y % 100 !== 0; }\nexport function daysInMonth(year, month) { const days = [31,28,31,30,31,30,31,31,30,31,30,31]; if (month === 2 && isLeapYear(year)) return 29; return days[month]; }\nexport function dayOfYear(s) { const [y, m, d] = s.split('-').map(Number); let t = d; for (let i = 1; i < m; i++) t += daysInMonth(y, i); return t; }\nEOF\ncat > dates.test.js <<'EOF'\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isLeapYear, daysInMonth, dayOfYear } from './dates.js';\n\ntest('isLeapYear', () => {\n  assert.equal(isLeapYear(2024), true);\n  assert.equal(isLeapYear(1900), false);\n  assert.equal(isLeapYear(2000), true);\n});\n\ntest('daysInMonth', () => {\n  assert.equal(daysInMonth(2023, 1), 31);\n  assert.equal(daysInMonth(2024, 2), 29);\n  assert.equal(daysInMonth(2023, 12), 31);\n});\n\ntest('dayOfYear', () => {\n  assert.equal(dayOfYear('2024-03-01'), 61);\n  assert.equal(dayOfYear('2023-12-31'), 365);\n});\nEOF\nnpm test 2>&1 | grep -E \"^# |not ok|actual|expected\" ",
  "sed -i '' -e 's/y % 4 === 0 \\&\\& y % 100 !== 0;/(y % 4 === 0 \\&\\& y % 100 !== 0) || y % 400 === 0;/' -e 's/return days\\[month\\];/return days[month - 1];/' dates.js && cat dates.js && npm test 2>&1 | grep -E \"^# (tests|pass|fail)|not ok\"",
  "sysctl -n hw.ncpu hw.memsize | awk 'NR==1{print $1\" cpus\"} NR==2{print $1/1e9\" GB\"}'; docker info --format '{{.NCPU}} cpu {{.MemTotal}} mem'; uptime; sed -n 1,80p /repo/docs/fh-summarize.py",
  "cd /repo/agents/v7-gate; B=$(cat /repo/.agent-runs/v7-gate/base); git diff $B -- packages/runtime/src packages/cli/src",
  "cd /repo/agents/v7-gate; B=$(cat /repo/.agent-runs/v7-gate/base); git diff $B -- packages/runtime/test packages/cli/test",
  "cd /repo/packages/runtime/src; grep -n \"taskClauses\\|export function\\|MAX_\\|^const\" checks.ts prompt.ts | head -60; wc -l checks.ts prompt.ts",
  "cd /repo/packages/runtime/src; cat checks.ts; sed -n 1,142p prompt.ts",
  "cd /repo/packages/runtime; python3 - <<'P'\np=\"src/checks.ts\"; s=open(p).read()\na=\"|\\\\bFAILED\\\\b|\"; b=\"|(?<!\\\\b0 )\\\\bFAILED\\\\b|\"\nassert s.count(a)==1; s=s.replace(a,b); open(p,\"w\").write(s)\nP\nhead -1 src/checks.ts; npx tsc --noEmit -p . && npm test 2>&1 | grep -E \"^# (pass|fail)|not ok\"",
  "cd /repo; git add packages/runtime/src/checks.ts packages/runtime/test/checks.test.ts && git commit -q -m \"fix(runtime): '0 FAILED' is not a failure\n\nCo-Authored-By: someone\" && git log --oneline -1\npython3 - <<'P'\nprint(\"patched\")\nP\nsed -n 10,16p packages/runtime/src/prompt.ts | cut -c1-160; cd packages/runtime && npx tsc --noEmit -p . && npm test 2>&1 | grep -E \"^# (pass|fail)|not ok\"",
  "cd /repo/runs; T=v10/trials/anko/t1; python3 .claude/skills/fh-eval/trace.py $T 2>&1 | tail -20",
  "cd /repo/runs; for d in v10-c/trials/sm/t2 v10-c/trials/meriyah/t1; do python3 score.py $d; done",
  "cd /repo/docs/frontierharness; python3 -m unittest test_summarize 2>&1 | grep -B5 -A15 \"^FAIL:\" | head -40",
  "cd /repo/agents/clause-fg/packages/runtime && npx tsc --noEmit -p . && npm test 2>&1 | grep -E \"^# (pass|fail|skip)|not ok\" | head",
  "cd /repo/agents/clause-fg/packages/runtime && node --test dist-test/test/checks.test.js 2>&1 | grep -E \"actual|expected|\\+|- \" | head -12",
  "cd ../agents/model-caps/packages/cli && npm test 2>&1 | grep -B3 -A25 \"^not ok\" | head -50",
  "cd /app && uv run pytest -q 2>&1 | tail -5"
]

describe('touchedPaths', () => {
  test('Edit, Write and MultiEdit write file_path; NotebookEdit writes notebook_path', () => {
    expect(touchedPaths('Edit', { file_path: '/wt/greet.py', old_string: 'hello', new_string: 'hi' })).toEqual(['/wt/greet.py'])
    expect(touchedPaths('Write', { file_path: '/wt/src/new file.ts', content: 'x' })).toEqual(['/wt/src/new file.ts'])
    expect(touchedPaths('MultiEdit', { file_path: '/wt/a.ts', edits: [] })).toEqual(['/wt/a.ts'])
    expect(touchedPaths('NotebookEdit', { notebook_path: '/wt/n.ipynb', new_source: '' })).toEqual(['/wt/n.ipynb'])
  })
  test('other tools and inputs without a path write nothing', () => {
    expect(touchedPaths('Read', { file_path: '/wt/greet.py' })).toEqual([])
    expect(touchedPaths('Bash', { command: 'touch x' })).toEqual([])
    expect(touchedPaths('Edit', {})).toEqual([])
    expect(touchedPaths('NotebookEdit', { file_path: '/wt/n.ipynb' })).toEqual([])
  })
})

describe('porcelainChanged', () => {
  test('entries that appeared or changed status; a file modified before and after is not seen', () => {
    expect(porcelainChanged(BEFORE, AFTER)).toEqual(['greet.py', 'keep.txt', 'src/new file.ts'])
  })
  test('a rename made during the call reports both names; the earlier staged rename stays out', () => {
    expect(porcelainChanged(AFTER, RENAMED)).toEqual(['greet.py', 'hello.py'])
  })
  test('the difference is symmetric: what disappeared counts as well', () => {
    expect(porcelainChanged(AFTER, BEFORE)).toEqual(['greet.py', 'keep.txt', 'src/new file.ts'])
  })
  test('identical and empty outputs change nothing', () => {
    expect(porcelainChanged(AFTER, AFTER)).toEqual([])
    expect(porcelainChanged('', '')).toEqual([])
    expect(porcelainChanged('', BEFORE)).toEqual(['docs/new-name.md', 'docs/old-name.md', 'notes/todo list.md', 'src/my file.txt'])
  })
  test('output that is not porcelain v1 -z is refused', () => {
    expect(() => porcelainChanged(AFTER, RENAMED_NO_Z)).toThrow()
    // RENAMED cut after the rename's new name: the original name is missing.
    expect(() => porcelainChanged(AFTER, RENAMED.slice(0, RENAMED.indexOf('hello.py\0') + 'hello.py\0'.length))).toThrow()
  })
})

describe('findConflict', () => {
  const touches = new Map<string, Set<string>>([
    ['a1', new Set(['/wt/greet.py', '/wt/README.md'])],
    ['a2', new Set(['/wt/src/x.ts'])],
    ['a3', new Set(['/wt/greet.py'])],
  ])
  test('another running agent that touched the path', () => {
    expect(findConflict(touches, 'a3', '/wt/greet.py', new Set(['a1', 'a2', 'a3']))).toBe('a1')
    expect(findConflict(touches, 'a1', '/wt/greet.py', new Set(['a1', 'a3']))).toBe('a3')
  })
  test('the agent itself, agents no longer running, and untouched paths are no conflict', () => {
    expect(findConflict(touches, 'a1', '/wt/README.md', new Set(['a1', 'a2', 'a3']))).toBeNull()
    expect(findConflict(touches, 'a3', '/wt/greet.py', new Set(['a2', 'a3']))).toBeNull()
    expect(findConflict(touches, 'a2', '/wt/other.py', new Set(['a1', 'a2', 'a3']))).toBeNull()
    expect(findConflict(new Map(), 'a1', '/wt/greet.py', new Set(['a1']))).toBeNull()
  })
})

// The lists below are JEV's own (mods/jev/tests/describe.test.ts, "decision 4" tests), so a
// difference from JEV's judgment fails here.
describe('isCheckCommand', () => {
  test('the known runners are checks, after env, wrappers and launcher prefixes', () => {
    for (const command of [
      'cargo test', 'cargo build --release', 'cargo clippy -- -D warnings', 'cargo check -p core',
      'pytest -q tests/test_a.py', 'python -m pytest', 'python3.12 -m pytest -x', 'uv run pytest', 'poetry run mypy src',
      'go test ./...', 'go build ./cmd/x', 'go vet ./...',
      'tsc --noEmit', 'npx tsc -p .', 'npx --yes -p typescript tsc -p mods/jev --noEmit', './node_modules/.bin/tsc', 'eslint .', 'ruff check .', 'mypy src',
      'npm test', 'npm test -- --grep parser', 'pnpm test', 'yarn test', 'bun test', 'npm run build', 'npm run test:unit', 'pnpm run lint',
      'yarn run typecheck', 'bun run check', 'npm run verify', 'npm run ci', 'npm --prefix web run lint', 'pnpm -C app run test',
      'CI=1 npm test', 'timeout 600 cargo test', 'env RUST_LOG=debug cargo test', 'time pytest',
      'cd repo && npm test', 'cd repo; npm test', 'npm test 2>&1', 'npm test > out.log 2>&1', 'npm run build && npm test', 'npm test && echo ok',
      '(cd repo && npm test)', 'npm test;', 'npm test\n',
    ]) expect(isCheckCommand(command), command).toBe(true)
  })
  test('a script name counts only as a whole word or before `:`; one-off scripts are no checks', () => {
    for (const command of [
      'bun run scripts/precision.ts', 'bun scripts/decide.ts', 'bun run src/circuit.ts', 'bun run scripts/recall.ts', 'python3 scripts/precision.py',
      'npm run testing', 'npm run build-docs', 'npm run pretest', 'npm ci', 'npm install', 'yarn build', 'node --test', 'make test', 'jest',
      'python3 scripts/run_tests.py', './scripts/test.sh', 'cargo run', 'go run .', 'python -c "import pytest"',
    ]) expect(isCheckCommand(command), command).toBe(false)
  })
  test('a pipe, `|| true` / `|| :`, a background `&`, or anything but `&&` after the check leaves it unjudged', () => {
    for (const command of [
      'npm test | tail -30', 'npm test 2>&1 | grep -E "^# "', 'pytest |& tee log', 'npm test || true', 'npm test || :', 'cargo test || echo failed',
      'npm test; echo done', 'pytest; echo "exit=$?"', 'npm test &', 'ls | head; npm test', 'rm -f x || true; npm test',
      '(cd repo && npm test) || true', '(cd repo && npm test); echo', 'npm test\necho done',
    ]) expect(isCheckCommand(command), command).toBe(false)
    expect(isCheckCommand('npm test -- --grep "a | b"')).toBe(true)
    expect(isCheckCommand('echo "npm test"')).toBe(false)
  })
  test('the remote command of ssh, docker exec and sh -c is judged the same way', () => {
    for (const command of [
      "ssh haichao 'cd /srv/app && cargo test'", 'ssh -p 2222 -i ~/.ssh/k user@host pytest -q', "ssh host 'npm test'",
      'docker exec web npm test', 'docker exec -it -w /app web pytest', "docker exec web bash -lc 'cd /app && npm run lint'",
      "bash -lc 'npm test'", "sh -c 'cd x && go test ./...'",
    ]) expect(isCheckCommand(command), command).toBe(true)
    for (const command of [
      "ssh haichao 'ls /data/runs/e1/'", "ssh host 'npm test | tail'", "ssh host 'npm test || true'", 'docker exec web ls /app',
      'docker run img npm test', "bash -lc 'npm test; echo done'",
    ]) expect(isCheckCommand(command), command).toBe(false)
  })
  test('heredoc bodies are not commands, except a body fed to a shell', () => {
    expect(isCheckCommand("git commit -m \"$(cat <<'EOF'\ndon't fail; npm test\nEOF\n)\"")).toBe(false)
    expect(isCheckCommand("cat <<'EOF' > a.txt\nnpm test\nEOF\nls")).toBe(false)
    expect(isCheckCommand("cat > a <<'EOF'\nnpm test\nEOF\nnpm test")).toBe(true)
    expect(isCheckCommand("bash <<'EOF'\nnpm test\nEOF")).toBe(true)
  })
  test('commands from real sessions: none is a check; the plain reruns are', () => {
    for (const command of SESSION_COMMANDS) expect(isCheckCommand(command), command.slice(0, 80)).toBe(false)
    expect(isCheckCommand("sed -i '' -e 's/a/b/' dates.js && npm test")).toBe(true)
    expect(isCheckCommand('cd /repo/docs/frontierharness; python3 -m pytest')).toBe(true)
    expect(isCheckCommand('cd /repo/agents/clause-fg/packages/runtime && npx tsc --noEmit -p . && npm test')).toBe(true)
  })
})
