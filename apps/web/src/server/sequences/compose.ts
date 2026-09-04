import {
  ingestMessage,
  internalDomainOf,
  isUuid,
  readMailbox,
  readThread,
  type WorkspaceContext,
} from '@rawr/db'
import { gmailFetcherFor } from '../gmail.ts'
import { buildMessage } from './mime.ts'

/** One email, sent by hand from somebody's own mailbox.
 *
 *  The same path a sequence step takes, minus everything a sequence adds: no
 *  pixel, no rewritten links, no unsubscribe footer. A person writing to one
 *  person is correspondence, not outreach, and instrumenting it would be
 *  surveillance of a colleague rather than measurement of a campaign. */

export type ComposeInput = {
  mailboxId: string
  to: string
  subject: string
  text: string
  /** Reply into an existing conversation, keeping its headers. */
  threadId?: string | null | undefined
  /** Who it is about, so it lands on the right record even before the sync
   *  reads it back. */
  contactId?: string | null | undefined
}

export type ComposeResult = { messageId: string | null; threadId: string | null }

export const compose = async (ctx: WorkspaceContext, input: ComposeInput): Promise<ComposeResult> => {
  const box = await readMailbox(ctx, input.mailboxId)
  if (!box) throw new Error('That mailbox is not connected.')
  if (box.userId !== ctx.actorId && ctx.role !== 'admin') {
    throw new Error('That is somebody else’s mailbox. You can only send from your own.')
  }
  if (box.state === 'revoked') {
    throw new Error(`${box.email} is disconnected. Reconnect it before sending.`)
  }
  if (!box.canSend) {
    throw new Error(`${box.email} was connected for reading only. Reconnect it and allow sending.`)
  }
  if (input.subject.trim() === '') throw new Error('An email needs a subject.')

  // Replying: the headers come from the last message in the thread, so the
  // recipient's client threads it rather than starting a new conversation.
  let inReplyTo: string | null = null
  let references: string[] = []
  let providerThreadId: string | null = null

  if (input.threadId && isUuid(input.threadId)) {
    const found = await readThread(ctx, input.threadId)
    const last = found?.messages[found.messages.length - 1]
    if (last) {
      const [row] = await threadHeaders(ctx, input.threadId)
      inReplyTo = row?.internetMessageId ?? null
      references = row?.references ?? []
      providerThreadId = row?.providerThreadId ?? null
    }
  }

  const built = buildMessage({
    from: { name: box.email.split('@')[0] ?? 'Rawr', address: box.email },
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: null,
    inReplyTo,
    references: inReplyTo ? [...references, inReplyTo] : references,
  })

  const fetcher = await gmailFetcherFor(ctx, box.id)
  const sent = (await fetcher('/messages/send', undefined, {
    method: 'POST',
    body: JSON.stringify({
      raw: built.raw,
      ...(providerThreadId ? { threadId: providerThreadId } : {}),
    }),
  })) as { id?: string; threadId?: string }

  // Stored the way an incoming message is, so it is on the record and in the
  // inbox now rather than whenever the next sync happens to run.
  const stored = sent.id
    ? await ingestMessage(ctx, {
        incoming: {
          providerThreadId: providerThreadId ?? sent.threadId ?? sent.id,
          providerMessageId: sent.id,
          subject: input.subject,
          from: box.email,
          to: [input.to],
          cc: [],
          sentAt: new Date(),
          snippet: input.text.slice(0, 200),
          internetMessageId: built.internetMessageId,
          inReplyTo,
          references,
          body: { text: input.text },
          hasAttachments: false,
        },
        ownerEmail: box.email,
        mailboxId: box.id,
        internalDomain: await internalDomainOf(ctx),
        blocked: new Set(),
      })
    : null

  return {
    messageId: stored?.stored ? stored.messageId : null,
    threadId: stored?.stored ? stored.threadId : null,
  }
}

/** The threading headers of the newest message in a conversation. */
const threadHeaders = async (
  ctx: WorkspaceContext,
  threadId: string,
): Promise<{ internetMessageId: string | null; references: string[]; providerThreadId: string | null }[]> => {
  const { withWorkspace } = await import('@rawr/db')
  const { sql } = await import('drizzle-orm')
  return withWorkspace(ctx, (tx) =>
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
