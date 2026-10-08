'use client'

import { Button, DataTable, EmptyState, IconButton, Modal, RenamePrompt, TextInput, useToast, type Column } from '@rawr/ui'
import { Pencil, Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { tasksPath } from '~/lib/links.ts'
import { queueDeleteCopy } from '~/lib/task-copy.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useFormat } from '~/components/zone.tsx'

export type QueueRow = { id: string; name: string; openCount: number }

export type QueueManagerProps = {
  account: string
  queues: QueueRow[]
  canWrite: boolean
}

/** HubSpot's Task queues page: the named lists a rep works top to bottom, each
 *  one a link to its tasks, with create, rename and delete beside them. */
export const QueueManager = ({ account, queues, canWrite }: QueueManagerProps) => {
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<QueueRow | null>(null)
  const [removing, setRemoving] = useState<QueueRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  /** Queues created here, kept until router.refresh brings them back from the
   *  server: the round trip is long enough that a new queue looked like it had
   *  not been created. */
  const [created, setCreated] = useState<QueueRow[]>([])

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

  const needle = query.trim().toLowerCase()
  const shown = [...queues, ...created.filter((queue) => !queues.some((row) => row.id === queue.id))].filter(
    (queue) => queue.name.toLowerCase().includes(needle),
  )

  const columns: Column<QueueRow>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 360,
      render: (queue) => (
        <Link href={tasksPath(account, { queue: queue.id })} className="block truncate">
          {queue.name}
        </Link>
      ),
    },
    { key: 'open', header: 'Open tasks', width: 160, render: (queue) => fmt.number(queue.openCount) },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: '',
            width: 96,
            render: (queue: QueueRow) => (
              <span className="flex items-center gap-1">
                <IconButton label={`Rename ${queue.name}`} icon={<Pencil size={16} />} onClick={() => setRenaming(queue)} />
                <IconButton
                  label={`Delete ${queue.name}`}
                  tone="destructive"
                  icon={<ACTION_ICONS.delete size={16} />}
                  onClick={() => setRemoving(queue)}
                />
              </span>
            ),
          },
        ]
      : []),
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full min-w-0 @lg:w-[13.375rem]">
          <TextInput
            type="search"
            value={query}
            aria-label="Search task queues"
            placeholder="Search task queues"
            onChange={(event) => setQuery(event.target.value)}
            className="h-control min-h-0 rounded-pill border-line-strong bg-surface py-1 pr-10 pl-4"
          />
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2" />
        </div>
        {canWrite ? (
          <Button variant="primary" className="ml-auto" onClick={() => setAdding(true)}>
            Create task queue
          </Button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={shown}
        rowKey={(queue) => queue.id}
        caption="Task queues"
        storageKey="task-queues"
        fill
        empty={
          <div className="flex flex-1 flex-col justify-center">
            <EmptyState
              title={needle ? 'No queue matches' : 'No queues yet.'}
              {...(needle ? {} : { description: 'A queue is a named list of tasks somebody works through, like Monday calls.' })}
            />
          </div>
        }
      />

      <Modal
        open={adding}
        title="Create task queue"
        onClose={() => setAdding(false)}
        dirty={name !== ''}
        onSubmit={() => {
          const wanted = name.trim()
          void run(
            async () => {
              const { id } = await api.crm.tasks.queues.create.mutate({ name: wanted })
              setCreated((current) => [...current, { id, name: wanted, openCount: 0 }])
            },
            'Queue created.',
            () => {
              setName('')
              setAdding(false)
            },
          )
        }}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={name.trim() === ''}>
              Create
            </Button>
          </>
        }
      >
        <TextInput
          value={name}
          data-autofocus
          maxLength={120}
          aria-label="Queue name"
          placeholder="Monday calls"
          onChange={(event) => setName(event.target.value)}
        />
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
                  () => {
                    setCreated((current) => current.filter((queue) => queue.id !== removing!.id))
                    setRemoving(null)
                  },
                )
              }
            >
              Delete queue
            </Button>
          </>
        }
      >
        <p>{queueDeleteCopy(removing?.openCount ?? 0, fmt.number)}</p>
      </Modal>
    </div>
  )
}
