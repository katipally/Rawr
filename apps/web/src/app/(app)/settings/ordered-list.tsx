'use client'

import { Button, Field, Modal, RenamePrompt, Select, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

export type OrderedRow = { id: string; name: string; detail: string; usedBy: number }

export type OrderedListProps = {
  rows: OrderedRow[]
  canWrite: boolean
  role: string
  noun: string
  /** Which router this list edits. Only lifecycle uses it today; naming it keeps
   *  the component honest rather than pretending to be generic. */
  namespace: 'lifecycle'
}

/** An ordered, named list where deleting one entry means deciding where its records
 *  go. The same shape as a pipeline stage, without the probability. */
export const OrderedList = ({ rows, canWrite, role, noun, namespace }: OrderedListProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState('')
  const [removing, setRemoving] = useState<OrderedRow | null>(null)
  const [renaming, setRenaming] = useState<OrderedRow | null>(null)
  const [destination, setDestination] = useState('')

  const routes = api.admin[namespace]

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

  const move = (index: number, by: number) => {
    const next = [...rows]
    const target = index + by
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    if (moved) next.splice(target, 0, moved)
    void run(() => routes.reorder.mutate({ orderedIds: next.map((row) => row.id) }), 'Order saved.')
  }

  if (!canWrite) {
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          Your role ({role}) can read this and cannot change it.
        </p>
        <ol className="flex flex-col rounded-panel border border-line bg-surface">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-baseline gap-x-3 border-b border-divider px-3 py-2 last:border-0"
            >
              <span className="font-medium">{row.name}</span>
              <span className="text-small text-secondary">{row.detail}</span>
            </li>
          ))}
        </ol>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run(() => routes.create.mutate({ name: adding }), `${noun} added.`).then(
            (ok) => ok && setAdding(''),
          )
        }}
      >
        <Field id="ordered-new" label={`New ${noun}`}>
          <TextInput id="ordered-new" value={adding} onChange={(event) => setAdding(event.target.value)} />
        </Field>
        <Button variant="primary" busy={busy} disabled={!adding.trim()}>
          Add
        </Button>
      </form>

      <ol className="flex flex-col rounded-panel border border-line bg-surface">
        {rows.length === 0 ? (
          <li className="px-3 py-3 text-secondary">Nothing here yet.</li>
        ) : (
          rows.map((row, index) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-divider px-3 py-2 last:border-0"
            >
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
                <span className="text-small text-secondary tabular-nums">{index + 1}</span>
                <span className="font-medium">{row.name}</span>
                <span className="text-small text-secondary">{row.detail}</span>
              </span>
              <span className="flex shrink-0 flex-wrap gap-2">
                <Button variant="tertiary" busy={busy} disabled={index === 0} onClick={() => move(index, -1)}>
                  Up
                </Button>
                <Button
                  variant="tertiary"
                  busy={busy}
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Down
                </Button>
                <Button
                  variant="tertiary"
                  busy={busy}
                  onClick={() => setRenaming(row)}
                >
                  Rename
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setRemoving(row)
                    setDestination('')
                  }}
                >
                  Delete
                </Button>
              </span>
            </li>
          ))
        )}
      </ol>

      <RenamePrompt
        value={renaming?.name ?? null}
        title={`Rename ${renaming?.name ?? ''}`}
        label={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} name`}
        busy={busy}
        onCancel={() => setRenaming(null)}
        onRename={(name) => {
          if (!renaming) return
          void run(() => routes.rename.mutate({ id: renaming.id, name }), 'Renamed.').then(
            (ok) => ok && setRenaming(null),
          )
        }}
      />

      <Modal open={removing !== null} title={`Delete ${removing?.name ?? ''}`} onClose={() => setRemoving(null)}>
        {removing ? (
          <div className="flex flex-col gap-3">
            {removing.usedBy === 0 ? (
              <p>Nothing is set to this, so nothing has to move.</p>
            ) : (
              <>
                <p>
                  {removing.usedBy.toLocaleString()} record{removing.usedBy === 1 ? '' : 's'} are set
                  to this. Leaving them pointing at nothing would read as "never had one", which is
                  a different thing, so pick where they go.
                </p>
                <Field id="ordered-destination" label="Move them to">
                  <Select
                    id="ordered-destination"
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                  >
                    <option value="">Pick one</option>
                    {rows
                      .filter((row) => row.id !== removing.id)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                busy={busy}
                disabled={removing.usedBy > 0 && destination === ''}
                onClick={() =>
                  void run(
                    () => routes.remove.mutate({ id: removing.id, destinationId: destination || null }),
                    'Deleted.',
                  ).then((ok) => ok && setRemoving(null))
                }
              >
                Delete
              </Button>
              <Button variant="tertiary" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
