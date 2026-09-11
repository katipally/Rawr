'use client'

import { Avatar, Badge, Button, Card, Checkbox, DropdownMenu, EmptyState, Field, IconButton, Modal, Select, TextInput, useToast } from '@rawr/ui'
import { Copy, MoreHorizontal } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { invitePath } from '~/lib/links.ts'
import {
  CRITICAL_ACTIONS,
  CRITICAL_HINT,
  CRITICAL_LABEL,
  HUBS,
  HUBS_WITHOUT_SCREENS,
  HUBS_WITH_RECORDS,
  HUB_HINT,
  SCOPES,
  SCOPE_LABEL,
  type CriticalAction,
  type Hub,
  type Scope,
} from '~/lib/hubs.ts'
import { formatDate } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'

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

/** The suggested sets, handed down from the data access layer so the client keeps
 *  no second copy of them. */
export type RoleTemplate = { key: string; label: string; description: string; grants: Grants }

type Props = {
  rows: MemberListRow[]
  invitations: InvitationRow[]
  templates: RoleTemplate[]
  selfId: string
  isSuperAdmin: boolean
}

type Grants = {
  isSuperAdmin: boolean
  viewHubs: Hub[]
  editHubs: Hub[]
  viewScopes: HubScopes
  editScopes: HubScopes
  criticalGrants: CriticalAction[]
}
type Level = 'none' | 'view' | 'edit'
type Tab = 'active' | 'pending' | 'deactivated'

const EMPTY: Grants = { isSuperAdmin: false, viewHubs: [], editHubs: [], viewScopes: {}, editScopes: {}, criticalGrants: [] }

const grantsOf = (row: MemberListRow | InvitationRow): Grants => ({
  isSuperAdmin: row.isSuperAdmin,
  viewHubs: row.viewHubs,
  editHubs: row.editHubs,
  viewScopes: row.viewScopes,
  editScopes: row.editScopes,
  criticalGrants: row.criticalGrants,
})

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
  ...grants,
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
  if (held.length === 0 && grants.criticalGrants.length === 0) return 'No access'
  const parts = held.map((hub) => {
    const level = levelOf(grants, hub) === 'edit' ? hub : `${hub} (view)`
    const scope = scopeOf(grants, hub)
    return scope === 'everything' ? level : `${level} · ${SCOPE_LABEL[scope].toLowerCase()}`
  })
  const critical = CRITICAL_ACTIONS.filter((action) => grants.criticalGrants.includes(action))
  if (critical.length > 0) parts.push(critical.map((action) => CRITICAL_LABEL[action].toLowerCase()).join(', '))
  return parts.join(' · ')
}

const withCritical = (grants: Grants, action: CriticalAction, on: boolean): Grants => ({
  ...grants,
  criticalGrants: on
    ? CRITICAL_ACTIONS.filter((key) => key === action || grants.criticalGrants.includes(key))
    : grants.criticalGrants.filter((key) => key !== action),
})

/** The grid itself: one row per hub, three exclusive levels. Super admin sits
 *  above it and greys it out, because holding everything is not six choices. */
const GrantGrid = ({
  value,
  onChange,
  templates,
  copyFrom,
}: {
  value: Grants
  onChange: (next: Grants) => void
  templates: RoleTemplate[]
  copyFrom: MemberListRow[]
}) => (
  <div className="flex flex-col gap-3">
    {/* HubSpot's "Choose how to set access": start from a suggested set or from
        somebody who already has the right one, then adjust. Neither commits
        anything, so a wrong pick is a second click rather than a mistake. */}
    <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">start from an existing set of permissions</legend>
      <span className="text-small text-secondary">Start from</span>
      {templates.map((template) => (
        <Button key={template.key} type="button" variant="secondary" title={template.description} onClick={() => onChange(template.grants)}>
          {template.label}
        </Button>
      ))}
      {copyFrom.length > 0 ? (
        <Select
          aria-label="Copy permissions from another member"
          value=""
          onChange={(e) => {
            const source = copyFrom.find((row) => row.userId === e.target.value)
            if (source) onChange(grantsOf(source))
          }}
        >
          <option value="">Copy from another member</option>
          {copyFrom.map((row) => (
            <option key={row.userId} value={row.userId}>
              {row.name}
            </option>
          ))}
        </Select>
      ) : null}
    </fieldset>
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
              <p className="text-body">
                <span className="capitalize">{hub}</span>
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
    {/* HubSpot's Critical column, as its own group for the same reason it is one
        there: each of these is irreversible or reaches the whole database, and
        none of them falls out of holding a hub. */}
    <div className="flex flex-col gap-1 rounded-hs border border-line">
      <div className="grid grid-cols-[1fr_auto] gap-2 border-b border-line px-3 py-2 text-small text-secondary">
        <span>Critical</span>
        <span>Off · On</span>
      </div>
      {CRITICAL_ACTIONS.map((action) => {
        const on = value.isSuperAdmin || value.criticalGrants.includes(action)
        return (
          <div key={action} className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2">
            <div>
              <p className="text-body">{CRITICAL_LABEL[action]}</p>
              <p className="text-small text-secondary">{CRITICAL_HINT[action]}</p>
            </div>
            <fieldset className="flex gap-1 border-0 p-0">
              <legend className="sr-only">may {CRITICAL_LABEL[action].toLowerCase()}</legend>
              {([false, true] as const).map((option) => (
                <Button
                  key={String(option)}
                  type="button"
                  variant={on === option ? 'primary' : 'secondary'}
                  disabled={value.isSuperAdmin}
                  onClick={() => onChange(withCritical(value, action, option))}
                >
                  {option ? 'On' : 'Off'}
                </Button>
              ))}
            </fieldset>
          </div>
        )
      })}
    </div>
  </div>
)

export const MemberList = ({ rows, invitations, templates, selfId, isSuperAdmin }: Props) => {
  const zone = useZone()
  const toast = useToast()
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('active')
  const [editing, setEditing] = useState<{ userId: string; name: string; grants: Grants } | null>(null)
  const [inviting, setInviting] = useState<{ email: string; grants: Grants } | null>(null)
  const [copying, setCopying] = useState<{ toUserId: string; name: string; fromUserId: string } | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [ending, setEnding] = useState<{ userId: string; name: string; kind: 'deactivate' | 'remove' } | null>(null)
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
  const shown = members.filter((row) =>
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
                ? `Active (${members.filter((r) => r.state === 'active').length})`
                : key === 'pending'
                  ? `Pending (${invitations.length})`
                  : `Deactivated (${members.filter((r) => r.state === 'deactivated').length})`}
            </Button>
          ))}
        </div>
        {isSuperAdmin ? (
          <Button onClick={() => setInviting({ email: '', grants: EMPTY })}>Create member</Button>
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
                    {formatDate(row.expiresAt, zone)}
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
                        setEditing({ userId: row.userId, name: row.name, grants: grantsOf(row) }),
                    },
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
                      : {
                          key: 'deactivate',
                          label: 'End access',
                          onSelect: () => setEnding({ userId: row.userId, name: row.name, kind: 'deactivate' }),
                        },
                    {
                      key: 'copy',
                      label: 'Copy permissions from...',
                      onSelect: () => setCopying({ toUserId: row.userId, name: row.name, fromUserId: '' }),
                    },
                    {
                      key: 'remove',
                      label: 'Remove from account',
                      onSelect: () => setEnding({ userId: row.userId, name: row.name, kind: 'remove' }),
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
            <GrantGrid
              value={editing.grants}
              onChange={(grants) => setEditing({ ...editing, grants })}
              templates={templates}
              copyFrom={[]}
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  run(
                    async () => {
                      await api.account.members.setGrants.mutate({ userId: editing.userId, ...editing.grants })
                      setEditing(null)
                    },
                    'Permissions saved.',
                    { userId: editing.userId, patch: editing.grants },
                  )
                }
              >
                Save
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={inviting !== null} onClose={() => setInviting(null)} title="Create member">
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
            <GrantGrid
              value={inviting.grants}
              onChange={(grants) => setInviting({ ...inviting, grants })}
              templates={templates}
              copyFrom={rows}
            />
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

      <Modal open={copying !== null} onClose={() => setCopying(null)} title={`Copy permissions to ${copying?.name ?? ''}`}>
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
            <div className="flex justify-end gap-2">
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
            </div>
          </div>
        ) : null}
      </Modal>

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
                void run(() => api.account.members.deactivate.mutate({ userId: target.userId }), 'Access ended.', {
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
          <p>
            They are signed out and cannot get back in. Their records, notes and emails stay where
            they are, and restoring access puts back exactly what they held.
          </p>
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
    </Card>
  )
}
