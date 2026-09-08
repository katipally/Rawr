'use client'

import { Avatar, Badge, Button, Card, Checkbox, DropdownMenu, EmptyState, Field, IconButton, Modal, TextInput, useToast } from '@rawr/ui'
import { Copy, MoreHorizontal } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { invitePath } from '~/lib/links.ts'
import { HUBS, HUBS_WITHOUT_SCREENS, HUBS_WITH_RECORDS, HUB_HINT, SCOPES, SCOPE_LABEL, type Hub, type Scope } from '~/lib/hubs.ts'

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
  invitedByName: string | null
  expiresAt: string
  createdAt: string
}

type Props = {
  rows: MemberListRow[]
  invitations: InvitationRow[]
  selfId: string
  isSuperAdmin: boolean
}

type Grants = {
  isSuperAdmin: boolean
  viewHubs: Hub[]
  editHubs: Hub[]
  viewScopes: HubScopes
  editScopes: HubScopes
}
type Level = 'none' | 'view' | 'edit'
type Tab = 'active' | 'pending' | 'deactivated'

const EMPTY: Grants = { isSuperAdmin: false, viewHubs: [], editHubs: [], viewScopes: {}, editScopes: {} }

const levelOf = (grants: Grants, hub: Hub): Level =>
  grants.editHubs.includes(hub) ? 'edit' : grants.viewHubs.includes(hub) ? 'view' : 'none'

/** A hub that reaches everything is absent from the map rather than stored as
 *  'everything', which is the shape the server keeps and the policy reads. */
const withScope = (map: HubScopes, hub: Hub, scope: Scope): HubScopes => {
  const next = { ...map }
  if (scope === 'everything') delete next[hub]
  else next[hub] = scope
  return next
}

const scopeOf = (grants: Grants, hub: Hub): Scope => grants.viewScopes[hub] ?? 'everything'

const withLevel = (grants: Grants, hub: Hub, level: Level): Grants => ({
  isSuperAdmin: grants.isSuperAdmin,
  viewHubs: level === 'view' ? [...new Set([...grants.viewHubs, hub])] : grants.viewHubs.filter((h) => h !== hub),
  editHubs: level === 'edit' ? [...new Set([...grants.editHubs, hub])] : grants.editHubs.filter((h) => h !== hub),
  // Dropping a hub drops its scope with it, so granting it again starts open
  // rather than silently narrowed by a decision somebody made months ago.
  viewScopes: level === 'none' ? withScope(grants.viewScopes, hub, 'everything') : grants.viewScopes,
  editScopes: level === 'edit' ? grants.editScopes : withScope(grants.editScopes, hub, 'everything'),
})

/** One control, both maps. Reading and writing are narrowed together because a
 *  seat that may only edit its own records has no reason to read everybody's,
 *  and HubSpot's own grid moves them together too. */
const withRecordScope = (grants: Grants, hub: Hub, scope: Scope): Grants => ({
  ...grants,
  viewScopes: withScope(grants.viewScopes, hub, scope),
  editScopes: grants.editHubs.includes(hub) ? withScope(grants.editScopes, hub, scope) : grants.editScopes,
})

/** What the row shows at a glance, in HubSpot's own shorthand: the hubs someone
 *  holds, not a count of them. */
const summarise = (grants: Grants): string => {
  if (grants.isSuperAdmin) return 'Super Admin'
  const held = HUBS.filter((hub) => levelOf(grants, hub) !== 'none')
  if (held.length === 0) return 'No access'
  return held
    .map((hub) => {
      const level = levelOf(grants, hub) === 'edit' ? hub : `${hub} (view)`
      const scope = scopeOf(grants, hub)
      return scope === 'everything' ? level : `${level} · ${SCOPE_LABEL[scope].toLowerCase()}`
    })
    .join(' · ')
}

/** The grid itself: one row per hub, three exclusive levels. Super admin sits
 *  above it and greys it out, because holding everything is not six choices. */
const GrantGrid = ({ value, onChange }: { value: Grants; onChange: (next: Grants) => void }) => (
  <div className="flex flex-col gap-3">
    <Checkbox
      label="Super Admin"
      hint="Every hub, plus seating people and ending their access."
      checked={value.isSuperAdmin}
      onChange={(e) => onChange({ ...value, isSuperAdmin: e.target.checked })}
    />
    <div className="flex flex-col gap-1 rounded-hs border border-line">
      <div className="grid grid-cols-[1fr_auto] gap-2 border-b border-line px-3 py-2 text-small text-secondary">
        <span>Hub</span>
        <span>None · View · Edit</span>
      </div>
      {HUBS.map((hub) => {
        const level = levelOf(value, hub)
        return (
          <div key={hub} className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2">
            <div>
              <p className="capitalize text-body">
                {hub}
                {HUBS_WITHOUT_SCREENS.has(hub) ? <span className="ml-2 text-small text-secondary">no screens yet</span> : null}
              </p>
              <p className="text-small text-secondary">{HUB_HINT[hub]}</p>
            </div>
            <fieldset className="flex gap-1 border-0 p-0">
              <legend className="sr-only">{hub} access</legend>
              {(['none', 'view', 'edit'] as const).map((option) => (
                <Button
                  key={option}
                  type="button"
                  variant={level === option ? 'primary' : 'secondary'}
                  disabled={value.isSuperAdmin}
                  onClick={() => onChange(withLevel(value, hub, option))}
                >
                  {option === 'none' ? 'None' : option === 'view' ? 'View' : 'Edit'}
                </Button>
              ))}
            </fieldset>
            {level !== 'none' && HUBS_WITH_RECORDS.has(hub) && !value.isSuperAdmin ? (
              <fieldset className="col-span-2 flex flex-wrap items-center gap-1 border-0 p-0 pl-0 pt-1">
                <legend className="sr-only">how much of {hub} this seat reaches</legend>
                <span className="pr-1 text-small text-secondary">Reaches</span>
                {SCOPES.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    variant={scopeOf(value, hub) === option ? 'primary' : 'secondary'}
                    onClick={() => onChange(withRecordScope(value, hub, option))}
                  >
                    {SCOPE_LABEL[option]}
                  </Button>
                ))}
                <span className="text-small text-secondary">
                  {scopeOf(value, hub) === 'everything'
                    ? 'every record in the account'
                    : scopeOf(value, hub) === 'team'
                      ? 'records owned by anybody on their teams, and unassigned ones'
                      : 'only records they own, and unassigned ones'}
                </span>
              </fieldset>
            ) : null}
          </div>
        )
      })}
    </div>
  </div>
)

export const MemberList = ({ rows, invitations, selfId, isSuperAdmin }: Props) => {
  const toast = useToast()
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('active')
  const [editing, setEditing] = useState<{ userId: string; name: string; grants: Grants } | null>(null)
  const [inviting, setInviting] = useState<{ email: string; grants: Grants } | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await what()
      toast('success', done)
      router.refresh()
    } catch (error) {
      toast('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const shown = rows.filter((row) =>
    tab === 'active' ? row.state === 'active' : tab === 'deactivated' ? row.state === 'deactivated' : false,
  )

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex gap-1">
          {(['active', 'pending', 'deactivated'] as const).map((key) => (
            <Button
              key={key}
              variant={tab === key ? 'primary' : 'secondary'}
              onClick={() => setTab(key)}
            >
              {key === 'active'
                ? `Active (${rows.filter((r) => r.state === 'active').length})`
                : key === 'pending'
                  ? `Pending (${invitations.length})`
                  : `Deactivated (${rows.filter((r) => r.state === 'deactivated').length})`}
            </Button>
          ))}
        </div>
        {isSuperAdmin ? (
          <Button onClick={() => setInviting({ email: '', grants: EMPTY })}>Create user</Button>
        ) : null}
      </div>

      {tab === 'pending' ? (
        invitations.length === 0 ? (
          <EmptyState title="No open invitations" description="Everybody invited has taken their seat." />
        ) : (
          <ul>
            {invitations.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-0">
                <div>
                  <p className="text-body">{row.email}</p>
                  <p className="text-small text-secondary">
                    {summarise(row)} · invited by {row.invitedByName ?? 'somebody'} · expires{' '}
                    {new Date(row.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                {isSuperAdmin ? (
                  <DropdownMenu
                    label="Invitation actions"
                    trigger={(props) => <IconButton {...props} label="Invitation actions" icon={<MoreHorizontal size={16} />} />}
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
                        onSelect: () =>
                          run(() => api.account.members.revoke.mutate({ invitationId: row.id }), 'Invitation revoked.'),
                      },
                    ] }]}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : shown.length === 0 ? (
        <EmptyState
          title={tab === 'active' ? 'Nobody here yet' : 'Nobody deactivated'}
          description={tab === 'active' ? 'Invite somebody to seat them.' : 'Everybody who has been here still has access.'}
        />
      ) : (
        <ul>
          {shown.map((row) => (
            <li key={row.userId} className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-0">
              <div className="flex items-center gap-3">
                <Avatar name={row.name} />
                <div>
                  <p className="text-body">
                    {row.name}
                    {row.userId === selfId ? <span className="text-secondary"> (you)</span> : null}
                    {row.isSuperAdmin ? (
                      <Badge tone="accent" className="ml-2">
                        Super Admin
                      </Badge>
                    ) : null}
                    {!row.linked ? (
                      <Badge tone="neutral" className="ml-2">
                        Never signed in
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-small text-secondary">
                    {row.email} · {summarise(row)}
                  </p>
                </div>
              </div>
              {isSuperAdmin && row.userId !== selfId ? (
                <DropdownMenu
                  label={`Actions for ${row.name}`}
                  trigger={(props) => <IconButton {...props} label={`Actions for ${row.name}`} icon={<MoreHorizontal size={16} />} />}
                  groups={[{ key: 'member', items: [
                    {
                      key: 'edit',
                      label: 'Edit permissions',
                      onSelect: () =>
                        setEditing({
                          userId: row.userId,
                          name: row.name,
                          grants: {
                            isSuperAdmin: row.isSuperAdmin,
                            viewHubs: row.viewHubs,
                            editHubs: row.editHubs,
                            viewScopes: row.viewScopes,
                            editScopes: row.editScopes,
                          },
                        }),
                    },
                    row.state === 'deactivated'
                      ? {
                          key: 'reactivate',
                          label: 'Restore access',
                          onSelect: () =>
                            run(() => api.account.members.reactivate.mutate({ userId: row.userId }), 'Access restored.'),
                        }
                      : {
                          key: 'deactivate',
                          label: 'End access',
                          onSelect: () =>
                            run(() => api.account.members.deactivate.mutate({ userId: row.userId }), 'Access ended.'),
                        },
                    {
                      key: 'remove',
                      label: 'Remove from account',
                      onSelect: () =>
                        run(() => api.account.members.remove.mutate({ userId: row.userId }), 'Removed.'),
                    },
                  ] }]}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={`Permissions for ${editing?.name ?? ''}`}>
        {editing ? (
          <div className="flex flex-col gap-4">
            <GrantGrid value={editing.grants} onChange={(grants) => setEditing({ ...editing, grants })} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.account.members.setGrants.mutate({ userId: editing.userId, ...editing.grants })
                    setEditing(null)
                  }, 'Permissions saved.')
                }
              >
                Save
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={inviting !== null} onClose={() => setInviting(null)} title="Create user">
        {inviting ? (
          <div className="flex flex-col gap-4">
            <Field id="invite-email" label="Email address">
              <TextInput
                id="invite-email"
                type="email"
                value={inviting.email}
                onChange={(e) => setInviting({ ...inviting, email: e.target.value })}
                placeholder="someone@example.com"
              />
            </Field>
            <GrantGrid value={inviting.grants} onChange={(grants) => setInviting({ ...inviting, grants })} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setInviting(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy || inviting.email.trim() === ''}
                onClick={() =>
                  run(async () => {
                    const { token } = await api.account.members.invite.mutate({
                      email: inviting.email.trim(),
                      ...inviting.grants,
                    })
                    setInviting(null)
                    setLink(`${window.location.origin}${invitePath(token)}`)
                  }, 'Invitation ready.')
                }
              >
                Send invitation
              </Button>
            </div>
          </div>
        ) : null}
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
    </Card>
  )
}
