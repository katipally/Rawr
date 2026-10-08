import { z } from 'zod'
import { owner } from '../db.ts'
import { APP_BASE, INTERNAL_SECRET } from '../env.ts'
import { boss } from '../boss.ts'
import { defineJob, eachAccount } from './registry.ts'

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
  audience: `select distinct account_id from mailbox where state in ('connected', 'backfilling', 'error')`,
  handle: async () => {
    // An errored mailbox is asked again once its pause is over: five minutes,
    // doubling with each failure in a row, up to six hours. A transient fault (a
    // Google 5xx, a quota) must not end syncing until somebody reconnects.
    const rows = await owner`
      select id, account_id from mailbox
       where state in ('connected', 'backfilling')
          or (state = 'error'
              and last_error_at + least(360, 5 * power(2, least(greatest(failures, 1) - 1, 10))) * interval '1 minute' < now())`

    await eachAccount(rows, (row) => row.account_id, (row) =>
      // At most one queued pass per mailbox. A ten-minute tick landing while the
      // previous sync is still reading history does not queue a second copy. A pass
      // that outlives a tick can still overlap the queued one, because a running
      // pass does not block the next one on a short queue.
      boss().send('mail.sync', { accountId: row.account_id, mailboxId: row.id }, { singletonKey: String(row.id) }),
    )
  },
})

const sync = defineJob({
  name: 'mail.sync',
  schema: z.object({ accountId: z.uuid(), mailboxId: z.uuid() }),
  retryLimit: 4,
  retryDelaySeconds: 300,
  policy: 'short',
  handle: async ({ accountId, mailboxId }) => {
    const response = await fetch(`${APP_BASE}/api/internal/mail-sync`, {
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
      await boss().send('mail.sync', { accountId, mailboxId }, { singletonKey: mailboxId })
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
  audience: `select distinct account_id from message where body_state = 'pending'`,
  handle: async () => {
    const rows = await owner`
      select distinct m.mailbox_id as id, m.account_id
        from message m
        join mailbox b on b.id = m.mailbox_id
       where m.body_state = 'pending' and b.state in ('connected', 'backfilling')`

    await eachAccount(rows, (row) => row.account_id, (row) =>
      boss().send('mail.hydrate', { accountId: row.account_id, mailboxId: row.id }, { singletonKey: String(row.id) }),
    )
  },
})

const hydrate = defineJob({
  name: 'mail.hydrate',
  schema: z.object({ accountId: z.uuid(), mailboxId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 300,
  policy: 'short',
  handle: async ({ accountId, mailboxId }) => {
    const response = await fetch(`${APP_BASE}/api/internal/mail-hydrate`, {
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
      await boss().send('mail.hydrate', { accountId, mailboxId }, { singletonKey: mailboxId })
    }
  },
})

/** Inbox changes made in Rawr (archive, trash, unread) that Gmail has not had yet. The
 *  change is already saved when this runs, so the dispatcher only finds the threads that
 *  are waiting: one indexed scan, one job per thread, and a job already queued for a
 *  thread is not queued twice.
 *
 *  A thread still waiting after a day is left to the dead letter that its failed job
 *  raised, rather than being retried every few minutes for ever. */
const pushDispatch = defineJob({
  name: 'mail.push.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 60,
  audience: `select distinct account_id from message_thread where state_changed_at is distinct from gmail_synced_at`,
  handle: async () => {
    const rows = await owner`
      select account_id, thread_id from (
        select t.account_id, t.id as thread_id
          from message_thread t
         where t.state_changed_at is distinct from t.gmail_synced_at
           and t.state_changed_at > now() - interval '1 day'
        union
        select r.account_id, r.thread_id
          from message_thread_read r
          join mailbox b on b.user_id = r.user_id and b.account_id = r.account_id
         where r.gmail_unread is not null and b.can_modify and b.state <> 'revoked'
      ) waiting
       limit 500`

    await eachAccount(rows, (row) => row.account_id, (row) =>
      boss().send('mail.push', { accountId: row.account_id, threadId: row.thread_id }, { singletonKey: String(row.thread_id) }),
    )
  },
})

const push = defineJob({
  name: 'mail.push',
  schema: z.object({ accountId: z.uuid(), threadId: z.uuid() }),
  retryLimit: 4,
  retryDelaySeconds: 120,
  policy: 'short',
  handle: async ({ accountId, threadId }) => {
    const response = await fetch(`${APP_BASE}/api/internal/mail-push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify({ accountId, threadId }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? `The app answered ${response.status} for thread ${threadId}.`)
    }
  },
})

export const mailJobs = [dispatch, sync, hydrateDispatch, hydrate, pushDispatch, push]
export const dispatchMailboxes = dispatch
export const dispatchMailboxBodies = hydrateDispatch
export const dispatchMailPush = pushDispatch
