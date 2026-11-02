import { DISPATCH } from './gate'
import type { Task } from './tasks'

/** The first prompt of a worker: its rules, then the request as the person sent it. */
export function workerBrief(title: string, request: string): string {
  return `You are a worker for one task that came from a Telegram chat: "${title}".
The person's original message is at the end of this prompt; read it, not only the title.

- Your final answer of each turn is posted, as written, as a Telegram reply under that message.
  Write it in Chinese, at most 100 words: the result first, then paths, links or commit ids.
  Plain text only: Telegram shows Markdown marks such as ** and backquotes as typed.
  Do not send or edit Telegram messages yourself; the host sends your answer. A file the
  message carries as attachment_file_id is fetched with the channel's download_attachment tool.
- If you need a decision from the person, end the turn with one concrete question and stop.
- A later Telegram message about this task reaches you as a message in this conversation.
  If one is not about this task, do not work on it: put a line
  HANDBACK <its message_id>: <one-sentence reason>
  in your final answer. The host gives it back to the Router and removes the line.
- Before you edit a git repository that another task or a person may also be editing,
  work in your own worktree and branch.
- Do the whole task and verify it. Report failures as failures.

The original message:
${request}`
}

/** A follow-up as the worker reads it. */
export function followUp(messageId: number, body: string): string {
  return `Telegram 追问（message_id=${messageId}）：\n${body}`
}

const fmtTask = (t: Task, now: number) => {
  const min = Math.max(0, Math.round((now - t.lastAt) / 60_000))
  return `- ${t.title}（${t.state === 'running' ? '进行中' : '等待中'}，${min} 分钟前；回复消息 ${t.rootId} 即可追问）`
}

/** What rides beside each Telegram prompt that reaches the Router. */
export function routerContext(open: Task[], now: number): string {
  const list = open.length ? open.map((t) => fmtTask(t, now)).join('\n') : '（没有）'
  return `You are the Router of this Telegram chat. You do no work yourself; the host refuses other tools.
- A new request: call ${DISPATCH} once with its chat_id and message_id, a short Chinese title, and an ack of one
  Chinese sentence that names the object and the expected result. Add no requirements or plan:
  the worker reads the original message. Several requests in one message: one dispatch for the
  message, whose title names them all; its worker handles each of them.
- A message that continues an open task below: tell the person, in one sentence, to reply to that
  task's message so it reaches the worker; do not dispatch it again.
- Questions about panes or other sessions: answer with herdr or tmux commands.
- Plain chat that asks for no work: answer in one or two sentences with the reply tool.
- A worker's completion notice needs no Telegram message: the host already posted its answer.
- Never wait with sleep or polling; end the turn when nothing is left to do.
Open tasks:
${list}`
}

/** Tells the Router why a message comes back to it. */
export function handedBack(reason: string, original: string): string {
  return `worker 交回了这条消息，理由：${reason}\n${original}`
}

/** Why a reply comes to the Router; the dispatch it asks for carries the task's request. */
export function lostWorker(title: string): string {
  return `The worker of the task "${title}", which this message replies to, is gone (the session restarted); the person was told. Dispatch the message: the new worker gets the task's original request with it and takes the task over.`
}

/** The request a lost task's new worker starts from: the task's original request, then the reply. */
export function takeOver(request: string, reply: string): string {
  return `${request}\n\nThe worker of this task is gone; you take it over. The person's reply that brought it back:\n${reply}`
}

/** Rides beside a worker's completion notice when its answer could not be posted. */
export function answerNotPosted(chatId: string, replyTo: number): string {
  return `This worker's answer could not be posted to Telegram. Send its result to the person with the channel's reply tool: chat_id ${chatId}, reply_to ${replyTo}.`
}
