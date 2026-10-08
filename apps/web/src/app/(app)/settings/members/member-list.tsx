'use client'

import { Avatar, Badge, Button, ConfirmDialog, DataTable, DropdownMenu, EmptyState, Field, IconButton, Modal, Select, TextInput, cn, useToast, type Column } from '@rawr/ui'
import { ChevronDown, Copy, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'
import { pushParams, useUrlParam } from '~/lib/url-params.ts'
import { invitePath } from '~/lib/links.ts'
import { CRITICAL_ACTIONS, CRITICAL_LABEL, HUBS, HUBS_WITH_RECORDS, SCOPE_LABEL, type CriticalAction, type Hub, type Scope } from '~/lib/hubs.ts'
import { useFormat } from '~/components/zone.tsx'
import { AccessEditor, EMPTY_GRANTS, levelOf, scopeOf, type Grants, type RoleTemplate } from './access-editor.tsx'

type HubScopes = Partial<Record<Hub, Scope>>

export type MemberListRow = {
  userId: string
  email: string
  name: string
  avatarUrl: string | null
  isSuperAdmin: boolean
  viewHubs: Hub[]
  editHubs: Hub[]
  viewScopes: HubScopes
  editScopes: HubScopes
  criticalGrants: CriticalAction[]
  state: 'active' | 'invited' | 'deactivated'
  linked: boolean
  joinedAt: string
}

export type InvitationRow = {
  id: string
  email: string
  isSuperAdmin: boolean
  viewHubs: Hub[]
  editHubs: Hub[]
  viewScopes: HubScopes
  editScopes: HubScopes
  criticalGrants: CriticalAction[]
  invitedByName: string | null
  expiresAt: string
  createdAt: string
}

type Props = {
  rows: MemberListRow[]
  invitations: InvitationRow[]
  templates: RoleTemplate[]
  selfId: string
  isSuperAdmin: boolean
}

type View = 'active' | 'pending' | 'deactivated'
const VIEWS: { key: View; label: string }[] = [
  { key: 'active', label: 'Active Users' },
  { key: 'pending', label: 'Pending Invites' },
  { key: 'deactivated', label: 'Deactivated Users' },
]

const grantsOf = (row: MemberListRow | InvitationRow): Grants => ({
  isSuperAdmin: row.isSuperAdmin,
  viewHubs: row.viewHubs,
  editHubs: row.editHubs,
  viewScopes: row.viewScopes,
  editScopes: row.editScopes,
  criticalGrants: row.criticalGrants,
})

/** What the Access column shows, in HubSpot's own shorthand: the hubs someone
 *  holds joined by bars, how far each reaches only where it is narrowed. */
const summarise = (grants: Grants): string => {
  if (grants.isSuperAdmin) return 'Super Admin'
  const held = HUBS.filter((hub) => levelOf(grants, hub) !== 'none')
  if (held.length === 0 && grants.criticalGrants.length === 0) return 'No access'
  const parts = held.map((hub) => {
    const notes = [
      ...(levelOf(grants, hub) === 'view' ? ['view'] : []),
      ...(HUBS_WITH_RECORDS.has(hub) && scopeOf(grants, hub) !== 'everything' ? [SCOPE_LABEL[scopeOf(grants, hub)].toLowerCase()] : []),
    ]
    const name = hub[0]!.toUpperCase() + hub.slice(1)
    return notes.length > 0 ? `${name} (${notes.join(', ')})` : name
  })
  const critical = CRITICAL_ACTIONS.filter((action) => grants.criticalGrants.includes(action))
  if (critical.length > 0) parts.push(critical.map((action) => CRITICAL_LABEL[action]).join(', '))
  return parts.join(' | ')
}

export const MemberList = ({ rows, invitations, templates, selfId, isSuperAdmin }: Props) => {
  const fmt = useFormat()
  const toast = useToast()
  const router = useRouter()
  const [viewParam] = useUrlParam('view')
  const view: View = viewParam === 'pending' || viewParam === 'deactivated' ? viewParam : 'active'
  const [needle, setNeedle] = useState('')
  const [editingId, setEditingId] = useUrlParam('member')
  const [invitingParam, setInviting] = useUrlParam('invite')
  const editingRow = isSuperAdmin ? rows.find((row) => row.userId === editingId && row.userId !== selfId) : undefined
  const editingSelf = isSuperAdmin && editingId === selfId
  const inviting = isSuperAdmin && invitingParam !== null
  const [copying, setCopying] = useState<{ toUserId: string; name: string; fromUserId: string } | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<InvitationRow | null>(null)
  const [ending, setEnding] = useState<{ userId: string; name: string; kind: 'deactivate' | 'remove' } | null>(null)
  /** Who inherits the records and open tasks of the person being ended. Empty leaves
   *  them with nobody, which every scope can still reach. */
  const [handTo, setHandTo] = useState(selfId)
  const [busy, setBusy] = useState(false)
  /** What a member looks like after a change this browser has made but the server
   *  has not sent back yet. router.refresh takes a round trip, and a permission
   *  row that still reads the old way for that long looks like the save failed.
   *  Dropped on failure, so the server rows are what is left. */
  const [pending, setPending] = useState<Record<string, Partial<MemberListRow>>>({})

  const run = async (what: () => Promise<unknown>, done: string, ahead?: { userId: string; patch: Partial<MemberListRow> }) => {
    setBusy(true)
    if (ahead) setPending((current) => ({ ...current, [ahead.userId]: { ...current[ahead.userId], ...ahead.patch } }))
    try {
      await what()
      toast('success', done)
      router.refresh()
    } catch (error) {
      if (ahead) {
        setPending((current) => {
          const next = { ...current }
          delete next[ahead.userId]
          return next
        })
      }
      toast('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const members = rows.map((row) => (pending[row.userId] ? { ...row, ...pending[row.userId] } : row))
  const counts: Record<View, number> = {
    active: members.filter((row) => row.state === 'active').length,
    pending: invitations.length,
    deactivated: members.filter((row) => row.state === 'deactivated').length,
  }
  const wanted = needle.trim().toLowerCase()
  const found = (text: string) => text.toLowerCase().includes(wanted)
  const shown = members.filter((row) => row.state === view && (wanted === '' || found(row.name) || found(row.email)))
  const shownInvites = invitations.filter((row) => wanted === '' || found(row.email))
  const { page, pager } = usePagedRows<MemberListRow>(shown, 'users')
  const invitePage = usePagedRows<InvitationRow>(shownInvites, 'invites')

  const save = async (userId: string, grants: Grants) => {
    setBusy(true)
    setPending((current) => ({ ...current, [userId]: { ...current[userId], ...grants } }))
    try {
      await api.account.members.setGrants.mutate({ userId, ...grants })
      toast('success', 'Permissions saved.')
      router.refresh()
      setEditingId(null)
    } catch (error) {
      setPending((current) => {
        const next = { ...current }
        delete next[userId]
        return next
      })
      toast('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const invite = async (email: string, grants: Grants) => {
    setBusy(true)
    try {
      const { token } = await api.account.members.invite.mutate({ email, ...grants })
      toast('success', 'Invitation ready.')
      router.refresh()
      setInviting(null)
      setLink(`${window.location.origin}${invitePath(token)}`)
    } catch (error) {
      toast('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const memberActions = (row: MemberListRow) =>
    isSuperAdmin && row.userId !== selfId ? (
      <DropdownMenu
        label={`Actions for ${row.name}`}
        align="start"
        trigger={(props) => (
          <button {...props} type="button" className={rowPill}>
            Actions
            <ChevronDown aria-hidden="true" className="size-3" />
          </button>
        )}
        groups={[{ key: 'member', items: [
          { key: 'edit', label: 'Edit permissions', onSelect: () => setEditingId(row.userId) },
          { key: 'copy', label: 'Copy permissions from...', onSelect: () => setCopying({ toUserId: row.userId, name: row.name, fromUserId: '' }) },
          row.state === 'deactivated'
            ? {
                key: 'reactivate',
                label: 'Restore access',
                onSelect: () =>
                  run(
                    () => api.account.members.reactivate.mutate({ userId: row.userId }),
                    'Access restored.',
                    { userId: row.userId, patch: { state: 'active' } },
                  ),
              }
            : { key: 'deactivate', label: 'End access', onSelect: () => setEnding({ userId: row.userId, name: row.name, kind: 'deactivate' }) },
          { key: 'remove', label: 'Remove from account', destructive: true, onSelect: () => setEnding({ userId: row.userId, name: row.name, kind: 'remove' }) },
        ] }]}
      />
    ) : null

  const memberColumns: Column<MemberListRow>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 380,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <Avatar name={row.name} />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {isSuperAdmin && row.userId !== selfId ? (
              <button type="button" title={row.name} onClick={() => setEditingId(row.userId)} className="min-w-0 truncate text-left font-semibold text-link hover:underline">
                {row.name}
              </button>
            ) : (
              <span title={row.name} className="min-w-0 truncate font-semibold">
                {row.name}
              </span>
            )}
            {row.userId === selfId ? <span className="shrink-0 text-secondary">(you)</span> : null}
            {row.isSuperAdmin ? <Badge tone="accent" className="shrink-0">Super Admin</Badge> : null}
            {!row.linked ? <Badge tone="neutral" className="shrink-0">Never signed in</Badge> : null}
          </span>
          <RowActions>{memberActions(row)}</RowActions>
        </span>
      ),
    },
    { key: 'email', header: 'Email', width: 260, render: (row) => <span title={row.email} className="block truncate">{row.email}</span> },
    { key: 'access', header: 'Access', width: 380, render: (row) => <span title={summarise(row)} className="block truncate">{summarise(row)}</span> },
    { key: 'joined', header: 'Joined', width: 160, render: (row) => <span className="whitespace-nowrap">{fmt.date(row.joinedAt)}</span> },
  ]

  const inviteColumns: Column<InvitationRow>[] = [
    {
      key: 'email',
      header: 'Email',
      width: 340,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span title={row.email} className="min-w-0 flex-1 truncate font-semibold">{row.email}</span>
          {isSuperAdmin ? (
            <RowActions>
              <DropdownMenu
                label={`Actions for the invitation to ${row.email}`}
                align="start"
                trigger={(props) => (
                  <button {...props} type="button" className={rowPill}>
                    Actions
                    <ChevronDown aria-hidden="true" className="size-3" />
                  </button>
                )}
                groups={[{ key: 'invite', items: [
                  {
                    key: 'resend',
                    label: 'Resend',
                    onSelect: () =>
                      run(async () => {
                        const { token } = await api.account.members.resend.mutate({ invitationId: row.id })
                        setLink(`${window.location.origin}${invitePath(token)}`)
                      }, 'A new link is ready.'),
                  },
                  {
                    key: 'revoke',
                    label: 'Revoke',
                    destructive: true,
                    onSelect: () => setRevoking(row),
                  },
                ] }]}
              />
            </RowActions>
          ) : null}
        </span>
      ),
    },
    { key: 'access', header: 'Access', width: 340, render: (row) => <span title={summarise(row)} className="block truncate">{summarise(row)}</span> },
    { key: 'by', header: 'Invited by', width: 200, render: (row) => <span className="block truncate">{row.invitedByName ?? EMPTY_VALUE}</span> },
    { key: 'expires', header: 'Expires', width: 160, render: (row) => <span className="whitespace-nowrap">{fmt.date(row.expiresAt)}</span> },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0">Create users, choose what each of them can reach, and end their access.</p>
        {isSuperAdmin ? <Button onClick={() => setInviting('1')}>Create user</Button> : null}
      </div>

      <div role="tablist" aria-label="Users by state" className="flex min-w-0 overflow-x-auto">
        {VIEWS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={view === entry.key}
            onClick={() => pushParams({ view: entry.key === 'active' ? null : entry.key, skip: null })}
            className={cn(
              'flex h-pill min-w-0 flex-1 basis-0 items-center gap-2 border border-line px-3 text-left whitespace-nowrap transition-colors duration-150 ease-out @lg:max-w-[16.25rem] [&+&]:-ml-px',
              view === entry.key ? 'bg-surface' : 'bg-fill hover:bg-fill-hover',
            )}
          >
            <span className="grid h-[1.125rem] min-w-[1.125rem] shrink-0 place-items-center rounded-pill bg-body px-1 text-small text-inverse tabular-nums">
              {fmt.number(counts[entry.key])}
            </span>
            <span className="min-w-0 truncate">{entry.label}</span>
          </button>
        ))}
      </div>

      <label className="relative w-full min-w-0 @lg:w-80">
        <span className="sr-only">Search name or email address</span>
        <input
          type="search"
          value={needle}
          placeholder={view === 'pending' ? 'Search email address' : 'Search name or email address'}
          onChange={(event) => setNeedle(event.target.value)}
          className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-9 pl-4 text-base font-light placeholder:text-muted"
        />
        <Search aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
      </label>

      {view === 'pending' ? (
        shownInvites.length === 0 ? (
          <EmptyState
            title={wanted ? 'No invitation matches' : 'No open invitations'}
            description={wanted ? 'Nobody invited has that email address.' : 'Everybody invited has taken their seat.'}
          />
        ) : (
          <>
            <DataTable columns={inviteColumns} rows={invitePage.page} rowKey={(row) => row.id} caption="Pending invites" storageKey="settings.invites" />
            {invitePage.pager}
          </>
        )
      ) : shown.length === 0 ? (
        <EmptyState
          title={wanted ? 'Nobody matches' : view === 'active' ? 'Nobody here yet' : 'Nobody deactivated'}
          description={
            wanted
              ? 'No user here has that name or email address.'
              : view === 'active'
                ? 'Create a user to seat them.'
                : 'Everybody who has been here still has access.'
          }
        />
      ) : (
        <>
          <DataTable columns={memberColumns} rows={page} rowKey={(row) => row.userId} caption={VIEWS.find((entry) => entry.key === view)!.label} storageKey="settings.users" />
          {pager}
        </>
      )}

      {editingRow ? (
        <AccessEditor
          key={editingRow.userId}
          name={editingRow.name}
          initial={grantsOf(editingRow)}
          templates={templates}
          copyFrom={members.filter((row) => row.userId !== editingRow.userId).map((row) => ({ userId: row.userId, name: row.name, grants: grantsOf(row) }))}
          busy={busy}
          onSave={(grants) => void save(editingRow.userId, grants)}
          onClose={() => setEditingId(null)}
        />
      ) : inviting ? (
        <AccessEditor
          name={null}
          initial={EMPTY_GRANTS}
          templates={templates}
          copyFrom={members.map((row) => ({ userId: row.userId, name: row.name, grants: grantsOf(row) }))}
          busy={busy}
          onSave={(grants, email) => void invite(email, grants)}
          onClose={() => setInviting(null)}
        />
      ) : editingSelf ? (
        <p className="min-w-0">You cannot change your own access. Ask another super admin to do it.</p>
      ) : null}

      <Modal
        open={copying !== null}
        onClose={() => setCopying(null)}
        title={`Copy permissions to ${copying?.name ?? ''}`}
        footer={
          copying ? (
            <>
              <Button variant="secondary" onClick={() => setCopying(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy || copying.fromUserId === ''}
                onClick={() => {
                  const source = members.find((row) => row.userId === copying.fromUserId)
                  void run(
                    async () => {
                      await api.account.members.copyGrants.mutate({
                        fromUserId: copying.fromUserId,
                        toUserId: copying.toUserId,
                      })
                      setCopying(null)
                    },
                    'Permissions copied.',
                    source ? { userId: copying.toUserId, patch: grantsOf(source) } : undefined,
                  )
                }}
              >
                Copy
              </Button>
            </>
          ) : null
        }
      >
        {copying ? (
          <div className="flex flex-col gap-4">
            <Field id="copy-from" label="Copy from" hint="They end up holding exactly what this person holds now.">
              <Select
                id="copy-from"
                value={copying.fromUserId}
                onChange={(e) => setCopying({ ...copying, fromUserId: e.target.value })}
              >
                <option value="">Pick somebody</option>
                {rows
                  .filter((row) => row.userId !== copying.toUserId)
                  .map((row) => (
                    <option key={row.userId} value={row.userId}>
                      {row.name} - {summarise(row)}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke the invitation to ${revoking?.email ?? ''}?`}
        confirm="Revoke"
        busy={busy}
        onCancel={() => setRevoking(null)}
        onConfirm={() =>
          revoking &&
          void run(() => api.account.members.revoke.mutate({ invitationId: revoking.id }), 'Invitation revoked.').then(() =>
            setRevoking(null),
          )
        }
      >
        <p className="break-words">The link sent to {revoking?.email} stops working. Invite them again to send a new one.</p>
      </ConfirmDialog>

      {/* Both actions here take somebody's access away, so both are confirmed like
          every other destructive action in Rawr. Removing is the one that cannot be
          undone: the seat and its grants are deleted rather than suspended. */}
      <Modal
        open={ending !== null}
        onClose={() => setEnding(null)}
        title={
          ending?.kind === 'remove'
            ? `Remove ${ending.name} from this account?`
            : `End access for ${ending?.name ?? ''}?`
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setEnding(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() => {
                const target = ending!
                setEnding(null)
                if (target.kind === 'remove') {
                  void run(() => api.account.members.remove.mutate({ userId: target.userId }), 'Removed.')
                  return
                }
                void run(() => api.account.members.deactivate.mutate({ userId: target.userId, reassignTo: handTo || null }), 'Access ended.', {
                  userId: target.userId,
                  patch: { state: 'deactivated' },
                })
              }}
            >
              {ending?.kind === 'remove' ? 'Remove' : 'End access'}
            </Button>
          </>
        }
      >
        {ending?.kind === 'remove' ? (
          <p>
            Their seat and everything it granted go, and nothing puts them back except a new
            invitation with the permissions typed again. Their records, notes and emails stay where
            they are. Ending access instead keeps the seat, so restoring it puts back exactly what
            they held.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <p>
              They are signed out of this account and cannot get back in. Their notes and emails
              stay where they are, their mailbox is disconnected, and restoring access puts back
              exactly what they held.
            </p>
            <Field id="hand-to" label="Hand their records and open tasks to">
              <Select id="hand-to" value={handTo} onChange={(e) => setHandTo(e.target.value)}>
                <option value="">Nobody</option>
                {rows
                  .filter((row) => row.state === 'active' && row.userId !== ending?.userId)
                  .map((row) => (
                    <option key={row.userId} value={row.userId}>
                      {row.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        )}
      </Modal>

      {/* The link is shown once and stored nowhere, so a lost one is resent rather
          than looked up. */}
      <Modal open={link !== null} onClose={() => setLink(null)} title="The invitation link">
        <div className="flex flex-col gap-3">
          <p className="text-secondary">
            Send this to them yourself. It is shown once and works for two weeks.
          </p>
          <div className="flex gap-2">
            <TextInput value={link ?? ''} readOnly />
            <IconButton
              label="Copy link"
              icon={<Copy size={16} />}
              onClick={() => {
                if (link) void navigator.clipboard.writeText(link)
                toast('success', 'Copied.')
              }}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
