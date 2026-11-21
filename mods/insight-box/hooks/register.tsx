import type { Register } from 'claude-code'

import { splitInsight } from '../src/split'

// Rewrites only the drawing of a reply block; the stored message and what the
// model reads keep the text as written. Markdown cannot close a box, so the
// model writes a marked block and the border is drawn here, sized by the
// surface to its width, CJK included.
export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const found = splitInsight(e.props.text)
    if (!found) return next(e)

    const { Box, Text, Markdown } = $.ui.resolve(e)
    // The engine's own node keeps the reply's bullet and gutter; the box and
    // anything after it sit under the same gutter.
    const head = found.before ? await next({ ...e, props: { ...e.props, text: found.before } }) : null

    return (
      <Box flexDirection="column">
        {head}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="suggestion"
          paddingX={1}
          marginLeft={2}
          marginTop={found.before ? 1 : 0}
        >
          <Text color="suggestion" bold>
            ★ {found.title}
          </Text>
          {found.body ? <Markdown text={found.body} /> : null}
        </Box>
        {found.after ? (
          <Box marginLeft={2} marginTop={1}>
            <Markdown text={found.after} />
          </Box>
        ) : null}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
