/**
 * Finds the "★ 思路" block in a reply's markdown.
 *
 * The block opens on a line holding only the star and its title, with or
 * without the rule and backticks an older output style asked the model to
 * write (`★ 思路 ───`). It closes on a line holding only a rule of box
 * characters, or a lone star; while a reply is still streaming it may have no
 * close yet, and then runs to the end of the text.
 */

export type Split = {
  /** Markdown before the block. */
  before: string
  /** The block's title, the words after the star. */
  title: string
  /** The block's body, markdown, without its open and close lines. */
  body: string
  /** Markdown after the block. */
  after: string
}

const OPEN = /^[ \t]*`?★[ \t]*([^\s─`][^─`]*?)[ \t─]*`?[ \t]*$/
const CLOSE = /^[ \t]*`?(?:─{3,}|★)`?[ \t]*$/

export function splitInsight(text: string): Split | undefined {
  const lines = text.split('\n')
  const open = lines.findIndex(l => OPEN.test(l))
  if (open < 0) return undefined
  let close = lines.findIndex((l, i) => i > open && CLOSE.test(l))
  if (close < 0) close = lines.length
  const title = OPEN.exec(lines[open]!)![1]!.trim()
  return {
    before: lines.slice(0, open).join('\n').replace(/\s+$/, ''),
    title,
    // Model-written bullets may carry the indent of the list they followed.
    body: dedent(lines.slice(open + 1, close)).join('\n').trim(),
    after: lines.slice(close + 1).join('\n').replace(/^\s+/, ''),
  }
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter(l => l.trim()).map(l => /^[ \t]*/.exec(l)![0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return lines.map(l => l.slice(cut))
}
