'use client'

import { Badge, Button, DataTable, EmptyState, NOTHING_MATCHED, Spinner, cn, useToast, type Column } from '@rawr/ui'
import Link from 'next/link'
import { Fragment, useState } from 'react'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { FilterChip, ghostFilter } from '~/components/filter-chip.tsx'
import { auditPath } from '~/lib/links.ts'
import { errorMessage, trpc } from '~/lib/rpc.ts'
import { useFormat } from '~/components/zone.tsx'
import { useQueryClient } from '@tanstack/react-query'

type Row = {
  id: string
  at: string
  actorName: string | null
  actorKind: string
  entity: string
  entityId: string | null
  action: string
  before: unknown
  after: unknown
}

type Cursor = { at: string; id: string } | null

const KIND_TONE: Record<string, 'neutral' | 'accent' | 'info' | 'warn'> = {
  user: 'neutral',
  mcp: 'accent',
  job: 'info',
  integration: 'info',
  public: 'warn',
}

/** English past tense, by rule. The action column holds a verb stem and new ones
 *  are added all over the DAL without touching this file, so a lookup table would
 *  be stale the week after it was written; these are the stems the rule gets
 *  wrong. */
const IRREGULAR: Record<string, string> = {
  send: 'sent',
  resend: 'resent',
  read: 'read',
  set: 'set',
  submit: 'submitted',
  status: 'changed the status of',
  run: 'ran',
}

const pastTense = (verb: string): string =>
  IRREGULAR[verb] ??
  (verb.endsWith('e')
    ? `${verb}d`
    : /^[^aeiou]*[aeiou][bdgmnpt]$/.test(verb)
      ? `${verb}${verb.at(-1)}ed`
      : /[aeiou]l$/.test(verb)
        ? `${verb}led`
        : `${verb}ed`)

/** What was done, in the Action column. Only the first word of an action is the
 *  verb, so `save_steps` is "Saved steps". */
const actionOf = (action: string): string => {
  const [verb = '', ...rest] = action.split('_')
  const did = [pastTense(verb), ...rest].join(' ')
  return did.charAt(0).toUpperCase() + did.slice(1)
}

const categoryOf = (entity: string): string => {
  const words = entity.replaceAll('_', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A filtered history is an address, so it can be sent to whoever has to answer for it. */
const hrefFor = (entity: string | null, actorId: string | null): string => {
  const query = new URLSearchParams()
  if (entity) query.set('entity', entity)
  if (actorId) query.set('actor', actorId)
  const search = query.toString()
  return search ? `${auditPath()}?${search}` : auditPath()
}

export const AuditTable = ({
  initial,
  cursor: initialCursor,
  entities,
  people,
  entity,
  actorId,
}: {
  initial: Row[]
  cursor: Cursor
  entities: string[]
  people: { userId: string; name: string }[]
  entity: string | null
  actorId: string | null
}) => {
  const queryClient = useQueryClient()
  const fmt = useFormat()
  const toast = useToast()
  const [rows, setRows] = useState(initial)
  const [cursor, setCursor] = useState<Cursor>(initialCursor)
  const [busy, setBusy] = useState(false)

  const loadOlder = async () => {
    setBusy(true)
    try {
      const page = await queryClient.fetchQuery({ ...trpc.admin.audit.list.queryOptions({ entity, actorId, cursor, limit: 50 }), staleTime: 0 })
      // superjson revives the timestamps as Dates; the server component hands
      // them over as strings. One shape here, so the renderer never has to ask.
      setRows((current) => [...current, ...page.rows.map((row) => ({ ...row, at: row.at.toISOString() }))])
      setCursor(page.cursor)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<Row>[] = [
    {
      key: 'at',
      header: 'Occurred',
      width: 200,
      render: (row) => (
        <time dateTime={row.at} className="whitespace-nowrap">
          {fmt.dateTime(row.at)}
        </time>
      ),
    },
    {
      key: 'actor',
      header: 'Modified by',
      width: 240,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span title={row.actorName ?? undefined} className="min-w-0 truncate">{row.actorName ?? 'Somebody'}</span>
          {row.actorKind === 'user' ? null : <Badge tone={KIND_TONE[row.actorKind] ?? 'neutral'} className="shrink-0">{row.actorKind}</Badge>}
        </span>
      ),
    },
    { key: 'category', header: 'Category', width: 200, render: (row) => <span className="block truncate">{categoryOf(row.entity)}</span> },
    { key: 'action', header: 'Action', width: 220, render: (row) => <span className="block truncate">{actionOf(row.action)}</span> },
    { key: 'details', header: 'Details', width: 360, render: (row) => <Diff before={row.before} after={row.after} /> },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <FilterChip
          label="Category"
          clear={hrefFor(null, actorId)}
          options={entities.map((each) => ({ key: each, label: categoryOf(each), href: hrefFor(each, actorId), on: each === entity }))}
        />
        <FilterChip
          label="Modified by"
          clear={hrefFor(entity, null)}
          options={people.map((person) => ({ key: person.userId, label: person.name, href: hrefFor(entity, person.userId), on: person.userId === actorId }))}
        />
        {entity || actorId ? (
          <>
            <span aria-hidden="true" className="mx-1.5 h-5 w-px bg-line" />
            <Link href={auditPath()} className={cn(ghostFilter, 'no-underline')}>
              Reset filters
            </Link>
          </>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <EmptyState {...NOTHING_MATCHED} />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Audit log" storageKey="settings.audit" />
      )}

      <div className="flex items-center gap-2">
        {cursor ? (
          <Button busy={busy} onClick={() => void loadOlder()}>
            Show older
          </Button>
        ) : rows.length > 0 ? (
          <p className="text-secondary">That is the whole history for this filter.</p>
        ) : null}
        {busy && !cursor ? <Spinner label="Loading history" /> : null}
      </div>
    </div>
  )
}

const show = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return EMPTY_VALUE
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** What actually changed, field by field.
 *
 *  The Action column says a deal was updated; this says the stage went from
 *  Qualified to Closed won, which is the thing anybody reading a history came
 *  for. Only the keys that differ, because a record with forty fields and one
 *  edit should read as one line. Both sides are already stored on the row. */
const Diff = ({ before, after }: { before: unknown; after: unknown }) => {
  const from = asRecord(before)
  const to = asRecord(after)
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter(
    (key) => show(from[key]) !== show(to[key]),
  )
  if (keys.length === 0) return null

  return (
    <details className="py-2">
      <summary className="cursor-pointer text-small text-secondary">
        {keys.length === 1 ? '1 field changed' : `${keys.length} fields changed`}
      </summary>
      <dl className="mt-1 grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-small">
        {keys.map((key) => (
          <Fragment key={key}>
            <dt className="truncate text-secondary">{key.replaceAll('_', ' ')}</dt>
            <dd className="min-w-0 break-words">
              <span className="text-secondary line-through">{show(from[key])}</span>
              <span aria-hidden="true"> → </span>
              <span>{show(to[key])}</span>
            </dd>
          </Fragment>
        ))}
      </dl>
    </details>
  )
}
