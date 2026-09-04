import { sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import { randomToken } from '../internal/crypto.ts'
import { recordActivity } from './activity.ts'
import { readAttribution, type AttributionInput } from './attribution.ts'
import { assertCanWrite, type WorkspaceContext } from './context.ts'
import { readSchema, type FormField } from './form-schema.ts'
import { emailFrom, validateAnswers, type FieldError } from './form-validate.ts'
import { publicEdgeContext } from './forms.ts'
import { isUuid, mutate, withWorkspace, writeAudit, type Tx } from './index.ts'
import { mapAnswersToColumns, upsertCapturedPerson } from './people.ts'
import { aliasVisitor } from './stitch.ts'
import {
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

export type BookingKind = 'one_on_one' | 'round_robin'
export type BookingLocation = 'zoom' | 'google_meet' | 'phone' | 'custom'
export type BookingState = 'confirmed' | 'cancelled' | 'rescheduled'

/** What a visitor is allowed to know about a page. Deliberately without the
 *  templates: an event title is internal and can name a deal. */
export type PublicBookingPage = {
  workspaceId: string
  workspaceSlug: string
  workspaceName: string
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
  workspace_id: string
  workspace_slug: string
  workspace_name: string
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

/** The one question the public edge asks before it has a workspace, through the
 *  same security-definer path a form uses. There is no route from here to a
 *  record. */
export const publicBookingPage = async (
  workspaceSlug: string,
  slug: string,
): Promise<PublicBookingPage | null> => {
  const rows = await appDb.execute<PublicPageRow>(
    sql`select * from rawr.public_booking_page(${workspaceSlug}, ${slug})`,
  )
  const row = rows[0]
  if (!row) return null
  return {
    workspaceId: row.workspace_id,
    workspaceSlug: row.workspace_slug,
    workspaceName: row.workspace_name,
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

/** Everything about a page, including the templates. Read under a workspace scope,
 *  so this is the shape the confirmation path and the admin screens use. */
export type BookingPageConfig = PublicBookingPage & {
  ownerId: string | null
  titleTpl: string
  descriptionTpl: string
  companyFallback: string
}

const PAGE_COLUMNS = sql`
  p.workspace_id, w.slug as workspace_slug, w.name as workspace_name, p.id as booking_page_id,
  p.slug, p.name, p.kind, p.owner_id, p.duration_minutes, p.buffer_before_minutes,
  p.buffer_after_minutes, p.min_notice_minutes, p.max_horizon_days, p.granularity_minutes,
  p.location, p.location_detail, p.title_tpl, p.description_tpl, p.company_fallback,
  p.questions, p.is_active, p.redirect_url, p.confirmation_copy,
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
}

const toConfig = (row: ConfigRow): BookingPageConfig => ({
  workspaceId: row.workspace_id,
  workspaceSlug: row.workspace_slug,
  workspaceName: row.workspace_name,
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
})

const readConfig = async (tx: Tx, pageId: string): Promise<BookingPageConfig | null> => {
  const [row] = await tx.execute<ConfigRow>(sql`
    select ${PAGE_COLUMNS} from booking_page p
      join workspace w on w.id = p.workspace_id
     where p.id = ${pageId} limit 1`)
  return row ? toConfig(row) : null
}

export const readBookingPage = async (
  ctx: WorkspaceContext,
  pageId: string,
): Promise<BookingPageConfig | null> =>
  isUuid(pageId) ? withWorkspace(ctx, (tx) => readConfig(tx, pageId)) : null

// ---------------------------------------------------------------------------
// Hosts and availability
// ---------------------------------------------------------------------------

export type HostAvailability = {
  userId: string
  name: string
  email: string
  weight: number
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
  ctx: WorkspaceContext,
  pageId: string,
  window: { from: Date; to: Date },
): Promise<HostAvailability[]> =>
  withWorkspace(ctx, async (tx) => {
    const hosts = await tx.execute<HostRow>(sql`
      select h.user_id, u.name, u.email, h.weight, h.last_assigned_at,
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
      tx.execute<{ host_user_id: string; starts_at: Date | string; ends_at: Date | string }>(sql`
        select host_user_id, starts_at, ends_at
          from booking
         where host_user_id in (${idList(ids)}) and state = 'confirmed'
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
      const list = busyByUser.get(row.host_user_id) ?? []
      list.push({ start: new Date(row.starts_at), end: new Date(row.ends_at) })
      busyByUser.set(row.host_user_id, list)
    }

    const countByUser = new Map(counts.map((row) => [row.host_user_id, Number(row.n)]))

    return hosts.map((host) => ({
      userId: host.user_id,
      name: host.name,
      email: host.email,
      weight: host.weight,
      lastAssignedAt: asDate(host.last_assigned_at),
      timezone: host.timezone ?? 'America/Los_Angeles',
      weekly: readWeekly(host.weekly),
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
  if (Object.keys(readWeekly(host.weekly)).length === 0) {
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
 *  timezone. Then the union across hosts, because a round robin offers a slot if
 *  anybody can take it. A hold reserves capacity rather than the slot itself, so on
 *  a page with three free hosts it takes three holds to close an hour. */
export const computeOffer = (input: OfferInput): Offer => {
  const byInstant = new Map<number, string[]>()
  const problems: string[] = []

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
    if (hostUserIds.length <= held) continue
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
  ctx: WorkspaceContext,
  pageId: string,
  window: { from: Date; to: Date },
): Promise<Map<number, number>> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx.execute<{ starts_at: Date | string; n: string }>(sql`
      select starts_at, count(*) as n from booking_hold
       where booking_page_id = ${pageId} and expires_at > now()
         and starts_at >= ${ts(window.from)} and starts_at < ${ts(window.to)}
       group by starts_at`)
    return new Map(rows.map((row) => [new Date(row.starts_at).getTime(), Number(row.n)]))
  })

export const placeHold = async (
  workspaceId: string,
  pageId: string,
  startsAt: Date,
): Promise<{ token: string; expiresAt: Date }> => {
  const ctx = publicEdgeContext(workspaceId)
  const token = randomToken(18)
  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000)
  await withWorkspace(ctx, async (tx) => {
    // Expired holds are cleared on the way past rather than by a job: the only
    // query that cares is this one, and it is the only writer.
    await tx.execute(sql`delete from booking_hold where expires_at < now() - interval '1 hour'`)
    await tx.execute(sql`
      insert into booking_hold (workspace_id, booking_page_id, starts_at, token, expires_at)
      values (${workspaceId}, ${pageId}, ${ts(startsAt)}, ${token}, ${ts(expiresAt)})`)
  })
  return { token, expiresAt }
}

export const releaseHold = async (workspaceId: string, token: string): Promise<void> => {
  await withWorkspace(publicEdgeContext(workspaceId), (tx) =>
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
  /** Non-fatal. A Zoom outage lands here; the meeting still happens. F2 §4. */
  warnings: string[]
}

export type ProvisionRequest = {
  page: BookingPageConfig
  host: { userId: string; name: string; email: string; calendarId: string; provider: 'google' | 'dev' }
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

export type ConfirmResult = {
  bookingId: string
  hostUserId: string
  hostName: string
  hostEmail: string
  startsAt: Date
  endsAt: Date
  contactId: string | null
  companyId: string | null
  conferenceUrl: string | null
  cancelToken: string
  rescheduleToken: string
  warnings: string[]
  errors?: FieldError[] | undefined
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
  ctx: WorkspaceContext,
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

  return withWorkspace(ctx, async (tx) => {
    // Serialises every attempt on this page and this instant, so two visitors
    // racing for the last slot are resolved rather than both being told yes. The
    // partial unique index on (host, starts_at) is the backstop underneath it.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`${input.page.bookingPageId}|${input.startsAt.toISOString()}`}, 0))`)

    const candidateIds = hosts.map((host) => host.userId)
    if (candidateIds.length === 0) throw new SlotGoneError()

    // Rawr's own commitments, re-read now rather than trusted from the page load.
    // Overlap, not equality: a sixty minute meeting at ten blocks a slot at half past.
    const taken = await tx.execute<{ host_user_id: string }>(sql`
      select host_user_id from booking
       where state = 'confirmed' and host_user_id in (${idList(candidateIds)})
         and starts_at < ${ts(endsAt)} and ends_at > ${ts(input.startsAt)}`)
    const busy = new Set(taken.map((row) => row.host_user_id))

    const free = hosts.filter((host) => !busy.has(host.userId))
    if (free.length === 0) throw new SlotGoneError()

    const chosenId = assignHost(
      free.map((host) => ({
        userId: host.userId,
        weight: host.weight,
        lastAssignedAt: host.lastAssignedAt,
        recentAssignments: host.recentAssignments,
      })),
      `${input.startsAt.toISOString()}|${email.toLowerCase()}`,
    )
    const host = free.find((candidate) => candidate.userId === chosenId)
    if (!host) throw new SlotGoneError()

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
      startsAt: input.startsAt,
      endsAt,
      attendee: { name, email, timezone: input.attendeeTimezone },
      answers,
      companyName,
      contactId: linked.contactId,
      tokens: { cancel: cancelToken, reschedule: rescheduleToken },
    })

    const [row] = await tx.execute<{ id: string }>(sql`
      insert into booking (workspace_id, booking_page_id, host_user_id, contact_id, company_id,
                           starts_at, ends_at, attendee_timezone, attendee_name, attendee_email,
                           answers, conference_url, conference_ref, calendar_event_id, calendar_id,
                           state, reschedule_of, cancel_token, reschedule_token)
      values (${ctx.workspaceId}, ${input.page.bookingPageId}, ${host.userId},
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

    await tx.execute(sql`
      update booking_host set last_assigned_at = now()
       where booking_page_id = ${input.page.bookingPageId} and user_id = ${host.userId}`)

    if (input.holdToken) {
      await tx.execute(sql`delete from booking_hold where token = ${input.holdToken}`)
    }

    if (input.rescheduleOf) {
      await tx.execute(sql`
        update booking set state = 'rescheduled', updated_at = now()
         where id = ${input.rescheduleOf} and state = 'confirmed'`)
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
      hostName: host.name,
      hostEmail: host.email,
      startsAt: input.startsAt,
      endsAt,
      contactId: linked.contactId,
      companyId: linked.companyId,
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
  hostName: '',
  hostEmail: '',
  startsAt: input.startsAt,
  endsAt: new Date(input.startsAt.getTime() + input.page.durationMinutes * 60_000),
  contactId: null,
  companyId: null,
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
  workspaceId: string
  bookingPageId: string
  pageName: string
  pageSlug: string
  workspaceSlug: string
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
  workspace_id: string
  booking_page_id: string
  page_name: string
  page_slug: string
  workspace_slug: string
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
  b.id, b.workspace_id, b.booking_page_id, p.name as page_name, p.slug as page_slug,
  w.slug as workspace_slug, b.host_user_id, u.name as host_name, u.email as host_email,
  b.contact_id, b.company_id, b.starts_at, b.ends_at, b.attendee_name, b.attendee_email,
  b.attendee_timezone, b.answers, b.conference_url, b.conference_ref, b.calendar_event_id,
  b.calendar_id, b.state, b.cancel_token, b.reschedule_token, b.cancel_reason`

const BOOKING_JOINS = sql`
  from booking b
  join booking_page p on p.id = b.booking_page_id
  join workspace w on w.id = b.workspace_id
  join user_account u on u.id = b.host_user_id`

const toBooking = (row: BookingRow): BookingRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  bookingPageId: row.booking_page_id,
  pageName: row.page_name,
  pageSlug: row.page_slug,
  workspaceSlug: row.workspace_slug,
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
  ctx: WorkspaceContext,
  id: string,
): Promise<BookingRecord | null> =>
  withWorkspace(ctx, async (tx) => {
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
  ctx: WorkspaceContext,
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
  const rows = await appDb.execute<{ workspace_id: string; booking_id: string }>(
    sql`select * from rawr.booking_for_token(${purpose}, ${token})`,
  )
  const found = rows[0]
  if (!found) return null
  return readBooking(publicEdgeContext(found.workspace_id), found.booking_id)
}

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

export type Withdrawn = { alreadyDone: boolean; booking: BookingRecord }

/** Idempotent by design: clicking cancel twice cancels once and reports the same
 *  thing both times, because a person who is not sure it worked will click again.
 *  Removing the calendar event is the caller's job and is also idempotent. */
export const cancelBooking = async (
  ctx: WorkspaceContext,
  id: string,
  input: { reason?: string | null; by: 'attendee' | 'host' } = { by: 'host' },
): Promise<Withdrawn> => {
  const existing = await readBooking(ctx, id)
  if (!existing) throw new Error('That booking no longer exists.')
  if (existing.state !== 'confirmed') return { alreadyDone: true, booking: existing }

  return mutate<Withdrawn>(ctx, 'booking', async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      update booking set state = 'cancelled', cancelled_at = now(), updated_at = now(),
                         cancel_reason = ${input.reason ?? null}
       where id = ${id} and state = 'confirmed'
       returning id`)

    // Lost the race with another click. The first one did the work.
    if (updated.length === 0) {
      return {
        result: { alreadyDone: true, booking: { ...existing, state: 'cancelled' as BookingState } },
        audit: { entity: 'booking', entityId: id, action: 'cancel', after: { noop: true } },
      }
    }

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
  ctx: WorkspaceContext,
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

  return withWorkspace(ctx, async (tx) => {
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
             b.starts_at, b.ends_at, b.state, b.contact_id, b.conference_url
        from booking b
        join booking_page p on p.id = b.booking_page_id
        join user_account u on u.id = b.host_user_id
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
