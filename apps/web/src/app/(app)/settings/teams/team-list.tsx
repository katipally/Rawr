'use client'

import { Badge, Button, Card, Combobox, EmptyState, Field, Modal, TextArea, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { usePagedRows } from '~/components/paged.tsx'
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
  const { page, pager } = usePagedRows(teams, 'teams')

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
    <div className="flex flex-col gap-3">
      {!canWrite ? (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          You need {hub} access to change this.
        </p>
      ) : (
        <div>
          <Button variant="primary" onClick={() => setEditing({ id: null, name: '', description: '' })}>
            Create team
          </Button>
        </div>
      )}

      {teams.length === 0 ? (
        <EmptyState
          title="No teams yet"
          description="A team is a name and a list of people. Assignment rotates within it."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {page.map((team) => (
            <Card
              key={team.id}
              title={team.name}
              action={<Badge>{team.members.length}</Badge>}
            >
              <div className="flex flex-col gap-2">
                {team.description ? <p className="text-secondary">{team.description}</p> : null}
                {team.members.length === 0 ? (
                  <p className="text-secondary">Nobody is on this team yet, so nothing rotates to it.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {team.members.map((member) => (
                      <li key={member.userId} className="flex items-center gap-2">
                        <span className="min-w-0 truncate">{member.name}</span>
                        {member.isLead ? <Badge tone="accent">Lead</Badge> : null}
                      </li>
                    ))}
                  </ul>
                )}
                {canWrite ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      onClick={() =>
                        setMembers({
                          team,
                          chosen: team.members.map((member) => member.userId),
                          leads: team.members.filter((member) => member.isLead).map((member) => member.userId),
                        })
                      }
                    >
                      Edit members
                    </Button>
                    <Button
                      variant="tertiary"
                      onClick={() => setEditing({ id: team.id, name: team.name, description: team.description ?? '' })}
                    >
                      Rename
                    </Button>
                    <Button variant="tertiary" onClick={() => setDeleting(team)}>
                      Delete
                    </Button>
                  </div>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      {pager}

      {editing ? (
        <Modal
          open
          size="sm"
          title={editing.id ? `Rename ${editing.name}` : 'Create team'}
          onClose={() => setEditing(null)}
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void run(
                () =>
                  api.admin.teams.save.mutate({
                    id: editing.id,
                    name: editing.name.trim(),
                    description: editing.description.trim() || null,
                  }),
                editing.id ? 'Saved.' : `${editing.name} is ready. Add people to it next.`,
              ).then((ok) => ok && setEditing(null))
            }}
          >
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
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" type="button" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" busy={busy} disabled={editing.name.trim() === ''}>
                Save
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {members ? (
        <Modal open title={`Who is on ${members.team.name}`} onClose={() => setMembers(null)}>
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

            <div className="flex justify-end gap-2">
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
            </div>
          </div>
        </Modal>
      ) : null}

      {deleting ? (
        <Modal open size="sm" title={`Delete ${deleting.name}`} onClose={() => setDeleting(null)}>
          <div className="flex flex-col gap-3">
            <p>
              The team goes; nobody loses their seat. Anything set to round-robin within it falls back to
              rotating through the whole account.
            </p>
            <div className="flex justify-end gap-2">
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
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
