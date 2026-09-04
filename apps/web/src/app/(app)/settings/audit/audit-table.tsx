'use client'

import { Badge, Button, Card, Combobox, EmptyState, Spinner, useToast } from '@rawr/ui'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

type Row = {
  id: string
  at: string
  actorName: string | null
  actorKind: string
  entity: string
  entityId: string | null
  action: string
  after: unknown
}

type OrgRow = { id: string; at: string; actorName: string | null; entity: string; action: string }

type Cursor = { at: string; id: string } | null

const KIND_TONE: Record<string, 'neutral' | 'accent' | 'info' | 'warn'> = {
  user: 'neutral',
  mcp: 'accent',
  job: 'info',
  integration: 'info',
  public: 'warn',
}

/** A sentence rather than a row of columns: "who did what to which thing" reads
 *  faster than four cells the eye has to reassemble. */
const sentence = (row: Row): string =>
  `${row.actorName ?? 'Somebody'} ${row.action.replaceAll('_', ' ')} a ${row.entity.replaceAll('_', ' ')}`

export const AuditTable = ({
  initial,
  cursor: initialCursor,
  entities,
  people,
  organisation,
  organisationName,
}: {
  initial: Row[]
  cursor: Cursor
  entities: string[]
  people: { userId: string; name: string }[]
  organisation: OrgRow[]
  organisationName: string
}) => {
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
              <li key={row.id} className="flex flex-wrap items-baseline gap-2 px-4 py-2">
                <time dateTime={row.at} className="w-44 shrink-0 text-small text-secondary">
                  {new Date(row.at).toLocaleString()}
                </time>
                <span className="min-w-0 flex-1">{sentence(row)}</span>
                {row.actorKind === 'user' ? null : (
                  <Badge tone={KIND_TONE[row.actorKind] ?? 'neutral'}>{row.actorKind}</Badge>
                )}
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

      {organisation.length > 0 ? (
        <Card title={`${organisationName}, above this workspace`} flush>
          <ul className="divide-y divide-divider">
            {organisation.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2 px-4 py-2">
                <time dateTime={row.at} className="w-44 shrink-0 text-small text-secondary">
                  {new Date(row.at).toLocaleString()}
                </time>
                <span className="min-w-0 flex-1">
                  {row.actorName ?? 'Somebody'} {row.action.replaceAll('_', ' ')} a{' '}
                  {row.entity.replaceAll('_', ' ')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}
