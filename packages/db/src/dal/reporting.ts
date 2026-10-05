import { sql } from 'drizzle-orm'
import type { AccountContext } from './context.ts'
import { accountZone, withAccount } from './index.ts'
import { addDays, dayKey, zonedTimeToUtc } from './slots.ts'

/** B7. Six reports, each one question answered over a date range.
 *
 *  Two rules hold everywhere here. The range is capped at a year and a day, so no
 *  report can be asked to scan the whole table by putting 1970 in a URL. And every
 *  result is capped at 200 rows, because a chart with four hundred bars is not a
 *  report, it is a table nobody reads; anything longer belongs on a list screen
 *  with its own pagination.
 *
 *  Every query is a range scan over an index that already exists, grouped in the
 *  database rather than in Node. Reading a year of deals into memory to count them
 *  by week is how a reporting screen becomes the slowest page in the product. */

export type Range = { from: Date; to: Date }

export const MAX_DAYS = 366
export const MAX_ROWS = 200

const DAY_MS = 24 * 60 * 60 * 1000

/** Clamps whatever arrived to something answerable, rather than refusing. A range
 *  the wrong way round is a mistake in a link, not an attack, and the useful
 *  response is the range they meant.
 *
 *  Left to itself the range is the last thirty whole days in `zone`, today
 *  included: the account's own calendar, so that after 5 PM Pacific it does not
 *  end on a tomorrow nobody has reached. */
export const clampRange = (
  input: {
    from?: Date | string | null | undefined
    to?: Date | string | null | undefined
  },
  zone = 'UTC',
): Range => {
  const parse = (value: Date | string | null | undefined): Date | null => {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
    return new Date(value)
  }

  const midnight = (day: string) => zonedTimeToUtc(day, 0, zone)
  const to = parse(input.to) ?? midnight(addDays(dayKey(new Date(), zone), 1))
  const from = parse(input.from) ?? midnight(addDays(dayKey(new Date(to.getTime() - 1), zone), -29))
  const [start, end] = from.getTime() <= to.getTime() ? [from, to] : [to, from]
  const capped = end.getTime() - start.getTime() > MAX_DAYS * DAY_MS
    ? new Date(end.getTime() - MAX_DAYS * DAY_MS)
    : start
  return { from: capped, to: end }
}

/** The calendar day an instant falls on in `zone`. A bare `::date` reads it in the
 *  session's zone, which is UTC, and filed a 9:21 PM Pacific fill under tomorrow. */
const daily = (column: string, zone: string) => sql`(${sql.raw(column)} at time zone ${zone})::date`

/** Sunday-free weeks: `date_trunc('week')` is ISO, so a week always starts on a
 *  Monday whatever the server's locale thinks. */
const weekly = (column: string, zone: string) =>
  sql`date_trunc('week', ${sql.raw(column)} at time zone ${zone})::date`

/** Every bucket in the range, including the empty ones.
 *
 *  A `group by` over the rows returns only the buckets that have any, so a quiet
 *  fortnight vanished from the axis instead of being drawn flat, and the line
 *  closed the gap as though the weeks either side were adjacent. The calendar is
 *  generated here and the counts are joined onto it, so the shape of the chart is
 *  decided by the range asked for rather than by which days happened to be busy.
 *
 *  Bounded by the range clamp: 366 days, or 53 weeks. That is why these two are
 *  the queries with no MAX_ROWS on them. A `limit` on a calendar does not trim a
 *  chart, it silently ends it early — a year of submissions used to stop in
 *  August and look complete. */
const calendar = (range: Range, step: 'day' | 'week', zone: string) => {
  // `to` is exclusive, so the last bucket is the one holding the instant before
  // it: a range that ends at midnight does not draw the day that begins there.
  const first = sql`${range.from.toISOString()}::timestamptz at time zone ${zone}`
  const last = sql`(${range.to.toISOString()}::timestamptz - interval '1 microsecond') at time zone ${zone}`
  return step === 'week'
    ? sql`select generate_series(date_trunc('week', ${first}), date_trunc('week', ${last}), interval '1 week')::date as bucket`
    : sql`select generate_series((${first})::date, (${last})::date, interval '1 day')::date as bucket`
}

const bounds = (range: Range, column: string) =>
  sql`${sql.raw(column)} >= ${range.from.toISOString()}::timestamptz and ${sql.raw(column)} < ${range.to.toISOString()}::timestamptz`

/** The same range for a column that is already a day. Comparing a date with the
 *  range's instants reads the date as UTC midnight, which drops the first day of
 *  a range for anyone west of Greenwich. */
const dayBounds = (range: Range, column: string, zone: string) =>
  sql`${sql.raw(column)} >= (${range.from.toISOString()}::timestamptz at time zone ${zone})::date
      and ${sql.raw(column)} <= ((${range.to.toISOString()}::timestamptz - interval '1 microsecond') at time zone ${zone})::date`

// ------------------------------------------------------------------ pipeline

/** Money is reported one total per currency and never added across them:
 *  converting at today's rate would make last quarter's number move every
 *  morning. Largest first. */
export type Amounts = { currency: string; amount: number }[]

const amountsOf = (rows: { currency: string; amount: string | number }[] | null): Amounts =>
  (rows ?? []).map((row) => ({ currency: row.currency, amount: Number(row.amount) }))

export type PipelineReport = {
  /** Deals made each week, and deals closed each week: a deal is won in the week
   *  it was won, whenever it was made. */
  weeks: { week: string; created: number; won: number; lost: number }[]
  /** What the deals won over the range came to, per currency. */
  wonAmounts: Amounts
  /** One entry per stage of every pipeline, in pipeline then stage order. Two
   *  pipelines routinely name a stage the same thing, so the stage id is what
   *  identifies a row and the pipeline is what a reader groups by. Merging them
   *  on name alone reported a funnel that belonged to no pipeline at all. */
  funnel: {
    pipelineId: string
    pipeline: string
    stageId: string
    stage: string
    position: number
    deals: number
    amounts: Amounts
  }[]
  owners: { owner: string; open: number; won: number; wonAmounts: Amounts }[]
}

/** The deals that are closed now, each with when it closed: the last time a move
 *  put it in a stage (the stage_change every move writes), else the close date it
 *  was given, else when it was made, for a deal that was created already won.
 *
 *  A deal that closed inside the range has been written to since, so rows last
 *  touched before it began are skipped before the lookup rather than after: the
 *  lookup is one indexed probe per deal, and an account's history is mostly
 *  deals that closed long ago. */
const closedDeals = (range: Range, zone: string) => sql`
  select d.id, d.amount, d.currency, s.is_closed_won as won,
         coalesce(
           (select max(l.occurred_at) from activity_link l
             where l.entity_type = 'deal' and l.entity_id = d.id and l.type = 'stage_change'),
           d.close_date::timestamp at time zone ${zone},
           d.created_at) as closed_at
    from deal d
    join pipeline_stage s on s.id = d.stage_id and (s.is_closed_won or s.is_closed_lost)
   where d.deleted_at is null and d.updated_at >= ${range.from.toISOString()}::timestamptz`

/** What the pipeline did over the range: how many deals arrived each week, how
 *  many closed either way, where the open ones are sitting, and who holds them. */
export const pipelineReport = async (ctx: AccountContext, range: Range): Promise<PipelineReport> =>
  withAccount(ctx, async (tx) => {
    const zone = await accountZone(ctx, tx)

    const weeks = await tx.execute<{ week: string; created: number; won: number; lost: number }>(sql`
      with weeks as (${calendar(range, 'week', zone)}),
      made as (
        select ${weekly('d.created_at', zone)} as week, count(*)::int as n
          from deal d
         where d.deleted_at is null and ${bounds(range, 'd.created_at')}
         group by 1
      ),
      closed as (${closedDeals(range, zone)}),
      shut as (
        select ${weekly('c.closed_at', zone)} as week,
               count(*) filter (where c.won)::int as won,
               count(*) filter (where not c.won)::int as lost
          from closed c
         where ${bounds(range, 'c.closed_at')}
         group by 1
      )
      select w.bucket as week, coalesce(m.n, 0)::int as created,
             coalesce(x.won, 0)::int as won, coalesce(x.lost, 0)::int as lost
        from weeks w
        left join made m on m.week = w.bucket
        left join shut x on x.week = w.bucket
       order by w.bucket`)

    const won = await tx.execute<{ currency: string; amount: string }>(sql`
      with closed as (${closedDeals(range, zone)})
      select c.currency, sum(c.amount)::text as amount
        from closed c
       where c.won and ${bounds(range, 'c.closed_at')}
       group by c.currency
      having coalesce(sum(c.amount), 0) > 0
       order by sum(c.amount) desc`)

    const funnel = await tx.execute<{
      pipeline_id: string
      pipeline: string
      stage_id: string
      stage: string
      position: number
      deals: number
      amounts: { currency: string; amount: string }[]
    }>(sql`
      with per as (
        select d.stage_id, d.currency, count(*)::int as n, coalesce(sum(d.amount), 0) as amount
          from deal d
         where d.deleted_at is null and ${bounds(range, 'd.created_at')}
         group by 1, 2
      )
      select p.id as pipeline_id, p.name as pipeline,
             s.id as stage_id, s.name as stage, s.position::int as position,
             coalesce(sum(per.n), 0)::int as deals,
             coalesce(json_agg(json_build_object('currency', per.currency, 'amount', per.amount) order by per.amount desc)
                        filter (where per.amount > 0), '[]'::json) as amounts
        from pipeline_stage s
        join pipeline p on p.id = s.pipeline_id
        left join per on per.stage_id = s.id
       group by p.id, p.name, p.position, s.id, s.name, s.position
       order by p.position, p.name, s.position
       limit ${MAX_ROWS}`)

    const owners = await tx.execute<{
      owner: string
      open: number
      won: number
      won_amounts: { currency: string; amount: string }[]
    }>(sql`
      select o.owner, sum(o.open)::int as open, sum(o.won)::int as won,
             coalesce(json_agg(json_build_object('currency', o.currency, 'amount', o.won_amount) order by o.won_amount desc)
                        filter (where o.won_amount > 0), '[]'::json) as won_amounts
        from (
          select coalesce(u.name, u.email, 'Unassigned') as owner, d.currency,
                 count(*) filter (where not coalesce(s.is_closed_won, false) and not coalesce(s.is_closed_lost, false)) as open,
                 count(*) filter (where s.is_closed_won) as won,
                 coalesce(sum(d.amount) filter (where s.is_closed_won), 0) as won_amount
            from deal d
            left join pipeline_stage s on s.id = d.stage_id
            left join user_account u on u.id = d.owner_id
           where d.deleted_at is null and ${bounds(range, 'd.created_at')}
           group by 1, 2
        ) o
       group by o.owner
       order by sum(o.won) desc, sum(o.open) desc, o.owner
       limit ${MAX_ROWS}`)

    return {
      weeks: weeks.map((row) => ({
        week: String(row.week),
        created: Number(row.created),
        won: Number(row.won),
        lost: Number(row.lost),
      })),
      wonAmounts: amountsOf(won),
      funnel: funnel.map((row) => ({
        pipelineId: row.pipeline_id,
        pipeline: row.pipeline,
        stageId: row.stage_id,
        stage: row.stage,
        position: Number(row.position),
        deals: Number(row.deals),
        amounts: amountsOf(row.amounts),
      })),
      owners: owners.map((row) => ({
        owner: row.owner,
        open: Number(row.open),
        won: Number(row.won),
        wonAmounts: amountsOf(row.won_amounts),
      })),
    }
  })

// --------------------------------------------------------------------- forms

export type FormsReport = {
  days: { day: string; clean: number; held: number }[]
  forms: {
    /** Names are not unique: `form` is unique on its slug, so two forms may
     *  share a title and only the id tells them apart. */
    id: string
    form: string
    submissions: number
    held: number
    contacts: number
    deals: number
    /** Times the embed painted this form, through the consent-gated collector.
     *  Zero for a form only ever opened on its hosted page, and undercounted by
     *  whoever declined analytics, which is what a consent gate is for. */
    views: number
    /** Distinct pages it was painted on. */
    appearsOn: number
  }[]
}

/** Fills per day, and what each form actually produced.
 *
 *  Held submissions are counted separately rather than excluded: a form whose
 *  numbers dropped because the spam filter tightened looks identical to one nobody
 *  is filling in, unless both lines are on the chart. */
export const formsReport = async (ctx: AccountContext, range: Range): Promise<FormsReport> =>
  withAccount(ctx, async (tx) => {
    const zone = await accountZone(ctx, tx)
    const days = await tx.execute<{ day: string; clean: number; held: number }>(sql`
      with days as (${calendar(range, 'day', zone)})
      select c.bucket as day,
             count(s.id) filter (where s.spam_state = 'clean')::int as clean,
             count(s.id) filter (where s.spam_state <> 'clean')::int as held
        from days c
        left join form_submission s
          on ${daily('s.at', zone)} = c.bucket and ${bounds(range, 's.at')}
       group by c.bucket
       order by c.bucket`)

    // Views come from the form's own counter, which names no visitor and is
    // therefore not consent gated: a conversion rate built from the tracked
    // event alone would quietly omit everybody who declined analytics.
    //
    // Its own grouped scan rather than a join: joining a per-view table to a
    // per-submission one multiplies both counts, which is how a conversion rate
    // ends up over a hundred percent.
    const views = await tx.execute<{ form_id: string; views: number; pages: number }>(sql`
      select v.form_id::text as form_id,
             sum(v.views)::int as views,
             count(distinct v.page_path)::int as pages
        from form_view v
       where ${dayBounds(range, 'v.day', zone)}
       group by 1
       limit ${MAX_ROWS}`)
    const viewsByForm = new Map(views.map((row) => [String(row.form_id), row]))

    const forms = await tx.execute<{
      id: string
      form: string
      submissions: number
      held: number
      contacts: number
      deals: number
    }>(sql`
      -- distinct: the deal join repeats a submission once per later deal.
      select f.id, f.name as form,
             count(distinct s.id)::int as submissions,
             count(distinct s.id) filter (where s.spam_state <> 'clean')::int as held,
             count(distinct s.contact_id)::int as contacts,
             count(distinct d.id)::int as deals
        from form f
        join form_submission s on s.form_id = f.id and ${bounds(range, 's.at')}
        left join deal d on d.company_id = s.company_id and d.deleted_at is null
                        and d.created_at >= s.at and ${bounds(range, 'd.created_at')}
       group by f.id, f.name
       order by 2 desc
       limit ${MAX_ROWS}`)

    return {
      days: days.map((row) => ({ day: String(row.day), clean: Number(row.clean), held: Number(row.held) })),
      forms: forms.map((row) => {
        const seen = viewsByForm.get(String(row.id))
        return {
          id: String(row.id),
          form: row.form,
          submissions: Number(row.submissions),
          held: Number(row.held),
          contacts: Number(row.contacts),
          deals: Number(row.deals),
          views: Number(seen?.views ?? 0),
          appearsOn: Number(seen?.pages ?? 0),
        }
      }),
    }
  })

// ----------------------------------------------------------------- sequences

export type SequencesReport = {
  sequences: {
    sequence: string
    sent: number
    opened: number
    clicked: number
    replied: number
    bounced: number
  }[]
  mailboxes: { mailbox: string; sent: number; bounced: number; failed: number }[]
}

/** How outreach performed, per sequence and per mailbox.
 *
 *  Opens are counted from sends that were opened at least once rather than from
 *  every pixel load, because a mail read four times is one person reading it. The
 *  same send opened by a privacy proxy and by the recipient is still one. */
export const sequencesReport = async (ctx: AccountContext, range: Range): Promise<SequencesReport> =>
  withAccount(ctx, async (tx) => {
    const sequences = await tx.execute<{
      sequence: string
      sent: number
      opened: number
      clicked: number
      replied: number
      bounced: number
    }>(sql`
      select q.name as sequence,
             count(*) filter (where d.state = 'sent')::int as sent,
             count(*) filter (where d.open_count > 0)::int as opened,
             count(*) filter (where d.click_count > 0)::int as clicked,
             -- A reply belongs to the enrollment, not to each mail it sent.
             count(distinct d.enrollment_id) filter (where e.state = 'replied')::int as replied,
             count(*) filter (where d.state = 'bounced')::int as bounced
        from sequence_send d
        join sequence_enrollment e on e.id = d.enrollment_id
        join sequence q on q.id = e.sequence_id
       where ${bounds(range, 'd.sent_at')}
       group by q.id, q.name
       order by 2 desc
       limit ${MAX_ROWS}`)

    const mailboxes = await tx.execute<{ mailbox: string | null; sent: number; bounced: number; failed: number }>(sql`
      select coalesce(m.email, 'A disconnected mailbox') as mailbox,
             count(*) filter (where d.state = 'sent')::int as sent,
             count(*) filter (where d.state = 'bounced')::int as bounced,
             count(*) filter (where d.state = 'failed')::int as failed
        from sequence_send d
        left join mailbox m on m.id = d.mailbox_id
       where ${bounds(range, 'd.sent_at')}
         -- The sequence rollup above joins enrollment and so excludes one-off
         -- mail already; this one has to say it, or a tracked reply somebody
         -- typed by hand would count as outreach from that mailbox.
         and d.enrollment_id is not null
       group by 1
       order by 2 desc
       limit ${MAX_ROWS}`)

    return {
      sequences: sequences.map((row) => ({
        sequence: row.sequence,
        sent: Number(row.sent),
        opened: Number(row.opened),
        clicked: Number(row.clicked),
        replied: Number(row.replied),
        bounced: Number(row.bounced),
      })),
      mailboxes: mailboxes.map((row) => ({
        mailbox: row.mailbox ?? 'A disconnected mailbox',
        sent: Number(row.sent),
        bounced: Number(row.bounced),
        failed: Number(row.failed),
      })),
    }
  })

// --------------------------------------------------------------------- email

export type EmailReport = {
  mailboxes: { mailbox: string; sent: number; received: number; threads: number }[]
  /** Hours between an outbound message and the first inbound reply on its thread. */
  replyLag: { mailbox: string; medianHours: number | null; replies: number }[]
}

/** What is actually going through the connected mailboxes, and how long people
 *  wait for an answer. The lag is a median rather than a mean: one thread that was
 *  answered after a fortnight should not make a team that replies within the hour
 *  look like it replies within a day. */
export const emailReport = async (ctx: AccountContext, range: Range): Promise<EmailReport> =>
  withAccount(ctx, async (tx) => {
    const mailboxes = await tx.execute<{ mailbox: string | null; sent: number; received: number; threads: number }>(sql`
      select coalesce(b.email, 'A disconnected mailbox') as mailbox,
             count(*) filter (where m.direction = 'outbound')::int as sent,
             count(*) filter (where m.direction = 'inbound')::int as received,
             count(distinct m.thread_id)::int as threads
        from message m
        left join mailbox b on b.id = m.mailbox_id
       where ${bounds(range, 'm.sent_at')}
       group by 1
       order by 2 desc
       limit ${MAX_ROWS}`)

    const replyLag = await tx.execute<{ mailbox: string | null; median_hours: string | null; replies: number }>(sql`
      with answered as (
        select out.mailbox_id,
               min(reply.sent_at) - out.sent_at as waited
          from message out
          join message reply
            on reply.thread_id = out.thread_id
           and reply.direction = 'inbound'
           and reply.sent_at > out.sent_at
         where out.direction = 'outbound' and ${bounds(range, 'out.sent_at')}
         group by out.id, out.mailbox_id, out.sent_at
      )
      select coalesce(b.email, 'A disconnected mailbox') as mailbox,
             (percentile_cont(0.5) within group (order by extract(epoch from a.waited) / 3600))::text as median_hours,
             count(*)::int as replies
        from answered a
        left join mailbox b on b.id = a.mailbox_id
       group by 1
       order by 3 desc
       limit ${MAX_ROWS}`)

    return {
      mailboxes: mailboxes.map((row) => ({
        mailbox: row.mailbox ?? 'A disconnected mailbox',
        sent: Number(row.sent),
        received: Number(row.received),
        threads: Number(row.threads),
      })),
      replyLag: replyLag.map((row) => ({
        mailbox: row.mailbox ?? 'A disconnected mailbox',
        medianHours: row.median_hours === null ? null : Number(row.median_hours),
        replies: Number(row.replies),
      })),
    }
  })

// ------------------------------------------------------------------- website

export type WebsiteReport = {
  channels: { channel: string; sessions: number; identified: number }[]
  campaigns: { source: string; medium: string; campaign: string; sessions: number }[]
  pages: { path: string; views: number; visitors: number }[]
  identifiedShare: { sessions: number; identified: number }
}

/** Where the traffic came from, what it read, and how much of it Rawr can put a
 *  name to. The identified share is the number that says whether the tracking is
 *  worth anything: anonymous sessions are a page-view counter, named ones are a
 *  CRM. */
export const websiteReport = async (ctx: AccountContext, range: Range): Promise<WebsiteReport> =>
  withAccount(ctx, async (tx) => {
    const channels = await tx.execute<{ channel: string | null; sessions: number; identified: number }>(sql`
      select coalesce(s.channel, 'Not attributed') as channel,
             count(*)::int as sessions,
             count(*) filter (where v.contact_id is not null)::int as identified
        from visitor_session s
        left join visitor v on v.id = s.visitor_id and v.account_id = s.account_id
       where ${bounds(range, 's.started_at')}
       group by 1
       order by 2 desc
       limit ${MAX_ROWS}`)

    const campaigns = await tx.execute<{
      source: string | null
      medium: string | null
      campaign: string | null
      sessions: number
    }>(sql`
      select s.utm ->> 'source' as source,
             s.utm ->> 'medium' as medium,
             s.utm ->> 'campaign' as campaign,
             count(*)::int as sessions
        from visitor_session s
       where ${bounds(range, 's.started_at')} and s.utm <> '{}'::jsonb
       group by 1, 2, 3
       order by 4 desc
       limit ${MAX_ROWS}`)

    const pages = await tx.execute<{ path: string; views: number; visitors: number }>(sql`
      select p.path, count(*)::int as views, count(distinct p.visitor_id)::int as visitors
        from page_view p
       where ${bounds(range, 'p.at')}
       group by 1
       order by 2 desc
       limit ${MAX_ROWS}`)

    const totals = channels.reduce(
      (running, row) => ({
        sessions: running.sessions + Number(row.sessions),
        identified: running.identified + Number(row.identified),
      }),
      { sessions: 0, identified: 0 },
    )

    return {
      channels: channels.map((row) => ({
        channel: row.channel ?? 'Not attributed',
        sessions: Number(row.sessions),
        identified: Number(row.identified),
      })),
      campaigns: campaigns.map((row) => ({
        source: row.source ?? '(none)',
        medium: row.medium ?? '(none)',
        campaign: row.campaign ?? '(none)',
        sessions: Number(row.sessions),
      })),
      pages: pages.map((row) => ({ path: row.path, views: Number(row.views), visitors: Number(row.visitors) })),
      identifiedShare: totals,
    }
  })

// --------------------------------------------------------------- attribution

export type AttributionReport = {
  first: { channel: string; contacts: number; deals: number; wonAmounts: Amounts }[]
  last: { channel: string; contacts: number; deals: number; wonAmounts: Amounts }[]
}

/** The question the whole block exists for: which channels bring people who
 *  eventually buy.
 *
 *  Both touches are reported, side by side and never blended. First touch credits
 *  what found somebody; last touch credits what closed them; a single blended
 *  number hides which of the two a channel is good at. A contact whose source was
 *  never captured appears as "Not attributed" rather than being dropped, because a
 *  report that quietly excludes half the contacts is worse than one that admits it. */
export const attributionReport = async (ctx: AccountContext, range: Range): Promise<AttributionReport> =>
  withAccount(ctx, async (tx) => {
    // Last touch falls back to the first: if the only touch anybody recorded is
    // the one that found them, then it is also the most recent one. Without this,
    // every contact who arrived once and never came back reads as unattributed on
    // the right-hand chart while being attributed on the left, which looks like a
    // bug and is really just a contact with a single visit.
    const source = (column: 'original_source' | 'latest_source') =>
      column === 'latest_source'
        ? sql`coalesce(c.latest_source, c.original_source)`
        : sql`c.original_source`

    const byTouch = async (column: 'original_source' | 'latest_source') =>
      tx.execute<{
        channel: string
        contacts: number
        deals: number
        won_amounts: { currency: string; amount: string }[]
      }>(sql`
        with touched as (
          select coalesce(${source(column)} ->> 'channel', 'Not attributed') as channel, c.id, c.company_id
            from contact c
           where c.deleted_at is null and ${bounds(range, 'c.created_at')}
        ),
        -- One row per channel and deal: every contact at a company is joined to its
        -- deals, so summing straight off that join counted a deal once per contact.
        --
        -- Deals are deliberately not bounded by the range: a channel that found
        -- somebody in January is credited with the deal that closed in June, and
        -- cutting the join at the range end would credit it with nothing.
        credited as (
          select distinct t.channel, d.id, d.amount, d.currency, coalesce(s.is_closed_won, false) as won
            from touched t
            join deal d on d.company_id = t.company_id and d.deleted_at is null
            left join pipeline_stage s on s.id = d.stage_id
        ),
        per_currency as (
          select channel, currency, count(*)::int as n,
                 coalesce(sum(amount) filter (where won), 0) as won_amount
            from credited group by channel, currency
        ),
        deals as (
          select channel, sum(n)::int as deals,
                 coalesce(json_agg(json_build_object('currency', currency, 'amount', won_amount) order by won_amount desc)
                            filter (where won_amount > 0), '[]'::json) as won_amounts
            from per_currency group by channel
        )
        select p.channel, p.contacts, coalesce(k.deals, 0)::int as deals,
               coalesce(k.won_amounts, '[]'::json) as won_amounts
          from (select channel, count(*)::int as contacts from touched group by channel) p
          left join deals k on k.channel = p.channel
         order by p.contacts desc, coalesce(k.deals, 0) desc, p.channel
         limit ${MAX_ROWS}`)

    const shape = (rows: Awaited<ReturnType<typeof byTouch>>) =>
      rows.map((row) => ({
        channel: row.channel,
        contacts: Number(row.contacts),
        deals: Number(row.deals),
        wonAmounts: amountsOf(row.won_amounts),
      }))

    return {
      first: shape(await byTouch('original_source')),
      last: shape(await byTouch('latest_source')),
    }
  })
