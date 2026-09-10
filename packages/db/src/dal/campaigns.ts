import { sql } from 'drizzle-orm'
import type { AccountContext } from './context.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import { MAX_ROWS, type Range } from './reporting.ts'

/** P3 item 14. The SEM container, and the cost-per numbers it exists for.
 *
 *  Everything else in attribution is derived from what arrived: a channel is a
 *  reading of a referrer and a medium, and it needs no table. Cost is not in the
 *  query string and never will be, so a campaign is a row somebody keys the
 *  `utm_campaign` value into and types the spend against. Every visit,
 *  submission, contact and deal already carrying that value joins onto it.
 *
 *  The match is on `lower(utm_campaign)`, everywhere, in one place: an ad
 *  platform that starts sending `Spring_2026` where it used to send
 *  `spring_2026` must not silently open a second campaign. */

export type CampaignRow = {
  id: string
  name: string
  source: string | null
  medium: string | null
  utmCampaign: string
  spend: number
  currency: string
  startsOn: string | null
  endsOn: string | null
  updatedAt: Date
}

export type CampaignPage = { rows: CampaignRow[]; total: number }

const PAGE = 25
const MAX_PAGE = 100

export const listCampaigns = async (
  ctx: AccountContext,
  input: { search?: string | null | undefined; limit?: number | undefined; offset?: number | undefined } = {},
): Promise<CampaignPage> =>
  withAccount(ctx, async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? PAGE, 1), MAX_PAGE)
    const offset = Math.max(input.offset ?? 0, 0)
    const needle = input.search?.trim().toLowerCase()
    const match = needle
      ? sql`and (lower(k.name) like ${`%${needle}%`} or lower(k.utm_campaign) like ${`%${needle}%`})`
      : sql``

    const rows = await tx.execute<{
      id: string
      name: string
      source: string | null
      medium: string | null
      utm_campaign: string
      spend: string
      currency: string
      starts_on: string | null
      ends_on: string | null
      updated_at: string
      total: number
    }>(sql`
      select k.id, k.name, k.source, k.medium, k.utm_campaign, k.spend::text, k.currency,
             k.starts_on::text, k.ends_on::text, k.updated_at,
             count(*) over ()::int as total
        from campaign k
       where k.account_id = ${ctx.accountId} ${match}
       order by lower(k.name)
       limit ${limit} offset ${offset}`)

    return {
      rows: rows.map((row) => ({
        id: row.id,
        name: row.name,
        source: row.source,
        medium: row.medium,
        utmCampaign: row.utm_campaign,
        spend: Number(row.spend),
        currency: row.currency,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
        updatedAt: new Date(row.updated_at),
      })),
      total: Number(rows[0]?.total ?? 0),
    }
  })

export type SaveCampaignInput = {
  id?: string | null | undefined
  name: string
  source?: string | null | undefined
  medium?: string | null | undefined
  utmCampaign: string
  spend: number
  currency: string
  startsOn?: string | null | undefined
  endsOn?: string | null | undefined
}

/** Creating or editing one, then attaching whoever already arrived through it.
 *
 *  The resolve runs inside the same transaction, because a campaign that exists
 *  but names nobody until a nightly job catches up reads as a bug on the report
 *  it was created to fill in. */
export const saveCampaign = async (ctx: AccountContext, input: SaveCampaignInput): Promise<string> =>
  mutate(ctx, 'campaign', async (tx) => {
    const name = input.name.trim()
    const utmCampaign = input.utmCampaign.trim()
    if (!name) throw new Error('A campaign needs a name.')
    if (!utmCampaign) throw new Error('A campaign needs the utm_campaign value its links carry.')
    if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
      throw new Error('That campaign would end before it started.')
    }

    // Read the row the update is about to overwrite, so the audit entry can say
    // what changed rather than showing every field as arriving from nothing.
    const prior = input.id
      ? (
          await tx.execute<{ name: string; utm_campaign: string; spend: string }>(sql`
            select name, utm_campaign, spend::text
              from campaign
             where id = ${input.id} and account_id = ${ctx.accountId}`)
        )[0]
      : undefined

    const rows = input.id
      ? await tx.execute<{ id: string }>(sql`
          update campaign
             set name = ${name}, source = ${input.source?.trim() || null},
                 medium = ${input.medium?.trim() || null}, utm_campaign = ${utmCampaign},
                 spend = ${input.spend}, currency = ${input.currency.trim().toUpperCase()},
                 starts_on = ${input.startsOn || null}, ends_on = ${input.endsOn || null},
                 updated_at = now()
           where id = ${input.id} and account_id = ${ctx.accountId}
          returning id`)
      : await tx.execute<{ id: string }>(sql`
          insert into campaign (account_id, name, source, medium, utm_campaign, spend, currency, starts_on, ends_on, created_by)
          values (${ctx.accountId}, ${name}, ${input.source?.trim() || null}, ${input.medium?.trim() || null},
                  ${utmCampaign}, ${input.spend}, ${input.currency.trim().toUpperCase()},
                  ${input.startsOn || null}, ${input.endsOn || null}, ${ctx.actorId})
          on conflict (account_id, lower(utm_campaign)) do update
             set name = excluded.name, source = excluded.source, medium = excluded.medium,
                 spend = excluded.spend, currency = excluded.currency,
                 starts_on = excluded.starts_on, ends_on = excluded.ends_on, updated_at = now()
          returning id`)

    const id = rows[0]?.id
    if (!id) throw new Error('That campaign is not in this account.')

    await resolveContactCampaigns(tx, ctx, null)
    return {
      result: id,
      audit: {
        entity: 'campaign',
        entityId: id,
        action: input.id ? 'update' : 'create',
        before: prior && { name: prior.name, utmCampaign: prior.utm_campaign, spend: Number(prior.spend) },
        after: { name, utmCampaign, spend: input.spend },
      },
    }
  })

/** Points `first_campaign_id` and `last_campaign_id` at whatever campaign the
 *  contact's own stored attribution names.
 *
 *  Both sources are already on the contact as jsonb, written by the collector on
 *  a new visit and by the form path on a submission, so this reads what capture
 *  wrote rather than needing its own copy of the parsing. Passing ids narrows it
 *  to the contacts a stitch just touched; passing null re-runs the whole account,
 *  which is what a newly created campaign needs.
 *
 *  One statement, two joins on `campaign (account_id, lower(utm_campaign))`:
 *  O(contacts considered), and idempotent, so a re-run changes nothing. */
export const resolveContactCampaigns = async (
  tx: Tx,
  ctx: AccountContext,
  contactIds: string[] | null,
): Promise<void> => {
  const ids = contactIds ? [...new Set(contactIds)].filter(Boolean) : null
  if (ids && ids.length === 0) return
  const only = ids
    ? sql`and c.id = any(array[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])`
    : sql``

  await tx.execute(sql`
    update contact c
       set first_campaign_id = f.id,
           last_campaign_id = l.id
      from contact base
      left join campaign f
        on f.account_id = base.account_id
       and lower(f.utm_campaign) = lower(base.original_source #>> '{detail,utm,campaign}')
      left join campaign l
        on l.account_id = base.account_id
       and lower(l.utm_campaign) = lower(coalesce(base.latest_source, base.original_source) #>> '{detail,utm,campaign}')
     where c.id = base.id
       and c.account_id = ${ctx.accountId}
       and c.deleted_at is null ${only}
       and (c.first_campaign_id is distinct from f.id or c.last_campaign_id is distinct from l.id)`)
}

// ------------------------------------------------------------------- report

export type CampaignPerformance = {
  id: string
  name: string
  utmCampaign: string
  spend: number
  currency: string
  visits: number
  submissions: number
  contacts: number
  deals: number
  wonAmount: number
  /** Null rather than zero when nothing was reached: dividing spend by nobody is
   *  not a cost of zero, it is a number that does not exist yet. */
  costPerContact: number | null
  costPerDeal: number | null
}

/** What each campaign bought.
 *
 *  Visits and submissions are matched on the utm value they arrived carrying, so
 *  they count anonymous traffic too. Contacts and deals go through
 *  `first_campaign_id`, which credits the campaign that found somebody rather
 *  than the one they last clicked, the same rule first-touch attribution uses.
 *
 *  Deals are deliberately not bounded by the range, exactly as the attribution
 *  report does it: a campaign that found somebody in January is credited with the
 *  deal that closed in June, and cutting the join at the range end would credit
 *  it with nothing.
 *
 *  Four grouped passes and a join, not a subquery per campaign: O(rows in range),
 *  independent of how many campaigns exist. */
export const campaignPerformance = async (
  ctx: AccountContext,
  range: Range,
): Promise<CampaignPerformance[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      name: string
      utm_campaign: string
      spend: string
      currency: string
      visits: number
      submissions: number
      contacts: number
      deals: number
      won_amount: string
    }>(sql`
      with k as (
        select id, name, utm_campaign, lower(utm_campaign) as key, spend, currency
          from campaign where account_id = ${ctx.accountId}
      ), visits as (
        select lower(s.utm ->> 'campaign') as key, count(*)::int as n
          from visitor_session s
         where s.account_id = ${ctx.accountId}
           and s.started_at >= ${range.from.toISOString()}::timestamptz
           and s.started_at < ${range.to.toISOString()}::timestamptz
           and nullif(trim(s.utm ->> 'campaign'), '') is not null
         group by 1
      ), subs as (
        select lower(f.attribution -> 'utm' ->> 'campaign') as key, count(*)::int as n
          from form_submission f
         where f.account_id = ${ctx.accountId}
           and f.at >= ${range.from.toISOString()}::timestamptz
           and f.at < ${range.to.toISOString()}::timestamptz
           and nullif(trim(f.attribution -> 'utm' ->> 'campaign'), '') is not null
         group by 1
      ), people as (
        select c.first_campaign_id as cid, count(*)::int as n
          from contact c
         where c.account_id = ${ctx.accountId}
           and c.deleted_at is null
           and c.first_campaign_id is not null
           and c.created_at >= ${range.from.toISOString()}::timestamptz
           and c.created_at < ${range.to.toISOString()}::timestamptz
         group by 1
      ), won as (
        select c.first_campaign_id as cid,
               count(distinct d.id)::int as n,
               coalesce(sum(d.amount) filter (where st.is_closed_won), 0)::text as amount
          from contact c
          join deal d on d.company_id = c.company_id and d.deleted_at is null
          left join pipeline_stage st on st.id = d.stage_id
         where c.account_id = ${ctx.accountId}
           and c.deleted_at is null
           and c.first_campaign_id is not null
           and c.created_at >= ${range.from.toISOString()}::timestamptz
           and c.created_at < ${range.to.toISOString()}::timestamptz
         group by 1
      )
      select k.id, k.name, k.utm_campaign, k.spend::text, k.currency,
             coalesce(visits.n, 0) as visits,
             coalesce(subs.n, 0) as submissions,
             coalesce(people.n, 0) as contacts,
             coalesce(won.n, 0) as deals,
             coalesce(won.amount, '0') as won_amount
        from k
        left join visits on visits.key = k.key
        left join subs on subs.key = k.key
        left join people on people.cid = k.id
        left join won on won.cid = k.id
       order by k.spend desc, coalesce(visits.n, 0) desc, lower(k.name)
       limit ${MAX_ROWS}`)

    return rows.map((row) => {
      const spend = Number(row.spend)
      const contacts = Number(row.contacts)
      const deals = Number(row.deals)
      return {
        id: row.id,
        name: row.name,
        utmCampaign: row.utm_campaign,
        spend,
        currency: row.currency,
        visits: Number(row.visits),
        submissions: Number(row.submissions),
        contacts,
        deals,
        wonAmount: Number(row.won_amount),
        costPerContact: spend > 0 && contacts > 0 ? spend / contacts : null,
        costPerDeal: spend > 0 && deals > 0 ? spend / deals : null,
      }
    })
  })
