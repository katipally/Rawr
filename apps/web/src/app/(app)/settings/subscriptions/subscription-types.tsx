'use client'

import { Button, Field, Modal, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { SubscriptionTypeRow } from '@rawr/db'
import { api, errorMessage } from '~/lib/rpc.ts'

export type SubscriptionTypesProps = {
  rows: SubscriptionTypeRow[]
  canWrite: boolean
  role: string
}

export const SubscriptionTypes = ({ rows, canWrite, role }: SubscriptionTypesProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isInternal, setIsInternal] = useState(false)
  const [removing, setRemoving] = useState<SubscriptionTypeRow | null>(null)

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

  return (
    <div className="flex flex-col gap-4">
      {canWrite ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void run(
              () => api.admin.subscriptionTypes.create.mutate({ name, description: description || null, isInternal }),
              'Subscription type created.',
            ).then((ok) => {
              if (ok) {
                setName('')
                setDescription('')
                setIsInternal(false)
              }
            })
          }}
        >
          <Field id="sub-name" label="Name">
            <TextInput
              id="sub-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Product newsletter"
            />
          </Field>
          <Field id="sub-description" label="Description" hint="Shown to staff, not to the contact.">
            <TextInput
              id="sub-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 pb-1.5">
            <input type="checkbox" checked={isInternal} onChange={(event) => setIsInternal(event.target.checked)} />
            <span>
              Internal
              <span className="block text-small text-secondary">Never offered on a public form.</span>
            </span>
          </label>
          <Button variant="primary" busy={busy} disabled={!name.trim()}>
            Create
          </Button>
        </form>
      ) : (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          Your role ({role}) can read this and cannot change it. Marketing and admins manage
          subscription types.
        </p>
      )}

      <ul className="flex flex-col rounded-panel border border-line bg-surface">
        {rows.length === 0 ? (
          <li className="px-3 py-3 text-secondary">
            No subscription types yet. Without one there is nothing for a contact to opt out of,
            and a form's consent checkbox has nothing to record against.
          </li>
        ) : (
          rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-divider px-3 py-2 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{row.name}</span>
                  {row.isInternal ? (
                    <span className="rounded-hs bg-fill px-1.5 py-0.5 text-small text-secondary">Internal</span>
                  ) : null}
                </p>
                {row.description ? <p className="text-small text-secondary">{row.description}</p> : null}
                <p className="text-small text-secondary tabular-nums">
                  {row.subscribed.toLocaleString()} subscribed · {row.unsubscribed.toLocaleString()} opted out ·
                  everybody else has not specified
                </p>
              </div>
              {canWrite ? (
                <span className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    variant="tertiary"
                    busy={busy}
                    onClick={() => {
                      const next = window.prompt('Rename this subscription type to', row.name)
                      if (next && next !== row.name) {
                        void run(
                          () => api.admin.subscriptionTypes.update.mutate({ id: row.id, name: next }),
                          'Renamed.',
                        )
                      }
                    }}
                  >
                    Rename
                  </Button>
                  <Button variant="destructive" onClick={() => setRemoving(row)}>
                    Delete
                  </Button>
                </span>
              ) : null}
            </li>
          ))
        )}
      </ul>

      <Modal open={removing !== null} title={`Delete ${removing?.name ?? ''}`} onClose={() => setRemoving(null)}>
        {removing ? (
          <div className="flex flex-col gap-3">
            {removing.unsubscribed > 0 ? (
              <p className="rounded-hs border border-error bg-error-subtle px-3 py-2 text-error">
                {removing.unsubscribed.toLocaleString()} people have opted out of this. Deleting it
                discards every one of those opt-outs, and nothing anywhere else remembers them.
              </p>
            ) : (
              <p>Nobody has opted out of this, so no consent is discarded.</p>
            )}
            <p className="text-secondary">
              {removing.subscribed.toLocaleString()} explicit opt-ins go too.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                busy={busy}
                onClick={() =>
                  void run(
                    () =>
                      api.admin.subscriptionTypes.remove.mutate({
                        id: removing.id,
                        confirmUnsubscribes: removing.unsubscribed,
                      }),
                    'Subscription type deleted.',
                  ).then((ok) => ok && setRemoving(null))
                }
              >
                Delete permanently
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
