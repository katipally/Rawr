'use client'

import { Button, DataTable, DropdownMenu, EmptyState, Modal, NOTHING_MATCHED, PageHeader, useToast, type Column } from '@rawr/ui'
import { ChevronDown, Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, StatusDot, rowPill } from '~/components/row-actions.tsx'
import type { FilterField, Group } from '~/components/crm/filter-builder.tsx'
import { objectView, segmentsPath } from '~/lib/links.ts'
import { api, errorMessage, trpc } from '~/lib/rpc.ts'
import { useUrlParam } from '~/lib/url-params.ts'
import { useFormat } from '~/components/zone.tsx'
import { useQueryClient } from '@tanstack/react-query'
import { OBJECT_LABEL, SegmentBuilder } from './segment-builder.tsx'

export type SegmentRow = {
  id: string
  name: string
  objectKey: ObjectKey
  description: string | null
  filters: Group[]
  memberCount: number
  /** An imported list: a snapshot of whoever was in the file. The evaluator
   *  leaves it alone, so recomputing it and giving it conditions both do
   *  nothing, and the row has to say which kind it is. */
  isStatic: boolean
  lastEvaluatedAt: string | null
}

export type SegmentListProps = {
  account: string
  rows: SegmentRow[]
  fieldsByObject: Record<string, FilterField[]>
  canWrite: boolean
  hub: string
}

/** HubSpot's ghost filter on its segment list: 14px semibold, no border until
 *  the pointer is over it. */
const ghost =
  'inline-flex min-h-[2.4375rem] items-center gap-1 rounded-hs px-3 font-semibold text-body transition-all duration-150 ease-out hover:bg-fill'

const KIND_LABEL = { all: 'All types', active: 'Active', static: 'Static' } as const

export const SegmentList = ({ account, rows, fieldsByObject, canWrite, hub }: SegmentListProps) => {
  const queryClient = useQueryClient()
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  // ?segment=new or ?segment=<id> opens the builder, and the older
  // ?action=create-list opens it on a static list, so links into either still land.
  const [segmentParam, setSegmentParam] = useUrlParam('segment')
  const [action, setAction] = useUrlParam('action')
  const editing = rows.find((row) => row.id === segmentParam && !row.isStatic) ?? null
  const building = segmentParam === 'new' || editing !== null || action === 'create-list'
  const closeBuilder = () => {
    setSegmentParam(null)
    if (action === 'create-list') setAction(null)
  }

  const [needle, setNeedle] = useState('')
  const [kind, setKind] = useState<'all' | 'active' | 'static'>('all')
  const [objectFilter, setObjectFilter] = useState<'all' | ObjectKey>('all')
  const [removing, setRemoving] = useState<SegmentRow | null>(null)

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try {
      await fn()
      if (done) toast('success', done)
      void queryClient.invalidateQueries(trpc.segments.pathFilter())
      router.refresh()
      return true
    } catch (cause) {
      toast('error', errorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const conditionCount = (groups: Group[]) =>
    groups.reduce((sum, group) => sum + group.conditions.length, 0)

  const query = needle.trim().toLowerCase()
  const shown = rows.filter(
    (row) =>
      (!query || row.name.toLowerCase().includes(query)) &&
      (kind === 'all' || (kind === 'static') === row.isStatic) &&
      (objectFilter === 'all' || row.objectKey === objectFilter),
  )
  const { page, pager } = usePagedRows(shown, 'segments')
  const narrowed = query !== '' || kind !== 'all' || objectFilter !== 'all'

  const recompute = (row: SegmentRow) =>
    void run(async () => {
      const result = await api.segments.evaluate.mutate({ id: row.id })
      toast('info', `${result.members} members: ${result.entered} joined, ${result.exited} left.`)
    })

  const columns: Column<SegmentRow>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 360,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-col">
            <Link href={segmentsPath(account, row.id)} title={row.name} className="truncate font-semibold text-link hover:underline">
              {row.name}
            </Link>
            {row.description ? <span className="truncate text-small text-secondary">{row.description}</span> : null}
          </span>
          <RowActions>
            {canWrite && !row.isStatic ? (
              <button type="button" className={rowPill} onClick={() => setSegmentParam(row.id)}>
                Edit
              </button>
            ) : null}
            <Link href={segmentsPath(account, row.id)} className={rowPill}>
              Details
            </Link>
            <DropdownMenu
              label={`More for ${row.name}`}
              align="start"
              groups={[
                {
                  key: 'read',
                  // A static list holds no conditions, so filtering a record list
                  // by them would show every record rather than its own.
                  items: row.isStatic
                    ? []
                    : [
                        {
                          key: 'list',
                          label: 'Open matching records',
                          href: objectView(account, row.objectKey, 'all', 'list', { filters: JSON.stringify(row.filters) }),
                        },
                      ],
                },
                ...(canWrite
                  ? [
                      ...(row.isStatic ? [] : [{ key: 'write', items: [{ key: 'recompute', label: 'Recompute', onSelect: () => recompute(row) }] }]),
                      { key: 'danger', items: [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => setRemoving(row) }] },
                    ]
                  : []),
              ].filter((group) => group.items.length > 0)}
              trigger={(props) => (
                <button {...props} type="button" className={rowPill}>
                  More
                  <ChevronDown aria-hidden="true" className="size-3" />
                </button>
              )}
            />
          </RowActions>
        </span>
      ),
    },
    {
      key: 'size',
      header: 'List size',
      width: 110,
      align: 'right',
      render: (row) =>
        row.lastEvaluatedAt === null && !row.isStatic ? (
          <span className="text-secondary" title="Never recomputed, so the count is unknown rather than zero">--</span>
        ) : (
          <Link href={segmentsPath(account, row.id)} className="font-semibold text-link hover:underline">
            {fmt.number(row.memberCount)}
          </Link>
        ),
    },
    {
      key: 'type',
      header: 'Type',
      width: 110,
      render: (row) =>
        row.isStatic ? (
          <span title="A snapshot kept by hand. It is never recomputed.">
            <StatusDot tone="off">Static</StatusDot>
          </span>
        ) : (
          <StatusDot tone="live">Active</StatusDot>
        ),
    },
    { key: 'object', header: 'Object', width: 120, render: (row) => OBJECT_LABEL[row.objectKey] },
    {
      key: 'conditions',
      header: 'Conditions',
      width: 110,
      align: 'right',
      render: (row) => (row.isStatic ? <span className="text-secondary">--</span> : conditionCount(row.filters)),
    },
    {
      key: 'updated',
      header: 'Last recomputed',
      width: 200,
      render: (row) =>
        row.isStatic ? (
          <span className="text-secondary">Kept by hand</span>
        ) : row.lastEvaluatedAt === null ? (
          <span className="text-secondary">Never</span>
        ) : (
          fmt.dateTime(row.lastEvaluatedAt)
        ),
    },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHeader
        title="Segments"
        lead={`${fmt.number(rows.length)} segment${rows.length === 1 ? '' : 's'}`}
        why={
          <p>
            Membership is recomputed on a schedule and whenever you ask; entering and leaving both
            land on the record&apos;s timeline, so a contact who left last month still shows why
            they are no longer being mailed. An imported list is a snapshot instead, and says so.
          </p>
        }
        action={
          canWrite ? (
            <span className="flex flex-wrap gap-2">
              {rows.length > 0 ? (
                <Button
                  busy={busy}
                  onClick={() =>
                    void run(async () => {
                      const results = await api.segments.evaluateAll.mutate()
                      const failed = results.filter((entry) => entry.error !== null)
                      if (failed.length > 0) {
                        toast('error', `${failed[0]!.name}: ${failed[0]!.error}`)
                      }
                    }, 'Every segment recomputed.')
                  }
                >
                  Recompute all
                </Button>
              ) : null}
              <Button variant="primary" onClick={() => setSegmentParam('new')}>
                Create segment
              </Button>
            </span>
          ) : undefined
        }
      />

      {canWrite ? null : (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          You need {hub} access to change segments. Marketing and admins own
          who is in a list.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        <DropdownMenu
          label="Segment type"
          align="start"
          groups={[
            {
              key: 'kind',
              items: (Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((key) => ({
                key,
                label: KIND_LABEL[key],
                checked: kind === key,
                onSelect: () => setKind(key),
              })),
            },
          ]}
          trigger={(props) => (
            <button {...props} type="button" className={ghost}>
              {KIND_LABEL[kind]}
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </button>
          )}
        />
        <DropdownMenu
          label="Records"
          align="start"
          groups={[
            {
              key: 'object',
              items: [
                { key: 'all', label: 'All objects', checked: objectFilter === 'all', onSelect: () => setObjectFilter('all') },
                ...(Object.keys(OBJECT_LABEL) as ObjectKey[]).map((key) => ({
                  key,
                  label: OBJECT_LABEL[key],
                  checked: objectFilter === key,
                  onSelect: () => setObjectFilter(key),
                })),
              ],
            },
          ]}
          trigger={(props) => (
            <button {...props} type="button" className={ghost}>
              {objectFilter === 'all' ? 'All objects' : OBJECT_LABEL[objectFilter]}
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </button>
          )}
        />
      </div>

      <label className="relative w-full min-w-0 @lg:w-64">
        <span className="sr-only">Search segments</span>
        <input
          type="search"
          value={needle}
          placeholder="Search segments"
          onChange={(event) => setNeedle(event.target.value)}
          className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-9 pl-4 text-body placeholder:text-muted"
        />
        <Search aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
      </label>

      <DataTable
        columns={columns}
        rows={page}
        rowKey={(row) => row.id}
        caption="Segments in this account"
        storageKey="segments"
        fill
        empty={
          <div className="flex flex-1 flex-col justify-center">
          {narrowed ? (
            <EmptyState {...NOTHING_MATCHED} />
          ) : (
            <EmptyState
              title="No segments yet"
              description="A saved query that remembers who is in it."
              {...(canWrite ? { action: <Button variant="primary" onClick={() => setSegmentParam('new')}>Create segment</Button> } : {})}
            />
          )}
          </div>
        }
      />

      {pager}

      <div className="-mx-3 flex shrink-0 items-center border-t border-line px-3 pt-2 sm:-mx-6 sm:px-6">
        <span className="inline-flex h-8 items-center rounded-pill bg-canvas px-4 text-small font-semibold">
          {fmt.number(shown.length)} {shown.length === 1 ? 'segment' : 'segments'}
        </span>
      </div>

      <SegmentBuilder
        open={canWrite && building}
        segment={editing}
        startStatic={action === 'create-list'}
        fieldsByObject={fieldsByObject}
        onClose={closeBuilder}
        onSaved={(id) => router.push(segmentsPath(account, id))}
      />

      {/* --------------------------------------------------------- delete */}
      <Modal
        open={removing !== null}
        title={`Delete ${removing?.name ?? ''}?`}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button variant="tertiary" disabled={busy} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() =>
                void run(() => api.segments.remove.mutate({ id: removing!.id }), 'Segment deleted.').then((ok) => {
                  if (ok) setRemoving(null)
                })
              }
            >
              Delete
            </Button>
          </>
        }
      >
        <p>
          {removing?.isStatic
            ? 'The records stay where they are. What goes is the list and the record of who was put in it.'
            : 'The records stay where they are. What goes is the saved query and the membership it worked out.'}{' '}
          Not reversible.
        </p>
      </Modal>
    </div>
  )
}
