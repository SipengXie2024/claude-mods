// What the Router (the main loop of the Telegram session) may call. The paper's
// ablation saw a single session keep work for itself under a neutral prompt,
// so the rule is code: the Router routes, talks, and drives herdr/tmux panes.

export const DISPATCH = 'mcp__tg-router__dispatch'
export const FORWARD = 'mcp__tg-router__forward'
/** the forked channel: the MCP server the launcher starts through --mcp-config */
export const CHANNEL_SERVER = 'tg-channel'
export const CHANNEL_PREFIX = `mcp__${CHANNEL_SERVER}__`
/** the chat id of requests typed in the Router session's own terminal (or through Remote Control) */
export const TERMINAL_CHAT = 'tui'

/** magpie-tasks registers these for the Router under claude-magpie (long tasks and promotion) */
export const FORWARD_LONG = 'mcp__magpie-tasks__forward_long'
export const RECOMMEND_ARCHITECT = 'mcp__magpie-tasks__recommend_architect'
export const PROMOTE_TASK = 'mcp__magpie-tasks__promote_task'
/** tools only the Router itself may call */
const ROUTER_ONLY = new Set([DISPATCH, FORWARD, FORWARD_LONG, RECOMMEND_ARCHITECT, PROMOTE_TASK])

const ROUTER_TOOLS = new Set([...ROUTER_ONLY, 'TaskStop', 'ToolSearch', 'SendMessage'])
const PANE_CMD = /^(herdr|tmux)$/
/** tmux commands that run a shell command or script in the tmux server itself, and their aliases */
const TMUX_SHELL = /^(run(-shell)?|if(-shell)?|pipe-pane|pipep|source(-file)?)$/
/** filters a pane command may pipe into */
const PIPE_FILTER = /^(head|tail|grep|wc|sort|cut)$/
/** `sort -o FILE` writes a file */
const SORT_OUTPUT = /(^|\s)(-[A-Za-z]*o|--output)/

export const DENY_WORK = `Router 不做具体工作。新的请求用 ${DISPATCH} 交给 worker；窗格相关的问题只能用 herdr 或 tmux 命令。`

/** Each `&&`/`||`/`;`/`&`/newline part must be a herdr or tmux pipeline. */
export function isPaneCommand(command: string): boolean {
  // command substitution, backticks and redirection could run or write anything
  if (/`|\$\(|<\(|>/.test(command)) return false
  const parts = command.split(/&&|\|\||;|&|\n/).map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return false
  const words = (s: string) => s.split(/\s+/)
  return parts.every((part) => {
    const stages = part.split('|').map((s) => s.trim())
    const head = words(stages[0]!)
    if (!PANE_CMD.test(head[0] ?? '')) return false
    if (head[0] === 'tmux' && head.some((w) => TMUX_SHELL.test(w))) return false
    return stages.slice(1).every((s) => PIPE_FILTER.test(words(s)[0] ?? '') && !(words(s)[0] === 'sort' && SORT_OUTPUT.test(s)))
  })
}

export type GateInput = { tool: string; agentId?: string; command?: unknown; file_path?: unknown }

/** The deny reason for a Router call, or null when the call may run. */
export function routerDeny(e: GateInput, inboxDir: string): string | null {
  // a worker's other tools, magpie-tasks' open_worktree among them, are not this gate's to judge
  if (e.agentId) return ROUTER_ONLY.has(e.tool) ? `${e.tool} 只给 Router 用` : null
  if (ROUTER_TOOLS.has(e.tool) || e.tool.startsWith(CHANNEL_PREFIX)) return null
  if (e.tool === 'Bash' && typeof e.command === 'string' && isPaneCommand(e.command)) return null
  // a photo the person sent: the channel tells the Router to Read it
  if (e.tool === 'Read' && typeof e.file_path === 'string' && e.file_path.startsWith(`${inboxDir}/`) && !e.file_path.includes('..')) return null
  return DENY_WORK
}
