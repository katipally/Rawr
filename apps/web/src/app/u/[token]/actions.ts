'use server'

import {
  confirmSubscription,
  enrollmentAccountForToken,
  publicEdgeContext,
  subscriptionAccountForToken,
  unsubscribeByToken,
} from '@rawr/db'
import { redirect } from 'next/navigation'

/** Recording the opt-out. Idempotent, because a mail client that prefetches the
 *  one-click URL must not produce two different answers, and because somebody
 *  pressing the button twice has not asked for anything different. */
export const unsubscribeAction = async (form: FormData): Promise<void> => {
  const token = String(form.get('token') ?? '')
  const accountId = token ? await enrollmentAccountForToken(token) : null
  if (accountId) {
    await unsubscribeByToken({ ...publicEdgeContext(accountId), actorKind: 'public' }, token)
  }
  // The same page either way: whether the token was known is not a stranger's
  // business, and saying so would turn this into a token oracle.
  redirect(`/u/${encodeURIComponent(token)}?done=1`)
}

/** Recording the opt-in. A POST for the reason the unsubscribe is one: a mail
 *  client that prefetches links must not be able to subscribe somebody, and the
 *  token is cleared by the update itself, so pressing twice confirms once. */
export const confirmAction = async (form: FormData): Promise<void> => {
  const token = String(form.get('token') ?? '')
  const accountId = token ? await subscriptionAccountForToken(token) : null
  if (accountId) {
    await confirmSubscription({ ...publicEdgeContext(accountId), actorKind: 'public' }, token)
  }
  // The same page either way, so this cannot be used to test tokens.
  redirect(`/u/${encodeURIComponent(token)}?done=1`)
}
