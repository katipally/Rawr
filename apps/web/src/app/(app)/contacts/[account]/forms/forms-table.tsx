'use client'

import type { Format } from '~/lib/format.ts'
import { Button, DataTable, DropdownMenu, EmptyState, Field, Modal, Select, TextInput, useToast, type Column } from '@rawr/ui'
import { ChevronDown } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { usePagedRows } from '~/components/paged.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useUrlParam } from '~/lib/url-params.ts'
import { formPerformancePath, formsPath, submissionsPath } from '~/lib/links.ts'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { RowActions, StatusDot, rowPill } from '~/components/row-actions.tsx'
import { EmbedSnippet } from './embed-snippet.tsx'
import { useFormat } from '~/components/zone.tsx'

export type FormRow = {
  id: string
  name: string
  slug: string
  isActive: boolean
  folderId: string | null
  fieldCount: number
  submissions: number
  quarantined: number
  spam: number
  pageViews: number
  appearsOn: number
  /** ISO, or null before the first submission. */
  lastSubmissionAt: string | null
}

export type FolderRow = { id: string; name: string; forms: number }

/** Which folder the list is showing. Kept in the URL rather than in state, so a
 *  folder somebody is working out of survives a reload and pastes as a link. */
const UNFILED = 'none'

/** A rate somebody has to act on, not a rate somebody has to admire. One decimal
 *  is enough to tell 2.1% from 2.8%; a second is noise from a counter. */
const rate = (fmt: Format, part: number, whole: number): string =>
  whole === 0 ? EMPTY_VALUE : fmt.percent(part / whole, 1)

/** HubSpot's forms list: a table with the form's status under its name, and the
 *  numbers that matter in the columns. The embed code is one click away on each
 *  row rather than printed under every form. */
export const FormsTable = ({
  account,
  baseUrl,
  siteKey,
  rows,
  folders,
  canEdit,
}: {
  account: string
  baseUrl: string
  siteKey: string | null
  rows: FormRow[]
  folders: FolderRow[]
  canEdit: boolean
}) => {
  const fmt = useFormat()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const toast = useToast()

  const [embedId, setEmbedId] = useUrlParam('embed')
  const embedding = rows.find((row) => row.id === embedId) ?? null
  const setEmbedding = (row: FormRow | null) => setEmbedId(row?.id ?? null)
  const [moveId, setMoveId] = useUrlParam('move')
  const moving = rows.find((row) => row.id === moveId) ?? null
  const setMoving = (row: FormRow | null) => setMoveId(row?.id ?? null)
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null)
  const [removingFolder, setRemovingFolder] = useState<FolderRow | null>(null)
  const [busy, setBusy] = useState(false)

  const folder = params.get('folder')
  const shown =
    folder === null
      ? rows
      : rows.filter((row) => (folder === UNFILED ? row.folderId === null : row.folderId === folder))
  const { page, pager } = usePagedRows(shown, 'forms')

  const go = (next: string | null) => {
    const query = new URLSearchParams(params)
    if (next === null) query.delete('folder')
    else query.set('folder', next)
    // A folder change starts the list again: page four of one folder is not a
    // page of another.
    query.delete('skip')
    const search = query.toString()
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false })
  }

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<FormRow>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 420,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-col">
            <Link href={formPerformancePath(account, row.id)} title={row.name} className="truncate font-semibold text-link hover:underline">
              {row.name}
            </Link>
            <span className="flex min-w-0 text-small">
              <StatusDot tone={row.isActive ? 'live' : 'off'}>{row.isActive ? 'Published' : 'Turned off'} | Form</StatusDot>
            </span>
          </span>
          <RowActions>
            <Link href={formsPath(account, row.id)} className={rowPill}>
              Edit
            </Link>
            {canEdit ? (
              <button
                type="button"
                className={rowPill}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const id = await api.forms.clone.mutate({ id: row.id })
                    router.push(formsPath(account, id))
                  })
                }
              >
                Clone
              </button>
            ) : null}
            <DropdownMenu
              label={`Actions for ${row.name}`}
              align="start"
              groups={[
                {
                  key: 'actions',
                  items: [
                    { key: 'embed', label: 'Embed code', onSelect: () => setEmbedding(row) },
                    ...(canEdit ? [{ key: 'move', label: 'Move to folder', onSelect: () => setMoving(row) }] : []),
                  ],
                },
              ]}
              trigger={(props) => (
                <button {...props} type="button" className={rowPill}>
                  Actions
                  <ChevronDown aria-hidden="true" className="size-3" />
                </button>
              )}
            />
          </RowActions>
        </span>
      ),
    },
    {
      key: 'views',
      header: 'Page views',
      width: 130,
      align: 'right',
      render: (row) => (row.pageViews === 0 ? EMPTY_VALUE : fmt.number(row.pageViews)),
    },
    {
      key: 'rate',
      header: 'Submissions / page view',
      width: 190,
      align: 'right',
      render: (row) => rate(fmt, row.submissions, row.pageViews),
    },
    {
      key: 'spam',
      header: 'Spam submissions',
      width: 160,
      align: 'right',
      render: (row) => fmt.number(row.spam),
    },
    {
      key: 'submissions',
      header: 'Form submissions',
      width: 160,
      align: 'right',
      render: (row) => (
        <Link href={submissionsPath(account, { state: 'clean', form: row.id })} className="font-semibold text-link hover:underline">
          {fmt.number(row.submissions)}
        </Link>
      ),
    },
    {
      key: 'appears',
      header: 'Appears on',
      width: 130,
      align: 'right',
      render: (row) =>
        row.appearsOn === 0 ? EMPTY_VALUE : `${row.appearsOn} ${row.appearsOn === 1 ? 'page' : 'pages'}`,
    },
    {
      key: 'held',
      header: 'Held for review',
      width: 150,
      align: 'right',
      render: (row) =>
        row.quarantined > 0 ? (
          <Link href={submissionsPath(account, { state: 'quarantined', form: row.id })} className="font-semibold text-link hover:underline">
            {fmt.number(row.quarantined)}
          </Link>
        ) : (
          '0'
        ),
    },
    {
      key: 'last',
      header: 'Last submission',
      width: 180,
      render: (row) =>
        row.lastSubmissionAt
          ? fmt.date(row.lastSubmissionAt)
          : EMPTY_VALUE,
    },
  ]

  return (
    <>
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-1.5">
        <Chip current={folder === null} onClick={() => go(null)}>
          All forms ({rows.length})
        </Chip>
        {folders.map((entry) => (
          <Chip key={entry.id} current={folder === entry.id} onClick={() => go(entry.id)}>
            {entry.name} ({entry.forms})
          </Chip>
        ))}
        <Chip current={folder === UNFILED} onClick={() => go(UNFILED)}>
          Unfiled ({rows.filter((row) => row.folderId === null).length})
        </Chip>
        {canEdit ? (
          <>
            <Chip current={false} onClick={() => setNaming({ id: null, name: '' })}>
              + New folder
            </Chip>
            {folder !== null && folder !== UNFILED ? (
              <>
                <Chip
                  current={false}
                  onClick={() => {
                    const current = folders.find((entry) => entry.id === folder)
                    if (current) setNaming({ id: current.id, name: current.name })
                  }}
                >
                  Rename
                </Chip>
                <Chip
                  current={false}
                  onClick={() => {
                    const current = folders.find((entry) => entry.id === folder)
                    if (current) setRemovingFolder(current)
                  }}
                >
                  Delete folder
                </Chip>
              </>
            ) : null}
          </>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={page}
        rowKey={(row) => row.id}
        caption="Forms in this account"
        empty={
          folder === null ? (
            <EmptyState title="No forms yet" description="Create a form to start collecting submissions." />
          ) : (
            <EmptyState title="No forms here" description="Nothing is filed under this chip yet." />
          )
        }
      />
      {pager}

      <Modal open={embedding !== null} title={embedding ? `Embed “${embedding.name}”` : 'Embed'} onClose={() => setEmbedding(null)}>
        {embedding ? <EmbedSnippet baseUrl={baseUrl} siteKey={siteKey} formId={embedding.id} account={account} slug={embedding.slug} /> : null}
      </Modal>

      <Modal
        open={moving !== null}
        title={moving ? `Move “${moving.name}”` : 'Move'}
        onClose={() => setMoving(null)}
      >
        <Field id="move-folder" label="Folder" hint="A folder is where a form is filed. It changes nothing about how the form works.">
          <Select
            id="move-folder"
            value={moving?.folderId ?? ''}
            disabled={busy}
            onChange={(event) => {
              const target = moving
              if (!target) return
              const folderId = event.target.value || null
              // Closed after the refresh starts: dropping ?move first lets that
              // address change land last and shows the list as it was.
              void run(() => api.forms.moveToFolder.mutate({ formId: target.id, folderId })).then(() => setMoving(null))
            }}
          >
            <option value="">No folder</option>
            {folders.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>

      <Modal
        open={removingFolder !== null}
        size="sm"
        title={removingFolder ? `Delete “${removingFolder.name}”?` : 'Delete folder'}
        onClose={() => setRemovingFolder(null)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setRemovingFolder(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() => {
                const target = removingFolder
                if (!target) return
                setRemovingFolder(null)
                void run(async () => {
                  await api.forms.removeFolder.mutate({ id: target.id })
                  go(null)
                })
              }}
            >
              Delete folder
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>
            {removingFolder && removingFolder.forms > 0
              ? `Deleting a folder empties it: the ${fmt.number(removingFolder.forms)} ${removingFolder.forms === 1 ? 'form' : 'forms'} filed here move to Unfiled and keep collecting. A filing decision never takes a live capture path down with it.`
              : 'The folder is empty, so nothing else changes.'}
          </p>
        </div>
      </Modal>

      <Modal
        open={naming !== null}
        title={naming?.id ? 'Rename folder' : 'New folder'}
        onClose={() => setNaming(null)}
        dirty={naming !== null && !naming.id && naming.name !== ''}
        onSubmit={() => {
          const draft = naming
          if (!draft) return
          setNaming(null)
          void run(() =>
            api.forms.saveFolder.mutate({ id: draft.id, name: draft.name }),
          )
        }}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setNaming(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !naming?.name.trim()}>
              Save
            </Button>
          </>
        }
      >
        <Field id="folder-name" label="Name">
          <TextInput
            id="folder-name"
            value={naming?.name ?? ''}
            disabled={busy}
            onChange={(event) =>
              setNaming((current) => (current ? { ...current, name: event.target.value } : current))
            }
          />
        </Field>
      </Modal>
    </>
  )
}

const Chip = ({
  current,
  onClick,
  children,
}: {
  current: boolean
  onClick: () => void
  children: React.ReactNode
}) => (
  <button
    type="button"
    aria-current={current ? 'true' : undefined}
    onClick={onClick}
    className={`inline-flex h-control max-w-full items-center truncate rounded-pill border px-3 text-small ${
      current ? 'border-line-strong bg-fill font-medium' : 'border-line text-secondary hover:bg-fill'
    }`}
  >
    {children}
  </button>
)
