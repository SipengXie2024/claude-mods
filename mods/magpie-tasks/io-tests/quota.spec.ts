// The acceptance choice on Magpie's live quota readings (GET <gateway>/v1/magpie/quotas through
// nodeIo): the answer parses, every subscription the rules file lists has its weekly window, and the
// chosen one has the largest share of its week left among those with no window used up.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { acceptancePick, readQuotas } from '../src/quota'
import { loadRules } from '../src/rules'
import { nodeIo } from './node-io'

const GATEWAY = 'http://127.0.0.1:3425'
const rules = await loadRules(nodeIo(), join(import.meta.dir, '..'))

test('the live readings choose the subscription with the most of its week left', async () => {
  const io = nodeIo()
  const quotas = await readQuotas(io, GATEWAY)
  expect(io.calls).toEqual([{ method: 'fetch', url: `${GATEWAY}/v1/magpie/quotas` }])
  const rows = rules.acceptance.subscriptions.map(s => {
    const q = quotas.find(x => x.provider === s.provider)!
    const relevant = q.windows.filter(w => w.name === s.week || s.limits.includes(w.name))
    return { model: s.model, week: q.windows.find(w => w.name === s.week)!.remaining, spent: relevant.some(w => w.remaining <= 0) }
  })
  const pick = acceptancePick(rules, quotas)
  console.log(`live pick: ${pick.model}; ${pick.reason}`)
  const chosen = rows.find(r => r.model === pick.model)!
  for (const r of rows) {
    if (r.spent && !chosen.spent) continue
    expect(chosen.week).toBeGreaterThanOrEqual(r.week)
  }
})
