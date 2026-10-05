'use client'

import { Button, EmptyState, IconButton, Modal, cn, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { recordPath } from '~/lib/links.ts'
import { useOnChange } from '~/lib/record-events.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { replaceParams } from '~/lib/url-params.ts'
import { TASK_TYPE_LABELS, type TaskPriority, type TaskType } from './task-labels.ts'
import { formatDate, isPast } from './value.tsx'
import { useZone } from '~/components/zone.tsx'

export type TaskRow = {
  id: string
  title: string
  body: string | null
  type: TaskType
  priority: TaskPriority
  dueDate: string | null
  remindAt: Date | string | null
  queueId: string | null
  queueName: string | null
  status: 'open' | 'done'
  assigneeId: string | null
  assigneeName: string | null
  /** An object key, core or invented. Null for a task that hangs on nothing. */
  entityType: string | null
  entityId: string | null
  entityName: string | null
  /** When it was read, sent back with an edit so a task changed since is refused. */
  updatedAt: Date | string
}

export type TasksPanelProps = {
  account: string
  rows: TaskRow[]
  /** Set on a record page, so a new task is filed against that record. */
  entity?: { entityType: string; entityId: string }
  canWrite: boolean
  /** Rendered as a boxed panel on a record, and bare on the tasks page. */
  heading?: string
}

export const TasksPanel = ({
  account,
  rows,
  entity,
  canWrite,
  heading = 'Tasks',
}: TasksPanelProps) => {
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<TaskRow | null>(null)
  // Tasks read again after one was added, held with the rows they replace so a
  // fresh render from the server takes over as soon as there is one.
  const [fresh, setFresh] = useState<{ since: TaskRow[]; rows: TaskRow[] } | null>(null)
  const shown = fresh?.since === rows ? fresh.rows : rows

  useOnChange('tasks', () => {
    if (!entity) return
    api.crm.tasks.list
      .query({ entity })
      .then((list) => setFresh({ since: rows, rows: list }))
      .catch((cause) => toast('error', errorMessage(cause)))
  })

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast('success', done)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const open = shown.filter((row) => row.status === 'open')
  const done = shown.filter((row) => row.status === 'done')

  return (
    <section className="rounded-panel border border-line bg-surface shadow-panel">
      <h2 className="px-6 pt-6 pb-4 text-base font-semibold">
        {heading} ({open.length} open)
      </h2>

      {canWrite ? (
        <div className="border-b border-divider px-6 py-2">
          <Button onClick={() => replaceParams({ task: 'new', log: null })}>Add task</Button>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState
          title="No tasks"
          description={
            canWrite
              ? 'Add one above. Overdue tasks are what the Monday list is built from.'
              : 'Nothing has been assigned here yet.'
          }
        />
      ) : (
        <ul className="flex flex-col">
          {[...open, ...done].map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 border-b border-divider px-6 py-2 last:border-0"
            >
              <input
                type="checkbox"
                checked={row.status === 'done'}
                disabled={!canWrite || busy}
                aria-label={`Mark “${row.title}” ${row.status === 'done' ? 'not done' : 'done'}`}
                onChange={(event) =>
                  void run(
                    () =>
                      api.crm.tasks.setStatus.mutate({
                        id: row.id,
                        status: event.target.checked ? 'done' : 'open',
                      }),
                    event.target.checked ? 'Marked done.' : 'Reopened.',
                  )
                }
              />

              <span className="min-w-0 flex-1">
                <span className={cn('block break-words', row.status === 'done' && 'text-secondary line-through')}>
                  {row.title}
                </span>
                <span className="block text-small text-secondary">
                  {TASK_TYPE_LABELS[row.type]}
                  {row.priority === 'high' ? ' · High priority' : ''}
                  {row.queueName ? ` · ${row.queueName}` : ''}
                </span>
                {row.body ? (
                  <span className="block whitespace-pre-wrap break-words text-small text-secondary">
                    {row.body}
                  </span>
                ) : null}
                <span className="block text-small text-secondary">
                  {row.dueDate ? (
                    <span className={cn(row.status === 'open' && isPast(row.dueDate) && 'font-medium text-error')}>
                      {formatDate(row.dueDate, zone)}
                    </span>
                  ) : (
                    'No due date'
                  )}
                  {row.assigneeName ? ` · ${row.assigneeName}` : ''}
                  {row.entityId && row.entityType && !entity ? (
                    <>
                      {' · '}
                      <Link href={recordPath(account, row.entityType, row.entityId)}>
                        {row.entityName ?? 'the linked record'}
                      </Link>
                    </>
                  ) : null}
                </span>
              </span>

              {canWrite ? (
                <IconButton
                  label={`Delete “${row.title}”`}
                  tone="destructive"
                  icon={<ACTION_ICONS.delete size={16} />}
                  disabled={busy}
                  onClick={() => setRemoving(row)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={removing !== null}
        title={`Delete “${removing?.title ?? ''}”?`}
        onClose={() => setRemoving(null)}
        onSubmit={() =>
          void run(() => api.crm.tasks.remove.mutate({ id: removing!.id }), 'Task deleted.').then(() =>
            setRemoving(null),
          )
        }
        footer={
          <>
            <Button variant="tertiary" disabled={busy} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" busy={busy}>
              Delete task
            </Button>
          </>
        }
      >
        <p>
          The record it hangs on keeps its timeline, so what was done about it is still there. The
          task itself does not come back.
        </p>
      </Modal>
    </section>
  )
}
