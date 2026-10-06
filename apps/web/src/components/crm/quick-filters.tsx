'use client'

import { Button, Checkbox, IconButton, Popover, TextInput, cn } from '@rawr/ui'
import { ChevronDown, ListFilter, Pencil, Plus, X } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useFormat, useZone } from '~/components/zone.tsx'
import { dayKey } from '~/lib/format.ts'
import { useUi, useUiReady } from '~/lib/store/ui.ts'
import type { Choice } from './field-input.tsx'
import type { Condition, FilterField, Group } from './filter-builder.tsx'

/** HubSpot's row for every object: owner, create date, last activity, status.
 *  Each object shows the ones it has. */
const DEFAULT_KEYS = ['owner_id', 'created_at', 'last_contacted_at', 'lead_status', 'close_date']
const TEMPORAL = new Set(['date', 'datetime'])
const DAY_MS = 86_400_000
const RANGES = [
  { label: 'Today', days: 0 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
]
/** Past this many options a list gets a search box. */
const SEARCH_FROM = 8

const ghost =
  'inline-flex h-pill min-w-0 items-center gap-1 rounded-pill px-2 text-small font-semibold text-body transition-all duration-150 ease-out hover:bg-fill'

/** A quick filter is a group of its own holding one condition on its field, so
 *  it ANDs with whatever the advanced filters say and never rewrites them. */
const isQuick = (group: Group, key: string): boolean => group.conditions.length === 1 && group.conditions[0]!.field === key

const withQuick = (filters: Group[], key: string, condition: Condition | null): Group[] => [
  ...filters.filter((group) => !isQuick(group, key)),
  ...(condition ? [{ conjunction: 'and' as const, conditions: [condition] }] : []),
]

const valuesOf = (condition: Condition | undefined): string[] => {
  const value = condition?.value
  if (Array.isArray(value)) return value.map(String)
  return value === null || value === undefined || value === '' ? [] : [String(value)]
}

type Editor = 'list' | 'date' | 'text' | null

const editorFor = (field: FilterField, options: Choice[]): Editor => {
  if (options.length > 0 && field.operators.includes('in')) return 'list'
  if (TEMPORAL.has(field.type) && field.operators.includes('between')) return 'date'
  if (field.operators.includes('contains')) return 'text'
  return null
}

export type QuickFiltersProps = {
  object: string
  fields: FilterField[]
  /** The bounded choices a user or relation field picks from, by field key. */
  choices: Record<string, Choice[]>
  filters: Group[]
  onChange: (filters: Group[]) => void
  onAdvanced: () => void
}

export const QuickFilters = ({ object, fields, choices, filters, onChange, onAdvanced }: QuickFiltersProps) => {
  const ready = useUiReady()
  const stored = useUi((state) => state.quickFilters[object])
  const setQuickFilters = useUi((state) => state.setQuickFilters)
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const optionsOf = (field: FilterField): Choice[] => [
    ...(field.type === 'user' ? [{ id: '@me', label: 'Me' }] : []),
    ...(choices[field.key] ?? field.options.map((option) => ({ id: option, label: option }))),
  ]
  const usable = (field: FilterField | undefined): field is FilterField => field !== undefined && editorFor(field, optionsOf(field)) !== null
  const keys = ((ready ? stored : undefined) ?? DEFAULT_KEYS).filter((key) => usable(byKey.get(key)))
  const shown = new Set(keys)

  const addButton = useRef<HTMLButtonElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const addable = fields.filter((field) => !shown.has(field.key) && usable(field) && field.label.toLowerCase().includes(needle))

  return (
    <div className="flex flex-wrap items-center gap-1">
      {keys.map((key) => {
        const field = byKey.get(key)!
        return (
          <Chip
            key={key}
            field={field}
            options={optionsOf(field)}
            condition={filters.find((group) => isQuick(group, key))?.conditions[0]}
            onApply={(condition) => onChange(withQuick(filters, key, condition))}
          />
        )
      })}
      <span aria-hidden="true" className="mx-1.5 h-5 w-px bg-line" />
      <IconButton
        ref={addButton}
        label="Add quick filter"
        icon={<Plus aria-hidden="true" className="size-3.5" />}
        aria-haspopup="dialog"
        aria-expanded={adding}
        onClick={() => {
          setQuery('')
          setAdding((open) => !open)
        }}
        className="size-7 border border-line-strong bg-surface text-body"
      />
      <Popover open={adding} onClose={() => setAdding(false)} anchorRef={addButton} align="start" label="Add quick filter">
        <div className="flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 p-3">
          <TextInput
            aria-label="Search properties"
            placeholder="Search properties"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-control min-h-0 rounded-pill"
          />
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {addable.map((field) => (
              <li key={field.key}>
                <button
                  type="button"
                  onClick={() => {
                    setQuickFilters(object, [...keys, field.key])
                    setAdding(false)
                  }}
                  className="w-full truncate rounded-hs px-3 py-2 text-left hover:bg-fill"
                >
                  {field.label}
                </button>
              </li>
            ))}
            {addable.length === 0 ? <li className="px-3 py-2 text-secondary">No other property can be a quick filter.</li> : null}
          </ul>
        </div>
      </Popover>
      <IconButton
        ref={editButton}
        label="Edit quick filters"
        icon={<Pencil aria-hidden="true" className="size-3.5" />}
        aria-haspopup="dialog"
        aria-expanded={editing}
        onClick={() => setEditing((open) => !open)}
        className="size-7 border border-line-strong bg-surface text-body"
      />
      <Popover open={editing} onClose={() => setEditing(false)} anchorRef={editButton} align="start" label="Edit quick filters">
        <div className="flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 p-3">
          <span className="text-small font-semibold">Quick filters</span>
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {keys.map((key) => (
              <li key={key} className="flex min-w-0 items-center gap-2 px-1">
                <span className="min-w-0 flex-1 truncate">{byKey.get(key)!.label}</span>
                <IconButton
                  label={`Remove ${byKey.get(key)!.label}`}
                  icon={<X aria-hidden="true" className="size-3.5" />}
                  onClick={() => setQuickFilters(object, keys.filter((other) => other !== key))}
                />
              </li>
            ))}
            {keys.length === 0 ? <li className="px-1 py-2 text-secondary">None. Add one with +.</li> : null}
          </ul>
          <Button variant="tertiary" className="self-start" onClick={() => setQuickFilters(object, null)}>
            Reset to defaults
          </Button>
        </div>
      </Popover>
      <button type="button" onClick={onAdvanced} className={ghost}>
        <ListFilter aria-hidden="true" className="size-3.5" />
        Advanced filters
      </button>
    </div>
  )
}

const Chip = ({
  field,
  options,
  condition,
  onApply,
}: {
  field: FilterField
  options: Choice[]
  condition: Condition | undefined
  onApply: (condition: Condition | null) => void
}) => {
  const fmt = useFormat()
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const values = valuesOf(condition)
  const nameOf = (id: string) => options.find((option) => option.id === id)?.label ?? id

  const summary = ((): string | null => {
    if (!condition) return null
    if (condition.operator === 'in') return values.length > 1 ? `${nameOf(values[0]!)} +${values.length - 1}` : nameOf(values[0] ?? '')
    if (condition.operator === 'on_or_after') return values[0] === '@today' ? 'Today' : `Since ${fmt.date(values[0])}`
    if (condition.operator === 'between') return `${fmt.date(values[0])} to ${fmt.date(values[1])}`
    if (condition.operator === 'contains') return `“${values[0]}”`
    return 'Filtered'
  })()
  const label = summary ? `${field.label}: ${summary}` : field.label
  const apply = (next: Condition | null, close = true) => {
    onApply(next)
    if (close) setOpen(false)
  }

  const editor = editorFor(field, options)
  let body: ReactNode = null
  if (editor === 'list') body = <ListEditor field={field} options={options} picked={condition?.operator === 'in' ? values : []} onApply={apply} />
  else if (editor === 'date') body = <DateEditor field={field} condition={condition} onApply={apply} />
  else if (editor === 'text') body = <TextEditor field={field} value={condition?.operator === 'contains' ? (values[0] ?? '') : ''} onApply={apply} />

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((shown) => !shown)}
        className={cn(ghost, condition && 'bg-fill-hover')}
      >
        <span className="max-w-64 truncate">{label}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="start" label={field.label}>
        <div className="flex w-[min(18rem,calc(100vw-2rem))] flex-col gap-2 p-3">
          {body}
          {condition ? (
            <Button variant="tertiary" className="self-start" onClick={() => apply(null)}>
              Clear
            </Button>
          ) : null}
        </div>
      </Popover>
    </>
  )
}

/** Each tick applies at once, the way HubSpot's does, and the list stays open
 *  for the next one. */
const ListEditor = ({
  field,
  options,
  picked,
  onApply,
}: {
  field: FilterField
  options: Choice[]
  picked: string[]
  onApply: (condition: Condition | null, close?: boolean) => void
}) => {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const chosen = new Set(picked)
  const visible = needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options
  const toggle = (id: string) => {
    if (chosen.has(id)) chosen.delete(id)
    else chosen.add(id)
    onApply(chosen.size > 0 ? { field: field.key, operator: 'in', value: [...chosen] } : null, false)
  }
  return (
    <>
      {options.length > SEARCH_FROM ? (
        <TextInput
          aria-label={`Search ${field.label}`}
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-control min-h-0 rounded-pill"
        />
      ) : null}
      <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {visible.map((option) => (
          <Checkbox key={option.id} label={option.label} checked={chosen.has(option.id)} onChange={() => toggle(option.id)} />
        ))}
        {visible.length === 0 ? <p className="text-secondary">Nothing matches.</p> : null}
      </div>
    </>
  )
}

const DateEditor = ({
  field,
  condition,
  onApply,
}: {
  field: FilterField
  condition: Condition | undefined
  onApply: (condition: Condition | null) => void
}) => {
  const zone = useZone()
  const current = valuesOf(condition)
  const [range, setRange] = useState(condition?.operator === 'between' ? current : ['', ''])
  const since = (days: number) => (days === 0 ? '@today' : dayKey(new Date(Date.now() - days * DAY_MS), zone))
  return (
    <>
      <div className="flex flex-col">
        {RANGES.map((option) => {
          const value = since(option.days)
          const on = condition?.operator === 'on_or_after' && current[0] === value
          return (
            <button
              key={option.label}
              type="button"
              aria-pressed={on}
              onClick={() => onApply({ field: field.key, operator: 'on_or_after', value })}
              className="rounded-hs px-3 py-2 text-left hover:bg-fill aria-pressed:font-semibold"
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <form
        className="flex flex-col gap-2 border-t border-line pt-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (range[0] && range[1]) onApply({ field: field.key, operator: 'between', value: range })
        }}
      >
        <span className="text-small text-secondary">Between</span>
        <div className="flex items-center gap-2">
          <TextInput aria-label="From" type="date" value={range[0] ?? ''} onChange={(event) => setRange([event.target.value, range[1] ?? ''])} className="min-w-0 flex-1" />
          <TextInput aria-label="To" type="date" value={range[1] ?? ''} onChange={(event) => setRange([range[0] ?? '', event.target.value])} className="min-w-0 flex-1" />
        </div>
        <Button type="submit" className="self-start" disabled={!range[0] || !range[1]}>
          Apply
        </Button>
      </form>
    </>
  )
}

const TextEditor = ({
  field,
  value,
  onApply,
}: {
  field: FilterField
  value: string
  onApply: (condition: Condition | null) => void
}) => {
  const [draft, setDraft] = useState(value)
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onApply(draft.trim() ? { field: field.key, operator: 'contains', value: draft.trim() } : null)
      }}
    >
      <TextInput aria-label={`${field.label} contains`} placeholder="Contains" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <Button type="submit" className="self-start">
        Apply
      </Button>
    </form>
  )
}
