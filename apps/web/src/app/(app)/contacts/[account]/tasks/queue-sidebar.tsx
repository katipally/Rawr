'use client'

import { Button, IconButton, Modal, RenamePrompt, TextInput, cn, useToast } from '@rawr/ui'
import { Pencil, Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { tasksPath, type TaskView } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

export type QueueRow = { id: string; name: string; openCount: number }

export type QueueSidebarProps = {
  account: string
  queues: QueueRow[]
  /** A queue id, 'none', or undefined for every task whatever list it is in. */
  current?: string | undefined
  /** Carried into every link so switching queue keeps the view and the search. */
  keep: { view: TaskView; mine?: '1'; q?: string; type?: string }
  canWrite: boolean
}

const row =
  'flex min-h-9 items-center gap-2 rounded-control px-3 text-body no-underline hover:bg-fill'

/** The named lists a rep works top to bottom, and the two that are not lists:
 *  everything, and the tasks nobody filed. Scrolls on its own so a hundred
 *  queues never push the table off the screen. */
export const QueueSidebar = ({ account, queues, current, keep, canWrite }: QueueSidebarProps) => {
  const router = useRouter()
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<QueueRow | null>(null)
  const [removing, setRemoving] = useState<QueueRow | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>, done: string, after: () => void) => {
    setBusy(true)
    try {
      await fn()
      toast('success', done)
      after()
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const href = (queue?: string) => tasksPath(account, { ...keep, ...(queue ? { queue } : {}) })

  return (
    <nav aria-label="Task queues" className="flex min-h-0 w-full shrink-0 flex-col gap-1 sm:w-56">
      <div className="flex items-center justify-between gap-2 px-3">
        <h2 className="text-small font-semibold text-secondary">Queues</h2>
        {canWrite ? (
          <IconButton label="Create queue" icon={<Plus size={16} />} onClick={() => setAdding(true)} />
        ) : null}
      </div>

      <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        <li>
          <Link href={href()} className={cn(row, !current && 'bg-fill-hover font-medium')}>
            All queues
          </Link>
        </li>
        <li>
          <Link href={href('none')} className={cn(row, current === 'none' && 'bg-fill-hover font-medium')}>
            No queue
          </Link>
        </li>
        {queues.map((queue) => (
          <li key={queue.id} className="group flex items-center gap-1">
            <Link
              href={href(queue.id)}
              className={cn(row, 'min-w-0 flex-1', current === queue.id && 'bg-fill-hover font-medium')}
            >
              <span className="min-w-0 flex-1 truncate">{queue.name}</span>
              <span className="shrink-0 text-small text-secondary">{queue.openCount.toLocaleString()}</span>
            </Link>
            {canWrite ? (
              <>
                <IconButton label={`Rename ${queue.name}`} icon={<Pencil size={16} />} onClick={() => setRenaming(queue)} />
                <IconButton
                  label={`Delete ${queue.name}`}
                  tone="destructive"
                  icon={<ACTION_ICONS.delete size={16} />}
                  onClick={() => setRemoving(queue)}
                />
              </>
            ) : null}
          </li>
        ))}
      </ul>

      <Modal open={adding} title="Create queue" onClose={() => setAdding(false)}>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void run(() => api.crm.tasks.queues.create.mutate({ name }), 'Queue created.', () => {
              setName('')
              setAdding(false)
            })
          }}
        >
          <TextInput
            value={name}
            data-autofocus
            maxLength={120}
            aria-label="Queue name"
            placeholder="Monday calls"
            onChange={(event) => setName(event.target.value)}
            className="min-w-40 flex-1"
          />
          <Button type="submit" variant="primary" busy={busy} disabled={name.trim() === ''}>
            Create
          </Button>
        </form>
      </Modal>

      <RenamePrompt
        value={renaming?.name ?? null}
        label="Queue name"
        title="Rename queue"
        busy={busy}
        onCancel={() => setRenaming(null)}
        onRename={(next) =>
          void run(
            () => api.crm.tasks.queues.rename.mutate({ id: renaming!.id, name: next }),
            'Queue renamed.',
            () => setRenaming(null),
          )
        }
      />

      <Modal
        open={removing !== null}
        title={`Delete ${removing?.name ?? 'queue'}?`}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setRemoving(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() =>
                void run(
                  () => api.crm.tasks.queues.remove.mutate({ id: removing!.id }),
                  'Queue deleted.',
                  () => setRemoving(null),
                )
              }
            >
              Delete queue
            </Button>
          </>
        }
      >
        <p>
          The {removing?.openCount.toLocaleString() ?? 0} open{' '}
          {removing?.openCount === 1 ? 'task' : 'tasks'} in it go back to no queue. Nothing is deleted
          but the list itself.
        </p>
      </Modal>
    </nav>
  )
}
