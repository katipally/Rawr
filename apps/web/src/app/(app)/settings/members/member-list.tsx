'use client'

import type { Role } from '@rawr/db'
import { Button, DataTable, EmptyState, Field, Modal, Select, TextInput, useToast, type Column } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

export type MemberListRow = {
  userId: string
  email: string
  name: string
  avatarUrl: string | null
  role: Role
  linked: boolean
  joinedAt: string
}

type Props = { rows: MemberListRow[]; selfId: string; canWrite: boolean; role: string }

const ROLES = ['admin', 'sales', 'marketing', 'viewer'] as const satisfies readonly Role[]

// Listed here as well as in the data access layer: a client bundle cannot import
// the database package, and Record<Role, ...> fails to compile if the two drift.
const ROLE_HINT: Record<Role, string> = {
  admin: 'Everything, including settings and members',
  sales: 'Contacts, companies, deals, tasks, bookings',
  marketing: 'Contacts, companies, forms, segments, subscriptions',
  viewer: 'Read only',
}

export const MemberList = ({ rows, selfId, canWrite, role }: Props) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ email: '', name: '', role: 'viewer' as Role })
  const [removing, setRemoving] = useState<MemberListRow | null>(null)

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

  const columns: Column<MemberListRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">
            {row.name}
            {row.userId === selfId ? <span className="ml-1 text-secondary">(you)</span> : null}
          </span>
          <span className="truncate text-small text-secondary">{row.email}</span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: 150,
      render: (row) =>
        canWrite ? (
          <select
            aria-label={`Role for ${row.name}`}
            value={row.role}
            disabled={busy}
            onChange={(event) =>
              void run(
                () => api.admin.members.setRole.mutate({ userId: row.userId, role: event.target.value as Role }),
                `${row.name} is now ${event.target.value}.`,
              )
            }
            className="min-h-8 rounded-hs border border-line bg-surface pl-2 pr-7 text-body"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          <span>{row.role}</span>
        ),
    },
    {
      key: 'linked',
      header: 'Google',
      width: 160,
      render: (row) => (
        <span className={row.linked ? 'text-success' : 'text-secondary'}>
          {row.linked ? 'Signed in' : 'Not signed in yet'}
        </span>
      ),
    },
    {
      key: 'joinedAt',
      header: 'Joined',
      width: 120,
      render: (row) => <span className="text-secondary">{new Date(row.joinedAt).toLocaleDateString()}</span>,
    },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: '',
            width: 110,
            render: (row: MemberListRow) =>
              row.userId === selfId ? null : (
                <Button variant="tertiary" disabled={busy} onClick={() => setRemoving(row)}>
                  Remove
                </Button>
              ),
          } satisfies Column<MemberListRow>,
        ]
      : []),
  ]

  return (
    <div className="flex flex-col gap-3">
      {!canWrite ? (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          Your role ({role}) can read this and cannot change it.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-small text-secondary">
            {ROLES.map((r) => (
              <div key={r} className="flex gap-1">
                <dt className="font-medium text-body">{r}</dt>
                <dd>{ROLE_HINT[r]}</dd>
              </div>
            ))}
          </dl>
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add member
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title="Nobody is in this workspace yet" description="Add somebody by email to seat them." />
      ) : (
        <DataTable caption="Members of this workspace" columns={columns} rows={rows} rowKey={(row) => row.userId} storageKey="members" />
      )}

      {adding ? (
        <Modal open title="Add a member" onClose={() => setAdding(false)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void run(
                () => api.admin.members.add.mutate({ email: draft.email, name: draft.name || undefined, role: draft.role }),
                `${draft.email} can sign in as ${draft.role}.`,
              ).then((ok) => {
                if (ok) {
                  setAdding(false)
                  setDraft({ email: '', name: '', role: 'viewer' })
                }
              })
            }}
          >
            <Field label="Work email" id="member-email" required>
              <TextInput
                id="member-email"
                type="email"
                required
                autoFocus
                value={draft.email}
                onChange={(event) => setDraft({ ...draft, email: event.target.value })}
              />
            </Field>
            <Field label="Name" id="member-name" hint="Optional. Google fills it in on their first sign-in.">
              <TextInput id="member-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="Role" id="member-role">
              <Select id="member-role" value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as Role })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}: {ROLE_HINT[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" busy={busy}>
                Add
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {removing ? (
        <Modal open title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <p className="text-secondary">
            {removing.email} loses access on their next request. Records they own keep them as owner.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="tertiary" onClick={() => setRemoving(null)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() =>
                void run(() => api.admin.members.remove.mutate({ userId: removing.userId }), `${removing.name} was removed.`).then(
                  (ok) => ok && setRemoving(null),
                )
              }
            >
              Remove
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
