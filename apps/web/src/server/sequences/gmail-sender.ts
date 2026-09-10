import { randomUUID } from 'node:crypto'
import { trackingBase, type ClaimedRun, type AccountContext } from '@rawr/db'
import { env } from '~/lib/env.ts'
import { gmailFetcherFor } from '../gmail.ts'
import { buildMessage } from './mime.ts'
import type { OutgoingStep, Sender, SentMessage } from './sender.ts'

/** Sending from the member's own mailbox.
 *
 *  This is the reason sequences are in-house: the mail comes from the person the
 *  prospect already knows, lands in the same conversation as everything else, is
 *  read back by the same sync, and stops the moment a reply arrives through it. */
export const gmailSender: Sender = {
  name: 'gmail',
  send: async (ctx: AccountContext, run: ClaimedRun, step: OutgoingStep): Promise<SentMessage> => {
    const sendToken = randomUUID().replaceAll('-', '')
    const base = trackingBase(run, env.AUTH_URL)

    const built = buildMessage({
      from: { name: run.mailboxEmail.split('@')[0] ?? 'Rawr', address: run.mailboxEmail },
      to: run.contactEmail,
      subject: step.subject,
      text: step.text,
      html: step.html,
      inReplyTo: step.inReplyTo,
      references: step.references,
      trackingBase: base,
      unsubscribeToken: run.unsubscribeToken,
      sendToken,
      // The sequence says whether to measure; the recipient says whether they may
      // be measured. Both have to agree, and the recipient is the one who can veto.
      trackOpens: run.settings.trackOpens && run.trackingAllowed,
      trackClicks: run.settings.trackClicks && run.trackingAllowed,
    })

    const fetcher = await gmailFetcherFor(ctx, run.mailboxId)
    const sent = (await fetcher('/messages/send', undefined, {
      method: 'POST',
      body: JSON.stringify({
        raw: built.raw,
        // Gmail threads on its own id, not on the headers. The header is what the
        // recipient's client threads on; this is what keeps the sender's own copy
        // in the same conversation.
        ...(run.providerThreadId && step.inReplyTo ? { threadId: run.providerThreadId } : {}),
      }),
    })) as { id?: string; threadId?: string }

    return {
      providerMessageId: sent.id ?? null,
      internetMessageId: built.internetMessageId,
      links: built.links,
      sendToken,
    }
  },
}

/** Whether sending is possible at all right now, so the runner can say why rather
 *  than failing at the last moment. */
export const canSendFrom = (run: ClaimedRun): string | null => {
  // No exception for the development switch. The stand-in mailbox is stored with
  // sending already granted, so the only mailbox the old exception let through
  // was a real one connected read-only, which then failed at Google instead of
  // here where somebody could read the reason.
  if (!run.mailboxCanSend) {
    return `${run.mailboxEmail} was connected for reading only. Reconnect it and allow sending.`
  }
  return null
}
