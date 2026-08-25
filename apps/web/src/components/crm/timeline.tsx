'use client'

import { Button, EmptyState, TextArea, cn, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { pageViewPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from './value.tsx'

export type TimelineEntry = {
  id: string
  type: string
  subject: string | null
  body: string | null
  occurredAt: string
  actorName: string | null
  actorKind: string
  /** What the entry was written from. Only F4's two types read it, to address the
   *  page view or event behind them. */
  payload?: unknown
}

export type TimelineGroup = { label: string; types: string[] }

export type TimelineProps = {
  object: ObjectKey
  workspace: string
  /** Whose record this is. Tracking entries are attributed to the person, the way
   *  HubSpot reads "Muhammad Owais viewed Data Studio", because "public viewed" or
   *  "job viewed" describes the mechanism rather than what happened. */
  recordName: string
  recordId: string
  initial: TimelineEntry[]
  initialCursor: { occurredAt: string; id: string } | null
  counts: Record<string, number>
  groups: TimelineGroup[]
  canWrite: boolean
}

const TYPE_LABELS: Record<string, string> = {
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

const STORAGE_PREFIX = 'rawr.timeline.types.'

/** The two types whose actor is the person the record is about, not a user, a job
 *  or "public". F4 §4. */
const TRACKED = new Set(['page_view', 'custom_event'])

/** A page view on the timeline addresses the row behind it, so "viewed Data
 *  Studio" opens the full URL, the referrer and the rest of that visit. F4 §4. */
const pageViewIdOf = (entry: TimelineEntry): string | null => {
  if (entry.type !== 'page_view') return null
  const id = (entry.payload as { pageViewId?: unknown } | null)?.pageViewId
  return typeof id === 'string' ? id : null
}

export const Timeline = ({
  object,
  workspace,
  recordName,
  recordId,
  initial,
  initialCursor,
  counts,
  groups,
  canWrite,
}: TimelineProps) => {
  const router = useRouter()
  const toast = useToast()
  const params = useSearchParams()
  const urlTypes = params.get('type')

  const [selected, setSelected] = useState<string[]>(urlTypes ? urlTypes.split(',').filter(Boolean) : [])
  const [rows, setRows] = useState(initial)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [posting, setPosting] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const shownCount = selected.length === 0 ? total : selected.reduce((sum, type) => sum + (counts[type] ?? 0), 0)

  /** The URL wins, because a link has to open the screen it was taken from. With
   *  nothing in the URL, the last choice this person made is restored. A3. */
  useEffect(() => {
    if (urlTypes !== null) {
      setHydrated(true)
      return
    }
    try {
      const saved = window.localStorage.getItem(`${STORAGE_PREFIX}${object}`)
      if (saved) setSelected(saved.split(',').filter(Boolean))
    } catch {
      // Private windows and blocked site data are normal, not an error.
    }
    setHydrated(true)
  }, [object, urlTypes])

  const load = async (types: string[], from: typeof cursor, append: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const page = await api.crm.timeline.list.query({
        entity: { entityType: object, entityId: recordId },
        types,
        limit: 50,
        cursor: from ? { occurredAt: new Date(from.occurredAt), id: from.id } : null,
      })
      const mapped = page.rows.map((row) => ({
        id: row.id,
        type: row.type,
        subject: row.subject,
        body: row.body,
        occurredAt: row.occurredAt.toISOString(),
        actorName: row.actorName,
        actorKind: row.actorKind,
        payload: row.payload,
      }))
      setRows((current) => (append ? [...current, ...mapped] : mapped))
      setCursor(
        page.nextCursor
          ? { occurredAt: page.nextCursor.occurredAt.toISOString(), id: page.nextCursor.id }
          : null,
      )
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  const toggle = (type: string) => {
    const next = selected.includes(type) ? selected.filter((t) => t !== type) : [...selected, type]
    setSelected(next)
    try {
      window.localStorage.setItem(`${STORAGE_PREFIX}${object}`, next.join(','))
    } catch {
      // Nothing depends on this surviving; the URL is the shareable copy.
    }
    // Put the choice in the URL so the filtered timeline can be linked to.
    const search = new URLSearchParams(params.toString())
    if (next.length === 0) search.delete('type')
    else search.set('type', next.join(','))
    window.history.replaceState(null, '', `?${search.toString()}`)
    void load(next, null, false)
  }

  const addNote = async () => {
    setPosting(true)
    try {
      await api.crm.timeline.note.mutate({
        entity: { entityType: object, entityId: recordId },
        body: note,
      })
      setNote('')
      toast('success', 'Note added.')
      await load(selected, null, false)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {canWrite ? (
        <div className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3">
          <TextArea
            value={note}
            aria-label="Add a note"
            placeholder="Add a note to this record"
            onChange={(event) => setNote(event.target.value)}
          />
          <div>
            <Button variant="primary" busy={posting} disabled={note.trim() === ''} onClick={() => void addNote()}>
              Add note
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="font-medium">
          Activity ({shownCount.toLocaleString()}/{total.toLocaleString()})
        </p>
        {selected.length > 0 ? (
          <Button variant="tertiary" onClick={() => { setSelected([]); void load([], null, false) }}>
            Show all
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter the timeline by type">
        {groups.flatMap((group) =>
          group.types
            .filter((type) => (counts[type] ?? 0) > 0)
            .map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={selected.includes(type)}
                onClick={() => toggle(type)}
                className={cn(
                  'rounded-hs border px-2 py-0.5 text-small',
                  selected.includes(type)
                    ? 'border-line-interactive bg-accent-subtle text-link'
                    : 'border-line text-secondary hover:bg-fill-hover',
                )}
              >
                {TYPE_LABELS[type] ?? type} {counts[type]}
              </button>
            )),
        )}
      </div>

      {error ? (
        <p role="alert" className="rounded-hs border border-error bg-error-subtle px-3 py-2 text-error">
          {error}
        </p>
      ) : null}

      {rows.length === 0 && hydrated ? (
        <EmptyState
          title={selected.length > 0 ? 'Nothing of that type yet' : 'Nothing has happened here yet'}
          description={
            selected.length > 0
              ? 'Clear the filter above to see everything on this record.'
              : 'Notes, emails, meetings and property changes all land here as they happen.'
          }
        />
      ) : (
        <ol className="flex flex-col gap-2">
          {rows.map((entry) => (
            <li key={entry.id} className="rounded-panel border border-line bg-surface p-3">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="rounded-hs bg-fill px-1.5 py-0.5 text-small text-secondary">
                  {TYPE_LABELS[entry.type] ?? entry.type}
                </span>
                <span className="min-w-0 break-words font-medium">
                  {TRACKED.has(entry.type)
                    ? `${recordName} `
                    : entry.actorName
                      ? `${entry.actorName} `
                      : entry.actorKind !== 'user'
                        ? `${entry.actorKind} `
                        : ''}
                  {pageViewIdOf(entry) ? (
                    <Link className="text-link" href={pageViewPath(workspace, pageViewIdOf(entry) as string)}>
                      {entry.subject ?? ''}
                    </Link>
                  ) : (
                    (entry.subject ?? '')
                  )}
                </span>
                <time
                  dateTime={entry.occurredAt}
                  className="ml-auto shrink-0 text-small text-secondary"
                  title={entry.occurredAt}
                >
                  {formatDateTime(entry.occurredAt)}
                </time>
              </p>
              {entry.body ? <p className="mt-1 break-words whitespace-pre-wrap">{entry.body}</p> : null}
            </li>
          ))}
        </ol>
      )}

      {cursor ? (
        <div>
          <Button busy={loading} onClick={() => void load(selected, cursor, true)}>
            Load older
          </Button>
        </div>
      ) : null}
    </div>
  )
}
