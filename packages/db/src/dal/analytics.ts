import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  collectorNotice,
  contactActivity,
  customEvent,
  pageView,
  site,
  visitor,
  visitorSession,
} from '../schema/analytics.ts'
import { consentRecord } from '../schema/forms.ts'
import { assertCanWrite, type WorkspaceContext } from './context.ts'
import { mutate, withWorkspace } from './index.ts'
import { refreshContactActivity } from './stitch.ts'

/** F4 §4. The read side: the three numbers on a contact record, the detail behind
 *  one page view, and the two paths a data-subject request needs. */

export type WebsiteActivity = {
  siteVisits: number
  pagesViewed: number
  firstSeenAt: Date | null
  lastSeenAt: Date | null
  devices: number
}

/** The same three numbers HubSpot shows, read from the maintained counter rather
 *  than counted. A contact with 20,000 page views opens as fast as one with three
 *  because this is a primary-key lookup either way. */
export const websiteActivity = async (
  ctx: WorkspaceContext,
  contactId: string,
): Promise<WebsiteActivity> =>
  withWorkspace(ctx, async (tx) => {
    const [row] = await tx
      .select({
        siteVisits: contactActivity.siteVisits,
        pagesViewed: contactActivity.pagesViewed,
        firstSeenAt: contactActivity.firstSeenAt,
        lastSeenAt: contactActivity.lastSeenAt,
      })
      .from(contactActivity)
      .where(eq(contactActivity.contactId, contactId))
      .limit(1)

    const [devices] = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from visitor_alias
       where workspace_id = ${ctx.workspaceId} and contact_id = ${contactId}`)

    return {
      siteVisits: row?.siteVisits ?? 0,
      pagesViewed: row?.pagesViewed ?? 0,
      firstSeenAt: row?.firstSeenAt ?? null,
      lastSeenAt: row?.lastSeenAt ?? null,
      devices: Number(devices?.n ?? 0),
    }
  })

export type PageViewDetail = {
  id: string
  contactId: string | null
  contactName: string | null
  url: string
  path: string
  title: string | null
  referrer: string | null
  utm: Record<string, string>
  device: string | null
  browser: string | null
  country: string | null
  siteName: string | null
  at: Date
  session: {
    id: string
    startedAt: Date
    endedAt: Date
    pageCount: number
    referrer: string | null
    /** What else they looked at in that visit, in order. The reason this screen
     *  exists rather than a tooltip on the timeline. */
    views: { id: string; path: string; title: string | null; at: Date }[]
  } | null
}

/** One page view, with the visit it belonged to. Addressed by its own id so the
 *  screen pastes into Slack like every other surface. */
export const readPageView = async (
  ctx: WorkspaceContext,
  id: string,
): Promise<PageViewDetail | null> =>
  withWorkspace(ctx, async (tx) => {
    const [row] = await tx.execute<{
      id: string
      contact_id: string | null
      contact_name: string | null
      url: string
      path: string
      title: string | null
      referrer: string | null
      utm: Record<string, string>
      device: string | null
      ua_family: string | null
      country: string | null
      site_name: string | null
      at: Date
      session_id: string | null
    }>(sql`
      select p.id, p.contact_id, p.url, p.path, p.title, p.referrer, p.utm,
             p.device, p.ua_family, p.country, p.at, p.session_id,
             s.name as site_name,
             nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '')
               as contact_name
        from page_view p
        left join site s on s.id = p.site_id
        left join contact c on c.id = p.contact_id
       where p.id = ${id}`)

    if (!row) return null

    const session = row.session_id ? await readSession(tx, row.session_id) : null

    return {
      id: row.id,
      contactId: row.contact_id,
      contactName: row.contact_name,
      url: row.url,
      path: row.path,
      title: row.title,
      referrer: row.referrer,
      utm: row.utm ?? {},
      device: row.device,
      browser: row.ua_family,
      country: row.country,
      siteName: row.site_name,
      at: new Date(row.at),
      session,
    }
  })

/** Capped, because a bot that got past the filter or a single-page app that got
 *  past the debounce would otherwise render a session of ten thousand rows. */
const SESSION_VIEW_CAP = 200

const readSession = async (
  tx: Parameters<Parameters<typeof withWorkspace>[1]>[0],
  sessionId: string,
): Promise<PageViewDetail['session']> => {
  const [row] = await tx
    .select({
      id: visitorSession.id,
      startedAt: visitorSession.startedAt,
      endedAt: visitorSession.endedAt,
      pageCount: visitorSession.pageCount,
      referrer: visitorSession.referrer,
    })
    .from(visitorSession)
    .where(eq(visitorSession.id, sessionId))
    .limit(1)
  if (!row) return null

  const views = await tx
    .select({ id: pageView.id, path: pageView.path, title: pageView.title, at: pageView.at })
    .from(pageView)
    .where(eq(pageView.sessionId, sessionId))
    .orderBy(pageView.at)
    .limit(SESSION_VIEW_CAP)

  return { ...row, views }
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export type SiteRow = {
  id: string
  name: string
  host: string
  siteKey: string
  isActive: boolean
  pageViews: number
  lastEventAt: Date | null
}

export const listSites = async (ctx: WorkspaceContext): Promise<SiteRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      name: string
      host: string
      site_key: string
      is_active: boolean
      page_views: string
      last_at: Date | null
    }>(sql`
      select s.id, s.name, s.host, s.site_key, s.is_active,
             count(p.id) as page_views, max(p.at) as last_at
        from site s
        left join page_view p on p.site_id = s.id
       where s.workspace_id = ${ctx.workspaceId}
       group by s.id
       order by s.name`)

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      host: row.host,
      siteKey: row.site_key,
      isActive: row.is_active,
      pageViews: Number(row.page_views),
      lastEventAt: row.last_at ? new Date(row.last_at) : null,
    }))
  })

const SITE_KEY = /^[a-z0-9][a-z0-9-]{2,60}$/

/** The driver's error, not the query builder's wrapper around it. Drizzle's
 *  message is the SQL and the parameters; the SQLSTATE and the constraint name
 *  are on the cause, and matching on those is what makes this specific rather
 *  than a substring search over somebody's site name. */
const violates = (cause: unknown, constraint: string): boolean => {
  const driver = (cause as { cause?: { code?: string; constraint_name?: string } } | null)?.cause
  return driver?.code === '23505' && driver.constraint_name === constraint
}

export const createSite = async (
  ctx: WorkspaceContext,
  input: { name: string; host: string; siteKey: string },
): Promise<{ id: string }> =>
  mutate(ctx, 'site', async (tx) => {
    const siteKey = input.siteKey.trim().toLowerCase()
    if (!SITE_KEY.test(siteKey)) {
      throw new Error(
        'A site key is 3 to 61 characters of lowercase letters, numbers and hyphens, and starts with a letter or number.',
      )
    }
    const host = input.host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!host.includes('.')) throw new Error('A site needs a host, such as datasaur.ai.')

    // The unique index is across every tenant, and row level security means a key
    // held by another workspace is invisible to a check-then-insert here. The
    // index is therefore the only honest test, and its violation is translated
    // into a message that says the key is taken without saying by whom.
    let row: { id: string } | undefined
    try {
      ;[row] = await tx
        .insert(site)
        .values({ workspaceId: ctx.workspaceId, name: input.name.trim(), host, siteKey })
        .returning({ id: site.id })
    } catch (cause) {
      if (violates(cause, 'site_key_unique')) {
        throw new Error('That site key is already in use. Pick another.')
      }
      throw cause
    }
    if (!row) throw new Error('That site could not be created.')

    return {
      result: { id: row.id },
      audit: { entity: 'site', entityId: row.id, action: 'create', before: null, after: { host, siteKey } },
    }
  })

export const setSiteActive = async (
  ctx: WorkspaceContext,
  id: string,
  isActive: boolean,
): Promise<void> =>
  mutate(ctx, 'site', async (tx) => {
    const updated = await tx
      .update(site)
      .set({ isActive })
      .where(eq(site.id, id))
      .returning({ id: site.id })
    if (updated.length === 0) throw new Error('That site is not here any more.')
    return {
      result: undefined,
      audit: { entity: 'site', entityId: id, action: 'set_active', before: { isActive: !isActive }, after: { isActive } },
    }
  })

// ---------------------------------------------------------------------------
// What the collector refused
// ---------------------------------------------------------------------------

export type CollectorNoticeRow = {
  kind: string
  key: string
  siteName: string
  day: string
  n: number
  detail: unknown
  lastAt: Date
}

/** Surfaced beside the failed jobs, because both answer the same question: what
 *  is quietly not working. A PII rejection is a bug in the product that fired it. */
export const listCollectorNotices = async (
  ctx: WorkspaceContext,
): Promise<CollectorNoticeRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx
      .select({
        kind: collectorNotice.kind,
        key: collectorNotice.key,
        siteName: site.name,
        day: collectorNotice.day,
        n: collectorNotice.n,
        detail: collectorNotice.detail,
        lastAt: collectorNotice.lastAt,
      })
      .from(collectorNotice)
      .innerJoin(site, eq(site.id, collectorNotice.siteId))
      .orderBy(desc(collectorNotice.lastAt))
      .limit(100)
    return rows
  })

// ---------------------------------------------------------------------------
// Data-subject requests
// ---------------------------------------------------------------------------

export type ActivityExport = {
  contactId: string
  exportedAt: Date
  visitors: { visitorId: string; via: string; at: Date }[]
  pageViews: { url: string; path: string; title: string | null; referrer: string | null; at: Date }[]
  events: { name: string; properties: unknown; at: Date }[]
  consent: { categories: unknown; policyVersion: string; at: Date }[]
  submissions: { formName: string; values: unknown; at: Date }[]
}

/** Everything Rawr holds about one person's browsing, in one call. Built in this
 *  feature because this is the feature that creates the obligation.
 *
 *  Uncapped on purpose: a data-subject request that silently returns the first
 *  thousand rows is not an answer to it. */
export const exportContactActivity = async (
  ctx: WorkspaceContext,
  contactId: string,
): Promise<ActivityExport> =>
  withWorkspace(ctx, async (tx) => {
    const visitors = await tx.execute<{ visitor_id: string; via: string; at: Date }>(sql`
      select visitor_id, via::text, created_at as at from visitor_alias
       where workspace_id = ${ctx.workspaceId} and contact_id = ${contactId}
       order by created_at`)

    const views = await tx
      .select({
        url: pageView.url,
        path: pageView.path,
        title: pageView.title,
        referrer: pageView.referrer,
        at: pageView.at,
      })
      .from(pageView)
      .where(eq(pageView.contactId, contactId))
      .orderBy(pageView.at)

    const events = await tx
      .select({ name: customEvent.name, properties: customEvent.properties, at: customEvent.at })
      .from(customEvent)
      .where(eq(customEvent.contactId, contactId))
      .orderBy(customEvent.at)

    const consent = await tx.execute<{ categories: unknown; policy_version: string; at: Date }>(sql`
      select c.categories, c.policy_version, c.at
        from consent_record c
        join visitor_alias a on a.visitor_id = c.visitor_id
                            and a.workspace_id = c.workspace_id
       where c.workspace_id = ${ctx.workspaceId} and a.contact_id = ${contactId}
       order by c.at`)

    const submissions = await tx.execute<{ form_name: string; values: unknown; at: Date }>(sql`
      select f.name as form_name, s.values, s.at
        from form_submission s
        join form f on f.id = s.form_id
       where s.workspace_id = ${ctx.workspaceId} and s.contact_id = ${contactId}
       order by s.at`)

    return {
      contactId,
      exportedAt: new Date(),
      visitors: visitors.map((row) => ({ visitorId: row.visitor_id, via: row.via, at: new Date(row.at) })),
      pageViews: views,
      events,
      consent: consent.map((row) => ({
        categories: row.categories,
        policyVersion: row.policy_version,
        at: new Date(row.at),
      })),
      submissions: submissions.map((row) => ({
        formName: row.form_name,
        values: row.values,
        at: new Date(row.at),
      })),
    }
  })

export type EraseResult = { pageViews: number; events: number; visitors: number }

/** A separate, explicit action, never a side effect of deleting a contact.
 *  Deleting a contact detaches their views back to contact_id = null so aggregate
 *  counts stay honest; this is what an erasure request asks for instead, and it
 *  removes the rows and the visitor identities that point at them. */
export const eraseContactActivity = async (
  ctx: WorkspaceContext,
  contactId: string,
): Promise<EraseResult> => {
  assertCanWrite(ctx, 'erasure')
  return mutate(ctx, 'erasure', async (tx) => {
    const ids = await tx.execute<{ visitor_id: string }>(sql`
      select visitor_id from visitor_alias
       where workspace_id = ${ctx.workspaceId} and contact_id = ${contactId}`)
    const visitorIds = ids.map((row) => row.visitor_id)

    const views = await tx.execute<{ id: string }>(sql`
      delete from page_view
       where workspace_id = ${ctx.workspaceId} and contact_id = ${contactId} returning id`)
    const events = await tx.execute<{ id: string }>(sql`
      delete from custom_event
       where workspace_id = ${ctx.workspaceId} and contact_id = ${contactId} returning id`)

    // The timeline entries those rows produced go with them, or the record would
    // still read "viewed Data Studio" with nothing behind it.
    await tx.execute(sql`
      delete from activity a
       using activity_link l
       where l.activity_id = a.id
         and a.workspace_id = ${ctx.workspaceId}
         and l.entity_type = 'contact' and l.entity_id = ${contactId}
         and a.type in ('page_view', 'custom_event')`)

    await tx.execute(sql`
      delete from page_view_daily
       where workspace_id = ${ctx.workspaceId} and contact_id = ${contactId}`)
    await tx.execute(sql`
      delete from contact_activity
       where workspace_id = ${ctx.workspaceId} and contact_id = ${contactId}`)
    await tx.execute(sql`
      delete from visitor_alias
       where workspace_id = ${ctx.workspaceId} and contact_id = ${contactId}`)

    if (visitorIds.length > 0) {
      // inArray, not `= any($1::text[])`: an array bound through the query builder
      // is expanded into one parameter per element, which makes any() a syntax
      // error rather than a list.
      await tx.delete(visitor).where(inArray(visitor.id, visitorIds))
      await tx.delete(consentRecord).where(inArray(consentRecord.visitorId, visitorIds))
    }

    const result = {
      pageViews: views.length,
      events: events.length,
      visitors: visitorIds.length,
    }

    return {
      result,
      audit: {
        entity: 'erasure',
        entityId: contactId,
        action: 'erase_activity',
        before: result,
        after: null,
      },
    }
  })
}

/** Raw rows past the retention window collapse to one row per contact per day.
 *  Configurable, because it is a data-protection decision, not a technical one.
 *  Runs per workspace so one tenant's backlog cannot stall another's. */
export const rollUpExpired = async (
  ctx: WorkspaceContext,
  months: number,
): Promise<{ rolled: number }> =>
  withWorkspace(ctx, async (tx) => {
    const cutoff = sql`now() - make_interval(months => ${months})`
    const rolled = await tx.execute<{ id: string }>(sql`
      with expired as (
        delete from page_view
         where workspace_id = ${ctx.workspaceId} and at < ${cutoff}
        returning contact_id, at, id
      ), kept as (
        insert into page_view_daily (workspace_id, contact_id, day, views)
        select ${ctx.workspaceId}, contact_id, at::date, count(*)
          from expired where contact_id is not null
         group by contact_id, at::date
        on conflict (workspace_id, contact_id, day)
          do update set views = page_view_daily.views + excluded.views
        returning contact_id
      )
      select id from expired`)

    await tx.execute(sql`
      delete from custom_event
       where workspace_id = ${ctx.workspaceId} and at < ${cutoff}`)
    await tx.execute(sql`
      delete from visitor_session
       where workspace_id = ${ctx.workspaceId} and ended_at < ${cutoff}`)

    return { rolled: rolled.length }
  })

export { refreshAllContactActivity, refreshContactActivity }

/** Contacts whose counters need recomputing after a roll-up moved rows out from
 *  under them. One query rather than a counter the roll-up tries to keep in step. */
export const contactsWithActivity = async (ctx: WorkspaceContext): Promise<string[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx
      .select({ contactId: contactActivity.contactId })
      .from(contactActivity)
      .where(and(eq(contactActivity.workspaceId, ctx.workspaceId)))
    return rows.map((row) => row.contactId)
  })
