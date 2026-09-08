import type { EnrollmentState, FieldType } from '@rawr/db'
import type { BadgeTone } from '@rawr/ui'
import { Markdown } from './markdown.tsx'
import { toPlainText } from './markdown.ts'
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

/** A record's name, cut to something that can be a tooltip or an accessible name.
 *
 *  Names are user data with no length limit: a company called
 *  "Ludwigshafen Interkontinentale Datenverarbeitungsgesellschaft…" repeated to
 *  five hundred characters is a real row, and putting it whole into an aria-label
 *  gives a screen reader a paragraph to read before it says what the button does.
 *  The visible text is clamped by CSS; this is for the places CSS cannot reach. */
export const shortName = (value: string, max = 40): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`

/** A calendar day, as month and day, for a chart axis where the year is already
 *  in the range above it.
 *
 *  Goes through `asDate` for the reason `asDate` exists: a `date` column arrives
 *  as "2026-08-07", which is a day, not an instant. Reading it as UTC midnight and
 *  then formatting it in the reader's own zone moves it to the 6th for everybody
 *  west of Greenwich, so an axis silently disagreed with the range printed above
 *  it. The report pages each had their own copy of this that did exactly that. */
export const formatDayShort = (value: unknown): string => {
  const date = asDate(value)
  return date ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
}

export const formatDateTime = (value: unknown): string => {
  const date = asDate(value)
  return date ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''
}

/** "3 days ago", in the reader's language. Only for a timeline the reader scans
 *  for recency; anything they might quote gets the full date and time. */
export const formatAgo = (value: unknown): string => {
  const date = asDate(value)
  if (!date) return ''
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86_400], ['hour', 3_600], ['minute', 60]]
  const [unit, size] = units.find(([, s]) => Math.abs(seconds) >= s) ?? ['minute', 60]
  const amount = Math.trunc(seconds / size)
  return amount === 0
    ? 'just now'
    : new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit)
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
  /** A row of a table, where the value has one line and the container is a span.
   *  Only rich text renders differently for it, and only because it is the one
   *  type whose full rendering is blocks. */
  oneLine?: boolean
}

/** The keys of a source blob that are worth putting on screen, and nothing else.
 *  A null or an empty string means "we did not learn this", which is not something
 *  to take up a line for. */
/** What a link says on screen. The scheme and the www are noise in a narrow
 *  column; the full address is on hover and in the href. */
const shortLink = (text: string): string =>
  text.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')

/** A key as a person reads it: `firstSeenAt` and `first_seen_at` both land on
 *  "First seen at". */
const humanKey = (key: string): string => {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** One leaf per line, in storage order, with the nesting thrown away.
 *
 *  Where a value sits inside the blob is a storage detail: `{channel, detail:
 *  {referrer}}` is two things a person can read, not one thing and a wall of
 *  JSON. A null means "we did not learn this", which is not worth a line, and a
 *  leaf name that repeats keeps the first one it was given. */
const readableEntries = (value: unknown, seen: Set<string> = new Set()): [string, string][] => {
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]): [string, string][] => {
    if (entry === null || entry === undefined || entry === '') return []
    if (typeof entry === 'object' && !Array.isArray(entry)) return readableEntries(entry, seen)
    if (seen.has(key)) return []
    seen.add(key)
    const text = Array.isArray(entry) ? entry.join(', ') : String(entry)
    if (!text) return []
    if (ISO_INSTANT.test(text)) return [[humanKey(key), formatDateTime(text)]]
    return [[humanKey(key), /^https?:\/\//i.test(text) ? shortLink(text) : text]]
  })
}

export const Value = ({ type, value, label, currency = 'USD', placeholder = '', oneLine = false }: ValueProps): ReactNode => {
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

  // Markdown, rendered to elements. The stored value is the characters somebody
  // typed and nothing here turns any of it into markup, so a tag in a note is a
  // tag on the screen rather than a tag in the page.
  //
  // A table cell gets the words on one line instead. A heading, a list and three
  // paragraphs do not fit a row, and the cell is inside a span, where a block
  // element is not valid content at all.
  if (type === 'rich_text') {
    if (oneLine) {
      const plain = toPlainText(text)
      return (
        <span className="block truncate" title={plain}>
          {plain}
        </span>
      )
    }
    return <Markdown source={text} />
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
    const isWeb = type === 'url' || type === 'linkedin'
    return (
      <a
        href={link}
        // A record link is internal; these leave the app, so they open away and
        // never hand the target a window handle.
        {...(isWeb ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
        // A web address is long and its tail is rarely the point, so it is
        // shortened and clipped with the whole thing on hover. An email address
        // is the opposite: every character is the point, so it wraps — but only
        // where it has to. break-all breaks eagerly and shatters a long address
        // into three ragged pieces in a column that had room for two.
        className={isWeb ? 'block truncate' : 'wrap-anywhere'}
        title={isWeb ? text : undefined}
      >
        {isWeb ? shortLink(text) : text}
      </a>
    )
  }

  if (type === 'json') {
    // The attribution container: raw JSON in a 20rem column is unreadable, and the
    // useful part is always the handful of leaves that carry a value. D17 stores
    // the whole payload verbatim; this renders the part a person can act on and
    // keeps the rest on hover.
    const entries = readableEntries(value).slice(0, 8)
    if (entries.length === 0) {
      return placeholder ? <span className="text-secondary">{placeholder}</span> : null
    }
    return (
      <span className="flex flex-col gap-0.5" title={text}>
        {entries.map(([key, entry]) => (
          <span key={key} className="flex flex-wrap gap-x-1">
            <span className="text-small text-secondary">{key}</span>
            <span className="min-w-0 break-words">{entry}</span>
          </span>
        ))}
      </span>
    )
  }

  return <span className="break-words">{text}</span>
}

/** Activity whose subject is a sentence about the record rather than about a
 *  person on the team. Every one of these is written by whichever admin's sync,
 *  webhook or public form handler noticed it, so the actor column names the
 *  operator: "Yash was enrolled in Trial follow-up" on a contact who is not Yash. */
const ABOUT_THE_RECORD = new Set([
  'page_view',
  'custom_event',
  'form_submission',
  'booking',
  'marketing_email',
  'email_tracking',
  'sequence_activity',
  'subscription_change',
  'segment_change',
])

/** What a non-person doer is called on screen. The column holds an enum word,
 *  and "public replied to Trial follow-up" reads like a bug. */
const ACTOR_KINDS: Record<string, string> = {
  mcp: 'An assistant',
  job: 'A scheduled job',
  integration: 'An integration',
  public: 'A public form',
}

/** Who the line is about, ahead of the subject. Empty for a person on the team
 *  whose name did not resolve, because "Somebody added a note" reads worse than
 *  "added a note". */
export const activityActor = (
  type: string,
  actor: { actorName: string | null; actorKind: string; recordName: string | null; payload?: unknown },
): string => {
  // A row that names its contact keeps that name on the company and deal pages
  // it also lands on, rather than reading as if the company were enrolled.
  const named = (actor.payload as { contactName?: unknown } | null)?.contactName
  if (ABOUT_THE_RECORD.has(type)) return typeof named === 'string' && named ? named : (actor.recordName ?? '')
  return actor.actorName ?? ACTOR_KINDS[actor.actorKind] ?? ''
}

/** How each timeline type is named on screen. Shared by the record timeline and
 *  the Home feed so the same event never has two names. */
export const ACTIVITY_LABELS: Record<string, string> = {
  note: 'Note',
  call: 'Call',
  email: 'Email',
  meeting: 'Meeting',
  task: 'Task',
  stage_change: 'Stage change',
  lifecycle_change: 'Lifecycle change',
  field_change: 'Property change',
  association_change: 'Association',
  merge: 'Merge',
  import: 'Import',
  form_submission: 'Form submission',
  booking: 'Booking',
  page_view: 'Page view',
  custom_event: 'Custom event',
  marketing_email: 'Marketing email',
  email_tracking: 'Email tracking',
  sequence_activity: 'Sequence',
  enrichment: 'Enrichment',
  subscription_change: 'Subscription',
  segment_change: 'Segment',
}

export const ENROLLMENT_TONE: Record<EnrollmentState, BadgeTone> = {
  active: 'ok',
  waiting_task: 'info',
  paused: 'warn',
  finished: 'neutral',
  replied: 'ok',
  bounced: 'error',
  unsubscribed: 'warn',
  failed: 'error',
  removed: 'neutral',
}

/** The state, said the way a salesperson would. "finished" and "replied" are both
 *  over, and they mean opposite things. */
export const ENROLLMENT_LABEL: Record<EnrollmentState, string> = {
  active: 'Running',
  waiting_task: 'Waiting on a task',
  paused: 'Paused',
  finished: 'Ran out of steps',
  replied: 'They replied',
  bounced: 'Bounced',
  unsubscribed: 'Unsubscribed',
  failed: 'Failed',
  removed: 'Removed',
}
