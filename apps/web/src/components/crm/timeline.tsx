'use client'

import { Alert, Button, DropdownMenu, EmptyState, TextArea, TextInput, cn, useToast } from '@rawr/ui'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { pageViewPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { ACTIVITY_LABELS as TYPE_LABELS, formatDateTime } from './value.tsx'

const monthOf = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

export type TimelineEntry = {
  id: string
  type: string
  subject: string | null
  body: string | null
  occurredAt: string
  actorId: string | null
  actorName: string | null
  actorKind: string
  /** What the entry was written from. Only F4's two types read it, to address the
   *  page view or event behind them. */
  payload?: unknown
}

export type TimelineGroup = { label: string; types: string[] }

export type TimelineProps = {
  /** An object key, core or invented. */
  object: string
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
  /** Who is looking. Their own hand-logged entries can be corrected or removed; an
   *  admin can do that to anyone's. Nothing the system wrote can be touched. */
  viewer: { userId: string; role: string }
  /** Which composer the quick-action row above asked for, from the address. The
   *  composer lives here, so the row asks rather than carrying a second copy. */
  openKind?: 'note' | 'call' | 'meeting' | 'email' | undefined
}

/** What a person can put on the timeline by hand, and the prompt each one needs.
 *  A note is about the record; the other three are about something that happened,
 *  which is why they carry a date and a note does not. A3. */
const LOGGABLE = [
  { type: 'note', verb: 'Add note', prompt: 'Add a note to this record', dated: false },
  { type: 'call', verb: 'Log call', prompt: 'What was said on the call', dated: true },
  { type: 'meeting', verb: 'Log meeting', prompt: 'What happened in the meeting', dated: true },
  { type: 'email', verb: 'Log email', prompt: 'What the email said', dated: true },
] as const

type Loggable = (typeof LOGGABLE)[number]['type']

const STORAGE_PREFIX = 'rawr.timeline.types.'

/** HubSpot's sub-tabs over the timeline. Each one is a preset of the type
 *  filter, so "Emails" and ticking Email and Marketing email are the same view. */
const SUBTABS: { label: string; types: string[] }[] = [
  { label: 'All activities', types: [] },
  { label: 'Notes', types: ['note'] },
  { label: 'Emails', types: ['email', 'marketing_email'] },
  { label: 'Calls', types: ['call'] },
  { label: 'Tasks', types: ['task'] },
  { label: 'Meetings', types: ['meeting', 'booking'] },
]

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((type) => b.includes(type))

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
  viewer,
  openKind,
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
  const [kind, setKind] = useState<Loggable>(openKind ?? 'note')
  const composer = useRef<HTMLTextAreaElement>(null)
  const [happenedOn, setHappenedOn] = useState('')
  const [posting, setPosting] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [needle, setNeedle] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const shownCount = selected.length === 0 ? total : selected.reduce((sum, type) => sum + (counts[type] ?? 0), 0)

  /** The URL wins, because a link has to open the screen it was taken from. With
   *  nothing in the URL, the last choice this person made is restored. A3. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: load is rebuilt every render; listing it would refetch on every render
  // The quick-action row is a link, so asking for a kind arrives as a new prop on
  // the same instance. Focus follows, because a person who clicked "Log call"
  // wants the cursor in the box, not a scrolled page they have to click into.
  useEffect(() => {
    if (!openKind) return
    setKind(openKind)
    composer.current?.focus()
  }, [openKind])

  useEffect(() => {
    if (urlTypes !== null) {
      setHydrated(true)
      return
    }
    try {
      // A remembered filter only makes sense for types this record has. Restoring
      // "Task" onto a record with no tasks would open on an empty timeline.
      const saved = (window.localStorage.getItem(`${STORAGE_PREFIX}${object}`)?.split(',').filter(Boolean) ?? []).filter(
        (type) => (counts[type] ?? 0) > 0,
      )
      if (saved.length > 0) {
        setSelected(saved)
        // The server rendered every type; the restored choice has to fetch its own
        // rows or the chips say one thing and the cards another.
        void load(saved, null, false)
      }
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
        actorId: row.actorId,
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

  const choose = (next: string[]) => {
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
  const toggle = (type: string) => choose(selected.includes(type) ? selected.filter((t) => t !== type) : [...selected, type])

  const query = needle.trim().toLowerCase()
  const shown = query
    ? rows.filter((entry) => `${entry.subject ?? ''} ${entry.body ?? ''} ${entry.actorName ?? ''}`.toLowerCase().includes(query))
    : rows
  const allCollapsed = shown.length > 0 && shown.every((entry) => collapsed.has(entry.id))

  const compose = LOGGABLE.find((entry) => entry.type === kind) ?? LOGGABLE[0]

  const log = async () => {
    setPosting(true)
    try {
      await api.crm.timeline.log.mutate({
        entity: { entityType: object, entityId: recordId },
        type: kind,
        body: note,
        // A bare date means midday local, so a call logged for yesterday does not
        // land on the day before in a zone behind the browser.
        ...(compose.dated && happenedOn ? { occurredAt: new Date(`${happenedOn}T12:00`) } : {}),
      })
      setNote('')
      setHappenedOn('')
      toast('success', `${TYPE_LABELS[kind]} added.`)
      await load(selected, null, false)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setPosting(false)
    }
  }

  const canTouch = (entry: TimelineEntry) =>
    canWrite &&
    LOGGABLE.some((loggable) => loggable.type === entry.type) &&
    (entry.actorId === viewer.userId || viewer.role === 'admin')

  const saveEdit = async () => {
    if (!editing) return
    setWorking(true)
    try {
      await api.crm.timeline.edit.mutate({ id: editing.id, body: editing.body })
      setRows((current) => current.map((row) => (row.id === editing.id ? { ...row, body: editing.body.trim() } : row)))
      setEditing(null)
      toast('success', 'Saved.')
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setWorking(false)
    }
  }

  const remove = async (id: string) => {
    setWorking(true)
    try {
      await api.crm.timeline.remove.mutate({ id })
      setRows((current) => current.filter((row) => row.id !== id))
      setRemoving(null)
      toast('success', 'Removed from the timeline.')
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {canWrite ? (
        <div className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-4 shadow-panel">
          <div className="flex flex-wrap gap-1">
            {LOGGABLE.map((entry) => (
              <Button
                key={entry.type}
                variant={entry.type === kind ? 'secondary' : 'tertiary'}
                aria-pressed={entry.type === kind}
                onClick={() => setKind(entry.type)}
              >
                {TYPE_LABELS[entry.type]}
              </Button>
            ))}
          </div>
          <TextArea
            ref={composer}
            value={note}
            aria-label={compose.prompt}
            placeholder={compose.prompt}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" busy={posting} disabled={note.trim() === ''} onClick={() => void log()}>
              {compose.verb}
            </Button>
            {compose.dated ? (
              <label className="flex items-center gap-2 text-secondary">
                When
                <TextInput
                  type="date"
                  value={happenedOn}
                  onChange={(event) => setHappenedOn(event.target.value)}
                />
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      <nav aria-label="Activity type" className="flex flex-wrap border-b border-line">
        {SUBTABS.map((tab) => {
          const active = sameSet(tab.types, selected)
          return (
            <button
              key={tab.label}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => choose(tab.types)}
              className={cn(
                '-mb-px border-b-[3px] px-3 py-2 font-normal',
                active ? 'border-body text-body' : 'border-transparent text-secondary hover:text-body',
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="relative w-full min-w-0 sm:w-52">
          <span className="sr-only">Search activities</span>
          <input
            type="search"
            value={needle}
            placeholder="Search activities"
            onChange={(event) => setNeedle(event.target.value)}
            className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-9 pl-4 text-body placeholder:text-muted"
          />
          <Search aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
        </label>
        {shown.length > 0 ? (
          <button
            type="button"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(shown.map((entry) => entry.id)))}
            className="inline-flex items-center gap-1 rounded-hs px-2 py-1 font-medium text-body hover:bg-fill"
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
            <ChevronDown aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu
          label="Filter the timeline by type"
          align="start"
          groups={groups.map((group) => ({
            key: group.label,
            label: group.label,
            items: group.types
              .filter((type) => (counts[type] ?? 0) > 0)
              .map((type) => ({
                key: type,
                label: TYPE_LABELS[type] ?? type,
                hint: counts[type],
                checked: selected.includes(type),
                onSelect: () => toggle(type),
              })),
          }))}
          trigger={(props) => (
            <button
              {...props}
              type="button"
              className={cn(
                'inline-flex h-control items-center gap-1 rounded-pill border border-line-strong px-4 text-small font-light text-body',
                selected.length > 0 ? 'bg-fill-hover' : 'bg-surface hover:bg-fill',
              )}
            >
              Activity ({shownCount.toLocaleString()}/{total.toLocaleString()})
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </button>
          )}
        />
        {selected.length > 0 ? (
          <Button
            variant="tertiary"
            onClick={() => {
              try {
                // Forgotten, not only cleared: otherwise the next record opens filtered again.
                window.localStorage.removeItem(`${STORAGE_PREFIX}${object}`)
              } catch {
                // Nothing depends on this surviving.
              }
              choose([])
            }}
          >
            Clear all
          </Button>
        ) : null}
      </div>

      {error ? (
        <Alert>
          {error}
        </Alert>
      ) : null}

      {shown.length === 0 && hydrated ? (
        <EmptyState
          title={query ? 'Nothing matches that search' : selected.length > 0 ? 'Nothing of that type yet' : 'Nothing has happened here yet'}
          description={
            query
              ? 'Only what is loaded is searched. Load older entries to search further back.'
              : selected.length > 0
                ? 'Clear the filter above to see everything on this record.'
                : 'Notes, emails, meetings and property changes all land here as they happen.'
          }
        />
      ) : (
        <ol className="flex flex-col gap-2">
          {shown.map((entry, index) => {
            // HubSpot heads each month; the rows arrive newest first, so a month
            // starts wherever it differs from the row before.
            const month = monthOf(entry.occurredAt)
            const heads = index === 0 || monthOf(shown[index - 1]!.occurredAt) !== month
            const folded = collapsed.has(entry.id)
            const fold = () =>
              setCollapsed((current) => {
                const next = new Set(current)
                if (folded) next.delete(entry.id)
                else next.add(entry.id)
                return next
              })
            return (
            <li key={entry.id} className="flex flex-col gap-2">
              {heads ? <p className={cn('text-base', index > 0 && 'mt-2')}>{month}</p> : null}
            <div className="rounded-panel border border-line bg-surface p-4">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <button
                  type="button"
                  aria-expanded={!folded}
                  onClick={fold}
                  className="inline-flex items-center gap-1 rounded-hs font-semibold hover:bg-fill"
                >
                  {folded ? (
                    <ChevronRight aria-hidden="true" className="size-4" />
                  ) : (
                    <ChevronDown aria-hidden="true" className="size-4" />
                  )}
                  {TYPE_LABELS[entry.type] ?? entry.type}
                </button>
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
              {folded ? null : editing?.id === entry.id ? (
                <div className="mt-2 flex flex-col gap-2">
                  <TextArea
                    value={editing.body}
                    aria-label="Edit this entry"
                    onChange={(event) => setEditing({ id: entry.id, body: event.target.value })}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" busy={working} disabled={editing.body.trim() === ''} onClick={() => void saveEdit()}>
                      Save
                    </Button>
                    <Button variant="tertiary" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : entry.body ? (
                <p className="mt-1 break-words whitespace-pre-wrap">{entry.body}</p>
              ) : null}
              {!folded && canTouch(entry) && editing?.id !== entry.id ? (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-small">
                  {removing === entry.id ? (
                    <>
                      <span className="text-secondary">Remove this {TYPE_LABELS[entry.type]?.toLowerCase() ?? 'entry'}?</span>
                      <Button variant="destructive" busy={working} onClick={() => void remove(entry.id)}>
                        Remove
                      </Button>
                      <Button variant="tertiary" onClick={() => setRemoving(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="tertiary" onClick={() => setEditing({ id: entry.id, body: entry.body ?? '' })}>
                        Edit
                      </Button>
                      <Button variant="tertiary" onClick={() => setRemoving(entry.id)}>
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
            </li>
            )
          })}
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
