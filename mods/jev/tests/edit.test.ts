import assert, { test } from './assert';
import { checkId, editPlan, editTargets, resolvePath } from '../src/describe';
import { dateDebugCommands } from './fixtures';

/** What a successful command run in /repo (the project root) leaves to count. */
const plan = (command: string) => editPlan(editTargets(command), '/repo', ['/repo']);
const files = (...paths: string[]) => ({ files: paths, unchecked: false });
const UNCHECKED = { files: [], unchecked: true };

test('sed -i and perl -i edit the files after their script', () => {
  for (const [command, expected] of [
    ["sed -i 's/return a - b;/return a * b;/' add.js", files('/repo/add.js')],
    ["sed -i'' 's/a/b/' add.js", files('/repo/add.js')],
    ["sed -i.bak -e 's/a/b/' src/add.js", files('/repo/src/add.js')],
    ["sed -Ei 's/(a)/b/' add.js", files('/repo/add.js')],
    ["sed --in-place 's/a/b/' add.js", files('/repo/add.js')],
    ["sed --in-place=.orig 's/a/b/' add.js", files('/repo/add.js')],
    ["sed -i '' -e 's/a/b/' dates.js", files('/repo/dates.js')],
    ["sed -e 's/a/b/' -i a.js b.js", files('/repo/a.js', '/repo/b.js')],
    ["perl -pi -e 's/a/b/' add.js", files('/repo/add.js')],
    ["perl -i -pe 's/a/b/' add.js", files('/repo/add.js')],
    ["perl -i.bak -pe 's/a/b/' add.js", files('/repo/add.js')],
    ["perl -0777 -pi -e 's/a/b/s' add.js", files('/repo/add.js')],
    ["perl -lpi -e 's/a/b/' add.js", files('/repo/add.js')],
  ] as const) assert.deepEqual(plan(command), expected, command);
});

test('an output redirection or tee into a file is an edit, a heredoc into a file too', () => {
  for (const [command, expected] of [
    ['echo x > notes.txt', files('/repo/notes.txt')],
    ['printf x >> /repo/log.txt', files('/repo/log.txt')],
    ['echo x >| a.txt', files('/repo/a.txt')],
    ['echo x>a.txt', files('/repo/a.txt')],
    ['make &> out.txt', files('/repo/out.txt')],
    ['make 2> err.txt', files('/repo/err.txt')],
    ['echo x > "out file.txt"', files('/repo/out file.txt')],
    ['echo x | tee a.txt', files('/repo/a.txt')],
    ['tee -a a.txt b.txt < in.txt', files('/repo/a.txt', '/repo/b.txt')],
    ['echo 1 | sudo tee /etc/hosts', files('/etc/hosts')],
    ["cat <<'EOF' > src/gen.ts\nexport const a = 1;\nEOF", files('/repo/src/gen.ts')],
    ['cat > src/gen.ts <<EOF\nx\nEOF', files('/repo/src/gen.ts')],
    ['cat <<-EOF >> a.txt\n\tx\n\tEOF', files('/repo/a.txt')],
    ['echo x > "$OUT"', UNCHECKED],
  ] as const) assert.deepEqual(plan(command), expected, command);
});

test('patch, git apply/am, git checkout -- <path> and git restore are edits', () => {
  for (const [command, expected] of [
    ['patch -p1 < fix.diff', UNCHECKED],
    ['git apply fix.diff', UNCHECKED],
    ["git apply <<'EOF'\ndiff --git a/add.js b/add.js\nEOF", UNCHECKED],
    ['git am 0001-fix.patch', UNCHECKED],
    ['git checkout -- add.js', files('/repo/add.js')],
    ['git checkout HEAD~1 -- src/a.ts src/b.ts', files('/repo/src/a.ts', '/repo/src/b.ts')],
    ['git -C sub checkout main -- a.js', files('/repo/sub/a.js')],
    ['git checkout -- .', files('/repo')],
    ['git restore add.js', files('/repo/add.js')],
    ['git restore --source=HEAD~1 -- add.js', files('/repo/add.js')],
    ['git restore -s HEAD add.js', files('/repo/add.js')],
    ['git restore --staged --worktree add.js', files('/repo/add.js')],
  ] as const) assert.deepEqual(plan(command), expected, command);
});

test('cp, mv and install into the work tree are edits; mv and cp -p keep the old time, so no stat can tell', () => {
  for (const [command, expected] of [
    ['cp /tmp/add.js add.js', files('/repo/add.js')],
    ['cp -r fixtures/ /repo/tests/', files('/repo/tests')],
    ['install -m 644 a.conf /repo/etc/', files('/repo/etc')],
    ['cp -t src a.js b.js', files('/repo/src')],
    ['mv old.js new.js', UNCHECKED],
    ['cp -p a.js b.js', UNCHECKED],
    ['cp -a a.js b.js', UNCHECKED],
  ] as const) assert.deepEqual(plan(command), expected, command);
  // the work tree is the project root or the directory the command ran in
  assert.deepEqual(editPlan(editTargets('cp a.js b.js'), '/elsewhere/x', ['/repo', '/elsewhere/x']), files('/elsewhere/x/b.js'));
});

test('a cd moves relative paths; remote, sh -c, xargs and find -exec edits are found', () => {
  for (const [command, expected] of [
    ["cd /repo/pkg && sed -i 's/a/b/' x.js", files('/repo/pkg/x.js')],
    ["cd pkg; sed -i 's/a/b/' x.js", files('/repo/pkg/x.js')],
    ["cd ../other && sed -i 's/a/b/' x.js", files('/other/x.js')],
    ['cd "$D" && sed -i s/a/b/ x.js', UNCHECKED],
    [`ssh box "sed -i 's/a/b/' /srv/a.js"`, UNCHECKED],
    ["ssh box 'cd /srv && cat > a.txt <<EOF\nx\nEOF'", UNCHECKED],
    ["docker exec web sh -c 'echo x > /app/a.txt'", UNCHECKED],
    ["ssh box 'cp /tmp/a /srv/a'", UNCHECKED],
    [`bash -lc "sed -i 's/a/b/' a.js"`, files('/repo/a.js')],
    ["find . -name '*.js' -exec sed -i 's/a/b/' {} +", UNCHECKED],
    ["grep -rl foo src | xargs sed -i 's/foo/bar/'", UNCHECKED],
    ['ls *.js | xargs -I{} cp {} src/', files('/repo/src')],
    ["sed -i 's/a/b/' a.js && npm test", files('/repo/a.js')],
    ["sed -i 's/x/y/' old.js && git mv old.js new.js", files('/repo/old.js')],
  ] as const) assert.deepEqual(plan(command), expected, command);
  // a command can be a check and an edit at once
  assert.ok(checkId("sed -i 's/a/b/' a.js && npm test") !== null);
});

test('no edit: sed or perl without -i, devices, fd duplications, plain output, inline interpreter scripts', () => {
  for (const command of [
    "sed 's/a/b/' a.js", "sed -n '1,20p' a.js", "sed -e 's/i/j/' a.js", "sed -i 's/a/b/'", "perl -pe 's/a/b/' a.js", "perl -e 'print 1'",
    'echo hi > /dev/null', 'make 2>&1', 'echo x >&2', 'ls 2>/dev/null', 'make &>/dev/null', 'echo hi | tee /dev/stderr', 'echo x | tee',
    'echo hi', 'cat a.js', 'ls -la', 'echo "a > b"', "grep '>' a.js", 'echo $((1 > 0))', '(( n > 0 )) && echo ok', '[[ a > b ]] && echo ok',
    'for ((i=0; i>3; i++)); do echo $i; done', 'while (( n > 0 )); do n=$((n-1)); done',
    "python - <<'EOF'\nopen('add.py', 'w').write('x')\nEOF", `python3 -c "open('a', 'w').write('x')"`, `node -e "require('fs').writeFileSync('a', 'x')"`,
  ]) assert.equal(plan(command), null, command);
});

test('no edit: a check writing its output, patch or git that only reads, cp/mv/install outside the work tree', () => {
  for (const command of [
    'npm test > out.log 2>&1', 'npm test 2>&1 | tee test.log', 'npm test >| out.log', 'cargo build > build.log', 'pytest -q | tee log.txt',
    "ssh box 'npm test > log'", 'tsc --noEmit > tsc.txt; echo done',
    'patch --dry-run -p1 < fix.diff', 'git apply --check fix.diff', 'git apply --stat fix.diff', 'git apply --cached fix.diff',
    'git am --show-current-patch', 'git checkout main', 'git checkout -b feat', 'git restore --staged add.js', 'git status', 'git diff > /dev/null',
    'cp a.js /tmp/a.js', 'mv build.log /tmp/', 'install -d /repo/out', 'cd /tmp && cp /repo/a.js b.js',
  ]) assert.equal(plan(command), null, command);
});

test('a real session\'s heredoc writes and its BSD sed -i are edits', () => {
  assert.deepEqual(plan(dateDebugCommands[0]!), files('/repo/package.json', '/repo/dates.js', '/repo/dates.test.js'));
  assert.deepEqual(plan(dateDebugCommands[1]!), files('/repo/dates.js'));
});

test('resolvePath folds . and .. against the directory', () => {
  assert.equal(resolvePath('/repo', 'pkg/../a.js'), '/repo/a.js');
  assert.equal(resolvePath('/repo', './a.js'), '/repo/a.js');
  assert.equal(resolvePath('/repo', '/etc/x'), '/etc/x');
  assert.equal(resolvePath('/repo', '../../..'), '/');
});
