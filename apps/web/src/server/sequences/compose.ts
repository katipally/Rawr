import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  claimMailAttachments,
  contactMergeFields,
  directTracking,
  finishMailAttachments,
  isAdmin,
  ingestMessage,
  internalDomainOf,
  isUuid,
  mergeValuesOf,
  readEmailTemplate,
  readMailbox,
  recordDirectSend,
  renderMergeFields,
  trackingBase,
  withAccount,
  type AccountContext,
  type MailFile,
} from '@rawr/db'
import { env } from '~/lib/env.ts'
import { attachmentTotalError, readRecipients } from '~/lib/mail-compose.ts'
import { gmailFetcherFor, sendMail } from '../gmail.ts'
import { describe, logError } from '../log.ts'
import { composedText, sanitiseComposed } from '../mail-html.ts'
import { objectBytes, removeObject } from '../storage.ts'
import { toEmailHtml } from './markdown-email.ts'
import { buildMessage, type Recipient } from './mime.ts'

/** One email, written by hand from somebody's own mailbox.
 *
 *  The same path a sequence step takes, minus the unsubscribe: a reply to one
 *  person is correspondence, and an opt-out footer on it is noise. Opens and
 *  clicks are measured, which is what makes "they read it" available on the
 *  record, but only for a named contact who is allowed to be measured. Mail to
 *  a bare address carries nothing, because there is no one to have asked.
 *
 *  Every message goes out as HTML with a plain-text part beside it. The HTML is
 *  cleaned here before it is sent, and the text is read back out of the cleaned
 *  HTML, so the two parts cannot say different things. */

export type ComposeInput = {
  mailboxId: string
  to: string
  cc?: string | undefined
  bcc?: string | undefined
  subject: string
  /** Plain text, for a caller with no HTML to give. The text part is this, as written,
   *  and the HTML part is the same words under the Markdown the app renders. */
  text?: string | undefined
  /** What the composer wrote. */
  html?: string | undefined
  /** Reply into an existing conversation, keeping its headers. */
  threadId?: string | null | undefined
  /** Who it is about, so it lands on the right record even before the sync
   *  reads it back. */
  contactId?: string | null | undefined
  attachments?: MailFile[] | undefined
}

/** `stored` is false when the sent mail was not kept as a message: the ingest
 *  keeps nothing for a thread with nobody on it who is a contact or at a company
 *  here. The ids are null then. */
export type ComposeResult = { stored: boolean; messageId: string | null; threadId: string | null }

export const compose = async (ctx: AccountContext, input: ComposeInput): Promise<ComposeResult> => {
  const box = await readMailbox(ctx, input.mailboxId)
  if (!box) throw new Error('That mailbox is not connected.')
  if (box.userId !== ctx.actorId && !isAdmin(ctx)) {
    throw new Error('That is somebody else’s mailbox. You can only send from your own.')
  }
  if (box.state === 'revoked') {
    throw new Error(`${box.email} is disconnected. Reconnect it before sending.`)
  }
  if (!box.canSend) {
    throw new Error(`${box.email} was connected for reading only. Reconnect it and allow sending.`)
  }
  if (input.subject.trim() === '') throw new Error('An email needs a subject.')

  const people = readRecipients({ to: input.to, cc: input.cc ?? '', bcc: input.bcc ?? '' })
  if (!people.ok) throw new Error(people.error)
  const { to, cc, bcc } = people.value

  // What the composer wrote is cleaned here. Plain text carries no HTML unless the
  // mail is tracked, which is how every caller that sends plain text has always had it.
  const written = input.html === undefined ? null : sanitiseComposed(input.html)
  const text = written === null ? (input.text ?? '') : composedText(written)
  if (text.trim() === '') throw new Error('Write the message before sending.')

  // The uploads are read from their rows, so a size or a key cannot be claimed by the request.
  const files = await claimMailAttachments(ctx, input.attachments ?? [])
  const tooBig = attachmentTotalError(files.reduce((sum, file) => sum + file.bytes, 0))
  if (tooBig) throw new Error(tooBig)
  const attached = await Promise.all(
    files.map(async (file) => {
      const bytes = await objectBytes(file.storageKey)
      if (bytes.byteLength !== file.bytes) throw new Error(`${file.filename} was not stored whole. Attach it again.`)
      return { filename: file.filename, mime: file.mime, bytes }
    }),
  )

  // Replying: the headers come from the last message in the thread, so the
  // recipient's client threads it rather than starting a new conversation.
  let inReplyTo: string | null = null
  let references: string[] = []
  let providerThreadId: string | null = null

  if (input.threadId && isUuid(input.threadId)) {
    // No row means the thread has no messages, which is the same answer as no
    // thread: nothing to reply to.
    const [row] = await threadHeaders(ctx, input.threadId)
    inReplyTo = row?.internetMessageId ?? null
    references = row?.references ?? []
    providerThreadId = row?.providerThreadId ?? null
  }

  // Asked before the message is built, because whether its links and opens are
  // measured decides what the HTML carries.
  const tracking = input.contactId && isUuid(input.contactId) ? await directTracking(ctx, input.contactId) : null
  const base = tracking?.allowed ? trackingBase(tracking, env.AUTH_URL) : null
  const sendToken = base ? randomUUID().replaceAll('-', '') : null
  const html = written ?? (base ? toEmailHtml(text) : null)

  const built = buildMessage({
    from: { name: box.email.split('@')[0] ?? 'Rawr', address: box.email },
    to,
    cc,
    bcc,
    subject: input.subject,
    text,
    html,
    attachments: attached,
    inReplyTo,
    references: inReplyTo ? [...references, inReplyTo] : references,
    trackingBase: base,
    sendToken,
  })

  const fetcher = await gmailFetcherFor(ctx, box.id)
  const sent = await sendMail(fetcher, {
    raw: built.raw,
    threadId: providerThreadId,
    internetMessageId: built.internetMessageId,
  })

  // The bytes are in Gmail's Sent copy now, and the uploads are spent. Neither is
  // needed again, so both go. A file that could not be removed keeps its row, and
  // the attachment sweep removes it later.
  const spent = await finishMailAttachments(ctx, files.map((file) => file.storageKey), removeObject)
  for (const failure of spent.failed) {
    logError({ msg: 'a sent attachment could not be removed from storage', error: describe(failure.error) })
  }

  // The mail is out, and Gmail takes no idempotency key: an error from here on
  // would show the sender a failure and invite a second send. So what follows is
  // best effort, and the next sync stores the copy if this could not.
  //
  // Stored the way an incoming message is, so it is on the record and in the
  // inbox now rather than whenever the next sync happens to run. Bcc is not kept:
  // the message has no place for it, and the sender's own Sent copy in Gmail has it.
  const stored = sent.id
    ? await ingestMessage(ctx, {
        incoming: {
          providerThreadId: providerThreadId ?? sent.threadId ?? sent.id,
          providerMessageId: sent.id,
          subject: input.subject,
          from: box.email,
          to: to.map(address),
          cc: cc.map(address),
          sentAt: new Date(),
          snippet: text.slice(0, 200),
          internetMessageId: built.internetMessageId,
          inReplyTo,
          references,
          body: { text, html: written },
          attachments: files.map((file) => ({
            filename: file.filename,
            mimeType: file.mime,
            sizeBytes: file.bytes,
            providerAttachmentId: null,
            inline: false,
          })),
          hasAttachments: files.length > 0,
        },
        ownerEmail: box.email,
        mailboxId: box.id,
        internalDomain: await internalDomainOf(ctx),
        blocked: new Set(),
      }).catch((cause) => {
        logError({ msg: 'a sent mail could not be stored', error: describe(cause) })
        return null
      })
    : null

  if (stored?.stored && stored.createdContactIds.length > 0) {
    // Loaded here, not at the top: record-events reaches next/server through automations, which plain Node unit tests cannot load.
    const { recordsCreated } = await import('../record-events.ts')
    await recordsCreated(ctx, 'contact', stored.createdContactIds)
  }

  // After the stored copy, so the row can point at it and the timeline shows the
  // opens against the message the sender can actually see.
  if (sendToken && input.contactId) {
    await recordDirectSend(ctx, {
      contactId: input.contactId,
      mailboxId: box.id,
      providerMessageId: sent.id ?? null,
      internetMessageId: built.internetMessageId,
      messageId: stored?.stored ? stored.messageId : null,
      token: sendToken,
      links: built.links,
    }).catch((cause) => logError({ msg: 'a sent mail could not be tracked', error: describe(cause) }))
  }

  return {
    stored: stored?.stored === true,
    messageId: stored?.stored ? stored.messageId : null,
    threadId: stored?.stored ? stored.threadId : null,
  }
}

const address = (recipient: Recipient): string => recipient.address

/** A saved template with its merge fields filled from the contact it is going to,
 *  as the HTML the composer takes. `missing` names the fields that had no value, so
 *  the composer can say so rather than send "Hi ,". */
export const templateForCompose = async (
  ctx: AccountContext,
  input: { templateId: string; mailboxId: string; contactId: string | null },
): Promise<{ subject: string; html: string; missing: string[] }> => {
  const template = await readEmailTemplate(ctx, input.templateId)
  if (!template) throw new Error('That template is no longer here.')
  const box = await readMailbox(ctx, input.mailboxId)
  if (!box) throw new Error('That mailbox is not connected.')
  if (box.userId !== ctx.actorId && !isAdmin(ctx)) {
    throw new Error('That is somebody else’s mailbox. You can only send from your own.')
  }
  const person = input.contactId && isUuid(input.contactId) ? await contactMergeFields(ctx, input.contactId) : null
  const values = mergeValuesOf({
    firstName: person?.firstName ?? null,
    lastName: person?.lastName ?? null,
    email: person?.email ?? null,
    company: person?.company ?? null,
    senderEmail: box.email,
    sequenceName: null,
  })
  const subject = renderMergeFields(template.subject, values)
  const body = renderMergeFields(template.bodyText, values)
  return {
    subject: subject.text,
    html: sanitiseComposed(toEmailHtml(body.text)),
    missing: [...new Set([...subject.missing, ...body.missing])],
  }
}

/** A file taken off the composer, or abandoned on it. Only an upload this person
 *  began is removed, so a key cannot be used to delete somebody else's bytes. */
export const discardMailAttachment = async (ctx: AccountContext, storageKey: string): Promise<void> => {
  if (!storageKey.startsWith(`${ctx.accountId}/`)) throw new Error('That file does not belong to this account.')
  const spent = await finishMailAttachments(ctx, [storageKey], removeObject)
  for (const failure of spent.failed) {
    logError({ msg: 'a discarded attachment could not be removed from storage', error: describe(failure.error) })
  }
}

/** The threading headers of the newest message in a conversation. */
const threadHeaders = async (
  ctx: AccountContext,
  threadId: string,
): Promise<{ internetMessageId: string | null; references: string[]; providerThreadId: string | null }[]> => {
  return withAccount(ctx, (tx) =>
    tx.execute<{ internetMessageId: string | null; references: string[]; providerThreadId: string | null }>(sql`
      select m.internet_message_id as "internetMessageId",
             m.references as "references",
             t.provider_thread_id as "providerThreadId"
        from message m
        join message_thread t on t.id = m.thread_id
       where m.thread_id = ${threadId}::uuid
       order by m.sent_at desc
       limit 1
    `),
  )
}
