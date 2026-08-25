import type { FieldType } from '@rawr/db'
import type { ReactNode } from 'react'

/** How a stored value is read on screen. One rule per field type, matching the
 *  CSV rule and the editor, so a table cell, a card and a record page can never
 *  disagree about what a value looks like. 02-foundation.md section 4.
 *
 *  Deliberately free of event handlers: this renders inside server components as
 *  well as client ones, and a handler here would make every one of them a client
 *  component. Stopping a click from reaching a clickable row is the table's job. */

const numberFormat = new Intl.NumberFormat(undefined)

export const formatCurrency = (value: unknown, currency = 'USD'): string => {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return ''
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount)
  } catch {
    // An unknown currency code is a data problem, not a reason to render nothing.
    return `${numberFormat.format(amount)} ${currency}`
  }
}

/** Dates arrive as strings from the query path and as Dates from the write path.
 *  Both are handled rather than assuming one. */
const asDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' || !value) return null
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export const formatDate = (value: unknown): string => {
  const date = asDate(value)
  return date ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
}

export const formatDateTime = (value: unknown): string => {
  const date = asDate(value)
  return date ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''
}

export const isPast = (value: unknown): boolean => {
  const date = asDate(value)
  if (!date) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return date < today
}

export const formatValue = (type: FieldType, value: unknown, currency = 'USD'): string => {
  if (value === null || value === undefined || value === '') return ''
  switch (type) {
    case 'currency':
      return formatCurrency(value, currency)
    case 'number':
    case 'rating':
      return Number.isFinite(Number(value)) ? numberFormat.format(Number(value)) : String(value)
    case 'percent':
      return `${numberFormat.format(Number(value))}%`
    case 'boolean':
      return value ? 'Yes' : 'No'
    case 'date':
      return formatDate(value)
    case 'datetime':
      return formatDateTime(value)
    case 'multi_select':
      return Array.isArray(value) ? value.join(', ') : String(value)
    case 'json':
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
    default:
      return String(value)
  }
}

const href = (type: FieldType, value: string): string | null => {
  if (type === 'email') return `mailto:${value}`
  if (type === 'phone') return `tel:${value.replace(/[^\d+]/g, '')}`
  if (type === 'url') return /^https?:\/\//i.test(value) ? value : `https://${value}`
  if (type === 'linkedin') return /^https?:\/\//i.test(value) ? value : `https://${value}`
  return null
}

export type ValueProps = {
  type: FieldType
  value: unknown
  /** A relation or user field renders its label, never its uuid. */
  label?: string | undefined
  currency?: string
  /** Renders the empty state as the placeholder rather than nothing at all. */
  placeholder?: string
}

export const Value = ({ type, value, label, currency = 'USD', placeholder = '' }: ValueProps): ReactNode => {
  if (label !== undefined && label !== '') return <span className="break-words">{label}</span>

  // A relation or user holds a uuid, which means nothing to a reader. With no
  // label resolved, the record it points at has no name; say that instead.
  if (type === 'relation' || type === 'user') {
    if (value === null || value === undefined || value === '') {
      return placeholder ? <span className="text-secondary">{placeholder}</span> : null
    }
    return <span className="text-secondary">Unnamed record</span>
  }

  const text = formatValue(type, value, currency)
  if (!text) {
    return placeholder ? <span className="text-secondary">{placeholder}</span> : null
  }

  if (type === 'multi_select' && Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((entry) => (
          <span key={String(entry)} className="rounded-hs bg-fill px-1.5 py-0.5 text-small">
            {String(entry)}
          </span>
        ))}
      </span>
    )
  }

  const link = typeof value === 'string' ? href(type, value) : null
  if (link) {
    return (
      <a
        href={link}
        // A record link is internal; these leave the app, so they open away and
        // never hand the target a window handle.
        {...(type === 'url' || type === 'linkedin' ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
        className="break-all"
      >
        {text}
      </a>
    )
  }

  if (type === 'json') {
    return <code className="break-all text-small text-secondary">{text}</code>
  }

  return <span className="break-words">{text}</span>
}
