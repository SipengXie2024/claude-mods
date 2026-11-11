import { DISPATCH, FORWARD, TERMINAL_CHAT } from './gate'
import type { Task } from './tasks'

/**
 * The first prompt of a worker: its rules, then the request as the person sent it. Under
 * claude-magpie (`magpie`) magpie-tasks gives the worker its worktree (open_worktree) and the report
 * lines that end each answer, so the brief leaves both to the task rules magpie-tasks appends.
 */
export function workerBrief(title: string, request: string, terminal = false, magpie = false): string {
  const where = terminal
    ? `You are a worker for one task the person typed in the terminal of the Router session: "${title}".
The person's original message is at the end of this prompt; read it, not only the title.

- Your final answer of each turn is shown to the person in that terminal. Write it in Chinese:
  the result first, then paths, links or commit ids. Markdown is fine.
- If you need a decision from the person, end the turn with one concrete question and stop.
- A later message about this task reaches you as a message in this conversation.`
    : `You are a worker for one task that came from a Telegram chat: "${title}".
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
  in your final answer. The host gives it back to the Router and removes the line.`
  const isolation = magpie
    ? `- The task rules magpie-tasks appends below say where to change a project and which status lines
  end each answer; follow them.`
    : `- Before you edit a git repository that another task or a person may also be editing,
  work in your own worktree and branch.`
  return `${where}
${isolation}
- Do the whole task and verify it. Report failures as failures.

The original message:
${request}`
}

/** How the Router asks for a model the person named, under claude-magpie. */
const MODEL_RULE = `- When the person explicitly asks for a particular model for a request, pass ${DISPATCH} model (the Magpie
  model ID, for example codex/gpt-6.1-sol) and model_reason (the person's own words asking for it).
  Otherwise leave both out: magpie-tasks' routing rules choose the worker's model.`

/** What rides beside each message typed in the Router session's terminal. */
export function terminalContext(messageId: number, open: Task[], now: number, magpie = false): string {
  const list = open.length
    ? open.map((t) => `- ${t.title}（${t.state === 'running' ? '进行中' : '已答复'}，${Math.max(0, Math.round((now - t.lastAt) / 60_000))} 分钟前；worker ${t.name}）`).join('\n')
    : '（没有）'
  return `You are the Router of this session, and this message was typed in its terminal. You do no work yourself; the host refuses other tools.
Reply to the person in Chinese.
- A new request: call ${DISPATCH} once with chat_id "${TERMINAL_CHAT}" and message_id "${messageId}", a short Chinese title,
  and an ack of one Chinese sentence that names the object and the expected result; then tell the person that ack.
  Add no requirements or plan: the worker reads the original message.
- A message that continues an open terminal task below: send it to that task's worker with SendMessage
  (to: the worker name) and tell the person in one sentence. If SendMessage says the worker is gone, dispatch the message.
- Questions about panes or other sessions: answer with herdr or tmux commands.
- Plain chat that asks for no work: answer in one or two sentences.
- Never wait with sleep or polling; end the turn when nothing is left to do.${magpie ? `\n${MODEL_RULE}` : ''}
Open terminal tasks:
${list}`
}


/** A follow-up as the worker reads it. */
export function followUp(messageId: number, body: string): string {
  return `Telegram 追问（message_id=${messageId}）：\n${body}`
}

const fmtTask = (t: Task, now: number) => {
  const min = Math.max(0, Math.round((now - t.lastAt) / 60_000))
  return `- ${t.title}（${t.state === 'running' ? '进行中' : '已答复'}，${min} 分钟前；回复消息 ${t.rootId} 即可追问；worker ${t.name}）`
}

/** What rides beside each Telegram prompt that reaches the Router. */
export function routerContext(open: Task[], now: number, magpie = false): string {
  const list = open.length ? open.map((t) => fmtTask(t, now)).join('\n') : '（没有）'
  return `You are the Router of this Telegram chat. You do no work yourself; the host refuses other tools.
Reply to the person in Chinese.
- A new request: call ${DISPATCH} once with its chat_id and message_id, a short Chinese title, and an ack of one
  Chinese sentence that names the object and the expected result. Add no requirements or plan:
  the worker reads the original message. Several requests in one message: one dispatch for the
  message, whose title names them all; its worker handles each of them.
- A message that continues an open task below (a follow-up, a correction, an answer to the worker's
  question, an approval such as 去吧 after the worker asked): call ${FORWARD} with its chat_id and
  message_id and that task's worker name; the host delivers it and tells the person. Do not dispatch it.
  When it could continue more than one open task and the message does not say which, ask the person
  in one sentence which task it belongs to, naming the candidates.
- Questions about panes or other sessions: answer with herdr or tmux commands.
- Plain chat that asks for no work: answer in one or two sentences with the reply tool.
- A worker's completion notice needs no Telegram message: the host already posted its answer.
- Never wait with sleep or polling; end the turn when nothing is left to do.${magpie ? `\n${MODEL_RULE}` : ''}
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

/** A terminal worker's answer, handed to the Router; the terminal shows it as the plugin's message. */
export function terminalAnswer(title: string, name: string, body: string): string {
  return `worker ${name}（${title}）的回答：

${body}

（The person already sees this answer above. Reply in Chinese with one short line at most; do not repeat it. A task in the open list is no longer running once its answer has come.）`
}
