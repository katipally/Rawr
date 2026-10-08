'use client'

import { Button, ConfirmDialog, DataTable, DropdownMenu, EmptyState, IconButton, Pagination, useToast, type Column } from '@rawr/ui'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronLeft, Pencil, Trash2, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import type { FilterField } from '~/components/crm/filter-builder.tsx'
import { RowActions, StatusDot, rowPill } from '~/components/row-actions.tsx'
import { useFormat } from '~/components/zone.tsx'
import { objectView, recordPath, segmentsPath } from '~/lib/links.ts'
import { useOrigin } from '~/lib/use-origin.ts'
import { closeParamsAndRefresh, useUrlParam } from '~/lib/url-params.ts'
import { api, errorMessage, trpc } from '~/lib/rpc.ts'
import { useQueryClient } from '@tanstack/react-query'
import { OBJECT_LABEL, SegmentBuilder, SegmentConditions } from '../segment-builder.tsx'
import type { SegmentRow } from '../segment-list.tsx'
import { lastPageStart } from './page-offset.ts'

type Member = { id: string; displayName: string; enteredAt: string }
type MemberSort = { by: 'name' | 'added'; dir: 'asc' | 'desc' }

const DEFAULT_SORT: MemberSort = { by: 'added', dir: 'desc' }

export type ListMembersProps = {
  account: string
  list: SegmentRow
  fields: FilterField[]
  initial: Member[]
  /** One screenful. The list itself can hold eighty thousand, so the page walks
   *  it rather than asking for it. Set by the server page, which fetched the
   *  first screenful with the same number. */
  pageSize: number
  canWrite: boolean
}

const bulkAction =
  'inline-flex h-[calc(var(--spacing-row)-2px)] shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-body font-semibold transition-all duration-150 ease-out hover:bg-fill disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent'

const tag = 'inline-flex h-[1.4375rem] items-center rounded-hs border px-2 text-small font-semibold'

const Metric = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex min-w-0 flex-col items-center gap-1 px-3 py-2 text-center">
    <span className="text-small font-semibold uppercase">{label}</span>
    <span className="max-w-full truncate text-kpi">{children}</span>
  </div>
)

/** HubSpot's segment page: the name with its object, type and size as tags, the
 *  filters in a card at the left, and the members under a strip of numbers at
 *  the right. A static list's members are put in and taken out here; an active
 *  one's follow its filters, so its table is read-only and Edit changes the rule. */
export const ListMembers = ({ account, list, fields, initial, pageSize, canWrite }: ListMembersProps) => {
  const queryClient = useQueryClient()
  const fmt = useFormat()
  const origin = useOrigin()
  const router = useRouter()
  const toast = useToast()
  const [members, setMembers] = useState(initial)
  const [offset, setOffset] = useState(0)
  const [perPage, setPerPage] = useState(pageSize)
  const [sort, setSort] = useState<MemberSort>(DEFAULT_SORT)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [segmentParam, setSegmentParam] = useUrlParam('segment')

  const load = async (next: number, size = perPage, order = sort) => {
    setBusy(true)
    try {
      const rows = await queryClient.fetchQuery({
        ...trpc.segments.members.queryOptions({ id: list.id, limit: size, offset: next, by: order.by, dir: order.dir }),
        staleTime: 0,
      })
      setMembers(rows.map((row) => ({ ...row, enteredAt: row.enteredAt.toISOString() })))
      setOffset(next)
      setPerPage(size)
      setSort(order)
      setSelected(new Set())
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (ids: string[]) => {
    setBusy(true)
    try {
      const result = await api.segments.removeMembers.mutate({ id: list.id, ids })
      toast('success', `${result.removed} taken off ${list.name}.`)
      setSelected(new Set())
      // Back to the same place in the list, unless that place is past the last
      // row now; asking for an offset past the end returns nothing.
      await load(Math.min(offset, lastPageStart(list.memberCount - result.removed, perPage)))
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
      setRemoving(null)
    }
  }

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try {
      await fn()
      if (done) toast('success', done)
      void queryClient.invalidateQueries(trpc.segments.pathFilter())
      return true
    } catch (cause) {
      toast('error', errorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const editable = canWrite && list.isStatic
  const conditions = list.filters.reduce((sum, group) => sum + group.conditions.length, 0)

  const sortControl = (by: MemberSort['by'], label: string) => {
    const active = sort.by === by ? sort.dir : null
    const next: MemberSort = { by, dir: active === 'asc' ? 'desc' : active === 'desc' ? 'asc' : by === 'name' ? 'asc' : 'desc' }
    const Icon = active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ArrowUpDown
    return (
      <button
        type="button"
        aria-label={`Sort by ${label} ${next.dir === 'asc' ? 'ascending' : 'descending'}`}
        disabled={busy}
        onClick={() => void load(0, perPage, next)}
        className="grid size-6 shrink-0 place-items-center rounded-pill text-body hover:bg-fill-hover disabled:text-muted"
      >
        <Icon aria-hidden="true" className="size-3.5" />
      </button>
    )
  }

  const columns: Column<Member>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 360,
      headerAside: sortControl('name', 'name'),
      ...(sort.by === 'name' ? { sort: sort.dir === 'asc' ? 'ascending' : 'descending' } : {}),
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <Link
            href={recordPath(account, list.objectKey, row.id, { from: origin })}
            title={row.displayName}
            className="min-w-0 truncate font-semibold text-link hover:underline"
          >
            {row.displayName}
          </Link>
          {editable ? (
            <RowActions>
              <button type="button" className={rowPill} disabled={busy} onClick={() => setRemoving([row.id])}>
                Remove
              </button>
            </RowActions>
          ) : null}
        </span>
      ),
    },
    {
      key: 'entered',
      header: 'Added',
      width: 220,
      headerAside: sortControl('added', 'date added'),
      ...(sort.by === 'added' ? { sort: sort.dir === 'asc' ? 'ascending' : 'descending' } : {}),
      render: (row) => fmt.dateTime(row.enteredAt),
    },
  ]

  const ticked = [...selected]

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 pb-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Link
            href={segmentsPath(account)}
            className="inline-flex items-center gap-0.5 self-start text-small font-semibold text-body no-underline hover:underline"
          >
            <ChevronLeft aria-hidden="true" className="size-3.5" />
            Back to segments
          </Link>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 break-words text-xl font-medium">{list.name}</h1>
            <span className={`${tag} border-tag-object bg-tag-object-subtle`}>{OBJECT_LABEL[list.objectKey]}</span>
            <span className={`${tag} ${list.isStatic ? 'border-line-strong bg-fill-header-hover' : 'border-status-live bg-status-live-subtle'}`}>
              {list.isStatic ? 'Static' : 'Active'}
            </span>
            <span className={`${tag} border-line-strong bg-fill-header-hover`}>Size: {fmt.number(list.memberCount)}</span>
          </div>
          <p className="max-w-prose break-words text-secondary">{list.description ?? 'No description.'}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canWrite && !list.isStatic ? (
            <Button icon={<Pencil aria-hidden="true" className="size-3.5" />} onClick={() => setSegmentParam(list.id)}>
              Edit
            </Button>
          ) : null}
          <DropdownMenu
            label="Actions"
            groups={[
              {
                key: 'read',
                items: list.isStatic
                  ? []
                  : [
                      {
                        key: 'records',
                        label: 'Open matching records',
                        href: objectView(account, list.objectKey, 'all', 'list', { filters: JSON.stringify(list.filters) }),
                      },
                    ],
              },
              ...(canWrite
                ? [
                    ...(list.isStatic
                      ? []
                      : [
                          {
                            key: 'write',
                            items: [
                              {
                                key: 'recompute',
                                label: 'Recompute',
                                onSelect: () =>
                                  void act(async () => {
                                    const result = await api.segments.evaluate.mutate({ id: list.id })
                                    toast('info', `${result.members} members: ${result.entered} joined, ${result.exited} left.`)
                                    await load(0)
                                    router.refresh()
                                  }),
                              },
                            ],
                          },
                        ]),
                    { key: 'danger', items: [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => setDeleting(true) }] },
                  ]
                : []),
            ].filter((group) => group.items.length > 0)}
            trigger={(props) => (
              <Button {...props} variant="primary">
                <span className="flex items-center gap-1">
                  Actions
                  <ChevronDown aria-hidden="true" className="size-3" />
                </span>
              </Button>
            )}
          />
        </div>
      </header>

      <div className="-mx-3 -mb-3 grid flex-1 content-start items-start gap-4 border-t border-line bg-canvas p-4 sm:-mx-6 sm:-mb-6 @4xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <section aria-labelledby="segment-filters" className="flex min-w-0 flex-col gap-4 rounded-panel border border-line bg-surface p-6">
          <div className="flex items-center gap-2">
            <h2 id="segment-filters" className="text-xl font-medium">
              Filters
            </h2>
            {canWrite && !list.isStatic ? (
              <button type="button" className={rowPill} onClick={() => setSegmentParam(list.id)}>
                Edit
              </button>
            ) : null}
          </div>
          {list.isStatic ? (
            <p className="text-secondary">
              A static list has no filters. It holds whoever was put in it: fill it from the bulk bar on any list of
              records, or from an imported file. Nothing recomputes it, and removing one ends their spell rather than
              erasing it, so the timeline still says when they were on here.
            </p>
          ) : conditions === 0 ? (
            <p className="text-secondary">No filters yet.</p>
          ) : (
            <SegmentConditions fields={fields} filters={list.filters} />
          )}
        </section>

        <section aria-label="Members" className="flex min-w-0 flex-col gap-4 rounded-panel border border-line bg-surface p-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] rounded-panel border border-line p-1">
            <Metric label="Size">{fmt.number(list.memberCount)}</Metric>
            <Metric label="Type">
              <StatusDot tone={list.isStatic ? 'off' : 'live'}>{list.isStatic ? 'Static' : 'Active'}</StatusDot>
            </Metric>
            <Metric label="Conditions">{list.isStatic ? '--' : fmt.number(conditions)}</Metric>
            <Metric label="Last recomputed">
              {list.isStatic ? 'Kept by hand' : list.lastEvaluatedAt ? fmt.date(list.lastEvaluatedAt) : 'Never'}
            </Metric>
          </div>

          <DataTable
            columns={columns}
            rows={members}
            rowKey={(row) => row.id}
            caption={`Members of ${list.name}`}
            storageKey={`segment.${list.id}`}
            {...(editable ? { selection: { selected, onChange: setSelected, noun: 'member' } } : {})}
            headerBar={
              editable && ticked.length > 0 ? (
                <div
                  role="toolbar"
                  aria-label={`Actions for ${ticked.length} selected members`}
                  className="flex h-full min-w-0 animate-drop-in items-center gap-0.5 rounded-hs border border-line bg-surface pl-4 motion-reduce:animate-none"
                >
                  <span className="mr-3 min-w-0 shrink truncate font-semibold">
                    {fmt.number(ticked.length)} {ticked.length === 1 ? 'member' : 'members'} selected
                  </span>
                  <button type="button" className={bulkAction} disabled={busy} onClick={() => setRemoving(ticked)}>
                    <Trash2 aria-hidden="true" className="size-4" />
                    Remove from list
                  </button>
                  <IconButton
                    label="Clear the selection"
                    icon={<X aria-hidden="true" className="size-4" />}
                    onClick={() => setSelected(new Set())}
                    className="mr-1 ml-auto shrink-0 text-body"
                  />
                </div>
              ) : null
            }
            empty={
              <EmptyState
                title="Nobody is on this list"
                description={
                  list.isStatic
                    ? 'Tick records on any list and use "Add to list" to fill it.'
                    : 'It has no members right now. Recompute it, or widen its conditions.'
                }
              />
            }
          />

          {list.memberCount > 0 ? (
            <Pagination
              format={fmt.number}
              count={members.length}
              offset={offset}
              total={list.memberCount}
              perPage={perPage}
              noun="members"
              onPrevious={() => void load(Math.max(0, offset - perPage))}
              onNext={() => void load(offset + perPage)}
              onPage={(page) => void load((page - 1) * perPage)}
              onPerPage={(size) => void load(0, size)}
            />
          ) : null}
        </section>
      </div>

      <SegmentBuilder
        open={canWrite && !list.isStatic && segmentParam === list.id}
        segment={list}
        startStatic={false}
        fieldsByObject={{ [list.objectKey]: fields }}
        onClose={() => setSegmentParam(null)}
        onSaved={() => {
          void load(0)
          closeParamsAndRefresh(router, { segment: null })
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        title={`Take ${fmt.number(removing?.length ?? 0)} off ${list.name}?`}
        confirm="Remove from list"
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      >
        <p>
          The records themselves stay. Each one&apos;s time on the list ends, and the timeline keeps
          saying when it was on here.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting}
        title={`Delete ${list.name}?`}
        confirm="Delete"
        busy={busy}
        onCancel={() => setDeleting(false)}
        onConfirm={() =>
          void act(() => api.segments.remove.mutate({ id: list.id }), 'Segment deleted.').then((ok) => {
            if (ok) router.push(segmentsPath(account))
            else setDeleting(false)
          })
        }
      >
        <p>
          {list.isStatic
            ? 'The records stay where they are. What goes is the list and the record of who was put in it.'
            : 'The records stay where they are. What goes is the saved query and the membership it worked out.'}{' '}
          Not reversible.
        </p>
      </ConfirmDialog>
    </div>
  )
}
