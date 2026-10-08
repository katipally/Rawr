'use client'

import { Alert, Button, DataTable, DropdownMenu, EmptyState, Field, Modal, RenamePrompt, TextInput, useToast, type Column } from '@rawr/ui'
import { ChevronDown, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import Link from 'next/link'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { objectView, propertiesPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useFormat } from '~/components/zone.tsx'

export type ObjectView = {
  id: string
  key: string
  nameSingular: string
  namePlural: string
  fieldCount: number
  recordCount: number
  custom: boolean
}

export const ObjectList = ({
  rows,
  account,
  canWrite,
}: {
  rows: ObjectView[]
  account: string
  canWrite: boolean
}) => {
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<ObjectView | null>(null)
  const [removing, setRemoving] = useState<ObjectView | null>(null)

  const [singular, setSingular] = useState('')
  const [plural, setPlural] = useState('')
  /** Objects created here, held until router.refresh brings them back: the round
   *  trip is long enough that a new object looked like it had not been created. */
  const [created, setCreated] = useState<ObjectView[]>([])
  const all = [...rows, ...created.filter((object) => !rows.some((row) => row.id === object.id))]
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? all.filter((row) => row.namePlural.toLowerCase().includes(needle) || row.nameSingular.toLowerCase().includes(needle) || row.key.includes(needle))
    : all
  const { page, pager } = usePagedRows(shown, 'objects')

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

  const columns: Column<ObjectView>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 360,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <Link href={objectView(account, row.key, 'all')} title={row.namePlural} className="min-w-0 flex-1 truncate font-semibold">
            {row.namePlural}
          </Link>
          {canWrite ? (
            <RowActions>
              <DropdownMenu
                label={`Actions for ${row.namePlural}`}
                align="start"
                trigger={(props) => (
                  <button {...props} type="button" className={rowPill}>
                    Actions
                    <ChevronDown aria-hidden="true" className="size-3" />
                  </button>
                )}
                groups={[
                  {
                    key: 'object',
                    items: [
                      { key: 'properties', label: 'Manage properties', href: propertiesPath(row.key) },
                      ...(row.custom ? [{ key: 'rename', label: 'Rename', onSelect: () => setRenaming(row) }] : []),
                    ],
                  },
                  ...(row.custom
                    ? [{ key: 'danger', items: [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => setRemoving(row) }] }]
                    : []),
                ]}
              />
            </RowActions>
          ) : null}
        </span>
      ),
    },
    { key: 'key', header: 'Internal name', width: 220, render: (row) => <code title={row.key} className="block truncate text-secondary">{row.key}</code> },
    { key: 'records', header: 'Records', width: 140, align: 'right', render: (row) => <span className="font-light tabular-nums">{fmt.number(row.recordCount)}</span> },
    {
      key: 'fields',
      header: 'Properties',
      width: 140,
      align: 'right',
      render: (row) => (
        <Link href={propertiesPath(row.key)} className="tabular-nums">
          {fmt.number(row.fieldCount)}
        </Link>
      ),
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative w-full min-w-0 @lg:w-[16rem]">
          <span className="sr-only">Search objects</span>
          <input
            type="search"
            value={query}
            placeholder="Search objects"
            onChange={(event) => setQuery(event.target.value)}
            className="h-[2.5rem] w-full rounded-pill border border-line-strong bg-surface py-2 pr-10 pl-4 font-light placeholder:text-muted"
          />
          <Search aria-hidden="true" className="absolute top-1/2 right-4 size-4 -translate-y-1/2" />
        </label>
        {canWrite ? (
          <Button onClick={() => { setSingular(''); setPlural(''); setCreating(true) }}>
            Create object
          </Button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title={all.length === 0 ? 'No objects of your own yet' : 'No object matches'}
          description={
            all.length === 0
              ? 'Contacts, companies and deals are built in. An object you create sits beside them with its own fields, its own list and its own records: a project, a vendor, a piece of equipment.'
              : 'Try another name.'
          }
        />
      ) : (
        <DataTable columns={columns} rows={page} rowKey={(row) => row.id} caption="Custom objects" storageKey="settings.objects" />
      )}

      {pager}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create object"
        dirty={singular !== '' || plural !== ''}
        onSubmit={() =>
          void run(async () => {
            const made = await api.admin.objects.create.mutate({
              nameSingular: singular,
              namePlural: plural,
            })
            setCreated((current) => [
              ...current,
              {
                id: made.id,
                key: made.key,
                nameSingular: singular.trim(),
                namePlural: plural.trim(),
                // Its naming field is created with it.
                fieldCount: 1,
                recordCount: 0,
                custom: true,
              },
            ])
          }, `${plural} was created. Add its fields under Properties.`).then((ok) => ok && setCreating(false))
        }
        footer={
          <>
            <Button variant="tertiary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!singular.trim() || !plural.trim()}>
              Create
            </Button>
          </>
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
          <>
            <Button variant="tertiary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
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
          </>
        }
      >
        <p>
          Its {fmt.number(removing?.recordCount)} record
          {removing?.recordCount === 1 ? '' : 's'} and {removing?.fieldCount} field
          {removing?.fieldCount === 1 ? '' : 's'} go with it, and none of it comes back. Deleting an
          object is not a soft delete, because an object that still occupies its key and still
          appears in every lookup is most of the cost of having it with none of the use.
        </p>
      </Modal>
    </div>
  )
}
