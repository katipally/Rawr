'use client'

import { Alert, Avatar, IconButton, Spinner, useMounted, usePresence } from '@rawr/ui'
import { CalendarDays, Mail, Phone, SquareCheck, StickyNote, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CopyButton } from '~/components/copy-button.tsx'
import { useFormat } from '~/components/zone.tsx'
import { PREVIEW_DOCK } from '~/lib/docks.ts'
import { inSentence } from '~/lib/label-case.ts'
import { recordPath } from '~/lib/links.ts'
import { trpc } from '~/lib/rpc.ts'
import type { TableColumn } from './record-table.tsx'
import { EMPTY_VALUE, Value } from './value.tsx'
import { useQueryClient } from '@tanstack/react-query'

type Loaded = {
  record: { displayName: string; values: Record<string, unknown>; labels: Record<string, string> }
  groups: { objectKey: string; namePlural: string; total: number; records: { id: string; displayName: string }[] }[]
}

export type RecordPreviewProps = {
  account: string
  object: string
  /** "Contact", for the heading over its properties. */
  objectLabel: string
  /** The record on show, or null when the panel is shut. */
  id: string | null
  /** The few properties worth reading before opening the record. */
  fields: TableColumn[]
  canWrite: boolean
  /** The list this panel is over, so the links out of it lead back to it. */
  from: string
  onClose: () => void
}

/** How many linked records a group names before it says how many more there are. */
const NAMED = 3

/** Matches --rawr-duration-preview, which the width transition runs for. */
const PREVIEW_EXIT_MS = 280

/** HubSpot's preview: enough of a record to decide whether it is the one, without
 *  leaving the list. A card docked beside the page card rather than a dialog over
 *  it, so the list stays usable and another row's preview swaps in place. It
 *  reads through the same procedures the record page does, and holds nothing the
 *  address does not, so a reload reopens it. */
export const RecordPreview = ({ account, object, objectLabel, id, fields, canWrite, from, onClose }: RecordPreviewProps) => {
  const queryClient = useQueryClient()
  const fmt = useFormat()
  const mounted = useMounted()
  const panel = useRef<HTMLElement>(null)
  const [loaded, setLoaded] = useState<{ id: string; data: Loaded | null } | null>(null)
  // The last record shown, so the card keeps its content while it slides shut.
  const [current, setCurrent] = useState(id)
  if (id && id !== current) setCurrent(id)
  const { present, closing } = usePresence(id !== null && mounted, PREVIEW_EXIT_MS)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    if (!id) return
    let live = true
    Promise.all([
      queryClient.fetchQuery({ ...trpc.crm.records.get.queryOptions({ object, id }), staleTime: 0 }),
      queryClient.fetchQuery({ ...trpc.crm.associations.read.queryOptions({ entity: { entityType: object, entityId: id } }), staleTime: 0 }),
    ])
      .then(([record, rail]) => {
        if (live) setLoaded({ id, data: record ? { record, groups: rail.groups.filter((group) => group.total > 0) } : null })
      })
      .catch(() => {
        if (live) setLoaded({ id, data: null })
      })
    return () => {
      live = false
    }
  }, [object, id, queryClient])

  useEffect(() => {
    if (!id) return
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      // A dialog open over the page owns its own Escape.
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
      close.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [id])

  const dock = mounted ? document.getElementById(PREVIEW_DOCK) : null
  if (!present || !dock || !current) return null

  const data = loaded?.id === current ? loaded.data : undefined
  const open = (params: Parameters<typeof recordPath>[3]) => recordPath(account, object, current, { from, ...params })
  const email = typeof data?.record.values.email === 'string' ? data.record.values.email : ''
  const actions = [
    { label: 'Note', icon: StickyNote, params: { interaction: 'note' } },
    ...(object === 'contact' && email ? [{ label: 'Email', icon: Mail, params: { tab: 'activities', compose: '1' } }] : []),
    { label: 'Call', icon: Phone, params: { interaction: 'call' } },
    { label: 'Task', icon: SquareCheck, params: { interaction: 'task' } },
    { label: 'Meeting', icon: CalendarDays, params: { interaction: 'meeting' } },
  ]

  return createPortal(
    // The wrapper's width is what animates, so the page card beside it gives up
    // the room in step. On a shell too narrow to share, it covers the card.
    <div
      data-closing={closing || undefined}
      className="w-[min(calc(var(--spacing-preview)+var(--spacing-dock-gap)),100cqw)] shrink-0 overflow-hidden transition-[width] duration-(--rawr-duration-preview) ease-preview starting:w-0 data-closing:w-0 motion-reduce:transition-none @max-dock/shell:absolute @max-dock/shell:inset-y-0 @max-dock/shell:right-0 @max-dock/shell:z-flyout"
    >
      <aside
        ref={panel}
        aria-label={`Preview of ${data?.record.displayName ?? inSentence(objectLabel)}`}
        tabIndex={-1}
        inert={closing}
        className="ml-dock-gap flex h-full w-[min(var(--spacing-preview),calc(100cqw-var(--spacing-dock-gap)))] flex-col overflow-hidden rounded-panel bg-surface text-body shadow-panel outline-none @max-dock/shell:shadow-overlay"
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line py-4 pr-6 pl-4">
          <h2 className="min-w-0 flex-1 truncate text-lg font-normal">Preview</h2>
          <IconButton label="Close preview" icon={<X aria-hidden="true" className="size-4" />} onClick={onClose} className="text-body" />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {data === undefined ? (
            <div className="flex justify-center p-4">
              <Spinner />
            </div>
          ) : data === null ? (
            <div className="p-4">
              <Alert>That record could not be opened. It may have been deleted.</Alert>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-4 p-4">
                <Link href={open({})} className="self-start hover:underline">
                  View record
                </Link>
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={data.record.displayName} size="lg" />
                  <div className="min-w-0">
                    <p className="truncate text-[1.375rem] font-medium" title={data.record.displayName}>
                      {data.record.displayName}
                    </p>
                    {email ? (
                      <span className="flex min-w-0 items-center gap-1">
                        <a href={`mailto:${email}`} className="min-w-0 truncate hover:underline" title={email}>
                          {email}
                        </a>
                        <CopyButton value={email} what="Email" />
                      </span>
                    ) : null}
                  </div>
                </div>
                {canWrite ? (
                  <div className="flex flex-wrap justify-between gap-2">
                    {actions.map((action) => (
                      <Link
                        key={action.label}
                        href={open(action.params)}
                        className="group flex flex-col items-center gap-1 text-small font-light text-body no-underline"
                      >
                        <span className="grid size-8 place-items-center rounded-pill border border-line-strong transition-all duration-150 ease-out group-hover:bg-fill">
                          <action.icon aria-hidden="true" className="size-4" />
                        </span>
                        {action.label}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>

              <section className="border-t border-line px-4 py-3">
                <h3 className="font-semibold">About this {inSentence(objectLabel)}</h3>
                <dl className="flex flex-col">
                  {fields.map((field) => (
                    <div key={field.key} className="mt-2 min-w-0">
                      <dt className="text-small text-secondary">{field.label}</dt>
                      <dd className="min-w-0">
                        <Value
                          format={fmt}
                          type={field.type}
                          value={data.record.values[field.key]}
                          label={data.record.labels[field.key]}
                          currency={data.record.values.currency}
                          placeholder={EMPTY_VALUE}
                        />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>

              {data.groups.map((group) => (
                <section key={group.objectKey} className="min-w-0 border-t border-line px-4 py-3">
                  <h3 className="font-semibold">
                    {group.namePlural} ({fmt.number(group.total)})
                  </h3>
                  <ul className="mt-1">
                    {group.records.slice(0, NAMED).map((row) => (
                      <li key={row.id} className="min-w-0 truncate">
                        <Link href={recordPath(account, group.objectKey, row.id, { from })} title={row.displayName}>
                          {row.displayName}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {group.total > NAMED ? (
                    <p className="text-small text-secondary">and {fmt.number(group.total - NAMED)} more</p>
                  ) : null}
                </section>
              ))}
            </>
          )}
        </div>
      </aside>
    </div>,
    dock,
  )
}
