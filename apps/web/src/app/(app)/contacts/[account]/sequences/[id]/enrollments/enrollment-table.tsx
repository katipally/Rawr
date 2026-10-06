'use client'

import type { EnrollmentState, SequenceState } from '@rawr/db'
import { Badge, ConfirmDialog, DataTable, EmptyState, IconButton, cn, useToast, type Column } from '@rawr/ui'
import { X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { enrollmentsPath, recordPath } from '~/lib/links.ts'
import { useOrigin } from '~/lib/use-origin.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { ENROLLMENT_LABEL as LABEL, ENROLLMENT_TONE as TONE } from '~/components/crm/value.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { useFormat } from '~/components/zone.tsx'
import { SequenceHeader } from '../sequence-header.tsx'

type Row = {
  id: string
  contactId: string
  contactName: string
  contactEmail: string | null
  state: EnrollmentState
  currentStep: number
  nextRunAt: string | null
  lastSentAt: string | null
  stopReason: string | null
  sends: number
  opens: number
  clicks: number
}

const FILTERS: (EnrollmentState | null)[] = [
  null,
  'active',
  'waiting_task',
  'paused',
  'finished',
  'replied',
  'bounced',
  'unsubscribed',
  'failed',
  'removed',
]

const bulkAction =
  'inline-flex h-[calc(var(--spacing-row)-2px)] shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-body font-semibold transition-all duration-150 ease-out hover:bg-fill disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent'

/** Who is in one sequence: HubSpot's enrollments tab, the statuses down the
 *  side and a table of contacts with Pause, Resume and Unenroll on the hovered
 *  row or over the header for the ticked ones. */
export const EnrollmentTable = ({
  account,
  sequence,
  state,
  rows,
  canWrite,
}: {
  account: string
  sequence: { id: string; name: string; state: SequenceState; description: string | null }
  state: EnrollmentState | null
  rows: Row[]
  canWrite: boolean
}) => {
  const fmt = useFormat()
  const origin = useOrigin()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<Row[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const { page, pager } = usePagedRows(rows, 'contacts')
  const ticked = rows.filter((row) => selected.has(row.id))

  /** One existing call per contact, side by side: a page holds at most 200, and
   *  one refused contact should not keep the others where they were. */
  const runEach = async (targets: Row[], fn: (row: Row) => Promise<unknown>, done: string) => {
    setBusy(true)
    const results = await Promise.allSettled(targets.map(fn))
    setBusy(false)
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length === 0) toast('success', done)
    else if (failed[0]?.status === 'rejected')
      toast('error', `${failed.length} of ${targets.length} did not change: ${errorMessage(failed[0].reason)}`)
    setSelected(new Set())
    router.refresh()
  }

  const pause = (targets: Row[]) =>
    runEach(targets, (row) => api.sequences.enrollments.pause.mutate({ id: row.id }), 'Paused.')
  const resume = (targets: Row[]) =>
    runEach(targets, (row) => api.sequences.enrollments.resume.mutate({ id: row.id }), 'Running again.')

  const columns: Column<Row>[] = [
    {
      key: 'contact',
      header: 'Contact',
      width: 300,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-col">
            <Link
              href={recordPath(account, 'contact', row.contactId, { from: origin })}
              title={row.contactName}
              className="truncate font-semibold text-link hover:underline"
            >
              {row.contactName}
            </Link>
            <span className="truncate text-small text-secondary">{row.contactEmail ?? 'No email'}</span>
          </span>
          {canWrite ? (
            <RowActions>
              {row.state === 'active' ? (
                <button type="button" className={rowPill} disabled={busy} onClick={() => void pause([row])}>
                  Pause
                </button>
              ) : null}
              {row.state === 'paused' ? (
                <button type="button" className={rowPill} disabled={busy} onClick={() => void resume([row])}>
                  Resume
                </button>
              ) : null}
              <button type="button" className={rowPill} disabled={busy} onClick={() => setRemoving([row])}>
                Unenroll
              </button>
            </RowActions>
          ) : null}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 200,
      render: (row) => (
        <Badge tone={TONE[row.state]} dot>
          {LABEL[row.state]}
        </Badge>
      ),
    },
    { key: 'step', header: 'Latest step', width: 130, render: (row) => `Step ${row.currentStep + 1}` },
    {
      key: 'engagement',
      header: 'Engagement',
      width: 260,
      render: (row) => (
        <span className="block truncate">
          {fmt.number(row.sends)} sent · {fmt.number(row.opens)} opened · {fmt.number(row.clicks)} clicked
        </span>
      ),
    },
    {
      key: 'details',
      header: 'Details',
      width: 260,
      render: (row) => {
        const timing =
          row.state === 'active' && row.nextRunAt
            ? `Next ${fmt.dateTime(row.nextRunAt)}`
            : row.lastSentAt
              ? `Last ${fmt.date(row.lastSentAt)}`
              : 'Nothing sent yet'
        const details = row.stopReason ? `${row.stopReason} · ${timing}` : timing
        return (
          <span className="block truncate" title={details}>
            {details}
          </span>
        )
      },
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SequenceHeader account={account} sequence={sequence} current="enrollments" />

      <div className="flex min-w-0 flex-col gap-4 @4xl:flex-row @4xl:items-start">
        <nav aria-label="Enrollment status" className="flex min-w-0 flex-wrap gap-1 @4xl:w-56 @4xl:shrink-0 @4xl:flex-col">
          {FILTERS.map((each) => (
            <Link
              key={each ?? 'all'}
              href={enrollmentsPath(account, sequence.id, { state: each ?? undefined })}
              aria-current={state === each ? 'page' : undefined}
              className={cn(
                'flex min-h-10 items-center rounded-hs px-3 text-body no-underline transition-colors duration-150 ease-out',
                state === each ? 'bg-fill-hover font-medium' : 'font-normal hover:bg-fill',
              )}
            >
              {each === null ? 'Everyone' : LABEL[each]}
            </Link>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <DataTable
            columns={columns}
            rows={page}
            rowKey={(row) => row.id}
            caption={`Who is in ${sequence.name}`}
            storageKey="sequence.enrollments"
            {...(canWrite ? { selection: { selected, onChange: setSelected, noun: 'contact' } } : {})}
            headerBar={
              canWrite && ticked.length > 0 ? (
                <div
                  role="toolbar"
                  aria-label={`Actions for ${ticked.length} selected contacts`}
                  className="flex h-full min-w-0 animate-drop-in items-center gap-0.5 rounded-hs border border-line bg-surface pl-4 motion-reduce:animate-none"
                >
                  <span className="mr-3 min-w-0 shrink truncate font-semibold">
                    {fmt.number(ticked.length)} {ticked.length === 1 ? 'contact' : 'contacts'} selected
                  </span>
                  <button
                    type="button"
                    className={bulkAction}
                    disabled={busy || !ticked.some((row) => row.state === 'active')}
                    onClick={() => void pause(ticked.filter((row) => row.state === 'active'))}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className={bulkAction}
                    disabled={busy || !ticked.some((row) => row.state === 'paused')}
                    onClick={() => void resume(ticked.filter((row) => row.state === 'paused'))}
                  >
                    Resume
                  </button>
                  <button type="button" className={bulkAction} disabled={busy} onClick={() => setRemoving(ticked)}>
                    Unenroll
                  </button>
                  <IconButton
                    label="Clear the selection"
                    icon={<X aria-hidden="true" className="size-4" />}
                    onClick={() => setSelected(new Set())}
                    className="mr-1 ml-auto shrink-0 text-body"
                  />
                </div>
              ) : null
            }
            empty={
              <EmptyState
                title="Nobody here"
                description="Enrol somebody from a contact, or from a selection on the contacts list."
              />
            }
          />
          {pager}
        </div>
      </div>

      <ConfirmDialog
        open={removing.length > 0}
        title={
          removing.length === 1
            ? `Take ${removing[0]?.contactName ?? 'them'} out of ${sequence.name}?`
            : `Take ${fmt.number(removing.length)} contacts out of ${sequence.name}?`
        }
        confirm="Unenroll"
        busy={busy}
        onCancel={() => setRemoving([])}
        onConfirm={() => {
          const targets = removing
          void runEach(
            targets,
            (row) => api.sequences.enrollments.remove.mutate({ id: row.id }),
            targets.length === 1 ? `${targets[0]?.contactName ?? 'They'} is out of this sequence.` : 'They are out of this sequence.',
          ).then(() => setRemoving([]))
        }}
      >
        <p>No further step of this sequence is sent to them.</p>
      </ConfirmDialog>
    </div>
  )
}
