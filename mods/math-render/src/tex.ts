// TeX math in a markdown reply, drawn as Unicode text for a terminal.
//
// `renderMath` finds math spans outside code (`$…$`, `\(…\)`, `$$…$$`, `\[…\]`
// and bare display environments) and replaces each with plain text: inline
// math becomes one line of Unicode, display math a fenced block of character
// art (fractions stacked, limits above and below, stretched delimiters).
// The result is still markdown, so inline output escapes markdown syntax and
// display art sits in a fence, where runs of spaces survive.

// `inner` is a fraction: kept a gap apart from plain neighbours.
type Cls = 'ord' | 'op' | 'fn' | 'bin' | 'rel' | 'punct' | 'open' | 'close' | 'space' | 'inner'

type Accent =
  | 'hat' | 'tilde' | 'bar' | 'vec' | 'dot' | 'ddot' | 'acute' | 'grave'
  | 'breve' | 'check' | 'ring' | 'underline'

type GridKind = 'matrix' | 'align' | 'cases' | 'gather'

type Node =
  | { k: 'sym'; s: string; c: Cls; limits?: boolean; int?: boolean }
  | { k: 'row'; items: Node[] }
  | { k: 'text'; s: string }
  | { k: 'script'; base: Node; sub?: Node; sup?: Node }
  | { k: 'frac'; num: Node; den: Node }
  | { k: 'binom'; top: Node; bottom: Node }
  | { k: 'sqrt'; body: Node; index?: Node }
  | { k: 'accent'; a: Accent; body: Node }
  | { k: 'delim'; l: string; r: string; body: Node }
  | { k: 'grid'; rows: Node[][]; kind: GridKind; l: string; r: string }
  | { k: 'stack'; body: Node; over?: Node; under?: Node }
  | { k: 'brace'; body: Node; up: boolean; label?: Node }
  | { k: 'boxed'; body: Node }

const sym = (s: string, c: Cls = 'ord'): Node => ({ k: 'sym', s, c })
const row = (items: Node[]): Node => ({ k: 'row', items })

// ---------------------------------------------------------------- symbols

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  varkappa: 'ϰ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π',
  varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

const BIN: Record<string, string> = {
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '⋅', ast: '∗', star: '⋆',
  circ: '∘', bullet: '∙', oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘',
  odot: '⊙', cup: '∪', cap: '∩', sqcup: '⊔', sqcap: '⊓', uplus: '⊎',
  wedge: '∧', land: '∧', vee: '∨', lor: '∨', setminus: '∖', smallsetminus: '∖',
  wr: '≀', diamond: '⋄', triangleleft: '◁', triangleright: '▷', amalg: '⨿',
  dagger: '†', ddagger: '‡', cdotp: '⋅', ltimes: '⋉', rtimes: '⋊',
  boxplus: '⊞', boxtimes: '⊠',
}

const REL: Record<string, string> = {
  le: '≤', leq: '≤', ge: '≥', geq: '≥', leqslant: '⩽', geqslant: '⩾',
  ne: '≠', neq: '≠', approx: '≈', approxeq: '≊', equiv: '≡', sim: '∼',
  simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫', lll: '⋘', ggg: '⋙',
  subset: '⊂', subseteq: '⊆', subsetneq: '⊊', supset: '⊃', supseteq: '⊇',
  supsetneq: '⊋', sqsubseteq: '⊑', sqsupseteq: '⊒', in: '∈', notin: '∉',
  ni: '∋', owns: '∋', mid: '∣', nmid: '∤', parallel: '∥', nparallel: '∦',
  perp: '⊥', to: '→', rightarrow: '→', leftarrow: '←', gets: '←',
  Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
  iff: '⟺', implies: '⟹', impliedby: '⟸', mapsto: '↦', longmapsto: '⟼',
  longrightarrow: '⟶', longleftarrow: '⟵', Longrightarrow: '⟹',
  Longleftarrow: '⟸', longleftrightarrow: '⟷', Longleftrightarrow: '⟺',
  hookrightarrow: '↪', hookleftarrow: '↩', rightharpoonup: '⇀',
  leftharpoonup: '↼', rightleftharpoons: '⇌', uparrow: '↑', downarrow: '↓',
  Uparrow: '⇑', Downarrow: '⇓', updownarrow: '↕', nearrow: '↗', searrow: '↘',
  swarrow: '↙', nwarrow: '↖', vdash: '⊢', dashv: '⊣', models: '⊨',
  vDash: '⊨', prec: '≺', succ: '≻', preceq: '⪯', succeq: '⪰', doteq: '≐',
  triangleq: '≜', coloneqq: '≔', eqqcolon: '≕', coloneq: '≔', lesssim: '≲',
  gtrsim: '≳', asymp: '≍', bowtie: '⋈', smile: '⌣', frown: '⌢', nless: '≮',
  ngtr: '≯', nleq: '≰', ngeq: '≱', nsim: '≁', ncong: '≇', nsubseteq: '⊈',
  nsupseteq: '⊉', lhd: '⊲', rhd: '⊳', unlhd: '⊴', unrhd: '⊵', propersubset: '⊂',
  leftrightarrows: '⇆', rightleftarrows: '⇄', circeq: '≗', backsim: '∽',
  therefore: '∴', because: '∵', Join: '⨝',
}

const ORD: Record<string, string> = {
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃',
  nexists: '∄', emptyset: '∅', varnothing: '∅', aleph: 'ℵ', beth: 'ℶ',
  hbar: 'ℏ', hslash: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', wp: '℘', angle: '∠',
  measuredangle: '∡', triangle: '△', square: '□', Box: '□', blacksquare: '■',
  top: '⊤', bot: '⊥', dots: '…', ldots: '…', cdots: '⋯', vdots: '⋮',
  ddots: '⋱', prime: '′', degree: '°', checkmark: '✓', S: '§', P: '¶',
  neg: '¬', lnot: '¬', flat: '♭', sharp: '♯', natural: '♮', clubsuit: '♣',
  diamondsuit: '♢', heartsuit: '♡', spadesuit: '♠', imath: 'ı', jmath: 'ȷ',
  complement: '∁', mho: '℧', eth: 'ð', surd: '√', backslash: '∖',
  lozenge: '◊', star: '⋆', bigstar: '★', dag: '†', ddag: '‡', copyright: '©',
  circledR: '®', pounds: '£', yen: '¥', euro: '€', textbackslash: '∖',
}

const OPEN: Record<string, string> = {
  langle: '⟨', lceil: '⌈', lfloor: '⌊', lbrace: '{', lbrack: '[', lvert: '|',
  lVert: '‖', ulcorner: '⌜', llcorner: '⌞', lgroup: '(', '{': '{',
}

const CLOSE: Record<string, string> = {
  rangle: '⟩', rceil: '⌉', rfloor: '⌋', rbrace: '}', rbrack: ']', rvert: '|',
  rVert: '‖', urcorner: '⌝', lrcorner: '⌟', rgroup: ')', '}': '}',
}

// Big operators; integrals take their limits beside, the rest above and below.
const BIGOP: Record<string, string> = {
  sum: '∑', prod: '∏', coprod: '∐', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁',
  bigotimes: '⨂', bigodot: '⨀', bigvee: '⋁', bigwedge: '⋀', bigsqcup: '⨆',
  biguplus: '⨄',
}

const INTOP: Record<string, string> = {
  int: '∫', iint: '∬', iiint: '∭', oint: '∮', oiint: '∯', intop: '∫',
  smallint: '∫',
}

// Function names drawn upright; `true` puts their scripts above and below.
const FN: Record<string, boolean> = {
  sin: false, cos: false, tan: false, cot: false, sec: false, csc: false,
  arcsin: false, arccos: false, arctan: false, sinh: false, cosh: false,
  tanh: false, coth: false, log: false, ln: false, lg: false, exp: false,
  dim: false, ker: false, deg: false, hom: false, arg: false, sgn: false,
  det: true, gcd: true, lim: true, liminf: true, limsup: true, max: true,
  min: true, sup: true, inf: true, Pr: true, injlim: true, projlim: true,
  argmax: true, argmin: true,
}

const FN_NAME: Record<string, string> = {
  liminf: 'lim inf', limsup: 'lim sup', injlim: 'inj lim', projlim: 'proj lim',
  argmax: 'arg max', argmin: 'arg min',
}

const SPACE: Record<string, string> = {
  ',': ' ', ':': ' ', ';': ' ', '>': ' ', ' ': ' ', '!': '', quad: '  ',
  qquad: '    ', enspace: ' ', thinspace: ' ', medspace: ' ',
  thickspace: ' ', negthinspace: '', enskip: ' ', space: ' ',
}

// \not over a relation.
const NEGATED: Record<string, string> = {
  '=': '≠', '<': '≮', '>': '≯', '≤': '≰', '≥': '≱', '∈': '∉', '∋': '∌',
  '⊂': '⊄', '⊃': '⊅', '⊆': '⊈', '⊇': '⊉', '≡': '≢', '∼': '≁', '≅': '≇',
  '≈': '≉', '∣': '∤', '∥': '∦', '≺': '⊀', '≻': '⊁', '⊢': '⊬', '⊨': '⊭',
  '→': '↛', '←': '↚', '↔': '↮', '⇒': '⇏', '⇐': '⇍', '⇔': '⇎', '∃': '∄',
}

const ACCENTS: Record<string, Accent> = {
  hat: 'hat', widehat: 'hat', tilde: 'tilde', widetilde: 'tilde', bar: 'bar',
  overline: 'bar', vec: 'vec', overrightarrow: 'vec', dot: 'dot',
  ddot: 'ddot', acute: 'acute', grave: 'grave', breve: 'breve',
  check: 'check', widecheck: 'check', mathring: 'ring', underline: 'underline',
}

const COMBINING: Record<Accent, string> = {
  hat: '̂', tilde: '̃', bar: '̅', vec: '⃗', dot: '̇',
  ddot: '̈', acute: '́', grave: '̀', breve: '̆',
  check: '̌', ring: '̊', underline: '̲',
}

// The mark drawn on the row above (below for underline) a wider body.
const ACCENT_MARK: Record<Accent, string> = {
  hat: '^', tilde: '~', bar: '_', vec: '→', dot: '·', ddot: '¨', acute: '´',
  grave: '`', breve: '˘', check: 'ˇ', ring: '°', underline: '‾',
}

const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
  '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼',
  '(': '⁽', ')': '⁾', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ',
  g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ',
  p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ',
  z: 'ᶻ', A: 'ᴬ', B: 'ᴮ', D: 'ᴰ', E: 'ᴱ', G: 'ᴳ', H: 'ᴴ', I: 'ᴵ', J: 'ᴶ',
  K: 'ᴷ', L: 'ᴸ', M: 'ᴹ', N: 'ᴺ', O: 'ᴼ', P: 'ᴾ', R: 'ᴿ', T: 'ᵀ', U: 'ᵁ',
  V: 'ⱽ', W: 'ᵂ', 'β': 'ᵝ', 'γ': 'ᵞ', 'δ': 'ᵟ', 'θ': 'ᶿ', 'φ': 'ᵠ', 'ϕ': 'ᵠ',
  'χ': 'ᵡ', 'ι': 'ᶥ', '′': '′', '″': '″', '‴': '‴', '∗': '*', '⊤': 'ᵀ',
  '†': '†', '‡': '‡', '∘': '°',
}

const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
  '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌',
  '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ',
  m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ',
  x: 'ₓ', 'β': 'ᵦ', 'γ': 'ᵧ', 'ρ': 'ᵨ', 'φ': 'ᵩ', 'ϕ': 'ᵩ', 'χ': 'ᵪ',
}

// A script inside a script keeps its raised or lowered form: e^{-x^2} → e⁻ˣ².
for (const map of [SUP, SUB]) for (const v of Object.values(map)) map[v] ??= v

type Font = 'bb' | 'cal' | 'frak' | 'bf' | 'plain'

const FONTS: Record<string, Font> = {
  mathbb: 'bb', Bbb: 'bb', mathcal: 'cal', mathscr: 'cal', mathfrak: 'frak',
  mathbf: 'bf', boldsymbol: 'bf', bm: 'bf', mathit: 'plain', mathsf: 'plain',
  mathtt: 'plain', mathnormal: 'plain',
}

// Letters of a font that Unicode keeps in the Letterlike Symbols block.
const FONT_HOLES: Record<Font, Record<string, string>> = {
  bb: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
  cal: {
    B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ',
    e: 'ℯ', g: 'ℊ', o: 'ℴ',
  },
  frak: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' },
  bf: {},
  plain: {},
}

const FONT_BASE: Record<Font, [upper: number, lower: number, digit: number]> = {
  bb: [0x1d538, 0x1d552, 0x1d7d8],
  cal: [0x1d49c, 0x1d4b6, 0],
  frak: [0x1d504, 0x1d51e, 0],
  bf: [0x1d400, 0x1d41a, 0x1d7ce],
  plain: [0, 0, 0],
}

function fontChar(ch: string, font: Font): string {
  const hole = FONT_HOLES[font][ch]
  if (hole) return hole
  const [upper, lower, digit] = FONT_BASE[font]
  const code = ch.charCodeAt(0)
  if (upper && ch >= 'A' && ch <= 'Z') return String.fromCodePoint(upper + code - 65)
  if (lower && ch >= 'a' && ch <= 'z') return String.fromCodePoint(lower + code - 97)
  if (digit && ch >= '0' && ch <= '9') return String.fromCodePoint(digit + code - 48)
  return ch
}

function charSym(ch: string): Node {
  switch (ch) {
    case '+': return sym('+', 'bin')
    case '-': return sym('−', 'bin')
    case '*': return sym('∗', 'bin')
    case '=': case '<': case '>': case ':': return sym(ch, 'rel')
    case ',': case ';': return sym(ch, 'punct')
    case '(': case '[': return sym(ch, 'open')
    case ')': case ']': return sym(ch, 'close')
    case '\'': return sym('′')
    case '~': return sym(' ', 'space')
    default: return sym(ch)
  }
}

// ---------------------------------------------------------------- parser

type Tok = { t: 'cmd' | 'ch'; v: string }

function tokenize(src: string): Tok[] {
  const cs = Array.from(src)
  const out: Tok[] = []
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!
    if (c !== '\\') {
      out.push({ t: 'ch', v: c })
      continue
    }
    const n = cs[i + 1]
    if (n === undefined) {
      out.push({ t: 'ch', v: '\\' })
      continue
    }
    if (/[A-Za-z]/.test(n)) {
      let j = i + 1
      let name = ''
      while (j < cs.length && /[A-Za-z]/.test(cs[j]!)) name += cs[j++]
      out.push({ t: 'cmd', v: name })
      i = j - 1
    } else {
      out.push({ t: 'cmd', v: n })
      i++
    }
  }
  return out
}

const isSpace = (t: Tok | undefined) => t?.t === 'ch' && /\s/.test(t.v)
const isCh = (t: Tok | undefined, v: string) => t?.t === 'ch' && t.v === v
const isCmd = (t: Tok | undefined, v: string) => t?.t === 'cmd' && t.v === v

const ROW_STOP = (t: Tok) =>
  isCh(t, '}') || isCh(t, '&') || isCmd(t, '\\') || isCmd(t, 'cr') ||
  isCmd(t, 'right') || isCmd(t, 'end')

const GRID_KINDS: Record<string, [GridKind, string, string]> = {
  matrix: ['matrix', '', ''], smallmatrix: ['matrix', '', ''],
  pmatrix: ['matrix', '(', ')'], bmatrix: ['matrix', '[', ']'],
  Bmatrix: ['matrix', '{', '}'], vmatrix: ['matrix', '|', '|'],
  Vmatrix: ['matrix', '‖', '‖'], array: ['matrix', '', ''],
  subarray: ['gather', '', ''], cases: ['cases', '{', ''],
  dcases: ['cases', '{', ''], rcases: ['cases', '', '}'],
  aligned: ['align', '', ''], align: ['align', '', ''],
  alignat: ['align', '', ''], alignedat: ['align', '', ''],
  split: ['align', '', ''], eqnarray: ['align', '', ''], flalign: ['align', '', ''],
  gathered: ['gather', '', ''], gather: ['gather', '', ''],
  multline: ['gather', '', ''], equation: ['gather', '', ''],
  displaymath: ['gather', '', ''], math: ['gather', '', ''],
}

class Parser {
  private i = 0
  tag: string | undefined

  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined {
    while (isSpace(this.toks[this.i])) this.i++
    return this.toks[this.i]
  }

  private next(): Tok | undefined {
    const t = this.peek()
    if (t) this.i++
    return t
  }

  // The raw text of a `{…}` argument, braces balanced, for \text and names.
  private rawArg(): string {
    if (!isCh(this.peek(), '{')) {
      const t = this.next()
      return t ? (t.t === 'cmd' ? `\\${t.v}` : t.v) : ''
    }
    this.i++
    let depth = 0
    let s = ''
    for (; this.i < this.toks.length; this.i++) {
      const t = this.toks[this.i]!
      if (isCh(t, '{')) depth++
      if (isCh(t, '}')) {
        if (depth === 0) break
        depth--
      }
      s += t.t === 'cmd' ? (/[A-Za-z]/.test(t.v) ? `\\${t.v} ` : `\\${t.v}`) : t.v
    }
    this.i++
    return s
  }

  private optArg(): Node | undefined {
    if (!isCh(this.peek(), '[')) return undefined
    this.i++
    const items: Node[] = []
    while (this.peek() && !isCh(this.peek(), ']')) {
      const n = this.scripted()
      if (n) items.push(n)
    }
    this.i++
    return row(items)
  }

  parseTop(): Node {
    const g = this.grid(undefined)
    if (g.length === 1 && g[0]!.length === 1) return g[0]![0]!
    const kind = g.some(r => r.length > 1) ? 'align' : 'gather'
    return { k: 'grid', rows: g, kind, l: '', r: '' }
  }

  // A cell row up to the next `&`, `\\`, `}`, `\right` or `\end`.
  private row(): Node {
    const items: Node[] = []
    for (let t = this.peek(); t && !ROW_STOP(t); t = this.peek()) {
      const n = this.scripted()
      if (n) items.push(n)
    }
    return row(items)
  }

  private group(): Node {
    this.i++ // {
    const items: Node[] = []
    for (let t = this.peek(); t && !isCh(t, '}'); t = this.peek()) {
      if (ROW_STOP(t)) {
        // `&`, `\\`, `\right` or `\end` inside braces with no environment.
        this.i++
        if (isCmd(t, 'end')) this.rawArg()
        else if (isCmd(t, 'right')) this.delimTok()
        else items.push(sym(' ', 'space'))
        continue
      }
      const n = this.scripted()
      if (n) items.push(n)
    }
    this.i++ // }
    return row(items)
  }

  // Rows of cells until `\end{name}` (or the end of input at top level).
  private grid(name: string | undefined): Node[][] {
    const rows: Node[][] = []
    let cells: Node[] = []
    let cell: Node[] = []
    const endCell = () => {
      cells.push(row(cell))
      cell = []
    }
    const endRow = () => {
      endCell()
      rows.push(cells)
      cells = []
    }
    for (;;) {
      cell.push(...rowItems(this.row()))
      const t = this.peek()
      if (t === undefined) {
        endRow()
        break
      }
      if (isCh(t, '&')) {
        this.i++
        endCell()
        continue
      }
      if (isCmd(t, '\\') || isCmd(t, 'cr')) {
        this.i++
        this.rowSkip()
        endRow()
        continue
      }
      if (name !== undefined) {
        if (isCmd(t, 'end')) {
          this.i++
          this.rawArg()
        } else if (isCh(t, '}') && name === 'substack') this.i++
        endRow()
        break
      }
      // Top level: a stray `}`, `\right` or `\end{…}` is dropped.
      this.i++
      if (isCmd(t, 'end')) this.rawArg()
      else if (isCmd(t, 'right')) this.delimTok()
    }
    const empty = (r: Node[]) => r.every(c => rowItems(c).length === 0)
    while (rows.length > 1 && empty(rows[rows.length - 1]!)) rows.pop()
    return rows
  }

  // The `[2pt]` that may follow `\\`; a bracket holding anything else is math.
  private rowSkip() {
    if (!isCh(this.peek(), '[')) return
    let j = this.i
    let s = ''
    while (j < this.toks.length && !isCh(this.toks[j], ']') && j - this.i < 16) s += this.toks[j++]!.v
    if (isCh(this.toks[j], ']') && /^\[\s*-?[\d.]+\s*[a-z]{2}\s*$/.test(s)) this.i = j + 1
  }

  private delimTok(): string {
    const t = this.next()
    if (!t) return ''
    if (t.t === 'ch') return t.v === '.' ? '' : t.v
    const s = OPEN[t.v] ?? CLOSE[t.v] ?? REL[t.v] ?? ORD[t.v]
    if (s) return s
    if (t.v === '|' || t.v === 'Vert') return '‖'
    if (t.v === 'vert') return '|'
    return t.v
  }

  private arg(): Node {
    if (isCh(this.peek(), '{')) return this.group()
    return this.atom() ?? row([])
  }

  scripted(): Node | undefined {
    let base = this.atom()
    if (base === undefined) return undefined
    let sub: Node | undefined
    let sup: Node | undefined
    const primes: Node[] = []
    for (;;) {
      const t = this.peek()
      if (isCh(t, '^')) {
        this.i++
        sup = this.arg()
      } else if (isCh(t, '_')) {
        this.i++
        sub = this.arg()
      } else if (isCh(t, '\'')) {
        this.i++
        primes.push(sym('′'))
      } else if (isCmd(t, 'limits') || isCmd(t, 'nolimits')) {
        this.i++
        if (base.k === 'sym') base = { ...base, limits: t!.v === 'limits' }
      } else break
    }
    if (primes.length) sup = row([...primes, ...(sup ? [sup] : [])])
    if (base.k === 'brace' && (base.up ? sup : sub)) {
      const label = base.up ? sup : sub
      base = { ...base, label }
      if (base.up) sup = undefined
      else sub = undefined
    }
    if (!sub && !sup) return base
    return { k: 'script', base, sub, sup }
  }

  private atom(): Node | undefined {
    const t = this.next()
    if (!t) return undefined
    if (t.t === 'ch') {
      if (t.v === '{') {
        this.i--
        return this.group()
      }
      if (t.v === '^' || t.v === '_') {
        this.i--
        return row([])
      }
      if (t.v === '&') return sym(' ', 'space')
      return charSym(t.v)
    }
    return this.command(t.v)
  }

  private command(c: string): Node | undefined {
    if (c in GREEK) return sym(GREEK[c]!)
    if (c in BIGOP) return { k: 'sym', s: BIGOP[c]!, c: 'op', limits: true }
    if (c in INTOP) return { k: 'sym', s: INTOP[c]!, c: 'op', limits: false, int: c !== 'iint' && c !== 'iiint' && c !== 'oiint' }
    if (c in FN) return { k: 'sym', s: FN_NAME[c] ?? c, c: 'fn', limits: FN[c] }
    if (c in BIN) return sym(BIN[c]!, 'bin')
    if (c in REL) return sym(REL[c]!, 'rel')
    if (c in OPEN) return sym(OPEN[c]!, 'open')
    if (c in CLOSE) return sym(CLOSE[c]!, 'close')
    if (c in ORD) return sym(ORD[c]!)
    if (c in SPACE) return sym(SPACE[c]!, 'space')
    if (c in ACCENTS) return { k: 'accent', a: ACCENTS[c]!, body: this.arg() }
    if (c in FONTS) return applyFont(this.arg(), FONTS[c]!)
    switch (c) {
      case '|': return sym('‖')
      case '#': case '$': case '%': case '&': case '_': return sym(c)
      case '\\': case 'cr': case 'newline': return sym(' ', 'space')
      case 'vert': return sym('|')
      case 'Vert': return sym('‖')
      case 'colon': return sym(':', 'punct')
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac':
        return { k: 'frac', num: this.arg(), den: this.arg() }
      case 'binom': case 'dbinom': case 'tbinom': case 'choose':
        return { k: 'binom', top: this.arg(), bottom: this.arg() }
      case 'sqrt': {
        const index = this.optArg()
        return { k: 'sqrt', index, body: this.arg() }
      }
      case 'left': {
        const l = this.delimTok()
        const body = this.inner()
        let r = ''
        if (isCmd(this.peek(), 'right')) {
          this.i++
          r = this.delimTok()
        }
        return { k: 'delim', l, r, body }
      }
      case 'middle': return sym(this.delimTok(), 'rel')
      case 'big': case 'Big': case 'bigg': case 'Bigg':
      case 'bigl': case 'Bigl': case 'biggl': case 'Biggl':
        return sym(this.delimTok(), 'open')
      case 'bigr': case 'Bigr': case 'biggr': case 'Biggr':
        return sym(this.delimTok(), 'close')
      case 'bigm': case 'Bigm': case 'biggm': case 'Biggm':
        return sym(this.delimTok(), 'rel')
      case 'text': case 'textrm': case 'textnormal': case 'mbox': case 'hbox':
      case 'textit': case 'textbf': case 'textsf': case 'texttt': case 'emph':
      case 'textup': case 'textmd':
        return { k: 'text', s: textOf(this.rawArg()) }
      case 'mathrm': case 'mathup': return this.arg()
      case 'operatorname': {
        const star = isCh(this.peek(), '*')
        if (star) this.i++
        return { k: 'sym', s: textOf(this.rawArg()), c: 'fn', limits: star }
      }
      case 'mathop': {
        const body = this.arg()
        const s = linear(body, true)
        return { k: 'sym', s, c: 'op', limits: true }
      }
      case 'mathbin': return { ...asSym(this.arg()), c: 'bin' }
      case 'mathrel': return { ...asSym(this.arg()), c: 'rel' }
      case 'mathord': case 'mathinner': return this.arg()
      case 'displaystyle': case 'textstyle': case 'scriptstyle':
      case 'scriptscriptstyle': case 'nonumber': case 'notag': case 'hline':
      case 'limits': case 'nolimits': case 'strut': case 'mathstrut':
      case 'allowbreak': case 'nobreak': case 'relax': case 'rm': case 'bf':
      case 'it': case 'cal': case 'sf': case 'tt': case 'end': case 'right':
        return undefined
      case 'label': case 'phantom': case 'vphantom': case 'hphantom': case 'hspace':
      case 'vspace': case 'kern': case 'mkern': case 'mskip': case 'hskip':
        this.rawArg()
        return c === 'hspace' || c === 'phantom' || c === 'hphantom' ? sym(' ', 'space') : undefined
      case 'tag': {
        const star = isCh(this.peek(), '*')
        if (star) this.i++
        const s = textOf(this.rawArg())
        this.tag = star ? s : `(${s})`
        return undefined
      }
      case 'color': case 'textcolor': {
        this.rawArg()
        return c === 'textcolor' ? this.arg() : undefined
      }
      case 'colorbox': case 'fcolorbox': {
        this.rawArg()
        if (c === 'fcolorbox') this.rawArg()
        return this.arg()
      }
      case 'boxed': case 'fbox': return { k: 'boxed', body: this.arg() }
      case 'not': {
        const n = this.atom()
        if (n?.k === 'sym') return sym(NEGATED[n.s] ?? `${n.s}̸`, n.c)
        return n
      }
      case 'pmod': {
        const n = this.arg()
        return row([sym(' ', 'space'), sym('('), sym('mod'), sym(' ', 'space'), n, sym(')')])
      }
      case 'bmod': case 'mod': return { k: 'sym', s: 'mod', c: 'bin' }
      case 'overset': case 'stackrel': {
        const over = this.arg()
        return { k: 'stack', over, body: this.arg() }
      }
      case 'underset': {
        const under = this.arg()
        return { k: 'stack', under, body: this.arg() }
      }
      case 'xrightarrow': case 'xleftarrow': case 'xRightarrow': case 'xLeftarrow':
      case 'xmapsto': case 'xlongequal': {
        const under = this.optArg()
        const over = this.arg()
        const arrow = { xrightarrow: '→', xleftarrow: '←', xRightarrow: '⇒', xLeftarrow: '⇐', xmapsto: '↦', xlongequal: '=' }[c]
        return { k: 'stack', over, under, body: { k: 'sym', s: arrow, c: 'rel' } }
      }
      case 'overbrace': return { k: 'brace', body: this.arg(), up: true }
      case 'underbrace': return { k: 'brace', body: this.arg(), up: false }
      case 'substack': {
        if (isCh(this.peek(), '{')) this.i++
        const rows = this.grid('substack')
        return { k: 'grid', rows, kind: 'gather', l: '', r: '' }
      }
      case 'begin': {
        const name = this.rawArg().replace(/\*$/, '')
        if (name === 'array' || name === 'subarray' || name === 'tabular') this.rawArg()
        if (name === 'alignat' || name === 'alignedat') this.rawArg()
        const [kind, l, r] = GRID_KINDS[name] ?? ['matrix', '', '']
        const rows = this.grid(name)
        if (rows.length === 1 && rows[0]!.length === 1 && kind === 'gather') return rows[0]![0]
        return { k: 'grid', rows, kind, l, r }
      }
      default:
        return sym(c.length === 1 ? c : `\\${c}`)
    }
  }

  // The body of \left … \right: a row, or a grid when it holds `\\`.
  private inner(): Node {
    const items: Node[] = []
    for (let t = this.peek(); t && !isCmd(t, 'right') && !isCh(t, '}') && !isCmd(t, 'end'); t = this.peek()) {
      if (isCh(t, '&') || isCmd(t, '\\')) {
        this.i++
        items.push(sym(' ', 'space'))
        continue
      }
      const n = this.scripted()
      if (n) items.push(n)
    }
    return row(items)
  }
}

function rowItems(n: Node): Node[] {
  return n.k === 'row' ? n.items : [n]
}

function asSym(n: Node): Node & { k: 'sym' } {
  return { k: 'sym', s: linear(n, true), c: 'ord' }
}

// \text{…}: the words as written, a nested `$…$` without its dollars.
function textOf(raw: string): string {
  return raw.replace(/\\([{}$%&#_ ])/g, '$1').replace(/\$/g, '').replace(/\\[A-Za-z]+ ?/g, m => {
    const name = m.trim().slice(1)
    return GREEK[name] ?? ORD[name] ?? REL[name] ?? BIN[name] ?? (name === 'quad' ? '  ' : '')
  }).replace(/~/g, ' ')
}

function applyFont(n: Node, font: Font): Node {
  switch (n.k) {
    case 'sym': return n.c === 'ord' ? { ...n, s: Array.from(n.s).map(ch => fontChar(ch, font)).join('') } : n
    case 'row': return row(n.items.map(m => applyFont(m, font)))
    case 'script': return { ...n, base: applyFont(n.base, font) }
    default: return n
  }
}

// ---------------------------------------------------------------- width

function charWidth(cp: number): number {
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200b || cp === 0x200d) return 0
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2
  return 1
}

export function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0)!)
  return w
}

// ---------------------------------------------------------------- spacing

type Side = { l: Cls; r: Cls }

function sides(n: Node): Side {
  switch (n.k) {
    case 'sym': return { l: n.c, r: n.c }
    case 'script': return sides(n.base)
    case 'delim': return { l: n.l ? 'open' : 'ord', r: n.r ? 'close' : 'ord' }
    case 'row': {
      if (n.items.length === 0) return { l: 'ord', r: 'ord' }
      return { l: sides(n.items[0]!).l, r: sides(n.items[n.items.length - 1]!).r }
    }
    case 'stack': return sides(n.body)
    case 'frac': case 'binom': return { l: 'inner', r: 'inner' }
    default: return { l: 'ord', r: 'ord' }
  }
}

// The gap between neighbours: around relations and binary operators, after
// punctuation, and between a function name and a plain argument.
function gap(p: Cls | undefined, c: Cls, script: boolean): string {
  if (p === undefined || p === 'space' || c === 'space' || script) return ''
  if (p === 'rel' && c === 'rel') return ''
  if (p === 'rel' || c === 'rel') return p === 'open' || c === 'close' ? '' : ' '
  if (p === 'bin' || c === 'bin') return ' '
  if (p === 'punct') return c === 'close' ? '' : ' '
  if (p === 'inner') return c === 'close' || c === 'punct' ? '' : ' '
  if (c === 'inner') return p === 'open' ? '' : ' '
  if (p === 'fn') return c === 'open' || c === 'close' || c === 'punct' ? '' : ' '
  if (c === 'fn') return p === 'ord' || p === 'close' || p === 'op' ? ' ' : ''
  if (p === 'op') return c === 'close' || c === 'punct' ? '' : ' '
  if (c === 'op') return p === 'ord' || p === 'close' ? ' ' : ''
  return ''
}

// A binary operator at the start, or after another operator, is unary.
function spaced(items: Node[], script: boolean): { n: Node; pre: string }[] {
  const out: { n: Node; pre: string }[] = []
  let prev: Cls | undefined
  for (const n of items) {
    let { l, r } = sides(n)
    if (l === 'bin' && (prev === undefined || prev === 'bin' || prev === 'rel' || prev === 'open' || prev === 'punct' || prev === 'op' || prev === 'fn')) {
      l = 'ord'
      if (n.k === 'sym' || n.k === 'script') r = 'ord'
    }
    out.push({ n, pre: gap(prev, l, script) })
    prev = r
  }
  return out
}

// Plain brackets around something tall stretch, as \left … \right would.
function groupDelims(items: Node[]): Node[] {
  const out: Node[] = []
  const opens: number[] = []
  for (const n of items) {
    const bare = n.k === 'script' ? n.base : n
    if (bare.k === 'sym' && bare.c === 'open' && n.k === 'sym') {
      opens.push(out.length)
      out.push(n)
      continue
    }
    if (bare.k === 'sym' && bare.c === 'close' && opens.length) {
      const at = opens.pop()!
      const open = out[at] as Node & { k: 'sym' }
      const body = row(out.splice(at + 1))
      out.pop()
      const d: Node = { k: 'delim', l: open.s, r: bare.s, body }
      out.push(n.k === 'script' ? { ...n, base: d } : d)
      continue
    }
    out.push(n)
  }
  return out
}

// ---------------------------------------------------------------- linear

function compact(n: Node, map: Record<string, string>): string | undefined {
  const s = linear(n, true)
  let out = ''
  for (const ch of s) {
    const m = map[ch]
    if (m === undefined) return undefined
    out += m
  }
  return out
}

// Whether a node's one-line form has a gap outside its own brackets.
function spreads(n: Node): boolean {
  switch (n.k) {
    case 'row': {
      const parts = spaced(groupDelims(n.items), false)
      return parts.length === 1
        ? spreads(parts[0]!.n)
        : parts.some(p => p.pre !== '' || spreads(p.n) || (p.n.k === 'sym' && p.n.c === 'space'))
    }
    case 'text': return n.s.includes(' ')
    case 'sym': return n.c === 'space' || n.s.includes(' ')
    case 'frac': case 'grid': return true
    default: return false
  }
}

// A numerator needs brackets when it spreads; a denominator also when it is
// a product (`(∂t²)`), but not a single call like `P(B)`.
function needsParens(n: Node, below: boolean): boolean {
  if (spreads(n)) return true
  if (!below || n.k !== 'row') return false
  const items = groupDelims(n.items)
  return items.length > 1 && !items.slice(1).every(m => m.k === 'delim' || (m.k === 'script' && m.base.k === 'delim'))
}

function scriptText(n: Node, map: Record<string, string>, mark: string): string {
  const c = compact(n, map)
  if (c !== undefined) return c
  const s = linear(n, true)
  return Array.from(s).length === 1 ? `${mark}${s}` : `${mark}(${s})`
}

// One line of Unicode for a node.
function linear(n: Node, script = false): string {
  switch (n.k) {
    case 'sym': return n.s
    case 'text': return n.s
    case 'row': {
      return spaced(groupDelims(n.items), script).map(({ n: m, pre }) => pre + linear(m, script)).join('')
    }
    case 'script': {
      const base = linear(n.base, script)
      const sub = n.sub ? scriptText(n.sub, SUB, '_') : ''
      const sup = n.sup ? scriptText(n.sup, SUP, '^') : ''
      return base + sub + sup
    }
    case 'frac': {
      const a = linear(n.num, script)
      const b = linear(n.den, script)
      return `${needsParens(n.num, false) ? `(${a})` : a}/${needsParens(n.den, true) ? `(${b})` : b}`
    }
    case 'binom': return `C(${linear(n.top, true)}, ${linear(n.bottom, true)})`
    case 'sqrt': {
      const s = linear(n.body, script)
      const idx = n.index ? linear(n.index, true) : ''
      const root = idx === '3' ? '∛' : idx === '4' ? '∜' : idx ? `${compact(n.index!, SUP) ?? `(${idx})`}√` : '√'
      return needsParens(n.body, true) ? `${root}(${s})` : `${root}${s}`
    }
    case 'accent': {
      const s = linear(n.body, script)
      const mark = COMBINING[n.a]
      const chars = Array.from(s)
      if (chars.length === 1) return s + mark
      if (n.a === 'bar' || n.a === 'underline') return chars.map(ch => ch + mark).join('')
      if (n.a === 'vec') return s + mark
      return chars.map(ch => ch + mark).join('')
    }
    case 'delim': return n.l + linear(n.body, script) + n.r
    case 'grid': {
      const sep = n.kind === 'matrix' ? ' ' : n.kind === 'cases' ? ', ' : ''
      const cell = (c: Node, j: number) =>
        (n.kind === 'align' && j % 2 === 1 && sides(c).l === 'rel' ? ' ' : '') + linear(c, script)
      const rows = n.rows.map(r => r.map(cell).join(sep).trim())
      const body = rows.join('; ')
      if (n.kind === 'cases') return `${n.l}${n.l ? ' ' : ''}${body}${n.r ? ' ' : ''}${n.r}`
      return n.l + body + n.r
    }
    case 'stack': {
      const body = linear(n.body, script)
      const over = n.over ? scriptText(n.over, SUP, '^') : ''
      const under = n.under ? scriptText(n.under, SUB, '_') : ''
      return body + under + over
    }
    case 'brace': {
      const s = linear(n.body, script)
      if (!n.label) return s
      const body = needsParens(n.body, true) ? `(${s})` : s
      return body + (n.up ? scriptText(n.label, SUP, '^') : scriptText(n.label, SUB, '_'))
    }
    case 'boxed': return `[${linear(n.body, script)}]`
  }
}

// ---------------------------------------------------------------- 2D layout

type Box = { rows: string[]; w: number; base: number }

const text = (s: string): Box => ({ rows: [s], w: strWidth(s), base: 0 })
const padRight = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - strWidth(s)))

function hcat(boxes: Box[]): Box {
  if (boxes.length === 0) return text('')
  const above = Math.max(...boxes.map(b => b.base))
  const below = Math.max(...boxes.map(b => b.rows.length - 1 - b.base))
  const rows = Array.from({ length: above + below + 1 }, () => '')
  for (const b of boxes) {
    const off = above - b.base
    for (let r = 0; r < rows.length; r++) rows[r] += padRight(b.rows[r - off] ?? '', b.w)
  }
  return { rows, w: boxes.reduce((s, b) => s + b.w, 0), base: above }
}

function center(b: Box, w: number): Box {
  const left = Math.floor((w - b.w) / 2)
  return { rows: b.rows.map(r => padRight(' '.repeat(left) + r, w)), w, base: b.base }
}

function align(b: Box, w: number, how: 'l' | 'c' | 'r'): Box {
  if (how === 'c') return center(b, w)
  const pad = ' '.repeat(Math.max(0, w - b.w))
  return { rows: b.rows.map(r => (how === 'r' ? pad + padRight(r, b.w) : padRight(r, w))), w, base: b.base }
}

function blank(h: number, w: number, base: number): Box {
  return { rows: Array.from({ length: h }, () => ' '.repeat(w)), w, base }
}

const STRETCH: Record<string, [top: string, mid: string, bottom: string, centre?: string]> = {
  '(': ['⎛', '⎜', '⎝'], ')': ['⎞', '⎟', '⎠'],
  '[': ['⎡', '⎢', '⎣'], ']': ['⎤', '⎥', '⎦'],
  '{': ['⎧', '⎪', '⎩', '⎨'], '}': ['⎫', '⎪', '⎭', '⎬'],
  '⌈': ['⎡', '⎢', '⎢'], '⌉': ['⎤', '⎥', '⎥'],
  '⌊': ['⎢', '⎢', '⎣'], '⌋': ['⎥', '⎥', '⎦'],
  '|': ['│', '│', '│'], '‖': ['║', '║', '║'], '∣': ['│', '│', '│'],
}

function delimBox(ch: string, h: number, base: number): Box {
  if (ch === '') return { rows: Array.from({ length: h }, () => ''), w: 0, base }
  if (h === 1) return { rows: [ch], w: strWidth(ch), base }
  if (ch === '⟨' || ch === '⟩' || ch === '<' || ch === '>') {
    const left = ch === '⟨' || ch === '<'
    const half = Math.floor(h / 2)
    const rows = Array.from({ length: h }, (_, r) => {
      if (h % 2 === 1 && r === half) return left ? '⟨' : '⟩'
      return (r < half) === left ? '╱' : '╲'
    })
    return { rows, w: 1, base }
  }
  const parts = STRETCH[ch]
  if (!parts) return { rows: Array.from({ length: h }, (_, r) => (r === base ? ch : ' ')), w: strWidth(ch), base }
  const [top, mid, bottom, centre] = parts
  if (centre && h === 2) return { rows: [top, bottom], w: 1, base }
  const rows = Array.from({ length: h }, (_, r) => {
    if (r === 0) return top
    if (r === h - 1) return bottom
    if (centre && r === Math.floor((h - 1) / 2)) return centre
    return mid
  })
  return { rows, w: 1, base }
}

function integralBox(above: number, below: number): Box {
  const h = above + below + 1
  const rows = Array.from({ length: h }, (_, r) => (r === 0 ? '⌠' : r === h - 1 ? '⌡' : '⎮'))
  return { rows, w: 1, base: above }
}

const isIntegral = (n: Node) => {
  const b = n.k === 'script' ? n.base : n
  return b.k === 'sym' && b.int === true
}

function layRow(items: Node[], script: boolean): Box {
  const parts = spaced(groupDelims(items), script)
  const boxes = parts.map(p => (isIntegral(p.n) ? undefined : lay(p.n, script)))
  const out: Box[] = []
  parts.forEach((p, i) => {
    if (p.pre) out.push(text(p.pre))
    let b = boxes[i]
    if (b === undefined) {
      // An integral stands as tall as its integrand: what follows it up to
      // the next relation.
      let above = 0
      let below = 0
      for (let j = i + 1; j < parts.length && sides(parts[j]!.n).l !== 'rel'; j++) {
        const m = boxes[j]
        if (!m) continue
        above = Math.max(above, m.base)
        below = Math.max(below, m.rows.length - 1 - m.base)
      }
      const sign = !script && above + below > 0 ? integralBox(above, below) : undefined
      b = p.n.k === 'script' ? layScript(p.n, script, sign) : sign ?? lay(p.n, script)
    }
    out.push(b)
  })
  return hcat(out)
}

function layScript(n: Node & { k: 'script' }, script: boolean, baseBox?: Box): Box {
  const b = baseBox ?? lay(n.base, script)
  const base = n.base
  const limits = !script && base.k === 'sym' && base.limits === true
  if (limits) {
    const sup = n.sup ? lay(n.sup, true) : undefined
    const sub = n.sub ? lay(n.sub, true) : undefined
    const w = Math.max(b.w, sup?.w ?? 0, sub?.w ?? 0)
    const rows = [
      ...(sup ? center(sup, w).rows : []),
      ...center(b, w).rows,
      ...(sub ? center(sub, w).rows : []),
    ]
    return { rows, w, base: (sup?.rows.length ?? 0) + b.base }
  }
  if (b.rows.length === 1) {
    const sup = n.sup ? compact(n.sup, SUP) : ''
    const sub = n.sub ? compact(n.sub, SUB) : ''
    if (sup !== undefined && sub !== undefined && !hasTall(n.sup) && !hasTall(n.sub)) {
      return text(b.rows[0]! + sub + sup)
    }
  }
  // Beside a tall base a script that has Unicode forms still uses them.
  const side = (m: Node | undefined, map: Record<string, string>) => {
    if (!m) return undefined
    const c = b.rows.length > 1 && !hasTall(m) ? compact(m, map) : undefined
    return c === undefined ? lay(m, true) : text(c)
  }
  const sup = side(n.sup, SUP)
  const sub = side(n.sub, SUB)
  const h = b.rows.length
  // Rows relative to the base box's top row.
  const supTop = sup ? (h > 1 ? 1 - sup.rows.length : -sup.rows.length) : 0
  const subTop = sub ? (h > 1 ? h - 1 : h) : 0
  const top = Math.min(0, supTop)
  const bottom = Math.max(h - 1, sub ? subTop + sub.rows.length - 1 : 0)
  const sw = Math.max(sup?.w ?? 0, sub?.w ?? 0)
  const rows: string[] = []
  for (let r = top; r <= bottom; r++) {
    const left = r >= 0 && r < h ? b.rows[r]! : ''
    let right = ''
    if (sup && r >= supTop && r < supTop + sup.rows.length) right = sup.rows[r - supTop]!
    else if (sub && r >= subTop && r < subTop + sub.rows.length) right = sub.rows[r - subTop]!
    rows.push(padRight(left, b.w) + padRight(right, sw))
  }
  return { rows, w: b.w + sw, base: b.base - top }
}

function hasTall(n: Node | undefined): boolean {
  if (!n) return false
  switch (n.k) {
    case 'frac': case 'binom': case 'grid': case 'stack': case 'brace': case 'boxed': return true
    case 'row': return n.items.some(hasTall)
    case 'script': return hasTall(n.base) || hasTall(n.sub) || hasTall(n.sup)
    case 'delim': case 'accent': case 'sqrt': return hasTall(n.body)
    default: return false
  }
}

function lay(n: Node, script = false): Box {
  switch (n.k) {
    case 'sym': return text(n.s)
    case 'text': return text(n.s)
    case 'row': return layRow(n.items, script)
    case 'script': return layScript(n, script)
    case 'frac': {
      if (script) return text(linear(n, true))
      const num = lay(n.num)
      const den = lay(n.den)
      const w = Math.max(num.w, den.w) + 2
      return {
        rows: [...center(num, w).rows, '─'.repeat(w), ...center(den, w).rows],
        w,
        base: num.rows.length,
      }
    }
    case 'binom': {
      if (script) return text(linear(n, true))
      const top = lay(n.top)
      const bottom = lay(n.bottom)
      const w = Math.max(top.w, bottom.w)
      const body: Box = { rows: [...center(top, w).rows, ...center(bottom, w).rows], w, base: top.rows.length - 1 }
      const h = body.rows.length
      return hcat([delimBox('(', h, body.base), body, delimBox(')', h, body.base)])
    }
    case 'sqrt': {
      const body = lay(n.body, script)
      const idx = n.index ? linear(n.index, true) : ''
      if (body.rows.length === 1) {
        const root = idx === '3' ? '∛' : idx === '4' ? '∜' : idx ? `${compact(n.index!, SUP) ?? `(${idx})`}√` : '√'
        const rw = strWidth(root)
        return { rows: [' '.repeat(rw) + '_'.repeat(body.w), root + body.rows[0]!], w: rw + body.w, base: 1 }
      }
      const h = body.rows.length
      const lead = idx ? compact(n.index!, SUP) ?? `(${idx})` : ''
      const lw = strWidth(lead)
      const rows = [
        ' '.repeat(lw) + ' ┌' + '─'.repeat(body.w),
        ...body.rows.map((r, i) => (i === h - 1 ? padRight(lead, lw) + '╲│' : ' '.repeat(lw) + ' │') + padRight(r, body.w)),
      ]
      return { rows, w: lw + 2 + body.w, base: body.base + 1 }
    }
    case 'accent': {
      const body = lay(n.body, script)
      if (body.rows.length === 1 && body.w === 1) return text(body.rows[0]! + COMBINING[n.a])
      const mark = ACCENT_MARK[n.a]
      const line = n.a === 'bar' || n.a === 'underline'
        ? mark.repeat(body.w)
        : n.a === 'vec'
          ? '─'.repeat(Math.max(0, body.w - 1)) + '→'
          : center(text(mark), body.w).rows[0]!
      if (n.a === 'underline') return { rows: [...body.rows, line], w: body.w, base: body.base }
      return { rows: [line, ...body.rows], w: body.w, base: body.base + 1 }
    }
    case 'delim': {
      const body = lay(n.body, script)
      const h = body.rows.length
      return hcat([delimBox(n.l, h, body.base), body, delimBox(n.r, h, body.base)])
    }
    case 'grid': return layGrid(n, script)
    case 'stack': {
      const body = lay(n.body, script)
      const over = n.over ? lay(n.over, true) : undefined
      const under = n.under ? lay(n.under, true) : undefined
      let w = Math.max(body.w, over?.w ?? 0, under?.w ?? 0)
      let b = body
      if (n.body.k === 'sym' && n.body.c === 'rel' && w > body.w) {
        // A labelled arrow grows under its label.
        const s = n.body.s
        w += 2
        b = text(s === '=' ? '═'.repeat(w) : s === '←' || s === '⇐' ? s + (s === '⇐' ? '═' : '─').repeat(w - 1) : (s === '⇒' ? '═' : '─').repeat(w - 1) + s)
      }
      const rows = [
        ...(over ? center(over, w).rows : []),
        ...center(b, w).rows,
        ...(under ? center(under, w).rows : []),
      ]
      return { rows, w, base: (over?.rows.length ?? 0) + b.base }
    }
    case 'brace': {
      const body = lay(n.body, script)
      const w = body.w
      const mid = Math.floor((w - 1) / 2)
      const brace = w < 3
        ? '─'.repeat(w)
        : (n.up ? '┌' : '└') + '─'.repeat(mid - 1) + (n.up ? '┴' : '┬') + '─'.repeat(w - mid - 2) + (n.up ? '┐' : '┘')
      const label = n.label ? lay(n.label, true) : undefined
      const lw = Math.max(w, label?.w ?? 0)
      const bodyC = center(body, lw)
      const braceC = center(text(brace), lw)
      if (n.up) {
        const rows = [...(label ? center(label, lw).rows : []), ...braceC.rows, ...bodyC.rows]
        return { rows, w: lw, base: (label?.rows.length ?? 0) + 1 + body.base }
      }
      return { rows: [...bodyC.rows, ...braceC.rows, ...(label ? center(label, lw).rows : [])], w: lw, base: body.base }
    }
    case 'boxed': {
      const body = lay(n.body, script)
      return {
        rows: ['┌' + '─'.repeat(body.w + 2) + '┐', ...body.rows.map(r => '│ ' + padRight(r, body.w) + ' │'), '└' + '─'.repeat(body.w + 2) + '┘'],
        w: body.w + 4,
        base: body.base + 1,
      }
    }
  }
}

function layGrid(n: Node & { k: 'grid' }, script: boolean): Box {
  const cols = Math.max(...n.rows.map(r => r.length))
  const cells = n.rows.map(r => r.map((c, j) => {
    const b = lay(c, script)
    // The right half of an aligned pair keeps the gap before its relation.
    if (n.kind === 'align' && j % 2 === 1 && sides(c).l === 'rel') return hcat([text(' '), b])
    return b
  }))
  const widths = Array.from({ length: cols }, (_, j) => Math.max(0, ...cells.map(r => r[j]?.w ?? 0)))
  const how = (j: number): 'l' | 'c' | 'r' =>
    n.kind === 'align' ? (j % 2 === 0 ? 'r' : 'l') : n.kind === 'cases' ? 'l' : 'c'
  const sep = (j: number) => (n.kind === 'align' ? (j % 2 === 1 ? '  ' : '') : n.kind === 'cases' ? '    ' : '  ')
  const lines: Box[] = cells.map(r => {
    const parts: Box[] = []
    for (let j = 0; j < cols; j++) {
      if (j > 0 && sep(j - 1)) parts.push(text(sep(j - 1)))
      const c = r[j] ?? text('')
      parts.push(align(c, widths[j]!, how(j)))
    }
    return hcat(parts)
  })
  const tall = lines.some(l => l.rows.length > 1)
  const rows: string[] = []
  lines.forEach((l, i) => {
    if (i > 0 && tall && n.kind !== 'align') rows.push('')
    rows.push(...l.rows)
  })
  const w = Math.max(0, ...lines.map(l => l.w))
  const h = rows.length
  const body: Box = { rows: rows.map(r => padRight(r, w)), w, base: Math.floor((h - 1) / 2) }
  if (!n.l && !n.r) return body
  const inner = n.kind === 'matrix' ? hcat([text(' '), body, text(' ')]) : hcat([text(' '), body])
  return hcat([delimBox(n.l, h, body.base), inner, delimBox(n.r, h, body.base)])
}

// ---------------------------------------------------------------- public

export type Rendered = { inline: string; art: string[] }

// One formula: its one-line form and its character art.
export function renderFormula(src: string): Rendered {
  const p = new Parser(tokenize(src))
  const tree = p.parseTop()
  let inline = linear(tree)
  let box = lay(tree)
  if (p.tag) {
    inline += `  ${p.tag}`
    box = hcat([box, text(`    ${p.tag}`)])
  }
  const art = box.rows.map(r => r.trimEnd())
  while (art.length > 1 && art[0] === '') art.shift()
  while (art.length > 1 && art[art.length - 1] === '') art.pop()
  return { inline: inline.trim(), art }
}

const DISPLAY_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline',
  'multline*', 'eqnarray', 'eqnarray*', 'displaymath', 'flalign', 'flalign*',
])

const escapeMarkdown = (s: string) => s.replace(/[\\`*_[\]<>|~]/g, '\\$&')

// Fenced code blocks and code spans: math inside them stays as written.
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  const fenceAt: [number, number][] = []
  let open: { ch: string; len: number; start: number } | undefined
  for (let start = 0; ;) {
    const nl = text.indexOf('\n', start)
    const end = nl < 0 ? text.length : nl
    const f = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/.exec(text.slice(start, end))
    if (open) {
      if (f && f[1]![0] === open.ch && f[1]!.length >= open.len && f[2]!.trim() === '') {
        fenceAt.push([open.start, end])
        open = undefined
      }
    } else if (f && !(f[1]![0] === '`' && f[2]!.includes('`'))) {
      open = { ch: f[1]![0]!, len: f[1]!.length, start }
    }
    if (nl < 0) break
    start = nl + 1
  }
  if (open) fenceAt.push([open.start, text.length])
  let from = 0
  for (const [s, e] of [...fenceAt, [text.length, text.length] as [number, number]]) {
    spans(text, from, s, ranges)
    if (s < e) ranges.push([s, e])
    from = e
  }
  return ranges
}

function spans(text: string, from: number, to: number, out: [number, number][]) {
  let i = from
  while (i < to) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] !== '`') {
      i++
      continue
    }
    let n = 0
    while (text[i + n] === '`') n++
    let j = i + n
    let close = -1
    while (j < to) {
      if (text[j] === '`') {
        let k = 0
        while (text[j + k] === '`') k++
        if (k === n) {
          close = j
          break
        }
        j += k
      } else j++
    }
    if (close < 0) {
      i += n
      continue
    }
    out.push([i, close + n])
    i = close + n
  }
}

// Where `close` next appears at or after `from`, skipping backslash escapes.
function findClose(text: string, from: number, close: string): number {
  for (let j = from; j < text.length; j++) {
    if (text.startsWith(close, j)) return j
    if (text[j] === '\\' && close[0] !== '\\') j++
  }
  return -1
}

type Found = { end: number; src: string; display: boolean }

function findMath(text: string, i: number, limit: number): Found | 'stop' | undefined {
  if (text.startsWith('$$', i)) {
    const c = findClose(text, i + 2, '$$')
    if (c < 0) return 'stop'
    if (c + 2 > limit || text.slice(i + 2, c).trim() === '') return undefined
    return { end: c + 2, src: text.slice(i + 2, c), display: true }
  }
  if (text.startsWith('\\[', i) || text.startsWith('\\(', i)) {
    const display = text[i + 1] === '['
    const c = text.indexOf(display ? '\\]' : '\\)', i + 2)
    if (c < 0) return display ? 'stop' : undefined
    if (c + 2 > limit) return undefined
    return { end: c + 2, src: text.slice(i + 2, c), display }
  }
  if (text.startsWith('\\begin{', i)) {
    const m = /^\\begin\{([A-Za-z]+\*?)\}/.exec(text.slice(i, i + 40))
    if (!m || !DISPLAY_ENVS.has(m[1]!)) return undefined
    const endTag = `\\end{${m[1]}}`
    const c = text.indexOf(endTag, i)
    if (c < 0) return 'stop'
    if (c + endTag.length > limit) return undefined
    return { end: c + endTag.length, src: text.slice(i, c + endTag.length), display: true }
  }
  if (text[i] === '$') {
    const first = text[i + 1]
    if (first === undefined || /\s/.test(first) || first === '$') return undefined
    for (let j = i + 1; j < limit; j++) {
      const ch = text[j]
      if (ch === '\\') {
        j++
        continue
      }
      if (ch === '\n' && /^\n[ \t]*(\n|$)/.test(text.slice(j, j + 40))) return undefined
      if (ch === '$') {
        // The first later `$` decides: it closes only after a non-space and
        // before a non-digit, so prices like "$5 and $10" stay text.
        if (/\s/.test(text[j - 1]!) || /\d/.test(text[j + 1] ?? '')) return undefined
        return { end: j + 1, src: text.slice(i + 1, j), display: false }
      }
    }
    return undefined
  }
  return undefined
}

// The markdown context of a line: blockquote markers and list indent.
function lineContext(prefix: string): { quote: string; indent: number; content: boolean; table: boolean } {
  const q = /^(?:[ \t]*>[ \t]?)*/.exec(prefix)![0]
  const rest = prefix.slice(q.length)
  const quote = q.includes('>') ? '> '.repeat((q.match(/>/g) ?? []).length) : ''
  const list = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/.exec(rest)
  const lead = list ? list[0] : /^[ \t]*/.exec(rest)![0]
  const after = rest.slice(lead.length)
  return {
    quote,
    indent: strWidth(lead.replace(/\t/g, '    ')),
    content: after.trim() !== '',
    table: rest.trimStart().startsWith('|'),
  }
}

// Math in a markdown reply, replaced by Unicode text. `columns` is the width
// the reply is drawn in; display art wider than that is written on one line.
export function renderMath(text: string, columns?: number): string {
  if (!text.includes('$') && !text.includes('\\')) return text
  const code = codeRanges(text)
  let out = ''
  let i = 0
  let ci = 0
  while (i < text.length) {
    const range = code[ci]
    if (range && i >= range[0]) {
      out += text.slice(i, range[1])
      i = range[1]
      ci++
      continue
    }
    const limit = range ? range[0] : text.length
    const ch = text[i]!
    if (ch === '\\' && text[i + 1] !== undefined && !'([b'.includes(text[i + 1]!)) {
      out += text.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch !== '$' && ch !== '\\') {
      out += ch
      i++
      continue
    }
    const found = findMath(text, i, limit)
    if (found === 'stop') {
      // An open display block, still streaming: leave the rest as written.
      out += text.slice(i)
      break
    }
    if (found === undefined) {
      out += ch
      i++
      continue
    }
    const lineStart = text.lastIndexOf('\n', i - 1) + 1
    const ctx = lineContext(text.slice(lineStart, i))
    let src = found.src
    // In a table row `\|` is the cell's escaped pipe, read before the math.
    if (ctx.table) src = src.replace(/\\\|/g, '|')
    if (ctx.quote) {
      const depth = ctx.quote.length / 2
      src = src.replace(new RegExp(`\\n(?:[ \\t]*>[ \\t]?){0,${depth}}`, 'g'), '\n')
    }
    const formula = renderFormula(src)
    const lineEnd = text.indexOf('\n', found.end)
    const tail = text.slice(found.end, lineEnd < 0 ? text.length : lineEnd)
    const ownLine = !ctx.content && tail.trim() === ''
    const room = (columns ?? Infinity) - ctx.indent - ctx.quote.length - 4
    const width = Math.max(...formula.art.map(strWidth))
    const asBlock = found.display && !ctx.table && width <= room && (ownLine || formula.art.length > 1)
    if (!asBlock) {
      out += escapeMarkdown(formula.inline)
      i = found.end
      continue
    }
    const pad = ctx.quote + ' '.repeat(ctx.indent)
    const fence = formula.art.some(l => l.includes('```')) ? '~~~' : '```'
    let block = ctx.content ? `\n${pad}` : ''
    block += `${fence}\n`
    for (const line of formula.art) block += `${pad}${line}\n`
    block += `${pad}${fence}`
    out += block
    i = found.end
    if (tail.trim() !== '') {
      out += `\n${pad}`
      while (text[i] === ' ' || text[i] === '\t') i++
    }
  }
  return out
}
