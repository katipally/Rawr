'use client'

import { useQueryClient } from '@tanstack/react-query'
import { Button, Combobox, DropdownMenu, IconButton, Modal, Select, TextInput, useToast } from '@rawr/ui'
import { ChevronDown, Link2, Pencil, Send, Trash2, UserRound, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { api, errorMessage, trpc } from '~/lib/rpc.ts'
import { EnrollDialog } from './enroll-dialog.tsx'
import { FieldInput, type EditableField } from './field-input.tsx'
import { RecordPicker, type PickedRecord } from './record-picker.tsx'
import { useFormat } from '~/components/zone.tsx'

export type BulkBarProps = {
  object: string
  objectLabel: string
  objectPlural: string
  /** Ids ticked in the table. The bar only exists while this is non-empty. */
  ids: string[]
  /** The version of each selected row as the table read it. */
  versions: Record<string, string>
  fields: EditableField[]
  onDone: () => void
  onClear: () => void
}

/** Which dialog is open. Each action asks for exactly the one thing it needs and
 *  nothing else, so none of them is a form. */
type Pending = 'delete' | 'assign' | 'associate' | 'merge' | 'list' | 'edit' | null

type Progress = { id: string; processed: number; total: number }

const POLL_MS = 2000

/** HubSpot's selection actions: ghost, 14/600, a pixel inside the 40px row. The
 *  label folds away on a narrow table and stays the button's name. */
const action =
  'inline-flex h-[calc(var(--spacing-row)-2px)] shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-body font-semibold transition-all duration-150 ease-out hover:bg-fill disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent'
const label = 'sr-only @3xl:not-sr-only'

/** One field, one value, applied to everything ticked. A5.
 *
 *  Deliberately one field at a time. A multi-field bulk editor reads as a record
 *  form and invites somebody to blank three properties across two hundred records
 *  by accident; one field with the count in the button says exactly what is about
 *  to happen. Rows that refuse the change come back named, because "12 of 50
 *  failed" is not something anybody can act on.
 *
 *  The named actions beside it are the ones HubSpot puts on a selection: delete,
 *  assign an owner, associate with a record, merge two, add to a list. A large
 *  selection becomes a job rather than a request, and the toolbar shows how far
 *  it has got, because closing the tab must not stop it. */
export const BulkBar = ({ object, objectLabel, objectPlural, ids, versions, fields, onDone, onClear }: BulkBarProps) => {
  const fmt = useFormat()
  const router = useRouter()
  const queryClient = useQueryClient()
  const toast = useToast()
  // What is missing from the records changed, so the tiles above the list are asked again.
  const refresh = () => {
    void queryClient.invalidateQueries(trpc.crm.kpis.queryFilter())
    router.refresh()
  }
  const [fieldKey, setFieldKey] = useState('')
  const [value, setValue] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<{ id: string; displayName: string; reason: string }[]>([])
  const [showEnroll, setShowEnroll] = useState(false)

  const [pending, setPending] = useState<Pending>(null)
  const [typedCount, setTypedCount] = useState('')
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [owners, setOwners] = useState<{ id: string; name: string }[]>([])
  const [target, setTarget] = useState<PickedRecord | null>(null)
  const [targetObject, setTargetObject] = useState('company')
  const [linkLabel, setLinkLabel] = useState('')
  const [lists, setLists] = useState<{ id: string; name: string }[]>([])
  const [listId, setListId] = useState<string | null>(null)
  const [survivorId, setSurvivorId] = useState<string | null>(null)
  const [pair, setPair] = useState<{ id: string; name: string }[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)

  const field = fields.find((candidate) => candidate.key === fieldKey)
  /** The registry's own plural. Appending an "s" turns Company into "companys". */
  const nounFor = (count: number): string =>
    (count === 1 ? objectLabel : objectPlural).toLowerCase()
  const noun = nounFor(ids.length)

  /** A queued action reports itself. Polled rather than pushed for the same
   *  reason the import wizard is: one screen watching one row does not earn a
   *  socket, and the answer is a single indexed read. */
  useEffect(() => {
    if (!progress) return
    let live = true
    const timer = setInterval(() => {
      api.crm.bulk.progress
        .query({ id: progress.id })
        .then((row) => {
          if (!live || !row) return
          setProgress({ id: row.id, processed: row.processed, total: row.total })
          if (row.state === 'running') return
          clearInterval(timer)
          setProgress(null)
          if (row.state === 'failed') toast('error', row.lastError ?? 'The action stopped part way.')
          else {
            toast(
              'success',
              row.failedCount > 0
                ? `${row.processed} of ${row.total} done, ${row.failedCount} refused.`
                : `All ${row.total} done.`,
            )
          }
          onDone()
          void queryClient.invalidateQueries(trpc.crm.kpis.queryFilter())
          router.refresh()
        })
        .catch(() => {})
    }, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [progress, onDone, router, queryClient, toast])

  /** Puts a bulk edit back. Not a transaction and not pretending to be one: a
   *  record somebody else changed in between is reported by name rather than
   *  quietly overwritten, which is the same promise the edit itself makes. */
  const undo = async (key: string, previous: { id: string; values: Record<string, unknown>; version: Date }[]) => {
    const byValue = new Map<string, { value: unknown; rows: { id: string; version: Date }[] }>()
    for (const row of previous) {
      const value = row.values[key] ?? null
      const bucket = JSON.stringify(value)
      const found = byValue.get(bucket)
      if (found) found.rows.push({ id: row.id, version: row.version })
      else byValue.set(bucket, { value, rows: [{ id: row.id, version: row.version }] })
    }
    try {
      let restored = 0
      for (const { value, rows } of byValue.values()) {
        const result = await api.crm.records.bulkUpdate.mutate({
          object,
          rows,
          values: { [key]: value },
        })
        restored += result.updated
      }
      toast('success', `Put back on ${restored} ${nounFor(restored)}.`)
      refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  /** The inverse of the delete that just ran: the Restore records page does the
   *  same for a delete nobody undid in time. */
  const bringBack = async (restoring: string[]) => {
    try {
      const result = await api.crm.records.restore.mutate({ object, ids: restoring })
      toast('success', `Put back ${result.restored} ${nounFor(result.restored)}.`)
      refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const apply = async () => {
    if (!field) return
    setBusy(true)
    setFailed([])
    try {
      const result = await api.crm.records.bulkUpdate.mutate({
        object,
        rows: ids.map((id) => ({ id, version: versions[id]! })),
        values: { [field.key]: value === '' ? null : value },
      })
      setFailed(result.failed)
      if (result.updated > 0) {
        toast('success', `${field.label} changed on ${result.updated} ${nounFor(result.updated)}.`, {
          label: 'Undo',
          // Grouped by the value each record held, so putting two hundred records
          // back costs one call per distinct old value rather than two hundred.
          // The toast stays until it is used or dismissed, because five seconds is
          // not long enough to notice what you just did to two hundred records.
          run: () => undo(field.key, result.previous),
        })
      }
      if (result.failed.length === 0) {
        setFieldKey('')
        setValue(null)
        setPending(null)
        onDone()
      }
      refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  /** Every named action goes the same way: start it, and either it is finished
   *  when the call answers or it hands back something to watch. */
  const start = async (
    action: Parameters<typeof api.crm.bulk.start.mutate>[0]['action'],
    done: (processed: number) => string,
  ) => {
    setBusy(true)
    try {
      const result = await api.crm.bulk.start.mutate({ object, ids, action })
      setPending(null)
      if (result.mode === 'queued') {
        setProgress({ id: result.operationId, processed: 0, total: result.total })
        toast('info', `${fmt.number(result.total)} ${noun} queued. You can close this page.`)
        return
      }
      if (result.failed.length > 0) {
        setFailed(result.failed)
      }
      const refused = new Set(result.failed.map((row) => row.id))
      toast(
        'success',
        done(result.processed),
        // Only an inline run is small enough for one restore call; a queued one is
        // put back from the Restore records page.
        action.type === 'delete'
          ? { label: 'Undo', run: () => bringBack(ids.filter((id) => !refused.has(id))) }
          : undefined,
      )
      onDone()
      void queryClient.invalidateQueries(trpc.crm.pathFilter())
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const openAssign = async () => {
    setPending('assign')
    setOwnerId(null)
    try {
      const lookups = await queryClient.fetchQuery(trpc.crm.lookups.queryOptions())
      setOwners(lookups.users.filter((user) => user.state !== 'deactivated').map((user) => ({ id: user.id, name: user.name })))
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const openList = async () => {
    setPending('list')
    setListId(null)
    try {
      // Safe because the button that opens this only exists for the three.
      const rows = await queryClient.fetchQuery(trpc.segments.list.queryOptions({ object: object as 'contact' | 'company' | 'deal' }))
      setLists(rows.filter((row) => row.isStatic).map((row) => ({ id: row.id, name: row.name })))
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const openMerge = async () => {
    setPending('merge')
    setSurvivorId(ids[0] ?? null)
    setPair([])
    try {
      const names = await Promise.all(
        ids.map(async (id) => ({ id, name: (await queryClient.fetchQuery(trpc.crm.nameOf.queryOptions({ object, id }))) ?? id })),
      )
      setPair(names)
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  /** A segment is saved against one of the three built-in objects, so a list is
   *  only somewhere a record of one of them can go. */
  const isBuiltIn = object === 'contact' || object === 'company' || object === 'deal'
  const canMerge = ids.length === 2 && isBuiltIn

  return (
    // The table lays this over its header row, so it is exactly that row's
    // height and the rows under it never move.
    <div
      role="toolbar"
      aria-label={`Actions for ${ids.length} selected ${noun}`}
      className="@container relative flex h-full min-w-0 animate-drop-in items-center gap-0.5 rounded-hs border border-line bg-surface pl-4 motion-reduce:animate-none"
    >
      <span className="mr-3 min-w-0 shrink truncate font-semibold">
        {fmt.number(ids.length)} {noun} selected
      </span>

      <button type="button" className={action} aria-label="Assign owner" onClick={() => void openAssign()}>
        <UserRound aria-hidden="true" className="size-4" />
        <span className={label}>Assign</span>
      </button>
      <button
        type="button"
        className={action}
        aria-label="Edit a property"
        onClick={() => {
          setFieldKey('')
          setValue(null)
          setFailed([])
          setPending('edit')
        }}
      >
        <Pencil aria-hidden="true" className="size-4" />
        <span className={label}>Edit</span>
      </button>
      <button
        type="button"
        className={action}
        aria-label="Delete"
        onClick={() => {
          setTypedCount('')
          setPending('delete')
        }}
      >
        <Trash2 aria-hidden="true" className="size-4" />
        <span className={label}>Delete</span>
      </button>
      <button
        type="button"
        className={action}
        aria-label="Associate with"
        onClick={() => {
          setPending('associate')
          setTarget(null)
          setLinkLabel('')
        }}
      >
        <Link2 aria-hidden="true" className="size-4" />
        <span className={label}>Associate</span>
      </button>
      {/* A sequence sends to a person, so this is a contact-only action. */}
      {object === 'contact' ? (
        <button type="button" className={action} aria-label="Enroll in sequence" onClick={() => setShowEnroll(true)}>
          <Send aria-hidden="true" className="size-4" />
          <span className={label}>Enroll in sequence</span>
        </button>
      ) : null}
      <DropdownMenu
        label="More bulk actions"
        align="start"
        groups={[
          {
            key: 'more',
            items: [
              ...(isBuiltIn ? [{ key: 'list', label: 'Add to list', onSelect: () => void openList() }] : []),
              {
                key: 'merge',
                label: 'Merge',
                hint: canMerge ? undefined : 'Exactly two',
                disabled: !canMerge,
                onSelect: () => void openMerge(),
              },
            ],
          },
        ]}
        trigger={(props) => (
          <button {...props} type="button" className={action}>
            More
            <ChevronDown aria-hidden="true" className="size-4" />
          </button>
        )}
      />

      {progress ? (
        <p role="status" className="ml-2 min-w-0 truncate text-small text-secondary" title="This keeps running if you leave the page.">
          {fmt.number(progress.processed)} of {fmt.number(progress.total)} done. This
          keeps running if you leave the page.
        </p>
      ) : null}

      <IconButton
        label="Clear selection"
        icon={<X aria-hidden="true" className="size-4" />}
        onClick={onClear}
        className="mr-1 ml-auto shrink-0 text-body"
      />

      {/* Refusals outlive the dialog that caused them, so they hang under the
          bar until read rather than vanishing with it. */}
      {failed.length > 0 && pending === null ? (
        <div
          role="alert"
          className="absolute top-full left-0 z-20 mt-1 flex max-h-64 w-[min(32rem,100%)] flex-col gap-1 overflow-y-auto rounded-panel border border-line bg-surface p-3 shadow-overlay"
        >
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-error">
              {failed.length} of {ids.length} could not be changed. Everything else was saved.
            </p>
            <IconButton label="Dismiss" icon={<X aria-hidden="true" className="size-4" />} onClick={() => setFailed([])} className="size-6 shrink-0" />
          </div>
          <FailedList failed={failed} />
        </div>
      ) : null}

      <Modal
        open={pending === 'edit'}
        title={`Edit ${ids.length} ${noun}`}
        onClose={() => setPending(null)}
        onSubmit={() => void apply()}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!field}>
              Apply to {ids.length}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-small text-secondary">Property to change</span>
            <Select
              value={fieldKey}
              onChange={(event) => {
                setFieldKey(event.target.value)
                setValue(null)
                setFailed([])
              }}
            >
              <option value="">Pick a field</option>
              {fields.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {candidate.label}
                </option>
              ))}
            </Select>
          </label>

          {field ? (
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-small text-secondary">New value</span>
              <FieldInput id="bulk-value" field={field} value={value} onChange={setValue} />
            </label>
          ) : null}

          {failed.length > 0 ? (
            <div role="alert" className="flex flex-col gap-1">
              <p className="text-error">
                {failed.length} of {ids.length} could not be changed. Everything else was saved.
              </p>
              <FailedList failed={failed} />
            </div>
          ) : null}
        </div>
      </Modal>

      {showEnroll ? (
        <EnrollDialog
          contactIds={ids}
          contactLabel={`${ids.length} ${noun}`}
          onClose={() => setShowEnroll(false)}
          onEnrolled={() => {
            onDone()
            router.refresh()
          }}
        />
      ) : null}

      <Modal
        open={pending === 'delete'}
        title={`Delete ${ids.length} ${noun}?`}
        onClose={() => setPending(null)}
        onSubmit={() => void start({ type: 'delete' }, (n) => `${n} ${nounFor(n)} deleted.`)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              busy={busy}
              disabled={ids.length > 1 && typedCount.trim() !== String(ids.length)}
            >
              Delete {ids.length}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>
            They stop appearing in lists, reports and pickers. Their timelines are kept, so what
            already happened is still on record; nothing here erases {ids.length === 1 ? 'a record' : 'records'}.
            Restore records, under Data Management, puts them back.
          </p>
          {ids.length > 1 ? (
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-small text-secondary">Type {ids.length} to confirm</span>
              <TextInput
                inputMode="numeric"
                autoComplete="off"
                value={typedCount}
                onChange={(event) => setTypedCount(event.target.value)}
              />
            </label>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={pending === 'assign'}
        title={`Assign ${ids.length} ${noun}`}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={() => void start({ type: 'assign', ownerId }, (n) => `Owner set on ${n} ${noun}.`)}
            >
              Assign {ids.length}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Combobox
            label="Owner"
            value={ownerId}
            onChange={setOwnerId}
            options={owners.map((person) => ({ value: person.id, label: person.name }))}
          />
          <p className="text-small text-secondary">
            Leaving it empty takes the owner off, which is what unassigning is.
          </p>
        </div>
      </Modal>

      <Modal
        open={pending === 'associate'}
        title={`Associate ${ids.length} ${noun} with`}
        onClose={() => setPending(null)}
        onSubmit={() => {
          if (!target || busy) return
          void start(
            {
              type: 'associate',
              target: { entityType: targetObject, entityId: target.id },
              label: linkLabel.trim() || null,
            },
            (n) => `${n} ${noun} linked to ${target.label}.`,
          )
        }}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!target}>
              Associate {ids.length}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-small text-secondary">Kind of record</span>
            <Select
              value={targetObject}
              onChange={(event) => {
                setTargetObject(event.target.value)
                setTarget(null)
              }}
            >
              <option value="company">Company</option>
              <option value="contact">Contact</option>
              <option value="deal">Deal</option>
            </Select>
          </label>
          <RecordPicker object={targetObject} value={target} onChange={setTarget} label="Record" />
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-small text-secondary">Label, optional</span>
            <TextInput
              value={linkLabel}
              onChange={(event) => setLinkLabel(event.target.value)}
              placeholder="Decision maker"
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={pending === 'list'}
        title={`Add ${ids.length} ${noun} to a list`}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!listId}
              onClick={() =>
                void start({ type: 'add_to_list', listId: listId! }, (n) => `${n} ${noun} added.`)
              }
            >
              Add {ids.length}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {lists.length === 0 ? (
            <p className="text-secondary">
              There is no static list for {objectPlural.toLowerCase()} yet. Create one on the
              Segments page; an active list decides its own membership from its conditions.
            </p>
          ) : (
            <Combobox
              label="List"
              value={listId}
              onChange={setListId}
              options={lists.map((row) => ({ value: row.id, label: row.name }))}
            />
          )}
        </div>
      </Modal>

      <Modal
        open={pending === 'merge'}
        title="Merge two records"
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!survivorId || pair.length < 2}
              onClick={() =>
                void start({ type: 'merge', survivorId: survivorId! }, () => 'Merged.')
              }
            >
              Merge
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>
            Not reversible. Everything the absorbed record carries moves across: its timeline, its
            associations, its subscriptions, its list memberships and its tasks.
          </p>
          {pair.length < 2 ? (
            <p className="text-secondary">Reading the two records…</p>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-small text-secondary">Which one to keep</legend>
              {pair.map((row) => (
                <label key={row.id} className="flex min-w-0 items-center gap-2">
                  <input
                    type="radio"
                    name="bulk-survivor"
                    checked={survivorId === row.id}
                    onChange={() => setSurvivorId(row.id)}
                  />
                  <span className="min-w-0 truncate">{row.name}</span>
                </label>
              ))}
            </fieldset>
          )}
        </div>
      </Modal>
    </div>
  )
}

const FailedList = ({ failed }: { failed: { id: string; displayName: string; reason: string }[] }) => (
  <ul className="flex flex-col gap-0.5">
    {failed.map((row) => (
      <li key={row.id} className="text-small text-secondary">
        <span className="font-medium">{row.displayName}</span> {row.reason}
      </li>
    ))}
  </ul>
)
