import { sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import { randomToken } from '../internal/crypto.ts'
import { recordActivity } from './activity.ts'
import { readAttribution, type AttributionInput } from './attribution.ts'
import { assertCanWrite, type AccountContext } from './context.ts'
import { readSchema, type FormField } from './form-schema.ts'
import { emailFrom, validateAnswers, type FieldError } from './form-validate.ts'
import { publicEdgeContext } from './forms.ts'
import { isUuid, mutate, withAccount, writeAudit, type Tx } from './index.ts'
import { mapAnswersToColumns, upsertCapturedPerson } from './people.ts'
import { aliasVisitor } from './stitch.ts'
import {
  DEFAULT_WEEKLY,
  computeSlots,
  dayKey,
  readRanges,
  readWeekly,
  type DayOverride,
  type Interval,
  type WeeklyRules,
} from './slots.ts'

/** F2. The booking engine: what is offered, who gets assigned, and what a
 *  confirmation actually writes.
 *
 *  No network calls happen here. Free-busy and the conference link are the two
 *  things that need the outside world, and both arrive as arguments, because a
 *  data access layer that reaches Google cannot be asked "what would you offer if
 *  this host were busy from two until four on the Sunday the clocks change". */

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** Asked on every page and not editable, because a booking with no name and no
 *  address cannot become a contact and the whole point is that it does. They are
 *  ordinary form fields so validation, mapping and rendering are the same code
 *  that runs for F3 rather than a second implementation with its own bugs. */
export const BOOKING_CORE_FIELDS: FormField[] = [
  { key: 'name', type: 'text', label: 'Full name', required: true, mapsTo: null },
  { key: 'email', type: 'email', label: 'Work email', required: true, mapsTo: 'contact.email' },
]

const CORE_KEYS = new Set(BOOKING_CORE_FIELDS.map((field) => field.key))

/** A page's extra questions, with anything that collides with a core field
 *  dropped: two fields called `email` would make the mapping ambiguous. */
export const readQuestions = (raw: unknown): FormField[] =>
  readSchema(raw).filter((field) => !CORE_KEYS.has(field.key))

export const bookingFields = (questions: FormField[]): FormField[] => [
  ...BOOKING_CORE_FIELDS,
  ...questions,
]

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export type BookingKind = 'one_on_one' | 'round_robin' | 'collective'
export type BookingLocation = 'zoom' | 'google_meet' | 'phone' | 'custom'
export type BookingState = 'confirmed' | 'cancelled' | 'rescheduled'

/** What a visitor is allowed to know about a page. Deliberately without the
 *  templates: an event title is internal and can name a deal. */
export type PublicBookingPage = {
  accountId: string
  accountSlug: string
  accountName: string
  bookingPageId: string
  slug: string
  name: string
  kind: BookingKind
  durationMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minNoticeMinutes: number
  maxHorizonDays: number
  granularityMinutes: number
  location: BookingLocation
  locationDetail: string | null
  questions: FormField[]
  isActive: boolean
  redirectUrl: string | null
  confirmationCopy: string | null
  /** Who the meeting is with. Names only: the page is public, so an address here
   *  would be a scraper's list. A round robin names everybody it might land on,
   *  because the visitor is choosing the team, not the person. */
  hostNames: string[]
}

type PublicPageRow = {
  account_id: string
  account_slug: string
  account_name: string
  booking_page_id: string
  slug: string
  name: string
  kind: BookingKind
  duration_minutes: number
  buffer_before_minutes: number
  buffer_after_minutes: number
  min_notice_minutes: number
  max_horizon_days: number
  granularity_minutes: number
  location: BookingLocation
  location_detail: string | null
  questions: unknown
  is_active: boolean
  redirect_url: string | null
  confirmation_copy: string | null
  host_names: string[] | null
}

/** The one question the public edge asks before it has an account, through the
 *  same security-definer path a form uses. There is no route from here to a
 *  record. */
export const publicBookingPage = async (
  accountSlug: string,
  slug: string,
): Promise<PublicBookingPage | null> => {
  const rows = await appDb.execute<PublicPageRow>(
    sql`select * from rawr.public_booking_page(${accountSlug}, ${slug})`,
  )
  const row = rows[0]
  if (!row) return null
  return {
    accountId: row.account_id,
    accountSlug: row.account_slug,
    accountName: row.account_name,
    bookingPageId: row.booking_page_id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    durationMinutes: row.duration_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    minNoticeMinutes: row.min_notice_minutes,
    maxHorizonDays: row.max_horizon_days,
    granularityMinutes: row.granularity_minutes,
    location: row.location,
    locationDetail: row.location_detail,
    questions: readQuestions(row.questions),
    isActive: row.is_active,
    redirectUrl: row.redirect_url,
    confirmationCopy: row.confirmation_copy,
    hostNames: Array.isArray(row.host_names) ? row.host_names.filter(Boolean) : [],
  }
}

/** Everything about a page, including the templates. Read under an account scope,
 *  so this is the shape the confirmation path and the admin screens use. */
export type BookingPageConfig = PublicBookingPage & {
  ownerId: string | null
  titleTpl: string
  descriptionTpl: string
  companyFallback: string
  confirmationEnabled: boolean
  /** Null means the wording Rawr ships. Kept as null rather than resolved here so
   *  that improving the default reaches every page that never customised it. */
  confirmationSubject: string | null
  confirmationBody: string | null
  reminderSubject: string | null
  reminderBody: string | null
  reminders: BookingReminder[]
}

export const REMINDER_UNITS = ['week', 'day', 'hour', 'minute'] as const
export type ReminderUnit = (typeof REMINDER_UNITS)[number]

export type BookingReminder = { id: string; amount: number; unit: ReminderUnit }

const MINUTES_PER_UNIT: Record<ReminderUnit, number> = {
  week: 10_080,
  day: 1440,
  hour: 60,
  minute: 1,
}

/** How far ahead of the meeting a reminder goes out. The pair is stored, not this,
 *  so "1 week before" reads back as one week. */
export const reminderLeadMinutes = (reminder: { amount: number; unit: ReminderUnit }): number =>
  reminder.amount * MINUTES_PER_UNIT[reminder.unit]

export const reminderLabel = (reminder: { amount: number; unit: ReminderUnit }): string =>
  `${reminder.amount} ${reminder.unit}${reminder.amount === 1 ? '' : 's'} before`

const readReminders = (raw: unknown): BookingReminder[] => {
  if (!Array.isArray(raw)) return []
  const units = new Set<string>(REMINDER_UNITS)
  return raw
    .filter(
      (row): row is BookingReminder =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as BookingReminder).id === 'string' &&
        Number.isFinite((row as BookingReminder).amount) &&
        units.has((row as BookingReminder).unit),
    )
    .map((row) => ({ id: row.id, amount: Number(row.amount), unit: row.unit }))
    .sort((a, b) => reminderLeadMinutes(b) - reminderLeadMinutes(a))
}

const PAGE_COLUMNS = sql`
  p.account_id, a.slug as account_slug, a.name as account_name, p.id as booking_page_id,
  p.slug, p.name, p.kind, p.owner_id, p.duration_minutes, p.buffer_before_minutes,
  p.buffer_after_minutes, p.min_notice_minutes, p.max_horizon_days, p.granularity_minutes,
  p.location, p.location_detail, p.title_tpl, p.description_tpl, p.company_fallback,
  p.questions, p.is_active, p.redirect_url, p.confirmation_copy,
  p.confirmation_enabled, p.confirmation_subject, p.confirmation_body,
  p.reminder_subject, p.reminder_body,
  coalesce(
    (select jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'unit', r.unit))
       from booking_reminder r where r.booking_page_id = p.id),
    '[]'::jsonb
  ) as reminders,
  coalesce(
    (select array_agg(u.name order by u.name)
       from booking_host h join user_account u on u.id = h.user_id
      where h.booking_page_id = p.id and h.is_active),
    '{}'::text[]
  ) as host_names`

type ConfigRow = PublicPageRow & {
  owner_id: string | null
  title_tpl: string
  description_tpl: string
  company_fallback: string
  confirmation_enabled: boolean
  confirmation_subject: string | null
  confirmation_body: string | null
  reminder_subject: string | null
  reminder_body: string | null
  reminders: unknown
}

const toConfig = (row: ConfigRow): BookingPageConfig => ({
  accountId: row.account_id,
  accountSlug: row.account_slug,
  accountName: row.account_name,
  bookingPageId: row.booking_page_id,
  slug: row.slug,
  name: row.name,
  kind: row.kind,
  ownerId: row.owner_id,
  durationMinutes: row.duration_minutes,
  bufferBeforeMinutes: row.buffer_before_minutes,
  bufferAfterMinutes: row.buffer_after_minutes,
  minNoticeMinutes: row.min_notice_minutes,
  maxHorizonDays: row.max_horizon_days,
  granularityMinutes: row.granularity_minutes,
  location: row.location,
  locationDetail: row.location_detail,
  hostNames: Array.isArray(row.host_names) ? row.host_names.filter(Boolean) : [],
  titleTpl: row.title_tpl,
  descriptionTpl: row.description_tpl,
  companyFallback: row.company_fallback,
  questions: readQuestions(row.questions),
  isActive: row.is_active,
  redirectUrl: row.redirect_url,
  confirmationCopy: row.confirmation_copy,
  confirmationEnabled: row.confirmation_enabled,
  confirmationSubject: row.confirmation_subject,
  confirmationBody: row.confirmation_body,
  reminderSubject: row.reminder_subject,
  reminderBody: row.reminder_body,
  reminders: readReminders(row.reminders),
})

const readConfig = async (tx: Tx, pageId: string): Promise<BookingPageConfig | null> => {
  const [row] = await tx.execute<ConfigRow>(sql`
    select ${PAGE_COLUMNS} from booking_page p
      join account a on a.id = p.account_id
     where p.id = ${pageId} limit 1`)
  return row ? toConfig(row) : null
}

export const readBookingPage = async (
  ctx: AccountContext,
  pageId: string,
): Promise<BookingPageConfig | null> =>
  isUuid(pageId) ? withAccount(ctx, (tx) => readConfig(tx, pageId)) : null

// ---------------------------------------------------------------------------
// Hosts and availability
// ---------------------------------------------------------------------------

export type HostAvailability = {
  userId: string
  name: string
  email: string
  weight: number
  /** Collective only: whether this host has to be free for a time to be offered.
   *  Always true on the other kinds, where each host stands alone. */
  isRequired: boolean
  lastAssignedAt: Date | null
  timezone: string
  weekly: WeeklyRules
  overrides: Map<string, DayOverride>
  provider: 'google' | 'dev'
  calendarId: string
  grantState: 'unconfigured' | 'connected' | 'degraded' | 'revoked'
  /** Why this host is offering nothing, in words an admin can act on. Null when
   *  they are usable. */
  unavailableReason: string | null
  /** Confirmed Rawr bookings in the window. Always counted, on every page this
   *  person hosts, which is what stops two pages offering the same hour twice. */
  rawrBusy: Interval[]
  /** Confirmed bookings in the trailing window, for the round robin share. */
  recentAssignments: number
}

type HostRow = {
  user_id: string
  name: string
  email: string
  weight: number
  is_required: boolean
  last_assigned_at: Date | string | null
  timezone: string | null
  weekly: unknown
  provider: 'google' | 'dev' | null
  calendar_id: string | null
  grant_state: HostAvailability['grantState'] | null
  last_error: string | null
}

/** How far back the round robin counts, so a host who was away for a week catches
 *  up rather than being permanently behind. Counted from real bookings, not from a
 *  stored tally, so it cannot drift. */
const ASSIGNMENT_WINDOW_DAYS = 30

/** A list of ids as SQL. Drizzle expands a JS array in a template into one
 *  placeholder per element, which produces `any(($1, $2))` and is a syntax error,
 *  so the list is built explicitly. Callers guarantee it is not empty. */
const idList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `)

/** An instant as SQL. A raw query built with the `sql` template hands its
 *  parameters to the driver untouched, and the driver refuses a Date, so every
 *  instant crosses as an ISO string with the cast written on it. */
const ts = (at: Date) => sql`${at.toISOString()}::timestamptz`

const asDate = (value: Date | string | null): Date | null =>
  value === null ? null : value instanceof Date ? value : new Date(value)

/** Everything the availability computation needs about the people on a page, in
 *  four queries rather than four per host. */
export const readPageHosts = async (
  ctx: AccountContext,
  pageId: string,
  window: { from: Date; to: Date },
): Promise<HostAvailability[]> =>
  withAccount(ctx, async (tx) => {
    const hosts = await tx.execute<HostRow>(sql`
      select h.user_id, u.name, u.email, h.weight, h.is_required, h.last_assigned_at,
             a.timezone, a.weekly,
             g.provider, g.calendar_id, g.state as grant_state, g.last_error
        from booking_host h
        join user_account u on u.id = h.user_id
        left join availability a on a.user_id = h.user_id
        left join calendar_grant g on g.user_id = h.user_id
       where h.booking_page_id = ${pageId} and h.is_active
       order by u.name`)

    if (hosts.length === 0) return []
    const ids = hosts.map((host) => host.user_id)

    const [overrides, busy, counts] = await Promise.all([
      tx.execute<{ user_id: string; day: string; is_unavailable: boolean; blocks: unknown }>(sql`
        select user_id, day::text as day, is_unavailable, blocks
          from availability_override
         where user_id in (${idList(ids)})
           and day between ${dayKey(window.from, 'UTC')}::date - 1
                       and ${dayKey(window.to, 'UTC')}::date + 1`),
      // booking_participant rather than booking: on a collective page most people
      // in the room did not organise the meeting, and a commitment is a commitment.
      // Rows exist only while the booking is confirmed, so no state test is needed.
      tx.execute<{ user_id: string; starts_at: Date | string; ends_at: Date | string }>(sql`
        select user_id, starts_at, ends_at
          from booking_participant
         where user_id in (${idList(ids)})
           and starts_at < ${ts(window.to)} and ends_at > ${ts(window.from)}`),
      tx.execute<{ host_user_id: string; n: string }>(sql`
        select host_user_id, count(*) as n
          from booking
         where host_user_id in (${idList(ids)}) and state = 'confirmed'
           and booking_page_id = ${pageId}
           and created_at > now() - make_interval(days => ${ASSIGNMENT_WINDOW_DAYS})
         group by host_user_id`),
    ])

    const overridesByUser = new Map<string, Map<string, DayOverride>>()
    for (const row of overrides) {
      const forUser = overridesByUser.get(row.user_id) ?? new Map<string, DayOverride>()
      forUser.set(row.day, {
        isUnavailable: row.is_unavailable,
        blocks: readRanges(row.blocks),
      })
      overridesByUser.set(row.user_id, forUser)
    }

    const busyByUser = new Map<string, Interval[]>()
    for (const row of busy) {
      const list = busyByUser.get(row.user_id) ?? []
      list.push({ start: new Date(row.starts_at), end: new Date(row.ends_at) })
      busyByUser.set(row.user_id, list)
    }

    const countByUser = new Map(counts.map((row) => [row.host_user_id, Number(row.n)]))

    return hosts.map((host) => ({
      userId: host.user_id,
      name: host.name,
      email: host.email,
      weight: host.weight,
      isRequired: host.is_required,
      lastAssignedAt: asDate(host.last_assigned_at),
      timezone: host.timezone ?? 'America/Los_Angeles',
      // The same fallback the working-hours screen shows. Without it that screen
      // displayed nine to five for somebody with no row, while the engine read
      // nothing and held every slot back: hours on screen, an empty calendar in
      // public, and no way to tell from either which one was lying.
      weekly: host.weekly === null ? DEFAULT_WEEKLY : readWeekly(host.weekly),
      overrides: overridesByUser.get(host.user_id) ?? new Map(),
      provider: host.provider ?? 'google',
      calendarId: host.calendar_id ?? 'primary',
      grantState: host.grant_state ?? 'unconfigured',
      unavailableReason: grantProblem(host),
      rawrBusy: busyByUser.get(host.user_id) ?? [],
      recentAssignments: countByUser.get(host.user_id) ?? 0,
    }))
  })

/** A host with no working calendar is unavailable, never free. Failing open here
 *  double books a real person, which is the one outcome worse than offering fewer
 *  slots. F2 §2. */
const grantProblem = (host: HostRow): string | null => {
  if (!host.grant_state || host.grant_state === 'unconfigured') {
    return `${host.name} has not connected a calendar, so no slots can be offered for them.`
  }
  if (host.grant_state === 'revoked') {
    return `${host.name}'s calendar access was revoked and has to be reconnected.`
  }
  if (host.grant_state === 'degraded') {
    return `${host.name}'s calendar is failing: ${host.last_error ?? 'no reason recorded'}`
  }
  if (host.weekly !== null && Object.keys(readWeekly(host.weekly)).length === 0) {
    return `${host.name} has no working hours set, so there is nothing to offer.`
  }
  return null
}

// ---------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------

export type OfferedSlot = { startsAt: Date; hostUserIds: string[] }

export type Offer = {
  slots: OfferedSlot[]
  /** Hosts that contributed nothing and why, for the admin health panel and for
   *  an honest empty state rather than a blank calendar. */
  problems: string[]
}

export type OfferInput = {
  page: Pick<
    BookingPageConfig,
    | 'kind'
    | 'durationMinutes'
    | 'bufferBeforeMinutes'
    | 'bufferAfterMinutes'
    | 'minNoticeMinutes'
    | 'maxHorizonDays'
    | 'granularityMinutes'
  >
  hosts: HostAvailability[]
  /** Free-busy read from the provider, per host. A host missing from this map is
   *  treated as unavailable, not as free. */
  externalBusy: Map<string, Interval[]>
  /** Live holds on this page, as slot start instants with a count. */
  holds: Map<number, number>
  from: Date
  to: Date
  now: Date
}

/** Which instants are offerable, and by whom.
 *
 *  Per host: their own windows minus their own commitments, computed in their own
 *  timezone. Then across hosts, and this is where the kinds part company.
 *
 *  A round robin takes the union: the slot is offered if anybody can take it, and a
 *  hold reserves capacity rather than the slot, so on a page with three free hosts
 *  it takes three holds to close an hour.
 *
 *  A collective takes the intersection of the required hosts: the meeting is the
 *  whole panel, so a time with one of them missing is not that meeting. There is
 *  one meeting to take, so one hold closes it. Optional hosts ride along wherever
 *  they are free and never hold the calendar back. */
export const computeOffer = (input: OfferInput): Offer => {
  const byInstant = new Map<number, string[]>()
  const problems: string[] = []
  const collective = input.page.kind === 'collective'
  const required = collective ? input.hosts.filter((host) => host.isRequired) : []

  if (collective && required.length === 0) {
    return {
      slots: [],
      problems: ['This page needs at least one required host before it can offer a time.'],
    }
  }

  for (const host of input.hosts) {
    if (host.unavailableReason) {
      problems.push(host.unavailableReason)
      continue
    }
    const external = input.externalBusy.get(host.userId)
    if (!external) {
      problems.push(
        `${host.name}'s calendar could not be read, so their slots are held back rather than guessed.`,
      )
      continue
    }

    const slots = computeSlots({
      from: input.from,
      to: input.to,
      now: input.now,
      timezone: host.timezone,
      weekly: host.weekly,
      overrides: host.overrides,
      busy: [...external, ...host.rawrBusy],
      durationMinutes: input.page.durationMinutes,
      bufferBeforeMinutes: input.page.bufferBeforeMinutes,
      bufferAfterMinutes: input.page.bufferAfterMinutes,
      minNoticeMinutes: input.page.minNoticeMinutes,
      maxHorizonDays: input.page.maxHorizonDays,
      granularityMinutes: input.page.granularityMinutes,
    })

    for (const slot of slots) {
      const at = slot.getTime()
      const holders = byInstant.get(at)
      if (holders) holders.push(host.userId)
      else byInstant.set(at, [host.userId])
    }
  }

  const slots: OfferedSlot[] = []
  for (const [at, hostUserIds] of byInstant) {
    const held = input.holds.get(at) ?? 0
    if (collective) {
      const present = new Set(hostUserIds)
      if (!required.every((host) => present.has(host.userId))) continue
      // One meeting, so one hold closes it.
      if (held > 0) continue
    } else if (hostUserIds.length <= held) {
      continue
    }
    slots.push({ startsAt: new Date(at), hostUserIds })
  }
  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  return { slots, problems }
}

// ---------------------------------------------------------------------------
// Round robin
// ---------------------------------------------------------------------------

export type Candidate = {
  userId: string
  weight: number
  lastAssignedAt: Date | null
  recentAssignments: number
}

/** Cheap, stable, and not a security boundary: it only has to break a tie the same
 *  way twice for the same inputs. */
const hash = (value: string): number => {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** F2 §3. Lowest share first, where share is bookings taken divided by weight.
 *  Ties break on who was assigned longest ago, then on a hash so the result is the
 *  same every time for the same inputs.
 *
 *  The seed is the slot and the attendee rather than the booking id the doc names:
 *  a booking id is generated by the insert this decision precedes, so seeding on it
 *  would make the tie-break random per attempt instead of deterministic. */
export const assignHost = (candidates: Candidate[], seed: string): string | null => {
  if (candidates.length === 0) return null
  const ranked = [...candidates].sort((a, b) => {
    const shareA = a.recentAssignments / Math.max(1, a.weight)
    const shareB = b.recentAssignments / Math.max(1, b.weight)
    if (shareA !== shareB) return shareA - shareB

    const seenA = a.lastAssignedAt?.getTime() ?? 0
    const seenB = b.lastAssignedAt?.getTime() ?? 0
    if (seenA !== seenB) return seenA - seenB

    return hash(`${seed}:${a.userId}`) - hash(`${seed}:${b.userId}`)
  })
  return ranked[0]?.userId ?? null
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

export const HOLD_MINUTES = 5

export const readHolds = async (
  ctx: AccountContext,
  pageId: string,
  window: { from: Date; to: Date },
): Promise<Map<number, number>> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ starts_at: Date | string; n: string }>(sql`
      select starts_at, count(*) as n from booking_hold
       where booking_page_id = ${pageId} and expires_at > now()
         and starts_at >= ${ts(window.from)} and starts_at < ${ts(window.to)}
       group by starts_at`)
    return new Map(rows.map((row) => [new Date(row.starts_at).getTime(), Number(row.n)]))
  })

export const placeHold = async (
  accountId: string,
  pageId: string,
  startsAt: Date,
): Promise<{ token: string; expiresAt: Date }> => {
  const ctx = publicEdgeContext(accountId)
  const token = randomToken(18)
  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000)
  await withAccount(ctx, async (tx) => {
    // Expired holds are cleared on the way past rather than by a job: the only
    // query that cares is this one, and it is the only writer.
    await tx.execute(sql`delete from booking_hold where expires_at < now() - interval '1 hour'`)
    await tx.execute(sql`
      insert into booking_hold (account_id, booking_page_id, starts_at, token, expires_at)
      values (${accountId}, ${pageId}, ${ts(startsAt)}, ${token}, ${ts(expiresAt)})`)
  })
  return { token, expiresAt }
}

/** One token, moved from slot to slot as the person changes their mind, rather
 *  than a release and a fresh insert per change.
 *
 *  Reusing the token is what stops a refresh stacking holds, and what closes the
 *  window where somebody who had just clicked a different time held nothing at
 *  all. A move consumes no capacity that the previous hold was not already
 *  consuming, so it costs the visitor one request instead of two.
 *
 *  Falls through to placing one when the token names nothing live: it may have
 *  expired while the questions were being filled in, and the person changing a
 *  slot is not who should be told about that. */
export const renewHold = async (
  accountId: string,
  pageId: string,
  startsAt: Date,
  token: string | null,
): Promise<{ token: string; expiresAt: Date }> => {
  if (token) {
    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000)
    const moved = await withAccount(publicEdgeContext(accountId), (tx) =>
      tx.execute(sql`
        update booking_hold
           set starts_at = ${ts(startsAt)}, expires_at = ${ts(expiresAt)}
         where token = ${token} and booking_page_id = ${pageId} and expires_at > now()
        returning token`),
    )
    if (moved.length > 0) return { token, expiresAt }
  }
  return placeHold(accountId, pageId, startsAt)
}

export const releaseHold = async (accountId: string, token: string): Promise<void> => {
  await withAccount(publicEdgeContext(accountId), (tx) =>
    tx.execute(sql`delete from booking_hold where token = ${token}`),
  )
}

// ---------------------------------------------------------------------------
// Confirming a booking
// ---------------------------------------------------------------------------

export class SlotGoneError extends Error {
  constructor(message = 'That slot just went. Here are the times still open.') {
    super(message)
    this.name = 'SlotGoneError'
  }
}

export type Attendee = { name: string; email: string; timezone: string }

/** What the outside world contributes: a calendar event and, when the provider is
 *  reachable, a conference link. Called inside the booking transaction, so a
 *  throw here writes nothing at all. */
export type Provisioned = {
  calendarEventId: string | null
  calendarId: string | null
  conferenceUrl: string | null
  conferenceRef: string | null
  /** One per host in `alsoOn`, in any order. Their invitations, so a cancellation
   *  can withdraw each rather than orphaning it. */
  alsoWritten?: { userId: string; calendarEventId: string | null; calendarId: string | null }[]
  /** Non-fatal. A Zoom outage lands here; the meeting still happens. F2 §4. */
  warnings: string[]
}

/** One person the meeting commits, as the provisioner needs them. */
export type ProvisionHost = {
  userId: string
  name: string
  email: string
  calendarId: string
  provider: 'google' | 'dev'
}

export type ProvisionRequest = {
  page: BookingPageConfig
  /** The organiser: whose conference it is, and whose event carries the booking. */
  host: ProvisionHost
  /** Everybody else the meeting commits, on a collective page. Empty otherwise. */
  alsoOn: ProvisionHost[]
  startsAt: Date
  endsAt: Date
  attendee: Attendee
  answers: Record<string, unknown>
  companyName: string | null
  contactId: string | null
  /** The attendee's own credentials for their own booking, generated before the
   *  event is written so the invitation can carry the reschedule and cancel links.
   *  Rawr cannot send email yet (D7 rules out sending, and the newsletter provider
   *  arrives in F6), so the calendar invitation Google sends is where an attendee
   *  actually receives them. */
  tokens: { cancel: string; reschedule: string }
}

export type Provisioner = (request: ProvisionRequest) => Promise<Provisioned>

export type ConfirmInput = {
  page: BookingPageConfig
  startsAt: Date
  /** The whole posted body. Validated against the page's questions here, so an
   *  answer to a question the page does not ask is refused rather than stored. */
  body: Record<string, unknown>
  attendeeTimezone: string
  attribution: AttributionInput
  holdToken?: string | null | undefined
  /** Set when this booking replaces another. The old row becomes 'rescheduled'. */
  rescheduleOf?: string | null | undefined
  /** F4 §3, T1. Present only for the inline widget, which runs in the same page
   *  context as the embed and can read the first-party cookie. The hosted page is
   *  on Rawr's origin and has no access to it, so a booking made there identifies
   *  nobody, correctly. */
  visitorId?: string | null | undefined
}

/** A calendar entry that belongs to nobody now: written for a booking that has
 *  since been cancelled or moved. Returned rather than deleted here, because
 *  withdrawing it is a call to Google and nothing in this layer talks to Google. */
export type OrphanedEvent = {
  userId: string
  calendarEventId: string
  calendarId: string
}

export type ConfirmResult = {
  bookingId: string
  hostUserId: string
  hostName: string
  hostEmail: string
  startsAt: Date
  endsAt: Date
  contactId: string | null
  companyId: string | null
  /** What the attendee gave, echoed back so the mail the caller sends does not
   *  have to read the row it just wrote. */
  attendeeName: string
  attendeeEmail: string
  attendeeTimezone: string
  companyName: string | null
  conferenceUrl: string | null
  cancelToken: string
  rescheduleToken: string
  /** The invitations the booking this one replaced had written for its other
   *  participants. The organiser's own event is patched or replaced by the caller;
   *  these have to be withdrawn. */
  releasedEvents: OrphanedEvent[]
  warnings: string[]
  errors?: FieldError[] | undefined
}

/** Frees everything a booking committed, and hands back the invitations that now
 *  belong to nobody. Deleting the rows is what makes the time bookable again. */
const releaseParticipants = async (tx: Tx, bookingId: string): Promise<OrphanedEvent[]> => {
  const rows = await tx.execute<{
    user_id: string
    calendar_event_id: string | null
    calendar_id: string | null
    is_organiser: boolean
  }>(sql`
    delete from booking_participant where booking_id = ${bookingId}
    returning user_id, calendar_event_id, calendar_id, is_organiser`)

  return rows
    .filter((row) => !row.is_organiser && row.calendar_event_id && row.calendar_id)
    .map((row) => ({
      userId: row.user_id,
      calendarEventId: row.calendar_event_id as string,
      calendarId: row.calendar_id as string,
    }))
}

/** F2 §4, steps 2 to 7, in one transaction.
 *
 *  The doc numbers the calendar event before the contact upsert. The order here is
 *  the other way round, and it is the same guarantee: everything runs inside one
 *  transaction, so a calendar failure still leaves nothing written. Doing the
 *  upsert first means the event title can carry the real company name, which is
 *  what §5 asks for.
 *
 *  `hosts` must be the set the caller has just verified against live free-busy,
 *  with caches bypassed. This function re-checks Rawr's own bookings and takes an
 *  advisory lock on the slot, but it cannot know what Google said a moment ago. */
export const confirmBooking = async (
  ctx: AccountContext,
  input: ConfirmInput,
  hosts: HostAvailability[],
  provision: Provisioner,
): Promise<ConfirmResult> => {
  assertCanWrite(ctx, 'contact')
  const fields = bookingFields(input.page.questions)
  const { answers, errors } = validateAnswers(fields, input.body)
  if (errors.length > 0) {
    return { ...emptyResult(input), errors }
  }

  const email = emailFrom(fields, answers)
  const name = typeof answers.name === 'string' ? answers.name.trim() : ''
  if (!email) {
    return {
      ...emptyResult(input),
      errors: [{ key: 'email', message: 'Work email is required to book a meeting.' }],
    }
  }

  const endsAt = new Date(input.startsAt.getTime() + input.page.durationMinutes * 60_000)
  const attribution = readAttribution(input.attribution)

  return withAccount(ctx, async (tx) => {
    // Serialises every attempt on this page and this instant, so two visitors
    // racing for the last slot are resolved rather than both being told yes. The
    // partial unique index on (host, starts_at) is the backstop underneath it.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`${input.page.bookingPageId}|${input.startsAt.toISOString()}`}, 0))`)

    const candidateIds = hosts.map((host) => host.userId)
    if (candidateIds.length === 0) throw new SlotGoneError()

    // The meeting being moved releases its own commitments first, so a reschedule
    // is never blocked by the booking it is replacing. Inside the transaction, so
    // a failed insert puts them back.
    const releasedEvents = input.rescheduleOf
      ? await releaseParticipants(tx, input.rescheduleOf)
      : []
    if (input.rescheduleOf) {
      await tx.execute(sql`
        update booking set state = 'rescheduled', updated_at = now()
         where id = ${input.rescheduleOf} and state = 'confirmed'`)
    }

    // Rawr's own commitments, re-read now rather than trusted from the page load.
    // Overlap, not equality: a sixty minute meeting at ten blocks a slot at half past.
    const taken = await tx.execute<{ user_id: string }>(sql`
      select user_id from booking_participant
       where user_id in (${idList(candidateIds)})
         and starts_at < ${ts(endsAt)} and ends_at > ${ts(input.startsAt)}`)
    const busy = new Set(taken.map((row) => row.user_id))

    const free = hosts.filter((host) => !busy.has(host.userId))
    if (free.length === 0) throw new SlotGoneError()

    const collective = input.page.kind === 'collective'
    const required = hosts.filter((host) => host.isRequired)
    // A panel with somebody missing is not the meeting that was asked for, so it
    // is refused as a slot that has gone rather than quietly booked short.
    if (collective && (required.length === 0 || required.some((host) => busy.has(host.userId)))) {
      throw new SlotGoneError()
    }

    // Who takes it. On a collective the organiser rotates through the required
    // hosts by the same share rule, so ownership of the lead is still shared out.
    const chosenId = assignHost(
      (collective ? required : free).map((host) => ({
        userId: host.userId,
        weight: host.weight,
        lastAssignedAt: host.lastAssignedAt,
        recentAssignments: host.recentAssignments,
      })),
      `${input.startsAt.toISOString()}|${email.toLowerCase()}`,
    )
    const host = free.find((candidate) => candidate.userId === chosenId)
    if (!host) throw new SlotGoneError()

    // Everybody the meeting commits: the whole free party on a collective page,
    // the assigned host alone on the others.
    const party = collective ? free : [host]

    const [first = '', ...rest] = name.split(/\s+/).filter(Boolean)
    const mapped = mapAnswersToColumns(fields, answers)
    const linked = await upsertCapturedPerson(tx, ctx, {
      email,
      contact: {
        ...mapped.contact,
        // Only used when the column is empty, so a real first name already on the
        // record is never replaced by a half-typed one from a booking form.
        first_name: first,
        last_name: rest.join(' '),
      },
      company: mapped.company,
      attribution,
      source: 'booking',
      // The person who takes the meeting owns the lead, the way HubSpot hands a
      // booked contact to the organiser. An existing owner is kept.
      assignOwner: { mode: 'user', userId: host.userId },
    })

    const companyName = await resolveCompanyName(tx, linked.companyId, mapped.company)

    const cancelToken = randomToken()
    const rescheduleToken = randomToken()

    const provisioned = await provision({
      page: input.page,
      host: {
        userId: host.userId,
        name: host.name,
        email: host.email,
        calendarId: host.calendarId,
        provider: host.provider,
      },
      alsoOn: party
        .filter((member) => member.userId !== host.userId)
        .map((member) => ({
          userId: member.userId,
          name: member.name,
          email: member.email,
          calendarId: member.calendarId,
          provider: member.provider,
        })),
      startsAt: input.startsAt,
      endsAt,
      attendee: { name, email, timezone: input.attendeeTimezone },
      answers,
      companyName,
      contactId: linked.contactId,
      tokens: { cancel: cancelToken, reschedule: rescheduleToken },
    })

    const [row] = await tx.execute<{ id: string }>(sql`
      insert into booking (account_id, booking_page_id, host_user_id, contact_id, company_id,
                           starts_at, ends_at, attendee_timezone, attendee_name, attendee_email,
                           answers, conference_url, conference_ref, calendar_event_id, calendar_id,
                           state, reschedule_of, cancel_token, reschedule_token)
      values (${ctx.accountId}, ${input.page.bookingPageId}, ${host.userId},
              ${linked.contactId}, ${linked.companyId}, ${ts(input.startsAt)}, ${ts(endsAt)},
              ${input.attendeeTimezone}, ${name || email}, ${email},
              ${JSON.stringify(answers)}::jsonb, ${provisioned.conferenceUrl},
              ${provisioned.conferenceRef}, ${provisioned.calendarEventId},
              ${provisioned.calendarId}, 'confirmed', ${input.rescheduleOf ?? null},
              ${cancelToken}, ${rescheduleToken})
      on conflict do nothing
      returning id`)

    // The unique index refused it: somebody else confirmed this host for this
    // instant between the lock being taken and here, which should be impossible
    // and is caught anyway rather than trusted.
    if (!row) throw new SlotGoneError()

    // One row per person in the room, including the organiser. This is what makes
    // a double booking unreachable for a host who did not organise the meeting,
    // and the same unique index refuses it if two collectives race.
    const written = new Map(
      (provisioned.alsoWritten ?? []).map((event) => [event.userId, event]),
    )
    for (const member of party) {
      const own = member.userId === host.userId
      const event = own
        ? { calendarEventId: provisioned.calendarEventId, calendarId: provisioned.calendarId }
        : (written.get(member.userId) ?? { calendarEventId: null, calendarId: null })
      const [seat] = await tx.execute<{ user_id: string }>(sql`
        insert into booking_participant (account_id, booking_id, user_id, starts_at, ends_at,
                                         calendar_event_id, calendar_id, is_organiser)
        values (${ctx.accountId}, ${row.id}, ${member.userId}, ${ts(input.startsAt)},
                ${ts(endsAt)}, ${event.calendarEventId}, ${event.calendarId}, ${own})
        on conflict do nothing
        returning user_id`)
      if (!seat) throw new SlotGoneError()
    }

    await tx.execute(sql`
      update booking_host set last_assigned_at = now()
       where booking_page_id = ${input.page.bookingPageId} and user_id = ${host.userId}`)

    if (input.holdToken) {
      await tx.execute(sql`delete from booking_hold where token = ${input.holdToken}`)
    }

    if (input.visitorId && linked.contactId) {
      await aliasVisitor(tx, ctx, {
        visitorId: input.visitorId,
        contactId: linked.contactId,
        via: 'booking',
      })
    }

    await recordActivity(tx, ctx, {
      type: 'booking',
      subject: `${input.rescheduleOf ? 'rescheduled' : 'booked'} ${input.page.name} with ${host.name}`,
      occurredAt: new Date(),
      source: 'booking',
      payload: {
        bookingId: row.id,
        bookingPageId: input.page.bookingPageId,
        hostUserId: host.userId,
        startsAt: input.startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        attendeeTimezone: input.attendeeTimezone,
        conferenceUrl: provisioned.conferenceUrl,
        answers,
      },
      links: [
        ...(linked.contactId ? [{ entityType: 'contact' as const, entityId: linked.contactId }] : []),
        ...(linked.companyId ? [{ entityType: 'company' as const, entityId: linked.companyId }] : []),
      ],
    })

    await writeAudit(tx, ctx, {
      entity: 'booking',
      entityId: row.id,
      action: input.rescheduleOf ? 'reschedule' : 'create',
      before: input.rescheduleOf ? { bookingId: input.rescheduleOf } : null,
      after: {
        bookingPageId: input.page.bookingPageId,
        hostUserId: host.userId,
        startsAt: input.startsAt.toISOString(),
        attendeeEmail: email,
        conferenceUrl: provisioned.conferenceUrl,
      },
    })

    return {
      bookingId: row.id,
      hostUserId: host.userId,
      releasedEvents,
      hostName: host.name,
      hostEmail: host.email,
      startsAt: input.startsAt,
      endsAt,
      contactId: linked.contactId,
      companyId: linked.companyId,
      attendeeName: name,
      attendeeEmail: email,
      attendeeTimezone: input.attendeeTimezone,
      companyName,
      conferenceUrl: provisioned.conferenceUrl,
      cancelToken,
      rescheduleToken,
      warnings: provisioned.warnings,
    }
  })
}

const emptyResult = (input: ConfirmInput): ConfirmResult => ({
  bookingId: '',
  hostUserId: '',
  releasedEvents: [],
  hostName: '',
  hostEmail: '',
  startsAt: input.startsAt,
  endsAt: new Date(input.startsAt.getTime() + input.page.durationMinutes * 60_000),
  contactId: null,
  companyId: null,
  attendeeName: '',
  attendeeEmail: '',
  attendeeTimezone: input.attendeeTimezone,
  companyName: null,
  conferenceUrl: null,
  cancelToken: '',
  rescheduleToken: '',
  warnings: [],
})

/** What {{company.name}} renders as. The record wins when there is one, then
 *  whatever the booker typed, then nothing, and §5's fallback covers nothing. */
const resolveCompanyName = async (
  tx: Tx,
  companyId: string | null,
  answered: Record<string, unknown>,
): Promise<string | null> => {
  if (companyId) {
    const [row] = await tx.execute<{ name: string | null }>(
      sql`select name from company where id = ${companyId} limit 1`,
    )
    if (row?.name) return row.name
  }
  const typed = answered.name
  return typeof typed === 'string' && typed.trim() ? typed.trim() : null
}

// ---------------------------------------------------------------------------
// Reading one booking, by token or by id
// ---------------------------------------------------------------------------

export type BookingRecord = {
  id: string
  accountId: string
  bookingPageId: string
  pageName: string
  pageSlug: string
  accountSlug: string
  hostUserId: string
  hostName: string
  hostEmail: string
  contactId: string | null
  companyId: string | null
  startsAt: Date
  endsAt: Date
  attendeeName: string
  attendeeEmail: string
  attendeeTimezone: string
  answers: Record<string, unknown>
  conferenceUrl: string | null
  conferenceRef: string | null
  calendarEventId: string | null
  calendarId: string | null
  state: BookingState
  cancelToken: string
  rescheduleToken: string
  cancelReason: string | null
}

type BookingRow = {
  id: string
  account_id: string
  booking_page_id: string
  page_name: string
  page_slug: string
  account_slug: string
  host_user_id: string
  host_name: string
  host_email: string
  contact_id: string | null
  company_id: string | null
  starts_at: Date | string
  ends_at: Date | string
  attendee_name: string
  attendee_email: string
  attendee_timezone: string
  answers: unknown
  conference_url: string | null
  conference_ref: string | null
  calendar_event_id: string | null
  calendar_id: string | null
  state: BookingState
  cancel_token: string
  reschedule_token: string
  cancel_reason: string | null
}

const BOOKING_COLUMNS = sql`
  b.id, b.account_id, b.booking_page_id, p.name as page_name, p.slug as page_slug,
  a.slug as account_slug, b.host_user_id, u.name as host_name, u.email as host_email,
  b.contact_id, b.company_id, b.starts_at, b.ends_at, b.attendee_name, b.attendee_email,
  b.attendee_timezone, b.answers, b.conference_url, b.conference_ref, b.calendar_event_id,
  b.calendar_id, b.state, b.cancel_token, b.reschedule_token, b.cancel_reason`

const BOOKING_JOINS = sql`
  from booking b
  join booking_page p on p.id = b.booking_page_id
  join account a on a.id = b.account_id
  join user_account u on u.id = b.host_user_id`

const toBooking = (row: BookingRow): BookingRecord => ({
  id: row.id,
  accountId: row.account_id,
  bookingPageId: row.booking_page_id,
  pageName: row.page_name,
  pageSlug: row.page_slug,
  accountSlug: row.account_slug,
  hostUserId: row.host_user_id,
  hostName: row.host_name,
  hostEmail: row.host_email,
  contactId: row.contact_id,
  companyId: row.company_id,
  startsAt: new Date(row.starts_at),
  endsAt: new Date(row.ends_at),
  attendeeName: row.attendee_name,
  attendeeEmail: row.attendee_email,
  attendeeTimezone: row.attendee_timezone,
  answers: (row.answers ?? {}) as Record<string, unknown>,
  conferenceUrl: row.conference_url,
  conferenceRef: row.conference_ref,
  calendarEventId: row.calendar_event_id,
  calendarId: row.calendar_id,
  state: row.state,
  cancelToken: row.cancel_token,
  rescheduleToken: row.reschedule_token,
  cancelReason: row.cancel_reason,
})

export const readBooking = async (
  ctx: AccountContext,
  id: string,
): Promise<BookingRecord | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<BookingRow>(
      sql`select ${BOOKING_COLUMNS} ${BOOKING_JOINS} where b.id = ${id} limit 1`,
    )
    return row ? toBooking(row) : null
  })

/** The conference link arriving late, after §4 step 5 failed and the retry finally
 *  got one. Conditional on the link still being missing and the meeting still
 *  standing, so a retry that overlaps a cancellation or a reschedule writes
 *  nothing and says so. */
export const attachConference = async (
  ctx: AccountContext,
  id: string,
  conference: { url: string; ref: string | null },
): Promise<boolean> =>
  mutate<boolean>(ctx, 'booking', async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      update booking
         set conference_url = ${conference.url}, conference_ref = ${conference.ref},
             updated_at = now()
       where id = ${id} and state = 'confirmed' and conference_url is null
       returning id`)
    return {
      result: rows.length > 0,
      audit: {
        entity: 'booking',
        entityId: id,
        action: 'conference-link',
        before: { conferenceUrl: null },
        after: { conferenceUrl: rows.length > 0 ? conference.url : null },
      },
    }
  })

/** Someone clicking a link in their confirmation email has no session. The token
 *  is the credential, and it names which tenant to scope to. Single purpose: a
 *  cancel token cannot be used to reschedule. */
export const bookingForToken = async (
  purpose: 'cancel' | 'reschedule',
  token: string,
): Promise<BookingRecord | null> => {
  if (!token || token.length < 20) return null
  const rows = await appDb.execute<{ account_id: string; booking_id: string }>(
    sql`select * from rawr.booking_for_token(${purpose}, ${token})`,
  )
  const found = rows[0]
  if (!found) return null
  return readBooking(publicEdgeContext(found.account_id), found.booking_id)
}

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

export type Withdrawn = {
  alreadyDone: boolean
  booking: BookingRecord
  /** The invitations written for everybody who was not the organiser. Withdrawing
   *  them is the caller's job, for the same reason the organiser's own event is. */
  releasedEvents: OrphanedEvent[]
}

/** Idempotent by design: clicking cancel twice cancels once and reports the same
 *  thing both times, because a person who is not sure it worked will click again.
 *  Removing the calendar event is the caller's job and is also idempotent. */
export const cancelBooking = async (
  ctx: AccountContext,
  id: string,
  input: { reason?: string | null; by: 'attendee' | 'host' } = { by: 'host' },
): Promise<Withdrawn> => {
  const existing = await readBooking(ctx, id)
  if (!existing) throw new Error('That booking no longer exists.')
  if (existing.state !== 'confirmed')
    return { alreadyDone: true, booking: existing, releasedEvents: [] }

  return mutate<Withdrawn>(ctx, 'booking', async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      update booking set state = 'cancelled', cancelled_at = now(), updated_at = now(),
                         cancel_reason = ${input.reason ?? null}
       where id = ${id} and state = 'confirmed'
       returning id`)

    // Lost the race with another click. The first one did the work.
    if (updated.length === 0) {
      return {
        result: {
          alreadyDone: true,
          booking: { ...existing, state: 'cancelled' as BookingState },
          releasedEvents: [],
        },
        audit: { entity: 'booking', entityId: id, action: 'cancel', after: { noop: true } },
      }
    }

    // What actually frees the time again, for everybody the meeting committed.
    const releasedEvents = await releaseParticipants(tx, id)

    await recordActivity(tx, ctx, {
      type: 'booking',
      subject: `cancelled ${existing.pageName} with ${existing.hostName}`,
      source: 'booking',
      payload: {
        bookingId: id,
        cancelledBy: input.by,
        reason: input.reason ?? null,
        startsAt: existing.startsAt.toISOString(),
      },
      links: [
        ...(existing.contactId
          ? [{ entityType: 'contact' as const, entityId: existing.contactId }]
          : []),
        ...(existing.companyId
          ? [{ entityType: 'company' as const, entityId: existing.companyId }]
          : []),
      ],
    })

    return {
      result: {
        alreadyDone: false,
        booking: { ...existing, state: 'cancelled' as BookingState },
        releasedEvents,
      },
      audit: {
        entity: 'booking',
        entityId: id,
        action: 'cancel',
        before: { state: 'confirmed', startsAt: existing.startsAt.toISOString() },
        after: { state: 'cancelled', cancelledBy: input.by, reason: input.reason ?? null },
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Admin lists
// ---------------------------------------------------------------------------

export type BookingListRow = {
  id: string
  pageName: string
  hostName: string
  attendeeName: string
  attendeeEmail: string
  startsAt: Date
  endsAt: Date
  state: BookingState
  contactId: string | null
  conferenceUrl: string | null
}

/** Upcoming first, because that is what a person opening this screen wants. Keyset
 *  on (starts_at, id) so a page with four thousand past bookings opens as fast as
 *  one with three. */
export const listBookings = async (
  ctx: AccountContext,
  input: {
    pageId?: string | null | undefined
    hostUserId?: string | null | undefined
    state?: BookingState | null | undefined
    when?: 'upcoming' | 'past' | undefined
    limit?: number | undefined
    cursor?: { startsAt: Date; id: string } | null | undefined
  } = {},
): Promise<{ rows: BookingListRow[]; nextCursor: { startsAt: Date; id: string } | null }> => {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const past = input.when === 'past'

  return withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      page_name: string
      host_name: string
      attendee_name: string
      attendee_email: string
      starts_at: Date | string
      ends_at: Date | string
      state: BookingState
      contact_id: string | null
      conference_url: string | null
    }>(sql`
      select b.id, p.name as page_name, u.name as host_name, b.attendee_name, b.attendee_email,
             b.starts_at, b.ends_at, b.state, b.conference_url,
             -- Deleting a contact is a soft delete, so the column still points at
             -- a row. Offering it as a link sends somebody to a 404 after the
             -- delete dialog has just promised the meeting would read as plain text.
             c.id as contact_id
        from booking b
        join booking_page p on p.id = b.booking_page_id
        join user_account u on u.id = b.host_user_id
        left join contact c on c.id = b.contact_id and c.deleted_at is null
       where ${input.pageId ? sql`b.booking_page_id = ${input.pageId}` : sql`true`}
         and ${input.hostUserId ? sql`b.host_user_id = ${input.hostUserId}` : sql`true`}
         and ${input.state ? sql`b.state = ${input.state}` : sql`true`}
         and ${past ? sql`b.starts_at < now()` : sql`b.starts_at >= now()`}
         and ${
           input.cursor
             ? past
               ? sql`(b.starts_at, b.id) < (${ts(input.cursor.startsAt)}, ${input.cursor.id})`
               : sql`(b.starts_at, b.id) > (${ts(input.cursor.startsAt)}, ${input.cursor.id})`
             : sql`true`
         }
       order by b.starts_at ${past ? sql`desc` : sql`asc`}, b.id ${past ? sql`desc` : sql`asc`}
       limit ${limit + 1}`)

    const page = rows.slice(0, limit).map((row) => ({
      id: row.id,
      pageName: row.page_name,
      hostName: row.host_name,
      attendeeName: row.attendee_name,
      attendeeEmail: row.attendee_email,
      startsAt: new Date(row.starts_at),
      endsAt: new Date(row.ends_at),
      state: row.state,
      contactId: row.contact_id,
      conferenceUrl: row.conference_url,
    }))
    const more = rows.length > limit ? page.at(-1) : undefined
    return {
      rows: page,
      nextCursor: more ? { startsAt: more.startsAt, id: more.id } : null,
    }
  })
}

// ---------------------------------------------------------------------------
// Views, and what a page is worth
// ---------------------------------------------------------------------------

/** One more look at a public page. Counted per day rather than per view, because
 *  a link in an email signature is fetched by every scanner that touches the mail
 *  and a conversion rate only ever needs the daily total.
 *
 *  Reached from the public edge, so it takes the account the slug already
 *  resolved to and never one from the request. Best effort: a counter that
 *  refuses must not stop somebody booking a meeting. */
export const recordBookingPageView = async (accountId: string, pageId: string): Promise<void> => {
  const ctx = publicEdgeContext(accountId)
  await withAccount(ctx, (tx) =>
    tx.execute(sql`
      insert into booking_page_view (account_id, booking_page_id, day, views)
      values (${accountId}, ${pageId}, (now() at time zone 'utc')::date, 1)
      on conflict (account_id, booking_page_id, day)
        do update set views = booking_page_view.views + 1`),
  ).catch(() => undefined)
}

export type BookingPageStats = {
  views: number
  booked: number
  cancelled: number
  /** Bookings per hundred views. Null when nothing has been viewed, because zero
   *  per cent and "nobody has looked yet" are different answers. */
  conversion: number | null
  sinceDays: number
}

/** What one link is worth over a window. Two indexed counts, no scan of a view
 *  log: the counter is already daily. */
export const bookingPageStats = async (
  ctx: AccountContext,
  pageId: string,
  sinceDays = 30,
): Promise<BookingPageStats> =>
  withAccount(ctx, async (tx) => {
    const days = Math.min(Math.max(Math.trunc(sinceDays) || 30, 1), 365)
    const [row] = await tx.execute<{ views: string; booked: string; cancelled: string }>(sql`
      select
        coalesce((select sum(v.views) from booking_page_view v
                   where v.booking_page_id = ${pageId}
                     and v.day >= (now() at time zone 'utc')::date - ${days}::int), 0) as views,
        (select count(*) from booking b
          where b.booking_page_id = ${pageId}
            and b.state <> 'rescheduled'
            and b.created_at >= now() - ${`${days} days`}::interval) as booked,
        (select count(*) from booking b
          where b.booking_page_id = ${pageId}
            and b.state = 'cancelled'
            and b.created_at >= now() - ${`${days} days`}::interval) as cancelled`)

    const views = Number(row?.views ?? 0)
    const booked = Number(row?.booked ?? 0)
    return {
      views,
      booked,
      cancelled: Number(row?.cancelled ?? 0),
      conversion: views > 0 ? Math.round((booked / views) * 1000) / 10 : null,
      sinceDays: days,
    }
  })

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** Everything one reminder needs to be written and addressed, read after the
 *  worker has already decided it is due. Null when the booking moved, was
 *  cancelled, or the reminder was deleted between the two. */
export type ReminderTarget = {
  bookingId: string
  page: BookingPageConfig
  reminder: BookingReminder
  hostUserId: string
  hostName: string
  hostEmail: string
  contactId: string | null
  attendeeName: string
  attendeeEmail: string
  attendeeTimezone: string
  startsAt: Date
  endsAt: Date
  conferenceUrl: string | null
  companyName: string | null
  rescheduleToken: string
  cancelToken: string
}

export const readReminderTarget = async (
  ctx: AccountContext,
  input: { bookingId: string; reminderId: string },
): Promise<ReminderTarget | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{
      booking_page_id: string
      host_user_id: string
      host_name: string
      host_email: string
      contact_id: string | null
      attendee_name: string
      attendee_email: string
      attendee_timezone: string
      starts_at: string
      ends_at: string
      conference_url: string | null
      company_name: string | null
      reschedule_token: string
      cancel_token: string
      amount: number
      unit: ReminderUnit
    }>(sql`
      select b.booking_page_id, b.host_user_id, u.name as host_name, u.email as host_email,
             b.contact_id, b.attendee_name, b.attendee_email, b.attendee_timezone,
             b.starts_at, b.ends_at, b.conference_url, co.name as company_name,
             b.reschedule_token, b.cancel_token, r.amount, r.unit
        from booking b
        join user_account u on u.id = b.host_user_id
        join booking_reminder r on r.id = ${input.reminderId}
        left join company co on co.id = b.company_id
       where b.id = ${input.bookingId}
         and b.state = 'confirmed'
         and r.booking_page_id = b.booking_page_id
       limit 1`)
    if (!row) return null

    const page = await readConfig(tx, row.booking_page_id)
    if (!page) return null

    return {
      bookingId: input.bookingId,
      page,
      reminder: { id: input.reminderId, amount: Number(row.amount), unit: row.unit },
      hostUserId: row.host_user_id,
      hostName: row.host_name,
      hostEmail: row.host_email,
      contactId: row.contact_id,
      attendeeName: row.attendee_name,
      attendeeEmail: row.attendee_email,
      attendeeTimezone: row.attendee_timezone,
      startsAt: new Date(row.starts_at),
      endsAt: new Date(row.ends_at),
      conferenceUrl: row.conference_url,
      companyName: row.company_name,
      rescheduleToken: row.reschedule_token,
      cancelToken: row.cancel_token,
    }
  })

/** Claims the reminder before it is sent, not after: the primary key is what makes
 *  two workers racing send one mail, and a row written afterwards leaves the gap
 *  the key exists to close. False means somebody else has it. */
export const claimReminder = async (
  ctx: AccountContext,
  input: { bookingId: string; reminderId: string },
): Promise<boolean> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ booking_id: string }>(sql`
      insert into booking_reminder_sent (account_id, booking_id, reminder_id)
      values (${ctx.accountId}, ${input.bookingId}, ${input.reminderId})
      on conflict do nothing
      returning booking_id`)
    return rows.length > 0
  })

/** Undoes the claim when the send never happened, so the next tick tries again
 *  rather than the meeting passing in silence. */
export const releaseReminder = async (
  ctx: AccountContext,
  input: { bookingId: string; reminderId: string },
): Promise<void> => {
  await withAccount(ctx, (tx) =>
    tx.execute(sql`
      delete from booking_reminder_sent
       where booking_id = ${input.bookingId} and reminder_id = ${input.reminderId}`),
  )
}
