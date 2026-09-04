'use server'

import { enrollmentWorkspaceForToken, publicEdgeContext, unsubscribeByToken } from '@rawr/db'
import { redirect } from 'next/navigation'

/** Recording the opt-out. Idempotent, because a mail client that prefetches the
 *  one-click URL must not produce two different answers, and because somebody
 *  pressing the button twice has not asked for anything different. */
export const unsubscribeAction = async (form: FormData): Promise<void> => {
  const token = String(form.get('token') ?? '')
  const workspaceId = token ? await enrollmentWorkspaceForToken(token) : null
  if (workspaceId) {
    await unsubscribeByToken({ ...publicEdgeContext(workspaceId), actorKind: 'public' }, token)
  }
  // The same page either way: whether the token was known is not a stranger's
  // business, and saying so would turn this into a token oracle.
  redirect(`/u/${encodeURIComponent(token)}?done=1`)
}
