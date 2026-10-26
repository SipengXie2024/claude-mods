import assert, { test } from './assert';
import { checkId, describeToolInput, shellSegments } from '../src/describe';
import { dateDebugCommands } from './fixtures';

const isCheck = (command: string) => checkId(command) !== null;

test('describeToolInput renders the useful part of each tool input', () => {
  assert.equal(describeToolInput('Bash', { command: 'npm   test' }), 'npm test');
  assert.equal(describeToolInput('Edit', { file_path: 'src/a.ts', old_string: 'x' }), 'src/a.ts');
  assert.equal(describeToolInput('Grep', { pattern: 'TODO', path: 'src' }), '"TODO" in src');
});

test('decision 4: the known runners are checks, after env, wrappers and launcher prefixes', () => {
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
  ]) assert.ok(isCheck(command), command);
});

test('decision 4 (B7): a script name counts only as a whole word or before `:`; one-off scripts are no checks', () => {
  for (const command of [
    'bun run scripts/precision.ts', 'bun scripts/decide.ts', 'bun run src/circuit.ts', 'bun run scripts/recall.ts', 'python3 scripts/precision.py',
    'npm run testing', 'npm run build-docs', 'npm run pretest', 'npm ci', 'npm install', 'yarn build', 'node --test', 'make test', 'jest',
    'python3 scripts/run_tests.py', './scripts/test.sh', 'cargo run', 'go run .', 'python -c "import pytest"',
  ]) assert.ok(!isCheck(command), command);
});

test('decision 4: a pipe, `|| true` / `|| :`, a background `&`, or anything but `&&` after the check leaves it unjudged', () => {
  for (const command of [
    'npm test | tail -30', 'npm test 2>&1 | grep -E "^# "', 'pytest |& tee log', 'npm test || true', 'npm test || :', 'cargo test || echo failed',
    'npm test; echo done', 'pytest; echo "exit=$?"', 'npm test &', 'ls | head; npm test', 'rm -f x || true; npm test',
    '(cd repo && npm test) || true', '(cd repo && npm test); echo', 'npm test\necho done',
  ]) assert.ok(!isCheck(command), command);
  // a pipe or a check text inside quotes is neither
  assert.ok(isCheck('npm test -- --grep "a | b"'));
  assert.ok(!isCheck('echo "npm test"'));
});

test('decision 4 (B8): the remote command of ssh, docker exec and sh -c is judged the same way', () => {
  for (const command of [
    "ssh haichao 'cd /srv/app && cargo test'", 'ssh -p 2222 -i ~/.ssh/k user@host pytest -q', "ssh host 'npm test'",
    'docker exec web npm test', 'docker exec -it -w /app web pytest', "docker exec web bash -lc 'cd /app && npm run lint'",
    "bash -lc 'npm test'", "sh -c 'cd x && go test ./...'",
  ]) assert.ok(isCheck(command), command);
  for (const command of [
    "ssh haichao 'ls /data/runs/e1/'", "ssh host 'npm test | tail'", "ssh host 'npm test || true'", 'docker exec web ls /app',
    'docker run img npm test', "bash -lc 'npm test; echo done'",
  ]) assert.ok(!isCheck(command), command);
});

test('decision 4: identity is the full command, whitespace normalized, never the 160-char summary', () => {
  assert.equal(checkId('npm   test'), checkId('npm test'));
  assert.notEqual(checkId('npm test'), checkId('npm test -- --grep a'));
  assert.notEqual(checkId('cd a && npm test'), checkId('cd b && npm test'));
  const long = (tail: string) => `cd /repo/${'deep/'.repeat(40)}pkg && npm test -- ${tail}`;
  assert.ok(describeToolInput('Bash', { command: long('a') }) === describeToolInput('Bash', { command: long('b') }), 'the summaries clip to the same text');
  assert.notEqual(checkId(long('a')), checkId(long('b')));
  assert.match(checkId('npm test')!, /^[0-9a-f]{20}$/);
});

test('heredoc operators inside quotes, comments, and arithmetic are text, not heredocs', async () => {
  for (const head of [
    "printf '%s\\n' 'cat <<EOF'",
    'echo "run <<EOF first"',
    "echo $'it\\'s <<EOF'",
    'echo hi # see <<EOF',
    'echo $((1<<3))',
    '(( x = 1 << 3 ))',
    'cat <<<"x"',
    'echo "<<EOF"',
    "printf '<<EOF\\n'",
    'echo "a\n<<EOF\nb"',
  ]) {
    const command = `${head}\nnpm test 2>&1`;
    assert.ok(shellSegments(command).includes('npm test 2>&1'), command);
    assert.ok(isCheck(command), command);
  }
  // Real heredocs still drop their bodies: in `$(…)` inside quotes, several per line, `<<-`.
  assert.deepEqual(shellSegments("git commit -m \"$(cat <<'EOF'\nfix: npm test; pytest\nEOF\n)\" && git log -1"), ['cat', 'git commit -m "$()"', 'git log -1']);
  assert.ok(!isCheck("git commit -m \"$(cat <<'EOF'\ndon't fail; npm test\nEOF\n)\""));
  assert.ok(!isCheck("cat <<'EOF' > a.txt\nnpm test\nEOF\nls"));
  assert.ok(isCheck("cat > a <<'EOF'\nnpm test\nEOF\nnpm test"));
  assert.ok(isCheck("bash <<'EOF'\nnpm test\nEOF"), 'a heredoc fed to a shell runs');
  assert.deepEqual(shellSegments('cat <<A <<B\nnpm test\nA\npytest\nB\nls'), ['cat', 'ls']);
  assert.deepEqual(shellSegments('cat <<-EOF\n\tpytest\n\tEOF\nls'), ['cat', 'ls']);
  // A body ends only at its exact delimiter line.
  assert.deepEqual(shellSegments('cat <<EOF\n  EOF\npytest\nEOF\nls'), ['cat', 'ls']);
});

test('a real session\'s grep-filtered test runs are not judged; the plain rerun is', () => {
  for (const command of dateDebugCommands) assert.ok(!isCheck(command), command.slice(0, 60));
  assert.ok(isCheck("sed -i '' -e 's/a/b/' dates.js && npm test"));
});
