'use client'

import type { EnrollmentState } from '@rawr/db'
import { Badge, Button, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { sequencePath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { EnrollDialog } from './enroll-dialog.tsx'
import { ENROLLMENT_LABEL, ENROLLMENT_TONE, formatDateTime } from './value.tsx'
import { useZone } from '~/components/zone.tsx'

export type SequencesPanelRow = {
  id: string
  sequenceId: string
  sequenceName: string
  state: EnrollmentState
  currentStep: number
  stepCount: number
  nextRunAt: string | null
  lastSentAt: string | null
  stopReason: string | null
  enrolledAt: string
}

export type SequencesPanelProps = {
  account: string
  /** A contact's own enrollments, or, on a company, the button to enrol everyone
   *  at it. A company has no enrollment of its own: a sequence writes to a person. */
  contactId?: string | undefined
  companyId?: string | undefined
  contactName: string
  rows: SequencesPanelRow[]
  canWrite: boolean
}

const LIVE: EnrollmentState[] = ['active', 'waiting_task', 'paused']

/** Which sequences this person is in, and where each one stands. The point is
 *  the thing HubSpot puts at the top of a contact: nobody enrols somebody a
 *  colleague is already writing to, and a paused or stopped run says why. */
export const SequencesPanel = ({
  account,
  contactId,
  companyId,
  contactName,
  rows,
  canWrite,
}: SequencesPanelProps) => {
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [enrolling, setEnrolling] = useState(false)

  const act = async (id: string, action: 'pause' | 'resume' | 'remove') => {
    setBusy(id)
    try {
      await api.sequences.enrollments[action].mutate({ id })
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const live = rows.filter((row) => LIVE.includes(row.state))
  const past = rows.filter((row) => !LIVE.includes(row.state))

  return (
    <section className="rounded-panel border border-line bg-surface shadow-panel">
      <header className="flex items-center justify-between gap-2 px-6 pt-6 pb-4">
        <h2 className="text-base font-semibold">
          {companyId ? 'Sequences' : `Sequences (${live.length})`}
        </h2>
        {canWrite ? (
          <Button variant="tertiary" onClick={() => setEnrolling(true)}>
            {companyId ? 'Enrol everyone here' : 'Enrol'}
          </Button>
        ) : null}
      </header>

      {companyId ? (
        <p className="px-6 pb-6 text-secondary">
          Enrolling here puts every contact at {contactName} who has an email address into one
          sequence, from one mailbox. Anybody already in it is left alone.
        </p>
      ) : rows.length === 0 ? (
        <p className="px-6 pb-6 text-secondary">{contactName} is not in a sequence.</p>
      ) : (
        <ul className="flex flex-col">
          {[...live, ...past].map((row) => (
            <li key={row.id} className="flex flex-col gap-1 border-b border-divider px-6 py-3 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link className="min-w-0 break-words font-medium text-link" href={sequencePath(account, row.sequenceId)}>
                  {row.sequenceName}
                </Link>
                <Badge tone={ENROLLMENT_TONE[row.state]} dot>
                  {ENROLLMENT_LABEL[row.state]}
                </Badge>
              </div>
              <p className="text-small text-secondary">
                {row.stepCount > 0 ? `Step ${Math.min(row.currentStep + 1, row.stepCount)} of ${row.stepCount}` : 'No steps yet'}
                {row.state === 'active' && row.nextRunAt ? ` · next ${formatDateTime(row.nextRunAt, zone)}` : ''}
                {row.lastSentAt ? ` · last sent ${formatDateTime(row.lastSentAt, zone)}` : ''}
                {!LIVE.includes(row.state) && row.stopReason ? ` · ${row.stopReason}` : ''}
              </p>
              {canWrite && LIVE.includes(row.state) ? (
                <div className="flex flex-wrap gap-2 text-small">
                  {row.state === 'paused' ? (
                    <Button variant="tertiary" busy={busy === row.id} onClick={() => void act(row.id, 'resume')}>
                      Resume
                    </Button>
                  ) : (
                    <Button variant="tertiary" busy={busy === row.id} onClick={() => void act(row.id, 'pause')}>
                      Pause
                    </Button>
                  )}
                  <Button variant="tertiary" busy={busy === row.id} onClick={() => void act(row.id, 'remove')}>
                    Remove
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {enrolling ? (
        <EnrollDialog
          {...(companyId ? { companyId } : { contactIds: contactId ? [contactId] : [] })}
          contactLabel={companyId ? `everyone at ${contactName}` : contactName}
          onClose={() => setEnrolling(false)}
          onEnrolled={() => router.refresh()}
        />
      ) : null}
    </section>
  )
}
