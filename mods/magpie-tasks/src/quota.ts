// The model of a daily task's acceptance check (routing rules, `acceptance`): Magpie's subscription
// quotas (GET <gateway>/v1/magpie/quotas, the readings `magpie quota` prints) decide which
// subscription the check runs on, and the rules file names that subscription's model.
import type { Io } from './io'
import type { AcceptanceSubscription, Rules } from './rules'

export interface QuotaWindow { name: string; remaining: number }
export interface SubscriptionQuota { provider: string; windows: QuotaWindow[] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// The subscription entries of Magpie's answer (`{ data: [...], object: "list" }`); key balances and
// other kinds are left out. `remaining` is the percentage of the window left.
export function parseQuotas(text: string): SubscriptionQuota[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`Magpie quotas: the answer is not JSON: ${(error as Error).message}`)
  }
  if (!isRecord(json) || !Array.isArray(json['data'])) throw new Error('Magpie quotas: the answer has no data list')
  const out: SubscriptionQuota[] = []
  json['data'].forEach((entry: unknown, i: number) => {
    if (!isRecord(entry) || typeof entry['provider'] !== 'string') throw new Error(`Magpie quotas: data[${i}] has no provider`)
    if (entry['kind'] !== 'subscription') return
    const windows = entry['windows']
    if (!Array.isArray(windows)) throw new Error(`Magpie quotas: the ${entry['provider']} subscription has no windows`)
    out.push({
      provider: entry['provider'],
      windows: windows.map((w: unknown, j: number) => {
        if (!isRecord(w) || typeof w['name'] !== 'string' || typeof w['remaining'] !== 'number') throw new Error(`Magpie quotas: ${entry['provider']} windows[${j}] has no name or remaining share`)
        return { name: w['name'], remaining: w['remaining'] }
      }),
    })
  })
  return out
}

export interface AcceptancePick { model: string; reason: string }

// The subscription whose weekly window has the largest share left gives the model; a subscription
// with any of its windows for that model used up (0% left) comes after every other, and the rules
// file's order decides a tie. Every listed subscription needs exactly one reading of its weekly window.
export function acceptancePick(rules: Rules, quotas: SubscriptionQuota[]): AcceptancePick {
  const rows = rules.acceptance.subscriptions.map((s: AcceptanceSubscription, order) => {
    const mine = quotas.filter(q => q.provider === s.provider)
    if (mine.length !== 1) throw new Error(`Magpie quotas: ${mine.length} ${s.provider} subscriptions reported; the acceptance choice compares exactly one per provider`)
    const q = mine[0]!
    const week = q.windows.find(w => w.name === s.week)
    if (week === undefined) throw new Error(`Magpie quotas: the ${s.provider} subscription has no "${s.week}" window (it reports ${q.windows.map(w => `"${w.name}"`).join(', ') || 'none'})`)
    const spent = q.windows.filter(w => w.name === s.week || s.limits.includes(w.name)).find(w => w.remaining <= 0)
    return { s, order, left: week.remaining, spent }
  })
  rows.sort((a, b) => Number(a.spent !== undefined) - Number(b.spent !== undefined) || b.left - a.left || a.order - b.order)
  const pct = (n: number) => `${Math.round(n * 10) / 10}%`
  const readings = rows.map(r => `${r.s.provider} ${r.s.week} ${pct(r.left)} left${r.spent !== undefined ? ` (${r.spent.name} used up)` : ''}`).join('; ')
  const best = rows[0]!
  return { model: best.s.model, reason: `the ${best.s.provider} subscription has the most of its week left (${readings})` }
}

export async function readQuotas(io: Io, gatewayUrl: string): Promise<SubscriptionQuota[]> {
  const url = `${gatewayUrl.replace(/\/+$/, '')}/v1/magpie/quotas`
  const r = await io.fetch(url, { method: 'GET' })
  if (!r.ok) throw new Error(`Magpie quotas: GET ${url} answered ${r.status}: ${r.text.slice(0, 300)}`)
  return parseQuotas(r.text)
}
