// Scenario driver for the magpie-tasks e2e scripts. A session loaded with this mod sends what the
// scenario writes into the file PEER_SEND_FILE names to another session with `$.session.send`: the
// call the Router makes when it hands a Telegram message to a long task's architect. The file holds
// one JSON object `{ "to": "<session id>", "text": "<message>" }`; once it is sent the file is
// emptied and `<file>.done` holds what `$.session.send` answered.
import type { Register } from 'claude-code'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const file = await $.env.get('PEER_SEND_FILE')
    if (file === undefined || file === '') return r
    let busy = false
    $.clock.every(1000, () => {
      if (busy) return
      busy = true
      void (async () => {
        if (!(await $.fs.exists(file))) return
        const body = (await $.fs.read(file)).trim()
        if (body === '') return
        const request = JSON.parse(body) as { to: string; text: string }
        await $.fs.write(file, '')
        const sent = await $.session.send({ to: { sessionId: request.to }, text: request.text })
        await $.fs.write(`${file}.done`, `${JSON.stringify(sent)}\n`)
      })().catch((err: unknown) => $.ui.log(`peer-send: ${err instanceof Error ? err.message : String(err)}`)).finally(() => { busy = false })
    })
    return r
  })
}
