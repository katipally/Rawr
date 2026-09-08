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
import { createdAt, pk, updatedAt, accountId } from './columns.ts'
import {
  bookingKindEnum,
  bookingLocationEnum,
  bookingStateEnum,
  calendarProviderEnum,
  integrationStateEnum,
} from './enums.ts'
import { userAccount, account } from './identity.ts'
import { company, contact } from './records.ts'

/** F2. Every instant here is timestamptz and every human-facing time is a rule in
 *  somebody's named timezone resolved against a date. An offset stored as a number
 *  breaks the first time a DST boundary lands between the rule and the meeting. */

export const bookingPage = pgTable(
  'booking_page',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    /** The public address is /b/:account/:slug, so the slug is what goes in an
     *  email signature and a Webflow embed, never the uuid. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: bookingKindEnum('kind').notNull().default('round_robin'),
    /** Set on a one-on-one page, null on a shared one. A personal link is visible
     *  and editable only to its owner, which is the whole difference between the
     *  two Notion rows. F2 §6. */
    ownerId: uuid('owner_id').references(() => userAccount.id, { onDelete: 'cascade' }),
    durationMinutes: integer('duration_minutes').notNull().default(30),
    bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
    bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),
    minNoticeMinutes: integer('min_notice_minutes').notNull().default(240),
    maxHorizonDays: integer('max_horizon_days').notNull().default(60),
    /** How far apart offered starts are. Independent of duration so a 45 minute
     *  call can still be offered on the hour and the half hour. */
    granularityMinutes: integer('granularity_minutes').notNull().default(30),
    location: bookingLocationEnum('location').notNull().default('zoom'),
    /** The phone number or the custom instructions. Unused for zoom and meet,
     *  where the provider supplies the join details. */
    locationDetail: text('location_detail'),
    titleTpl: text('title_tpl').notNull(),
    descriptionTpl: text('description_tpl').notNull(),
    /** What {{company.name}} becomes when the booker's address tells us nothing,
     *  so an event is never titled "… <> " with the tail missing. F2 §5. */
    companyFallback: text('company_fallback').notNull().default('a new team'),
    /** Ordered extra questions, same shape as a form field: {key, type, label,
     *  required, options, placeholder}. Name and email are always asked and are
     *  not listed here. */
    questions: jsonb('questions').notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    redirectUrl: text('redirect_url'),
    confirmationCopy: text('confirmation_copy'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('booking_page_slug_key').on(t.accountId, t.slug),
    index('booking_page_owner_idx').on(t.accountId, t.ownerId),
  ],
)

export const bookingHost = pgTable(
  'booking_host',
  {
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    bookingPageId: uuid('booking_page_id')
      .notNull()
      .references(() => bookingPage.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    /** Relative share of the round robin. Weight 2 takes twice the meetings of
     *  weight 1 over a window, which is how a team lead takes fewer. */
    weight: integer('weight').notNull().default(1),
    /** Collective only. A required host has to be free for a time to be offered at
     *  all; an optional one is invited when they happen to be free and never holds
     *  the calendar back. Ignored by the other kinds, where every host is a
     *  candidate on their own. */
    isRequired: boolean('is_required').notNull().default(true),
    /** Tie-break only. The share itself is counted from real bookings, so a
     *  counter drifting out of step cannot skew the distribution. F2 §3. */
    lastAssignedAt: timestamp('last_assigned_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.bookingPageId, t.userId] }),
    index('booking_host_user_idx').on(t.accountId, t.userId),
  ],
)

/** One schedule per person, reused by every page they host on. Two schedules for
 *  one person is a feature nobody asked for and it doubles every availability
 *  question, so a page inherits its hosts' schedules rather than owning one. */
export const availability = pgTable(
  'availability',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    /** IANA name. Never an offset. */
    timezone: text('timezone').notNull().default('America/Los_Angeles'),
    /** {"1": [["09:00","17:00"]], ...} keyed by ISO weekday, 1 = Monday. Local
     *  wall-clock times, resolved against each date, so 9am stays 9am across a
     *  DST change. */
    weekly: jsonb('weekly').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('availability_user_key').on(t.accountId, t.userId)],
)

export const availabilityOverride = pgTable(
  'availability_override',
  {
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    /** A calendar date in the person's own timezone, not an instant. */
    day: date('day').notNull(),
    /** Empty with isUnavailable false is meaningless, so the flag is explicit:
     *  a holiday is is_unavailable, a short day is blocks. */
    isUnavailable: boolean('is_unavailable').notNull().default(true),
    blocks: jsonb('blocks').notNull().default([]),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.userId, t.day] })],
)

export const booking = pgTable(
  'booking',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    bookingPageId: uuid('booking_page_id')
      .notNull()
      .references(() => bookingPage.id, { onDelete: 'restrict' }),
    hostUserId: uuid('host_user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => company.id, { onDelete: 'set null' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** Stored so a confirmation, a reschedule page and an ICS attachment all read
     *  back in the timezone the person actually booked from. */
    attendeeTimezone: text('attendee_timezone').notNull(),
    attendeeName: text('attendee_name').notNull(),
    attendeeEmail: text('attendee_email').notNull(),
    answers: jsonb('answers').notNull().default({}),
    conferenceUrl: text('conference_url'),
    /** The provider's own id for the conference, so a cancellation can delete the
     *  Zoom meeting rather than orphaning it. */
    conferenceRef: text('conference_ref'),
    calendarEventId: text('calendar_event_id'),
    calendarId: text('calendar_id'),
    state: bookingStateEnum('state').notNull().default('confirmed'),
    /** The booking this one replaced. Reading backwards through it gives the
     *  whole reschedule chain without a separate history table. */
    rescheduleOf: uuid('reschedule_of'),
    /** Opaque random secrets, not signatures: a signed token cannot be revoked
     *  without a revocation list, and these have to stop working the moment the
     *  booking is cancelled. Never sequential, never derived from the id. */
    cancelToken: text('cancel_token').notNull(),
    rescheduleToken: text('reschedule_token').notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** The invariant that makes a double booking unreachable even if every check
     *  above it is wrong: one person cannot hold two confirmed meetings that
     *  start at the same instant. Deliberately per host, not per page, because a
     *  round robin is meant to offer one slot to several hosts. */
    uniqueIndex('booking_host_slot_key')
      .on(t.accountId, t.hostUserId, t.startsAt)
      .where(sql`state = 'confirmed'`),
    index('booking_host_window_idx').on(t.accountId, t.hostUserId, t.startsAt),
    index('booking_page_idx').on(t.accountId, t.bookingPageId, t.startsAt),
    index('booking_contact_idx').on(t.accountId, t.contactId),
    uniqueIndex('booking_cancel_token_key').on(t.cancelToken),
    uniqueIndex('booking_reschedule_token_key').on(t.rescheduleToken),
  ],
)

/** Who a meeting actually commits, one row per person.
 *
 *  `booking.host_user_id` is the organiser: whose Zoom it is, who owns the lead,
 *  whose name the confirmation says. On a collective page the meeting commits
 *  several people, and every one of them has to be unbookable at that instant by
 *  anything else.
 *
 *  So this table, not a second booking row per host: one meeting stays one row in
 *  `booking`, one entry in the timeline and one contact, while the unique index
 *  below is the invariant that makes a double booking unreachable for every
 *  participant rather than only the organiser.
 *
 *  Rows exist only while the booking is confirmed. Cancelling or rescheduling
 *  deletes them, which is what frees the time again and why the index needs no
 *  partial clause. Written for every kind, so there is one answer to "is this
 *  person committed then" rather than two. */
export const bookingParticipant = pgTable(
  'booking_participant',
  {
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => booking.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** The organiser's event is the one on `booking`; this is everybody else's, so
     *  a cancellation can withdraw each invitation rather than orphaning it. */
    calendarEventId: text('calendar_event_id'),
    calendarId: text('calendar_id'),
    /** True for the row that mirrors `booking.host_user_id`. */
    isOrganiser: boolean('is_organiser').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.bookingId, t.userId] }),
    /** The invariant, for everyone in the room. */
    uniqueIndex('booking_participant_slot_key').on(t.accountId, t.userId, t.startsAt),
    /** The overlap read: one person's commitments in a window. */
    index('booking_participant_window_idx').on(t.accountId, t.userId, t.startsAt, t.endsAt),
  ],
)

/** A five minute soft hold, so filling in the questions does not lose the slot to
 *  someone faster. It reserves capacity rather than the slot: on a round robin with
 *  three free hosts, three holds are needed before the slot stops being offered. */
export const bookingHold = pgTable(
  'booking_hold',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    bookingPageId: uuid('booking_page_id')
      .notNull()
      .references(() => bookingPage.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('booking_hold_token_key').on(t.token),
    index('booking_hold_slot_idx').on(t.accountId, t.bookingPageId, t.startsAt, t.expiresAt),
  ],
)

/** A person's calendar connection. Tokens are encrypted with a key held outside
 *  this database, so a database dump is not a set of live
 *  Google credentials. */
export const calendarGrant = pgTable(
  'calendar_grant',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    provider: calendarProviderEnum('provider').notNull().default('google'),
    /** Which calendar events are written to. 'primary' unless somebody picks
     *  another one, which is the destination-calendar choice cal.diy exposes. */
    calendarId: text('calendar_id').notNull().default('primary'),
    state: integrationStateEnum('state').notNull().default('unconfigured'),
    accessToken: text('access_token_enc'),
    refreshToken: text('refresh_token_enc'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  /** One connection per person, not one per provider. Two would let free-busy be
   *  read through the development provider while a real Google calendar sat next
   *  to it, which reports no commitments and so offers times somebody is busy. */
  (t) => [uniqueIndex('calendar_grant_user_key').on(t.accountId, t.userId)],
)
