'use client'

import { Badge, Button, Combobox, Modal, Spinner, useToast } from '@rawr/ui'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

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
  const toast = useToast()
  const [sequences, setSequences] = useState<Sequence[] | null>(null)
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null)
  const [sequenceId, setSequenceId] = useState<string | null>(null)
  const [mailboxId, setMailboxId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.sequences.list.query(), api.mail.mailboxes.query()])
      .then(([found, boxes]) => {
        setSequences(found.filter((row) => row.state !== 'archived'))
        setMailboxes(boxes.map((box) => ({ id: box.id, email: box.email, canSend: box.canSend, state: box.state })))
        // One sendable mailbox is the common case, so it is chosen rather than
        // made into a question.
        const sendable = boxes.filter((box) => box.canSend && box.state !== 'revoked')
        if (sendable.length === 1) setMailboxId(sendable[0]?.id ?? null)
      })
      .catch((cause) => setError(errorMessage(cause)))
  }, [])

  const sendable = (mailboxes ?? []).filter((box) => box.canSend && box.state !== 'revoked')
  const refused = outcomes?.filter((row) => !row.enrolled) ?? []
  const enrolled = outcomes?.filter((row) => row.enrolled).length ?? 0

  return (
    <Modal open title={`Add ${contactLabel} to a sequence`} onClose={onClose}>
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

          <div className="flex justify-end gap-2">
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
              Enrol
            </Button>
          </div>
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
