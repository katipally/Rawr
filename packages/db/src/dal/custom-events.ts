import { sql } from 'drizzle-orm'
import type { AccountContext } from './context.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import { MAX_ROWS, type Range } from './reporting.ts'

/** P3 item 13. What a site's events are called, what they mean, and how far
 *  people get through a sequence of them.
 *
 *  A definition describes a name the collector already stores; it never gates
 *  one. The collector's hot path stays exactly as it was, and the vocabulary is
 *  discovered from `event_name_day`, which already records every distinct name
 *  per account per day for the cardinality cap. So opening this tab is what
 *  registers what the sites are firing, and a release that starts firing a new
 *  name shows it there without anybody deploying anything. */

export type EventDefRow = {
  id: string
  name: string
  label: string | null
  properties: Record<string, unknown>
  /** True while nobody has described it: the collector saw the name, that is all. */
  discovered: boolean
  /** Days in the discovery window this name was seen on, newest first. */
  lastSeenDay: string | null
  updatedAt: Date
}

export type EventDefPage = { rows: EventDefRow[]; total: number }

/** How far back a name counts as current. A site that stopped firing something a
 *  quarter ago should not keep it at the top of a list somebody is choosing
 *  funnel steps from, and the row itself is never deleted, so nothing is lost. */
const DISCOVERY_DAYS = 30

const PAGE = 25
const MAX_PAGE = 100

/** Registers every name seen in the window that has no definition yet.
 *
 *  One `insert ... select` over `event_name_day`, whose primary key is
 *  (account_id, day, name): at most the daily cardinality cap times the window,
 *  and the conflict clause makes a second call a no-op. O(names in the window). */
const registerDiscovered = async (tx: Tx, ctx: AccountContext): Promise<void> => {
  await tx.execute(sql`
    insert into custom_event_def (account_id, name, discovered)
    select distinct d.account_id, d.name, true
      from event_name_day d
     where d.account_id = ${ctx.accountId}
       and d.day >= current_date - ${DISCOVERY_DAYS}::int
       and d.name <> '_overflow'
    on conflict do nothing`)
}

export const listEventDefs = async (
  ctx: AccountContext,
  input: { search?: string | null | undefined; limit?: number | undefined; offset?: number | undefined } = {},
): Promise<EventDefPage> =>
  withAccount(ctx, async (tx) => {
    await registerDiscovered(tx, ctx)

    const limit = Math.min(Math.max(input.limit ?? PAGE, 1), MAX_PAGE)
    const offset = Math.max(input.offset ?? 0, 0)
    const needle = input.search?.trim().toLowerCase()
    const match = needle
      ? sql`and (lower(e.name) like ${`%${needle}%`} or lower(coalesce(e.label, '')) like ${`%${needle}%`})`
      : sql``

    const rows = await tx.execute<{
      id: string
      name: string
      label: string | null
      properties: Record<string, unknown>
      discovered: boolean
      last_seen_day: string | null
      updated_at: string
      total: number
    }>(sql`
      select e.id, e.name, e.label, e.properties, e.discovered, e.updated_at,
             (select max(d.day)::text from event_name_day d
               where d.account_id = e.account_id and d.name = e.name) as last_seen_day,
             count(*) over ()::int as total
        from custom_event_def e
       where e.account_id = ${ctx.accountId} ${match}
       -- Described names first: those are the ones somebody chose to care about.
       order by e.discovered, lower(e.name)
       limit ${limit} offset ${offset}`)

    return {
      rows: rows.map((row) => ({
        id: row.id,
        name: row.name,
        label: row.label,
        properties: (row.properties ?? {}) as Record<string, unknown>,
        discovered: row.discovered,
        lastSeenDay: row.last_seen_day,
        updatedAt: new Date(row.updated_at),
      })),
      total: Number(rows[0]?.total ?? 0),
    }
  })

export type SaveEventDefInput = {
  name: string
  label?: string | null | undefined
  properties?: Record<string, unknown> | undefined
}

/** Describing a name is what turns it from discovered into declared, which is
 *  why `discovered` is set false here rather than being a separate switch. */
export const saveEventDef = async (ctx: AccountContext, input: SaveEventDefInput): Promise<string> =>
  mutate(ctx, 'custom_event_def', async (tx) => {
    const name = input.name.trim()
    if (!name) throw new Error('An event needs a name.')

    const rows = await tx.execute<{ id: string }>(sql`
      insert into custom_event_def (account_id, name, label, properties, discovered)
      values (${ctx.accountId}, ${name}, ${input.label?.trim() || null},
              ${JSON.stringify(input.properties ?? {})}::jsonb, false)
      on conflict (account_id, lower(name)) do update
         set label = excluded.label,
             properties = excluded.properties,
             discovered = false,
             updated_at = now()
      returning id`)

    const id = rows[0]?.id
    if (!id) throw new Error('That event definition could not be saved.')
    return {
      result: id,
      audit: { entity: 'custom_event_def', entityId: id, action: 'save', after: { name } },
    }
  })

// ------------------------------------------------------------------- report

export type EventDayCount = { day: string; name: string; events: number; visitors: number }

/** Per-name daily counts over the range, for the events report.
 *
 *  Grouped in the database and capped like every other report: a chart with four
 *  hundred bars is a table nobody reads. One range scan on
 *  custom_event (account_id, name, at). */
export const eventCountsByDay = async (
  ctx: AccountContext,
  range: Range,
  names: string[] = [],
): Promise<EventDayCount[]> =>
  withAccount(ctx, async (tx) => {
    const only = names.length > 0
      ? sql`and e.name = any(array[${sql.join(names.map((name) => sql`${name}::text`), sql`, `)}])`
      : sql``

    const rows = await tx.execute<{ day: string; name: string; events: number; visitors: number }>(sql`
      select e.at::date::text as day, e.name,
             count(*)::int as events,
             count(distinct e.visitor_id)::int as visitors
        from custom_event e
       where e.account_id = ${ctx.accountId}
         and e.at >= ${range.from.toISOString()}::timestamptz
         and e.at < ${range.to.toISOString()}::timestamptz ${only}
       group by 1, 2
       order by 1, 3 desc
       limit ${MAX_ROWS * 5}`)

    return rows.map((row) => ({
      day: row.day,
      name: row.name,
      events: Number(row.events),
      visitors: Number(row.visitors),
    }))
  })

export type EventFunnelStep = { name: string; visitors: number; contacts: number }

export const FUNNEL_MIN_STEPS = 2
export const FUNNEL_MAX_STEPS = 5

/** How many people got through each step, in the order given.
 *
 *  Order matters and is what makes this a funnel rather than five counts: step
 *  two counts only visitors whose first step-two event came at or after their
 *  first step-one event. Somebody who paid before they ever saw the pricing page
 *  did not walk this path, and counting them makes a broken funnel look healthy.
 *
 *  Built as one aggregate per step over a single filtered CTE rather than a
 *  window function per row: five hash joins over the events named in the funnel,
 *  O(matching rows x steps) with steps capped at five, and never the
 *  self-join-per-pair shape that turns into O(rows x steps squared). */
export const eventFunnel = async (
  ctx: AccountContext,
  input: { steps: string[]; range: Range },
): Promise<EventFunnelStep[]> => {
  const steps = input.steps.map((step) => step.trim()).filter(Boolean).slice(0, FUNNEL_MAX_STEPS)
  if (steps.length < FUNNEL_MIN_STEPS) return []

  return withAccount(ctx, async (tx) => {
    // Each step's CTE is the visitors who reached the one before it, plus the
    // first time they fired this step's name at or after that moment.
    const reached = steps.map((name, index) => {
      const alias = sql.raw(`s${index}`)
      const previous = sql.raw(`s${index - 1}`)
      return index === 0
        ? sql`${alias} as (
            select b.visitor_id, min(b.at) as at
              from base b where b.name = ${name}
             group by 1)`
        : sql`${alias} as (
            select b.visitor_id, min(b.at) as at
              from base b
              join ${previous} p on p.visitor_id = b.visitor_id and b.at >= p.at
             where b.name = ${name}
             group by 1)`
    })

    const counts = steps.map(
      (_name, index) => sql`select ${index}::int as step,
             count(*)::int as visitors,
             count(distinct k.contact_id)::int as contacts
        from ${sql.raw(`s${index}`)} s
        left join known k on k.visitor_id = s.visitor_id`,
    )

    const rows = await tx.execute<{ step: number; visitors: number; contacts: number }>(sql`
      with base as (
        select e.visitor_id, e.contact_id, e.name, e.at
          from custom_event e
         where e.account_id = ${ctx.accountId}
           and e.at >= ${input.range.from.toISOString()}::timestamptz
           and e.at < ${input.range.to.toISOString()}::timestamptz
           and e.name = any(array[${sql.join(steps.map((name) => sql`${name}::text`), sql`, `)}])
      ), known as (
        select visitor_id, max(contact_id::text)::uuid as contact_id
          from base where contact_id is not null group by 1
      ), ${sql.join(reached, sql`, `)}
      ${sql.join(counts, sql` union all `)}
      order by 1`)

    const found = new Map(rows.map((row) => [Number(row.step), row]))
    return steps.map((name, index) => ({
      name,
      visitors: Number(found.get(index)?.visitors ?? 0),
      contacts: Number(found.get(index)?.contacts ?? 0),
    }))
  })
}
