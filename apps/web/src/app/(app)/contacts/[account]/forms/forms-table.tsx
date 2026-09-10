'use client'

import { Button, DataTable, Field, Modal, Select, TextInput, useToast, type Column } from '@rawr/ui'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { usePagedRows } from '~/components/paged.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formsPath, submissionsPath } from '~/lib/links.ts'
import { EmbedSnippet } from './embed-snippet.tsx'
import { formatDate } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'

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
const rate = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`

/** HubSpot's forms list: a table with the form's status under its name, and the
 *  numbers that matter in the columns. The embed code is one click away on each
 *  row rather than printed under every form. */
export const FormsTable = ({
  account,
  baseUrl,
  rows,
  folders,
  canEdit,
}: {
  account: string
  baseUrl: string
  rows: FormRow[]
  folders: FolderRow[]
  canEdit: boolean
}) => {
  const zone = useZone()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const toast = useToast()

  const [embedding, setEmbedding] = useState<FormRow | null>(null)
  const [moving, setMoving] = useState<FormRow | null>(null)
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null)
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
      width: 320,
      render: (row) => (
        <span className="flex min-w-0 flex-col py-1">
          <Link href={formsPath(account, row.id)} className="truncate" onClick={(event) => event.stopPropagation()}>
            {row.name}
          </Link>
          <span className="flex items-center gap-1.5 text-small text-secondary">
            <span aria-hidden="true" className={`size-2 rounded-pill ${row.isActive ? 'bg-success' : 'bg-line-strong'}`} />
            {row.isActive ? 'Published' : 'Turned off'} | Form
          </span>
        </span>
      ),
    },
    {
      key: 'views',
      header: 'Page views',
      width: 130,
      align: 'right',
      render: (row) => (row.pageViews === 0 ? '—' : row.pageViews.toLocaleString()),
    },
    {
      key: 'rate',
      header: 'Submissions / page view',
      width: 190,
      align: 'right',
      render: (row) => rate(row.submissions, row.pageViews),
    },
    {
      key: 'spam',
      header: 'Spam submissions',
      width: 160,
      align: 'right',
      render: (row) => row.spam.toLocaleString(),
    },
    { key: 'submissions', header: 'Form submissions', width: 160, align: 'right', render: (row) => row.submissions.toLocaleString() },
    {
      key: 'appears',
      header: 'Appears on',
      width: 130,
      align: 'right',
      render: (row) =>
        row.appearsOn === 0 ? '—' : `${row.appearsOn} ${row.appearsOn === 1 ? 'page' : 'pages'}`,
    },
    {
      key: 'held',
      header: 'Held for review',
      width: 150,
      align: 'right',
      render: (row) =>
        row.quarantined > 0 ? (
          <Link href={submissionsPath(account, { state: 'quarantined', form: row.id })} onClick={(event) => event.stopPropagation()}>
            {row.quarantined.toLocaleString()}
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
          ? formatDate(row.lastSubmissionAt, zone)
          : '—',
    },
    {
      key: 'actions',
      header: '',
      width: 250,
      render: (row) => (
        <span className="flex flex-wrap justify-end gap-1">
          <RowAction onClick={() => setEmbedding(row)}>Embed code</RowAction>
          {canEdit ? (
            <>
              <RowAction
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const id = await api.forms.clone.mutate({ id: row.id })
                    router.push(formsPath(account, id))
                  })
                }
              >
                Clone
              </RowAction>
              <RowAction onClick={() => setMoving(row)}>Move</RowAction>
            </>
          ) : null}
        </span>
      ),
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
                  onClick={() =>
                    run(async () => {
                      await api.forms.removeFolder.mutate({ id: folder })
                      go(null)
                    })
                  }
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
        onRowClick={(row) => router.push(formsPath(account, row.id))}
      />
      {pager}

      <Modal open={embedding !== null} title={embedding ? `Embed “${embedding.name}”` : 'Embed'} onClose={() => setEmbedding(null)}>
        {embedding ? <EmbedSnippet baseUrl={baseUrl} formId={embedding.id} account={account} slug={embedding.slug} /> : null}
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
              setMoving(null)
              void run(() => api.forms.moveToFolder.mutate({ formId: target.id, folderId }))
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
        open={naming !== null}
        title={naming?.id ? 'Rename folder' : 'New folder'}
        onClose={() => setNaming(null)}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            const draft = naming
            if (!draft) return
            setNaming(null)
            void run(() =>
              api.forms.saveFolder.mutate({ id: draft.id, name: draft.name }),
            )
          }}
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
          <Button type="submit" variant="primary" disabled={busy || !naming?.name.trim()}>
            Save
          </Button>
        </form>
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

const RowAction = ({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={(event) => {
      event.stopPropagation()
      onClick()
    }}
    className="inline-flex h-control items-center rounded-pill border border-line-strong px-3 text-small font-light hover:bg-fill disabled:opacity-60"
  >
    {children}
  </button>
)
