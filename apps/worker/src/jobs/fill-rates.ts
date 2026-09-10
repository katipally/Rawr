import { refreshFillRates, type AccountContext } from '@rawr/db'
import { z } from 'zod'
import { owner } from '../db.ts'
import { defineJob } from './registry.ts'

/** The fill rate of every property, once a night.
 *
 *  The settings screen wants "how many records hold a value" beside three hundred
 *  and seventy-two properties at once, and that answer costs a scan each. One
 *  statement per object gets all of them out of a single pass, so the cost is a
 *  handful of scans a night rather than hundreds a page load, and the stamp the
 *  count carries is what lets the screen say how old it is. */

const jobContext = (accountId: string): AccountContext => ({
  accountId,
  actorId: null,
  actorKind: 'job',
  isSuperAdmin: false,
  viewHubs: [],
  editHubs: ['account'],
})

export const fillFieldRates = defineJob({
  name: 'fields.fillrate',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 300,
  handle: async () => {
    // Per account, so one tenant's three hundred properties cannot stall another's.
    const accounts = await owner<{ id: string; slug: string }[]>`select id, slug from account`
    for (const row of accounts) {
      const { objects, fields } = await refreshFillRates(jobContext(row.id))
      console.log(`[fields.fillrate] ${row.slug}: ${fields} propert(ies) across ${objects} object(s).`)
    }
  },
})
