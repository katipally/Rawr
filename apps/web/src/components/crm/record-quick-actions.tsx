'use client'

import { IconButton } from '@rawr/ui'
import { CalendarCheck, CircleCheck, Mail, Phone, StickyNote } from 'lucide-react'
import type { ObjectKey } from '@rawr/db'
import { useNavigation } from '~/components/navigation.tsx'
import { recordPath } from '~/lib/links.ts'

export type RecordQuickActionsProps = {
  workspace: string
  object: string
  recordId: string
  /** Null when this record has no address to write to, which disables Email and
   *  says why rather than offering a button that cannot do anything. */
  email: string | null
  canWrite: boolean
}

/** HubSpot's row of round buttons under a record's name: Note, Email, Call,
 *  Task, Meeting.
 *
 *  None of them own a form. Each is a link into the address that opens the panel
 *  already on this page, so there is one composer, one task form and one compose
 *  dialog, and "log a call on this deal" is a link somebody can be sent. */
export const RecordQuickActions = ({
  workspace,
  object,
  recordId,
  email,
  canWrite,
}: RecordQuickActionsProps) => {
  const { navigate } = useNavigation()

  if (!canWrite) return null

  const go = (params: Parameters<typeof recordPath>[3]) =>
    navigate(recordPath(workspace, object, recordId, { tab: 'activities', ...params }))

  return (
    <div className="flex flex-wrap items-center gap-1">
      <IconButton
        label="Add a note"
        icon={<StickyNote aria-hidden="true" className="size-4" />}
        onClick={() => go({ log: 'note' })}
      />
      <IconButton
        label={email ? `Email ${email}` : 'No email address on this record'}
        icon={<Mail aria-hidden="true" className="size-4" />}
        disabled={!email}
        onClick={() => go({ compose: '1' })}
      />
      <IconButton
        label="Log a call"
        icon={<Phone aria-hidden="true" className="size-4" />}
        onClick={() => go({ log: 'call' })}
      />
      <IconButton
        label="Create a task"
        icon={<CircleCheck aria-hidden="true" className="size-4" />}
        onClick={() => go({ task: 'new' })}
      />
      <IconButton
        label="Log a meeting"
        icon={<CalendarCheck aria-hidden="true" className="size-4" />}
        onClick={() => go({ log: 'meeting' })}
      />
    </div>
  )
}
