'use client'

import { Button, Combobox, DataTable, DropdownMenu, EmptyState, Field, Modal, TextArea, TextInput, useToast, type Column } from '@rawr/ui'
import { ChevronDown, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

type Person = { userId: string; name: string; email: string }
type Team = {
  id: string
  name: string
  description: string | null
  members: { userId: string; name: string; email: string; isLead: boolean }[]
}

export const TeamList = ({
  teams,
  people,
  canWrite,
  hub,
}: {
  teams: Team[]
  people: Person[]
  canWrite: boolean
  hub: string
}) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ id: string | null; name: string; description: string } | null>(null)
  const [members, setMembers] = useState<{ team: Team; chosen: string[]; leads: string[] } | null>(null)
  const [deleting, setDeleting] = useState<Team | null>(null)
  const [needle, setNeedle] = useState('')
  const wanted = needle.trim().toLowerCase()
  // A team is found by its own name or by anybody on it, the question usually being "which team is Sam on".
  const shown = wanted
    ? teams.filter((team) => team.name.toLowerCase().includes(wanted) || team.members.some((member) => member.name.toLowerCase().includes(wanted)))
    : teams
  const { page, pager } = usePagedRows(shown, 'teams')

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

  const names = (members: Team['members']) => members.map((member) => member.name).join(', ')

  const columns: Column<Team>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 360,
      render: (team) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-1 flex-col">
            <span title={team.name} className="truncate font-semibold">{team.name}</span>
            {team.description ? <span title={team.description} className="truncate text-small text-secondary">{team.description}</span> : null}
          </span>
          {canWrite ? (
            <RowActions>
              <DropdownMenu
                label={`Actions for ${team.name}`}
                align="start"
                trigger={(props) => (
                  <button {...props} type="button" className={rowPill}>
                    Actions
                    <ChevronDown aria-hidden="true" className="size-3" />
                  </button>
                )}
                groups={[{ key: 'team', items: [
                  {
                    key: 'members',
                    label: 'Edit members',
                    onSelect: () =>
                      setMembers({
                        team,
                        chosen: team.members.map((member) => member.userId),
                        leads: team.members.filter((member) => member.isLead).map((member) => member.userId),
                      }),
                  },
                  { key: 'rename', label: 'Rename', onSelect: () => setEditing({ id: team.id, name: team.name, description: team.description ?? '' }) },
                  { key: 'delete', label: 'Delete', destructive: true, onSelect: () => setDeleting(team) },
                ] }]}
              />
            </RowActions>
          ) : null}
        </span>
      ),
    },
    { key: 'count', header: 'Users', width: 100, align: 'right', render: (team) => (team.members.length === 0 ? EMPTY_VALUE : team.members.length) },
    { key: 'people', header: 'Members', width: 360, render: (team) => <span title={names(team.members)} className="block truncate">{names(team.members) || EMPTY_VALUE}</span> },
    { key: 'leads', header: 'Leads', width: 220, render: (team) => {
        const leads = names(team.members.filter((member) => member.isLead))
        return <span title={leads} className="block truncate">{leads || EMPTY_VALUE}</span>
      }, },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p>Use teams to group people. Round robin on a form or booking page picks from the people chosen there. Teams do not route anything yet.</p>
      <div className="flex min-w-0 flex-col gap-3 rounded-panel border border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="relative w-full min-w-0 @lg:w-56">
            <span className="sr-only">Search teams</span>
            <input
              type="search"
              value={needle}
              placeholder="Search"
              onChange={(event) => setNeedle(event.target.value)}
              className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-9 pl-4 placeholder:text-muted"
            />
            <Search aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
          </label>
          {canWrite ? (
            <Button onClick={() => setEditing({ id: null, name: '', description: '' })}>Create team</Button>
          ) : (
            <p className="text-secondary">You need {hub} access to change teams.</p>
          )}
        </div>

        {shown.length === 0 ? (
          <EmptyState
            title={wanted ? 'No team matches' : 'No teams yet'}
            description={wanted ? 'No team, and nobody on one, has that name.' : 'A team is a name and a list of people.'}
          />
        ) : (
          <DataTable columns={columns} rows={page} rowKey={(team) => team.id} caption="Teams" storageKey="settings.teams" />
        )}
      </div>

      {pager}

      {editing ? (
        <Modal
          open
          size="sm"
          title={editing.id ? `Rename ${teams.find((team) => team.id === editing.id)?.name ?? 'team'}` : 'Create team'}
          onClose={() => setEditing(null)}
          dirty={!editing.id && (editing.name !== '' || editing.description !== '')}
          onSubmit={() =>
            void run(
              () =>
                api.admin.teams.save.mutate({
                  id: editing.id,
                  name: editing.name.trim(),
                  description: editing.description.trim() || null,
                }),
              editing.id ? 'Saved.' : `${editing.name} is ready. Add people to it next.`,
            ).then((ok) => {
              if (!ok) return
              setEditing(null)
              if (!editing.id) setNeedle('')
            })
          }
          footer={
            <>
              <Button variant="tertiary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" busy={busy} disabled={editing.name.trim() === ''}>
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Field label="Name" id="team-name" required>
              <TextInput
                id="team-name"
                required
                autoFocus
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </Field>
            <Field label="What it is for" id="team-description" hint="Optional.">
              <TextArea
                id="team-description"
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
            </Field>
          </div>
        </Modal>
      ) : null}

      {members ? (
        <Modal
          open
          title={`Who is on ${members.team.name}`}
          onClose={() => setMembers(null)}
          footer={
            <>
              <Button variant="tertiary" onClick={() => setMembers(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                busy={busy}
                onClick={() =>
                  void run(
                    () =>
                      api.admin.teams.setMembers.mutate({
                        teamId: members.team.id,
                        members: members.chosen.map((userId) => ({
                          userId,
                          isLead: members.leads.includes(userId),
                        })),
                      }),
                    `${members.team.name} now has ${members.chosen.length} ${members.chosen.length === 1 ? 'member' : 'members'}.`,
                  ).then((ok) => ok && setMembers(null))
                }
              >
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Combobox
              label="Members"
              multiple
              value={members.chosen}
              onChange={(chosen) =>
                setMembers({ ...members, chosen, leads: members.leads.filter((id) => chosen.includes(id)) })
              }
              hint="Everybody seated in this account can be on a team."
              options={people.map((person) => ({
                value: person.userId,
                label: person.name,
                hint: person.email,
              }))}
            />

            {members.chosen.length > 0 ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="pb-1 font-medium">Leads</legend>
                <p className="pb-1 text-secondary">
                  A lead is a member the team is headed by. Leaving this empty is fine; nothing rotates
                  differently because of it.
                </p>
                {members.chosen.map((userId) => {
                  const person = people.find((entry) => entry.userId === userId)
                  return (
                    <label key={userId} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={members.leads.includes(userId)}
                        onChange={(event) =>
                          setMembers({
                            ...members,
                            leads: event.target.checked
                              ? [...members.leads, userId]
                              : members.leads.filter((id) => id !== userId),
                          })
                        }
                      />
                      <span className="min-w-0 truncate">{person?.name ?? userId}</span>
                    </label>
                  )
                })}
              </fieldset>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          open
          size="sm"
          title={`Delete ${deleting.name}`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="tertiary" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                busy={busy}
                onClick={() =>
                  void run(() => api.admin.teams.delete.mutate({ id: deleting.id }), `${deleting.name} is gone.`).then(
                    (ok) => ok && setDeleting(null),
                  )
                }
              >
                Delete
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p>The team goes; nobody loses their seat.</p>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
