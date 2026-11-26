import * as vm from 'node:vm'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { inspect } from 'node:util'
import * as acorn from 'acorn'

const [sockPath, authToken, parentPidArg] = process.argv.slice(2)
if (!sockPath || !authToken) {
  console.error('usage: bun worker.mjs <socketPath> <authToken> [parentPid]')
  process.exit(2)
}

const parentPid = parentPidArg ? Number(parentPidArg) : 0
const OUTPUT_CHAR_CAP = 30_000
const CONSOLE_RING_MAX = 1000
const IDLE_SHUTDOWN_MS = 4 * 60 * 60 * 1000
const SLICE_WAIT_MS = 10_000

const BUILTIN_TOOL_NAMES = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Skill',
  'WebFetch',
])

const NON_ERROR_EXIT1_CMD_RE = /(?:^|[|;&\n])\s*(?:env\s+(?:\w+=\S+\s+)*)?(?:grep|rg|egrep|fgrep|find|diff|test|\[|git\s+(?:diff|grep))\b/

function posixQuote(s) {
  return "'" + String(s).replaceAll("'", "'\\''") + "'"
}

function truncateMiddle(text, cap = OUTPUT_CHAR_CAP) {
  if (typeof text !== 'string' || text.length <= cap) return text
  const half = Math.floor((cap - 80) / 2)
  const dropped = text.length - half * 2
  return `${text.slice(0, half)}\n… [${dropped.toLocaleString('en-US')} chars omitted] …\n${text.slice(-half)}`
}

function formatValue(val) {
  if (typeof val === 'string') return truncateMiddle(val)
  if (val === undefined) return 'undefined'
  if (val === null || typeof val === 'number' || typeof val === 'boolean') return String(val)
  try {
    return truncateMiddle(
      inspect(val, {
        depth: 6,
        maxArrayLength: 100,
        maxStringLength: 10_000,
        breakLength: 100,
        colors: false,
      }),
    )
  } catch {
    return truncateMiddle(String(val))
  }
}

function isPlainObject(v, vmObjectProto) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === null || proto === Object.prototype || (vmObjectProto !== undefined && proto === vmObjectProto)
}

function isThenable(v) {
  return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function'
}

// Collect bound identifier names from any JS binding pattern, optionally rewriting
// leaf identifiers to unique temp names so destructuring never shadows globals.
function rewritePattern(node, source, tempCounter, bindings) {
  switch (node.type) {
    case 'Identifier': {
      const tmp = `__cm_b${tempCounter.n++}`
      bindings.push([node.name, tmp])
      return tmp
    }
    case 'AssignmentPattern': {
      const left = rewritePattern(node.left, source, tempCounter, bindings)
      const right = source.slice(node.right.start, node.right.end)
      return `${left} = ${right}`
    }
    case 'RestElement': {
      return `...${rewritePattern(node.argument, source, tempCounter, bindings)}`
    }
    case 'ArrayPattern': {
      const parts = node.elements.map(el => (el ? rewritePattern(el, source, tempCounter, bindings) : ''))
      return `[${parts.join(', ')}]`
    }
    case 'ObjectPattern': {
      const parts = node.properties.map(prop => {
        if (prop.type === 'RestElement') {
          return `...${rewritePattern(prop.argument, source, tempCounter, bindings)}`
        }
        const keySrc = source.slice(prop.key.start, prop.key.end)
        const keyOut = prop.computed ? `[${keySrc}]` : keySrc
        const valOut = rewritePattern(prop.value, source, tempCounter, bindings)
        return `${keyOut}: ${valOut}`
      })
      return `{ ${parts.join(', ')} }`
    }
    default:
      return source.slice(node.start, node.end)
  }
}

/**
 * Transform user script into an async IIFE body that:
 * - Persists top-level const/let/var/function/class declarations onto globalThis
 *   (without creating shadowed local variables that would desync closures across calls)
 * - Hoists top-level function declarations
 * - Returns the value of the final ExpressionStatement (unless an explicit return is used)
 */
export function transformScript(code) {
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
  })

  const tempCounter = { n: 0 }
  const hoisted = []
  const bodyParts = []
  const stmts = ast.body

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]
    const isLast = i === stmts.length - 1
    const raw = code.slice(stmt.start, stmt.end)

    if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      const name = stmt.id.name
      hoisted.push(`globalThis[${JSON.stringify(name)}] = (${raw});`)
      continue
    }

    if (stmt.type === 'ClassDeclaration' && stmt.id) {
      const name = stmt.id.name
      bodyParts.push(`globalThis[${JSON.stringify(name)}] = (${raw});`)
      continue
    }

    if (stmt.type === 'VariableDeclaration') {
      const pieces = []
      for (const decl of stmt.declarations) {
        if (decl.id.type === 'Identifier') {
          const name = decl.id.name
          if (decl.init) {
            const initSrc = code.slice(decl.init.start, decl.init.end)
            pieces.push(`globalThis[${JSON.stringify(name)}] = (${initSrc});`)
          } else {
            pieces.push(`if (!(${JSON.stringify(name)} in globalThis)) globalThis[${JSON.stringify(name)}] = undefined;`)
          }
        } else {
          const bindings = []
          const patSrc = rewritePattern(decl.id, code, tempCounter, bindings)
          const initSrc = decl.init ? code.slice(decl.init.start, decl.init.end) : 'undefined'
          const assigns = bindings.map(([orig, tmp]) => `globalThis[${JSON.stringify(orig)}] = ${tmp};`).join(' ')
          pieces.push(`{ const ${patSrc} = (${initSrc}); ${assigns} }`)
        }
      }
      bodyParts.push(pieces.join('\n'))
      continue
    }

    if (isLast && stmt.type === 'ExpressionStatement') {
      const exprSrc = code.slice(stmt.expression.start, stmt.expression.end)
      bodyParts.push(`return (${exprSrc});`)
      continue
    }

    bodyParts.push(raw)
  }

  return [
    '(async () => {',
    ...hoisted,
    ...bodyParts,
    '})()',
  ].join('\n')
}

function makeConsoleRing() {
  const lines = []
  let dropped = 0
  const push = (level, args) => {
    const text = args.map(a => (typeof a === 'string' ? a : formatValue(a))).join(' ')
    const entry = level === 'log' ? text : `[${level}] ${text}`
    for (const l of entry.split('\n')) {
      if (lines.length >= CONSOLE_RING_MAX) {
        lines.shift()
        dropped += 1
      }
      lines.push(l)
    }
  }
  return {
    log: (...a) => push('log', a),
    info: (...a) => push('info', a),
    debug: (...a) => push('debug', a),
    warn: (...a) => push('warn', a),
    error: (...a) => push('error', a),
    tail: (n = 20) => lines.slice(-Math.max(0, Number(n) || 0)).join('\n'),
    buffer: () => lines.join('\n'),
    dropped: () => dropped,
  }
}

function parseBashExitCode(text) {
  if (typeof text !== 'string') return 1
  const m = /(?:^|\n)Exit code\s+(-?\d+)/i.exec(text)
  return m ? Number(m[1]) : 1
}

function stripExitCodeLine(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/(?:^|\n)Exit code\s+-?\d+\s*/i, '').trimStart()
}

function makeShellError(out) {
  const err = new Error(
    out.error
      ? out.error
      : `Command failed with exit code ${out.exitCode}: ${(out.stderr || out.stdout || '').slice(0, 400)}`,
  )
  err.name = 'ShellError'
  err.stdout = out.stdout
  err.stderr = out.stderr
  err.exitCode = out.exitCode
  err.output = out.output
  err.truncated = out.truncated
  return err
}

function createLoopContext(loopId) {
  const consoleRing = makeConsoleRing()
  let activeExec = null
  let currentCwd = process.cwd()
  let knownToolNames = new Set()

  const requestHost = (kind, payload) => {
    const exec = activeExec
    if (!exec || exec.cancelled) {
      return Promise.reject(new Error('REPL script has already finished; await all operations before returning.'))
    }
    const id = ++exec.nextCallId
    return new Promise((resolve, reject) => {
      exec.resolvers.set(id, { resolve, reject })
      exec.pendingCalls.push({ id, kind, ...payload })
      exec.notify?.()
    })
  }

  const resolveFilePath = (p) => {
    const s = String(p)
    return path.isAbsolute(s) ? s : path.resolve(currentCwd, s)
  }

  const invokeTool = async (toolName, input = {}) => {
    const res = await requestHost('tool', { tool: toolName, input })
    if (res.deny) {
      throw new Error(`${toolName} denied: ${res.deny}`)
    }
    if (res.isError) {
      if (toolName.startsWith('mcp__')) {
        throw new Error(res.text || `${toolName} failed`)
      }
      return { error: res.text || `${toolName} failed`, ...(res.result && typeof res.result === 'object' ? res.result : {}) }
    }
    if (toolName.startsWith('mcp__')) {
      if (typeof res.text === 'string') {
        try {
          return JSON.parse(res.text)
        } catch {
          return res.text
        }
      }
      return res.result ?? res.text ?? null
    }
    if (res.result !== undefined) return res.result
    return res.text !== undefined ? { text: res.text } : {}
  }

  const readWholeFile = async (filePath) => {
    const abs = resolveFilePath(filePath)
    let offset = 1
    const chunks = []
    let totalBytes = 0
    const MAX_BYTES = 16 * 1024 * 1024
    while (totalBytes < MAX_BYTES) {
      const res = await requestHost('tool', {
        tool: 'Read',
        input: { file_path: abs, offset, limit: 2000 },
      })
      if (res.deny) throw new Error(`Read denied: ${res.deny}`)
      if (res.isError) throw new Error(res.text || `Failed to read ${filePath}`)
      const fileObj = res.result && typeof res.result === 'object' ? res.result.file : undefined
      if (fileObj && typeof fileObj.content === 'string') {
        chunks.push(fileObj.content)
        totalBytes += fileObj.content.length
        const startLine = typeof fileObj.startLine === 'number' ? fileObj.startLine : offset
        const numLines = typeof fileObj.numLines === 'number' ? fileObj.numLines : 0
        const totalLines = typeof fileObj.totalLines === 'number' ? fileObj.totalLines : startLine + numLines - 1
        if (numLines <= 0 || startLine + numLines - 1 >= totalLines) break
        offset = startLine + numLines
      } else {
        chunks.push(typeof res.text === 'string' ? res.text : '')
        break
      }
    }
    return chunks.join('\n')
  }

  const readSliceFile = async (filePath, offset, limit) => {
    const abs = resolveFilePath(filePath)
    const input = { file_path: abs }
    if (offset !== undefined) input.offset = Number(offset)
    if (limit !== undefined) input.limit = Number(limit)
    const res = await requestHost('tool', { tool: 'Read', input })
    if (res.deny) throw new Error(`Read denied: ${res.deny}`)
    if (res.isError) throw new Error(res.text || `Failed to read ${filePath}`)
    const fileObj = res.result && typeof res.result === 'object' ? res.result.file : undefined
    if (fileObj && typeof fileObj.content === 'string') return fileObj.content
    return typeof res.text === 'string' ? res.text : ''
  }

  const runShell = (cmd, opts) => {
    const cfg = {
      cmd,
      throws: true,
      quiet: false,
      timeoutMs: opts?.timeoutMs,
      cwd: undefined,
      env: undefined,
    }

    let startedPromise = null
    const start = () => {
      if (startedPromise) return startedPromise
      startedPromise = (async () => {
        let fullCmd = cfg.cmd
        const envParts = []
        if (cfg.env && typeof cfg.env === 'object') {
          for (const [k, v] of Object.entries(cfg.env)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
              throw new Error(`$ env: invalid variable name ${JSON.stringify(k)}`)
            }
            envParts.push(`${k}=${posixQuote(v)}`)
          }
        }
        const envPrefix = envParts.length > 0 ? `${envParts.join(' ')} ` : ''
        if (cfg.cwd) {
          const targetDir = resolveFilePath(cfg.cwd)
          fullCmd = `( cd ${posixQuote(targetDir)} && ${envPrefix}${fullCmd} )`
        } else if (envPrefix) {
          fullCmd = `${envPrefix}${fullCmd}`
        }

        const input = { command: fullCmd }
        if (typeof cfg.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0) {
          input.timeout = Math.min(600_000, Math.floor(cfg.timeoutMs))
        }

        const res = await requestHost('tool', { tool: 'Bash', input })
        if (res.deny) {
          const out = {
            stdout: '',
            stderr: res.deny,
            exitCode: 1,
            output: `[error] ${res.deny}`,
            truncated: false,
            error: res.deny,
            text: () => '',
            lines: () => [''],
            json: () => { throw new Error(res.deny) },
          }
          if (cfg.throws) throw makeShellError(out)
          return out
        }

        const r = res.result && typeof res.result === 'object' ? res.result : {}
        let stdout = typeof r.stdout === 'string' ? r.stdout : ''
        let stderr = typeof r.stderr === 'string' ? r.stderr : ''
        let exitCode = 0
        let note
        let error

        if (res.isError) {
          exitCode = parseBashExitCode(res.text)
          if (!stdout && !stderr && typeof res.text === 'string') {
            stdout = stripExitCodeLine(res.text)
          }
          if (exitCode === 1 && NON_ERROR_EXIT1_CMD_RE.test(cfg.cmd)) {
            note = 'exit 1 treated as normal command outcome'
          } else {
            error = res.text || `Command failed with exit code ${exitCode}`
          }
        }

        const merged = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout
        const out = {
          stdout,
          stderr,
          exitCode,
          output: merged,
          truncated: Boolean(r.rawOutputPath),
          whole: !r.rawOutputPath,
          ...(r.rawOutputPath ? { file: r.rawOutputPath } : {}),
          ...(r.backgroundTaskId ? { running: { taskId: r.backgroundTaskId, outputPath: r.backgroundOutputPath || '' } } : {}),
          ...(note ? { note } : {}),
          ...(error ? { error } : {}),
          text() { return stdout },
          lines() { return stdout.split('\n') },
          json() { return JSON.parse(stdout) },
        }

        if (exitCode !== 0 && !note && cfg.throws) {
          throw makeShellError(out)
        }
        return out
      })()
      return startedPromise
    }

    // Queue start on next microtask so synchronous method chaining (.nothrow().cwd(...)) applies first.
    queueMicrotask(() => { void start() })

    const shellPromise = {
      then(onFulfilled, onRejected) {
        return start().then(onFulfilled, onRejected)
      },
      catch(onRejected) {
        return start().catch(onRejected)
      },
      finally(onFinally) {
        return start().finally(onFinally)
      },
      nothrow() { cfg.throws = false; return shellPromise },
      throws(on) { cfg.throws = Boolean(on); return shellPromise },
      quiet() { cfg.quiet = true; return shellPromise },
      timeout(ms) { cfg.timeoutMs = Number(ms); return shellPromise },
      cwd(dir) { cfg.cwd = String(dir); return shellPromise },
      env(vars) { cfg.env = { ...(cfg.env || {}), ...vars }; return shellPromise },
      text() { return start().then(o => o.stdout) },
      lines() { return start().then(o => o.stdout.split('\n')) },
      json() { return start().then(o => JSON.parse(o.stdout)) },
    }
    return shellPromise
  }

  function $(first, ...values) {
    if (Array.isArray(first) && Array.isArray(first.raw)) {
      let cmd = ''
      for (let i = 0; i < first.length; i++) {
        cmd += first[i]
        if (i < values.length) {
          const v = values[i]
          if (v !== null && typeof v === 'object' && typeof v.raw === 'string') {
            cmd += v.raw
          } else if (Array.isArray(v)) {
            cmd += v.map(item => posixQuote(item)).join(' ')
          } else {
            cmd += posixQuote(v)
          }
        }
      }
      return runShell(cmd)
    }
    const timeoutMs = typeof values[0] === 'number' ? values[0] : undefined
    return runShell(String(first), { timeoutMs })
  }
  $.escape = posixQuote
  $.ShellError = function ShellError(out) { return makeShellError(out) }

  function file(filePath) {
    const p = String(filePath)
    return Object.freeze({
      name: p,
      text: () => readWholeFile(p),
      json: async () => JSON.parse(await readWholeFile(p)),
      lines: async () => (await readWholeFile(p)).split('\n'),
      exists: async () => {
        const res = await requestHost('fs_exists', { path: resolveFilePath(p) })
        return Boolean(res.exists)
      },
      slice: (offset, limit) => readSliceFile(p, offset, limit),
    })
  }

  const countMatches = (hay, needle) => {
    if (!needle) return 0
    let n = 0
    let at = hay.indexOf(needle)
    while (at !== -1) {
      n += 1
      at = hay.indexOf(needle, at + needle.length)
    }
    return n
  }

  async function edit(filePath, a, b, c) {
    const abs = resolveFilePath(filePath)
    const fail = (soft, message, replacements = 0) => {
      if (soft) return { ok: false, replacements, error: message }
      throw new Error(message)
    }
    if (Array.isArray(a)) {
      const opts = b && typeof b === 'object' ? b : {}
      const all = opts.all === true
      const soft = opts.soft === true
      let text
      try {
        text = await readWholeFile(abs)
      } catch (err) {
        return fail(soft, `edit: ${filePath}: ${err.message}`)
      }
      const pairs = []
      for (let i = 0; i < a.length; i++) {
        const pair = a[i]
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
          return fail(soft, `edit ${i + 1}: must be [oldString, newString]`)
        }
        const [oldStr, newStr] = pair
        if (oldStr.length === 0) return fail(soft, `edit ${i + 1}: old text is empty; file untouched`)
        if (oldStr === newStr) {
          pairs.push([oldStr, newStr, 0])
          continue
        }
        const m = countMatches(text, oldStr)
        if (m === 0) return fail(soft, `edit ${i + 1}: text not found in ${filePath}; file untouched`)
        if (m > 1 && !all) return fail(soft, `edit ${i + 1}: found ${m} matches in ${filePath}; pass {all: true} or more context`)
        text = all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr)
        pairs.push([oldStr, newStr, m])
      }
      let total = 0
      for (let i = 0; i < pairs.length; i++) {
        const [oldStr, newStr, m] = pairs[i]
        if (m === 0) continue
        const res = await requestHost('tool', {
          tool: 'Edit',
          input: { file_path: abs, old_string: oldStr, new_string: newStr, replace_all: all },
        })
        if (res.deny || res.isError) {
          return fail(soft, res.deny || res.text || `edit ${i + 1} failed`, total)
        }
        total += m
      }
      return { ok: true, replacements: total }
    }

    const opts = c && typeof c === 'object' ? c : {}
    const all = opts.all === true
    const soft = opts.soft === true
    if (typeof a !== 'string' || typeof b !== 'string') {
      return fail(soft, 'edit: old and new text must be strings')
    }
    if (a === b) return { ok: true, replacements: 0 }
    const res = await requestHost('tool', {
      tool: 'Edit',
      input: { file_path: abs, old_string: a, new_string: b, replace_all: all },
    })
    if (res.deny || res.isError) {
      return fail(soft, res.deny || res.text || 'edit failed')
    }
    return { ok: true, replacements: all ? -1 : 1 }
  }

  async function write(filePath, content) {
    if (typeof filePath !== 'string' || typeof content !== 'string') {
      throw new Error('write: path and content must be strings')
    }
    const abs = resolveFilePath(filePath)
    const res = await requestHost('tool', {
      tool: 'Write',
      input: { file_path: abs, content },
    })
    if (res.deny) throw new Error(`Write denied: ${res.deny}`)
    if (res.isError) throw new Error(res.text || `Write failed for ${filePath}`)
    return Buffer.byteLength(content, 'utf8')
  }

  function preview(value, n = 200) {
    const cap = Math.max(20, Number(n) || 200)
    if (value && typeof value === 'object' && typeof value.stdout === 'string' && 'exitCode' in value) {
      const prefix = value.file ? `[saved to ${value.file}, ${value.stdout.length} chars shown]\n` : ''
      const body = value.stdout
      if (body.length <= cap) return `${prefix}${body}`
      return `${prefix}${body.slice(0, cap)}… [+${body.length - cap} chars]`
    }
    const str = typeof value === 'string' ? value : formatValue(value)
    if (str.length <= cap) return str
    return `${str.slice(0, cap)}… [+${str.length - cap} chars]`
  }

  function log(...args) {
    if (!activeExec) return
    const line = args.map(a => (typeof a === 'string' ? a : formatValue(a))).join(' ')
    activeExec.logs.push(truncateMiddle(line))
  }

  function sleep(ms) {
    const duration = Math.max(0, Math.min(600_000, Number(ms) || 0))
    return requestHost('sleep', { ms: duration }).then(() => undefined)
  }

  function searchTools(query, max = 10) {
    if (typeof query !== 'string' || query.trim() === '') {
      return Promise.resolve({ error: 'searchTools: query must be a non-empty string' })
    }
    return requestHost('search_tools', { query: query.trim(), max: Math.max(1, Math.min(50, Number(max) || 10)) })
  }

  function describeTool(name) {
    if (typeof name !== 'string' || name.trim() === '') {
      return Promise.resolve({ error: 'describeTool: name must be a non-empty string' })
    }
    return requestHost('describe_tool', { name: name.trim() })
  }

  const setTimeoutSandboxed = (fn, ms) => {
    const exec = activeExec
    const id = setTimeout(() => {
      exec?.timerIds.delete(id)
      try {
        fn()
      } catch (err) {
        consoleRing.error('setTimeout error:', err)
      }
      exec?.notify?.()
    }, Math.max(0, Number(ms) || 0))
    exec?.timerIds.add(id)
    return id
  }

  const clearTimeoutSandboxed = (id) => {
    activeExec?.timerIds.delete(id)
    clearTimeout(id)
  }

  const setIntervalSandboxed = (fn, ms) => {
    const exec = activeExec
    const id = setInterval(() => {
      try {
        fn()
      } catch (err) {
        consoleRing.error('setInterval error:', err)
      }
      exec?.notify?.()
    }, Math.max(10, Number(ms) || 10))
    exec?.timerIds.add(id)
    return id
  }

  const clearIntervalSandboxed = (id) => {
    activeExec?.timerIds.delete(id)
    clearInterval(id)
  }

  // Proxy `tools.<name>(input)` so any tool name works dynamically.
  const toolsProxy = new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      return (input = {}) => invokeTool(prop, input)
    },
    has(_target, prop) {
      return typeof prop === 'string' && (BUILTIN_TOOL_NAMES.has(prop) || knownToolNames.has(prop))
    },
    ownKeys() {
      return [...new Set([...BUILTIN_TOOL_NAMES, ...knownToolNames])]
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === 'string') {
        return { configurable: true, enumerable: true, value: (input = {}) => invokeTool(prop, input) }
      }
      return undefined
    },
  })

  const sandbox = {
    $,
    file,
    edit,
    write,
    preview,
    log,
    sleep,
    searchTools,
    describeTool,
    tools: toolsProxy,
    console: consoleRing,
    setTimeout: setTimeoutSandboxed,
    clearTimeout: clearTimeoutSandboxed,
    setInterval: setIntervalSandboxed,
    clearInterval: clearIntervalSandboxed,
    atob,
    btoa,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
  }

  for (const name of BUILTIN_TOOL_NAMES) {
    sandbox[name] = (input = {}) => invokeTool(name, input)
  }

  const context = vm.createContext(sandbox)
  vm.runInContext('globalThis.self = globalThis;', context)
  const vmObjectProto = vm.runInContext('Object.prototype', context)

  const builtinGlobalKeys = new Set(Object.getOwnPropertyNames(vm.runInContext('globalThis', context)))

  const syncToolGlobals = (toolNames) => {
    if (!Array.isArray(toolNames)) return
    knownToolNames = new Set(toolNames)
    for (const name of toolNames) {
      if (
        typeof name === 'string' &&
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) &&
        !builtinGlobalKeys.has(name) &&
        !(name in sandbox)
      ) {
        sandbox[name] = (input = {}) => invokeTool(name, input)
        builtinGlobalKeys.add(name)
      }
    }
  }

  const userGlobalNames = () => {
    const keys = Object.getOwnPropertyNames(vm.runInContext('globalThis', context))
    return keys.filter(k => !builtinGlobalKeys.has(k) && !k.startsWith('__cm_'))
  }

  return {
    loopId,
    context,
    vmObjectProto,
    setActiveExec: (e) => { activeExec = e },
    setCwd: (cwd) => { if (typeof cwd === 'string' && cwd) currentCwd = cwd },
    syncToolGlobals,
    userGlobalNames,
    evalCount: 0,
  }
}

const loops = new Map()
const executions = new Map()
let nextExecId = 1
let lastActivityAt = Date.now()

function getLoop(loopId) {
  let loop = loops.get(loopId)
  if (!loop) {
    loop = createLoopContext(loopId)
    loops.set(loopId, loop)
  }
  return loop
}

function clearExecTimers(exec) {
  for (const id of exec.timerIds) {
    clearTimeout(id)
    clearInterval(id)
  }
  exec.timerIds.clear()
}

function formatExecOutput(exec, evalNum) {
  const parts = [`<repl-output eval="${evalNum}">`]
  if (exec.logs.length > 0) {
    parts.push(`<log>\n${truncateMiddle(exec.logs.join('\n'))}\n</log>`)
  }
  if (exec.error !== undefined) {
    parts.push(`<error>\n${truncateMiddle(exec.error)}\n</error>`)
  } else if (exec.result !== undefined) {
    parts.push(`<result>\n${formatValue(exec.result)}\n</result>`)
  } else if (exec.logs.length === 0) {
    parts.push('<result>undefined</result>')
  }
  parts.push('</repl-output>')
  return parts.join('\n')
}

async function resolveTopLevelPromises(value, vmObjectProto) {
  if (isThenable(value)) return await value
  if (!isPlainObject(value, vmObjectProto)) return value
  const entries = Object.entries(value)
  if (!entries.some(([, v]) => isThenable(v))) return value
  const resolved = await Promise.all(entries.map(async ([k, v]) => [k, isThenable(v) ? await v : v]))
  return Object.fromEntries(resolved)
}

async function waitForStep(exec) {
  const remaining = Math.max(0, exec.deadline - Date.now())
  if (remaining === 0 && !exec.done) {
    exec.cancelled = true
    exec.done = true
    exec.error = `REPL script timed out after ${exec.timeoutMs} ms`
    clearExecTimers(exec)
    return
  }

  // Drain microtasks first so Promise.all([...]) queues every concurrent tool call together.
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setImmediate(r))
    if (exec.done) return
  }
  if (exec.pendingCalls.length > 0 || exec.done) return

  // If no tool calls yet and not done (e.g. waiting on a JS setTimeout), wait briefly.
  const sliceMs = Math.min(SLICE_WAIT_MS, remaining)
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      exec.notify = null
      resolve()
    }, sliceMs)
    exec.notify = () => {
      clearTimeout(timer)
      exec.notify = null
      setImmediate(resolve)
    }
  })

  if (!exec.done && Date.now() >= exec.deadline) {
    exec.cancelled = true
    exec.done = true
    exec.error = `REPL script timed out after ${exec.timeoutMs} ms`
    clearExecTimers(exec)
  }
}

function buildStepResponse(exec) {
  if (exec.done) {
    clearExecTimers(exec)
    exec.loop.setActiveExec(null)
    executions.delete(exec.id)
    return {
      status: 'done',
      execId: exec.id,
      evalNum: exec.evalNum,
      isError: exec.error !== undefined,
      output: formatExecOutput(exec, exec.evalNum),
    }
  }
  if (exec.pendingCalls.length > 0) {
    const calls = exec.pendingCalls.splice(0)
    return {
      status: 'need_tools',
      execId: exec.id,
      calls,
    }
  }
  return {
    status: 'continue',
    execId: exec.id,
  }
}

async function handleEval(body) {
  const loopId = typeof body.loopId === 'string' && body.loopId ? body.loopId : 'main'
  const code = typeof body.code === 'string' ? body.code : ''
  const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? body.timeoutMs : 120_000
  const loop = getLoop(loopId)
  loop.setCwd(body.cwd)
  loop.syncToolGlobals(body.toolNames)
  loop.evalCount += 1
  const evalNum = loop.evalCount

  let transformed
  try {
    transformed = transformScript(code)
  } catch (err) {
    return {
      status: 'done',
      evalNum,
      isError: true,
      output: `<repl-output eval="${evalNum}">\n<error>\nSyntaxError: ${err.message}\n</error>\n</repl-output>`,
    }
  }

  const exec = {
    id: `exec_${nextExecId++}`,
    evalNum,
    loop,
    timeoutMs,
    deadline: Date.now() + timeoutMs,
    nextCallId: 0,
    pendingCalls: [],
    resolvers: new Map(),
    logs: [],
    timerIds: new Set(),
    done: false,
    cancelled: false,
    result: undefined,
    error: undefined,
    notify: null,
  }
  executions.set(exec.id, exec)
  loop.setActiveExec(exec)

  let promise
  try {
    const script = new vm.Script(transformed, { filename: 'repl-script.js' })
    promise = script.runInContext(loop.context, { timeout: Math.min(30_000, timeoutMs) })
  } catch (err) {
    exec.done = true
    exec.error = err instanceof Error ? (err.stack || err.message) : String(err)
    return buildStepResponse(exec)
  }

  Promise.resolve(promise)
    .then(val => resolveTopLevelPromises(val, loop.vmObjectProto))
    .then(
      val => {
        if (!exec.done) {
          exec.result = val
          exec.done = true
          exec.notify?.()
        }
      },
      err => {
        if (!exec.done) {
          exec.error = err instanceof Error ? (err.stack || err.message) : String(err)
          exec.done = true
          exec.notify?.()
        }
      },
    )

  await waitForStep(exec)
  return buildStepResponse(exec)
}

async function handleResume(body) {
  const exec = executions.get(body.execId)
  if (!exec) {
    return { status: 'done', isError: true, output: '<repl-output>\n<error>\nUnknown or expired execution ID.\n</error>\n</repl-output>' }
  }
  if (body.abort === true) {
    exec.cancelled = true
    exec.done = true
    exec.error = 'REPL script aborted.'
    for (const { reject } of exec.resolvers.values()) {
      reject(new Error('REPL script aborted.'))
    }
    exec.resolvers.clear()
    return buildStepResponse(exec)
  }

  exec.loop.setActiveExec(exec)
  const results = Array.isArray(body.results) ? body.results : []
  for (const item of results) {
    const entry = exec.resolvers.get(item.id)
    if (!entry) continue
    exec.resolvers.delete(item.id)
    if (item.error) {
      entry.reject(new Error(String(item.error)))
    } else {
      entry.resolve(item.value)
    }
  }

  await waitForStep(exec)
  return buildStepResponse(exec)
}

function cleanupAndExit(code = 0) {
  try {
    server.stop(true)
  } catch {}
  try {
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath)
  } catch {}
  process.exit(code)
}

if (fs.existsSync(sockPath)) {
  try {
    fs.unlinkSync(sockPath)
  } catch {}
}

const server = Bun.serve({
  unix: sockPath,
  async fetch(req) {
    lastActivityAt = Date.now()
    if (req.headers.get('authorization') !== `Bearer ${authToken}`) {
      return new Response('Unauthorized', { status: 401 })
    }
    const url = new URL(req.url)
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true, pid: process.pid, loops: loops.size })
      }
      if (req.method === 'POST' && url.pathname === '/eval') {
        const body = await req.json()
        return Response.json(await handleEval(body))
      }
      if (req.method === 'POST' && url.pathname === '/resume') {
        const body = await req.json()
        return Response.json(await handleResume(body))
      }
      if (req.method === 'POST' && url.pathname === '/reset') {
        const body = await req.json().catch(() => ({}))
        const loopId = typeof body.loopId === 'string' && body.loopId ? body.loopId : 'main'
        loops.delete(loopId)
        return Response.json({ ok: true, reset: loopId })
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const loopId = url.searchParams.get('loopId') || 'main'
        const loop = loops.get(loopId)
        return Response.json({
          ok: true,
          pid: process.pid,
          loopId,
          evalCount: loop ? loop.evalCount : 0,
          globals: loop ? loop.userGlobalNames() : [],
        })
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        setTimeout(() => cleanupAndExit(0), 20)
        return Response.json({ ok: true })
      }
      return new Response('Not Found', { status: 404 })
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  },
})

try {
  fs.chmodSync(sockPath, 0o600)
} catch {}

// Watchdog: exit cleanly if parent died or worker sits idle for hours.
setInterval(() => {
  if (Date.now() - lastActivityAt > IDLE_SHUTDOWN_MS) {
    cleanupAndExit(0)
  }
  if (parentPid > 1) {
    try {
      process.kill(parentPid, 0)
    } catch {
      cleanupAndExit(0)
    }
  }
}, 30_000).unref()

process.on('SIGINT', () => cleanupAndExit(0))
process.on('SIGTERM', () => cleanupAndExit(0))

process.stdout.write('READY\n')
