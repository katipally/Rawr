'use client'

import { DataTable, Modal, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { formsPath, submissionsPath } from '~/lib/links.ts'
import { EmbedSnippet } from './embed-snippet.tsx'

export type FormRow = {
  id: string
  name: string
  slug: string
  isActive: boolean
  fieldCount: number
  submissions: number
  quarantined: number
  /** ISO, or null before the first submission. */
  lastSubmissionAt: string | null
}

/** HubSpot's forms list: a table with the form's status under its name, and the
 *  numbers that matter in the columns. The embed code is one click away on each
 *  row rather than printed under every form. */
export const FormsTable = ({ account, baseUrl, rows }: { account: string; baseUrl: string; rows: FormRow[] }) => {
  const router = useRouter()
  const [embedding, setEmbedding] = useState<FormRow | null>(null)

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
    { key: 'fields', header: 'Fields', width: 100, align: 'right', render: (row) => row.fieldCount },
    { key: 'submissions', header: 'Form submissions', width: 160, align: 'right', render: (row) => row.submissions.toLocaleString() },
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
          ? new Date(row.lastSubmissionAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
          : '--',
    },
    {
      key: 'embed',
      header: '',
      width: 140,
      render: (row) => (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            setEmbedding(row)
          }}
          className="inline-flex h-control items-center rounded-pill border border-line-strong px-4 text-small font-light hover:bg-fill"
        >
          Embed code
        </button>
      ),
    },
  ]

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        caption="Forms in this account"
        onRowClick={(row) => router.push(formsPath(account, row.id))}
      />
      <Modal open={embedding !== null} title={embedding ? `Embed “${embedding.name}”` : 'Embed'} onClose={() => setEmbedding(null)}>
        {embedding ? <EmbedSnippet baseUrl={baseUrl} formId={embedding.id} account={account} slug={embedding.slug} /> : null}
      </Modal>
    </>
  )
}
