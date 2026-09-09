'use client'

import { Badge, Button, Card, Combobox, EmptyState, Spinner, useToast } from '@rawr/ui'
import { Fragment, useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'

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
}

const pastTense = (verb: string): string =>
  IRREGULAR[verb] ??
  (verb.endsWith('e') ? `${verb}d` : /[aeiou]l$/.test(verb) ? `${verb}led` : `${verb}ed`)

/** A sentence rather than a row of columns: "who did what to which thing" reads
 *  faster than four cells the eye has to reassemble.
 *
 *  Only the first word of an action is the verb, so `save_steps` is "saved steps
 *  on", and the article follows the thing rather than always being "a", which
 *  turned every integration into "a integration". */
const sentence = (row: Pick<Row, 'actorName' | 'action' | 'entity'>): string => {
  const [verb = '', ...rest] = row.action.split('_')
  const thing = row.entity.replaceAll('_', ' ')
  const did = rest.length > 0 ? `${pastTense(verb)} ${rest.join(' ')} on` : pastTense(verb)
  return `${row.actorName ?? 'Somebody'} ${did} ${/^[aeiou]/i.test(thing) ? 'an' : 'a'} ${thing}`
}

export const AuditTable = ({
  initial,
  cursor: initialCursor,
  entities,
  people,
}: {
  initial: Row[]
  cursor: Cursor
  entities: string[]
  people: { userId: string; name: string }[]
}) => {
  const zone = useZone()
  const toast = useToast()
  const [rows, setRows] = useState(initial)
  const [cursor, setCursor] = useState<Cursor>(initialCursor)
  const [entity, setEntity] = useState<string | null>(null)
  const [actorId, setActorId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (next: { entity?: string | null; actorId?: string | null; more?: boolean }) => {
    setBusy(true)
    try {
      const page = await api.admin.audit.list.query({
        entity: next.entity === undefined ? entity : next.entity,
        actorId: next.actorId === undefined ? actorId : next.actorId,
        cursor: next.more ? cursor : null,
        limit: 50,
      })
      // superjson revives the timestamps as Dates; the server component hands
      // them over as strings. One shape here, so the renderer never has to ask.
      const fetched = page.rows.map((row) => ({ ...row, at: row.at.toISOString() }))
      setRows((current) => (next.more ? [...current, ...fetched] : fetched))
      setCursor(page.cursor)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
        <Combobox
          label="Kind of thing"
          value={entity}
          onChange={(value) => {
            setEntity(value)
            void load({ entity: value })
          }}
          options={entities.map((each) => ({ value: each, label: each.replaceAll('_', ' ') }))}
        />
        <Combobox
          label="Who"
          value={actorId}
          onChange={(value) => {
            setActorId(value)
            void load({ actorId: value })
          }}
          options={people.map((person) => ({ value: person.userId, label: person.name }))}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="Clear a filter, or look further back: only changes made through Rawr appear here."
        />
      ) : (
        <Card flush>
          <ul className="divide-y divide-divider">
            {rows.map((row) => (
              <li key={row.id} className="px-4 py-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <time dateTime={row.at} className="w-44 shrink-0 text-small text-secondary">
                    {formatDateTime(row.at, zone)}
                  </time>
                  <span className="min-w-0 flex-1">{sentence(row)}</span>
                  {row.actorKind === 'user' ? null : (
                    <Badge tone={KIND_TONE[row.actorKind] ?? 'neutral'}>{row.actorKind}</Badge>
                  )}
                </div>
                <Diff before={row.before} after={row.after} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex items-center gap-2">
        {cursor ? (
          <Button busy={busy} onClick={() => void load({ more: true })}>
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
  if (value === null || value === undefined || value === '') return '—'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** What actually changed, field by field.
 *
 *  The sentence says a deal was updated; this says the stage went from
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
    <details className="mt-1">
      <summary className="cursor-pointer text-small text-secondary">
        {keys.length === 1 ? '1 field changed' : `${keys.length} fields changed`}
      </summary>
      <dl className="mt-1 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-small">
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
