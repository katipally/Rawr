'use client'

import type { SequenceRow, SequenceState } from '@rawr/db'
import { Button, DataTable, EmptyState, Field, Modal, NOTHING_MATCHED, TextArea, TextInput, cn, useToast, PageHeader, type Column } from '@rawr/ui'
import { Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, StatusDot, rowPill, type StatusTone } from '~/components/row-actions.tsx'
import { useFormat } from '~/components/zone.tsx'
import { enrollmentsPath, sequencePath, sequenceSendsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

const STATE_TONE: Record<SequenceState, StatusTone> = {
  draft: 'off',
  active: 'live',
  paused: 'pending',
  archived: 'archived',
}

const STATE_LABEL: Record<SequenceState, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
}

/** A rate over a count, because "12 opened" means nothing without how many went
 *  out, and 0 of 0 is not 0%. */
const rate = (part: number, whole: number): string => (whole === 0 ? EMPTY_VALUE : `${Math.round((part / whole) * 100)}%`)

/** Archived is deliberately not one: an archived sequence is out of the way, and
 *  the tab that shows it is "All". */
const FILTERS: (SequenceState | null)[] = [null, 'draft', 'active', 'paused', 'archived']

/** HubSpot's sequences Manage table: the name with its state, then the numbers
 *  that compare one sequence with another, and the ways into it on the hovered
 *  row. */
export const SequenceList = ({
  account,
  rows,
  canWrite,
  hub,
}: {
  account: string
  rows: SequenceRow[]
  canWrite: boolean
  hub: string
}) => {
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [state, setState] = useState<SequenceState | null>(null)
  const [needle, setNeedle] = useState('')
  const [draft, setDraft] = useState({ name: '', description: '' })
  const [busy, setBusy] = useState(false)

  // Filtered here rather than refetched: the whole list is already on the page,
  // and an account has tens of sequences, not thousands.
  const wanted = needle.trim().toLowerCase()
  const shown = rows.filter(
    (row) =>
      (state === null || row.state === state) &&
      (wanted === '' ||
        row.name.toLowerCase().includes(wanted) ||
        (row.description ?? '').toLowerCase().includes(wanted) ||
        (row.ownerName ?? '').toLowerCase().includes(wanted)),
  )
  const { page, pager } = usePagedRows(shown, 'sequences')

  const columns: Column<SequenceRow>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 340,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-col">
            <Link href={sequencePath(account, row.id)} title={row.name} className="truncate font-semibold text-link hover:underline">
              {row.name}
            </Link>
            <span className="flex min-w-0 text-small">
              <StatusDot tone={STATE_TONE[row.state]}>
                {STATE_LABEL[row.state]} | {row.stepCount} {row.stepCount === 1 ? 'step' : 'steps'}
              </StatusDot>
            </span>
          </span>
          <RowActions>
            <Link href={sequencePath(account, row.id)} className={rowPill}>
              Edit
            </Link>
            <Link href={enrollmentsPath(account, row.id)} className={rowPill}>
              Enrollments
            </Link>
            <Link href={sequenceSendsPath(account, row.id)} className={rowPill}>
              Emails sent
            </Link>
          </RowActions>
        </span>
      ),
    },
    { key: 'owner', header: 'Owner', width: 150, render: (row) => row.ownerName ?? EMPTY_VALUE },
    { key: 'enrolled', header: 'Enrolled', width: 120, align: 'right', render: (row) => fmt.number(row.stats.enrolled) },
    { key: 'active', header: 'Active', width: 110, align: 'right', render: (row) => fmt.number(row.stats.active) },
    { key: 'open', header: 'Open rate', width: 130, align: 'right', render: (row) => rate(row.stats.opened, row.stats.sent) },
    { key: 'click', header: 'Click rate', width: 130, align: 'right', render: (row) => rate(row.stats.clicked, row.stats.sent) },
    { key: 'reply', header: 'Reply rate', width: 130, align: 'right', render: (row) => rate(row.stats.replied, row.stats.enrolled) },
    { key: 'bounced', header: 'Bounced', width: 120, align: 'right', render: (row) => fmt.number(row.stats.bounced) },
    { key: 'unsubscribed', header: 'Unsubscribed', width: 150, align: 'right', render: (row) => fmt.number(row.stats.unsubscribed) },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PageHeader
        title="Sequences"
        lead="A run of emails and tasks, sent from your own Gmail."
        why={
          <p>
            The mail comes from you and lands in the same conversation as everything else. A reply
            stops it on the sync that reads the reply.
          </p>
        }
        action={
          canWrite ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create sequence
            </Button>
          ) : undefined
        }
      />
      {canWrite ? null : (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          You need {hub} access to change these.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No sequences yet"
          description="A sequence is a run of steps with a wait between them. The first one takes a couple of minutes to write."
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <div role="tablist" aria-label="Sequence state" className="scroll-fade-x flex min-w-0 overflow-x-auto rounded-t-hs border-b border-line">
            {FILTERS.map((each) => (
              <button
                key={each ?? 'all'}
                type="button"
                role="tab"
                aria-selected={state === each}
                onClick={() => setState(each)}
                className={cn(
                  'flex min-h-10 shrink-0 items-center gap-2 border-r border-line px-4 text-body last:border-r-0',
                  state === each ? 'bg-surface font-medium' : 'bg-fill font-normal hover:bg-fill-hover',
                )}
              >
                {each === null ? 'All sequences' : <StatusDot tone={STATE_TONE[each]}>{STATE_LABEL[each]}</StatusDot>}
                <span className="text-small text-secondary">
                  {fmt.number(each === null ? rows.length : rows.filter((row) => row.state === each).length)}
                </span>
              </button>
            ))}
          </div>
          <label className="relative w-full min-w-0 @lg:w-60">
            <span className="sr-only">Search sequences</span>
            <input
              type="search"
              value={needle}
              placeholder="Search sequences"
              onChange={(event) => setNeedle(event.target.value)}
              className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-9 pl-4 text-body placeholder:text-muted"
            />
            <Search aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
          </label>
          <DataTable
            columns={columns}
            rows={page}
            rowKey={(row) => row.id}
            caption="Sequences in this account"
            storageKey="sequences.list"
            empty={<EmptyState {...NOTHING_MATCHED} />}
          />
        </div>
      )}

      {pager}

      {creating ? (
        <Modal
          open
          title="Create sequence"
          onClose={() => setCreating(false)}
          dirty={draft.name !== '' || draft.description !== ''}
          onSubmit={() => {
            setBusy(true)
            void api.sequences.save
              .mutate({ name: draft.name.trim(), description: draft.description.trim() || null })
              .then((created) => {
                toast('success', 'Add the steps next. Nothing sends until you turn it on.')
                router.push(sequencePath(account, created.id))
              })
              .catch((cause) => toast('error', errorMessage(cause)))
              .finally(() => setBusy(false))
          }}
          footer={
            <>
              <Button variant="tertiary" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" busy={busy} disabled={draft.name.trim() === ''}>
                Create
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Field label="Name" id="sequence-name" required>
              <TextInput
                id="sequence-name"
                required
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field label="What it is for" id="sequence-description" hint="Optional. Only your team sees it.">
              <TextArea
                id="sequence-description"
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </Field>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
