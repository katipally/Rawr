import { dateRangeLabel, isDateRange } from '@rawr/db/registry'
import type { Choice } from './field-input.tsx'
import type { Condition } from './filter-builder.tsx'

export const valuesOf = (condition: Condition | undefined): string[] => {
  const value = condition?.value
  if (Array.isArray(value)) return value.map(String)
  return value === null || value === undefined || value === '' ? [] : [String(value)]
}

/** The words a quick filter's chip shows for one condition. Every operator the
 *  filter engine has is spelled out here, so a chip never falls back to a
 *  generic word. `day` formats a date value and is the identity for anything else. */
export const summarize = (condition: Condition, options: Choice[], day: (value: string) => string): string => {
  const values = valuesOf(condition)
  const name = (id: string | undefined): string => options.find((option) => option.id === id)?.label ?? id ?? ''
  const first = name(values[0])
  const more = values.length > 1 ? ` +${values.length - 1}` : ''
  const text = values[0] ?? ''
  switch (condition.operator) {
    case 'is':
      return first
    case 'is_not':
      return `Not ${first}`
    case 'in':
      return `${first}${more}`
    case 'not_in':
      return `Not ${first}${more}`
    case 'contains':
      return `“${text}”`
    case 'not_contains':
      return `Not “${text}”`
    case 'starts_with':
      return `Starts “${text}”`
    case 'is_empty':
      return 'Empty'
    case 'is_not_empty':
      return 'Not empty'
    case 'gt':
      return `Over ${text}`
    case 'gte':
      return `${text} or more`
    case 'lt':
      return `Under ${text}`
    case 'lte':
      return `${text} or less`
    case 'between':
      return isDateRange(condition.value)
        ? dateRangeLabel(condition.value)
        : `${day(values[0] ?? '')} to ${day(values[1] ?? '')}`
    case 'before':
      return `Before ${day(text)}`
    case 'after':
      return `After ${day(text)}`
    case 'on_or_before':
      return `Up to ${day(text)}`
    case 'on_or_after':
      return text === '@today' ? 'Today' : `Since ${day(text)}`
  }
}
