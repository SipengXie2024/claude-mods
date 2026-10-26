import type { Register } from 'claude-code'

import { renderMath } from '../src/tex'

// Rewrites only the drawing of each reply block; the stored message and what
// the model reads keep the TeX as written.
export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    const text = renderMath(e.props.text, e.viewport?.columns)
    if (text === e.props.text) return next(e)
    return next({ ...e, props: { ...e.props, text } })
  })
}
