'use client'

import { Badge, Button, Card, DataTable, Field, IconButton, Modal, Pagination, Select, TextInput, useToast } from '@rawr/ui'
import { Trash2 } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

export type EventDefView = {
  id: string
  name: string
  label: string | null
  properties: Record<string, unknown>
  discovered: boolean
  lastSeenDay: string | null
  updatedAt: string
}

type Page = { rows: EventDefView[]; total: number }

const PER_PAGE = 25

const TYPES = ['string', 'number', 'boolean', 'date']

type PropertyRow = { key: string; type: string }

const rowsFrom = (properties: Record<string, unknown>): PropertyRow[] =>
  Object.entries(properties).map(([key, value]) => ({
    key,
    type: typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
      ? (value as { type: string }).type
      : 'string',
  }))

export const EventDefList = ({ initial, search: initialSearch }: { initial: Page; search: string }) => {
  const zone = useZone()
  const toast = useToast()
  const router = useRouter()
  const pathname = usePathname()
  const [page, setPage] = useState<Page>(initial)
  const [search, setSearch] = useState(initialSearch)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<EventDefView | null>(null)

  const load = useCallback(
    (nextOffset: number, needle: string) => {
      setBusy(true)
      api.analytics.events.list
        .query({ search: needle || null, limit: PER_PAGE, offset: nextOffset })
        .then((result) =>
          setPage({
            rows: result.rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
            total: result.total,
          }),
        )
        .catch((cause) => toast('error', errorMessage(cause)))
        .finally(() => setBusy(false))
    },
    [toast],
  )

  // A typed search is one request after the typing stops, not one per keystroke,
  // and the address follows it so a search can be linked to or reloaded. The
  // query is read at the moment the timer fires rather than tracked as a
  // dependency, which would run this again on the replace it just made.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const needle = search.trim()
      setOffset(0)
      load(0, needle)
      const query = new URLSearchParams(window.location.search)
      if (needle) query.set('q', needle)
      else query.delete('q')
      const next = query.toString()
      if (next !== window.location.search.replace(/^\?/, '')) {
        router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false })
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search, load, pathname, router])

  const move = (next: number) => {
    setOffset(next)
    load(next, search.trim())
  }

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Field label="Search" id="event-search">
              <TextInput
                id="event-search"
                type="search"
                placeholder="Event name or label"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
          </div>
          <Button
            variant="secondary"
            onClick={() =>
              setEditing({
                id: '',
                name: '',
                label: null,
                properties: {},
                discovered: false,
                lastSeenDay: null,
                updatedAt: new Date().toISOString(),
              })
            }
          >
            Describe an event
          </Button>
        </div>

        <DataTable
          caption="Event definitions"
          storageKey="tracking-events"
          rows={page.rows}
          rowKey={(row) => row.id}
          onRowClick={(row) => setEditing(row)}
          empty={
            <p className="text-secondary">
              {search.trim()
                ? 'No event matches that.'
                : 'No site has fired a custom event yet. Once one does, its name appears here on its own.'}
            </p>
          }
          columns={[
            {
              key: 'name',
              header: 'Event',
              render: (row) => (
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{row.label ?? row.name}</span>
                  {row.label ? <span className="truncate text-secondary">{row.name}</span> : null}
                </span>
              ),
            },
            {
              key: 'state',
              header: 'Described',
              width: 130,
              render: (row) =>
                row.discovered ? <Badge>Not yet</Badge> : <Badge tone="ok">Yes</Badge>,
            },
            {
              key: 'properties',
              header: 'Properties',
              width: 120,
              align: 'right',
              render: (row) => <span className="tabular-nums">{Object.keys(row.properties).length}</span>,
            },
            {
              key: 'seen',
              header: 'Last seen',
              width: 160,
              render: (row) => <span className="text-secondary">{row.lastSeenDay ?? 'Not in the last 30 days'}</span>,
            },
            {
              key: 'updated',
              header: 'Updated',
              width: 190,
              render: (row) => <span className="text-secondary">{formatDateTime(row.updatedAt, zone)}</span>,
            },
          ]}
        />

        <Pagination
          count={page.rows.length}
          offset={offset}
          total={page.total}
          perPage={PER_PAGE}
          noun="events"
          onPrevious={() => move(Math.max(offset - PER_PAGE, 0))}
          onNext={() => move(offset + PER_PAGE)}
        />
      </div>

      {editing ? (
        <EventDefEditor
          row={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load(offset, search.trim())
          }}
        />
      ) : null}
    </Card>
  )
}

const EventDefEditor = ({
  row,
  busy,
  onClose,
  onSaved,
}: {
  row: EventDefView
  busy: boolean
  onClose: () => void
  onSaved: () => void
}) => {
  const toast = useToast()
  const [name, setName] = useState(row.name)
  const [label, setLabel] = useState(row.label ?? '')
  const [properties, setProperties] = useState<PropertyRow[]>(rowsFrom(row.properties))
  const [saving, setSaving] = useState(false)

  const save = () => {
    setSaving(true)
    api.analytics.events.save
      .mutate({
        name: name.trim(),
        label: label.trim() || null,
        properties: Object.fromEntries(
          properties
            .filter((property) => property.key.trim())
            .map((property) => [property.key.trim(), { type: property.type }]),
        ),
      })
      .then(() => {
        toast('success', 'Saved. The events report and the funnel builder use this name.')
        onSaved()
      })
      .catch((cause) => toast('error', errorMessage(cause)))
      .finally(() => setSaving(false))
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={row.id ? row.name : 'Describe an event'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={saving || busy} disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Event name"
          id="event-name"
          hint="Exactly the string the site fires. Changing it here describes a different event; it does not rename anything already collected."
        >
          <TextInput
            id="event-name"
            value={name}
            readOnly={Boolean(row.id)}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Label" id="event-label" hint="What a reader should see instead of the raw name.">
          <TextInput id="event-label" value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>

        <div className="flex flex-col gap-2">
          <p className="font-medium">Properties</p>
          <p className="max-w-prose text-small text-secondary">
            What the site promises to send with this event. Advisory: the collector strips anything
            that looks like personal data and stores the rest whatever this says.
          </p>
          {properties.map((property, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label="Name" id={`property-key-${index}`}>
                  <TextInput
                    id={`property-key-${index}`}
                    value={property.key}
                    onChange={(event) =>
                      setProperties((rows) =>
                        rows.map((each, at) => (at === index ? { ...each, key: event.target.value } : each)),
                      )
                    }
                  />
                </Field>
              </div>
              <Field label="Type" id={`property-type-${index}`}>
                <Select
                  id={`property-type-${index}`}
                  value={property.type}
                  onChange={(event) =>
                    setProperties((rows) =>
                      rows.map((each, at) => (at === index ? { ...each, type: event.target.value } : each)),
                    )
                  }
                >
                  {TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
              </Field>
              <IconButton
                label={`Remove ${property.key || 'this property'}`}
                icon={<Trash2 aria-hidden="true" className="size-4" />}
                onClick={() => setProperties((rows) => rows.filter((_each, at) => at !== index))}
              />
            </div>
          ))}
          <div>
            <Button
              variant="tertiary"
              onClick={() => setProperties((rows) => [...rows, { key: '', type: 'string' }])}
            >
              Add a property
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
