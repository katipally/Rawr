'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { api } from '~/lib/rpc.ts'

/** Marks the thread read, once, when somebody actually opens it. A deliberate
 *  call rather than a side effect of the server read, so a background refresh or
 *  a preview cannot clear somebody's unread count for them. Failing is silent:
 *  nobody needs a toast because a read receipt did not save. */
export const ThreadRead = ({ threadId }: { threadId: string }) => {
  const router = useRouter()
  useEffect(() => {
    // Refreshed once it lands, or the unread count beside the list keeps
    // counting a thread the reader is looking at.
    void api.mail.markRead.mutate({ threadId }).then(() => router.refresh()).catch(() => {})
  }, [threadId, router])
  return null
}
