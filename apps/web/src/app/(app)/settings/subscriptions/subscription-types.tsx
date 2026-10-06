'use client'

import { Alert, Button, DataTable, DropdownMenu, EmptyState, Field, Modal, RenamePrompt, TextInput, useToast, type Column } from '@rawr/ui'
import { ChevronDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { SubscriptionTypeRow } from '@rawr/db'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { RowActions, StatusDot, rowPill } from '~/components/row-actions.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useFormat } from '~/components/zone.tsx'

export type SubscriptionTypesProps = {
  rows: SubscriptionTypeRow[]
  canWrite: boolean
  hub: string
}

export const SubscriptionTypes = ({ rows, canWrite, hub }: SubscriptionTypesProps) => {
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isInternal, setIsInternal] = useState(false)
  const [doubleOptIn, setDoubleOptIn] = useState(false)
  const [removing, setRemoving] = useState<SubscriptionTypeRow | null>(null)
  const [renaming, setRenaming] = useState<SubscriptionTypeRow | null>(null)
  const [creating, setCreating] = useState(false)

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

  const toggleConfirm = (row: SubscriptionTypeRow) =>
    void run(
      () => api.admin.subscriptionTypes.update.mutate({ id: row.id, doubleOptIn: !row.doubleOptIn }),
      row.doubleOptIn ? 'A tick on a form now subscribes straight away.' : 'Opt-ins on this type now have to be confirmed.',
    )

  const columns: Column<SubscriptionTypeRow>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 320,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-1 flex-col">
            <span title={row.name} className="truncate font-semibold">{row.name}</span>
            {row.isInternal ? <span className="truncate text-small font-light text-secondary">Internal, never offered on a public form</span> : null}
          </span>
          {canWrite ? (
            <RowActions>
              <DropdownMenu
                label={`Actions for ${row.name}`}
                align="start"
                trigger={(props) => (
                  <button {...props} type="button" className={rowPill}>
                    Actions
                    <ChevronDown aria-hidden="true" className="size-3" />
                  </button>
                )}
                groups={[
                  {
                    key: 'type',
                    items: [
                      { key: 'rename', label: 'Rename', disabled: busy, onSelect: () => setRenaming(row) },
                      { key: 'confirm', label: row.doubleOptIn ? 'Turn off confirmed opt-in' : 'Turn on confirmed opt-in', disabled: busy, onSelect: () => toggleConfirm(row) },
                    ],
                  },
                  { key: 'danger', items: [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => setRemoving(row) }] },
                ]}
              />
            </RowActions>
          ) : null}
        </span>
      ),
    },
    { key: 'description', header: 'Description', width: 360, render: (row) => <span title={row.description ?? undefined} className="block truncate font-light">{row.description || EMPTY_VALUE}</span> },
    {
      key: 'subscribed',
      header: 'Subscribed',
      width: 140,
      align: 'right',
      render: (row) => (
        <span title={row.awaitingConfirmation > 0 ? `${fmt.number(row.awaitingConfirmation)} waiting to confirm` : undefined} className="font-light tabular-nums">
          {fmt.number(row.subscribed)}
        </span>
      ),
    },
    { key: 'unsubscribed', header: 'Opted out', width: 140, align: 'right', render: (row) => <span className="font-light tabular-nums">{fmt.number(row.unsubscribed)}</span> },
    { key: 'confirm', header: 'Confirmed opt-in', width: 160, render: (row) => <StatusDot tone={row.doubleOptIn ? 'live' : 'off'}>{row.doubleOptIn ? 'On' : 'Off'}</StatusDot> },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0">
          What somebody can opt in or out of. Everybody not subscribed or opted out has not specified.
        </p>
        {canWrite ? (
          <Button onClick={() => setCreating(true)}>Create subscription type</Button>
        ) : (
          <p className="text-secondary">You need {hub} access to change this. Marketing and admins manage subscription types.</p>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No subscription types yet"
          description="Without one there is nothing for a contact to opt out of, and a form's consent checkbox has nothing to record against."
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Subscription types" storageKey="settings.subscription-types" />
      )}

      <Modal
        open={creating}
        title="Create subscription type"
        onClose={() => setCreating(false)}
        dirty={name !== '' || description !== ''}
        onSubmit={() =>
          void run(
            () =>
              api.admin.subscriptionTypes.create.mutate({
                name,
                description: description || null,
                isInternal,
                doubleOptIn,
              }),
            'Subscription type created.',
          ).then((ok) => {
            if (!ok) return
            setName('')
            setDescription('')
            setIsInternal(false)
            setDoubleOptIn(false)
            setCreating(false)
          })
        }
        footer={
          <>
            <Button variant="tertiary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
              Create
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field id="sub-name" label="Name">
            <TextInput id="sub-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Product newsletter" />
          </Field>
          <Field id="sub-description" label="Description" hint="Shown to staff, not to the contact.">
            <TextInput id="sub-description" value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={isInternal} onChange={(event) => setIsInternal(event.target.checked)} />
            <span>
              Internal
              <span className="block text-small text-secondary">Never offered on a public form.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={doubleOptIn} onChange={(event) => setDoubleOptIn(event.target.checked)} />
            <span>
              Confirmed opt-in
              <span className="block text-small text-secondary">
                A form tick only asks. Nothing is sent until the link in the confirmation mail is clicked.
              </span>
            </span>
          </label>
        </div>
      </Modal>

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
            </>
          ) : null
        }
      >
        {removing ? (
          <div className="flex flex-col gap-3">
            {removing.unsubscribed > 0 ? (
              <Alert>
                {fmt.number(removing.unsubscribed)} people have opted out of this. Deleting it
                discards every one of those opt-outs, and nothing anywhere else remembers them.
              </Alert>
            ) : (
              <p>Nobody has opted out of this, so no consent is discarded.</p>
            )}
            <p className="text-secondary">
              {fmt.number(removing.subscribed)} explicit opt-ins go too.
            </p>
          </div>
        ) : null}
      </Modal>

      <RenamePrompt
        value={renaming?.name ?? null}
        title={`Rename ${renaming?.name ?? ''}`}
        label="Subscription type name"
        busy={busy}
        onCancel={() => setRenaming(null)}
        onRename={(name) => {
          if (!renaming) return
          void run(
            () => api.admin.subscriptionTypes.update.mutate({ id: renaming.id, name }),
            'Renamed.',
          ).then((ok) => ok && setRenaming(null))
        }}
      />
    </div>
  )
}
