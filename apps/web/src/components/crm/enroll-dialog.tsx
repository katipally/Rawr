'use client'

import { Badge, Button, Combobox, Modal, Spinner, useToast } from '@rawr/ui'
import { useEffect, useState } from 'react'
import { api, errorMessage, trpc } from '~/lib/rpc.ts'
import { useQueryClient } from '@tanstack/react-query'
import type { SequenceStep } from '@rawr/db'
import { STEP_KIND_LABEL } from './value.tsx'

type Sequence = { id: string; name: string; state: string; stepCount: number }
type Mailbox = { id: string; email: string; canSend: boolean; state: string }
type Outcome = { contactId: string; enrolled: boolean; reason?: string }

/** Putting contacts into a sequence.
 *
 *  Says per contact what happened rather than a count: half a list silently not
 *  enrolled is how somebody finds out three months later that nobody was ever
 *  contacted. */
export const EnrollDialog = ({
  contactIds,
  companyId,
  contactLabel,
  onClose,
  onEnrolled,
}: {
  contactIds?: string[] | undefined
  /** Everyone at this company, resolved on the server. One or the other, never
   *  both: which people are meant is not something to guess at. */
  companyId?: string | undefined
  /** What to call them in the copy: one name, or "12 contacts". */
  contactLabel: string
  onClose: () => void
  onEnrolled?: () => void
}) => {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [sequences, setSequences] = useState<Sequence[] | null>(null)
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null)
  const [sequenceId, setSequenceId] = useState<string | null>(null)
  const [mailboxId, setMailboxId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [steps, setSteps] = useState<SequenceStep[] | null>(null)

  useEffect(() => {
    Promise.all([queryClient.fetchQuery({ ...trpc.sequences.list.queryOptions(), staleTime: 0 }), queryClient.fetchQuery({ ...trpc.mail.mailboxes.queryOptions(), staleTime: 0 })])
      .then(([found, boxes]) => {
        setSequences(found.filter((row) => row.state !== 'archived'))
        setMailboxes(boxes.map((box) => ({ id: box.id, email: box.email, canSend: box.canSend, state: box.state })))
        // One sendable mailbox is the common case, so it is chosen rather than
        // made into a question.
        const sendable = boxes.filter((box) => box.canSend && box.state !== 'revoked')
        if (sendable.length === 1) setMailboxId(sendable[0]?.id ?? null)
      })
      .catch((cause) => setError(errorMessage(cause)))
  }, [queryClient])

  // HubSpot shows the chosen sequence's steps before it starts, so what is about
  // to go out is read before it goes. A late answer for a sequence no longer
  // chosen is dropped.
  useEffect(() => {
    setSteps(null)
    if (!sequenceId) return
    let live = true
    queryClient
      .fetchQuery(trpc.sequences.get.queryOptions({ id: sequenceId }))
      .then((found) => {
        if (live) setSteps(found?.steps ?? [])
      })
      .catch((cause) => {
        if (live) setError(errorMessage(cause))
      })
    return () => {
      live = false
    }
  }, [queryClient, sequenceId])

  const sendable = (mailboxes ?? []).filter((box) => box.canSend && box.state !== 'revoked')
  const refused = outcomes?.filter((row) => !row.enrolled) ?? []
  const enrolled = outcomes?.filter((row) => row.enrolled).length ?? 0

  return (
    <Modal
      open
      title={`Enroll ${contactLabel} in a sequence`}
      onClose={onClose}
      footer={
        sequences && mailboxes && !outcomes ? (
          <>
            <Button variant="tertiary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!sequenceId || !mailboxId}
              onClick={() => {
                if (!sequenceId || !mailboxId) return
                setBusy(true)
                void api.sequences.enroll
                  .mutate(
                    companyId
                      ? { sequenceId, companyId, mailboxId }
                      : { sequenceId, contactIds: contactIds ?? [], mailboxId },
                  )
                  .then((result) => {
                    setOutcomes(result)
                    onEnrolled?.()
                  })
                  .catch((cause) => toast('error', errorMessage(cause)))
                  .finally(() => setBusy(false))
              }}
            >
              Start sequence
            </Button>
          </>
        ) : null
      }
    >
      {error ? <p className="text-error">{error}</p> : null}
      {!sequences || !mailboxes ? <Spinner label="Loading sequences" /> : null}

      {sequences && mailboxes && !outcomes ? (
        <div className="flex flex-col gap-3">
          {sequences.length === 0 ? (
            <p className="text-secondary">
              No sequences yet. Build one under Marketing, Sequences, then come back.
            </p>
          ) : null}
          {sendable.length === 0 ? (
            <p className="text-warning">
              No mailbox here can send yet. Under Settings, Mailboxes, reconnect one and allow sending.
            </p>
          ) : null}

          <Combobox
            label="Sequence"
            value={sequenceId}
            onChange={setSequenceId}
            options={sequences.map((row) => ({
              value: row.id,
              label: row.name,
              hint: `${row.state} · ${row.stepCount} step${row.stepCount === 1 ? '' : 's'}`,
              disabled: row.stepCount === 0,
            }))}
          />
          {sequenceId ? (
            steps === null ? (
              <Spinner label="Reading the steps" />
            ) : (
              <ol aria-label="Steps" className="flex max-h-64 flex-col divide-y divide-line overflow-y-auto rounded-hs border border-line">
                {steps.map((step, index) => (
                  <li key={step.id} className="flex min-w-0 flex-col px-3 py-2">
                    <span className="font-semibold">
                      {index + 1}. {STEP_KIND_LABEL[step.kind]}
                    </span>
                    <span className="truncate text-small text-secondary">
                      {step.delayDays === 0 && step.delayHours === 0
                        ? 'Straight away'
                        : `After ${step.delayDays} day${step.delayDays === 1 ? '' : 's'}${step.delayHours > 0 ? ` ${step.delayHours} h` : ''}`}
                      {` · ${(step.kind === 'email' ? step.subject : step.taskTitle) || 'Untitled'}`}
                    </span>
                  </li>
                ))}
              </ol>
            )
          ) : null}
          <Combobox
            label="Send from"
            value={mailboxId}
            onChange={setMailboxId}
            hint="Every step comes from this mailbox, so the conversation stays with one person."
            options={(mailboxes ?? []).map((box) => ({
              value: box.id,
              label: box.email,
              hint: box.canSend ? undefined : 'Connected for reading only',
              disabled: !box.canSend || box.state === 'revoked',
            }))}
          />
        </div>
      ) : null}

      {outcomes ? (
        <div className="flex flex-col gap-3">
          <p>
            <Badge tone={enrolled > 0 ? 'ok' : 'warn'}>{enrolled} enrolled</Badge>
            {refused.length > 0 ? <span className="ml-2 text-secondary">{refused.length} were not.</span> : null}
          </p>
          {refused.length > 0 ? (
            <ul className="flex flex-col gap-1 text-small text-secondary">
              {refused.map((row) => (
                <li key={row.contactId}>{row.reason}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
