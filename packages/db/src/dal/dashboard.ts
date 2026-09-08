import { sql } from 'drizzle-orm'
import type { AccountContext } from './context.ts'
import { withAccount } from './index.ts'

/** The Monday screen. Everything Trevor exports to a spreadsheet to see, read in
 *  one transaction: the open pipeline per stage, what closes this month, what is
 *  overdue, and what arrived since the person last looked. D10. */

export type Money = { currency: string; total: number; weighted: number }

/** One row per stage. Amounts are never summed across currencies: a dollar and
 *  a euro deal in the same stage report as two totals, the way the board does. */
export type StageSummary = {
  pipelineId: string
  pipelineName: string
  stageId: string
  stageName: string
  position: number
  probability: number | null
  count: number
  totals: Money[]
}

export type DealDue = {
  id: string
  name: string | null
  amount: number | null
  currency: string
  closeDate: string
  stageName: string | null
  ownerName: string | null
}

export type UpcomingBooking = {
  id: string
  startsAt: Date
  attendeeName: string
  contactId: string | null
  hostName: string | null
  pageName: string
}

export type Dashboard = {
  stages: StageSummary[]
  closingThisMonth: DealDue[]
  /** Contacts created in the last seven days. */
  newContacts: number
  quarantined: number
  upcoming: UpcomingBooking[]
  myOpenTasks: number
  myOverdueTasks: number
}

export const readDashboard = async (ctx: AccountContext): Promise<Dashboard> =>
  withAccount(ctx, async (tx) => {
    const [stages, closing, counts, upcoming] = await Promise.all([
      tx.execute<{
        pipeline_id: string
        pipeline_name: string
        stage_id: string
        stage_name: string
        position: number
        probability: string | null
        n: number
        totals: { currency: string; total: string; weighted: string }[] | null
      }>(sql`
        select p.id as pipeline_id, p.name as pipeline_name, s.id as stage_id, s.name as stage_name,
               s.position, s.probability,
               (select count(*) from deal d where d.stage_id = s.id and d.deleted_at is null)::int as n,
               (select json_agg(json_build_object('currency', m.currency, 'total', m.total, 'weighted', m.weighted) order by m.currency)
                  from (select d.currency,
                               coalesce(sum(d.amount), 0)::text as total,
                               coalesce(sum(d.amount * coalesce(s.probability, 0) / 100), 0)::text as weighted
                          from deal d
                         where d.stage_id = s.id and d.deleted_at is null and d.amount is not null
                         group by d.currency) m) as totals
          from pipeline_stage s
          join pipeline p on p.id = s.pipeline_id
         where not s.is_closed_won and not s.is_closed_lost
         order by p.position, s.position`),
      tx.execute<{
        id: string
        name: string | null
        amount: string | null
        currency: string
        close_date: string
        stage_name: string | null
        owner_name: string | null
      }>(sql`
        select d.id, d.name, d.amount, d.currency, d.close_date::text, s.name as stage_name, u.name as owner_name
          from deal d
          left join pipeline_stage s on s.id = d.stage_id
          left join user_account u on u.id = d.owner_id
         where d.deleted_at is null
           and d.close_date >= date_trunc('month', current_date)
           and d.close_date < date_trunc('month', current_date) + interval '1 month'
           and not coalesce(s.is_closed_won, false) and not coalesce(s.is_closed_lost, false)
         order by d.close_date asc
         limit 50`),
      tx.execute<{ new_contacts: number; quarantined: number; my_open: number; my_overdue: number }>(sql`
        select (select count(*) from contact where deleted_at is null and created_at >= now() - interval '7 days')::int as new_contacts,
               (select count(*) from form_submission where spam_state = 'quarantined')::int as quarantined,
               (select count(*) from task where status = 'open' and assignee_id = ${ctx.actorId}::uuid)::int as my_open,
               (select count(*) from task where status = 'open' and assignee_id = ${ctx.actorId}::uuid
                   and due_date is not null and due_date < current_date)::int as my_overdue`),
      tx.execute<{
        id: string
        starts_at: Date
        attendee_name: string
        contact_id: string | null
        host_name: string | null
        page_name: string
      }>(sql`
        select b.id, b.starts_at, b.attendee_name, b.contact_id, u.name as host_name, p.name as page_name
          from booking b
          join booking_page p on p.id = b.booking_page_id
          left join user_account u on u.id = b.host_user_id
         where b.state = 'confirmed' and b.starts_at >= now() and b.starts_at < now() + interval '7 days'
         order by b.starts_at asc
         limit 20`),
    ])

    const c = counts[0]
    return {
      stages: stages.map((row) => ({
        pipelineId: row.pipeline_id,
        pipelineName: row.pipeline_name,
        stageId: row.stage_id,
        stageName: row.stage_name,
        position: row.position,
        probability: row.probability === null ? null : Number(row.probability),
        count: Number(row.n),
        totals: (row.totals ?? []).map((m) => ({ currency: m.currency, total: Number(m.total), weighted: Number(m.weighted) })),
      })),
      closingThisMonth: closing.map((row) => ({
        id: row.id,
        name: row.name,
        amount: row.amount === null ? null : Number(row.amount),
        currency: row.currency,
        closeDate: row.close_date,
        stageName: row.stage_name,
        ownerName: row.owner_name,
      })),
      newContacts: Number(c?.new_contacts ?? 0),
      quarantined: Number(c?.quarantined ?? 0),
      myOpenTasks: Number(c?.my_open ?? 0),
      myOverdueTasks: Number(c?.my_overdue ?? 0),
      upcoming: upcoming.map((row) => ({
        id: row.id,
        startsAt: new Date(row.starts_at),
        attendeeName: row.attendee_name,
        contactId: row.contact_id,
        hostName: row.host_name,
        pageName: row.page_name,
      })),
    }
  })
