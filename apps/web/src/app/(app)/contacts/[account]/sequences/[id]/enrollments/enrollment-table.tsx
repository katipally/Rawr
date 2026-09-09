'use client'

import type { EnrollmentState } from '@rawr/db'
import { Badge, Breadcrumb, Button, Card, DropdownMenu, EmptyState, useToast } from '@rawr/ui'
import { MoreHorizontal } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { enrollmentsPath, recordPath, sequencePath, sequencesPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { ENROLLMENT_LABEL as LABEL, ENROLLMENT_TONE as TONE, formatDate, formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'

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

const FILTERS: (EnrollmentState | null)[] = [null, 'active', 'waiting_task', 'replied', 'bounced', 'failed']

export const EnrollmentTable = ({
  account,
  sequenceId,
  sequenceName,
  state,
  rows,
  canWrite,
}: {
  account: string
  sequenceId: string
  sequenceName: string
  state: EnrollmentState | null
  rows: Row[]
  canWrite: boolean
}) => {
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast('success', done)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Breadcrumb
        items={[
          { label: 'Sequences', href: sequencesPath(account) },
          { label: sequenceName, href: sequencePath(account, sequenceId) },
          { label: 'Who is in it' },
        ]}
      />

      <h1 className="text-lg font-medium">Who is in {sequenceName}</h1>

      <div className="flex flex-wrap gap-1">
        {FILTERS.map((each) => (
          <Link
            key={each ?? 'all'}
            href={enrollmentsPath(account, sequenceId, { state: each ?? undefined })}
            className={
              state === each
                ? 'rounded-hs bg-accent-subtle px-3 py-1.5 font-medium text-link no-underline'
                : 'rounded-hs px-3 py-1.5 text-secondary no-underline hover:bg-fill'
            }
          >
            {each === null ? 'Everyone' : LABEL[each]}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nobody here"
          description="Enrol somebody from a contact, or from a selection on the contacts list."
        />
      ) : (
        <Card flush>
          <ul className="divide-y divide-divider">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <Link href={recordPath(account, 'contact', row.contactId)} className="truncate font-medium">
                    {row.contactName}
                  </Link>
                  <span className="truncate text-small text-secondary">{row.contactEmail ?? 'No email'}</span>
                  {row.stopReason ? <span className="truncate text-small text-secondary">{row.stopReason}</span> : null}
                </span>

                <Badge tone={TONE[row.state]} dot>
                  {LABEL[row.state]}
                </Badge>

                <span className="w-28 shrink-0 text-small text-secondary tabular-nums">
                  step {row.currentStep + 1}
                </span>

                <span className="w-40 shrink-0 text-small text-secondary tabular-nums">
                  {row.sends} sent · {row.opens} opened · {row.clicks} clicked
                </span>

                <span className="w-40 shrink-0 text-small text-secondary">
                  {row.state === 'active' && row.nextRunAt
                    ? `Next ${formatDateTime(row.nextRunAt, zone)}`
                    : row.lastSentAt
                      ? `Last ${formatDate(row.lastSentAt, zone)}`
                      : 'Nothing sent yet'}
                </span>

                {canWrite ? (
                  <DropdownMenu
                    label={`Actions for ${row.contactName}`}
                    groups={[
                      {
                        key: 'run',
                        items: [
                          {
                            key: 'pause',
                            label: 'Pause',
                            disabled: row.state !== 'active',
                            onSelect: () =>
                              void run(() => api.sequences.enrollments.pause.mutate({ id: row.id }), 'Paused.'),
                          },
                          {
                            key: 'resume',
                            label: 'Resume',
                            disabled: row.state !== 'paused',
                            onSelect: () =>
                              void run(() => api.sequences.enrollments.resume.mutate({ id: row.id }), 'Running again.'),
                          },
                        ],
                      },
                      {
                        key: 'stop',
                        items: [
                          {
                            key: 'remove',
                            label: 'Take them out',
                            destructive: true,
                            onSelect: () =>
                              void run(
                                () => api.sequences.enrollments.remove.mutate({ id: row.id }),
                                `${row.contactName} is out of this sequence.`,
                              ),
                          },
                        ],
                      },
                    ]}
                    trigger={(props) => (
                      <Button {...props} variant="tertiary" disabled={busy} aria-label={`Actions for ${row.contactName}`}>
                        <MoreHorizontal aria-hidden="true" className="size-4" />
                      </Button>
                    )}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
