'use client'

import { Button, DataTable, DropdownMenu, EmptyState, Field, IconButton, Modal, NOTHING_MATCHED, PageHeader, Select, TextInput, useToast, type Column } from '@rawr/ui'
import { MoreVertical, Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { usePagedRows } from '~/components/paged.tsx'
import { FilterBuilder, type FilterField, type Group } from '~/components/crm/filter-builder.tsx'
import { objectView, recordPath, segmentsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'

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

const OBJECT_LABEL: Record<ObjectKey, string> = {
  contact: 'Contacts',
  company: 'Companies',
  deal: 'Deals',
}

export const SegmentList = ({ account, rows, fieldsByObject, canWrite, hub }: SegmentListProps) => {
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const [editing, setEditing] = useState<SegmentRow | 'new' | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [object, setObject] = useState<ObjectKey>('contact')
  const [filters, setFilters] = useState<Group[]>([{ conjunction: 'and', conditions: [] }])
  const [preview, setPreview] = useState<{ count: number; sample: { id: string; displayName: string }[] } | null>(null)
  const [showBuilder, setShowBuilder] = useState(false)

  const [needle, setNeedle] = useState('')
  const [kind, setKind] = useState<'all' | 'active' | 'static'>('all')
  const [objectFilter, setObjectFilter] = useState<'all' | ObjectKey>('all')
  const [creatingList, setCreatingList] = useState(false)
  const [viewing, setViewing] = useState<SegmentRow | null>(null)
  const [members, setMembers] = useState<{ id: string; displayName: string; enteredAt: Date }[] | null>(null)

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast('success', done)
      router.refresh()
      return true
    } catch (cause) {
      toast('error', errorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const openNew = () => {
    setEditing('new')
    setName('')
    setDescription('')
    setObject('contact')
    setFilters([{ conjunction: 'and', conditions: [] }])
    setPreview(null)
  }

  const openEdit = (row: SegmentRow) => {
    setEditing(row)
    setName(row.name)
    setDescription(row.description ?? '')
    setObject(row.objectKey)
    setFilters(row.filters.length > 0 ? row.filters : [{ conjunction: 'and', conditions: [] }])
    setPreview(null)
  }

  const runPreview = async (next: Group[]) => {
    setFilters(next)
    setPreview(null)
    try {
      setPreview(await api.segments.preview.query({ object, filters: next as never }))
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const save = async () => {
    const ok = await run(
      () =>
        api.segments.save.mutate({
          id: editing === 'new' || editing === null ? null : editing.id,
          object,
          name,
          description: description || null,
          filters: filters as never,
        }),
      'Segment saved. Recompute it to fill in who is in it.',
    )
    if (ok) setEditing(null)
  }

  const openMembers = async (row: SegmentRow) => {
    setViewing(row)
    setMembers(null)
    try {
      setMembers(await api.segments.members.query({ id: row.id }))
    } catch (cause) {
      toast('error', errorMessage(cause))
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
    }, 'Recomputed.')

  const columns: Column<SegmentRow>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 320,
      render: (row) => (
        <span className="flex min-w-0 flex-col py-1">
          {row.isStatic ? (
            <Link href={segmentsPath(account, row.id)} className="truncate font-semibold text-link hover:underline">
              {row.name}
            </Link>
          ) : (
            <button type="button" onClick={() => void openMembers(row)} className="truncate text-left font-semibold text-link hover:underline">
              {row.name}
            </button>
          )}
          {row.description ? <span className="truncate text-small text-secondary">{row.description}</span> : null}
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
          <button type="button" onClick={() => void openMembers(row)} className="font-semibold text-link hover:underline">
            {row.memberCount.toLocaleString()}
          </button>
        ),
    },
    {
      key: 'type',
      header: 'Type',
      width: 110,
      render: (row) =>
        row.isStatic ? (
          <span className="inline-flex items-center gap-2" title="A snapshot of an imported file. It is never recomputed.">
            <span aria-hidden="true" className="size-2 rounded-pill bg-line-strong" />
            Static
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="size-2 rounded-pill bg-success" />
            Active
          </span>
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
          <span className="text-secondary">Imported</span>
        ) : row.lastEvaluatedAt === null ? (
          <span className="text-secondary">Never</span>
        ) : (
          formatDateTime(row.lastEvaluatedAt, zone)
        ),
    },
    {
      key: 'actions',
      header: '',
      width: 64,
      render: (row) => (
        <DropdownMenu
          label={`Actions for ${row.name}`}
          groups={[
            {
              key: 'read',
              items: [
                { key: 'members', label: 'View members', onSelect: () => void openMembers(row) },
                {
                  key: 'list',
                  label: 'Open as a list',
                  href: objectView(account, row.objectKey, 'all', 'list', { filters: JSON.stringify(row.filters) }),
                },
              ],
            },
            ...(canWrite
              ? [
                  {
                    key: 'write',
                    items: row.isStatic
                      ? [
                          {
                            key: 'static',
                            label: 'Open the list',
                            href: segmentsPath(account, row.id),
                          },
                        ]
                      : [
                          { key: 'recompute', label: 'Recompute', onSelect: () => recompute(row) },
                          { key: 'edit', label: 'Edit', onSelect: () => openEdit(row) },
                        ],
                  },
                  {
                    key: 'danger',
                    items: [
                      {
                        key: 'delete',
                        label: 'Delete',
                        destructive: true,
                        onSelect: () => void run(() => api.segments.remove.mutate({ id: row.id }), 'Segment deleted.'),
                      },
                    ],
                  },
                ]
              : []),
          ]}
          trigger={(props) => <IconButton {...props} label={`Actions for ${row.name}`} icon={<MoreVertical className="size-4" />} />}
        />
      ),
    },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHeader
        title="Segments"
        lead={`${rows.length.toLocaleString()} segment${rows.length === 1 ? '' : 's'}`}
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
              <Button
                onClick={() => {
                  setName('')
                  setDescription('')
                  setObject('contact')
                  setCreatingList(true)
                }}
              >
                Create list
              </Button>
              <Button variant="primary" onClick={openNew}>
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

      <div className="flex flex-wrap items-end gap-2">
      <label className="relative w-full min-w-0 sm:w-64">
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

        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-small text-secondary">Type</span>
          <Select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="all">Active and static</option>
            <option value="active">Active</option>
            <option value="static">Static</option>
          </Select>
        </label>

        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-small text-secondary">Records</span>
          <Select
            value={objectFilter}
            onChange={(event) => setObjectFilter(event.target.value as 'all' | ObjectKey)}
          >
            <option value="all">Every object</option>
            {(Object.keys(OBJECT_LABEL) as ObjectKey[]).map((key) => (
              <option key={key} value={key}>
                {OBJECT_LABEL[key]}
              </option>
            ))}
          </Select>
        </label>
      </div>

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
              {...(canWrite ? { action: <Button variant="primary" onClick={openNew}>Create segment</Button> } : {})}
            />
          )}
          </div>
        }
      />

      {pager}

      <div className="-mx-3 flex shrink-0 items-center border-t border-line px-3 pt-2 sm:-mx-6 sm:px-6">
        <span className="inline-flex h-8 items-center rounded-pill bg-canvas px-4 text-small font-semibold">
          {shown.length.toLocaleString()} {shown.length === 1 ? 'segment' : 'segments'}
        </span>
      </div>

      {/* --------------------------------------------------------- editor */}
      <Modal
        open={editing !== null}
        size="lg"
        title={editing === 'new' ? 'Create segment' : `Edit ${editing === null ? '' : editing.name}`}
        onClose={() => setEditing(null)}
      >
        <div className="flex flex-col gap-3">
          <Field id="segment-name" label="Name">
            <TextInput
              id="segment-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Enterprise trials"
              autoFocus
            />
          </Field>

          <Field id="segment-description" label="Description" hint="Optional. Why this list exists.">
            <TextInput
              id="segment-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          <Field id="segment-object" label="Records">
            <Select
              id="segment-object"
              value={object}
              disabled={editing !== 'new'}
              onChange={(event) => {
                setObject(event.target.value as ObjectKey)
                setFilters([{ conjunction: 'and', conditions: [] }])
                setPreview(null)
              }}
            >
              {(Object.keys(OBJECT_LABEL) as ObjectKey[]).map((key) => (
                <option key={key} value={key}>
                  {OBJECT_LABEL[key]}
                </option>
              ))}
            </Select>
          </Field>
          {editing !== 'new' ? (
            <p className="text-small text-secondary">
              The object is fixed after creation: changing it would leave the stored membership
              pointing at records of a different kind.
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">Conditions</span>
              <span className="text-small text-secondary">
                {conditionCount(filters)} set. A segment with none would hold every record, so at
                least one is required.
              </span>
            </p>
            {showBuilder ? (
              <FilterBuilder
                fields={fieldsByObject[object] ?? []}
                value={filters}
                onApply={(next) => {
                  setShowBuilder(false)
                  void runPreview(next)
                }}
                onClose={() => setShowBuilder(false)}
              />
            ) : (
              <div>
                <Button onClick={() => setShowBuilder(true)}>
                  {conditionCount(filters) === 0 ? 'Add conditions' : 'Change conditions'}
                </Button>
              </div>
            )}
          </div>

          {preview ? (
            <div className="rounded-hs border border-line bg-fill px-3 py-2">
              <p className="font-medium">
                {preview.count.toLocaleString()} record{preview.count === 1 ? '' : 's'} match right now
              </p>
              {preview.sample.length > 0 ? (
                <p className="text-small text-secondary">
                  {preview.sample.map((entry) => entry.displayName).join(', ')}
                  {preview.count > preview.sample.length ? ' and more' : ''}
                </p>
              ) : (
                <p className="text-small text-secondary">
                  Nothing matches yet. That is allowed: a segment can be built before the records
                  that belong in it exist.
                </p>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              busy={busy}
              disabled={!name.trim() || conditionCount(filters) === 0}
              onClick={() => void save()}
            >
              Save segment
            </Button>
            <Button variant="tertiary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* ----------------------------------------------------- static list */}
      <Modal open={creatingList} title="Create list" onClose={() => setCreatingList(false)}>
        <div className="flex flex-col gap-3">
          <p className="text-secondary">
            A static list holds whoever you put in it and nothing takes them out again but you.
            Fill it from the bulk bar on any list of records, or from an imported file.
          </p>
          <Field id="list-name" label="Name">
            <TextInput
              id="list-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Autumn webinar invitees"
              autoFocus
            />
          </Field>
          <Field id="list-description" label="Description" hint="Optional. Why this list exists.">
            <TextInput
              id="list-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field id="list-object" label="Records">
            <Select id="list-object" value={object} onChange={(event) => setObject(event.target.value as ObjectKey)}>
              {(Object.keys(OBJECT_LABEL) as ObjectKey[]).map((key) => (
                <option key={key} value={key}>
                  {OBJECT_LABEL[key]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              busy={busy}
              disabled={!name.trim()}
              onClick={() =>
                void run(
                  () =>
                    api.segments.createList.mutate({
                      object,
                      name,
                      description: description || null,
                    }),
                  'List created. Add records to it from the bulk bar.',
                ).then((ok) => {
                  if (ok) setCreatingList(false)
                })
              }
            >
              Create list
            </Button>
            <Button variant="tertiary" onClick={() => setCreatingList(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* -------------------------------------------------------- members */}
      <Modal
        open={viewing !== null}
        size="lg" title={`Who is in ${viewing?.name ?? ''}`}
        onClose={() => setViewing(null)}
      >
        {members === null ? (
          <p className="text-secondary">Reading the membership…</p>
        ) : members.length === 0 ? (
          <p className="text-secondary">
            Nobody is in it right now. If it has never been recomputed, that is why: the query has
            not been run against the records yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {members.map((member) => (
              <li key={member.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={recordPath(account, viewing?.objectKey ?? 'contact', member.id)}
                  title={member.displayName}
                  className="min-w-0 truncate"
                >
                  {member.displayName}
                </Link>
                <span className="text-small text-secondary">
                  joined {formatDateTime(member.enteredAt.toISOString(), zone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  )
}
