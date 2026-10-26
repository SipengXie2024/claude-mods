import { describe, expect, test } from 'claude-code/testing'

import { renderFormula, renderMath } from '../src/tex'

const art = (src: string) => renderFormula(src).art.join('\n')

describe('inline formulas', () => {
  test('scripts use Unicode forms where they exist', () => {
    expect(renderMath('so $E = mc^2$ holds')).toBe('so E = mc² holds')
    expect(renderMath('$\\sum_{i=1}^{n} x_i$')).toBe('∑ᵢ₌₁ⁿ xᵢ')
  })
  test('a script without Unicode forms is written out', () => {
    expect(renderMath('$x^q$')).toBe('x^q')
    expect(renderMath('$e^{-x/2}$')).toBe('e^(−x/2)')
  })
  test('a script inside a script keeps its raised form', () => {
    expect(renderMath('$e^{-x^2}$')).toBe('e⁻ˣ²')
  })
  test('fractions are bracketed only where reading needs it', () => {
    expect(renderMath('$\\frac{1}{n}$')).toBe('1/n')
    expect(renderMath('$\\frac{a+b}{2}$')).toBe('(a + b)/2')
    expect(renderMath('$\\frac{P(B)}{P(A)}$')).toBe('P(B)/P(A)')
    expect(renderMath('$\\frac{\\partial u}{\\partial t}$')).toBe('∂u/(∂t)')
  })
  test('\\( \\) delimiters and fonts', () => {
    expect(renderMath('\\(x \\in \\mathbb{R}^n\\)')).toBe('x ∈ ℝⁿ')
  })
  test('markdown syntax in the result is escaped', () => {
    expect(renderMath('$|x|$ and $a_{i,j}$')).toBe('\\|x\\| and a\\_(i,j)')
  })
  test('thin spaces survive', () => {
    expect(renderMath('$\\int_0^1 f(x)\\,dx$')).toBe('∫₀¹ f(x) dx')
  })
})

describe('what stays as written', () => {
  test('prices and escaped dollars', () => {
    expect(renderMath('costs $5 or $10')).toBe('costs $5 or $10')
    expect(renderMath('from $5-$10')).toBe('from $5-$10')
    expect(renderMath('a \\$x\\$ b')).toBe('a \\$x\\$ b')
  })
  test('code spans and fenced code', () => {
    expect(renderMath('`$x^2$` and $x^2$')).toBe('`$x^2$` and x²')
    const fenced = '```tex\n$x^2$\n```\n$y^2$'
    expect(renderMath(fenced)).toBe('```tex\n$x^2$\n```\ny²')
  })
  test('a display block still streaming', () => {
    expect(renderMath('$a$ then $$\\frac{1}{')).toBe('a then $$\\frac{1}{')
  })
  test('text with no math is returned unchanged', () => {
    const s = 'plain *markdown* with a path C:\\temp'
    expect(renderMath(s)).toBe(s)
  })
})

describe('display formulas', () => {
  test('a display block on its own line becomes a fence of art', () => {
    expect(renderMath('see\n$$\n\\frac{a}{b}\n$$\nend')).toBe('see\n```\n a\n───\n b\n```\nend')
  })
  test('inside a list item the fence keeps the item indent', () => {
    expect(renderMath('1. x: $$\\frac{a}{b}$$ y')).toBe('1. x: \n   ```\n    a\n   ───\n    b\n   ```\n   y')
  })
  test('inside a blockquote each line keeps the marker', () => {
    expect(renderMath('> $$\n> \\frac{1}{2}\n> $$')).toBe('> ```\n>  1\n> ───\n>  2\n> ```')
  })
  test('in a table row it stays on one line', () => {
    expect(renderMath('| $$\\frac{1}{2}$$ |')).toBe('| 1/2 |')
  })
  test('in a table row an escaped pipe is a pipe', () => {
    expect(renderMath('| $\\|x\\|$ | $\\|v\\|$ |')).toBe('| \\|x\\| | \\|v\\| |')
  })
  test('a bare equation environment on its own lines', () => {
    expect(renderMath('\\begin{equation}\nE = mc^2\n\\end{equation}')).toBe('```\nE = mc²\n```')
  })
  test('wider than the reply, it is written on one line', () => {
    expect(renderMath('$$\\frac{a+b+c+d+e+f}{g}$$', 12)).toBe('(a + b + c + d + e + f)/g')
  })
  test('limits sit above and below a sum', () => {
    expect(art('\\sum_{i=1}^{n} i')).toBe(' n\n ∑  i\ni=1')
  })
  test('an integral grows with its integrand, not past the relation', () => {
    expect(art('\\int_0^1 \\frac{1}{x} dx = y')).toBe('⌠¹  1\n⎮  ─── dx = y\n⌡₀  x')
    expect(art('\\int_0^1 x\\,dx = \\frac{1}{2}')).toBe('            1\n∫₀¹ x dx = ───\n            2')
  })
  test('matrices and cases stretch their brackets', () => {
    expect(art('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}')).toBe('⎛ 1  2 ⎞\n⎝ 3  4 ⎠')
    expect(art('f = \\begin{cases} 1 & x > 0 \\\\ 0 & \\text{else} \\end{cases}')).toBe('f = ⎧ 1    x > 0\n    ⎩ 0    else')
  })
  test('aligned rows line up on the relation', () => {
    expect(art('\\begin{aligned} f(x) &= (x+1)^2 \\\\ &= x^2 + 2x + 1 \\end{aligned}')).toBe('f(x) = (x + 1)²\n     = x² + 2x + 1')
  })
  test('a superscript beside tall brackets keeps its Unicode form', () => {
    expect(art('\\left(\\frac{a}{b}\\right)^2')).toBe('⎛ a ⎞²\n⎜───⎟\n⎝ b ⎠')
  })
  test('square roots', () => {
    expect(art('\\sqrt{x^2+y^2}')).toBe(' _______\n√x² + y²')
  })
})
