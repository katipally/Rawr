'use client'

import { Button } from '@rawr/ui'
import { Reply, ReplyAll } from 'lucide-react'
import { useState } from 'react'
import { ComposeDialog } from '~/components/crm/compose-dialog.tsx'

/** Replying into this conversation, from your own mailbox. The reply carries the
 *  thread's headers, so it lands in the same conversation for the recipient as
 *  well as for us. Reply all copies everyone else on the newest message, with our
 *  own addresses already taken out by the page that computed it. */
export const ReplyButton = ({
  account,
  threadId,
  subject,
  sender,
  everyone,
  personId,
}: {
  account: string
  threadId: string
  subject: string | null
  sender: string
  everyone: { to: string; cc: string }
  personId: string | null
}) => {
  const [mode, setMode] = useState<'sender' | 'all' | null>(null)
  const recipients = mode === 'all' ? everyone : { to: sender, cc: '' }

  return (
    <>
      <Button variant="secondary" className="shrink-0" icon={<Reply aria-hidden="true" className="size-3.5" />} onClick={() => setMode('sender')}>
        Reply
      </Button>
      <Button variant="secondary" className="shrink-0" icon={<ReplyAll aria-hidden="true" className="size-3.5" />} onClick={() => setMode('all')}>
        Reply all
      </Button>
      {mode ? (
        <ComposeDialog
          account={account}
          to={recipients.to}
          cc={recipients.cc}
          subject={subject?.toLowerCase().startsWith('re:') ? subject : `Re: ${subject ?? '(no subject)'}`}
          threadId={threadId}
          personId={personId}
          onClose={() => setMode(null)}
        />
      ) : null}
    </>
  )
}
