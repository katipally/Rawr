'use client'

import type { Role } from '@rawr/db'
import { Avatar, Badge, Button, Card, Checkbox, Combobox, DropdownMenu, EmptyState, Field, IconButton, Modal, Select, TextInput, useToast } from '@rawr/ui'
import { Copy, MoreHorizontal } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

export type MemberListRow = {
  userId: string
  email: string
  name: string
  orgRole: 'org_admin' | 'member'
  state: 'active' | 'invited' | 'deactivated'
  linked: boolean
  joinedAt: string
  deactivatedAt: string | null
  seats: { workspaceId: string; workspaceName: string; role: Role }[]
  /** Their role in the workspace being looked at, or null if they hold no seat here. */
  roleHere: Role | null
}

export type InvitationRow = {
  id: string
  email: string
  orgRole: 'org_admin' | 'member'
  workspaceName: string | null
  workspaceRole: Role | null
  invitedByName: string | null
  expiresAt: string
  createdAt: string
}

type Props = {
  rows: MemberListRow[]
  invitations: InvitationRow[]
  workspaces: { id: string; name: string }[]
  workspaceId: string
  workspaceName: string
  selfId: string
  canSetRole: boolean
  isOrgAdmin: boolean
  role: string
}

const ROLES = ['admin', 'sales', 'marketing', 'viewer'] as const satisfies readonly Role[]

// Listed here as well as in the data access layer: a client bundle cannot import
// the database package, and Record<Role, ...> fails to compile if the two drift.
const ROLE_HINT: Record<Role, string> = {
  admin: 'Everything, including settings and members',
  sales: 'Contacts, companies, deals, tasks, bookings',
  marketing: 'Contacts, companies, forms, segments, subscriptions',
  viewer: 'Read only',
}

type Tab = 'active' | 'pending' | 'deactivated'

export const MemberList = ({
  rows,
  invitations,
  workspaces,
  workspaceId,
  workspaceName,
  selfId,
  canSetRole,
  isOrgAdmin,
  role,
}: Props) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>('active')
  const [inviting, setInviting] = useState(false)
  const [draft, setDraft] = useState({
    email: '',
    orgAdmin: false,
    workspaceId: workspaceId as string | null,
    role: 'viewer' as Role,
  })
  /** Shown once, after the invitation is made. Nothing stores the link. */
  const [link, setLink] = useState<string | null>(null)
  const [ending, setEnding] = useState<MemberListRow | null>(null)

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

  const active = rows.filter((row) => row.state === 'active')
  const deactivated = rows.filter((row) => row.state === 'deactivated')
  const counts: Record<Tab, number> = {
    active: active.length,
    pending: invitations.length,
    deactivated: deactivated.length,
  }
  const shown = tab === 'deactivated' ? deactivated : active

  const inviteLink = (token: string) => `${window.location.origin}/invite/${token}`

  const person = (row: MemberListRow) => (
    <li key={row.userId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <Avatar name={row.name || row.email} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-medium">{row.name}</span>
          {row.userId === selfId ? <span className="text-secondary">(you)</span> : null}
          {row.orgRole === 'org_admin' ? <Badge tone="accent">Organisation admin</Badge> : null}
          {row.state === 'deactivated' ? <Badge tone="error">Deactivated</Badge> : null}
        </span>
        <span className="truncate text-small text-secondary">{row.email}</span>
        {row.seats.length > 0 ? (
          <span className="truncate text-small text-secondary">
            {row.seats.map((seat) => `${seat.workspaceName}: ${seat.role}`).join(' · ')}
          </span>
        ) : (
          <span className="text-small text-secondary">No workspace seat yet</span>
        )}
      </span>

      <span className="shrink-0">
        {row.linked ? (
          <Badge tone="ok" dot>
            Signed in
          </Badge>
        ) : (
          <Badge>Not signed in yet</Badge>
        )}
      </span>

      {/* The role control edits the workspace being looked at, which is the one
          question a workspace admin can answer without being an org admin. */}
      <span className="w-40 shrink-0">
        {canSetRole && row.state === 'active' ? (
          <Select
            aria-label={`Role for ${row.name} in ${workspaceName}`}
            value={row.roleHere ?? ''}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value
              void run(
                () =>
                  next === ''
                    ? api.admin.members.remove.mutate({ userId: row.userId })
                    : row.roleHere === null
                      ? api.admin.members.add.mutate({ email: row.email, name: row.name, role: next as Role })
                      : api.admin.members.setRole.mutate({ userId: row.userId, role: next as Role }),
                next === ''
                  ? `${row.name} no longer has a seat in ${workspaceName}.`
                  : `${row.name} is ${next} in ${workspaceName}.`,
              )
            }}
          >
            <option value="">No seat here</option>
            {ROLES.map((each) => (
              <option key={each} value={each}>
                {each}
              </option>
            ))}
          </Select>
        ) : (
          <span className="text-secondary">{row.roleHere ?? 'No seat here'}</span>
        )}
      </span>

      {isOrgAdmin && row.userId !== selfId ? (
        <DropdownMenu
          label={`Actions for ${row.name}`}
          groups={[
            {
              key: 'org',
              items: [
                {
                  key: 'org-role',
                  label: row.orgRole === 'org_admin' ? 'Remove organisation admin' : 'Make organisation admin',
                  onSelect: () =>
                    void run(
                      () =>
                        api.org.members.setOrgRole.mutate({
                          userId: row.userId,
                          role: row.orgRole === 'org_admin' ? 'member' : 'org_admin',
                        }),
                      `${row.name} is now ${row.orgRole === 'org_admin' ? 'a member' : 'an organisation admin'}.`,
                    ),
                },
              ],
            },
            {
              key: 'access',
              items:
                row.state === 'deactivated'
                  ? [
                      {
                        key: 'reactivate',
                        label: 'Restore access',
                        onSelect: () =>
                          void run(
                            () => api.org.members.reactivate.mutate({ userId: row.userId }),
                            `${row.name} can sign in again.`,
                          ),
                      },
                    ]
                  : [
                      {
                        key: 'deactivate',
                        label: 'End access',
                        destructive: true,
                        onSelect: () => setEnding(row),
                      },
                    ],
            },
          ]}
          trigger={(props) => (
            <Button {...props} variant="tertiary" disabled={busy} aria-label={`Actions for ${row.name}`}>
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </Button>
          )}
        />
      ) : null}
    </li>
  )

  return (
    <div className="flex flex-col gap-3">
      {!canSetRole && !isOrgAdmin ? (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          Your role ({role}) can read this and cannot change it.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Members">
          {(['active', 'pending', 'deactivated'] as const).map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={tab === each}
              onClick={() => setTab(each)}
              className={
                tab === each
                  ? 'rounded-hs bg-accent-subtle px-3 py-1.5 font-medium text-link'
                  : 'rounded-hs px-3 py-1.5 text-secondary hover:bg-fill'
              }
            >
              {each === 'active' ? 'Active' : each === 'pending' ? 'Pending invites' : 'Deactivated'}
              <span className="ml-1.5 text-small">{counts[each]}</span>
            </button>
          ))}
        </div>
        {isOrgAdmin ? (
          <Button variant="primary" onClick={() => setInviting(true)}>
            Invite somebody
          </Button>
        ) : null}
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-small text-secondary">
        {ROLES.map((each) => (
          <div key={each} className="flex gap-1">
            <dt className="font-medium text-body">{each}</dt>
            <dd>{ROLE_HINT[each]}</dd>
          </div>
        ))}
      </dl>

      {tab === 'pending' ? (
        invitations.length === 0 ? (
          <EmptyState
            title="No invitations are waiting"
            description="Invite somebody by email and they will land here until they sign in."
          />
        ) : (
          <Card flush>
            <ul className="divide-y divide-divider">
              {invitations.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <Avatar name={row.email} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{row.email}</span>
                    <span className="truncate text-small text-secondary">
                      {row.workspaceName ? `${row.workspaceName}: ${row.workspaceRole}` : 'Organisation only'}
                      {row.invitedByName ? ` · invited by ${row.invitedByName}` : ''}
                    </span>
                  </span>
                  <Badge tone={new Date(row.expiresAt) < new Date() ? 'error' : 'warn'}>
                    {new Date(row.expiresAt) < new Date()
                      ? 'Expired'
                      : `Expires ${new Date(row.expiresAt).toLocaleDateString()}`}
                  </Badge>
                  <IconButton
                    label={`Send ${row.email} a fresh invitation link`}
                    icon={<ACTION_ICONS.resend size={16} />}
                    disabled={busy}
                    onClick={() =>
                      void api.org.members.resend
                        .mutate({ invitationId: row.id })
                        .then((result) => {
                          setLink(inviteLink(result.token))
                          toast('success', 'A new link was made. The old one no longer works.')
                          router.refresh()
                        })
                        .catch((cause) => toast('error', errorMessage(cause)))
                    }
                  />
                  <IconButton
                    label={`Revoke the invitation to ${row.email}`}
                    tone="destructive"
                    icon={<ACTION_ICONS.revoke size={16} />}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api.org.members.revoke.mutate({ invitationId: row.id }),
                        `The invitation to ${row.email} was revoked.`,
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          </Card>
        )
      ) : shown.length === 0 ? (
        <EmptyState
          title={tab === 'active' ? 'Nobody is in this organisation yet' : 'Nobody has been deactivated'}
          description={
            tab === 'active'
              ? 'Invite somebody by email to seat them.'
              : 'Ending somebody’s access keeps their name on everything they did.'
          }
        />
      ) : (
        <Card flush>
          <ul className="divide-y divide-divider">{shown.map(person)}</ul>
        </Card>
      )}

      {inviting ? (
        <Modal open title="Invite somebody" onClose={() => setInviting(false)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              setBusy(true)
              void api.org.members.invite
                .mutate({
                  email: draft.email,
                  orgRole: draft.orgAdmin ? 'org_admin' : 'member',
                  workspaceId: draft.workspaceId,
                  workspaceRole: draft.workspaceId ? draft.role : null,
                })
                .then((result) => {
                  setLink(inviteLink(result.token))
                  setInviting(false)
                  setDraft({ email: '', orgAdmin: false, workspaceId, role: 'viewer' })
                  toast('success', 'The invitation is ready. Send them the link.')
                  router.refresh()
                })
                .catch((cause) => toast('error', errorMessage(cause)))
                .finally(() => setBusy(false))
            }}
          >
            <p className="text-secondary">
              Rawr does not send mail yet, so the link appears here once and you send it. It works only
              for the address you name, and it expires in two weeks.
            </p>
            <Field label="Work email" id="invite-email" required>
              <TextInput
                id="invite-email"
                type="email"
                required
                autoFocus
                value={draft.email}
                onChange={(event) => setDraft({ ...draft, email: event.target.value })}
              />
            </Field>
            <Combobox
              label="Workspace seat"
              value={draft.workspaceId}
              onChange={(value) => setDraft({ ...draft, workspaceId: value })}
              hint="Leave it empty to add them to the organisation without a seat."
              options={workspaces.map((each) => ({ value: each.id, label: each.name }))}
            />
            {draft.workspaceId ? (
              <Field label="Role in that workspace" id="invite-role">
                <Select
                  id="invite-role"
                  value={draft.role}
                  onChange={(event) => setDraft({ ...draft, role: event.target.value as Role })}
                >
                  {ROLES.map((each) => (
                    <option key={each} value={each}>
                      {each}: {ROLE_HINT[each]}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Checkbox
              label="Can administer the organisation"
              hint="Creates workspaces, invites people and ends access."
              checked={draft.orgAdmin}
              onChange={(event) => setDraft({ ...draft, orgAdmin: event.target.checked })}
            />
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" type="button" onClick={() => setInviting(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" busy={busy} disabled={draft.email.trim() === ''}>
                Make the invitation
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {link ? (
        <Modal open size="sm" title="Send them this link" onClose={() => setLink(null)}>
          <div className="flex flex-col gap-3">
            <p className="text-secondary">
              This is the only time it is shown. If it is lost, resend the invitation to make a new one.
            </p>
            <code className="block overflow-x-auto rounded-hs border border-line bg-fill px-3 py-2">{link}</code>
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(link).then(
                    () => toast('success', 'Copied.'),
                    () => toast('error', 'The browser refused to copy. Select the link and copy it by hand.'),
                  )
                }}
              >
                <Copy aria-hidden="true" className="size-4" />
                Copy
              </Button>
              <Button variant="primary" onClick={() => setLink(null)}>
                Done
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {ending ? (
        <Modal open size="sm" title={`End access for ${ending.name}`} onClose={() => setEnding(null)}>
          <div className="flex flex-col gap-3">
            <p>
              {ending.name} loses access to every workspace in this organisation, and every session they
              hold stops working on its next request. Their name stays on everything they did.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" onClick={() => setEnding(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                busy={busy}
                onClick={() =>
                  void run(
                    () => api.org.members.deactivate.mutate({ userId: ending.userId }),
                    `${ending.name} can no longer sign in.`,
                  ).then((ok) => ok && setEnding(null))
                }
              >
                End access
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
