import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import {
  collectorNotice,
  contactActivity,
  customEvent,
  eventNameDay,
  pageView,
  visitor,
  visitorSession,
} from '../schema/analytics.ts'
import { recordActivity } from './activity.ts'
import { channelOfSession, sourceFromSession } from './attribution.ts'
import { resolveContactCampaigns } from './campaigns.ts'
import { publicEdgeContext } from './forms.ts'
import { withAccount, type Tx } from './index.ts'

/** F4 §2. The collector's half of the data access layer: everything an anonymous
 *  request may write, and nothing else.
 *
 *  Every rule that keeps this table honest lives here rather than in the route,
 *  so the browser beacon, a server-side call and a future mobile SDK cannot
 *  disagree about what a bot is or what counts as PII. */

// ---------------------------------------------------------------------------
// Resolving a site
// ---------------------------------------------------------------------------

export type PublicSite = { accountId: string; siteId: string; host: string }

/** Never taken from the payload: the site key names the tenant, and a request
 *  that could name its own account could write into anybody's. */
export const publicSite = async (siteKey: string): Promise<PublicSite | null> => {
  if (!siteKey || siteKey.length > 128) return null
  const rows = await appDb.execute<{ account_id: string; site_id: string; host: string }>(
    sql`select account_id, site_id, host from rawr.public_site(${siteKey})`,
  )
  const row = rows[0]
  return row ? { accountId: row.account_id, siteId: row.site_id, host: row.host } : null
}

// ---------------------------------------------------------------------------
// What the collector refuses
// ---------------------------------------------------------------------------

/** The cookie value, and the only shape of it Rawr will store. Anything else is
 *  either a client that predates the current embed or somebody probing, and both
 *  are answered the same way: no visitor, no row. */
const VISITOR_ID = /^[A-Za-z0-9_-]{16,64}$/

export const isVisitorId = (value: unknown): value is string =>
  typeof value === 'string' && VISITOR_ID.test(value)

/** Crawlers that announce themselves, plus the headless signatures that do not.
 *  A miss inflates every count on the panel, so this is the list the bot test in
 *  verify-activity runs against. */
const BOT_SIGNATURES = [
  'bot', 'crawler', 'spider', 'crawl', 'slurp', 'archiver', 'scraper',
  'googlebot', 'bingbot', 'yandex', 'baiduspider', 'duckduckbot', 'applebot',
  'facebookexternalhit', 'facebot', 'twitterbot', 'linkedinbot', 'slackbot',
  'discordbot', 'telegrambot', 'whatsapp', 'pinterest', 'redditbot',
  'ahrefs', 'semrush', 'mj12bot', 'dotbot', 'petalbot', 'dataforseo',
  'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'selenium',
  'curl/', 'wget/', 'python-requests', 'python-urllib', 'go-http-client',
  'java/', 'okhttp', 'axios/', 'node-fetch', 'got (', 'httpie',
  'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptimerobot', 'monitoring',
  'preview', 'validator', 'feedfetcher', 'apache-httpclient', 'libwww-perl',
]

export const isBot = (userAgent: string | null | undefined): boolean => {
  if (!userAgent) return true // No user agent at all is not a browser.
  const ua = userAgent.toLowerCase()
  if (ua.length > 512) return true
  return BOT_SIGNATURES.some((signature) => ua.includes(signature))
}

/** Enough of a user agent to say "Chrome on a phone" on the page-view detail, and
 *  deliberately no more. A full UA string is a fingerprint; these two fields are
 *  not. */
export const uaFamily = (userAgent: string | null | undefined): string | null => {
  if (!userAgent) return null
  const ua = userAgent.toLowerCase()
  if (ua.includes('edg/')) return 'Edge'
  if (ua.includes('opr/') || ua.includes('opera')) return 'Opera'
  if (ua.includes('firefox')) return 'Firefox'
  if (ua.includes('chrome') || ua.includes('crios')) return 'Chrome'
  if (ua.includes('safari')) return 'Safari'
  return 'Other'
}

export const uaDevice = (userAgent: string | null | undefined): string | null => {
  if (!userAgent) return null
  const ua = userAgent.toLowerCase()
  if (ua.includes('ipad') || (ua.includes('android') && !ua.includes('mobile'))) return 'tablet'
  if (ua.includes('mobi') || ua.includes('iphone') || ua.includes('android')) return 'phone'
  return 'desktop'
}

const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i
/** Seven or more digits with the usual separators. Deliberately loose: a false
 *  positive costs one rejected property and a notice somebody can read, and a
 *  false negative puts a phone number in an analytics table. */
const PHONE_LIKE = /(?:\+?\d[\d\s().-]{6,}\d)/
const PII_KEYS = new Set([
  'email', 'e_mail', 'email_address', 'mail', 'phone', 'phone_number', 'tel',
  'telephone', 'mobile', 'name', 'first_name', 'last_name', 'full_name',
  'firstname', 'lastname', 'fullname', 'address', 'street', 'postcode', 'zip',
  'ssn', 'dob', 'date_of_birth',
])

/** F4 §2 and its edge case: an event carrying an email is rejected and the
 *  rejection is visible to an admin, so the product that fired it can be fixed.
 *  Returns the offending property names; an empty array means the event is clean. */
export const piiViolations = (properties: Record<string, unknown>): string[] => {
  const found: string[] = []
  for (const [key, value] of Object.entries(properties)) {
    const normalised = key.trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (PII_KEYS.has(normalised)) {
      found.push(key)
      continue
    }
    if (typeof value !== 'string') continue
    if (EMAIL_LIKE.test(value) || PHONE_LIKE.test(value)) found.push(key)
  }
  return found
}

/** Over this many distinct names in a day, everything else is bucketed so one bad
 *  loop cannot destroy the table. F4 §2. */
export const EVENT_NAME_CAP = 200
export const OVERFLOW_EVENT = '_overflow'

/** Thirty minutes of inactivity, matching GA4, so "site visits" is a number
 *  somebody can compare against the old reports. */
const SESSION_GAP_MINUTES = 30

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

export type CollectInput = {
  site: PublicSite
  visitorId: string
  /** Stamped server side. A client timestamp is a hint for a queued beacon and is
   *  clamped by the caller before it gets here. */
  at: Date
  url: string
  path: string
  title?: string | null
  referrer?: string | null
  utm?: Record<string, string>
  userAgent?: string | null
  country?: string | null
  /** Absent for a page view; present for a custom event. */
  event?: { name: string; properties: Record<string, unknown> } | undefined
}

export type CollectResult = {
  id: string
  sessionId: string
  newSession: boolean
  /** Set when the event was stored under the overflow bucket or had properties
   *  stripped. The caller answers 204 either way; this is for the tests and for
   *  the notice that was written. */
  rejected?: 'pii' | 'cardinality' | undefined
}

const trim = (value: string | null | undefined, max: number): string | null => {
  if (value === null || value === undefined) return null
  const clean = value.trim()
  if (!clean) return null
  return clean.length > max ? clean.slice(0, max) : clean
}

export const collect = async (input: CollectInput): Promise<CollectResult> => {
  const ctx = publicEdgeContext(input.site.accountId)
  const { accountId, siteId } = input.site

  return withAccount(ctx, async (tx) => {
    const referrer = trim(input.referrer, 2048)
    const path = trim(input.path, 2048) ?? '/'

    // The visitor row carries where they first arrived from, which is the only
    // attribution a page view has before a form ever names them.
    await tx
      .insert(visitor)
      .values({
        accountId,
        id: input.visitorId,
        firstReferrer: referrer,
        firstLandingPage: trim(input.url, 2048),
        lastSeenAt: input.at,
        firstSeenAt: input.at,
      })
      .onConflictDoUpdate({
        target: [visitor.accountId, visitor.id],
        set: { lastSeenAt: input.at },
      })

    const [open] = await tx
      .select({ id: visitorSession.id })
      .from(visitorSession)
      .where(
        and(
          eq(visitorSession.visitorId, input.visitorId),
          gt(
            visitorSession.endedAt,
            new Date(input.at.getTime() - SESSION_GAP_MINUTES * 60_000),
          ),
        ),
      )
      .orderBy(desc(visitorSession.endedAt))
      .limit(1)

    let sessionId = open?.id
    const newSession = !sessionId
    if (sessionId) {
      await tx
        .update(visitorSession)
        .set({
          endedAt: input.at,
          exitPath: path,
          pageCount: sql`${visitorSession.pageCount} + ${input.event ? 0 : 1}`,
        })
        .where(eq(visitorSession.id, sessionId))
    } else {
      const [created] = await tx
        .insert(visitorSession)
        .values({
          accountId,
          visitorId: input.visitorId,
          siteId,
          startedAt: input.at,
          endedAt: input.at,
          entryPath: path,
          exitPath: path,
          pageCount: input.event ? 0 : 1,
          referrer,
          utm: input.utm ?? {},
          // Decided once, on the first page of the visit. A later page carries the
          // internal referrer of the page before it, which would relabel a paid
          // click as a referral halfway through the session.
          channel: channelOfSession({ referrer, utm: input.utm ?? {} }),
        })
        .returning({ id: visitorSession.id })
      if (!created) throw new Error('The visit could not be recorded.')
      sessionId = created.id
      await tx
        .update(visitor)
        .set({ sessionCount: sql`${visitor.sessionCount} + 1` })
        .where(eq(visitor.id, input.visitorId))
    }

    // Read after the upsert, so an identification that landed a moment ago
    // attributes this view immediately instead of waiting for the next back-fill.
    const [known] = await tx
      .select({ contactId: visitor.contactId })
      .from(visitor)
      .where(eq(visitor.id, input.visitorId))
      .limit(1)
    const contactId = known?.contactId ?? null

    const result = input.event
      ? await writeEvent(tx, input, sessionId, contactId)
      : await writeView(tx, input, sessionId, contactId)

    // A visit by somebody already known is a touch, and the latest touch is what
    // a report answers "what brought them back" with. Only on a new session, and
    // only when the session names a channel: a second page view must not overwrite
    // the campaign the visit arrived through.
    if (contactId && newSession) {
      await noteLatestTouch(tx, accountId, contactId, {
        referrer,
        utm: input.utm ?? {},
        landingPage: trim(input.url, 2048),
        path,
        at: input.at,
      })
      // A first visit fills original_source, and the campaign that first touch
      // names has to land in first_campaign_id with it. Both columns come from the
      // sources as they now stand, which is the one place that rule lives.
      await resolveContactCampaigns(tx, ctx, [contactId])
    }

    if (contactId) {
      await bumpCounters(tx, accountId, contactId, input.at, {
        views: input.event ? 0 : 1,
        visits: newSession ? 1 : 0,
      })
      await recordActivity(tx, ctx, {
        type: input.event ? 'custom_event' : 'page_view',
        subject: input.event
          ? `fired ${result.name}`
          : `viewed ${trim(input.title, 200) ?? path}`,
        occurredAt: input.at,
        source: 'tracking',
        payload: input.event
          ? { eventId: result.id, name: result.name, sessionId }
          : { pageViewId: result.id, path, url: trim(input.url, 2048), sessionId },
        links: [{ entityType: 'contact', entityId: contactId }],
      })
    }

    return { id: result.id, sessionId, newSession, rejected: result.rejected }
  })
}

const writeView = async (
  tx: Tx,
  input: CollectInput,
  sessionId: string,
  contactId: string | null,
): Promise<{ id: string; name: string; rejected?: 'pii' | 'cardinality' | undefined }> => {
  const [row] = await tx
    .insert(pageView)
    .values({
      accountId: input.site.accountId,
      visitorId: input.visitorId,
      contactId,
      sessionId,
      siteId: input.site.siteId,
      url: trim(input.url, 2048) ?? '/',
      path: trim(input.path, 2048) ?? '/',
      title: trim(input.title, 500),
      referrer: trim(input.referrer, 2048),
      utm: input.utm ?? {},
      uaFamily: uaFamily(input.userAgent),
      device: uaDevice(input.userAgent),
      country: trim(input.country, 2)?.toUpperCase() ?? null,
      at: input.at,
    })
    .returning({ id: pageView.id })
  if (!row) throw new Error('That page view could not be recorded.')
  return { id: row.id, name: 'page_view' }
}

const writeEvent = async (
  tx: Tx,
  input: CollectInput,
  sessionId: string,
  contactId: string | null,
): Promise<{ id: string; name: string; rejected?: 'pii' | 'cardinality' | undefined }> => {
  const event = input.event
  if (!event) throw new Error('writeEvent was called without an event.')

  const offending = piiViolations(event.properties)
  let properties = event.properties
  let rejected: 'pii' | 'cardinality' | undefined

  if (offending.length > 0) {
    // The event is kept and the offending properties are dropped. Refusing the
    // whole event would lose a real signal because one field was wrong, and
    // storing it would put a person's email in an analytics table.
    properties = Object.fromEntries(
      Object.entries(event.properties).filter(([key]) => !offending.includes(key)),
    )
    rejected = 'pii'
    await notice(tx, input.site, 'pii', event.name, { properties: offending })
  }

  const name = await capName(tx, input.site, event.name)
  if (name === OVERFLOW_EVENT && event.name !== OVERFLOW_EVENT) rejected = 'cardinality'

  const [row] = await tx
    .insert(customEvent)
    .values({
      accountId: input.site.accountId,
      visitorId: input.visitorId,
      contactId,
      sessionId,
      siteId: input.site.siteId,
      name,
      properties,
      at: input.at,
    })
    .returning({ id: customEvent.id })
  if (!row) throw new Error('That event could not be recorded.')
  return { id: row.id, name, rejected }
}

/** Bucketing, not refusing. The count query runs only when a name is new today,
 *  so a site firing one name a million times pays for it once. */
const capName = async (tx: Tx, site: PublicSite, raw: string): Promise<string> => {
  const name = raw.trim().slice(0, 120)
  if (!name) return OVERFLOW_EVENT

  const claimed = await tx
    .insert(eventNameDay)
    .values({ accountId: site.accountId, day: sql`current_date`, name })
    .onConflictDoNothing()
    .returning({ name: eventNameDay.name })

  if (claimed.length === 0) return name // Seen today already, so within the cap.

  const [counted] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(eventNameDay)
    .where(eq(eventNameDay.day, sql`current_date`))

  if ((counted?.n ?? 0) <= EVENT_NAME_CAP) return name

  await notice(tx, site, 'cardinality', OVERFLOW_EVENT, { cap: EVENT_NAME_CAP, seen: counted?.n })
  return OVERFLOW_EVENT
}

/** Aggregated per day, so a loop firing a rejected event ten thousand times is one
 *  row an admin can read rather than ten thousand. */
const notice = async (
  tx: Tx,
  site: PublicSite,
  kind: 'pii' | 'cardinality',
  key: string,
  detail: unknown,
): Promise<void> => {
  await tx
    .insert(collectorNotice)
    .values({
      accountId: site.accountId,
      siteId: site.siteId,
      kind,
      key: key.slice(0, 120),
      day: sql`current_date`,
      detail: detail ?? {},
    })
    .onConflictDoUpdate({
      target: [
        collectorNotice.accountId,
        collectorNotice.siteId,
        collectorNotice.kind,
        collectorNotice.key,
        collectorNotice.day,
      ],
      set: { n: sql`${collectorNotice.n} + 1`, lastAt: sql`now()`, detail: detail ?? {} },
    })
}

/** The latest touch on a contact, written from a session rather than a form.
 *
 *  `original_source` is filled only when it is empty: a contact created by an
 *  import or typed in by hand has no first touch, and the first visit Rawr sees is
 *  the best answer available. It is never overwritten, because a later visit is by
 *  definition not the first one. */
const noteLatestTouch = async (
  tx: Tx,
  accountId: string,
  contactId: string,
  visit: {
    referrer: string | null
    utm: Record<string, unknown>
    landingPage: string | null
    path: string
    at: Date
  },
): Promise<void> => {
  const payload = JSON.stringify({
    ...sourceFromSession({
      referrer: visit.referrer,
      utm: visit.utm,
      landingPage: visit.landingPage,
      pagePath: visit.path,
      at: visit.at,
    }),
    via: 'tracking',
  })

  await tx.execute(sql`
    update contact
       set latest_source = ${payload}::jsonb,
           original_source = coalesce(original_source, ${payload}::jsonb),
           updated_at = now()
     where id = ${contactId} and account_id = ${accountId}`)
}

export const bumpCounters = async (
  tx: Tx,
  accountId: string,
  contactId: string,
  at: Date,
  by: { views: number; visits: number },
): Promise<void> => {
  await tx
    .insert(contactActivity)
    .values({
      accountId,
      contactId,
      siteVisits: by.visits,
      pagesViewed: by.views,
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .onConflictDoUpdate({
      target: [contactActivity.accountId, contactActivity.contactId],
      set: {
        siteVisits: sql`${contactActivity.siteVisits} + ${by.visits}`,
        pagesViewed: sql`${contactActivity.pagesViewed} + ${by.views}`,
        firstSeenAt: sql`least(${contactActivity.firstSeenAt}, ${at.toISOString()}::timestamptz)`,
        lastSeenAt: sql`greatest(${contactActivity.lastSeenAt}, ${at.toISOString()}::timestamptz)`,
      },
    })
}
