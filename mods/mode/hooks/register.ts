import type { EngineInterface, PromptComposeSection, Register } from 'claude-code'

import { looksLikePaper } from './detect'
import { detectMode, mergeProfile, parseLocal } from './settings'

const USAGE = '用法：/mode academic | /mode general | /mode（查看当前模式）'

const LABEL = { academic: '学术', general: '通用', unset: '未设置（按通用）', custom: '自定义（插件开关不是两种模式之一）' }

// Read once per load: a /mode switch only applies after a restart anyway.
let cachedMode: Promise<ReturnType<typeof detectMode>> | undefined

function repoMode($: EngineInterface) {
  cachedMode ??= $.session
    .root()
    .then(root => $.fs.read(`${root}/.claude/settings.local.json`))
    .then(parseLocal)
    .catch(() => ({}))
    .then(detectMode)
  return cachedMode
}

// Academic mode keeps Plain as the output style (how replies read) and adds the
// academic judgment rules here, as their own system prompt section.
export const ACADEMIC_ID = 'mode:academic'
let cachedPrompt: Promise<PromptComposeSection> | undefined

function academicSection($: EngineInterface) {
  cachedPrompt ??= $.fs
    .read(`${$.plugin.root}/prompts/academic.md`)
    .then(text => ({ id: ACADEMIC_ID, text: String(text), scope: 'session' as const }))
  return cachedPrompt
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mode', description: '切换本仓库的通用/学术模式（重启后生效）' })
    const root = await $.session.root()
    const mode = await repoMode($)
    if (mode === 'academic') $.ui.status('学术模式')
    if (mode === 'unset' && (await looksLikePaper(p => $.fs.list(p), root))) {
      $.ui.toast('这里像论文仓库（有 .tex/.bib）。输入 /mode academic 切到学术模式，或 /mode general 以后不再提示。', {
        timeoutMs: 20000,
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if ((await repoMode($)) !== 'academic') return out
    return { sections: [...out.sections, await academicSection($)] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'mode' }, async ($, e) => {
    const arg = e.args.trim()
    const root = await $.session.root()
    const path = `${root}/.claude/settings.local.json`
    const text = await $.fs.read(path).catch(() => undefined)

    let local
    try {
      local = parseLocal(text)
    } catch (err) {
      return { text: `没有改动：${path} 不是合法 JSON（${String(err)}）。先修好这个文件再切换。` }
    }

    if (arg === '') return { text: `当前：${LABEL[detectMode(local)]}（来自 ${path}）\n${USAGE}` }
    if (arg !== 'academic' && arg !== 'general') return { text: USAGE }

    const merged = mergeProfile(local, arg)
    // Compare the whole profile, not just the plugin pair, so re-running /mode
    // also repairs a stale outputStyle value.
    if (JSON.stringify(merged) === JSON.stringify(local)) return { text: `${root} 已经是${LABEL[arg]}模式，没有改动。` }
    await $.fs.write(path, `${JSON.stringify(merged, null, 2)}\n`)
    return { text: `已把 ${root} 设为${LABEL[arg]}模式，写入 ${path}。\n重启会话后生效：/exit 后再运行 claude。` }
  })
}
