'use client'

import { Button, Field, Modal, Select, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useFormat } from '~/components/zone.tsx'
import { StageTable, type StageDraft } from '../stage-table.tsx'

type Stage = { id: string; name: string; usedBy: number }

/** The lifecycle list: ordered, named, and deleting one entry means deciding where
 *  its records go. HubSpot's stage table, the same as a pipeline's without the
 *  probability. */
export const StageList = ({ rows, canWrite }: { rows: Stage[]; canWrite: boolean }) => {
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<Stage | null>(null)
  const [destination, setDestination] = useState('')

  const routes = api.admin.lifecycle

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

  /** New stages first so the order can name them, renames next, the order once
   *  at the end: one request per changed stage. */
  const save = (draft: StageDraft<object>[]) =>
    run(async () => {
      const ids: string[] = []
      for (const row of draft) {
        const name = row.name.trim()
        if (!row.id) {
          ids.push((await routes.create.mutate({ name })).id)
          continue
        }
        ids.push(row.id)
        if (rows.find((stage) => stage.id === row.id)?.name !== name) await routes.rename.mutate({ id: row.id, name })
      }
      if (ids.length !== rows.length || ids.some((id, index) => id !== rows[index]?.id)) {
        await routes.reorder.mutate({ orderedIds: ids })
      }
    }, 'Lifecycle stages saved.')

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!canWrite ? <p className="text-secondary">You need account access to change this.</p> : null}
      <p>Track contacts and companies as they move through your marketing and sales processes. Drag a stage by its grip to reorder it.</p>
      <section className="min-w-0 rounded-panel border border-line px-4 py-4 sm:px-5">
        <StageTable<object>
          key={JSON.stringify(rows)}
          caption="Lifecycle stages"
          stages={rows}
          blank={{}}
          columns={[]}
          usedHeader="Used in"
          canWrite={canWrite}
          busy={busy}
          onSave={(draft) => save(draft)}
          onDelete={(stage) => {
            setRemoving(stage)
            setDestination('')
          }}
        />
      </section>

      <Modal
        open={removing !== null}
        size="sm"
        title={`Delete ${removing?.name ?? ''}`}
        onClose={() => setRemoving(null)}
        footer={
          removing ? (
            <>
              <Button variant="tertiary" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
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
            </>
          ) : null
        }
      >
        {removing ? (
          <div className="flex flex-col gap-3">
            {removing.usedBy === 0 ? (
              <p>Nothing is set to this, so nothing has to move.</p>
            ) : (
              <>
                <p>
                  {fmt.number(removing.usedBy)} record{removing.usedBy === 1 ? '' : 's'} are set
                  to this. Leaving them pointing at nothing would read as "never had one", which is
                  a different thing, so pick where they go.
                </p>
                <Field id="stage-destination" label="Move them to">
                  <Select
                    id="stage-destination"
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
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
