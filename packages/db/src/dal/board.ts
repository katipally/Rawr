import { sql, type SQL } from 'drizzle-orm'
import type { WorkspaceContext } from './context.ts'
import { withWorkspace } from './index.ts'
import { compileFilters, fieldExpression, scopeFor, type FilterGroup } from './query.ts'
import { displayName } from './records.ts'
import { fieldOrThrow, getRegistryIn, objectOrThrow } from './registry.ts'

export type BoardCard = {
  id: string
  displayName: string
  amount: string | null
  currency: string
  closeDate: string | null
  ownerName: string | null
  companyName: string | null
  nextStep: string | null
  nextStepDate: string | null
}

export type BoardColumn = {
  key: string
  name: string
  probability: number | null
  count: number
  /** Per currency, never summed across them. A mixed board shows subtotals rather
   *  than one wrong number. */
  totals: { currency: string; total: string; weighted: string }[]
  cards: BoardCard[]
  hasMore: boolean
}

export type Board = {
  groupByKey: string
  columns: BoardColumn[]
  /** Deals whose group value is set to something no longer on the board. */
  unassigned: number
}

const CARDS_PER_COLUMN = 50

/** Two queries for the whole board, whatever the column count: one grouped
 *  aggregate for the footers, one windowed fetch for the visible cards. Counting
 *  and totalling from the loaded cards would be wrong the moment a column has more
 *  than CARDS_PER_COLUMN deals. A5. */
export const readBoard = async (
  ctx: WorkspaceContext,
  input: { pipelineId?: string | null; filters?: FilterGroup[]; search?: string },
): Promise<Board> => {
  const scope = scopeFor(ctx.actorId)

  return withWorkspace(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, 'deal')
    const groupBy = fieldOrThrow(object, 'stage_id')
    const groupExpr = fieldExpression(object, groupBy)

    const stages = await tx.execute<{
      id: string
      name: string
      probability: string | null
      pipeline_id: string
    }>(sql`
      select s.id, s.name, s.probability, s.pipeline_id
        from pipeline_stage s
        ${input.pipelineId ? sql`where s.pipeline_id = ${input.pipelineId}` : sql``}
       order by s.position asc`)

    const where: SQL[] = [sql.raw(`"deal"."deleted_at" is null`)]
    if (input.pipelineId) where.push(sql`"deal"."pipeline_id" = ${input.pipelineId}`)
    const filters = compileFilters(object, input.filters ?? [], scope)
    if (filters) where.push(filters)
    if (input.search?.trim()) {
      where.push(sql`"deal"."search" @@ plainto_tsquery('simple', ${input.search.trim()})`)
    }
    const predicate = sql.join(where, sql` and `)

    const totals = await tx.execute<{
      stage_id: string
      currency: string
      n: number
      total: string | null
      weighted: string | null
    }>(sql`
      select ${groupExpr} as stage_id,
             "deal"."currency" as currency,
             count(*)::int as n,
             coalesce(sum("deal"."amount"), 0)::text as total,
             coalesce(sum("deal"."amount" * coalesce(s."probability", 0) / 100), 0)::text as weighted
        from "deal"
        left join pipeline_stage s on s.id = "deal"."stage_id"
       where ${predicate}
       group by 1, 2`)

    // row_number over the same partition the footers group by, so a column's cards
    // and its count can never disagree about which deals belong to it.
    const cards = await tx.execute<{
      id: string
      stage_id: string
      name: string | null
      amount: string | null
      currency: string
      close_date: string | null
      next_step: string | null
      next_step_date: string | null
      owner_name: string | null
      company_name: string | null
    }>(sql`
      select id, stage_id, name, amount, currency, close_date, next_step, next_step_date,
             owner_name, company_name
        from (
          select "deal"."id" as id,
                 ${groupExpr} as stage_id,
                 "deal"."name" as name,
                 "deal"."amount"::text as amount,
                 "deal"."currency" as currency,
                 "deal"."close_date"::text as close_date,
                 "deal"."next_step" as next_step,
                 "deal"."next_step_date"::text as next_step_date,
                 u."name" as owner_name,
                 coalesce(c."name", c."domain") as company_name,
                 row_number() over (
                   partition by ${groupExpr}
                   order by "deal"."close_date" asc nulls last, "deal"."id" desc
                 ) as rank
            from "deal"
            left join user_account u on u.id = "deal"."owner_id"
            left join company c on c.id = "deal"."company_id"
           where ${predicate}
        ) ranked
       where rank <= ${CARDS_PER_COLUMN}`)

    type Card = (typeof cards)[number]
    const byStage = new Map<string, Card[]>()
    for (const card of cards) {
      const bucket = byStage.get(card.stage_id)
      if (bucket) bucket.push(card)
      else byStage.set(card.stage_id, [card])
    }

    const known = new Set(stages.map((stage) => stage.id))
    const columns: BoardColumn[] = stages.map((stage) => {
      const rows = totals.filter((row) => row.stage_id === stage.id)
      const stageCards = byStage.get(stage.id) ?? []
      const count = rows.reduce((sum, row) => sum + Number(row.n), 0)
      return {
        key: stage.id,
        name: stage.name,
        probability: stage.probability === null ? null : Number(stage.probability),
        count,
        totals: rows.map((row) => ({
          currency: row.currency,
          total: row.total ?? '0',
          weighted: row.weighted ?? '0',
        })),
        hasMore: count > stageCards.length,
        cards: stageCards.map((card) => ({
          id: card.id,
          displayName: displayName('deal', { name: card.name }),
          amount: card.amount,
          currency: card.currency,
          closeDate: card.close_date,
          ownerName: card.owner_name,
          companyName: card.company_name,
          nextStep: card.next_step,
          nextStepDate: card.next_step_date,
        })),
      }
    })

    return {
      groupByKey: groupBy.key,
      columns,
      unassigned: totals
        .filter((row) => !known.has(row.stage_id))
        .reduce((sum, row) => sum + Number(row.n), 0),
    }
  })
}
