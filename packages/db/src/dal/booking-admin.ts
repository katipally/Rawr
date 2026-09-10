import { sql } from 'drizzle-orm'
import { decryptToken, encryptToken } from '../internal/crypto.ts'
import { assertCanWrite, ForbiddenError, isAdmin, type AccountContext } from './context.ts'
import { assertSchemaIsUsable } from './form-schema.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import {
  readQuestions,
  type BookingKind,
  type BookingLocation,
  type BookingPageConfig,
} from './bookings.ts'
import { DEFAULT_WEEKLY, isKnownTimezone, readRanges, readWeekly, type TimeRange, type WeeklyRules } from './slots.ts'

/** The admin half of F2: pages, who hosts them, working hours, and the calendar
 *  connections everything else depends on.
 *
 *  One rule runs through all of it. A round robin page belongs to the account and
 *  is an admin's to shape; a one-on-one page is somebody's own link and is theirs,
 *  with no admin rights required. F2 §6. That is finer than the four object-level
 *  roles can express, so it is checked here, in the layer, and not by hiding a
 *  button. */

const assertOwnPageOrAdmin = (ctx: AccountContext, ownerId: string | null): void => {
  if (isAdmin(ctx)) return
  if (ownerId && ownerId === ctx.actorId) return
  throw new ForbiddenError('account', 'change a shared booking page')
}

const assertOwnScheduleOrAdmin = (ctx: AccountContext, userId: string): void => {
  if (isAdmin(ctx) || ctx.actorId === userId) return
  throw new ForbiddenError('account', "change another person's availability")
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export type BookingPageSummary = {
  id: string
  slug: string
  name: string
  kind: BookingKind
  ownerId: string | null
  ownerName: string | null
  durationMinutes: number
  location: BookingLocation
  isActive: boolean
  hostCount: number
  upcoming: number
  /** Hosts on the page with no usable calendar. A number an admin can see at a
   *  glance beats a page that quietly offers nothing. */
  unhealthyHosts: number
  /** Active hosts who have working hours set. Zero means the page offers nothing
   *  however healthy every calendar is. */
  hostsWithHours: number
}

/** Shared pages, plus the person's own links. Somebody else's personal link is not
 *  listed, because it is theirs. */
export const listBookingPages = async (ctx: AccountContext): Promise<BookingPageSummary[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      slug: string
      name: string
      kind: BookingKind
      owner_id: string | null
      owner_name: string | null
      duration_minutes: number
      location: BookingLocation
      is_active: boolean
      host_count: string
      upcoming: string
      unhealthy: string
      hosts_with_hours: string
    }>(sql`
      select p.id, p.slug, p.name, p.kind, p.owner_id, o.name as owner_name,
             p.duration_minutes, p.location, p.is_active,
             count(distinct h.user_id) filter (where h.is_active) as host_count,
             count(distinct b.id) filter (where b.state = 'confirmed' and b.starts_at >= now()) as upcoming,
             count(distinct h.user_id) filter (
               where h.is_active and (g.state is null or g.state <> 'connected')
             ) as unhealthy,
             -- An empty weekly map offers no times, so a page whose every host has
             -- one is published and unbookable. Counted here rather than read per
             -- row, which would be a query per page on a list.
             count(distinct h.user_id) filter (
               where h.is_active and a.weekly is not null and a.weekly <> '{}'::jsonb
             ) as hosts_with_hours
        from booking_page p
        left join user_account o on o.id = p.owner_id
        left join booking_host h on h.booking_page_id = p.id
        left join calendar_grant g on g.user_id = h.user_id
        left join availability a on a.user_id = h.user_id and a.account_id = p.account_id
        left join booking b on b.booking_page_id = p.id
       where p.kind <> 'one_on_one' or p.owner_id = ${ctx.actorId}
       group by p.id, o.name
       order by p.kind, p.name`)

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      durationMinutes: row.duration_minutes,
      location: row.location,
      isActive: row.is_active,
      hostCount: Number(row.host_count),
      upcoming: Number(row.upcoming),
      unhealthyHosts: Number(row.unhealthy),
      hostsWithHours: Number(row.hosts_with_hours),
    }))
  })

export type SaveBookingPage = {
  id?: string | null | undefined
  slug: string
  name: string
  kind: BookingKind
  /** Ignored for a round robin. For a one-on-one it defaults to the person saving,
   *  and only an admin may set it to somebody else. */
  ownerId?: string | null | undefined
  durationMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minNoticeMinutes: number
  maxHorizonDays: number
  granularityMinutes: number
  location: BookingLocation
  locationDetail?: string | null | undefined
  titleTpl: string
  descriptionTpl: string
  companyFallback: string
  questions: unknown
  isActive: boolean
  redirectUrl?: string | null | undefined
  confirmationCopy?: string | null | undefined
  /** Shared pages only. Left undefined the host list is untouched. `isRequired`
   *  is read on a collective and ignored elsewhere, where each host stands alone. */
  hosts?: { userId: string; weight: number; isRequired?: boolean }[] | undefined
}

/** Creates or updates a page and, for a round robin, its host list in the same
 *  transaction. A page that cannot be published is refused here rather than
 *  discovered by a visitor looking at an empty calendar. */
export const saveBookingPage = async (
  ctx: AccountContext,
  input: SaveBookingPage,
): Promise<string> => {
  assertCanWrite(ctx, 'booking_page')

  if (!SLUG.test(input.slug)) {
    throw new Error(
      'A booking link can use lowercase letters, numbers and hyphens only, and cannot start or end with a hyphen.',
    )
  }
  if (!input.name.trim()) throw new Error('A booking page needs a name.')
  if (!input.titleTpl.trim()) throw new Error('The event title template cannot be empty.')
  if ((input.location === 'phone' || input.location === 'custom') && !input.locationDetail?.trim()) {
    throw new Error(
      input.location === 'phone'
        ? 'A phone meeting needs the number to call.'
        : 'A custom location needs the joining instructions.',
    )
  }

  // Same parser and the same usability rules as a form, so a booking question
  // cannot be something a form would have refused. Asserted only when there are
  // any: a page with no extra questions is the normal case, because the name and
  // the address are asked regardless.
  const questions = readQuestions(input.questions)
  if (questions.length > 0) assertSchemaIsUsable(questions)

  const ownerId =
    input.kind === 'one_on_one'
      ? isAdmin(ctx)
        ? (input.ownerId ?? ctx.actorId)
        : ctx.actorId
      : null

  if (input.kind === 'one_on_one' && !ownerId) {
    throw new Error('A personal booking link needs an owner, and this request has no signed-in user.')
  }
  if (input.kind !== 'one_on_one' && !isAdmin(ctx)) {
    throw new ForbiddenError('account', 'create or change a shared booking page')
  }
  // A collective is the intersection of its required hosts, so with none of them
  // it offers nothing at all. Refused here rather than discovered by a visitor
  // looking at an empty calendar.
  if (input.kind === 'collective' && input.hosts && !input.hosts.some((host) => host.isRequired !== false)) {
    throw new Error('A collective page needs at least one required host.')
  }

  return mutate(ctx, 'booking_page', async (tx) => {
    const before = input.id ? await readPageForAudit(tx, input.id) : null
    if (input.id) {
      if (!before) throw new Error('That booking page no longer exists.')
      assertOwnPageOrAdmin(ctx, before.owner_id)
      // Changing a personal link into a shared one, or the reverse, would move it
      // between two different permission models with live bookings attached.
      // Personal and shared are two different permission models with live
      // bookings attached, so that boundary is not crossed. Round robin and
      // collective are both shared and differ only in how availability is
      // combined, so switching between them is an ordinary edit.
      if ((before.kind === 'one_on_one') !== (input.kind === 'one_on_one')) {
        throw new Error(
          'A personal link and a shared page are different kinds of page. Create the other kind rather than converting this one.',
        )
      }
    }

    const hosts =
      input.kind === 'one_on_one' && ownerId
        ? [{ userId: ownerId, weight: 1 }]
        : (input.hosts ?? null)

    if (input.isActive && hosts !== null && hosts.length === 0) {
      throw new Error('A booking page with no hosts cannot be published. Add a host or leave it off.')
    }

    const [row] = await tx.execute<{ id: string }>(sql`
      insert into booking_page (
        id, account_id, slug, name, kind, owner_id, duration_minutes,
        buffer_before_minutes, buffer_after_minutes, min_notice_minutes, max_horizon_days,
        granularity_minutes, location, location_detail, title_tpl, description_tpl,
        company_fallback, questions, is_active, redirect_url, confirmation_copy)
      values (
        ${input.id ?? sql`gen_random_uuid()`}, ${ctx.accountId}, ${input.slug}, ${input.name.trim()},
        ${input.kind}, ${ownerId}, ${input.durationMinutes}, ${input.bufferBeforeMinutes},
        ${input.bufferAfterMinutes}, ${input.minNoticeMinutes}, ${input.maxHorizonDays},
        ${input.granularityMinutes}, ${input.location}, ${input.locationDetail ?? null},
        ${input.titleTpl}, ${input.descriptionTpl}, ${input.companyFallback},
        ${JSON.stringify(questions)}::jsonb, ${input.isActive}, ${input.redirectUrl ?? null},
        ${input.confirmationCopy ?? null})
      on conflict (id) do update set
        slug = excluded.slug, name = excluded.name, duration_minutes = excluded.duration_minutes,
        buffer_before_minutes = excluded.buffer_before_minutes,
        buffer_after_minutes = excluded.buffer_after_minutes,
        min_notice_minutes = excluded.min_notice_minutes,
        max_horizon_days = excluded.max_horizon_days,
        granularity_minutes = excluded.granularity_minutes,
        location = excluded.location, location_detail = excluded.location_detail,
        title_tpl = excluded.title_tpl, description_tpl = excluded.description_tpl,
        company_fallback = excluded.company_fallback, questions = excluded.questions,
        is_active = excluded.is_active, redirect_url = excluded.redirect_url,
        confirmation_copy = excluded.confirmation_copy, updated_at = now()
      returning id`)

    if (!row) throw new Error('The booking page could not be saved.')
    if (hosts) await replaceHosts(tx, ctx, row.id, hosts)

    return {
      result: row.id,
      audit: {
        entity: 'booking_page',
        entityId: row.id,
        action: input.id ? 'update' : 'create',
        before,
        after: { slug: input.slug, name: input.name, kind: input.kind, isActive: input.isActive },
      },
    }
  })
}

const readPageForAudit = async (
  tx: Tx,
  id: string,
): Promise<{ owner_id: string | null; kind: BookingKind; slug: string; name: string } | null> => {
  const [row] = await tx.execute<{
    owner_id: string | null
    kind: BookingKind
    slug: string
    name: string
  }>(sql`select owner_id, kind, slug, name from booking_page where id = ${id} limit 1`)
  return row ?? null
}

/** The host list is small and replaced whole, so a removed host cannot survive as
 *  a stale row. Deactivated rather than deleted, because their past bookings still
 *  point at them and the round robin's trailing window still counts them. */
const replaceHosts = async (
  tx: Tx,
  ctx: AccountContext,
  pageId: string,
  hosts: { userId: string; weight: number; isRequired?: boolean }[],
): Promise<void> => {
  const wanted = hosts.filter((host) => host.userId)
  const ids = wanted.map((host) => host.userId)

  // A host has to be a member of this account. Row level security makes the
  // membership table tenant-scoped, so an id from another tenant simply is not here.
  const members = ids.length
    ? await tx.execute<{ user_id: string }>(
        sql`select user_id from membership
             where user_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
      )
    : []
  const allowed = new Set(members.map((row) => row.user_id))
  const missing = ids.filter((id) => !allowed.has(id))
  if (missing.length > 0) {
    throw new Error('One of the hosts is not a member of this account.')
  }

  await tx.execute(sql`
    update booking_host set is_active = false
     where booking_page_id = ${pageId}
       and ${ids.length ? sql`user_id not in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql`true`}`)

  for (const host of wanted) {
    const weight = Math.min(Math.max(Math.trunc(host.weight) || 1, 1), 100)
    const isRequired = host.isRequired !== false
    await tx.execute(sql`
      insert into booking_host (account_id, booking_page_id, user_id, weight, is_required, is_active)
      values (${ctx.accountId}, ${pageId}, ${host.userId}, ${weight}, ${isRequired}, true)
      on conflict (account_id, booking_page_id, user_id)
        do update set weight = excluded.weight, is_required = excluded.is_required, is_active = true`)
  }
}

export type PageHostRow = {
  userId: string
  name: string
  email: string
  weight: number
  isRequired: boolean
  isActive: boolean
  grantState: string
  grantError: string | null
  timezone: string | null
}

export const readPageHostList = async (
  ctx: AccountContext,
  pageId: string,
): Promise<PageHostRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      user_id: string
      name: string
      email: string
      weight: number
      is_required: boolean
      is_active: boolean
      grant_state: string | null
      last_error: string | null
      timezone: string | null
    }>(sql`
      select h.user_id, u.name, u.email, h.weight, h.is_required, h.is_active,
             g.state as grant_state, g.last_error, a.timezone
        from booking_host h
        join user_account u on u.id = h.user_id
        left join calendar_grant g on g.user_id = h.user_id
        left join availability a on a.user_id = h.user_id
       where h.booking_page_id = ${pageId}
       order by u.name`)

    return rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      weight: row.weight,
      isRequired: row.is_required,
      isActive: row.is_active,
      grantState: row.grant_state ?? 'unconfigured',
      grantError: row.last_error,
      timezone: row.timezone,
    }))
  })

export const setPageActive = async (
  ctx: AccountContext,
  pageId: string,
  isActive: boolean,
): Promise<void> => {
  assertCanWrite(ctx, 'booking_page')
  await mutate(ctx, 'booking_page', async (tx) => {
    const before = await readPageForAudit(tx, pageId)
    if (!before) throw new Error('That booking page no longer exists.')
    assertOwnPageOrAdmin(ctx, before.owner_id)

    if (isActive) {
      const [count] = await tx.execute<{ n: string }>(
        sql`select count(*) as n from booking_host where booking_page_id = ${pageId} and is_active`,
      )
      if (Number(count?.n ?? 0) === 0) {
        throw new Error('A booking page with no active hosts cannot be published.')
      }
    }

    await tx.execute(
      sql`update booking_page set is_active = ${isActive}, updated_at = now() where id = ${pageId}`,
    )
    return {
      result: undefined,
      audit: {
        entity: 'booking_page',
        entityId: pageId,
        action: isActive ? 'publish' : 'unpublish',
        before: { isActive: !isActive },
        after: { isActive },
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type Schedule = {
  userId: string
  timezone: string
  weekly: WeeklyRules
  overrides: { day: string; isUnavailable: boolean; blocks: TimeRange[]; note: string | null }[]
}

/** The zone a person's times are written in, which Settings calls "Times are
 *  shown to you in". Stored on their availability row, because the working hours
 *  it holds are wall-clock times and needed a zone first; a person has one clock,
 *  so the two are the same answer.
 *
 *  UTC when nothing is stored rather than a guess: a wrong zone is a wrong time
 *  with no sign that it is wrong, and UTC at least reads as unset. The app seeds
 *  this from the browser the first time somebody opens it.
 *
 *  Read on every request, so it is one indexed lookup on the unique
 *  (account, user) key. */
/** Writes the zone a browser reports, once, for somebody who has never said.
 *
 *  Without it a new person reads every timestamp in UTC, which is worse than the
 *  browser guess this replaced. Only ever an insert: a stored zone is a choice,
 *  and a laptop carried to another country must not silently rewrite it. */
export const adoptTimezone = async (ctx: AccountContext, userId: string, timezone: string): Promise<boolean> => {
  if (!isKnownTimezone(timezone)) return false
  return withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      insert into availability (account_id, user_id, timezone, weekly)
      values (${ctx.accountId}, ${userId}, ${timezone}, '{}'::jsonb)
      on conflict (account_id, user_id) do nothing
      returning id`)
    return rows.length > 0
  })
}

export const displayTimezone = async (ctx: AccountContext, userId: string): Promise<string> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{ timezone: string }>(
      sql`select timezone from availability where user_id = ${userId} limit 1`,
    )
    return row?.timezone ?? 'UTC'
  })

export const readSchedule = async (ctx: AccountContext, userId: string): Promise<Schedule> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{ timezone: string; weekly: unknown }>(
      sql`select timezone, weekly from availability where user_id = ${userId} limit 1`,
    )
    const overrides = await tx.execute<{
      day: string
      is_unavailable: boolean
      blocks: unknown
      note: string | null
    }>(sql`
      select day::text as day, is_unavailable, blocks, note from availability_override
       where user_id = ${userId} and day >= current_date - 1
       order by day`)

    return {
      userId,
      timezone: row?.timezone ?? 'America/Los_Angeles',
      // A person who has never opened this screen still has working hours, so a
      // page is bookable the day it is created.
      weekly: row ? readWeekly(row.weekly) : DEFAULT_WEEKLY,
      overrides: overrides.map((override) => ({
        day: override.day,
        isUnavailable: override.is_unavailable,
        blocks: readRanges(override.blocks),
        note: override.note,
      })),
    }
  })

export const saveSchedule = async (
  ctx: AccountContext,
  input: { userId: string; timezone: string; weekly: unknown },
): Promise<void> => {
  assertCanWrite(ctx, 'availability')
  assertOwnScheduleOrAdmin(ctx, input.userId)
  if (!isKnownTimezone(input.timezone)) {
    throw new Error(`"${input.timezone}" is not a timezone this system recognises.`)
  }

  const weekly = readWeekly(input.weekly)
  for (const [weekday, ranges] of Object.entries(weekly)) {
    for (const [from, to] of ranges) {
      if (from === to) {
        throw new Error(`A window on weekday ${weekday} starts and ends at ${from}.`)
      }
    }
  }

  await mutate(ctx, 'availability', async (tx) => {
    const [before] = await tx.execute<{ timezone: string; weekly: unknown }>(
      sql`select timezone, weekly from availability where user_id = ${input.userId} limit 1`,
    )
    await tx.execute(sql`
      insert into availability (account_id, user_id, timezone, weekly)
      values (${ctx.accountId}, ${input.userId}, ${input.timezone}, ${JSON.stringify(weekly)}::jsonb)
      on conflict (account_id, user_id)
        do update set timezone = excluded.timezone, weekly = excluded.weekly, updated_at = now()`)

    return {
      result: undefined,
      audit: {
        entity: 'availability',
        entityId: input.userId,
        action: 'save',
        before: before ?? null,
        after: { timezone: input.timezone, weekly },
      },
    }
  })
}

export const saveOverride = async (
  ctx: AccountContext,
  input: {
    userId: string
    day: string
    isUnavailable: boolean
    blocks: unknown
    note?: string | null | undefined
  },
): Promise<void> => {
  assertCanWrite(ctx, 'availability')
  assertOwnScheduleOrAdmin(ctx, input.userId)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) {
    throw new Error('An override needs a date in YYYY-MM-DD form.')
  }
  const blocks = readRanges(input.blocks)
  if (!input.isUnavailable && blocks.length === 0) {
    throw new Error('A working-hours override needs at least one window, or mark the day unavailable.')
  }

  await mutate(ctx, 'availability', async (tx) => {
    await tx.execute(sql`
      insert into availability_override (account_id, user_id, day, is_unavailable, blocks, note)
      values (${ctx.accountId}, ${input.userId}, ${input.day}::date, ${input.isUnavailable},
              ${JSON.stringify(blocks)}::jsonb, ${input.note ?? null})
      on conflict (account_id, user_id, day)
        do update set is_unavailable = excluded.is_unavailable, blocks = excluded.blocks,
                      note = excluded.note`)
    return {
      result: undefined,
      audit: {
        entity: 'availability_override',
        // The person, not the day: audit_log.entity_id is a uuid, and the day is
        // what the change was about rather than what it identifies.
        entityId: input.userId,
        action: 'save',
        after: { day: input.day, isUnavailable: input.isUnavailable, blocks },
      },
    }
  })
}

export const clearOverride = async (
  ctx: AccountContext,
  input: { userId: string; day: string },
): Promise<void> => {
  assertCanWrite(ctx, 'availability')
  assertOwnScheduleOrAdmin(ctx, input.userId)
  await mutate(ctx, 'availability', async (tx) => {
    await tx.execute(sql`
      delete from availability_override
       where user_id = ${input.userId} and day = ${input.day}::date`)
    return {
      result: undefined,
      audit: {
        entity: 'availability_override',
        entityId: input.userId,
        action: 'clear',
        before: { day: input.day },
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Calendar grants
// ---------------------------------------------------------------------------

export type GrantSummary = {
  userId: string
  name: string
  email: string
  provider: 'google' | 'dev'
  calendarId: string
  state: string
  lastOkAt: Date | null
  lastError: string | null
  lastErrorAt: Date | null
  hasRefreshToken: boolean
}

export const listGrants = async (ctx: AccountContext): Promise<GrantSummary[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      user_id: string
      name: string
      email: string
      provider: 'google' | 'dev'
      calendar_id: string
      state: string
      last_ok_at: Date | string | null
      last_error: string | null
      last_error_at: Date | string | null
      has_refresh: boolean
    }>(sql`
      select g.user_id, u.name, u.email, g.provider, g.calendar_id, g.state,
             g.last_ok_at, g.last_error, g.last_error_at,
             (g.refresh_token_enc is not null) as has_refresh
        from calendar_grant g
        join user_account u on u.id = g.user_id
       order by u.name`)

    return rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      provider: row.provider,
      calendarId: row.calendar_id,
      state: row.state,
      lastOkAt: row.last_ok_at ? new Date(row.last_ok_at) : null,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at ? new Date(row.last_error_at) : null,
      hasRefreshToken: row.has_refresh,
    }))
  })

export type StoredGrant = {
  userId: string
  provider: 'google' | 'dev'
  calendarId: string
  state: 'unconfigured' | 'connected' | 'degraded' | 'revoked'
  accessToken: string | null
  refreshToken: string | null
  accessTokenExpiresAt: Date | null
  scope: string | null
}

/** Tokens come back decrypted, so this is the only function in the codebase that
 *  returns a live credential and it is called only by the provider client. */
export const readGrant = async (
  ctx: AccountContext,
  userId: string,
): Promise<StoredGrant | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{
      provider: 'google' | 'dev'
      calendar_id: string
      state: StoredGrant['state']
      access_token_enc: string | null
      refresh_token_enc: string | null
      access_token_expires_at: Date | string | null
      scope: string | null
    }>(sql`
      select provider, calendar_id, state, access_token_enc, refresh_token_enc,
             access_token_expires_at, scope
        from calendar_grant where user_id = ${userId} limit 1`)
    if (!row) return null

    return {
      userId,
      provider: row.provider,
      calendarId: row.calendar_id,
      state: row.state,
      accessToken: row.access_token_enc ? decryptToken(row.access_token_enc) : null,
      refreshToken: row.refresh_token_enc ? decryptToken(row.refresh_token_enc) : null,
      accessTokenExpiresAt: row.access_token_expires_at
        ? new Date(row.access_token_expires_at)
        : null,
      scope: row.scope,
    }
  })

/** Stores or refreshes a grant. A refresh token is only overwritten when a new one
 *  arrives: Google returns it on the first consent and not on later refreshes, so
 *  blindly writing null would break the connection on its first renewal. */
export const saveGrant = async (
  ctx: AccountContext,
  input: {
    userId: string
    provider: 'google' | 'dev'
    calendarId?: string
    accessToken?: string | null
    refreshToken?: string | null
    accessTokenExpiresAt?: Date | null
    scope?: string | null
  },
): Promise<void> => {
  assertCanWrite(ctx, 'calendar_grant')
  assertOwnScheduleOrAdmin(ctx, input.userId)

  // A raw template goes through postgres.js `unsafe`, which infers no types, so a
  // Date reaches the driver unserialised and the whole insert fails.
  const expiresAt = input.accessTokenExpiresAt?.toISOString() ?? null

  await mutate(ctx, 'calendar_grant', async (tx) => {
    await tx.execute(sql`
      insert into calendar_grant (account_id, user_id, provider, calendar_id, state,
                                  access_token_enc, refresh_token_enc, access_token_expires_at,
                                  scope, last_ok_at)
      values (${ctx.accountId}, ${input.userId}, ${input.provider},
              ${input.calendarId ?? 'primary'}, 'connected',
              ${input.accessToken ? encryptToken(input.accessToken) : null},
              ${input.refreshToken ? encryptToken(input.refreshToken) : null},
              ${expiresAt}::timestamptz, ${input.scope ?? null}, now())
      on conflict (account_id, user_id) do update set
        provider = excluded.provider,
        calendar_id = coalesce(${input.calendarId ?? null}, calendar_grant.calendar_id),
        state = 'connected',
        access_token_enc = excluded.access_token_enc,
        refresh_token_enc = coalesce(excluded.refresh_token_enc, calendar_grant.refresh_token_enc),
        access_token_expires_at = excluded.access_token_expires_at,
        scope = coalesce(excluded.scope, calendar_grant.scope),
        last_ok_at = now(), last_error = null, last_error_at = null, updated_at = now()`)

    return {
      result: undefined,
      audit: {
        entity: 'calendar_grant',
        entityId: input.userId,
        action: 'connect',
        // Never the token itself. An audit log is read by more people than a
        // credential store should be.
        after: { provider: input.provider, calendarId: input.calendarId ?? 'primary' },
      },
    }
  })
}

/** Which calendar the invitations land in. Separate from `saveGrant` because that
 *  one writes the tokens too: calling it to change only the destination would
 *  blank a live access token and take the connection down. */
export const setGrantCalendar = async (
  ctx: AccountContext,
  input: { userId: string; calendarId: string },
): Promise<void> => {
  assertCanWrite(ctx, 'calendar_grant')
  assertOwnScheduleOrAdmin(ctx, input.userId)

  await mutate(ctx, 'calendar_grant', async (tx) => {
    const [before] = await tx.execute<{ calendar_id: string }>(
      sql`select calendar_id from calendar_grant where user_id = ${input.userId} limit 1`,
    )
    if (!before) throw new Error('There is no calendar connected for that person.')

    await tx.execute(sql`
      update calendar_grant set calendar_id = ${input.calendarId}, updated_at = now()
       where user_id = ${input.userId}`)

    return {
      result: undefined,
      audit: {
        entity: 'calendar_grant',
        entityId: input.userId,
        action: 'update',
        before: { calendarId: before.calendar_id },
        after: { calendarId: input.calendarId },
      },
    }
  })
}

/** Called by the provider client when Google refuses. 'revoked' is terminal until
 *  the person reconnects; 'degraded' is a transient failure worth surfacing. Either
 *  way the host stops being offered rather than being treated as free. */
export const recordGrantFailure = async (
  ctx: AccountContext,
  input: { userId: string; error: string; revoked: boolean },
): Promise<void> => {
  await withAccount(ctx, (tx) =>
    tx.execute(sql`
      update calendar_grant
         set state = ${input.revoked ? 'revoked' : 'degraded'},
             last_error = ${input.error.slice(0, 500)}, last_error_at = now(), updated_at = now()
       where user_id = ${input.userId}`),
  )
}

export const disconnectGrant = async (ctx: AccountContext, userId: string): Promise<void> => {
  assertCanWrite(ctx, 'calendar_grant')
  assertOwnScheduleOrAdmin(ctx, userId)
  await mutate(ctx, 'calendar_grant', async (tx) => {
    await tx.execute(sql`
      update calendar_grant
         set state = 'revoked', access_token_enc = null, refresh_token_enc = null,
             access_token_expires_at = null, updated_at = now()
       where user_id = ${userId}`)
    return {
      result: undefined,
      audit: { entity: 'calendar_grant', entityId: userId, action: 'disconnect' },
    }
  })
}

/** Every page a person hosts, for their own profile screen. */
export const pagesHostedBy = async (
  ctx: AccountContext,
  userId: string,
): Promise<{ id: string; slug: string; name: string; kind: BookingKind; isActive: boolean }[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      slug: string
      name: string
      kind: BookingKind
      is_active: boolean
    }>(sql`
      select p.id, p.slug, p.name, p.kind, p.is_active
        from booking_page p
        join booking_host h on h.booking_page_id = p.id and h.is_active
       where h.user_id = ${userId}
       order by p.kind, p.name`)
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      isActive: row.is_active,
    }))
  })

export type { BookingPageConfig }
