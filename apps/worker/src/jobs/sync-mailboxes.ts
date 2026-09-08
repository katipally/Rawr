import { z } from 'zod'
import { owner } from '../db.ts'
import { INTERNAL_SECRET } from '../env.ts'
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
      select id, account_id from mailbox
       where state in ('connected', 'backfilling')`

    for (const row of rows) {
      await boss().send('mail.sync', { accountId: row.account_id, mailboxId: row.id })
    }
  },
})

const sync = defineJob({
  name: 'mail.sync',
  schema: z.object({ accountId: z.uuid(), mailboxId: z.uuid() }),
  retryLimit: 4,
  retryDelaySeconds: 300,
  handle: async ({ accountId, mailboxId }) => {
    const base = process.env.RAWR_INTERNAL_URL ?? 'http://localhost:3000'

    const response = await fetch(`${base}/api/internal/mail-sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify({ accountId, mailboxId }),
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
      await boss().send('mail.sync', { accountId, mailboxId })
    }
  },
})

/** Bodies, after the messages. Split from the sync deliberately: a sync that
 *  failed because one enormous mail timed out would cost the whole page of
 *  messages, and a message without its body is still on the record and still
 *  findable by its snippet.
 *
 *  Only mailboxes with a backlog are enqueued, which the partial index on
 *  body_state makes cheap to ask. */
const hydrateDispatch = defineJob({
  name: 'mail.hydrate.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 120,
  handle: async () => {
    const rows = await owner`
      select distinct m.mailbox_id as id, m.account_id
        from message m
        join mailbox b on b.id = m.mailbox_id
       where m.body_state = 'pending' and b.state in ('connected', 'backfilling')`

    for (const row of rows) {
      await boss().send('mail.hydrate', { accountId: row.account_id, mailboxId: row.id })
    }
  },
})

const hydrate = defineJob({
  name: 'mail.hydrate',
  schema: z.object({ accountId: z.uuid(), mailboxId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 300,
  handle: async ({ accountId, mailboxId }) => {
    const base = process.env.RAWR_INTERNAL_URL ?? 'http://localhost:3000'

    const response = await fetch(`${base}/api/internal/mail-hydrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify({ accountId, mailboxId }),
      signal: AbortSignal.timeout(120_000),
    })

    const body = (await response.json()) as {
      error?: string
      stored?: number
      failed?: number
      remaining?: boolean
      revoked?: boolean
    }

    if (!response.ok) {
      if (body.revoked) {
        console.log(`[mail] ${mailboxId}: access withdrawn, bodies left as they are.`)
        return
      }
      throw new Error(body.error ?? `The app answered ${response.status} for mailbox ${mailboxId}.`)
    }

    if (body.stored || body.failed) {
      console.log(`[mail] ${mailboxId}: ${body.stored ?? 0} bodies stored, ${body.failed ?? 0} could not be.`)
    }

    // Straight back on the queue while there is a backlog, for the same reason
    // the sync does it: a large archive should take minutes, not days.
    if (body.remaining) {
      await boss().send('mail.hydrate', { accountId, mailboxId })
    }
  },
})

export const mailJobs = [dispatch, sync, hydrateDispatch, hydrate]
export const dispatchMailboxes = dispatch
export const dispatchMailboxBodies = hydrateDispatch
