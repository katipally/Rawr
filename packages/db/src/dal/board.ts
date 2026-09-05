import { sql, type SQL } from 'drizzle-orm'
import type { WorkspaceContext } from './context.ts'
import { withWorkspace } from './index.ts'
import { compileFilters, fieldExpression, scopeFor, type FilterGroup } from './query.ts'
import { displayName } from './records.ts'
import { fieldOrThrow, getRegistry, objectOrThrow, type RegistryField, type RegistryObject } from './registry.ts'

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
  /** Days since this deal last moved stage, or since it was created if it never
   *  has. Derived from the stage_change activity the move already writes, so
   *  nothing new is stored to answer it. */
  daysInStage: number
  /** When anything last happened on it, in days. Null when nothing ever has. */
  daysSinceActivity: number | null
}

export type BoardColumn = {
  key: string
  name: string
  /** Only a pipeline stage carries one. Any other grouping has no weighting. */
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
  groupByLabel: string
  /** Every field this board could be grouped by, so the picker is the registry's
   *  answer rather than a hardcoded list. A5. */
  groupableFields: { key: string; label: string }[]
  columns: BoardColumn[]
  /** Deals whose group value is set to something no longer on the board. */
  unassigned: number
}

const CARDS_PER_COLUMN = 50

/** A board groups by exactly one field. Stage is the default and the only one that
 *  can weight a total, because probability is a property of a pipeline stage and
 *  of nothing else. Any select field is groupable: "by deal type" and "by product
 *  of interest" are boards somebody will want, and the registry already knows both
 *  their values and their labels. A5. */
const GROUPABLE = (field: RegistryField): boolean =>
  field.key === 'stage_id' || field.type === 'select'

export const groupableFields = (object: RegistryObject): { key: string; label: string }[] =>
  object.fields.filter(GROUPABLE).map((field) => ({ key: field.key, label: field.label }))

/** Two queries for the whole board, whatever the column count: one grouped
 *  aggregate for the footers, one windowed fetch for the visible cards. Counting
 *  and totalling from the loaded cards would be wrong the moment a column has more
 *  than CARDS_PER_COLUMN deals. A5. */
export const readBoard = async (
  ctx: WorkspaceContext,
  input: {
    pipelineId?: string | null
    filters?: FilterGroup[]
    search?: string
    /** Defaults to stage_id, which is what the deal board has always shown. */
    groupBy?: string | null
  },
): Promise<Board> => {
  const scope = scopeFor(ctx.actorId)

  const registry = await getRegistry(ctx)
  const object = objectOrThrow(registry, 'deal')
  {
    const requested = input.groupBy ?? 'stage_id'
    const candidate = object.byKey.get(requested)
    if (!candidate || !GROUPABLE(candidate)) {
      const names = groupableFields(object).map((field) => field.label).join(', ')
      throw new Error(`A board cannot be grouped by "${requested}". Try one of: ${names}.`)
    }
    const groupBy = fieldOrThrow(object, candidate.key)
    const groupExpr = fieldExpression(object, groupBy)
    const byStage = groupBy.key === 'stage_id'

    // The columns a board lays out, and their order. Stage takes them from the
    // pipeline so an empty stage still shows; a select takes them from the
    // registry's own option list for the same reason.
    // Three independent reads, three connections, so the board costs one read's
    // round trips rather than three in a row. See withWorkspaceReads.
    const columnsRead = byStage
      ? withWorkspace(ctx, async (tx) =>
          (
            await tx.execute<{ id: string; name: string; probability: string | null }>(sql`
              select s.id, s.name, s.probability
                from pipeline_stage s
                ${input.pipelineId ? sql`where s.pipeline_id = ${input.pipelineId}` : sql``}
               order by s.position asc`)
          ).map((stage) => ({
            key: stage.id,
            name: stage.name,
            probability: stage.probability === null ? null : Number(stage.probability),
          })),
        )
      : Promise.resolve(groupBy.options.map((option) => ({ key: option, name: option, probability: null })))

    const where: SQL[] = [sql.raw(`"deal"."deleted_at" is null`)]
    if (input.pipelineId) where.push(sql`"deal"."pipeline_id" = ${input.pipelineId}`)
    const filters = compileFilters(object, input.filters ?? [], scope)
    if (filters) where.push(filters)
    if (input.search?.trim()) {
      where.push(sql`"deal"."search" @@ plainto_tsquery('simple', ${input.search.trim()})`)
    }
    const predicate = sql.join(where, sql` and `)

    // Weighting only means anything against a stage's probability, so a board
    // grouped by anything else reports a total and leaves weighted equal to it
    // rather than inventing a percentage.
    const weightedExpr = byStage
      ? sql`coalesce(sum("deal"."amount" * coalesce(s."probability", 0) / 100), 0)::text`
      : sql`coalesce(sum("deal"."amount"), 0)::text`
    const weightJoin = byStage ? sql`left join pipeline_stage s on s.id = "deal"."stage_id"` : sql``

    const totalsRead = withWorkspace(ctx, (tx) => tx.execute<{
      group_key: string | null
      currency: string
      n: number
      total: string | null
      weighted: string | null
    }>(sql`
      select ${groupExpr} as group_key,
             "deal"."currency" as currency,
             count(*)::int as n,
             coalesce(sum("deal"."amount"), 0)::text as total,
             ${weightedExpr} as weighted
        from "deal"
        ${weightJoin}
       where ${predicate}
       group by 1, 2`))

    // row_number over the same partition the footers group by, so a column's cards
    // and its count can never disagree about which deals belong to it.
    const cardsRead = withWorkspace(ctx, (tx) => tx.execute<{
      id: string
      group_key: string | null
      name: string | null
      amount: string | null
      currency: string
      close_date: string | null
      next_step: string | null
      next_step_date: string | null
      owner_name: string | null
      company_name: string | null
      days_in_stage: number
      days_since_activity: number | null
    }>(sql`
      select id, group_key, name, amount, currency, close_date, next_step, next_step_date,
             owner_name, company_name, days_in_stage, days_since_activity
        from (
          select "deal"."id" as id,
                 ${groupExpr} as group_key,
                 "deal"."name" as name,
                 "deal"."amount"::text as amount,
                 "deal"."currency" as currency,
                 "deal"."close_date"::text as close_date,
                 "deal"."next_step" as next_step,
                 "deal"."next_step_date"::text as next_step_date,
                 u."name" as owner_name,
                 coalesce(c."name", c."domain") as company_name,
                 -- Two correlated reads per visible card, capped at fifty per
                 -- column by the window below, over the index the timeline already
                 -- has. Not a join: a deal with four hundred activities would
                 -- multiply every row of the board.
                 extract(day from now() - coalesce((
                   select max(l."occurred_at") from "activity_link" l
                     join "activity" a on a.id = l."activity_id"
                    where l."entity_type" = 'deal' and l."entity_id" = "deal"."id"
                      and a."type" = 'stage_change'
                 ), "deal"."created_at"))::int as days_in_stage,
                 (select extract(day from now() - max(l."occurred_at"))::int
                    from "activity_link" l
                   where l."entity_type" = 'deal' and l."entity_id" = "deal"."id") as days_since_activity,
                 row_number() over (
                   partition by ${groupExpr}
                   order by "deal"."close_date" asc nulls last, "deal"."id" desc
                 ) as rank
            from "deal"
            left join user_account u on u.id = "deal"."owner_id"
            left join company c on c.id = "deal"."company_id"
           where ${predicate}
        ) ranked
       where rank <= ${CARDS_PER_COLUMN}`))

    const [columnDefs, totals, cards] = await Promise.all([columnsRead, totalsRead, cardsRead])

    type Card = (typeof cards)[number]
    const grouped = new Map<string, Card[]>()
    for (const card of cards) {
      const key = card.group_key ?? ''
      const bucket = grouped.get(key)
      if (bucket) bucket.push(card)
      else grouped.set(key, [card])
    }

    const known = new Set(columnDefs.map((column) => column.key))
    const columns: BoardColumn[] = columnDefs.map((column) => {
      const rows = totals.filter((row) => row.group_key === column.key)
      const columnCards = grouped.get(column.key) ?? []
      const count = rows.reduce((sum, row) => sum + Number(row.n), 0)
      return {
        key: column.key,
        name: column.name,
        probability: column.probability,
        count,
        totals: rows.map((row) => ({
          currency: row.currency,
          total: row.total ?? '0',
          weighted: row.weighted ?? '0',
        })),
        hasMore: count > columnCards.length,
        cards: columnCards.map((card) => ({
          id: card.id,
          displayName: displayName(object, { name: card.name }),
          amount: card.amount,
          currency: card.currency,
          closeDate: card.close_date,
          ownerName: card.owner_name,
          companyName: card.company_name,
          nextStep: card.next_step,
          nextStepDate: card.next_step_date,
          daysInStage: Number(card.days_in_stage ?? 0),
          daysSinceActivity:
            card.days_since_activity === null || card.days_since_activity === undefined
              ? null
              : Number(card.days_since_activity),
        })),
      }
    })

    return {
      groupByKey: groupBy.key,
      groupByLabel: groupBy.label,
      groupableFields: groupableFields(object),
      columns,
      // Includes deals with no value at all for the grouping field, which is a real
      // state for a select and is never a state for a stage.
      unassigned: totals
        .filter((row) => row.group_key === null || !known.has(row.group_key))
        .reduce((sum, row) => sum + Number(row.n), 0),
    }
  }
}
