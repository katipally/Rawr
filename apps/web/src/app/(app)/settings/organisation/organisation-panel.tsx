'use client'

import { Badge, Button, Card, Field, IconButton, Modal, Switch, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

type Organisation = {
  id: string
  name: string
  slug: string
  hostedDomain: string
  autoJoinHostedDomain: boolean
  seatLimit: number | null
  seatsUsed: number
}

type Workspace = { id: string; name: string; slug: string; members: number; createdAt: string }

/** A slug appears in every address, so it is offered rather than derived silently:
 *  somebody renaming "EMEA" to "Europe" should not have every saved link break. */
const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 40)

export const OrganisationPanel = ({
  organisation,
  workspaces,
  currentWorkspaceId,
}: {
  organisation: Organisation
  workspaces: Workspace[]
  currentWorkspaceId: string
}) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState(organisation.name)
  const [seatLimit, setSeatLimit] = useState(organisation.seatLimit === null ? '' : String(organisation.seatLimit))
  const [autoJoin, setAutoJoin] = useState(organisation.autoJoinHostedDomain)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: '', slug: '', touched: false })
  const [renaming, setRenaming] = useState<Workspace | null>(null)

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

  const seatsLeft = organisation.seatLimit === null ? null : organisation.seatLimit - organisation.seatsUsed

  return (
    <div className="flex flex-col gap-4">
      <Card title="Details">
        <div className="flex flex-col gap-3">
          <Field label="Name" id="org-name">
            <TextInput id="org-name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field
            label="Google domain"
            id="org-domain"
            hint="Set when the organisation was created. Changing it would orphan every account on the old one."
          >
            <TextInput id="org-domain" value={organisation.hostedDomain} readOnly disabled />
          </Field>
          <Switch
            label={`Anyone with a verified ${organisation.hostedDomain} account can join`}
            hint="They land as a viewer in every workspace. Off makes this organisation invitation-only."
            checked={autoJoin}
            onChange={(event) => setAutoJoin(event.target.checked)}
          />
          <Field
            label="Seats"
            id="org-seats"
            hint={
              organisation.seatLimit === null
                ? `${organisation.seatsUsed} in use. Leave empty for no limit.`
                : `${organisation.seatsUsed} of ${organisation.seatLimit} in use.`
            }
          >
            <TextInput
              id="org-seats"
              inputMode="numeric"
              value={seatLimit}
              placeholder="No limit"
              onChange={(event) => setSeatLimit(event.target.value.replaceAll(/[^0-9]/g, ''))}
            />
          </Field>
          {seatsLeft !== null && seatsLeft <= 0 ? (
            <p className="text-error">
              Every seat is taken. Deactivate somebody, or raise the limit, before inviting anybody else.
            </p>
          ) : null}
          <div>
            <Button
              variant="primary"
              busy={busy}
              disabled={
                name.trim() === '' ||
                (name === organisation.name &&
                  autoJoin === organisation.autoJoinHostedDomain &&
                  seatLimit === (organisation.seatLimit === null ? '' : String(organisation.seatLimit)))
              }
              onClick={() =>
                void run(
                  () =>
                    api.org.save.mutate({
                      name: name.trim(),
                      autoJoinHostedDomain: autoJoin,
                      seatLimit: seatLimit === '' ? null : Number(seatLimit),
                    }),
                  'Saved.',
                )
              }
            >
              Save
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title="Workspaces"
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create workspace
          </Button>
        }
        flush
      >
        <ul className="divide-y divide-divider">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{workspace.name}</span>
                  {workspace.id === currentWorkspaceId ? <Badge tone="accent">You are here</Badge> : null}
                </span>
                <span className="truncate text-small text-secondary">
                  /{workspace.slug} · {workspace.members} {workspace.members === 1 ? 'member' : 'members'} ·
                  created {new Date(workspace.createdAt).toLocaleDateString()}
                </span>
              </span>
              <IconButton
                label={`Rename ${workspace.name}`}
                icon={<ACTION_ICONS.rename size={16} />}
                onClick={() => setRenaming(workspace)}
              />
            </li>
          ))}
        </ul>
      </Card>

      {creating ? (
        <Modal open title="Create a workspace" onClose={() => setCreating(false)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void run(
                () => api.org.workspaces.create.mutate({ name: draft.name.trim(), slug: draft.slug }),
                `${draft.name} is ready, with the pipelines, properties and views every workspace starts with.`,
              ).then((ok) => {
                if (ok) {
                  setCreating(false)
                  setDraft({ name: '', slug: '', touched: false })
                }
              })
            }}
          >
            <p className="text-secondary">
              A new workspace starts with its own contacts, companies, deals, pipelines and properties.
              Nothing is shared with the others except the people who may open it.
            </p>
            <Field label="Name" id="workspace-name" required>
              <TextInput
                id="workspace-name"
                required
                autoFocus
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                    slug: current.touched ? current.slug : slugify(event.target.value),
                  }))
                }
              />
            </Field>
            <Field label="Address" id="workspace-slug" hint="It appears in every link to this workspace.">
              <TextInput
                id="workspace-slug"
                required
                value={draft.slug}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, slug: slugify(event.target.value), touched: true }))
                }
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" type="button" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" busy={busy} disabled={draft.name.trim() === '' || draft.slug === ''}>
                Create
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {renaming ? (
        <Modal open size="sm" title={`Rename ${renaming.name}`} onClose={() => setRenaming(null)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              const next = new FormData(event.currentTarget).get('name')
              void run(
                () => api.org.workspaces.rename.mutate({ workspaceId: renaming.id, name: String(next) }),
                'Renamed.',
              ).then((ok) => ok && setRenaming(null))
            }}
          >
            <Field label="Name" id="rename-workspace" required>
              <TextInput id="rename-workspace" name="name" required autoFocus defaultValue={renaming.name} />
            </Field>
            <p className="text-secondary">
              The address stays /{renaming.slug}, so nothing anybody has linked to breaks.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" type="button" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" busy={busy}>
                Rename
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  )
}
