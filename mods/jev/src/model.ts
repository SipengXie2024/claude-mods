/** A Claude id or alias with its 1M-context suffix: `claude-opus-5-5[1m]`, `claude-haiku-4-5-20251001`, `opus`. */
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i
const ALIAS = /^(opus|sonnet|haiku|fable|mythos)(\[1m\])?$/i

const title = (family: string) => family[0]!.toUpperCase() + family.slice(1).toLowerCase()

export type OpenAIModelScale = 'astra' | 'astra-6.2' | 'sol-6.1' | 'sol-6.2'

/** Magpie 使用 provider/model 标识；Hermes 的 Astra 标识还带有上下文长度。 */
export function openAIModelScale(model: string | null): OpenAIModelScale | null {
  const id = model?.split('/').at(-1) ?? ''
  if (/^gpt-6-astra(?:-900k)?(?:\[1m\])?$/i.test(id)) return 'astra'
  if (/^gpt-6\.2-astra(?:-900k)?(?:\[1m\])?$/i.test(id)) return 'astra-6.2'
  if (/^gpt-6\.1-sol(?:\[1m\])?$/i.test(id)) return 'sol-6.1'
  if (/^gpt-6\.2-sol(?:\[1m\])?$/i.test(id)) return 'sol-6.2'
  return null
}

export type GeminiModelScale = 'argon' | 'carbon' | 'neon' | 'hydrogen'

/**
 * Gemini 4 under Magpie's `hakimi` (sub2api) or `antigravity` provider, by its bare ID
 * (`hakimi/gemini-4-carbon`, `antigravity/gemini-4-argon-trial`). Argon and Carbon offer
 * low / medium / high; Neon and Hydrogen add xhigh. A higher request runs at the top level.
 */
export function geminiModelScale(model: string | null): GeminiModelScale | null {
  const id = /(?:^|\/)gemini-4-(argon(?:-trial)?|carbon|neon|hydrogen)(?:\[1m\])?$/i.exec(model ?? '')
  if (!id) return null
  const name = id[1]!.toLowerCase()
  return name === 'argon-trial' ? 'argon' : (name as GeminiModelScale)
}

/**
 * A model whose ID ends in a reasoning level (`hakimi/gemini-4-argon-high`, `hakimi/claude-opus-5-5-medium`)
 * runs at that level whatever effort the request carries: the Antigravity upstream takes the level from
 * the model name. The bare ID (`hakimi/gemini-4-carbon`) is the one whose level the request's effort picks.
 */
const LEVEL_IN_NAME = /-(?:minimal|low|medium|high|xhigh|max)(?:\[1m\])?$/i

/** jev/ 网关自行设置推理强度，避免重复判断覆盖它的设置；名字里带档位的模型没有可选的强度。 */
export function isRoutedModel(model: string): boolean {
  return !/^jev\//i.test(model) && !LEVEL_IN_NAME.test(model) && (/opus|mythos/i.test(model) || openAIModelScale(model) !== null || geminiModelScale(model) !== null)
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
