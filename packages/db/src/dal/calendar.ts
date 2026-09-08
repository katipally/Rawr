import { sql, type SQL } from 'drizzle-orm'
import type { AccountContext } from './context.ts'
import { withAccount } from './index.ts'
import { compileFilters, fieldExpression, scopeFor, type FilterGroup } from './query.ts'
import { displayName } from './records.ts'
import type { ObjectKey } from '../registry/core.ts'
import { fieldOrThrow, getRegistry, objectOrThrow, type RegistryField, type RegistryObject } from './registry.ts'

/** What is happening this month.
 *
 *  A table answers "what is there" and a board answers "what stage is it at".
 *  Neither answers the question somebody opens a CRM on a Monday to ask, which is
 *  about dates: what closes this month, what is due this week.
 *
 *  One query, bounded by the month rather than by a row limit, because a calendar
 *  that silently stops at two hundred records is a calendar showing an empty
 *  second half of the month. A day with too many to draw says so instead. */

/** A field a calendar can lay records out on: a date, or an instant. Nothing
 *  else places a record on a square. */
const PLACEABLE = (field: RegistryField): boolean => field.type === 'date' || field.type === 'datetime'

export const calendarFields = (object: RegistryObject): { key: string; label: string }[] =>
  object.fields.filter(PLACEABLE).map((field) => ({ key: field.key, label: field.label }))

export type CalendarEntry = {
  id: string
  displayName: string
  /** The calendar day it sits on, as YYYY-MM-DD. */
  day: string
  /** Present for a datetime field, absent for a date. A date has no time, and
   *  inventing midnight for it would put "due today" at 12:00 am. */
  time: string | null
}

export type CalendarMonth = {
  objectKey: string
  /** Which field placed these. */
  fieldKey: string
  fieldLabel: string
  /** The first day of the month being shown, YYYY-MM-DD. */
  month: string
  entries: CalendarEntry[]
  /** True when the month held more than could be drawn. Better to say so than to
   *  show a quiet half-truth. */
  truncated: boolean
}

/** More than any month can usefully draw. A person looking at four hundred deals
 *  on one square needs the list, not the calendar, and the screen says so. */
const MAX_ENTRIES = 500

/** The month containing this day, as its first day. Built from the parts rather
 *  than from a Date, so a server in one zone and a reader in another agree on
 *  which month "2026-09-01" is in. */
const monthStart = (day: string): string => `${day.slice(0, 7)}-01`

export const readCalendar = async (
  ctx: AccountContext,
  input: {
    object: string
    /** Any day in the month to show. */
    month: string
    fieldKey: string
    filters?: FilterGroup[]
    search?: string
  },
): Promise<CalendarMonth> =>
  withAccount(ctx, async (tx) => {
    const registry = await getRegistry(ctx)
    const object = objectOrThrow(registry, input.object)

    const candidate = object.byKey.get(input.fieldKey)
    if (!candidate || !PLACEABLE(candidate)) {
      const names = calendarFields(object).map((field) => field.label).join(', ')
      throw new Error(
        names
          ? `A calendar cannot be laid out on "${input.fieldKey}". Try one of: ${names}.`
          : `A ${object.nameSingular.toLowerCase()} has no date field to lay a calendar out on.`,
      )
    }
    const field = fieldOrThrow(object, candidate.key)
    const placed = fieldExpression(object, field)
    const start = monthStart(input.month)

    const where: SQL[] = [sql.raw(`"${object.key}"."deleted_at" is null`)]
    // Half-open on the month: a record at 23:59 on the last day is in, and the
    // first instant of the next month is not. `>= start and < start + 1 month`
    // rather than `between`, which would include both ends of the boundary.
    where.push(sql`${placed} >= ${start}::date`)
    where.push(sql`${placed} < (${start}::date + interval '1 month')`)

    const filters = compileFilters(object, input.filters ?? [], scopeFor(ctx.actorId))
    if (filters) where.push(filters)
    if (input.search?.trim()) {
      where.push(sql`${sql.raw(`"${object.key}"."search"`)} @@ plainto_tsquery('simple', ${input.search.trim()})`)
    }

    const rows = await tx.execute<Record<string, unknown>>(sql`
      select ${sql.raw(`"${object.key}".*`)},
             (${placed})::date as calendar_day,
             ${field.type === 'datetime' ? sql`to_char(${placed}, 'HH24:MI')` : sql`null::text`} as calendar_time
        from ${sql.raw(`"${object.key}"`)}
       where ${sql.join(where, sql` and `)}
       order by ${placed} asc
       limit ${MAX_ENTRIES + 1}`)

    const truncated = rows.length > MAX_ENTRIES
    return {
      objectKey: object.key,
      fieldKey: field.key,
      fieldLabel: field.label,
      month: start,
      truncated,
      entries: rows.slice(0, MAX_ENTRIES).map((row) => ({
        id: String(row.id),
        displayName: displayName(object, row),
        day: String(row.calendar_day).slice(0, 10),
        time: (row.calendar_time as string | null) ?? null,
      })),
    }
  })

// ---------------------------------------------------------------------------
// The agenda: what one person has on
// ---------------------------------------------------------------------------

export type AgendaEntry = CalendarEntry & {
  kind: 'meeting' | 'task'
  /** The meeting's booking id or the task's id: what the day's chip addresses. */
  refId: string
  /** A task's record, when it hangs on one, so the chip can open the person
   *  rather than a list. */
  entityType: string | null
  entityId: string | null
}

export type Agenda = {
  month: string
  entries: AgendaEntry[]
  truncated: boolean
}

/** What a person has on this month: the meetings booked with them and the tasks
 *  due from them. Named agenda rather than schedule because `booking-admin`'s
 *  schedule is a person's working hours, which is a different thing entirely.
 *
 *  Not `readCalendar`, and deliberately: that one lays one registry object out on
 *  one of its date fields. Neither a booking nor a task is a registry object, and
 *  a month that shows meetings but not what is due is not the screen anybody
 *  opens a CRM on a Monday to look at.
 *
 *  Two indexed range scans and a merge, bounded by the month. O(k) in what the
 *  month holds, not in the account. */
export const readAgenda = async (
  ctx: AccountContext,
  input: { month: string; userId?: string | null },
): Promise<Agenda> =>
  withAccount(ctx, async (tx) => {
    const start = monthStart(input.month)
    const who = input.userId ?? null

    const rows = await tx.execute<{
      kind: 'meeting' | 'task'
      ref_id: string
      name: string
      calendar_day: string
      calendar_time: string | null
      entity_type: string | null
      entity_id: string | null
    }>(sql`
      select 'meeting' as kind, b.id as ref_id,
             p.name || ' · ' || b.attendee_name as name,
             (b.starts_at at time zone 'UTC')::date::text as calendar_day,
             to_char(b.starts_at at time zone 'UTC', 'HH24:MI') as calendar_time,
             case when b.contact_id is null then null else 'contact' end as entity_type,
             b.contact_id::text as entity_id
        from booking b
        join booking_page p on p.id = b.booking_page_id
       where b.state = 'confirmed'
         and b.starts_at >= ${start}::date
         and b.starts_at < (${start}::date + interval '1 month')
         and (${who}::uuid is null or b.host_user_id = ${who}::uuid)

      union all

      select 'task' as kind, t.id as ref_id,
             t.title as name,
             t.due_date::text as calendar_day,
             null::text as calendar_time,
             t.entity_type, t.entity_id::text
        from task t
       where t.due_date is not null
         and t.status = 'open'
         and t.due_date >= ${start}::date
         and t.due_date < (${start}::date + interval '1 month')
         and (${who}::uuid is null or t.assignee_id = ${who}::uuid)

       order by calendar_day, calendar_time nulls first
       limit ${MAX_ENTRIES + 1}`)

    const truncated = rows.length > MAX_ENTRIES
    return {
      month: start,
      truncated,
      entries: rows.slice(0, MAX_ENTRIES).map((row) => ({
        id: `${row.kind}:${row.ref_id}`,
        refId: row.ref_id,
        kind: row.kind,
        displayName: row.name,
        day: row.calendar_day,
        time: row.calendar_time,
        entityType: row.entity_type,
        entityId: row.entity_id,
      })),
    }
  })
