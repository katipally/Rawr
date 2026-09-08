import { eq, sql } from 'drizzle-orm'
import { visitor, visitorAlias } from '../schema/analytics.ts'
import { sourceFromSession } from './attribution.ts'
import type { AccountContext } from './context.ts'
import { publicEdgeContext } from './forms.ts'
import { withAccount, type Tx } from './index.ts'

/** F4 §3. Identity stitching: the mechanism that makes a brand-new contact arrive
 *  with a month of browsing history already on their timeline.
 *
 *  Two halves, deliberately split. The request that created the contact writes one
 *  alias row and stops; a visitor with 5,000 views must not make a form response
 *  wait. The worker claims that row and does the back-fill, chunked and idempotent,
 *  off the request path. Same mechanism as field_index, so there is exactly one way
 *  a request asks for background work. */

export type AliasVia = 'form_submission' | 'booking' | 'product_signin'

/** Written inside the caller's transaction, always. A committed contact whose
 *  browsing history was silently not claimed is not a state worth being able to
 *  reach.
 *
 *  If this visitor is already aliased to a different contact — a shared computer —
 *  the newest identification wins for future views and past views stay with the
 *  contact they were attributed to. Retroactively moving history between people is
 *  worse than a slightly stale attribution. */
export const aliasVisitor = async (
  tx: Tx,
  ctx: AccountContext,
  input: { visitorId: string; contactId: string; via: AliasVia },
): Promise<void> => {
  await tx
    .insert(visitorAlias)
    .values({
      accountId: ctx.accountId,
      visitorId: input.visitorId,
      contactId: input.contactId,
      via: input.via,
    })
    .onConflictDoNothing()

  // The visitor row may not exist yet: consent can be granted on a page whose
  // beacon has not landed. Creating it here means the next page view is attributed
  // without waiting for the back-fill.
  await tx
    .insert(visitor)
    .values({ accountId: ctx.accountId, id: input.visitorId, contactId: input.contactId })
    .onConflictDoUpdate({
      target: [visitor.accountId, visitor.id],
      set: { contactId: input.contactId },
    })
}

/** How many rows one pass moves. Small enough that a 20,000-view visitor never
 *  holds a transaction open long, large enough that it finishes in a few passes. */
export const BACKFILL_CHUNK = 500

export type BackfillResult = { pageViews: number; events: number; done: boolean }

/** Idempotent by construction: it only ever touches rows whose contact_id is null,
 *  so a re-run after a crash moves what is left and nothing twice.
 *
 *  One statement per chunk. The update, the timeline entries it produces and the
 *  links onto the contact are three data-modifying CTEs over three different
 *  tables, which is well defined; splitting them would leave a window where a page
 *  view is attributed but missing from the timeline. */
export const backfillVisitor = async (
  ctx: AccountContext,
  input: { visitorId: string; contactId: string },
): Promise<BackfillResult> =>
  withAccount(ctx, async (tx) => {
    const pageViews = await claimChunk(tx, ctx, input, 'page_view')
    const events = await claimChunk(tx, ctx, input, 'custom_event')
    const done = pageViews < BACKFILL_CHUNK && events < BACKFILL_CHUNK
    // Once every chunk has moved, the visitor's whole history belongs to this
    // contact, and their first session may well predate the form that named them.
    if (done) await moveFirstTouchEarlier(tx, ctx, input)
    return { pageViews, events, done }
  })

/** B7's first-touch rule, and the only direction it moves in.
 *
 *  Somebody read three blog posts from a paid ad in March and filled in a form in
 *  July. The form's own attribution is the July visit, so without this the contact
 *  reads as Direct Traffic and the ad that actually found them is invisible. The
 *  update is guarded on the stored timestamp, so it only ever moves the first touch
 *  backwards: a later session can never claim to be the first one, and running the
 *  back-fill twice changes nothing the second time. */
const moveFirstTouchEarlier = async (
  tx: Tx,
  ctx: AccountContext,
  input: { visitorId: string; contactId: string },
): Promise<void> => {
  const [earliest] = await tx.execute<{
    referrer: string | null
    utm: Record<string, unknown> | null
    entry_path: string | null
    started_at: Date | string
  }>(sql`
    select referrer, utm, entry_path, started_at
      from visitor_session
     where account_id = ${ctx.accountId} and visitor_id = ${input.visitorId}
     order by started_at
     limit 1`)
  if (!earliest) return

  const startedAt = new Date(earliest.started_at)
  const source = {
    ...sourceFromSession({
      referrer: earliest.referrer,
      utm: earliest.utm,
      pagePath: earliest.entry_path,
      at: startedAt,
    }),
    via: 'tracking',
  }

  await tx.execute(sql`
    update contact
       set original_source = ${JSON.stringify(source)}::jsonb,
           updated_at = now()
     where id = ${input.contactId}
       and account_id = ${ctx.accountId}
       and (
         original_source is null
         or (original_source #>> '{detail,firstSeenAt}') is null
         or (original_source #>> '{detail,firstSeenAt}')::timestamptz > ${startedAt.toISOString()}::timestamptz
       )`)
}

const claimChunk = async (
  tx: Tx,
  ctx: AccountContext,
  input: { visitorId: string; contactId: string },
  table: 'page_view' | 'custom_event',
): Promise<number> => {
  const source = sql.raw(table)
  const activityType = sql.raw(`'${table}'`)
  // "viewed Data Studio" for a page, "fired signup_started" for an event.
  const subject =
    table === 'page_view'
      ? sql`'viewed ' || coalesce(nullif(m.title, ''), m.path)`
      : sql`'fired ' || m.name`
  const payload =
    table === 'page_view'
      ? sql`jsonb_build_object('pageViewId', m.id, 'path', m.path, 'url', m.url, 'sessionId', m.session_id)`
      : sql`jsonb_build_object('eventId', m.id, 'name', m.name, 'sessionId', m.session_id)`

  const rows = await tx.execute<{ n: string }>(sql`
    with claimable as (
      select id from ${source}
       where account_id = ${ctx.accountId}
         and visitor_id = ${input.visitorId}
         and contact_id is null
       order by at
       limit ${BACKFILL_CHUNK}
       for update skip locked
    ), moved as (
      update ${source} t
         set contact_id = ${input.contactId}
        from claimable c
       where t.id = c.id
      returning t.*
    ), logged as (
      insert into activity (account_id, type, subject, occurred_at, actor_kind, source, payload)
      select ${ctx.accountId}, ${activityType}::rawr_activity_type, ${subject}, m.at,
             'job'::rawr_actor_kind, 'tracking', ${payload}
        from moved m
      returning id, occurred_at
    ), linked as (
      insert into activity_link (account_id, activity_id, entity_type, entity_id, type, occurred_at)
      select ${ctx.accountId}, l.id, 'contact'::text, ${input.contactId},
             ${activityType}::rawr_activity_type, l.occurred_at
        from logged l
      on conflict do nothing
      returning activity_id
    )
    select count(*)::text as n from linked`)

  return Number(rows[0]?.n ?? 0)
}

/** Recomputed rather than incremented. After a back-fill the counters have to be
 *  right regardless of how many passes it took or which of them was retried, and
 *  a recount over one contact's rows is one index scan.
 *
 *  page_view_daily is added in because raw rows past the retention window are gone
 *  and their counts still have to be honest. */
export const refreshContactActivity = async (
  ctx: AccountContext,
  contactId: string,
): Promise<void> =>
  withAccount(ctx, async (tx) => {
    await tx.execute(sql`
      insert into contact_activity
        (account_id, contact_id, site_visits, pages_viewed, first_seen_at, last_seen_at)
      select ${ctx.accountId}, ${contactId},
             coalesce(v.visits, 0),
             coalesce(v.views, 0) + coalesce(d.views, 0),
             least(v.first_at, d.first_day), greatest(v.last_at, d.last_day)
        from (select count(distinct session_id) as visits, count(*) as views,
                     min(at) as first_at, max(at) as last_at
                from page_view
               where account_id = ${ctx.accountId} and contact_id = ${contactId}) v
        cross join (select coalesce(sum(views), 0) as views,
                           min(day)::timestamptz as first_day, max(day)::timestamptz as last_day
                      from page_view_daily
                     where account_id = ${ctx.accountId} and contact_id = ${contactId}) d
      on conflict (account_id, contact_id) do update
         set site_visits = excluded.site_visits,
             pages_viewed = excluded.pages_viewed,
             first_seen_at = excluded.first_seen_at,
             last_seen_at = excluded.last_seen_at`)
  })

/** Every contact in the account at once, for the nightly roll-up.
 *
 *  The same arithmetic as above, expressed as two grouped scans and one upsert
 *  instead of one statement per contact. The per-contact form is right when a
 *  back-fill has just touched one person; after a roll-up it was being called once
 *  for every row in contact_activity, which is a network round trip per contact
 *  and does not survive 88,270 of them.
 *
 *  A contact whose rows have all gone is zeroed rather than left holding the count
 *  it had before, which is what the per-contact version did by recomputing over an
 *  empty set. */
export const refreshAllContactActivity = async (ctx: AccountContext): Promise<number> =>
  withAccount(ctx, async (tx) => {
    const written = await tx.execute<{ contact_id: string }>(sql`
      with viewed as (
        select contact_id, count(distinct session_id) as visits, count(*) as views,
               min(at) as first_at, max(at) as last_at
          from page_view
         where account_id = ${ctx.accountId} and contact_id is not null
         group by contact_id
      ), rolled as (
        select contact_id, sum(views) as views,
               min(day)::timestamptz as first_day, max(day)::timestamptz as last_day
          from page_view_daily
         where account_id = ${ctx.accountId}
         group by contact_id
      )
      insert into contact_activity
        (account_id, contact_id, site_visits, pages_viewed, first_seen_at, last_seen_at)
      select ${ctx.accountId}, coalesce(viewed.contact_id, rolled.contact_id),
             coalesce(viewed.visits, 0),
             coalesce(viewed.views, 0) + coalesce(rolled.views, 0),
             least(viewed.first_at, rolled.first_day),
             greatest(viewed.last_at, rolled.last_day)
        from viewed full outer join rolled on rolled.contact_id = viewed.contact_id
      on conflict (account_id, contact_id) do update
         set site_visits = excluded.site_visits,
             pages_viewed = excluded.pages_viewed,
             first_seen_at = excluded.first_seen_at,
             last_seen_at = excluded.last_seen_at
      returning contact_id`)

    // Anybody left in the table with nothing behind them any more. Erasure and a
    // retention window both get here.
    await tx.execute(sql`
      update contact_activity
         set site_visits = 0, pages_viewed = 0, first_seen_at = null, last_seen_at = null
       where account_id = ${ctx.accountId}
         and pages_viewed <> 0
         and contact_id not in (
           select contact_id from page_view
            where account_id = ${ctx.accountId} and contact_id is not null
           union
           select contact_id from page_view_daily where account_id = ${ctx.accountId})`)

    return written.length
  })

/** Called by the worker once a claimed alias is fully back-filled. */
export const markAliasResolved = async (
  ctx: AccountContext,
  aliasId: string,
  error?: string,
): Promise<void> =>
  withAccount(ctx, async (tx) => {
    await tx
      .update(visitorAlias)
      .set(
        error
          ? { lastError: error.slice(0, 2000) }
          : { resolvedAt: new Date(), lastError: null },
      )
      .where(eq(visitorAlias.id, aliasId))
  })

export type PendingAlias = {
  id: string
  accountId: string
  visitorId: string
  contactId: string
}

/** F1's contact merge moves everything the loser owned onto the survivor. Visitor
 *  aliases and the denormalised contact_id on both event tables are part of that,
 *  or a merged contact loses their browsing history. */
export const moveVisitorHistory = async (
  tx: Tx,
  ctx: AccountContext,
  from: string,
  to: string,
): Promise<void> => {
  await tx.execute(sql`
    delete from visitor_alias a
     where a.account_id = ${ctx.accountId}
       and a.contact_id = ${from}
       and exists (select 1 from visitor_alias keep
                    where keep.account_id = a.account_id
                      and keep.visitor_id = a.visitor_id
                      and keep.contact_id = ${to})`)

  await tx
    .update(visitorAlias)
    .set({ contactId: to })
    .where(eq(visitorAlias.contactId, from))

  for (const table of ['page_view', 'custom_event', 'visitor'] as const) {
    await tx.execute(sql`
      update ${sql.raw(table)} set contact_id = ${to}
       where account_id = ${ctx.accountId} and contact_id = ${from}`)
  }

  await tx.execute(sql`
    insert into page_view_daily (account_id, contact_id, day, views)
    select account_id, ${to}, day, views
      from page_view_daily
     where account_id = ${ctx.accountId} and contact_id = ${from}
    on conflict (account_id, contact_id, day)
      do update set views = page_view_daily.views + excluded.views`)

  await tx.execute(sql`
    delete from page_view_daily
     where account_id = ${ctx.accountId} and contact_id = ${from}`)
}

/** The public edge identifies people too: a booking creates a contact from a
 *  stranger's visitor id. Same context ceiling as a form fill. */
export const aliasFromPublicEdge = async (
  accountId: string,
  input: { visitorId: string; contactId: string; via: AliasVia },
): Promise<void> => {
  const ctx = publicEdgeContext(accountId)
  await withAccount(ctx, (tx) => aliasVisitor(tx, ctx, input))
}
