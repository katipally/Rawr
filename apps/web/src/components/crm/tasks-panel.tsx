'use client'

import { EmptyState, IconButton, cn, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { TaskForm } from './task-form.tsx'
import { formatDate, isPast } from './value.tsx'

export type TaskRow = {
  id: string
  title: string
  body: string | null
  dueDate: string | null
  status: 'open' | 'done'
  assigneeName: string | null
  /** An object key, core or invented. Null for a task that hangs on nothing. */
  entityType: string | null
  entityId: string | null
  entityName: string | null
}

export type TasksPanelProps = {
  account: string
  rows: TaskRow[]
  assignees: { id: string; label: string }[]
  /** Set on a record page, so a new task is filed against that record. */
  entity?: { entityType: string; entityId: string }
  canWrite: boolean
  /** Rendered as a boxed panel on a record, and bare on the tasks page. */
  heading?: string
  /** The record page's quick-action row asking for a new task, from the address.
   *  The form is here, so the row asks rather than carrying a second copy. */
  startNew?: boolean | undefined
}

export const TasksPanel = ({
  account,
  rows,
  assignees,
  entity,
  canWrite,
  heading = 'Tasks',
  startNew,
}: TasksPanelProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

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

  const open = rows.filter((row) => row.status === 'open')
  const done = rows.filter((row) => row.status === 'done')

  return (
    <section className="rounded-panel border border-line bg-surface shadow-panel">
      <h3 className="px-6 pt-6 pb-4 text-base font-semibold">
        {heading} ({open.length} open)
      </h3>

      {canWrite ? (
        <TaskForm
          assignees={assignees}
          entity={entity}
          autoFocus={startNew}
          className="flex flex-wrap items-end gap-2 border-b border-divider px-6 py-2"
        />
      ) : null}

      {rows.length === 0 ? (
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
                {row.body ? (
                  <span className="block whitespace-pre-wrap break-words text-small text-secondary">
                    {row.body}
                  </span>
                ) : null}
                <span className="block text-small text-secondary">
                  {row.dueDate ? (
                    <span className={cn(row.status === 'open' && isPast(row.dueDate) && 'font-medium text-error')}>
                      {formatDate(row.dueDate)}
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
                  onClick={() => void run(() => api.crm.tasks.remove.mutate({ id: row.id }), 'Task deleted.')}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
