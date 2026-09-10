import { sql, type SQL } from 'drizzle-orm'
import type { AccountContext } from './context.ts'
import { withAccount } from './index.ts'
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
  /** 0 to 100, computed by the nightly job and on a stage change. Null until it
   *  has been computed once. */
  score: number | null
  /** The next open task on the deal, which is what the card's activity chip
   *  offers to change. Null when there is none, and the chip offers to make one. */
  nextTask: { title: string; dueDate: string | null } | null
  /** Up to three associated contacts by name, plus how many there are in total,
   *  so a deal with forty shows three faces and "+37" rather than forty. */
  contacts: string[]
  contactCount: number
  /** The first associated contact with an address, for the card's Email action.
   *  A deal has no address of its own, exactly as on the record page. */
  emailContactId: string | null
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

type BoardInput = {
  pipelineId?: string | null
  filters?: FilterGroup[]
  search?: string
  /** Defaults to stage_id, which is what the deal board has always shown. */
  groupBy?: string | null
}

/** Which field the columns stand for and which deals are on the board at all.
 *  Resolved the same way for the first page and for a "show more", so page two of
 *  a column continues page one instead of reshuffling it. */
const boardShape = async (ctx: AccountContext, input: BoardInput) => {
  const scope = scopeFor(ctx.actorId)
  const registry = await getRegistry(ctx)
  const object = objectOrThrow(registry, 'deal')

  const requested = input.groupBy ?? 'stage_id'
  const candidate = object.byKey.get(requested)
  if (!candidate || !GROUPABLE(candidate)) {
    const names = groupableFields(object).map((field) => field.label).join(', ')
    throw new Error(`A board cannot be grouped by "${requested}". Try one of: ${names}.`)
  }
  const groupBy = fieldOrThrow(object, candidate.key)

  const where: SQL[] = [sql.raw(`"deal"."deleted_at" is null`)]
  if (input.pipelineId) where.push(sql`"deal"."pipeline_id" = ${input.pipelineId}`)
  const filters = compileFilters(object, input.filters ?? [], scope)
  if (filters) where.push(filters)
  if (input.search?.trim()) {
    where.push(sql`"deal"."search" @@ plainto_tsquery('simple', ${input.search.trim()})`)
  }

  return {
    object,
    groupBy,
    groupExpr: fieldExpression(object, groupBy),
    byStage: groupBy.key === 'stage_id',
    predicate: sql.join(where, sql` and `),
  }
}

type CardRow = {
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
  score: number | null
  next_task_title: string | null
  next_task_due: string | null
  contact_names: string[] | null
  contact_count: number
  email_contact_id: string | null
}

/** One window of cards per column. row_number is over the same partition the
 *  footers group by, so a column's cards and its count can never disagree about
 *  which deals belong to it. Ranks are 1-based, so `after` is an offset. */
const readCards = (ctx: AccountContext, groupExpr: SQL, predicate: SQL, after: number, upTo: number) =>
  withAccount(ctx, (tx) => tx.execute<CardRow>(sql`
    select id, group_key, name, amount, currency, close_date, next_step, next_step_date,
           owner_name, company_name, days_in_stage, days_since_activity, score,
           next_task_title, next_task_due, contact_names, contact_count, email_contact_id
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
                  where l."entity_type" = 'deal' and l."entity_id" = "deal"."id"
                    and l."type" = 'stage_change'
               ), "deal"."created_at"))::int as days_in_stage,
               (select extract(day from now() - max(l."occurred_at"))::int
                  from "activity_link" l
                 where l."entity_type" = 'deal' and l."entity_id" = "deal"."id") as days_since_activity,
               "deal"."score" as score,
               task."title" as next_task_title,
               task."due_date"::text as next_task_due,
               people."names" as contact_names,
               coalesce(people."n", 0) as contact_count,
               people."email_contact_id" as email_contact_id,
               row_number() over (
                 partition by ${groupExpr}
                 order by "deal"."close_date" asc nulls last, "deal"."id" desc
               ) as rank
          from "deal"
          left join user_account u on u.id = "deal"."owner_id"
          left join company c on c.id = "deal"."company_id"
          -- Two more lateral reads per visible card, both over an index that
          -- already exists, and both bounded by the window below. A join would
          -- multiply the row instead: a deal with nine tasks and forty contacts
          -- is one card, not three hundred and sixty.
          left join lateral (
            select t."title", t."due_date"
              from "task" t
             where t."entity_type" = 'deal' and t."entity_id" = "deal"."id" and t."status" = 'open'
             order by t."due_date" asc nulls last, t."id" asc
             limit 1
          ) task on true
          left join lateral (
            select count(*)::int as n,
                   (array_agg(named."name" order by named."name"))[1:3] as names,
                   (array_agg(named."id"::text order by named."name")
                      filter (where named."email" is not null))[1] as email_contact_id
              from (
                select p."id", p."email",
                       coalesce(nullif(trim(concat_ws(' ', p."first_name", p."last_name")), ''), p."email", 'Contact') as name
                  from "association" a
                  join "contact" p on p.id = a."to_id"
                 where a."from_type" = 'deal' and a."from_id" = "deal"."id" and a."to_type" = 'contact'
                   and p."deleted_at" is null
                union
                select p."id", p."email",
                       coalesce(nullif(trim(concat_ws(' ', p."first_name", p."last_name")), ''), p."email", 'Contact')
                  from "association" a
                  join "contact" p on p.id = a."from_id"
                 where a."to_type" = 'deal' and a."to_id" = "deal"."id" and a."from_type" = 'contact'
                   and p."deleted_at" is null
              ) named
          ) people on true
         where ${predicate}
      ) ranked
     where rank > ${after} and rank <= ${upTo}`))

const toCard = (object: RegistryObject, card: CardRow): BoardCard => ({
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
  score: card.score === null || card.score === undefined ? null : Number(card.score),
  nextTask: card.next_task_title ? { title: card.next_task_title, dueDate: card.next_task_due } : null,
  contacts: card.contact_names ?? [],
  contactCount: Number(card.contact_count ?? 0),
  emailContactId: card.email_contact_id,
})

/** Two queries for the whole board, whatever the column count: one grouped
 *  aggregate for the footers, one windowed fetch for the visible cards. Counting
 *  and totalling from the loaded cards would be wrong the moment a column has more
 *  than CARDS_PER_COLUMN deals. A5. */
export const readBoard = async (ctx: AccountContext, input: BoardInput): Promise<Board> => {
  const { object, groupBy, groupExpr, byStage, predicate } = await boardShape(ctx, input)

  // The columns a board lays out, and their order. Stage takes them from the
  // pipeline so an empty stage still shows; a select takes them from the
  // registry's own option list for the same reason.
  // Three independent reads, three connections, so the board costs one read's
  // round trips rather than three in a row. See withAccountReads.
  const columnsRead = byStage
    ? withAccount(ctx, async (tx) =>
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

  // Weighting only means anything against a stage's probability, so a board
  // grouped by anything else reports a total and leaves weighted equal to it
  // rather than inventing a percentage.
  const weightedExpr = byStage
    ? sql`coalesce(sum("deal"."amount" * coalesce(s."probability", 0) / 100), 0)::text`
    : sql`coalesce(sum("deal"."amount"), 0)::text`
  const weightJoin = byStage ? sql`left join pipeline_stage s on s.id = "deal"."stage_id"` : sql``

  const totalsRead = withAccount(ctx, (tx) => tx.execute<{
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

  const cardsRead = readCards(ctx, groupExpr, predicate, 0, CARDS_PER_COLUMN)

  const [columnDefs, totals, cards] = await Promise.all([columnsRead, totalsRead, cardsRead])

  const grouped = new Map<string, CardRow[]>()
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
      cards: columnCards.map((card) => toCard(object, card)),
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

/** The next page of one column, which is what "Show more" asks for. Only that
 *  column's deals are ranked, and the totals in its footer stay where they are:
 *  they come from the aggregate, not from what is on screen. */
export const readBoardColumn = async (
  ctx: AccountContext,
  input: BoardInput & { groupKey: string; offset: number },
): Promise<{ cards: BoardCard[]; hasMore: boolean }> => {
  const { object, groupExpr, predicate } = await boardShape(ctx, input)
  const onlyThisColumn = sql.join([predicate, sql`${groupExpr}::text = ${input.groupKey}`], sql` and `)
  // One card past the page, so the button knows whether to stay without a second
  // count query.
  const rows = await readCards(ctx, groupExpr, onlyThisColumn, input.offset, input.offset + CARDS_PER_COLUMN + 1)
  return {
    cards: rows.slice(0, CARDS_PER_COLUMN).map((row) => toCard(object, row)),
    hasMore: rows.length > CARDS_PER_COLUMN,
  }
}
