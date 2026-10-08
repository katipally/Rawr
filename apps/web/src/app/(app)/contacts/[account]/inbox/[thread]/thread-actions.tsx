'use client'

import { Button, Select, useToast } from '@rawr/ui'
import { Archive, ArchiveRestore, Mail, MailOpen, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

type Change = Parameters<typeof api.mail.changeThread.mutate>[0]['change']

/** What somebody can do to one conversation from its header. Every change is saved
 *  here first and reaches Gmail afterwards, so a change is never waiting on Google to
 *  look done. Delete asks nothing and offers Undo instead. */
export const ThreadActions = ({
  threadId,
  folder,
  unread,
  assignedTo,
  assignees,
  backHref,
  canWrite,
}: {
  threadId: string
  folder: 'inbox' | 'archived' | 'trash'
  unread: boolean
  assignedTo: string | null
  assignees: { id: string; label: string }[]
  backHref: string
  canWrite: boolean
}) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const apply = async (change: Change, done: string, leaveThread: boolean, undo?: Change) => {
    setBusy(true)
    try {
      await api.mail.changeThread.mutate({ threadId, change })
      toast('success', done, undo ? { label: 'Undo', run: () => apply(undo, 'Put back.', false) } : undefined)
      if (leaveThread) router.push(backHref)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const button = 'shrink-0'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        className={button}
        busy={busy}
        icon={unread ? <MailOpen aria-hidden="true" className="size-3.5" /> : <Mail aria-hidden="true" className="size-3.5" />}
        onClick={() => void apply({ kind: 'unread', value: !unread }, unread ? 'Marked read.' : 'Marked unread.', false)}
      >
        {unread ? 'Mark read' : 'Mark unread'}
      </Button>
      {canWrite ? (
        <>
          {folder === 'trash' ? (
            <Button
              variant="secondary"
              className={button}
              busy={busy}
              icon={<ArchiveRestore aria-hidden="true" className="size-3.5" />}
              onClick={() => void apply({ kind: 'trashed', value: false }, 'Restored to the Inbox.', true)}
            >
              Restore
            </Button>
          ) : (
            <>
              {folder === 'archived' ? (
                <Button
                  variant="secondary"
                  className={button}
                  busy={busy}
                  icon={<ArchiveRestore aria-hidden="true" className="size-3.5" />}
                  onClick={() => void apply({ kind: 'archived', value: false }, 'Moved back to the Inbox.', true)}
                >
                  Move to Inbox
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  className={button}
                  busy={busy}
                  icon={<Archive aria-hidden="true" className="size-3.5" />}
                  onClick={() => void apply({ kind: 'archived', value: true }, 'Archived.', true, { kind: 'archived', value: false })}
                >
                  Archive
                </Button>
              )}
              <Button
                variant="secondary"
                className={button}
                busy={busy}
                icon={<Trash2 aria-hidden="true" className="size-3.5" />}
                onClick={() => void apply({ kind: 'trashed', value: true }, 'Moved to Trash.', true, { kind: 'trashed', value: false })}
              >
                Delete
              </Button>
            </>
          )}
          <Select
            aria-label="Assign to"
            title="Assign to a teammate"
            className="w-auto max-w-44 truncate"
            value={assignedTo ?? ''}
            disabled={busy}
            onChange={(event) =>
              void apply(
                { kind: 'assignee', value: event.target.value || null },
                event.target.value ? 'Assigned.' : 'Unassigned.',
                false,
              )
            }
          >
            <option value="">Nobody</option>
            {assignees.map((person) => (
              <option key={person.id} value={person.id}>
                {person.label}
              </option>
            ))}
          </Select>
        </>
      ) : (
        <p className="text-small text-secondary">
          Read only for you. Ask someone with edit access to the Inbox to archive, delete or assign.
        </p>
      )}
    </div>
  )
}
