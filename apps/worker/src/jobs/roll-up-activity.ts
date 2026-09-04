import { refreshAllContactActivity, rollUpExpired, type WorkspaceContext } from '@rawr/db'
import { z } from 'zod'
import { owner } from '../db.ts'
import { defineJob } from './registry.ts'

/** F4 §1. Raw page views live for the retention window, then collapse to one row
 *  per contact per day. Aggregate counts stay honest afterwards, which is what
 *  lets the window be a data-protection decision rather than a lossy one.
 *
 *  Configurable because it is that decision, not a technical constant. */
const RETENTION_MONTHS = Number(process.env.ACTIVITY_RETENTION_MONTHS ?? '25')

const jobContext = (workspaceId: string): WorkspaceContext => ({
  workspaceId,
  actorId: null,
  actorKind: 'job',
  role: 'marketing',
})

export const rollUpActivity = defineJob({
  name: 'activity.rollup',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 300,
  handle: async () => {
    if (!Number.isFinite(RETENTION_MONTHS) || RETENTION_MONTHS < 1) {
      throw new Error(
        `ACTIVITY_RETENTION_MONTHS is "${process.env.ACTIVITY_RETENTION_MONTHS}", which is not a number of months.`,
      )
    }

    // Per workspace, so one tenant's backlog cannot stall another's. This is the
    // one query that crosses tenants, and it reads nothing but ids.
    const workspaces = await owner`select id from workspace`

    for (const row of workspaces) {
      const ctx = jobContext(row.id)
      const { rolled } = await rollUpExpired(ctx, RETENTION_MONTHS)
      if (rolled === 0) continue

      console.log(`[activity.rollup] rolled ${rolled} page view(s) in workspace ${row.id}.`)

      // The counters were computed from rows that have just moved into the daily
      // table. Recomputing reads both, so the numbers on the panel do not change.
      // One statement for the whole workspace: this used to be a round trip per
      // contact, which is fine at 20 seeded rows and not at 88,270.
      const refreshed = await refreshAllContactActivity(ctx)
      console.log(`[activity.rollup] recomputed ${refreshed} contact counter(s).`)
    }
  },
})
