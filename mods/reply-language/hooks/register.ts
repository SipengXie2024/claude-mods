import type { Register } from 'claude-code'

// The `language` setting lives only in the system prompt, the far end of a
// long session. Task notifications, compaction summaries and subagent reports
// put English right before the reply, and the reply follows them. A reminder
// attached to every prompt, written in the target language, sits next to the
// reply instead.

const CHINESE = /^(chinese|中文|zh([-_].*)?|简体中文|汉语)$/i

export function reminder(language: string): string {
  return CHINESE.test(language.trim())
    ? '用中文回复用户。代码、命令、标识符和提交信息保持原样。'
    : `Reply to the user in ${language.trim()}. Code, commands, identifiers and commit messages stay as written.`
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    const language = await $.settings.read({ key: 'language' })
    if (typeof language !== 'string' || !language.trim()) return next(e)
    return next({ ...e, context: [...(e.context ?? []), reminder(language)] })
  })
}
