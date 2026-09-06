'use client'

import { Checkbox, DataTable, EmptyState, IconButton, Modal, cn, useToast, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { useNavigation } from '~/components/navigation.tsx'
import { recordPath, tasksPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { TaskForm } from './task-form.tsx'
import type { TaskRow } from './tasks-panel.tsx'
import { formatDate, isPast } from './value.tsx'

export type TasksTableProps = {
  workspace: string
  rows: TaskRow[]
  assignees: { id: string; label: string }[]
  canWrite: boolean
  /** Shown when the view matched nothing. */
  emptyTitle: string
}

/** HubSpot's tasks index: a table with the done checkbox in the first column,
 *  the record the task hangs on one click away, and the count in the footer.
 *  The "Add tasks" button on the header links here with ?new=1, so the create
 *  dialog lives once, next to the table it adds to. */
export const TasksTable = ({ workspace, rows, assignees, canWrite, emptyTitle }: TasksTableProps) => {
  const router = useRouter()
  const { navigate } = useNavigation()
  const toast = useToast()
  const query = useSearchParams()
  const askedToCreate = query.get('new') === '1'
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (askedToCreate && canWrite) setCreating(true)
  }, [askedToCreate, canWrite])

  const closeCreate = () => {
    setCreating(false)
    // Drop ?new=1 so a refresh, or a step back, does not reopen the dialog.
    if (askedToCreate) {
      const next = new URLSearchParams(query)
      next.delete('new')
      navigate(`${tasksPath(workspace)}${next.size ? `?${next}` : ''}`)
    }
  }

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

  const columns: Column<TaskRow>[] = [
    {
      key: 'status',
      header: 'Status',
      width: 88,
      render: (row) => (
        <Checkbox
          label={`Mark “${row.title}” ${row.status === 'done' ? 'not done' : 'done'}`}
          hideLabel
          checked={row.status === 'done'}
          disabled={!canWrite || busy}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) =>
            void run(
              () => api.crm.tasks.setStatus.mutate({ id: row.id, status: event.target.checked ? 'done' : 'open' }),
              event.target.checked ? 'Marked done.' : 'Reopened.',
            )
          }
        />
      ),
    },
    {
      key: 'title',
      header: 'Title',
      width: 320,
      render: (row) => (
        <span className={cn('block truncate', row.status === 'done' && 'text-secondary line-through')}>{row.title}</span>
      ),
    },
    {
      key: 'record',
      header: 'Associated record',
      width: 220,
      render: (row) =>
        row.entityId && row.entityType ? (
          <Link href={recordPath(workspace, row.entityType, row.entityId)} className="truncate" onClick={(event) => event.stopPropagation()}>
            {row.entityName ?? 'the linked record'}
          </Link>
        ) : (
          <span className="text-secondary">--</span>
        ),
    },
    {
      key: 'due',
      header: 'Due date',
      width: 160,
      render: (row) =>
        row.dueDate ? (
          <span className={cn(row.status === 'open' && isPast(row.dueDate) && 'font-medium text-error')}>{formatDate(row.dueDate)}</span>
        ) : (
          <span className="text-secondary">--</span>
        ),
    },
    { key: 'assignee', header: 'Assigned to', width: 180, render: (row) => row.assigneeName ?? <span className="text-secondary">Unassigned</span> },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: '',
            width: 64,
            render: (row: TaskRow) => (
              <IconButton
                label={`Delete “${row.title}”`}
                tone="destructive"
                icon={<ACTION_ICONS.delete size={16} />}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  void run(() => api.crm.tasks.remove.mutate({ id: row.id }), 'Task deleted.')
                }}
              />
            ),
          },
        ]
      : []),
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        caption="Tasks in this workspace"
        storageKey="tasks"
        fill
        empty={
          <EmptyState
            title={emptyTitle}
            {...(canWrite ? { description: 'Add one with the button above. Overdue tasks are what the Monday list is built from.' } : {})}
          />
        }
      />
      <div className="-mx-3 flex shrink-0 items-center border-t border-line px-3 pt-2 sm:-mx-6 sm:px-6">
        <span className="inline-flex h-8 items-center rounded-pill bg-canvas px-4 text-small font-semibold">
          {rows.length.toLocaleString()} {rows.length === 1 ? 'task' : 'tasks'}
        </span>
      </div>
      <Modal open={creating} title="Create task" onClose={closeCreate}>
        <TaskForm assignees={assignees} autoFocus={creating} onCreated={closeCreate} className="flex flex-wrap items-end gap-2" />
      </Modal>
    </div>
  )
}
