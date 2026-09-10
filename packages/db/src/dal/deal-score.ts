import { sql, type SQL } from 'drizzle-orm'
import type { AccountContext } from './context.ts'
import { withAccount, type Tx } from './index.ts'

/** What each rule is worth out of a hundred. HubSpot's own deal score is an AI
 *  number with no explanation; this one is six rules a rep can argue with, which
 *  is the only kind of score anybody acts on.
 *
 *  Stage carries the most because a deal's stage is the one thing a rep has
 *  already committed to in writing. Recency is next because a quiet deal is the
 *  failure mode a board exists to surface. The rest are hygiene: a dated next
 *  step, a serious amount, somebody to talk to, and a sign they are talking back. */
export const SCORE_WEIGHTS = {
  stage: 30,
  recency: 20,
  nextStep: 15,
  amount: 15,
  contact: 10,
  inbound: 10,
} as const

export type ScoreKey = keyof typeof SCORE_WEIGHTS

/** A deal with nothing logged for a month scores nothing for recency; the decay
 *  between is linear, so a fortnight of silence costs half of it. Thirty days is
 *  the same sales month the board's stale badge uses. */
const RECENCY_DAYS = 30

/** How recent an inbound email has to be to count as them still being in the
 *  conversation. Two weeks: a reply older than that is history, not momentum. */
const INBOUND_DAYS = 14

/** The breakdown, in the order the record page lists it. `why` is what the rule
 *  actually measures, so the card explains itself without a legend. */
export const SCORE_COMPONENTS: { key: ScoreKey; label: string; max: number; why: string }[] = [
  { key: 'stage', label: 'Stage probability', max: SCORE_WEIGHTS.stage, why: 'The probability the pipeline gives this stage.' },
  { key: 'recency', label: 'Recent activity', max: SCORE_WEIGHTS.recency, why: `Full marks today, nothing after ${RECENCY_DAYS} days of silence.` },
  { key: 'nextStep', label: 'Next step booked', max: SCORE_WEIGHTS.nextStep, why: 'A next step with a date that has not passed.' },
  { key: 'amount', label: 'Amount', max: SCORE_WEIGHTS.amount, why: 'Against the median amount on this pipeline.' },
  { key: 'contact', label: 'Contact associated', max: SCORE_WEIGHTS.contact, why: 'At least one contact is linked to the deal.' },
  { key: 'inbound', label: 'They replied', max: SCORE_WEIGHTS.inbound, why: `An inbound email on the deal in the last ${INBOUND_DAYS} days.` },
]

export type ScoreBand = 'none' | 'low' | 'mid' | 'high'

/** The three bands HubSpot's ring shows, measured in its own portal: red up to
 *  49, amber through 69, green from 70. */
export const scoreBand = (score: number | null | undefined): ScoreBand =>
  score === null || score === undefined ? 'none' : score >= 70 ? 'high' : score >= 50 ? 'mid' : 'low'

/** One statement for however many deals the predicate selects.
 *
 *  Per deal: a stage lookup, a pipeline-median lookup, and three lateral reads
 *  over indexes the timeline and the association rail already have. O(d log n)
 *  for d deals, and the median is one grouped pass rather than one per deal. */
const scoreWhere = (tx: Tx, predicate: SQL) =>
  tx.execute<{ id: string }>(sql`
    with median as (
      select pipeline_id, percentile_cont(0.5) within group (order by amount) as amount
        from deal
       where deleted_at is null and amount is not null
       group by pipeline_id
    ),
    parts as (
      select d.id,
             round(coalesce(st.probability, 0) * ${SCORE_WEIGHTS.stage} / 100.0)::int as stage,
             round(${SCORE_WEIGHTS.recency} * (1 - least(1, coalesce(seen.days, ${RECENCY_DAYS})::numeric / ${RECENCY_DAYS})))::int as recency,
             case when d.next_step is not null and d.next_step_date >= current_date then ${SCORE_WEIGHTS.nextStep} else 0 end as next_step,
             case when d.amount is null or m.amount is null or m.amount = 0 then 0
                  else round(${SCORE_WEIGHTS.amount} * least(1, d.amount / m.amount))::int end as amount,
             case when people.n > 0 then ${SCORE_WEIGHTS.contact} else 0 end as contact,
             case when inbound.n > 0 then ${SCORE_WEIGHTS.inbound} else 0 end as inbound
        from deal d
        left join pipeline_stage st on st.id = d.stage_id
        left join median m on m.pipeline_id = d.pipeline_id
        left join lateral (
          select extract(day from now() - max(l.occurred_at))::int as days
            from activity_link l
           where l.entity_type = 'deal' and l.entity_id = d.id
        ) seen on true
        left join lateral (
          select count(*)::int as n from association a
           where (a.from_type = 'deal' and a.from_id = d.id and a.to_type = 'contact')
              or (a.to_type = 'deal' and a.to_id = d.id and a.from_type = 'contact')
        ) people on true
        left join lateral (
          select count(*)::int as n
            from activity_link l
            join activity a on a.id = l.activity_id
           where l.entity_type = 'deal' and l.entity_id = d.id and l.type = 'email'
             and l.occurred_at > now() - make_interval(days => ${INBOUND_DAYS})
             and a.payload ->> 'direction' = 'inbound'
        ) inbound on true
       where d.deleted_at is null and ${predicate}
    )
    update deal
       set score = p.stage + p.recency + p.next_step + p.amount + p.contact + p.inbound,
           score_at = now(),
           score_detail = jsonb_build_object(
             'stage', p.stage, 'recency', p.recency, 'nextStep', p.next_step,
             'amount', p.amount, 'contact', p.contact, 'inbound', p.inbound
           )
      from parts p
     where deal.id = p.id
     returning deal.id`)

/** After a stage change, inside the transaction that made it, so the board the
 *  card lands on is never showing a score for the stage it left. */
export const scoreDeal = async (tx: Tx, dealId: string): Promise<void> => {
  await scoreWhere(tx, sql`d.id = ${dealId}`)
}

/** The nightly pass. Every deal, because five of the six rules move on their own:
 *  a next step falls into the past and a conversation goes quiet without anybody
 *  writing to the record. */
export const scoreAllDeals = async (ctx: AccountContext): Promise<number> =>
  (await withAccount(ctx, (tx) => scoreWhere(tx, sql`true`))).length

export type DealScore = {
  score: number | null
  scoredAt: Date | null
  /** What each rule contributed, missing entries read as zero: a score written by
   *  an older weighting is still worth showing. */
  detail: Partial<Record<ScoreKey, number>>
}

export const readDealScore = async (ctx: AccountContext, dealId: string): Promise<DealScore | null> => {
  const [row] = await withAccount(ctx, (tx) =>
    tx.execute<{ score: number | null; score_at: string | null; score_detail: Record<string, number> | null }>(sql`
      select score, score_at, score_detail from deal where id = ${dealId} and deleted_at is null`),
  )
  if (!row) return null
  return {
    score: row.score === null ? null : Number(row.score),
    scoredAt: row.score_at ? new Date(row.score_at) : null,
    detail: (row.score_detail ?? {}) as Partial<Record<ScoreKey, number>>,
  }
}
