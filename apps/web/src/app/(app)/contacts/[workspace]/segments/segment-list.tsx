'use client'

import { Button, EmptyState, Field, Modal, Select, TextInput, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { FilterBuilder, type FilterField, type Group } from '~/components/crm/filter-builder.tsx'
import { objectView, recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'

export type SegmentRow = {
  id: string
  name: string
  objectKey: ObjectKey
  description: string | null
  filters: Group[]
  memberCount: number
  lastEvaluatedAt: string | null
}

export type SegmentListProps = {
  workspace: string
  rows: SegmentRow[]
  fieldsByObject: Record<string, FilterField[]>
  canWrite: boolean
  role: string
}

const OBJECT_LABEL: Record<ObjectKey, string> = {
  contact: 'Contacts',
  company: 'Companies',
  deal: 'Deals',
}

export const SegmentList = ({ workspace, rows, fieldsByObject, canWrite, role }: SegmentListProps) => {
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

  return (
    <div className="flex flex-col gap-4">
      {/* Two separate questions. Whether the toolbar is worth drawing depends on
          there being something to recompute; whether the read-only notice belongs
          depends only on the role. Asking them as one told an admin looking at an
          empty page that they could not change segments, directly above a button
          that creates one. */}
      {canWrite ? (
        rows.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={openNew}>
              Create segment
            </Button>
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
          </div>
        ) : null
      ) : (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          Your role ({role}) can read segments and cannot change them. Marketing and admins own
          who is in a list.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No segments yet"
          description="A saved query that remembers who is in it."
          action={canWrite ? <Button variant="primary" onClick={openNew}>Create segment</Button> : undefined}
        />
      ) : (
        <ul className="flex flex-col rounded-panel border border-line bg-surface">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-divider px-3 py-2 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{row.name}</span>
                  <span className="text-small text-secondary">{OBJECT_LABEL[row.objectKey]}</span>
                  <span className="text-small text-secondary">
                    {conditionCount(row.filters)} condition{conditionCount(row.filters) === 1 ? '' : 's'}
                  </span>
                </p>
                {row.description ? <p className="text-small text-secondary">{row.description}</p> : null}
                <p className="text-small text-secondary tabular-nums">
                  {row.lastEvaluatedAt === null
                    ? 'Never recomputed, so the member count is unknown rather than zero.'
                    : `${row.memberCount.toLocaleString()} member${row.memberCount === 1 ? '' : 's'} · last recomputed ${formatDateTime(row.lastEvaluatedAt)}`}
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap gap-2">
                <Button variant="tertiary" onClick={() => void openMembers(row)}>
                  Members
                </Button>
                <Link
                  href={objectView(workspace, row.objectKey, 'all', 'list', {
                    filters: JSON.stringify(row.filters),
                  })}
                  className="self-center text-small"
                >
                  Open as a list
                </Link>
                {canWrite ? (
                  <>
                    <Button
                      variant="tertiary"
                      busy={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await api.segments.evaluate.mutate({ id: row.id })
                          toast(
                            'info',
                            `${result.members} members: ${result.entered} joined, ${result.exited} left.`,
                          )
                        }, 'Recomputed.')
                      }
                    >
                      Recompute
                    </Button>
                    <Button variant="tertiary" onClick={() => openEdit(row)}>
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      busy={busy}
                      onClick={() =>
                        void run(() => api.segments.remove.mutate({ id: row.id }), 'Segment deleted.')
                      }
                    >
                      Delete
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* --------------------------------------------------------- editor */}
      <Modal
        open={editing !== null}
        size="lg"
        title={editing === 'new' ? 'New segment' : `Edit ${editing === null ? '' : editing.name}`}
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
                <Link href={recordPath(workspace, viewing?.objectKey ?? 'contact', member.id)}>
                  {member.displayName}
                </Link>
                <span className="text-small text-secondary">
                  joined {formatDateTime(member.enteredAt.toISOString())}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  )
}
