'use client'

import { Button, Combobox, Field, Modal, Spinner, TextArea, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useDraft } from '~/lib/drafts.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

type Mailbox = { id: string; email: string; canSend: boolean; state: string }

/** Writing one email, from your own mailbox.
 *
 *  Nothing here is instrumented: no pixel, no rewritten links. Measuring a
 *  colleague writing to one person would be surveillance rather than reporting,
 *  and the numbers on the sequence screens would stop meaning campaign. */
export const ComposeDialog = ({
  account,
  to,
  subject: initialSubject,
  threadId,
  contactId,
  onClose,
  onSent,
}: {
  account: string
  to: string
  subject?: string
  threadId?: string | null
  contactId?: string | null
  onClose: () => void
  onSent?: () => void
}) => {
  const router = useRouter()
  const toast = useToast()
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null)
  const [mailboxId, setMailboxId] = useState<string | null>(null)
  const [subject, setSubject] = useState(initialSubject ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  // Keyed on the thread when replying and on the contact for a fresh email, so a
  // reply-in-progress and an unrelated compose to the same person never collide.
  const { forget } = useDraft(account, 'email', threadId ?? contactId ?? undefined, { subject, text }, (draft) => {
    setSubject(draft.subject)
    setText(draft.text)
  })

  // Cancel and the modal's own X are a dismissal, not a discard: the draft is
  // only forgotten once the email actually sends.
  const close = () => {
    onClose()
  }

  useEffect(() => {
    api.mail.mailboxes
      .query()
      .then((boxes) => {
        const rows = boxes.map((box) => ({
          id: box.id,
          email: box.email,
          canSend: box.canSend,
          state: box.state,
        }))
        setMailboxes(rows)
        const sendable = rows.filter((box) => box.canSend && box.state !== 'revoked')
        if (sendable.length === 1) setMailboxId(sendable[0]?.id ?? null)
      })
      .catch((cause) => toast('error', errorMessage(cause)))
  }, [toast])

  const sendable = (mailboxes ?? []).filter((box) => box.canSend && box.state !== 'revoked')

  return (
    <Modal open size="lg" title={threadId ? `Reply to ${to}` : `Email ${to}`} onClose={close}>
      {!mailboxes ? <Spinner label="Loading mailboxes" /> : null}

      {mailboxes ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!mailboxId) return
            setBusy(true)
            void api.mail.compose
              .mutate({
                mailboxId,
                to,
                subject: subject.trim(),
                text,
                threadId: threadId ?? null,
                contactId: contactId ?? null,
              })
              .then(() => {
                toast('success', 'Sent. It is on the record and in the inbox already.')
                onSent?.()
                router.refresh()
                forget()
                close()
              })
              .catch((cause) => toast('error', errorMessage(cause)))
              .finally(() => setBusy(false))
          }}
        >
          {sendable.length === 0 ? (
            <p className="text-warning">
              No mailbox here can send yet. Under Settings, Mailboxes, reconnect one and allow sending.
            </p>
          ) : null}

          <Combobox
            label="From"
            value={mailboxId}
            onChange={setMailboxId}
            options={mailboxes.map((box) => ({
              value: box.id,
              label: box.email,
              hint: box.canSend ? undefined : 'Connected for reading only',
              disabled: !box.canSend || box.state === 'revoked',
            }))}
          />

          <Field label="Subject" id="compose-subject" required>
            <TextInput
              id="compose-subject"
              required
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </Field>

          <Field label="Message" id="compose-body">
            <TextArea
              id="compose-body"
              rows={10}
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="tertiary" type="button" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              busy={busy}
              disabled={!mailboxId || subject.trim() === '' || text.trim() === ''}
            >
              Send
            </Button>
          </div>
        </form>
      ) : null}
    </Modal>
  )
}
