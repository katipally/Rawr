import { listMailboxes, systemContext } from '@rawr/db'
import { publicBaseUrl } from '~/lib/env.ts'
import { compose } from './sequences/compose.ts'

/** The mail that turns a ticked box into consent.
 *
 *  Through the same composer a sequence step uses, so there is one place that
 *  holds a Google credential. From the account's first sending mailbox rather than
 *  anybody's in particular: a form fill has no owner yet, and the point of the
 *  mail is the link in it, not who it is from.
 *
 *  Never tracked. Asking somebody to confirm they want to hear from us and
 *  measuring whether they opened it is the wrong shape, so no contact is named to
 *  the composer and the message goes out as plain text. */

export type PendingConfirmation = {
  token: string
  typeName: string
  contactEmail: string
  contactFirstName: string | null
}

export const sendOptInConfirmation = async (
  accountId: string,
  pending: PendingConfirmation,
): Promise<{ sent: boolean }> => {
  const ctx = systemContext(accountId)
  const box = (await listMailboxes(ctx)).find((each) => each.canSend && each.state !== 'revoked')
  // Nothing to send from. The request stands and the token keeps working, so
  // connecting a mailbox and asking again costs nothing.
  if (!box) return { sent: false }

  const greeting = pending.contactFirstName?.trim() ? `Hello ${pending.contactFirstName.trim()},` : 'Hello,'
  const text = [
    greeting,
    '',
    `Please confirm that you would like to receive ${pending.typeName}.`,
    '',
    `${publicBaseUrl}/u/${pending.token}`,
    '',
    'If you did not ask for this, ignore this message and nothing will be sent.',
  ].join('\n')

  await compose(ctx, {
    mailboxId: box.id,
    to: pending.contactEmail,
    subject: `Confirm your subscription to ${pending.typeName}`,
    text,
  })
  return { sent: true }
}
