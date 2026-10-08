'use client'

import { Button, Combobox, Field, Modal, Select, Spinner, TextInput, useToast } from '@rawr/ui'
import { Paperclip } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useDraft } from '~/lib/drafts.ts'
import { readRecipients, type RecipientFields } from '~/lib/mail-compose.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { AttachmentList, useAttachments } from './compose-attachments.tsx'
import { type RichEditorHandle, RichEditor } from './rich-editor.tsx'

type Mailbox = { id: string; email: string; canSend: boolean; state: string }
type Template = { id: string; name: string }

/** The words in an HTML body, as a browser would show them. Empty when there is
 *  nothing to send but markup. */
const wordsIn = (html: string): string =>
  new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? ''

/** The form around the composer submits on Enter in any field. An email must not go
 *  out because a key was pressed in the To line, so only the Send button sends. */
const noSubmit = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter') event.preventDefault()
}

/** Writing one email, from your own mailbox.
 *
 *  Nothing here is instrumented unless a contact is named: then the same measuring
 *  as a sequence applies, and the record shows it. A colleague writing to one person
 *  with no contact named is never measured. */
export const ComposeDialog = ({
  account,
  to: initialTo,
  cc: initialCc = '',
  subject: initialSubject,
  threadId,
  contactId,
  personId,
  onClose,
  onSent,
}: {
  account: string
  to: string
  cc?: string
  subject?: string
  threadId?: string | null
  contactId?: string | null
  /** The person a template fills in for. A reply names one without measuring it. */
  personId?: string | null
  onClose: () => void
  onSent?: () => void
}) => {
  const router = useRouter()
  const toast = useToast()
  const editor = useRef<RichEditorHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const attachments = useAttachments()
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [mailboxId, setMailboxId] = useState<string | null>(null)
  const [to, setTo] = useState(initialTo)
  const [cc, setCc] = useState(initialCc)
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(initialCc !== '')
  const [showBcc, setShowBcc] = useState(false)
  const [subject, setSubject] = useState(initialSubject ?? '')
  const [html, setHtml] = useState('')
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)

  // Keyed on the thread when replying and on the contact for a fresh email, so a
  // reply-in-progress and an unrelated compose to the same person never collide.
  const { forget } = useDraft(
    account,
    'email',
    threadId ?? contactId ?? undefined,
    { subject, html, to, cc, bcc },
    (draft) => {
      setSubject(draft.subject)
      setHtml(draft.html ?? '')
      setTo(draft.to ?? '')
      setCc(draft.cc ?? '')
      setBcc(draft.bcc ?? '')
      setShowCc((draft.cc ?? '') !== '')
      setShowBcc((draft.bcc ?? '') !== '')
    },
  )

  // Cancel and the modal's own X are a dismissal, not a discard: the draft is
  // only forgotten once the email actually sends. Files still on the message go,
  // because nothing can restore them from a draft.
  const dismiss = () => {
    attachments.discardAll()
    onClose()
  }

  useEffect(() => {
    api.mail.mailboxes
      .query()
      .then((boxes) => {
        const rows = boxes.map((box) => ({ id: box.id, email: box.email, canSend: box.canSend, state: box.state }))
        setMailboxes(rows)
        const sendable = rows.filter((box) => box.canSend && box.state !== 'revoked')
        if (sendable.length === 1) setMailboxId(sendable[0]?.id ?? null)
      })
      .catch((cause) => toast('error', errorMessage(cause)))
  }, [toast])

  // Templates are a convenience: where the account cannot see them, the control is not offered.
  useEffect(() => {
    api.sequences.templates.list
      .query()
      .then((rows) => setTemplates(rows.map((row) => ({ id: row.id, name: row.name }))))
      .catch(() => setTemplates([]))
  }, [])

  const sendable = (mailboxes ?? []).filter((box) => box.canSend && box.state !== 'revoked')
  const people = useMemo(() => readRecipients({ to, cc, bcc }), [to, cc, bcc])
  const hasWords = useMemo(() => wordsIn(html) !== '', [html])

  /** Shown after a field is left or Send is pressed, not on every keystroke, so
   *  an address is not called wrong while it is still being typed. */
  const problem = (field: keyof RecipientFields): string | undefined => {
    if (!checked || people.ok) return undefined
    if (people.field === field || (people.field === null && field === 'to')) return people.error
    return undefined
  }

  const insertTemplate = async (templateId: string) => {
    if (!mailboxId) {
      toast('error', 'Choose the mailbox to send from before inserting a template.')
      return
    }
    try {
      const found = await api.mail.templateFor.query({
        templateId,
        mailboxId,
        contactId: personId ?? contactId ?? null,
      })
      if (subject.trim() === '' && found.subject !== '') setSubject(found.subject)
      editor.current?.insert(found.html)
      if (found.missing.length > 0) {
        toast('info', `Nothing for ${found.missing.join(', ')} on this contact. Fill it in before sending.`)
      }
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const pickFiles = (picked: FileList | null) => {
    const error = attachments.add([...(picked ?? [])])
    if (error) toast('error', error)
  }

  const send = () => {
    setChecked(true)
    if (!mailboxId || !people.ok || subject.trim() === '' || !hasWords || attachments.busy || attachments.failed) return
    setBusy(true)
    void api.mail.compose
      .mutate({
        mailboxId,
        to,
        cc,
        bcc,
        subject: subject.trim(),
        html,
        threadId: threadId ?? null,
        contactId: contactId ?? null,
        attachments: attachments.ready,
      })
      .then((result) => {
        toast(
          'success',
          result.stored ? 'Sent. It is on the record and in the inbox already.' : 'Sent. It is not on a contact, so it is not in the inbox.',
        )
        onSent?.()
        router.refresh()
        forget()
        onClose()
      })
      .catch((cause) => toast('error', errorMessage(cause)))
      .finally(() => setBusy(false))
  }

  return (
    <Modal
      open
      size="lg"
      title={threadId ? `Reply to ${initialTo}` : `Email ${initialTo}`}
      onClose={dismiss}
      onSubmit={send}
      dirty={html !== '' || subject !== (initialSubject ?? '') || attachments.files.length > 0}
      footer={
        mailboxes ? (
          <>
            <Button variant="tertiary" onClick={dismiss}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              busy={busy}
              disabled={!mailboxId || subject.trim() === '' || !hasWords || attachments.busy || attachments.failed}
            >
              Send
            </Button>
          </>
        ) : null
      }
    >
      {!mailboxes ? <Spinner label="Loading mailboxes" /> : null}

      {mailboxes ? (
        <div className="flex flex-col gap-3">
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
              hint:
                box.state === 'revoked'
                  ? 'Access withdrawn. Reconnect it under Inbox Settings.'
                  : box.canSend
                    ? undefined
                    : 'Connected for reading only',
              disabled: !box.canSend || box.state === 'revoked',
            }))}
          />

          <Field label="To" id="compose-to" required error={problem('to')}>
            <TextInput
              id="compose-to"
              required
              value={to}
              onChange={(event) => setTo(event.target.value)}
              onBlur={() => setChecked(true)}
              onKeyDown={noSubmit}
              autoComplete="off"
            />
          </Field>
          <div className="-mt-2 flex items-center justify-end gap-3 text-small font-semibold">
            {showCc ? null : (
              <button type="button" className="text-link hover:underline" onClick={() => setShowCc(true)}>
                Cc
              </button>
            )}
            {showBcc ? null : (
              <button type="button" className="text-link hover:underline" onClick={() => setShowBcc(true)}>
                Bcc
              </button>
            )}
          </div>

          {showCc ? (
            <Field label="Cc" id="compose-cc" error={problem('cc')}>
              <TextInput
                id="compose-cc"
                value={cc}
                onChange={(event) => setCc(event.target.value)}
                onBlur={() => setChecked(true)}
                onKeyDown={noSubmit}
                autoComplete="off"
              />
            </Field>
          ) : null}

          {showBcc ? (
            <Field label="Bcc" id="compose-bcc" error={problem('bcc')}>
              <TextInput
                id="compose-bcc"
                value={bcc}
                onChange={(event) => setBcc(event.target.value)}
                onBlur={() => setChecked(true)}
                onKeyDown={noSubmit}
                autoComplete="off"
              />
            </Field>
          ) : null}

          <Field label="Subject" id="compose-subject" required>
            <TextInput
              id="compose-subject"
              required
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              onKeyDown={noSubmit}
            />
          </Field>

          <div className="flex min-w-0 flex-wrap items-end justify-between gap-2">
            <span className="font-medium">Message</span>
            {templates.length > 0 ? (
              <Select
                aria-label="Insert template"
                value=""
                className="w-auto max-w-full min-w-0"
                onChange={(event) => {
                  if (event.target.value) void insertTemplate(event.target.value)
                }}
              >
                <option value="">Insert template</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
          <RichEditor
            id="compose-body"
            label="Message"
            ref={editor}
            value={html}
            onChange={setHtml}
          />

          <div className="flex min-w-0 flex-col gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                pickFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <Button
                variant="secondary"
                icon={<Paperclip aria-hidden="true" className="size-3.5" />}
                onClick={() => fileInput.current?.click()}
              >
                Attach file
              </Button>
            </div>
            {attachments.files.length > 0 ? (
              <AttachmentList files={attachments.files} onRemove={attachments.remove} />
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
