import { isDateRange } from '@rawr/db/registry'
import type { Condition, Group } from './filter-builder.tsx'

export const NULLARY = new Set(['is_empty', 'is_not_empty'])
/** Operators whose value is a list rather than a scalar. The compiler has always
 *  read these as arrays (dal/query.ts, LIST_OPERATORS); the builder only ever
 *  produced one value, so "is between" reached Postgres missing its upper bound
 *  and threw, and "is any of" could only ever name one option. */
export const RANGE = 'between'
export const MULTI = new Set(['in', 'not_in'])

/** A condition's value as the list the compiler expects, whatever shape it is in
 *  now: a saved view predates this and holds a scalar. */
export const asList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((entry) => (entry === null || entry === undefined ? '' : String(entry)))
  if (value === null || value === undefined || value === '') return []
  return [String(value)]
}

const DAY_START = /^\d{4}-\d{2}-\d{2}/

/** From after To, on a date or a datetime. A day "to" runs to its end, so a From on
 *  that same day still fits. Only dates start with a day, so numbers and text never
 *  count as reversed. */
export const isReversed = (condition: Condition): boolean => {
  if (condition.operator !== RANGE || isDateRange(condition.value)) return false
  const [from = '', to = ''] = asList(condition.value)
  if (!DAY_START.test(from) || !DAY_START.test(to)) return false
  return from.slice(0, 10) > to.slice(0, 10) || (from.length > 10 && to.length > 10 && from > to)
}

/** Complete means every part is filled: both ends of a range, at least one
 *  member of a list. `String([ '', '' ])` is "," which is not empty, so the old
 *  check would have waved a half-finished range through. A reversed range is not
 *  complete either: it would match nothing, so every form refuses to save it. */
export const isComplete = (condition: Condition): boolean => {
  if (NULLARY.has(condition.operator)) return true
  if (condition.operator === RANGE && isDateRange(condition.value)) return true
  const values = asList(condition.value)
  if (condition.operator === RANGE) return values.length === 2 && values.every((entry) => entry !== '') && !isReversed(condition)
  if (MULTI.has(condition.operator)) return values.length > 0 && values.every((entry) => entry !== '')
  return values.length > 0 && values[0] !== ''
}

/** Whether every condition has its values. A live builder reports an unfinished
 *  row too, so the caller checks this before it saves. */
export const groupsComplete = (groups: Group[]): boolean =>
  groups.every((group) => group.conditions.every(isComplete))

/** Keeps the conditions on a field the object still has, and returns the label of
 *  each one dropped. A condition on a missing field would show a blank operator
 *  under some other field's name, so it cannot stay. Groups left empty are dropped
 *  too, which is how the builder itself writes them. */
export const pruneGroups = (
  groups: Group[],
  keys: Set<string>,
  labels: Map<string, string>,
): { groups: Group[]; removed: string[] } => {
  const removed: string[] = []
  const kept = groups.flatMap((group) => {
    const conditions = group.conditions.filter((condition) => {
      if (keys.has(condition.field)) return true
      removed.push(labels.get(condition.field) ?? condition.field)
      return false
    })
    return conditions.length > 0 ? [{ ...group, conditions }] : []
  })
  return { groups: kept, removed }
}
