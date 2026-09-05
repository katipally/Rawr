'use client'

import { Alert, Badge, Button, EmptyState, Field, IconButton, Modal, RenamePrompt, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import Link from 'next/link'
import { ACTION_ICONS } from '~/components/icons.ts'
import { objectView, propertiesPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

export type ObjectView = {
  id: string
  key: string
  nameSingular: string
  namePlural: string
  fieldCount: number
  recordCount: number
}

export const ObjectList = ({
  rows,
  workspace,
  canWrite,
}: {
  rows: ObjectView[]
  workspace: string
  canWrite: boolean
}) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<ObjectView | null>(null)
  const [removing, setRemoving] = useState<ObjectView | null>(null)

  const [singular, setSingular] = useState('')
  const [plural, setPlural] = useState('')

  const run = async (what: () => Promise<unknown>, said: string) => {
    setBusy(true)
    try {
      await what()
      toast('success', said)
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
        <div>
          <Button variant="primary" onClick={() => { setSingular(''); setPlural(''); setCreating(true) }}>
            Create an object
          </Button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="No objects of your own yet"
          description="Contacts, companies and deals are built in. An object you create sits beside them with its own fields, its own list and its own records — a project, a vendor, a piece of equipment."
        />
      ) : (
        <ul className="flex flex-col rounded-panel border border-line bg-surface">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-divider px-3 py-2 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <Link href={objectView(workspace, row.key, 'all')} className="font-medium">
                    {row.namePlural}
                  </Link>
                  <code className="text-small text-secondary">{row.key}</code>
                </p>
                <p className="text-small text-secondary tabular-nums">
                  {row.recordCount.toLocaleString()} record{row.recordCount === 1 ? '' : 's'} ·{' '}
                  <Link href={propertiesPath(row.key)}>
                    {row.fieldCount} field{row.fieldCount === 1 ? '' : 's'}
                  </Link>
                </p>
              </div>

              {canWrite ? (
                <span className="flex shrink-0 items-center gap-0.5">
                  <IconButton
                    label={`Rename ${row.namePlural}`}
                    icon={<ACTION_ICONS.rename size={16} />}
                    onClick={() => setRenaming(row)}
                  />
                  <IconButton
                    label={`Delete ${row.namePlural}`}
                    tone="destructive"
                    icon={<ACTION_ICONS.delete size={16} />}
                    onClick={() => setRemoving(row)}
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create an object"
        footer={
          <div className="flex gap-2">
            <Button
              variant="primary"
              busy={busy}
              disabled={!singular.trim() || !plural.trim()}
              onClick={() =>
                void run(
                  () => api.admin.objects.create.mutate({ nameSingular: singular, namePlural: plural }),
                  `${plural} was created. Add its fields under Properties.`,
                ).then((ok) => ok && setCreating(false))
              }
            >
              Create
            </Button>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Field id="object-singular" label="One of them is called" hint="Project, Vendor, Asset.">
            <TextInput
              id="object-singular"
              value={singular}
              onChange={(event) => {
                setSingular(event.target.value)
                // Filled as you type, and only while nobody has edited it: most
                // plurals are the singular with an s, and the ones that are not
                // are the reason this is a field rather than a rule.
                if (!plural || plural === `${singular}s`) setPlural(`${event.target.value}s`)
              }}
            />
          </Field>
          <Field id="object-plural" label="Several are called" hint="What the list is titled.">
            <TextInput id="object-plural" value={plural} onChange={(event) => setPlural(event.target.value)} />
          </Field>

          <Alert tone="info">
            It starts with one field, Name, which is what its records are called. Add the rest under
            Properties. Records of it get a list, filters, search, a timeline, associations, tasks
            and files, the same as a contact.
          </Alert>
        </div>
      </Modal>

      <RenamePrompt
        value={renaming?.namePlural ?? null}
        title={`Rename ${renaming?.namePlural ?? ''}`}
        label="What several of them are called"
        busy={busy}
        onCancel={() => setRenaming(null)}
        onRename={(namePlural) => {
          const row = renaming
          if (!row) return
          void run(
            () =>
              api.admin.objects.rename.mutate({
                id: row.id,
                // Renaming from the list changes the plural, which is what the
                // list shows. The singular follows only if it was the obvious
                // one, so "Person/People" is never quietly turned into
                // "People/People" by a rename nobody meant that way.
                nameSingular: row.nameSingular === `${row.namePlural.replace(/s$/, '')}` ? namePlural.replace(/s$/, '') : row.nameSingular,
                namePlural,
              }),
            'Renamed.',
          ).then((ok) => ok && setRenaming(null))
        }}
      />

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title={`Delete ${removing?.namePlural ?? ''}?`}
        footer={
          <div className="flex gap-2">
            <Button
              variant="destructive"
              busy={busy}
              onClick={() =>
                void run(
                  () => api.admin.objects.remove.mutate({ id: removing!.id }),
                  `${removing!.namePlural} and everything in it was deleted.`,
                ).then((ok) => ok && setRemoving(null))
              }
            >
              Delete
            </Button>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
          </div>
        }
      >
        <p>
          Its {removing?.recordCount.toLocaleString()} record
          {removing?.recordCount === 1 ? '' : 's'} and {removing?.fieldCount} field
          {removing?.fieldCount === 1 ? '' : 's'} go with it, and none of it comes back. Deleting an
          object is not a soft delete, because an object that still occupies its key and still
          appears in every lookup is most of the cost of having it with none of the use.
        </p>
      </Modal>
    </div>
  )
}
