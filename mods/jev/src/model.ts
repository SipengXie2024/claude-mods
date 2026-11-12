/** A Claude id or alias with its 1M-context suffix: `claude-opus-5-5[1m]`, `claude-haiku-4-5-20251001`, `opus`. */
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i
const ALIAS = /^(opus|sonnet|haiku|fable|mythos)(\[1m\])?$/i

const title = (family: string) => family[0]!.toUpperCase() + family.slice(1).toLowerCase()

export type OpenAIModelScale = 'astra' | 'sol-6.1'

/** Magpie 使用 provider/model 标识；Hermes 的 Astra 标识还带有上下文长度。 */
export function openAIModelScale(model: string | null): OpenAIModelScale | null {
  const id = model?.split('/').at(-1) ?? ''
  if (/^gpt-6-astra(?:-900k)?(?:\[1m\])?$/i.test(id)) return 'astra'
  if (/^gpt-6\.1-sol(?:\[1m\])?$/i.test(id)) return 'sol-6.1'
  return null
}

/** Gemini 4 Argon under Magpie's Antigravity provider (`antigravity/gemini-4-argon`). */
export function isArgon(model: string | null): boolean {
  return /(?:^|\/)gemini-4-argon(?:-trial)?(?:\[1m\])?$/i.test(model ?? '')
}

/**
 * A model whose ID ends in a reasoning level (`hakimi/gemini-4-argon-high`, `hakimi/claude-opus-5-5-medium`)
 * runs at that level whatever effort the request carries: sub2api's Antigravity gateway sets the level
 * from the model name, so Magpie lists each level as its own model.
 */
const LEVEL_IN_NAME = /-(?:minimal|low|medium|high|xhigh|max)(?:\[1m\])?$/i

/** jev/ 网关自行设置推理强度，避免重复判断覆盖它的设置；名字里带档位的模型没有可选的强度。 */
export function isRoutedModel(model: string): boolean {
  return !/^jev\//i.test(model) && !LEVEL_IN_NAME.test(model) && (/opus|mythos/i.test(model) || openAIModelScale(model) !== null || isArgon(model))
}

/**
 * A model as the band names it: `claude-opus-5-5` → `Opus 5.5`,
 * `claude-fable-5-1[1m]` → `Fable 5.1 (1M)`, the alias `opus` → `Opus`.
 * Anything else (a gateway's `jev/…`, a provider's own id) as given.
 */
export function modelLabel(model: string): string {
  const id = CLAUDE_ID.exec(model)
  if (id) return `${title(id[1]!)} ${id[2]}${id[3] ? `.${id[3]}` : ''}${id[4] ? ' (1M)' : ''}`
  const alias = ALIAS.exec(model)
  if (alias) return `${title(alias[1]!)}${alias[2] ? ' (1M)' : ''}`
  return model
}
