'use client'

import { DATE_RANGES, dateRangeLabel, isDateRange } from '@rawr/db/registry'
import { Button, Select, TextInput, cn } from '@rawr/ui'
import { useState } from 'react'
import type { Operator } from '@rawr/db'
import { MULTI, NULLARY, RANGE, asList, groupsComplete, isComplete, isReversed } from './filter-rules.ts'

export type FilterField = {
  key: string
  label: string
  type: string
  options: string[]
  operators: readonly Operator[]
  /** Names for the ids a user or configuration field stores, where the caller has them. */
  choices?: { id: string; label: string }[]
}

export type Condition = { field: string; operator: Operator; value?: unknown }
export type Group = { conjunction: 'and' | 'or'; conditions: Condition[] }

const OPERATOR_LABELS: Record<string, string> = {
  is: 'is',
  is_not: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  in: 'is any of',
  not_in: 'is none of',
  before: 'is before',
  after: 'is after',
  on_or_before: 'is on or before',
  on_or_after: 'is on or after',
}

const INCOMPLETE = 'Every condition needs its values: both ends of a range, at least one of a list.'
const REVERSED = 'From is after To.'

const problem = (groups: Group[]): string | null =>
  groups.some((group) => group.conditions.some(isReversed)) ? REVERSED : groupsComplete(groups) ? null : INCOMPLETE

/** What an operator's value starts as when the operator changes, so a range is
 *  never half a range and a list is never a bare string. */
const emptyValueFor = (operator: string): unknown =>
  operator === RANGE ? ['', ''] : MULTI.has(operator) ? [] : ''

/** One condition as a sentence, "Lifecycle stage is any of Lead, MQL", for a
 *  page that shows a segment's rule without opening the builder. */
export const describeCondition = (fields: FilterField[], condition: Condition): string => {
  const field = fields.find((entry) => entry.key === condition.field)
  const label = field?.label ?? condition.field
  const operator = OPERATOR_LABELS[condition.operator] ?? condition.operator
  if (NULLARY.has(condition.operator)) return `${label} ${operator}`
  if (isDateRange(condition.value)) return `${label} is ${dateRangeLabel(condition.value).toLowerCase()}`
  const names = new Map(field?.choices?.map((choice) => [choice.id, choice.label]))
  const values = asList(condition.value).map((entry) => (entry === '@me' ? 'me' : (names.get(entry) ?? entry)))
  const value = condition.operator === RANGE ? values.join(' and ') : values.join(', ')
  return `${label} ${operator} ${value}`
}

/** A datetime is picked by its day here: a time is typed in the URL or the API, and
 *  a range is whole days (both ends inclusive) unless it carries one. */
const inputTypeFor = (type: string): string => {
  if (type === 'date' || type === 'datetime') return 'date'
  if (type === 'number' || type === 'currency' || type === 'percent' || type === 'rating') return 'number'
  return 'text'
}

export type FilterBuilderProps = {
  fields: FilterField[]
  value: Group[]
  /** Set where the builder is part of a form: every edit is reported at once and
   *  there is no Apply. An unfinished row is reported too, so the form checks
   *  `groupsComplete` before it saves. */
  onChange?: (groups: Group[]) => void
  /** Set where the builder is a popover that commits its draft on Apply. */
  onApply?: (groups: Group[]) => void
  /** Omitted where the builder is part of a form rather than a popover: there is
   *  nothing to close, and a Close button that does nothing is worse than none. */
  onClose?: () => void
  /** A property's rule is one group, so the builder offers no second one. */
  singleGroup?: boolean
  /** Offers HubSpot's rolling ranges on a date "is between". Only where the
   *  filter compiles to SQL, which is what resolves them on the day it runs. */
  relativeDates?: boolean
  className?: string
}

/** The right-hand side of one condition. Three shapes rather than one, because
 *  three is what the operators actually mean: a range needs both ends, a list
 *  needs however many the person picks, and everything else is a single value. */
const ValueControl = ({
  field,
  condition,
  relativeDates,
  onChange,
}: {
  field: FilterField | undefined
  condition: Condition
  relativeDates: boolean
  onChange: (value: unknown) => void
}) => {
  const values = asList(condition.value)
  const inputType = inputTypeFor(field?.type ?? 'text')

  if (condition.operator === RANGE) {
    const [from = '', to = ''] = values
    const rolling = isDateRange(condition.value) ? condition.value : ''
    const span =
      relativeDates && (field?.type === 'date' || field?.type === 'datetime') ? (
        <Select
          aria-label="Range"
          value={rolling}
          onChange={(event) => onChange(event.target.value || ['', ''])}
          className="w-auto min-w-40 flex-1"
        >
          <option value="">Custom dates</option>
          {DATE_RANGES.map((range) => (
            <option key={range.token} value={range.token}>
              {range.label}
            </option>
          ))}
        </Select>
      ) : null
    if (rolling) return span
    return (
      <div className="flex w-auto min-w-40 flex-1 flex-wrap items-center gap-2">
        {span}
        <TextInput
          aria-label="From"
          type={inputType}
          value={from}
          onChange={(event) => onChange([event.target.value, to])}
          className="min-w-0 flex-1"
        />
        <span className="shrink-0 text-secondary">and</span>
        <TextInput
          aria-label="To"
          type={inputType}
          value={to}
          onChange={(event) => onChange([from, event.target.value])}
          className="min-w-0 flex-1"
        />
      </div>
    )
  }

  if (MULTI.has(condition.operator)) {
    // A native multiple select: no new component, and every browser already
    // teaches its own way to add a second one.
    if (field && field.options.length > 0) {
      return (
        <Select
          aria-label="Values"
          multiple
          size={Math.min(field.options.length, 4)}
          value={values}
          onChange={(event) =>
            onChange([...event.target.selectedOptions].map((option) => option.value))
          }
          className="h-auto w-auto min-w-40 flex-1 py-1"
        >
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      )
    }
    return (
      <TextInput
        aria-label="Values, separated by commas"
        placeholder="one, two, three"
        value={values.join(', ')}
        onChange={(event) =>
          onChange(event.target.value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))
        }
        className="w-auto min-w-40 flex-1"
      />
    )
  }

  if (field && field.options.length > 0) {
    return (
      <Select
        aria-label="Value"
        value={values[0] ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className="w-auto min-w-40 flex-1"
      >
        <option value="">Pick one</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    )
  }

  return (
    <TextInput
      aria-label="Value"
      type={inputType}
      value={values[0] ?? ''}
      onChange={(event) => onChange(event.target.value)}
      className="w-auto min-w-40 flex-1"
    />
  )
}

/** AND/OR groups, one level deep. A5 draws the line there on purpose: a tree of
 *  arbitrary depth is a query builder nobody can read on screen. */
export const FilterBuilder = ({ fields, value, onChange, onApply, onClose, singleGroup = false, relativeDates = false, className }: FilterBuilderProps) => {
  const [groups, setGroups] = useState<Group[]>(
    value.length > 0 ? value : [{ conjunction: 'and', conditions: [] }],
  )
  const [error, setError] = useState<string | null>(null)

  const fieldFor = (key: string) => fields.find((field) => field.key === key)

  const edit = (next: Group[]) => {
    setGroups(next)
    onChange?.(next.filter((group) => group.conditions.length > 0))
  }

  const patch = (groupIndex: number, next: Partial<Group>) =>
    edit(groups.map((group, i) => (i === groupIndex ? { ...group, ...next } : group)))

  const patchCondition = (groupIndex: number, conditionIndex: number, next: Partial<Condition>) =>
    edit(
      groups.map((group, i) =>
        i === groupIndex
          ? {
              ...group,
              conditions: group.conditions.map((condition, j) =>
                j === conditionIndex ? { ...condition, ...next } : condition,
              ),
            }
          : group,
      ),
    )

  const addCondition = (groupIndex: number) => {
    const first = fields[0]
    if (!first) return
    edit(
      groups.map((group, i) =>
        i === groupIndex
          ? {
              ...group,
              conditions: [
                ...group.conditions,
                {
                  field: first.key,
                  operator: first.operators[0] ?? 'is',
                  value: emptyValueFor(first.operators[0] ?? 'is'),
                },
              ],
            }
          : group,
      ),
    )
  }

  const message = onChange ? problem(groups) : error

  const apply = () => {
    if (groups.some((group) => group.conditions.some(isReversed))) {
      setError(REVERSED)
      return
    }
    // Kept aligned with `groups` while the check runs. Dropping the empty groups
    // first and then indexing `cleaned[i]` against `groups` compares one group's
    // conditions with a different group's, so a missing value went unreported.
    const trimmed = groups.map((group) => ({
      ...group,
      conditions: group.conditions.filter(isComplete),
    }))

    const incomplete = trimmed.some(
      (group, i) => group.conditions.length < (groups[i]?.conditions.length ?? 0),
    )
    if (incomplete) {
      setError(INCOMPLETE)
      return
    }
    onApply?.(trimmed.filter((group) => group.conditions.length > 0))
  }

  const clearAll = () => (onApply ? onApply([]) : edit([{ conjunction: 'and', conditions: [] }]))

  return (
    <div className={cn('flex flex-col gap-3 rounded-panel border border-line bg-surface p-3 shadow-panel', className)}>
      {groups.map((group, groupIndex) => (
        <div key={groupIndex} className="flex flex-col gap-2 rounded-hs border border-divider p-2">
          {group.conditions.map((condition, conditionIndex) => {
            const field = fieldFor(condition.field)
            const takesValue = !NULLARY.has(condition.operator)
            return (
              <div key={conditionIndex} className="flex flex-wrap items-center gap-2">
                {conditionIndex > 0 ? (
                  <Select
                    aria-label="Join with the condition above"
                    value={group.conjunction}
                    onChange={(event) =>
                      patch(groupIndex, { conjunction: event.target.value as 'and' | 'or' })
                    }
                    className="w-24"
                  >
                    <option value="and">and</option>
                    <option value="or">or</option>
                  </Select>
                ) : (
                  <span className="w-24 text-secondary">where</span>
                )}

                <Select
                  aria-label="Field"
                  value={condition.field}
                  onChange={(event) => {
                    const next = fieldFor(event.target.value)
                    const operator = next?.operators[0] ?? 'is'
                    patchCondition(groupIndex, conditionIndex, {
                      field: event.target.value,
                      operator,
                      value: emptyValueFor(operator),
                    })
                  }}
                  className="w-auto min-w-40 flex-1"
                >
                  {fields.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </Select>

                <Select
                  aria-label="Operator"
                  value={condition.operator}
                  onChange={(event) => {
                    const operator = event.target.value as Operator
                    patchCondition(groupIndex, conditionIndex, { operator, value: emptyValueFor(operator) })
                  }}
                  className="w-auto min-w-36 flex-1"
                >
                  {(field?.operators ?? []).map((operator) => (
                    <option key={operator} value={operator}>
                      {OPERATOR_LABELS[operator] ?? operator}
                    </option>
                  ))}
                </Select>

                {takesValue ? <ValueControl field={field} condition={condition} relativeDates={relativeDates} onChange={(value) => patchCondition(groupIndex, conditionIndex, { value })} /> : null}

                <Button
                  variant="tertiary"
                  aria-label={`Remove the condition on ${field?.label ?? condition.field}`}
                  onClick={() =>
                    patch(groupIndex, {
                      conditions: group.conditions.filter((_, j) => j !== conditionIndex),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            )
          })}

          <div className="flex flex-wrap gap-2">
            <Button variant="tertiary" onClick={() => addCondition(groupIndex)}>
              Add condition
            </Button>
            {groups.length > 1 ? (
              <Button
                variant="tertiary"
                onClick={() => edit(groups.filter((_, i) => i !== groupIndex))}
              >
                Remove group
              </Button>
            ) : null}
          </div>
        </div>
      ))}

      {message ? (
        <p role="alert" className="text-error">
          {message}
        </p>
      ) : null}

      <div className={cn('flex flex-wrap gap-2')}>
        {onApply ? (
          <Button variant="primary" onClick={apply}>
            Apply
          </Button>
        ) : null}
        {singleGroup ? null : (
          <Button onClick={() => edit([...groups, { conjunction: 'and', conditions: [] }])}>Add group</Button>
        )}
        <Button variant="tertiary" onClick={clearAll}>
          Clear all
        </Button>
        {onClose ? (
          <Button variant="tertiary" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </div>
    </div>
  )
}
