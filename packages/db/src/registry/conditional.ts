import { OPERATORS, type Operator } from './types.ts'

/** Conditional property logic: a property is not on the record until the rule on
 *  it matches the record's other values.
 *
 *  The rule is one group of conditions over sibling properties, which is exactly
 *  what the filter builder already produces and what a segment already stores, so
 *  the editor is that component and nothing new has to be learned to read one.
 *  One level, like the builder: a tree of arbitrary depth is a rules engine.
 *
 *  Evaluated in the browser as somebody types, so it takes plain values and
 *  reaches nothing. HubSpot enforces the same rule wherever a record is created
 *  or edited by hand, and not where a job writes; a hidden property here is
 *  hidden from the panel, never from the import or the API. */

export type FieldCondition = { field: string; operator: Operator; value?: unknown }
export type Conditional = { conjunction: 'and' | 'or'; conditions: FieldCondition[] }

const OPERATOR_SET = new Set<string>(OPERATORS)

/** A stored rule as a rule, or null when the column holds anything else. Written
 *  from jsonb, which means it can hold whatever an older shape put there. */
export const readConditional = (raw: unknown): Conditional | null => {
  if (!raw || typeof raw !== 'object') return null
  const group = raw as { conjunction?: unknown; conditions?: unknown }
  if (!Array.isArray(group.conditions)) return null
  const conditions = group.conditions.flatMap((entry): FieldCondition[] => {
    const condition = entry as { field?: unknown; operator?: unknown; value?: unknown }
    if (typeof condition.field !== 'string' || typeof condition.operator !== 'string') return []
    if (!OPERATOR_SET.has(condition.operator)) return []
    return [{ field: condition.field, operator: condition.operator as Operator, value: condition.value }]
  })
  if (conditions.length === 0) return null
  return { conjunction: group.conjunction === 'or' ? 'or' : 'and', conditions }
}

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry ?? '')) : [String(value ?? '')]

const asNumber = (value: unknown): number => Number(typeof value === 'string' ? value.trim() : value)

/** Text for the comparisons a person means by "is": a select stores its option,
 *  a relation its id, a date its ISO string, and all three are compared as typed. */
const asText = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value ?? '').trim()

const matchesCondition = (condition: FieldCondition, values: Record<string, unknown>): boolean => {
  const actual = values[condition.field]
  const held = Array.isArray(actual) ? actual.map(asText) : [asText(actual)]
  const empty = held.every((entry) => entry === '')
  if (condition.operator === 'is_empty') return empty
  if (condition.operator === 'is_not_empty') return !empty
  if (empty) return false

  const wanted = asList(condition.value).map((entry) => entry.trim())
  const [first = ''] = wanted
  const lower = held.map((entry) => entry.toLowerCase())
  const wantedLower = first.toLowerCase()

  switch (condition.operator) {
    case 'is':
      return lower.includes(wantedLower)
    case 'is_not':
      return !lower.includes(wantedLower)
    case 'contains':
      return lower.some((entry) => entry.includes(wantedLower))
    case 'not_contains':
      return !lower.some((entry) => entry.includes(wantedLower))
    case 'starts_with':
      return lower.some((entry) => entry.startsWith(wantedLower))
    case 'in':
      return wanted.some((entry) => lower.includes(entry.toLowerCase()))
    case 'not_in':
      return !wanted.some((entry) => lower.includes(entry.toLowerCase()))
    case 'between': {
      const [from, to] = wanted
      const n = asNumber(held[0])
      return Number.isFinite(n) && n >= asNumber(from) && n <= asNumber(to)
    }
    // Numbers and dates both compare on one axis: a date is compared as time, a
    // number as itself, and a value that is neither never matches a comparison.
    default: {
      const left = comparable(held[0])
      const right = comparable(first)
      if (left === null || right === null) return false
      if (condition.operator === 'gt' || condition.operator === 'after') return left > right
      if (condition.operator === 'gte' || condition.operator === 'on_or_after') return left >= right
      if (condition.operator === 'lt' || condition.operator === 'before') return left < right
      return left <= right
    }
  }
}

const comparable = (value: string | undefined): number | null => {
  if (value === undefined || value === '') return null
  const asNum = Number(value)
  if (Number.isFinite(asNum)) return asNum
  const asTime = Date.parse(value)
  return Number.isNaN(asTime) ? null : asTime
}

/** Whether a property with this rule belongs on the record, given its values.
 *  No rule means yes, which is what a property without one is. */
export const matchesConditional = (raw: unknown, values: Record<string, unknown>): boolean => {
  const rule = readConditional(raw)
  if (!rule) return true
  return rule.conjunction === 'or'
    ? rule.conditions.some((condition) => matchesCondition(condition, values))
    : rule.conditions.every((condition) => matchesCondition(condition, values))
}

/** What a rule cannot do, said at save time rather than discovered when a
 *  property never appears. A property conditioned on itself can never be shown,
 *  and one conditioned on a field that is not on the object never matches. */
export const conditionalBlocker = (
  rule: Conditional,
  ownKey: string,
  fieldKeys: ReadonlySet<string>,
): string | null => {
  for (const condition of rule.conditions) {
    if (condition.field === ownKey) return 'A property cannot be shown based on its own value.'
    if (!fieldKeys.has(condition.field)) {
      return `"${condition.field}" is not a property on this object, so the rule could never match.`
    }
  }
  return null
}
