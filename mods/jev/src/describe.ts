/** One-line renderings of Claude Code tool inputs/results, and which Bash commands are checks. */

import { hash20 } from './hash';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function describeToolInput(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  switch (tool) {
    case 'Bash': return clip(str('command').replace(/\s+/g, ' '), 160);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return str('file_path') || str('notebook_path');
    case 'Grep': return `"${clip(str('pattern'), 80)}"${str('path') ? ` in ${str('path')}` : ''}`;
    case 'Glob': return str('pattern');
    case 'WebFetch': return str('url');
    case 'WebSearch': return str('query');
    case 'Task': case 'Agent': return str('description') || clip(str('prompt'), 100);
    default: {
      const json = JSON.stringify(input ?? {});
      return clip(json === '{}' ? '' : json, 120);
    }
  }
}

export function stringifyResult(response: unknown): string {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) {
    return response.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : JSON.stringify(b))).join('\n');
  }
  const r = response as Record<string, unknown>;
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    return [r.stdout, r.stderr].filter((x) => typeof x === 'string' && x).join('\n');
  }
  return JSON.stringify(response);
}

// ── Checks ─────────────────────────────────────────────────────────────────
//
// A check is a Bash command whose program, after launcher prefixes, is a
// known test/build/lint/typecheck runner; its verdict is the exit code alone,
// never the output text. The exit code must be the check's own: a command
// with a pipe, `|| true` / `|| :`, a background `&`, or anything but `&&`
// after its last check is not judged.

/** A pipeline of simple commands; `captured` when its output is substituted (`$(…)`, backticks, `<(…)`). */
interface Pipeline {
  stages: string[];
  captured: boolean;
  /** what follows it: `&&`, `||`, `;` (a newline too), `&`, a group's parenthesis; empty at the end */
  seps: string[];
}

/**
 * Pipelines of a shell script, including those inside `$(…)`, backticks, and
 * process substitution, with comments and non-shell heredoc bodies removed
 * (a heredoc fed to a shell is kept: it runs). An approximation for
 * classification, not a shell parser: quoting is respected, and redirections
 * such as `2>&1` stay attached to their command.
 */
function parsePipelines(command: string): Pipeline[] {
  const src = stripHeredocs(command);
  const out: Pipeline[] = [];
  type Frame = { seg: string; stages: string[]; quote: '' | '"' | "'" | "$'"; close: '' | ')' | '`'; last: Pipeline | null };
  const stack: Frame[] = [{ seg: '', stages: [], quote: '', close: '', last: null }];
  const stage = (f: Frame) => { if (f.seg.trim()) f.stages.push(f.seg.trim()); f.seg = ''; };
  // A separator with no command before it (the `;` of `) ;`) follows the pipeline before it.
  const end = (f: Frame, sep: string) => {
    stage(f);
    if (f.stages.length) { f.last = { stages: f.stages, captured: f.close !== '', seps: sep ? [sep] : [] }; out.push(f.last); }
    else if (sep && f.last) f.last.seps.push(sep);
    f.stages = [];
  };
  const open = (close: ')' | '`') => stack.push({ seg: '', stages: [], quote: '', close, last: null });
  for (let i = 0; i < src.length; i++) {
    const f = stack[stack.length - 1]!;
    const c = src[i]!;
    if (f.quote === "'") { f.seg += c; if (c === "'") f.quote = ''; continue; }
    if (c === '\\') { f.seg += c + (src[i + 1] ?? ''); i++; continue; }
    if (f.quote === "$'") { f.seg += c; if (c === "'") f.quote = ''; continue; }
    if (c === '$' && src[i + 1] === "'" && !f.quote) { f.quote = "$'"; f.seg += "$'"; i++; continue; }
    if (c === '$' && src.startsWith('((', i + 1)) {
      const close = src.indexOf('))', i + 3);
      const stop = close < 0 ? src.length : close + 2;
      f.seg += src.slice(i, stop); i = stop - 1; continue;
    }
    if ((c === '$' || (!f.quote && (c === '<' || c === '>'))) && src[i + 1] === '(') { f.seg += '$()'; open(')'); i++; continue; }
    if (c === '`') {
      if (f.close === '`' && !f.quote) { end(f, ''); stack.pop(); continue; }
      f.seg += '``'; open('`'); continue;
    }
    if (f.quote === '"') { f.seg += c; if (c === '"') f.quote = ''; continue; }
    if (c === "'" || c === '"') { f.quote = c; f.seg += c; continue; }
    if (c === ')' && f.close === ')') { end(f, ''); stack.pop(); continue; }
    if (c === '#' && /(^|\s)$/.test(f.seg)) { while (i + 1 < src.length && src[i + 1] !== '\n') i++; continue; }
    // Redirections (`2>&1`, `&>file`, `>&2`) are part of the command, not separators.
    if (c === '&' && (/[<>]$/.test(f.seg) || src[i + 1] === '>')) { f.seg += c; continue; }
    if (c === '|' && src[i + 1] !== '|') { stage(f); if (src[i + 1] === '&') i++; continue; }
    if (c === '|' || c === '&') {
      const double = src[i + 1] === c;
      end(f, double ? c + c : c);
      if (double) i++;
      continue;
    }
    if (c === ';' || c === '\n') { end(f, ';'); continue; }
    if (c === '(' || c === ')') { end(f, c); continue; }
    f.seg += c;
  }
  while (stack.length) end(stack.pop()!, '');
  return out;
}

/** Simple commands of a shell script (see parsePipelines). */
export function shellSegments(command: string): string[] {
  return parsePipelines(command).flatMap((p) => p.stages);
}

/** A heredoc redirection (`<<EOF`, `<<-'EOF'`) at `[start, end)` of its line, with the body it reads. */
interface Heredoc {
  start: number;
  end: number;
  delimiter: string;
  /** `<<-`: leading tabs are stripped from body lines and the delimiter line */
  stripTabs: boolean;
  body: string[];
}

/** Shell quoting context: code (top level, `$(…)`, backticks), quotes, and arithmetic (`close` is `)` for `$((`). */
type QuoteFrame = { kind: 'code' | "'" | "$'" | '"' | 'arith'; close: '' | ')' | '`'; depth: number };

/**
 * Heredoc operators on one line of a script, outside quotes, comments,
 * here-strings (`<<<`), and arithmetic (`$((1<<2))`). `stack` is the quoting
 * context the line starts in and is left where the line ends, so a quote or
 * `$(…)` left open carries into the next line. `continues` when a quote stays
 * open or the line ends in a backslash: the command line, and so the point
 * where heredoc bodies begin, extends past this line.
 */
function heredocOperators(line: string, stack: QuoteFrame[]): { ops: Heredoc[]; continues: boolean } {
  const ops: Heredoc[] = [];
  let escapedNewline = false;
  for (let i = 0; i < line.length; i++) {
    const f = stack[stack.length - 1]!;
    const c = line[i]!;
    if (f.kind === "'") { if (c === "'") stack.pop(); continue; }
    if (f.kind === "$'") { if (c === '\\') i++; else if (c === "'") stack.pop(); continue; }
    if (c === '\\') { if (i === line.length - 1) escapedNewline = true; i++; continue; }
    if (c === '$' && line[i + 1] === '(') {
      if (line[i + 2] === '(') { stack.push({ kind: 'arith', close: ')', depth: 0 }); i += 2; }
      else { stack.push({ kind: 'code', close: ')', depth: 0 }); i++; }
      continue;
    }
    if (c === '`') {
      if (f.kind === 'code' && f.close === '`') stack.pop();
      else stack.push({ kind: 'code', close: '`', depth: 0 });
      continue;
    }
    if (f.kind === '"') { if (c === '"') stack.pop(); continue; }
    if (f.kind === 'arith') {
      if (c === '(') f.depth++;
      else if (c === ')' && f.depth) f.depth--;
      else if (c === ')' && line[i + 1] === ')') { stack.pop(); i++; }
      else if (c === ')') {
        // Not arithmetic after all: `((cd a) | x)` and `$((cd a) | x)` are nested subshells.
        stack.pop();
        if (f.close === ')') stack.push({ kind: 'code', close: ')', depth: 0 });
        else stack[stack.length - 1]!.depth++;
      }
      continue;
    }
    const wordStart = i === 0 || /[\s;&|()]/.test(line[i - 1]!);
    if (c === '$' && line[i + 1] === "'") { stack.push({ kind: "$'", close: '', depth: 0 }); i++; continue; }
    if (c === "'" || c === '"') { stack.push({ kind: c, close: '', depth: 0 }); continue; }
    if (c === '(' && line[i + 1] === '(' && wordStart) { stack.push({ kind: 'arith', close: '', depth: 0 }); i++; continue; }
    if (c === '(') { f.depth++; continue; }
    if (c === ')') { if (f.close === ')') { if (f.depth) f.depth--; else stack.pop(); } continue; }
    if (c === '#' && wordStart) break; // a comment: the rest of the line
    if (c !== '<' || line[i + 1] !== '<') continue;
    if (line[i + 2] === '<') { i += 2; continue; } // here-string
    let j = i + 2;
    const stripTabs = line[j] === '-';
    if (stripTabs) j++;
    while (line[j] === ' ' || line[j] === '\t') j++;
    let delimiter = '', any = false;
    for (; j < line.length && !/[\s;&|<>()]/.test(line[j]!); j++) {
      const d = line[j]!;
      any = true;
      if (d === "'" || d === '"') {
        const close = line.indexOf(d, j + 1);
        const stop = close < 0 ? line.length : close;
        delimiter += line.slice(j + 1, stop); j = stop;
      } else if (d === '\\') { delimiter += line[j + 1] ?? ''; j++; }
      else delimiter += d;
    }
    if (!any) { i++; continue; }
    // A file descriptor (`0<<EOF`) belongs to the operator.
    let start = i;
    while (start > 0 && /\d/.test(line[start - 1]!)) start--;
    if (start > 0 && !/[\s;&|()]/.test(line[start - 1]!)) start = i;
    ops.push({ start, end: j, delimiter, stripTabs, body: [] });
    i = j - 1;
  }
  const top = stack[stack.length - 1]!.kind;
  return { ops, continues: escapedNewline || top === "'" || top === "$'" || top === '"' };
}

/**
 * Lines of a script with each heredoc's body attached to the operator that
 * reads it. Bodies are removed from the lines; `unterminated` when a body
 * runs to the end of the script.
 */
function heredocLines(command: string): { lines: Array<{ text: string; heredocs: Heredoc[] }>; unterminated: boolean } {
  const src = command.split('\n');
  const lines: Array<{ text: string; heredocs: Heredoc[] }> = [];
  const stack: QuoteFrame[] = [{ kind: 'code', close: '', depth: 0 }];
  let pending: Heredoc[] = [];
  let unterminated = false;
  for (let n = 0; n < src.length; n++) {
    const { ops, continues } = heredocOperators(src[n]!, stack);
    lines.push({ text: src[n]!, heredocs: ops });
    pending.push(...ops);
    if (continues) continue;
    // Bodies follow the end of the command line, one after another.
    for (const h of pending) {
      let closed = false;
      while (++n < src.length) {
        const body = h.stripTabs ? src[n]!.replace(/^\t+/, '') : src[n]!;
        if (body === h.delimiter) { closed = true; break; }
        h.body.push(body);
      }
      if (!closed) unterminated = true;
    }
    pending = [];
  }
  return { lines, unterminated };
}

/**
 * Drop heredoc bodies (file contents, Python scripts…), except a body fed to
 * a shell, which runs: it is kept as a `{ … }` group so a pipeline after the
 * heredoc (`bash <<EOF | tail`) still reads the group's output.
 */
function stripHeredocs(command: string): string {
  const kept: string[] = [];
  for (const { text, heredocs } of heredocLines(command).lines) {
    // The line without its operators; the first heredoc fed to a shell splits it around the body.
    let line = '', from = 0;
    let shell: { head: string; body: string[] } | undefined;
    for (const h of heredocs) {
      line += text.slice(from, h.start);
      from = h.end;
      if (shell) { line += ' '; continue; }
      const start = line.search(/[^;&|(]*$/);
      const owner = words(line.slice(start)).filter((w) => !/^\d*[<>]/.test(w));
      const inv = shellInvocation(owner.slice(1));
      if (owner.length > 0 && SHELLS.has(base(owner[0]!)) && inv.command === undefined && inv.script === undefined) {
        shell = { head: `${line.slice(0, start)} {`, body: h.body };
        line = '';
      } else line += ' ';
    }
    line += text.slice(from);
    if (shell) kept.push(shell.head, stripHeredocs(shell.body.join('\n')), `} ${line}`);
    else kept.push(line);
  }
  return kept.join('\n');
}

/** The `-c` command string or script operand of a shell invocation (`bash -lc '…'`, `bash -euo pipefail -c '…'`). */
function shellInvocation(args: readonly string[]): { command?: string; script?: string } {
  let dashC = false;
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!;
    if (x === '--') { const op = args[i + 1]; return op === undefined ? {} : dashC ? { command: op } : { script: op }; }
    if (x === '--rcfile' || x === '--init-file') { i++; continue; }
    if (x.startsWith('--')) continue;
    if (/^[-+][A-Za-z]+$/.test(x)) {
      if (x[0] === '-' && x.includes('c')) dashC = true;
      if (/[oO]$/.test(x)) i++; // -o/-O take an option name
      continue;
    }
    return dashC ? { command: x } : { script: x };
  }
  return {};
}

/** Words of one simple command, with surrounding quotes removed. */
function words(segment: string): string[] {
  const out: string[] = [];
  let word = '', quote = '', any = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; any = true; continue; }
    if (c === '\\') { word += segment[i + 1] ?? ''; i++; any = true; continue; }
    if (/\s/.test(c)) { if (word || any) out.push(word); word = ''; any = false; continue; }
    word += c; any = true;
  }
  if (word || any) out.push(word);
  return out;
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'fi', 'done', 'esac', 'in', 'coproc']);
const WRAPPERS = new Set(['sudo', 'nohup', 'nice', 'command', 'builtin', 'exec', 'env', 'timeout', 'gtimeout', 'stdbuf', 'caffeinate', 'unbuffer', 'doas']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** Prefixes that run the program after them: `npx tsc`, `uv run pytest`, `bundle exec …`. */
const LAUNCHERS: ReadonlyArray<readonly string[]> = [
  ['npx'], ['bunx'], ['uv', 'run'], ['poetry', 'run'], ['pipenv', 'run'], ['pdm', 'run'], ['hatch', 'run'], ['rye', 'run'],
  ['pnpm', 'exec'], ['pnpm', 'dlx'], ['yarn', 'exec'], ['yarn', 'dlx'], ['bundle', 'exec'],
];
/** Launcher and package-manager options that take the next word as their value. */
const VALUE_OPTIONS = new Set(['-p', '--package', '-C', '--dir', '--prefix', '--cwd', '--filter', '-F', '--workspace', '-w', '--with', '--python', '--project']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** A script name that checks: one of these words whole, or before `:` (`test:unit`). */
const CHECK_SCRIPT = /^(?:test|build|lint|check|typecheck|verify|ci)(?::\S*)?$/;
const PYTHON = /^python(?:\d+(?:\.\d+)?)?$/;
/** ssh options that take the next word as their value. */
const SSH_VALUE_OPTIONS = /^-[BbcDEeFIiJLlmOoPpQRSWw]$/;
/** docker/podman exec options that take the next word as their value. */
const EXEC_VALUE_OPTIONS = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys']);
/** How deep `sh -c`, `ssh` and `docker exec` nest before a command is left unjudged. */
const MAX_DEPTH = 3;

function base(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** Index of the first word at or after `i` that is not an option (or an option's value). */
function skipOptions(w: readonly string[], i: number, takesValue: (option: string) => boolean): number {
  while (i < w.length && w[i]!.startsWith('-') && w[i] !== '--') i += takesValue(w[i]!) && !w[i]!.includes('=') ? 2 : 1;
  return w[i] === '--' ? i + 1 : i;
}

/** A word as a shell reads it back: quoted unless it holds only plain characters. */
const quote = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`);

/** The words of the program a simple command runs, keywords, assignments, redirections, wrappers and launchers set aside. */
function program(segment: string): string[] {
  let w = words(segment);
  while (w.length) {
    const h = w[0]!;
    if (KEYWORDS.has(h) || /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(h) || /^\d*[<>]/.test(h)) { w.shift(); continue; }
    if (WRAPPERS.has(h)) {
      w.shift();
      while (w.length && (w[0]!.startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/.test(w[0]!) || /^[A-Za-z_]\w*=/.test(w[0]!))) w.shift();
      continue;
    }
    const launcher = LAUNCHERS.find((l) => l.every((x, k) => w[k] === x));
    if (launcher) { w = w.slice(skipOptions(w, launcher.length, (x) => VALUE_OPTIONS.has(x))); continue; }
    break;
  }
  return w;
}

/** Whether one simple command runs a known runner, here or behind `sh -c`, `ssh` or `docker exec`. */
function runsCheck(segment: string, depth: number): boolean {
  const w = program(segment);
  if (!w.length) return false;
  const name = base(w[0]!);
  const sub = w[1];
  if (SHELLS.has(name) || name === 'ssh' || name === 'docker' || name === 'podman') {
    if (depth >= MAX_DEPTH) return false;
    if (SHELLS.has(name)) {
      const inv = shellInvocation(w.slice(1));
      return inv.command !== undefined && judged(inv.command, depth + 1);
    }
    if (name === 'ssh') {
      // ssh joins the words after the host with spaces; the remote shell parses the result.
      const host = skipOptions(w, 1, (x) => SSH_VALUE_OPTIONS.test(x));
      return host + 1 < w.length && judged(w.slice(host + 1).join(' '), depth + 1);
    }
    if (sub !== 'exec') return false;
    const container = skipOptions(w, 2, (x) => EXEC_VALUE_OPTIONS.has(x));
    return container + 1 < w.length && judged(w.slice(container + 1).map(quote).join(' '), depth + 1);
  }
  switch (name) {
    case 'cargo': return sub === 'test' || sub === 'build' || sub === 'clippy' || sub === 'check';
    case 'go': return sub === 'test' || sub === 'build' || sub === 'vet';
    case 'pytest': case 'tsc': case 'eslint': case 'ruff': case 'mypy': return true;
  }
  if (PYTHON.test(name)) return sub === '-m' && ['pytest', 'mypy', 'ruff'].includes(w[2] ?? '');
  if (!PACKAGE_MANAGERS.has(name)) return false;
  const i = skipOptions(w, 1, (x) => VALUE_OPTIONS.has(x));
  if (w[i] === 'test') return true;
  if (w[i] !== 'run' && w[i] !== 'run-script') return false;
  const script = w[skipOptions(w, i + 1, (x) => VALUE_OPTIONS.has(x))];
  return script !== undefined && CHECK_SCRIPT.test(script);
}

/** Whether a command is a check whose exit code is its own (see the section comment). */
function judged(command: string, depth: number): boolean {
  if (/\|\|\s*(?:true|:)(?=[\s;&|)]|$)/.test(command)) return false;
  const pipelines = parsePipelines(command);
  if (pipelines.some((p) => p.stages.length > 1)) return false;
  const top = pipelines.filter((p) => !p.captured);
  let last = -1;
  top.forEach((p, i) => { if (runsCheck(p.stages[0]!, depth)) last = i; });
  if (last < 0) return false;
  // Pipelines of keywords alone (`}`, `fi`, `done`) run nothing that sets an exit code.
  const runs = top.map((p) => program(p.stages[0]!).length > 0);
  for (let k = last; k < top.length; k++) {
    const seps = top[k]!.seps;
    if (seps.includes('&') || seps.includes('||')) return false;
    // Before a later command only `&&` (and group parentheses) keep the check's failure as the exit code.
    if (runs.slice(k + 1).some(Boolean) && !seps.every((s) => s === '&&' || s === '(' || s === ')')) return false;
  }
  return true;
}

/**
 * The identity of a Bash command that is a check: a hash of the full command,
 * whitespace normalized, so a later run of the same command is the same
 * check. Null when the command is not a check, or its exit code is not the
 * check's.
 */
export function checkId(command: string): string | null {
  return judged(command, 0) ? hash20(command.replace(/\s+/g, ' ').trim()) : null;
}
