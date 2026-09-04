import { sql } from 'drizzle-orm'
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, pk, workspaceId } from './columns.ts'
import { aliasViaEnum } from './enums.ts'
import { workspace } from './identity.ts'
import { contact } from './records.ts'

/** F4. The person-level timeline behind "Muhammad Owais viewed Data Studio".
 *
 *  The visitor id is the value in the first-party cookie, carried as text rather
 *  than resolved to a surrogate key. Every hot path here is keyed by it — the
 *  collector's session lookup, and the back-fill that turns a month of anonymous
 *  browsing into a new contact's history — and a join on each of those to learn a
 *  uuid buys nothing. */

/** One row per host that sends events. datasaur.ai and app.datasaur.ai are two
 *  sites in one workspace, which is what open item 18 is deciding between.
 *
 *  The key is unique across every tenant, not per workspace: the collector has
 *  only this string to resolve a workspace from, so two tenants sharing one would
 *  make that question unanswerable. */
export const site = pgTable(
  'site',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    host: text('host').notNull(),
    siteKey: text('site_key').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('site_key_unique').on(t.siteKey),
    index('site_workspace_idx').on(t.workspaceId, t.host),
  ],
)

export const visitor = pgTable(
  'visitor',
  {
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    /** The cookie value. Never accepted from a query parameter, never put in a
     *  URL, never forwarded to GA4. */
    id: text('id').notNull(),
    /** Null until an identification resolves it. Set from the newest alias. */
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
    firstReferrer: text('first_referrer'),
    firstLandingPage: text('first_landing_page'),
    sessionCount: integer('session_count').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    index('visitor_contact_idx').on(t.workspaceId, t.contactId),
  ],
)

/** Every identification, kept rather than overwritten, because a shared browser
 *  producing two of these is a fact worth being able to read later.
 *
 *  `resolvedAt` null is the back-fill queue. The web app writes the row inside the
 *  transaction that created the contact and stops there; the worker claims it.
 *  Same mechanism as field_index, so there is one way a request asks for work. */
export const visitorAlias = pgTable(
  'visitor_alias',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    visitorId: text('visitor_id').notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    via: aliasViaEnum('via').notNull(),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('visitor_alias_key').on(t.workspaceId, t.visitorId, t.contactId),
    index('visitor_alias_pending_idx')
      .on(t.createdAt)
      .where(sql`resolved_at is null`),
    index('visitor_alias_contact_idx').on(t.workspaceId, t.contactId),
  ],
)

/** Thirty minutes of inactivity ends one, matching GA4's convention so "site
 *  visits" is a number somebody can compare against the old reports. */
export const visitorSession = pgTable(
  'visitor_session',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    visitorId: text('visitor_id').notNull(),
    siteId: uuid('site_id').references(() => site.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull().defaultNow(),
    entryPath: text('entry_path'),
    exitPath: text('exit_path'),
    pageCount: integer('page_count').notNull().default(0),
    referrer: text('referrer'),
    utm: jsonb('utm').notNull().default({}),
    /** Which of the seven buckets this visit came through, decided once on the
     *  first page of the session. Null on a session that predates the column: a
     *  report says "not attributed" rather than guessing at a paid click from a
     *  referrer that was never kept. */
    channel: text('channel'),
  },
  (t) => [
    index('visitor_session_visitor_idx').on(t.workspaceId, t.visitorId, t.endedAt.desc()),
    index('visitor_session_started_idx').on(t.workspaceId, t.startedAt.desc()),
    index('visitor_session_channel_idx').on(t.workspaceId, t.channel, t.startedAt.desc()),
  ],
)

/** contact_id is denormalised deliberately. The alternative is joining through
 *  visitor_alias on every timeline read, which is the hot path. F4 §1. */
export const pageView = pgTable(
  'page_view',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    visitorId: text('visitor_id').notNull(),
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => visitorSession.id, { onDelete: 'set null' }),
    siteId: uuid('site_id').references(() => site.id, { onDelete: 'set null' }),
    url: text('url').notNull(),
    path: text('path').notNull(),
    title: text('title'),
    referrer: text('referrer'),
    utm: jsonb('utm').notNull().default({}),
    uaFamily: text('ua_family'),
    device: text('device'),
    country: text('country'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The back-fill's only query, and the narrowest it can be: an identification
     *  touches nothing that is already attributed. */
    index('page_view_backfill_idx')
      .on(t.workspaceId, t.visitorId)
      .where(sql`contact_id is null`),
    index('page_view_visitor_idx').on(t.workspaceId, t.visitorId, t.at.desc()),
    index('page_view_contact_idx').on(t.workspaceId, t.contactId, t.at.desc()),
    index('page_view_session_idx').on(t.workspaceId, t.sessionId, t.at),
  ],
)

export const customEvent = pgTable(
  'custom_event',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    visitorId: text('visitor_id').notNull(),
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => visitorSession.id, { onDelete: 'set null' }),
    siteId: uuid('site_id').references(() => site.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    properties: jsonb('properties').notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('custom_event_backfill_idx')
      .on(t.workspaceId, t.visitorId)
      .where(sql`contact_id is null`),
    index('custom_event_visitor_idx').on(t.workspaceId, t.visitorId, t.at.desc()),
    index('custom_event_contact_idx').on(t.workspaceId, t.contactId, t.at.desc()),
  ],
)

/** The three numbers on the Website activity panel, maintained rather than
 *  counted. A contact with 20,000 page views has to open as fast as one with
 *  three, and COUNT(*) over page_view on every record open does not do that. */
export const contactActivity = pgTable(
  'contact_activity',
  {
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    siteVisits: integer('site_visits').notNull().default(0),
    pagesViewed: integer('pages_viewed').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.contactId] })],
)

/** Raw page views live 25 months, then collapse to one row per contact per day.
 *  Aggregate counts stay honest after the raw rows are gone, which is what lets
 *  the retention window be a data-protection decision rather than a lossy one. */
export const pageViewDaily = pgTable(
  'page_view_daily',
  {
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    views: integer('views').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.contactId, t.day] })],
)

/** Names seen today, per workspace. Counting rows here is how the cardinality cap
 *  knows a loop has started firing distinct names, without keeping a counter that
 *  a restart would lose. F4 §2. */
export const eventNameDay = pgTable(
  'event_name_day',
  {
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.day, t.name] })],
)

/** What the collector refused, aggregated so a loop firing a rejected event ten
 *  thousand times is one row an admin can read, not ten thousand.
 *
 *  A PII rejection is a bug in the product that fired it, so the site and the
 *  offending property name are both kept; the value never is. */
export const collectorNotice = pgTable(
  'collector_notice',
  {
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => site.id, { onDelete: 'cascade' }),
    /** 'pii' or 'cardinality'. */
    kind: text('kind').notNull(),
    /** The event name for a PII rejection, the day's bucket for a cardinality
     *  overflow. Never a value a visitor typed. */
    key: text('key').notNull(),
    day: date('day').notNull(),
    n: integer('n').notNull().default(1),
    detail: jsonb('detail').notNull().default({}),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.siteId, t.kind, t.key, t.day] }),
    index('collector_notice_recent_idx').on(t.workspaceId, t.lastAt.desc()),
  ],
)
