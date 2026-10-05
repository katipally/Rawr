'use client'

import { Alert, SidePanel, Spinner, buttonClass } from '@rawr/ui'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { LinkButton } from '~/components/link-button.tsx'
import { useFormat } from '~/components/zone.tsx'
import { recordPath } from '~/lib/links.ts'
import { trpc } from '~/lib/rpc.ts'
import type { TableColumn } from './record-table.tsx'
import { Value } from './value.tsx'
import { useQueryClient } from '@tanstack/react-query'

type Loaded = {
  record: { displayName: string; values: Record<string, unknown>; labels: Record<string, string> }
  groups: { objectKey: string; namePlural: string; total: number; records: { id: string; displayName: string }[] }[]
}

export type RecordPreviewProps = {
  account: string
  object: string
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

/** HubSpot's preview: enough of a record to decide whether it is the one, without
 *  leaving the list. It reads through the same procedures the record page does,
 *  and holds nothing the address does not, so a reload reopens it. */
export const RecordPreview = ({ account, object, id, fields, canWrite, from, onClose }: RecordPreviewProps) => {
  const queryClient = useQueryClient()
  const fmt = useFormat()
  const [loaded, setLoaded] = useState<{ id: string; data: Loaded | null } | null>(null)

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

  const data = loaded?.id === id ? loaded.data : undefined
  const open = (params: Parameters<typeof recordPath>[3]) => recordPath(account, object, id ?? '', { from, ...params })

  return (
    <SidePanel open={id !== null} onClose={onClose} title={data?.record.displayName ?? 'Preview'}>
      {data === undefined ? (
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      ) : data === null ? (
        <Alert>That record could not be opened. It may have been deleted.</Alert>
      ) : (
        <div className="flex flex-col gap-5">
          <LinkButton variant="primary" href={open({})} className="self-start">
            View record
          </LinkButton>

          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              {[
                { label: 'Note', params: { log: 'note' } },
                { label: 'Call', params: { log: 'call' } },
                { label: 'Meeting', params: { log: 'meeting' } },
                { label: 'Task', params: { task: 'new' } },
              ].map((action) => (
                <Link key={action.label} href={open(action.params)} className={buttonClass('secondary', 'no-underline')}>
                  {action.label}
                </Link>
              ))}
            </div>
          ) : null}

          <section>
            <h3 className="mb-2 font-semibold">About</h3>
            <dl className="flex flex-col gap-3">
              {fields.map((field) => (
                <div key={field.key} className="min-w-0">
                  <dt className="text-small text-secondary">{field.label}</dt>
                  <dd className="min-w-0">
                    <Value
                      format={fmt}
                      type={field.type}
                      value={data.record.values[field.key]}
                      label={data.record.labels[field.key]}
                      currency={data.record.values.currency}
                      placeholder="—"
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {data.groups.length > 0 ? (
            <section>
              <h3 className="mb-2 font-semibold">Associations</h3>
              <ul className="flex flex-col gap-3">
                {data.groups.map((group) => (
                  <li key={group.objectKey} className="min-w-0">
                    <p className="text-small text-secondary">
                      {group.namePlural} ({fmt.number(group.total)})
                    </p>
                    <ul>
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
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </SidePanel>
  )
}
