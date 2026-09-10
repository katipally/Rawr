import { scoreAllDeals, type AccountContext } from '@rawr/db'
import { z } from 'zod'
import { owner } from '../db.ts'
import { defineJob } from './registry.ts'

/** Every deal's score, once a night.
 *
 *  A stage change recomputes the one deal it moved, and that is the only input a
 *  write announces. The other five move on their own: a next step falls into the
 *  past, a conversation goes quiet, the pipeline median shifts as deals are won.
 *  So the board would drift by a point a day without this pass, which is one
 *  statement per account rather than one per deal. */

const jobContext = (accountId: string): AccountContext => ({
  accountId,
  actorId: null,
  actorKind: 'job',
  isSuperAdmin: false,
  viewHubs: [],
  editHubs: ['sales'],
})

export const scoreDeals = defineJob({
  name: 'deals.score',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 300,
  handle: async () => {
    const accounts = await owner<{ id: string; slug: string }[]>`select id, slug from account`
    for (const row of accounts) {
      const scored = await scoreAllDeals(jobContext(row.id))
      console.log(`[deals.score] ${row.slug}: ${scored} deal(s) rescored.`)
    }
  },
})
