import { z } from 'zod'
import { owner } from '../db.ts'
import { boss } from '../boss.ts'
import { defineJob } from './registry.ts'

/** F1 phase B, the schedule.
 *
 *  The sync itself lives in the web app, because it needs the Google OAuth client
 *  and the token refresh path that the sign-in flow already owns. Duplicating that
 *  in the worker would mean two places that know how to hold somebody's Google
 *  credentials. So this job asks the app to run a pass, over an internal endpoint
 *  that only accepts a shared secret.
 *
 *  A back-fill returns done:false while there is more history, and this enqueues
 *  the next page immediately rather than waiting for the next tick. Four years of
 *  mail should take minutes, not days. */

const dispatch = defineJob({
  name: 'mail.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 120,
  handle: async () => {
    const rows = await owner`
      select id, workspace_id from mailbox
       where state in ('connected', 'backfilling')`

    for (const row of rows) {
      await boss().send('mail.sync', { workspaceId: row.workspace_id, mailboxId: row.id })
    }
  },
})

const sync = defineJob({
  name: 'mail.sync',
  schema: z.object({ workspaceId: z.uuid(), mailboxId: z.uuid() }),
  retryLimit: 4,
  retryDelaySeconds: 300,
  handle: async ({ workspaceId, mailboxId }) => {
    const base = process.env.RAWR_INTERNAL_URL ?? 'http://localhost:3000'
    const secret = process.env.RAWR_INTERNAL_SECRET ?? ''
    if (!secret) {
      throw new Error(
        'RAWR_INTERNAL_SECRET is not set, so the worker cannot ask the app to read a mailbox. Set the same value on both.',
      )
    }

    const response = await fetch(`${base}/api/internal/mail-sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': secret },
      body: JSON.stringify({ workspaceId, mailboxId }),
      signal: AbortSignal.timeout(120_000),
    })

    const body = (await response.json()) as {
      error?: string
      done?: boolean
      read?: number
      stored?: number
      skipped?: number
      revoked?: boolean
    }

    if (!response.ok) {
      // A withdrawn grant is not a failure to retry. The mailbox has already been
      // marked revoked by the app; throwing would burn four retries against a
      // decision somebody made deliberately. B2.
      if (body.revoked) {
        console.log(`[mail] ${mailboxId}: access withdrawn, sync stopped.`)
        return
      }
      throw new Error(body.error ?? `The app answered ${response.status} for mailbox ${mailboxId}.`)
    }

    if (body.stored || body.skipped) {
      console.log(`[mail] ${mailboxId}: ${body.stored ?? 0} stored, ${body.skipped ?? 0} refused.`)
    }

    // More history to read. Straight back on the queue rather than waiting for the
    // next scheduled tick, which would stretch a large archive over days.
    if (body.done === false) {
      await boss().send('mail.sync', { workspaceId, mailboxId })
    }
  },
})

export const mailJobs = [dispatch, sync]
export const dispatchMailboxes = dispatch
export const syncMailboxJob = sync
