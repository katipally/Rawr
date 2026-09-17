'use client'

import { Button } from '@rawr/ui'
import { Reply } from 'lucide-react'
import { useState } from 'react'
import { ComposeDialog } from '~/components/crm/compose-dialog.tsx'

/** Replying into this conversation, from your own mailbox. The reply carries the
 *  thread's headers, so it lands in the same conversation for the recipient as
 *  well as for us. */
export const ReplyButton = ({
  account,
  threadId,
  to,
  subject,
}: {
  account: string
  threadId: string
  to: string
  subject: string | null
}) => {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Reply aria-hidden="true" className="size-4" />
        Reply
      </Button>
      {open ? (
        <ComposeDialog
          account={account}
          to={to}
          subject={subject?.toLowerCase().startsWith('re:') ? subject : `Re: ${subject ?? '(no subject)'}`}
          threadId={threadId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
