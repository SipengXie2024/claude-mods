// Jev's input for routing a delegation (README, subagent routing): the conversation the brief comes
// from, read through the host, the files the brief names, read from disk, and the brief.
import { briefForJev, briefPaths, delegationMessages, spawningDialogue, type ApiMessage } from './dialogue'
import { expandHome } from './io'
import type { JevMessage } from './jev'
import type { Ctx } from './state'

// One named file is read up to FILE_CHARS characters and all of them together up to FILES_CHARS,
// so they never crowd the conversation out of the Decisions API's input (it accepted 920,860
// tokens and rejected 927,343, findings 2026-11-09). A file over FILE_BYTES is not read at all: it
// is data, not part of a brief, and the brief still names it.
const FILE_CHARS = 100_000
const FILES_CHARS = 300_000
const FILE_BYTES = 4 * 1024 * 1024

// `agentId` is the subagent that delegates; without it the main loop delegates.
export async function delegationInput(ctx: Pick<Ctx, 'host' | 'io'>, prompt: string, agentId?: string): Promise<JevMessage[]> {
  const api = await (agentId === undefined ? ctx.host.session.messages({ as: 'api' }) : ctx.host.session.messages({ agentId, as: 'api' }))
  if (!Array.isArray(api)) throw new Error(`messages of ${agentId === undefined ? 'the main loop' : `agent ${agentId}`}: ${api.deny}`)
  const paths = briefPaths(briefForJev(prompt))
  const home = paths.some(p => p.startsWith('~/')) ? await ctx.io.env('HOME') : ''
  if (home === undefined) throw new Error('HOME is not set')
  const files: { path: string; text: string }[] = []
  let left = FILES_CHARS
  for (const named of paths) {
    if (left === 0) break
    const path = expandHome(named, home)
    // A path the brief names for its output, or one that is gone, is simply not there to read.
    if (!(await ctx.io.exists(path))) continue
    const s = await ctx.io.stat(path)
    if (s.kind !== 'file' || s.size > FILE_BYTES) continue
    const text = await ctx.io.read(path)
    if (text.includes('\u0000')) continue
    const cut = Math.min(FILE_CHARS, left)
    files.push({ path: named, text: text.length > cut ? `${text.slice(0, cut)}\n[… cut at ${cut} characters]` : text })
    left -= Math.min(text.length, cut)
  }
  return delegationMessages(spawningDialogue(api as ApiMessage[], agentId !== undefined), files, prompt)
}
