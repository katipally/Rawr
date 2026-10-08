import { refreshAllContactActivity, rollUpExpired, type AccountContext } from '@rawr/db'
import { z } from 'zod'
import { owner } from '../db.ts'
import { defineJob, eachAccount } from './registry.ts'

/** F4 §1. Raw page views collapse to one row per contact per day once past the
 *  account's window. Aggregate counts stay honest, so nothing is lost. */

const jobContext = (accountId: string): AccountContext => ({
  accountId,
  actorId: null,
  actorKind: 'job',
  isSuperAdmin: false,
  viewHubs: [],
  editHubs: ['contacts', 'marketing'],
})

export const rollUpActivity = defineJob({
  name: 'activity.rollup',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 300,
  policy: 'exclusive',
  audience: 'select id as account_id from account',
  handle: async () => {
    // Per account, so one tenant's backlog cannot stall another's.
    const accounts = await owner<{ id: string; months: number }[]>`
      select a.id, a.activity_retention_months as months from account a`

    await eachAccount(accounts, (row) => row.id, async (row) => {
      const ctx = jobContext(row.id)
      const { rolled } = await rollUpExpired(ctx, Number(row.months))
      if (rolled === 0) return

      console.log(`[activity.rollup] rolled ${rolled} page view(s) in account ${row.id}.`)

      // One statement, not one per contact: 88,270 round trips is not a strategy.
      const refreshed = await refreshAllContactActivity(ctx)
      console.log(`[activity.rollup] recomputed ${refreshed} contact counter(s).`)
    })
  },
})
