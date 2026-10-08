import { evaluateAllSegments, syncSegmentFailures, systemContext, type AccountContext } from '@rawr/db'
import { z } from 'zod'
import { owner } from '../db.ts'
import { defineJob, eachAccount } from './registry.ts'

/** A2: "membership recomputed on write and on a schedule". This is the schedule.
 *
 *  A segment answers a question about records that change constantly, so its
 *  membership is always a little behind. The scheduled pass is what bounds how far:
 *  a contact who became a customer this morning is in the customer segment, and on
 *  their timeline, within the hour rather than whenever somebody happens to press a
 *  button.
 *
 *  A segment whose filter refers to a field that has since been deleted fails on
 *  its own and does not take the others with it, which is why the layer reports per
 *  segment rather than throwing. Each broken segment keeps one open dead letter
 *  naming it, so an admin can see which query broke; it closes once the segment
 *  evaluates again. */
const jobContext = (accountId: string, timezone: string): AccountContext => ({
  accountId,
  timezone,
  actorId: null,
  actorKind: 'job',
  isSuperAdmin: false,
  viewHubs: [],
  editHubs: ['contacts', 'marketing'],
})

export const evaluateSegments = defineJob({
  name: 'segments.evaluate',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 300,
  audience: 'select id as account_id from account',
  handle: async () => {
    // Per account, so one tenant's slow query cannot stall another's. The only
    // query here that crosses tenants, and it reads nothing but ids.
    const accounts = await owner`select id, slug, timezone from account`

    await eachAccount(accounts, (row) => row.id, async (row) => {
      const results = await evaluateAllSegments(jobContext(row.id, row.timezone))
      // A broken segment keeps one open dead letter, refreshed each pass. Throwing
      // would retry every other account's segments three times over to record a
      // query that will not start working on its own.
      await syncSegmentFailures(systemContext(row.id), results)
      for (const result of results) {
        if (result.result && (result.result.entered > 0 || result.result.exited > 0)) {
          console.log(
            `[segments] ${row.slug} ${result.name}: ${result.result.entered} in, ${result.result.exited} out, ${result.result.members} now.`,
          )
        }
      }
    })
  },
})
