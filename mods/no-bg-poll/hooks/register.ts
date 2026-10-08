import type { Register } from 'claude-code'

// Background tasks (run_in_background, fork agents) send a completion
// notification. Polling them with `sleep N && tail` wastes wall time and
// re-pulls their output into context.

const TASK_OUTPUT = /\/tmp\/claude-\S*tasks\/\S*\.output/
const SLEEP = /(^|[^a-z_])sleep\s+[0-9]/
const SLEEP_THEN_READ = /(^|[^a-z_])sleep\s+[0-9]+(\.[0-9]+)?\s*&&\s*(tail|cat|head|grep|less|more|wc|awk|sed)/

const POLL_TASK_OUTPUT = `Blocked: polling a background-task output file with \`sleep N\`.

Background tasks send an automatic completion notification — do not poll.
End the turn or do unrelated work; you'll be woken when the task finishes.

If the user asked for a status update mid-flight, do a single non-blocking
peek (no sleep): use the Read tool on the .output file, or run \`ps -p <pid>\`.

If you genuinely need to wait for a non-background-task event (server boot,
daemon ready), use a bounded retry loop with a clear exit condition instead
of a fixed sleep + read.`

const POLL_SLEEP_READ = `Blocked: \`sleep N && <reader>\` matches the polling antipattern.

If you're waiting for a background task, end the turn — the harness sends
an auto-notification when it finishes. If you need to peek right now,
drop the sleep and just read the file with the Read tool.

If you're waiting for a daemon/server to start, use a bounded retry loop
(e.g., \`for i in {1..30}; do curl -sf URL && break; sleep 1; done\`) rather
than a fixed sleep before the first read.`

export function pollingReason(command: string): string | undefined {
  if (TASK_OUTPUT.test(command) && SLEEP.test(command)) return POLL_TASK_OUTPUT
  if (SLEEP_THEN_READ.test(command)) return POLL_SLEEP_READ
  return undefined
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const reason = pollingReason(e.command)
    return reason ? { deny: reason } : next(e)
  }).catch(($, e, next) => next(e))
}
