import type { EngineInterface, Register } from 'claude-code'
import {
  CLEAR_AFTER_PROMPTS,
  DEFAULT_CHECK_EVERY,
  DEFAULT_MAGPIE_GATEWAY,
  SEEN_MAX,
  SESSIONS_MAX,
  buildDiscussDraft,
  buildExplainPrompt,
  buildProposePrompt,
  isMagpieGateway,
  lineKey,
  looksToSkipAfter,
  parseProposal,
  type OfferTag,
} from '../src/protocol'

// Under claude-magpie only, run a lightweight side observer via $.model.fork
// that surfaces "Heads up" / "You should know" notes above the prompt, filling
// the gap left by Claude Code's built-in You should know plugin (which is gated
// off whenever ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN is set).
// Native Claude Code sessions are untouched.

type CardView =
  | { kind: 'offer'; tag: OfferTag; line: string; explanation?: string; promptsSurvived: number; shownAt: number }
  | { kind: 'explaining'; tag: OfferTag; line: string; shownAt: number }
  | { kind: 'explained'; tag: OfferTag; line: string; explanation: string; promptsSurvived: number; shownAt: number }

interface SessionRow {
  id: string
  askedTurn?: string
  offeredTurn?: string
  view?: CardView
}

interface StoredState {
  enabled: boolean
  seen: string[]
  known: string[]
  typedPastInARow: number
  looksToSkip: number
  sessions: SessionRow[]
}

interface Runtime {
  gatewayUrl: string
  checkEvery: number
  inFlight: Set<string>
  explaining: Set<string>
  promptsSinceView: Map<string, number>
}

const STORE_KEY = 'state'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0
}

function parseState(raw: unknown): StoredState {
  if (!isRecord(raw)) {
    return { enabled: true, seen: [], known: [], typedPastInARow: 0, looksToSkip: 0, sessions: [] }
  }
  const sessions: SessionRow[] = []
  if (Array.isArray(raw['sessions'])) {
    for (const item of raw['sessions']) {
      if (isRecord(item) && typeof item['id'] === 'string') {
        sessions.push(item as unknown as SessionRow)
      }
    }
  }
  return {
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true,
    seen: asStrings(raw['seen']).slice(-SEEN_MAX),
    known: asStrings(raw['known']).slice(-SEEN_MAX),
    typedPastInARow: asCount(raw['typedPastInARow']),
    looksToSkip: asCount(raw['looksToSkip']),
    sessions: sessions.slice(0, SESSIONS_MAX),
  }
}

function upsertSession(sessions: SessionRow[], row: SessionRow): SessionRow[] {
  return [row, ...sessions.filter(s => s.id !== row.id)].slice(0, SESSIONS_MAX)
}

async function isActive($: EngineInterface, gatewayUrl: string): Promise<boolean> {
  return isMagpieGateway(await $.env.get('ANTHROPIC_BASE_URL'), gatewayUrl)
}

async function loadState($: EngineInterface): Promise<StoredState> {
  return parseState(await $.store.get(STORE_KEY))
}

async function saveState($: EngineInterface, s: StoredState): Promise<void> {
  await $.store.set(STORE_KEY, s)
}

async function runCheck(
  $: EngineInterface,
  rt: Runtime,
  sid: string,
  turnId: string | undefined,
  force: boolean,
): Promise<'shown' | 'none' | 'deduped' | 'unparsable' | 'skipped' | 'error'> {
  if (rt.inFlight.has(sid)) return 'skipped'
  rt.inFlight.add(sid)
  try {
    const st = await loadState($)
    if (!force && !st.enabled) return 'skipped'
    const curRow = st.sessions.find(s => s.id === sid) ?? { id: sid }
    if (!force) {
      if (curRow.view !== undefined) return 'skipped'
      if (turnId !== undefined && curRow.offeredTurn === turnId) return 'skipped'
      if (st.looksToSkip > 0) {
        st.looksToSkip -= 1
        await saveState($, st)
        return 'skipped'
      }
    }

    if (turnId !== undefined) {
      st.sessions = upsertSession(st.sessions, { ...curRow, askedTurn: turnId })
      await saveState($, st)
    }

    const forkRes = await $.model.fork({ prompt: buildProposePrompt(st.seen, st.known) })
    if (!forkRes.isAnswered) {
      $.ui.log(`magpie-heads-up: fork unanswered (${forkRes.reason})`, { to: 'debug' })
      return forkRes.reason === 'nothing-to-fork' || forkRes.reason === 'empty-reply' ? 'none' : 'error'
    }

    const parsed = parseProposal(forkRes.text)
    if (parsed.kind === 'none') return 'none'
    if (parsed.kind === 'unparsable') {
      $.ui.log('magpie-heads-up: unparsable fork reply', { to: 'debug' })
      return 'unparsable'
    }

    const fresh = await loadState($)
    const dedupKey = lineKey(parsed.line)
    if (!force && [...fresh.seen, ...fresh.known].some(x => lineKey(x) === dedupKey)) {
      return 'deduped'
    }

    const freshRow = fresh.sessions.find(s => s.id === sid) ?? { id: sid }
    if (!force && freshRow.view !== undefined) return 'skipped'

    const now = await $.clock.now()
    fresh.seen = [...fresh.seen, parsed.line].slice(-SEEN_MAX)
    if (force) {
      fresh.typedPastInARow = 0
      fresh.looksToSkip = 0
    }
    fresh.sessions = upsertSession(fresh.sessions, {
      ...freshRow,
      ...(turnId !== undefined ? { offeredTurn: turnId } : {}),
      view: {
        kind: 'offer',
        tag: parsed.tag,
        line: parsed.line,
        ...(parsed.explanation !== undefined ? { explanation: parsed.explanation } : {}),
        promptsSurvived: 0,
        shownAt: now,
      },
    })
    rt.promptsSinceView.delete(sid)
    await saveState($, fresh)
    $.ui.invalidate('ui.render')
    return 'shown'
  } catch (err) {
    $.ui.log(`magpie-heads-up: check failed (${(err as Error)?.message ?? 'error'})`, { to: 'debug' })
    return 'error'
  } finally {
    rt.inFlight.delete(sid)
  }
}

async function resetBackoffAndClear($: EngineInterface, sid: string, markKnownLine?: string): Promise<void> {
  const fresh = await loadState($)
  fresh.typedPastInARow = 0
  fresh.looksToSkip = 0
  if (markKnownLine) {
    const k = lineKey(markKnownLine)
    if (!fresh.known.some(x => lineKey(x) === k)) {
      fresh.known = [...fresh.known, markKnownLine].slice(-SEEN_MAX)
    }
  }
  const r = fresh.sessions.find(s => s.id === sid)
  if (r) fresh.sessions = upsertSession(fresh.sessions, { ...r, view: undefined })
  await saveState($, fresh)
  $.ui.invalidate('ui.render')
}

async function openExplanation(
  $: EngineInterface,
  rt: Runtime,
  sid: string,
  tag: OfferTag,
  line: string,
  existing?: string,
): Promise<void> {
  if (existing && existing.trim() !== '') {
    const fresh = await loadState($)
    fresh.typedPastInARow = 0
    fresh.looksToSkip = 0
    const r = fresh.sessions.find(s => s.id === sid) ?? { id: sid }
    fresh.sessions = upsertSession(fresh.sessions, {
      ...r,
      view: { kind: 'explained', tag, line, explanation: existing, promptsSurvived: 0, shownAt: await $.clock.now() },
    })
    rt.promptsSinceView.delete(sid)
    await saveState($, fresh)
    $.ui.invalidate('ui.render')
    return
  }

  if (rt.explaining.has(sid)) return
  rt.explaining.add(sid)
  try {
    const fresh = await loadState($)
    fresh.typedPastInARow = 0
    fresh.looksToSkip = 0
    const r = fresh.sessions.find(s => s.id === sid) ?? { id: sid }
    fresh.sessions = upsertSession(fresh.sessions, {
      ...r,
      view: { kind: 'explaining', tag, line, shownAt: await $.clock.now() },
    })
    await saveState($, fresh)
    $.ui.invalidate('ui.render')

    const forkRes = await $.model.fork({ prompt: buildExplainPrompt(line) })
    const text = forkRes.isAnswered ? forkRes.text.trim() : ''
    const after = await loadState($)
    const rAfter = after.sessions.find(s => s.id === sid) ?? { id: sid }
    if (text !== '') {
      after.sessions = upsertSession(after.sessions, {
        ...rAfter,
        view: { kind: 'explained', tag, line, explanation: text, promptsSurvived: 0, shownAt: await $.clock.now() },
      })
      rt.promptsSinceView.delete(sid)
    } else {
      after.sessions = upsertSession(after.sessions, { ...rAfter, view: undefined })
      $.ui.toast('暂时无法展开这条说明')
    }
    await saveState($, after)
    $.ui.invalidate('ui.render')
  } finally {
    rt.explaining.delete(sid)
  }
}

async function discussInMain(
  $: EngineInterface,
  sid: string,
  tag: OfferTag,
  line: string,
  explanation?: string,
): Promise<void> {
  const box = await $.prompt.read()
  if (box.text.trim() !== '') {
    $.ui.toast('输入框已有内容，请先发送或清空再填入讨论')
    return
  }
  const draft = buildDiscussDraft(tag, line, explanation)
  const filled = await $.prompt.fill({ text: draft, mode: 'replace' })
  if (filled.isFilled) {
    await resetBackoffAndClear($, sid, line)
    return
  }
  if (filled.refusal === 'no_composer') {
    await resetBackoffAndClear($, sid, line)
    void $.prompt.submit({ text: draft })
    return
  }
  $.ui.toast('当前无法填入输入框')
}

export const register: Register = (on, options) => {
  const rt: Runtime = {
    gatewayUrl: typeof options?.gatewayUrl === 'string' && options.gatewayUrl.trim() !== ''
      ? options.gatewayUrl.trim()
      : DEFAULT_MAGPIE_GATEWAY,
    checkEvery: typeof options?.checkEvery === 'number' && Number.isSafeInteger(options.checkEvery) && options.checkEvery >= 1
      ? options.checkEvery
      : DEFAULT_CHECK_EVERY,
    inFlight: new Set<string>(),
    explaining: new Set<string>(),
    promptsSinceView: new Map<string, number>(),
  }

  on('session.start', async ($, e, next) => {
    const res = await next(e)
    if (await isActive($, rt.gatewayUrl)) {
      await $.command.register({
        name: 'heads-up',
        description: 'Magpie Heads up 旁路提醒：now 立即检查 | on | off | clear | status',
      })
    }
    return res
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'heads-up' }, async ($, e, next) => {
    if (!(await isActive($, rt.gatewayUrl))) return next(e)
    const arg = (e.args ?? '').trim().toLowerCase()
    const sid = await $.session.id()
    const st = await loadState($)

    if (arg === 'off' || arg === 'disable') {
      st.enabled = false
      const row = st.sessions.find(s => s.id === sid)
      if (row) st.sessions = upsertSession(st.sessions, { ...row, view: undefined })
      await saveState($, st)
      $.ui.invalidate('ui.render')
      return { text: 'magpie-heads-up 已关闭（/heads-up on 可重新开启）。' }
    }

    if (arg === 'on' || arg === 'enable') {
      st.enabled = true
      st.typedPastInARow = 0
      st.looksToSkip = 0
      await saveState($, st)
      return { text: `magpie-heads-up 已开启（每 ${rt.checkEvery} 步自动检查一次）。` }
    }

    if (arg === 'clear') {
      const row = st.sessions.find(s => s.id === sid)
      if (row) {
        st.sessions = upsertSession(st.sessions, { ...row, view: undefined })
        await saveState($, st)
        $.ui.invalidate('ui.render')
      }
      return { text: '已清除当前会话的 Heads up 卡片。' }
    }

    if (arg === 'now' || arg === 'check') {
      const outcome = await runCheck($, rt, sid, undefined, true)
      if (outcome === 'shown') return { text: '已触发检查，发现一条提醒并显示在输入框上方。' }
      if (outcome === 'none') return { text: '已检查当前对话：暂无需要打断提醒的内容。' }
      if (outcome === 'skipped') return { text: '已有检查正在进行，请稍候。' }
      return { text: `检查未能生成提醒（${outcome}）。` }
    }

    const row = st.sessions.find(s => s.id === sid)
    const status = [
      `magpie-heads-up: ${st.enabled ? '已开启' : '已关闭'}`,
      `检查频率: 每 ${rt.checkEvery} 步`,
      `已忽略退避: ${st.looksToSkip} 次（连续忽略 ${st.typedPastInARow} 条）`,
      `已记录话题: seen=${st.seen.length}, known=${st.known.length}`,
      `当前卡片: ${row?.view ? `${row.view.tag} · ${row.view.line}` : '无'}`,
      '用法: /heads-up now | on | off | clear | status',
    ].join('\n')
    return { text: status }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (await isActive($, rt.gatewayUrl)) {
      const kind = e.origin.kind
      if (kind === 'composer' || kind === 'bridge') {
        const sid = await $.session.id()
        rt.promptsSinceView.set(sid, (rt.promptsSinceView.get(sid) ?? 0) + 1)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    if (await isActive($, rt.gatewayUrl)) {
      const surfaces = await $.session.surfaces()
      if (surfaces.length > 0) {
        const sid = await $.session.id()
        if (e.index === 0) {
          const count = rt.promptsSinceView.get(sid) ?? 0
          rt.promptsSinceView.delete(sid)
          if (count > 0) {
            const st = await loadState($)
            const row = st.sessions.find(s => s.id === sid)
            const view = row?.view
            if (row && view && (view.kind === 'offer' || view.kind === 'explained')) {
              const survived = view.promptsSurvived + count
              if (view.kind === 'offer' && survived >= CLEAR_AFTER_PROMPTS) {
                st.typedPastInARow += 1
                st.looksToSkip = looksToSkipAfter(st.typedPastInARow)
                st.sessions = upsertSession(st.sessions, { ...row, view: undefined })
                await saveState($, st)
                $.ui.invalidate('ui.render')
              } else {
                st.sessions = upsertSession(st.sessions, {
                  ...row,
                  view: { ...view, promptsSurvived: survived },
                })
                await saveState($, st)
              }
            }
          }
        } else if (e.index > 0 && e.index % rt.checkEvery === 0) {
          // Run the fork in the background so the main turn is never delayed.
          void runCheck($, rt, sid, e.turnId, false)
        }
      }
    }

    return yield* next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await isActive($, rt.gatewayUrl))) return next(e)

    const sid = await $.session.id()
    const st = await loadState($)
    const row = st.sessions.find(s => s.id === sid)
    let view = row?.view

    // Clear stale "explaining" card if the plugin reloaded while a fork was in flight.
    if (view?.kind === 'explaining' && !rt.explaining.has(sid)) {
      if (row) {
        st.sessions = upsertSession(st.sessions, { ...row, view: undefined })
        await saveState($, st)
      }
      view = undefined
    }

    if (!view) return next(e)
    if (e.props.hasSurvey && view.kind !== 'explained') return next(e)

    const below = await next(e)
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)

    let card
    if (view.kind === 'explaining') {
      card = (
        <Box marginTop={1}>
          <Text color="suggestion">✦ </Text>
          <Text dimColor>正在生成说明…</Text>
        </Box>
      )
    } else if (view.kind === 'offer') {
      const offer = view
      card = (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="wrap">
            <Text color="suggestion">✦</Text>
            <Text dimColor> {offer.tag} · </Text>
            {offer.line}
          </Text>
          <Box marginLeft={2} flexWrap="wrap">
            <Box marginRight={3}>
              <Button key="explain" hotkey="1" plain label="展开说明" onPress={() => void openExplanation($, rt, sid, offer.tag, offer.line, offer.explanation)} />
            </Box>
            <Box marginRight={3}>
              <Button key="known" hotkey="2" plain label="已了解" onPress={() => void resetBackoffAndClear($, sid, offer.line)} />
            </Box>
            <Box marginRight={3}>
              <Button key="dismiss" hotkey="0" plain dimColor role="dismiss" label="关闭" onPress={() => void resetBackoffAndClear($, sid)} />
            </Box>
          </Box>
        </Box>
      )
    } else {
      const explained = view
      card = (
        <Box flexDirection="column" marginTop={1}>
          <Box marginBottom={1}>
            <Text wrap="wrap">
              <Text color="suggestion">✦</Text>
              <Text dimColor> {explained.tag} · </Text>
              {explained.line}
            </Text>
          </Box>
          <Box flexDirection="column" marginLeft={2} marginBottom={1}>
            <Markdown text={explained.explanation} />
          </Box>
          <Box marginLeft={2} flexWrap="wrap">
            <Box marginRight={3}>
              <Button key="got-it" hotkey="1" plain label="明白了" onPress={() => void resetBackoffAndClear($, sid, explained.line)} />
            </Box>
            <Box marginRight={3}>
              <Button key="discuss" hotkey="2" plain label="发到主对话讨论" onPress={() => void discussInMain($, sid, explained.tag, explained.line, explained.explanation)} />
            </Box>
            <Box marginRight={3}>
              <Button key="dismiss-explained" hotkey="0" plain dimColor role="dismiss" label="关闭" onPress={() => void resetBackoffAndClear($, sid)} />
            </Box>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {card}
        {below}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('session.end', ($, e, next) => {
    rt.promptsSinceView.delete(e.sessionId)
    rt.inFlight.delete(e.sessionId)
    rt.explaining.delete(e.sessionId)
    return next(e)
  })
}
