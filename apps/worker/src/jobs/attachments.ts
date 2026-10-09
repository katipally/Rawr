import { abandonedBefore } from '@rawr/db'
import { z } from 'zod'
import { owner } from '../db.ts'
import { APP_BASE, INTERNAL_SECRET } from '../env.ts'
import { defineJob, eachAccount } from './registry.ts'

/** Uploads begun in the composer or the record dialog and never filed. Their bytes
 *  sit in storage, which only the app holds a client for, so this finds the accounts
 *  with abandoned rows and asks the app to clear each one. The rows are read over the
 *  owner pool, the same cross-tenant path mail.push.dispatch uses. */
export const sweepAttachments = defineJob({
  name: 'attachments.sweep',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 300,
  audience: 'select id as account_id from account',
  handle: async () => {
    const rows = await owner`
      select distinct account_id from attachment_upload
       where expires_at <= ${abandonedBefore(new Date())}::timestamptz`

    await eachAccount(rows, (row) => row.account_id, async (row) => {
      const response = await fetch(`${APP_BASE}/api/internal/attachment-sweep`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
        body: JSON.stringify({ accountId: row.account_id }),
        signal: AbortSignal.timeout(120_000),
      })
      const body = (await response.json().catch(() => null)) as { error?: string; removed?: number; failed?: number } | null
      if (!response.ok) throw new Error(body?.error ?? `The app answered ${response.status} for the attachment sweep.`)
      // A failed removal kept its row, so the next hourly pass tries it again.
      if (body?.removed || body?.failed) {
        console.log(`[attachments] ${row.account_id}: ${body.removed ?? 0} abandoned uploads removed, ${body.failed ?? 0} kept for retry.`)
      }
    })
  },
})
