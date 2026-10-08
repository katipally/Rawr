'use client'

import type { SequenceRow } from '@rawr/db'
import { Button, ConfirmDialog, DropdownMenu, RenamePrompt, useToast, type MenuGroup } from '@rawr/ui'
import { ChevronDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { rowPill } from '~/components/row-actions.tsx'
import { sequencePath, sequencesPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

/** Rename, copy, archive, restore and delete, in the one menu the list row and
 *  the sequence's own header both open. */
export const SequenceActions = ({
  account,
  sequence,
  inRow = false,
}: {
  account: string
  sequence: SequenceRow
  inRow?: boolean
}) => {
  const router = useRouter()
  const toast = useToast()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const archived = sequence.state === 'archived'
  const hasRun = sequence.stats.enrolled > 0

  const run = async (work: () => Promise<void>, done: string) => {
    setBusy(true)
    try {
      await work()
      toast('success', done)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const setState = (state: 'paused' | 'archived', done: string) =>
    run(async () => {
      await api.sequences.setState.mutate({ id: sequence.id, state })
      router.refresh()
    }, done)

  const archivedNote =
    sequence.sender === 'woodpecker'
      ? 'Archived. People already handed to Woodpecker keep getting mail there, so stop the campaign in Woodpecker.'
      : 'Archived. Its people are paused, and nothing more goes out.'

  const groups: MenuGroup[] = [
    {
      key: 'edit',
      items: [
        { key: 'rename', label: 'Rename', onSelect: () => setRenaming(true) },
        {
          key: 'duplicate',
          label: 'Duplicate',
          onSelect: () =>
            void run(async () => {
              const copy = await api.sequences.duplicate.mutate({ id: sequence.id })
              router.push(sequencePath(account, copy.id))
            }, 'Copied. The copy is a draft, so nothing sends until you turn it on.'),
        },
      ],
    },
    {
      key: 'state',
      items: archived
        ? [{ key: 'restore', label: 'Restore', onSelect: () => void setState('paused', 'Restored and paused. Turn it on when you are ready.') }]
        : [{ key: 'archive', label: 'Archive', onSelect: () => void setState('archived', archivedNote) }],
    },
    {
      key: 'delete',
      items: [
        {
          key: 'delete',
          label: 'Delete',
          destructive: true,
          disabled: hasRun,
          description: hasRun ? 'People have been in it. Archive it instead.' : undefined,
          onSelect: () => setDeleting(true),
        },
      ],
    },
  ]

  return (
    <>
      <DropdownMenu
        label={`Actions for ${sequence.name}`}
        align={inRow ? 'start' : 'end'}
        groups={groups}
        trigger={(props) =>
          inRow ? (
            <button {...props} type="button" className={rowPill}>
              Actions
              <ChevronDown aria-hidden="true" className="size-3" />
            </button>
          ) : (
            <Button {...props} icon={<ChevronDown aria-hidden="true" className="size-3.5" />}>
              Actions
            </Button>
          )
        }
      />

      <RenamePrompt
        value={renaming ? sequence.name : null}
        label="Name"
        title="Rename sequence"
        busy={busy}
        onCancel={() => setRenaming(false)}
        onRename={(name) =>
          void run(async () => {
            await api.sequences.save.mutate({ id: sequence.id, name })
            setRenaming(false)
            router.refresh()
          }, 'Renamed.')
        }
      />

      <ConfirmDialog
        open={deleting}
        title={`Delete “${sequence.name}”?`}
        confirm="Delete"
        busy={busy}
        onCancel={() => setDeleting(false)}
        onConfirm={() =>
          void run(async () => {
            await api.sequences.delete.mutate({ id: sequence.id })
            setDeleting(false)
            router.push(sequencesPath(account))
          }, 'Deleted.')
        }
      >
        <p>The steps go with it. This cannot be undone.</p>
      </ConfirmDialog>
    </>
  )
}
