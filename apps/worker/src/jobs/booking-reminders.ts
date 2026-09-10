import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { APP_BASE, INTERNAL_SECRET } from '../env.ts'
import { bySlug, defineJob } from './registry.ts'

/** The clock behind pre-meeting reminders.
 *
 *  Split the way sequences are, and for the same reason: the dispatch is one scan
 *  a tick over every tenant's upcoming meetings, and the send is one mail through
 *  the app, where the Google credentials live. One slow mailbox must not hold up
 *  every other tenant's reminders.
 *
 *  Lateness is not a reason to skip. A meeting that is still in the future and has
 *  never been reminded about gets its reminder now, however long the worker was
 *  asleep, because a late reminder is worth more than none. A meeting that has
 *  already started gets nothing.
 *
 *  The predicate is `starts_at - amount unit <= now()`, which reads as "the moment
 *  this reminder was due has passed". Postgres parses 'week', 'day', 'hour' and
 *  'minute' as interval units directly, which is why the pair is stored as the
 *  person chose it rather than as minutes. */

/** Enough that a busy five minutes is not left behind, small enough that one tick
 *  cannot flood the queue. */
const BATCH = 500

const dispatch = defineJob({
  name: 'booking.reminders',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 120,
  handle: async () => {
    const rows = await owner<
      { booking_id: string; reminder_id: string; account_id: string; slug: string }[]
    >`
      select b.id as booking_id, r.id as reminder_id, b.account_id, a.slug
        from booking b
        join booking_reminder r on r.booking_page_id = b.booking_page_id
        join account a on a.id = b.account_id
       where b.state = 'confirmed'
         and b.starts_at > now()
         and b.starts_at - (r.amount || ' ' || r.unit)::interval <= now()
         and not exists (
               select 1 from booking_reminder_sent s
                where s.booking_id = b.id and s.reminder_id = r.id)
       order by b.starts_at
       limit ${BATCH}`

    for (const row of rows) {
      await boss().send(
        send.name,
        { accountId: row.account_id, bookingId: row.booking_id, reminderId: row.reminder_id },
        // One in flight per reminder per meeting. The ledger row is the real
        // guarantee; this stops the queue filling with work that will find it.
        { singletonKey: `booking:${row.booking_id}:${row.reminder_id}` },
      )
    }

    if (rows.length > 0) console.log(`[booking] ${rows.length} reminder(s) due: ${bySlug(rows)}`)
  },
})

const send = defineJob({
  name: 'booking.reminder',
  schema: z.object({ accountId: z.uuid(), bookingId: z.uuid(), reminderId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 300,
  handle: async (payload) => {
    const response = await fetch(`${APP_BASE}/api/internal/booking-reminder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    })

    const body = (await response.json()) as { error?: string; sent?: boolean; reason?: string }
    if (!response.ok) {
      throw new Error(body.error ?? `The app answered ${response.status} for booking ${payload.bookingId}.`)
    }
    if (body.sent) console.log(`[booking] reminded ${payload.bookingId}.`)
    else if (body.reason) console.log(`[booking] ${payload.bookingId}: ${body.reason}`)
  },
})

export const bookingReminderJobs = [dispatch, send]
export const dispatchBookingReminders = dispatch
