import { sql, type SQL } from 'drizzle-orm'
import {
  LIST_OPERATORS,
  NULLARY_OPERATORS,
  TYPE_META,
  type Operator,
} from '../registry/types.ts'
import { fieldOrThrow, type RegistryField, type RegistryObject } from './registry.ts'

export type Condition = { field: string; operator: Operator; value?: unknown }
/** One level deep, deliberately. A tree of arbitrary depth is a query builder
 *  nobody can read on screen, and no HubSpot view we are replacing needs one. A5. */
export type FilterGroup = { conjunction: 'and' | 'or'; conditions: Condition[] }
export type Sort = { key: string; direction: 'asc' | 'desc' }
export type Cursor = { value: string | number | null; id: string }

/** Values the caller may not know at save time. A saved view stores the token and
 *  it resolves per request, so "My contacts" means the person reading it. */
export type QueryScope = { userId: string | null; today: string }

export const scopeFor = (userId: string | null, now = new Date()): QueryScope => ({
  userId,
  today: now.toISOString().slice(0, 10),
})

const resolveToken = (value: unknown, scope: QueryScope): unknown => {
  if (value === '@me') return scope.userId
  if (value === '@today') return scope.today
  return value
}

/** A column reference, or the registry's declared cast over the jsonb blob. The
 *  cast is not optional: a number in jsonb sorts as text without it, and the hot
 *  index is built on this exact expression or Postgres will not use it. */
export const fieldExpression = (object: RegistryObject, field: RegistryField): SQL => {
  if (field.storage === 'column') {
    // Identifiers validated in fieldOrThrow, then quoted. Nothing user-typed
    // reaches SQL unquoted anywhere in this file.
    return sql.raw(`"${object.key}"."${field.columnName}"`)
  }
  const meta = TYPE_META[field.type]
  if (meta.jsonbCast === 'jsonb') return sql.raw(`"${object.key}"."custom" -> '${field.key}'`)
  return sql.raw(`("${object.key}"."custom" ->> '${field.key}')::${meta.jsonbCast}`)
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value])

const literal = (value: unknown): SQL => sql`${value}`

const compileCondition = (
  object: RegistryObject,
  condition: Condition,
  scope: QueryScope,
): SQL | null => {
  const field = fieldOrThrow(object, condition.field)
  const operator = condition.operator
  if (!field.operators.includes(operator)) {
    throw new Error(`"${operator}" cannot be used on ${field.label}, which is a ${field.type}.`)
  }

  const expr = fieldExpression(object, field)

  if (NULLARY_OPERATORS.includes(operator)) {
    if (field.storage === 'jsonb') {
      const key = sql.raw(`'${field.key}'`)
      const custom = sql.raw(`"${object.key}"."custom"`)
      return operator === 'is_empty'
        ? sql`(not ${custom} ? ${key} or ${custom} ->> ${key} is null)`
        : sql`(${custom} ? ${key} and ${custom} ->> ${key} is not null)`
    }
    return operator === 'is_empty' ? sql`${expr} is null` : sql`${expr} is not null`
  }

  const raw = resolveToken(condition.value, scope)
  // A token that resolved to nothing (an anonymous caller on an "@me" view) can
  // only match nothing. Saying so is better than quietly dropping the filter.
  if (raw === null || raw === undefined || raw === '') return sql`false`

  if (LIST_OPERATORS.includes(operator)) {
    const values = asList(raw).map((v) => resolveToken(v, scope)).filter((v) => v !== null && v !== undefined && v !== '')
    if (values.length === 0) return sql`false`
    if (operator === 'between') {
      const [from, to] = values
      if (from === undefined || to === undefined) {
        throw new Error(`"between" on ${field.label} needs two values.`)
      }
      return sql`${expr} between ${from} and ${to}`
    }
    const list = sql.join(values.map(literal), sql`, `)
    if (field.type === 'multi_select') {
      // Held as a json array, so membership is containment, not equality.
      const array = sql`to_jsonb(array[${list}]::text[])`
      return operator === 'in'
        ? sql`${expr} ?| array[${list}]::text[]`
        : sql`not coalesce(${expr} ?| array[${list}]::text[], false) or ${array} is null`
    }
    return operator === 'in' ? sql`${expr} in (${list})` : sql`(${expr} is null or ${expr} not in (${list}))`
  }

  switch (operator) {
    case 'is':
      return sql`${expr} = ${raw}`
    case 'is_not':
      // A null is "not X" in every reading a person expects from a filter.
      return sql`(${expr} is null or ${expr} <> ${raw})`
    case 'contains':
      return sql`${expr}::text ilike ${'%' + String(raw) + '%'}`
    case 'not_contains':
      return sql`(${expr} is null or ${expr}::text not ilike ${'%' + String(raw) + '%'})`
    case 'starts_with':
      return sql`${expr}::text ilike ${String(raw) + '%'}`
    case 'gt':
    case 'after':
      return sql`${expr} > ${raw}`
    case 'gte':
    case 'on_or_after':
      return sql`${expr} >= ${raw}`
    case 'lt':
    case 'before':
      return sql`${expr} < ${raw}`
    case 'lte':
    case 'on_or_before':
      return sql`${expr} <= ${raw}`
    default:
      throw new Error(`"${operator}" has no compiler.`)
  }
}

/** Groups are joined by AND, conditions inside a group by that group's conjunction. */
export const compileFilters = (
  object: RegistryObject,
  groups: FilterGroup[],
  scope: QueryScope,
): SQL | undefined => {
  const compiled: SQL[] = []
  for (const group of groups) {
    const parts = group.conditions
      .map((condition) => compileCondition(object, condition, scope))
      .filter((part): part is SQL => part !== null)
    if (parts.length === 0) continue
    compiled.push(sql`(${sql.join(parts, group.conjunction === 'or' ? sql` or ` : sql` and `)})`)
  }
  if (compiled.length === 0) return undefined
  return sql.join(compiled, sql` and `)
}

/** Filters arrive from a URL and from saved-view json, both of which a person can
 *  hand-edit. Anything unrecognised is dropped rather than trusted. */
export const parseFilters = (input: unknown): FilterGroup[] => {
  if (!Array.isArray(input)) return []
  const groups: FilterGroup[] = []
  for (const raw of input) {
    // A bare condition list is accepted and read as one AND group, which is what
    // a saved view written by hand almost always is.
    const source = Array.isArray(raw) ? { conjunction: 'and', conditions: raw } : raw
    if (!source || typeof source !== 'object') continue
    const candidate = source as { conjunction?: unknown; conditions?: unknown; field?: unknown }
    if (typeof candidate.field === 'string') {
      groups.push({ conjunction: 'and', conditions: [candidate as unknown as Condition] })
      continue
    }
    if (!Array.isArray(candidate.conditions)) continue
    const conditions = candidate.conditions.filter(
      (c): c is Condition =>
        !!c && typeof c === 'object' && typeof (c as Condition).field === 'string' && typeof (c as Condition).operator === 'string',
    )
    if (conditions.length === 0) continue
    groups.push({ conjunction: candidate.conjunction === 'or' ? 'or' : 'and', conditions })
  }
  return groups
}

export const parseSorts = (input: unknown): Sort[] => {
  if (!Array.isArray(input)) return []
  return input.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const candidate = raw as { key?: unknown; direction?: unknown }
    if (typeof candidate.key !== 'string') return []
    return [{ key: candidate.key, direction: candidate.direction === 'asc' ? 'asc' : 'desc' }]
  })
}

export type OrderPlan = {
  orderBy: SQL
  keysetWhere: (cursor: Cursor) => SQL
  /** Reads the sort value out of a returned row so the caller can mint the next
   *  cursor without knowing which field the sort was on. */
  cursorValue: string | null
}

const ID = (object: RegistryObject) => sql.raw(`"${object.key}"."id"`)

/** Keyset, never offset: OFFSET 80000 over 88,270 contacts is a table scan.
 *
 *  One sort field plus the id as a tiebreak. NULLS LAST is forced in both
 *  directions so the cursor arithmetic below has exactly one shape to handle;
 *  the cost is that a nullable sort column cannot ride a plain btree index, which
 *  is why the seeded views sort on columns that are never null. */
export const orderPlan = (object: RegistryObject, sorts: Sort[]): OrderPlan => {
  const primary = sorts[0]
  const id = ID(object)

  if (!primary) {
    return {
      orderBy: sql`${id} desc`,
      keysetWhere: (cursor) => sql`${id} < ${cursor.id}`,
      cursorValue: null,
    }
  }

  const field = fieldOrThrow(object, primary.key)
  const expr = fieldExpression(object, field)
  const descending = primary.direction === 'desc'
  const direction = descending ? sql.raw('desc') : sql.raw('asc')

  return {
    orderBy: sql`${expr} ${direction} nulls last, ${id} desc`,
    keysetWhere: (cursor) => {
      if (cursor.value === null) return sql`(${expr} is null and ${id} < ${cursor.id})`
      const beyond = descending ? sql`${expr} < ${cursor.value}` : sql`${expr} > ${cursor.value}`
      return sql`(${beyond} or ${expr} is null or (${expr} = ${cursor.value} and ${id} < ${cursor.id}))`
    },
    cursorValue: field.key,
  }
}
