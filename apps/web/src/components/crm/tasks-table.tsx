'use client'

import { Button, Checkbox, DataTable, EmptyState, IconButton, Modal, Select, cn, useToast, type Column } from '@rawr/ui'
import { Pencil } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { useNavigation } from '~/components/navigation.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { recordPath, tasksPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { TaskForm } from './task-form.tsx'
import { TASK_PRIORITY_LABELS, TASK_TYPE_LABELS } from './task-labels.ts'
import type { TaskRow } from './tasks-panel.tsx'
import { formatDate, isPast } from './value.tsx'
import { useZone } from '~/components/zone.tsx'

export type TasksTableProps = {
  account: string
  rows: TaskRow[]
  assignees: { id: string; label: string }[]
  queues: { id: string; name: string }[]
  /** The queue being looked at, so a task created here lands in it. */
  queueId?: string | undefined
  canWrite: boolean
  /** Shown when the view matched nothing. */
  emptyTitle: string
  /** Read from ?new=1 on the server, so a deep link has the dialog open on the
   *  first paint rather than after hydration. */
  openCreate?: boolean
  /** True when a filter, not an empty account, is why the table is empty. */
  filtered?: boolean
}

/** High is the only one worth colouring: medium is the default every task has,
 *  and a table where every row shouts says nothing. */
const PRIORITY_TONE: Record<TaskRow['priority'], string> = {
  low: 'text-secondary',
  medium: '',
  high: 'font-medium text-error',
}

/** HubSpot's tasks index: a table with the done checkbox in the first column,
 *  the record the task hangs on one click away, and the count in the footer.
 *  The "Add tasks" button on the header links here with ?new=1, so the create
 *  dialog lives once, next to the table it adds to. */
export const TasksTable = ({
  account,
  rows,
  assignees,
  queues,
  queueId,
  canWrite,
  emptyTitle,
  openCreate = false,
  filtered = false,
}: TasksTableProps) => {
  const zone = useZone()
  const router = useRouter()
  const { navigate } = useNavigation()
  const toast = useToast()
  const query = useSearchParams()
  // Derived from the prop rather than seeded into state from it, the way the list
  // toolbar's create dialog is: state read once at mount stays shut when a
  // client-side navigation re-renders this table with ?new=1 instead of
  // remounting it, and reading the param in an effect opens it only after
  // hydration, which on a cold load is late enough to look broken.
  const creating = openCreate && canWrite
  const [editing, setEditing] = useState<TaskRow | null>(null)
  const [removing, setRemoving] = useState<TaskRow | null>(null)
  const [busy, setBusy] = useState(false)
  const { page, pager } = usePagedRows(rows, 'task')

  // Drop ?new=1 so a refresh, or a step back, does not reopen the dialog. Run by
  // both ways out of the dialog: cancelling it and creating a task in it.
  const closeCreate = () => {
    if (!creating) return
    const next = new URLSearchParams(query)
    next.delete('new')
    navigate(`${tasksPath(account)}${next.size ? `?${next}` : ''}`)
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
        <span className="flex min-w-0 flex-col py-1">
          <span className={cn('block truncate', row.status === 'done' && 'text-secondary line-through')}>
            {row.title}
          </span>
          {/* One line of it. A task written by an automation carries the whole
              reason in its body, and a table row is not where that is read. */}
          {row.body ? <span className="block truncate text-small text-secondary">{row.body}</span> : null}
        </span>
      ),
    },
    { key: 'type', header: 'Type', width: 110, render: (row) => TASK_TYPE_LABELS[row.type] },
    {
      key: 'priority',
      header: 'Priority',
      width: 110,
      render: (row) => <span className={PRIORITY_TONE[row.priority]}>{TASK_PRIORITY_LABELS[row.priority]}</span>,
    },
    {
      key: 'record',
      header: 'Associated record',
      width: 220,
      render: (row) =>
        row.entityId && row.entityType ? (
          <Link href={recordPath(account, row.entityType, row.entityId)} className="truncate" onClick={(event) => event.stopPropagation()}>
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
          <span className={cn(row.status === 'open' && isPast(row.dueDate) && 'font-medium text-error')}>{formatDate(row.dueDate, zone)}</span>
        ) : (
          <span className="text-secondary">--</span>
        ),
    },
    {
      key: 'queue',
      header: 'Queue',
      width: 180,
      render: (row) =>
        canWrite ? (
          <Select
            aria-label={`Queue for “${row.title}”`}
            value={row.queueId ?? ''}
            disabled={busy}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) =>
              void run(
                () => api.crm.tasks.update.mutate({ id: row.id, queueId: event.target.value || null }),
                'Task moved.',
              )
            }
          >
            <option value="">No queue</option>
            {queues.map((queue) => (
              <option key={queue.id} value={queue.id}>
                {queue.name}
              </option>
            ))}
          </Select>
        ) : (
          <span className={row.queueName ? '' : 'text-secondary'}>{row.queueName ?? '--'}</span>
        ),
    },
    { key: 'assignee', header: 'Assigned to', width: 180, render: (row) => row.assigneeName ?? <span className="text-secondary">Unassigned</span> },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: '',
            width: 96,
            render: (row: TaskRow) => (
              <span className="flex items-center gap-1">
                <IconButton
                  label={`Edit “${row.title}”`}
                  icon={<Pencil size={16} />}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    setEditing(row)
                  }}
                />
                <IconButton
                  label={`Delete “${row.title}”`}
                  tone="destructive"
                  icon={<ACTION_ICONS.delete size={16} />}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    setRemoving(row)
                  }}
                />
              </span>
            ),
          },
        ]
      : []),
  ]

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <DataTable
        columns={columns}
        rows={page}
        rowKey={(row) => row.id}
        caption="Tasks in this account"
        storageKey="tasks"
        fill
        empty={
          <div className="flex flex-1 flex-col justify-center">
            <EmptyState
              title={emptyTitle}
              {...(filtered
                ? {
                    description:
                      'Widen the search, pick a different type, or clear the filter to see the rest of the tasks.',
                  }
                : canWrite
                  ? {
                      description:
                        'Add one with the button above. Overdue tasks are what the Monday list is built from.',
                    }
                  : {})}
            />
          </div>
        }
      />
      <div className="-mx-3 flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3 pt-2 sm:-mx-6 sm:px-6">
        <span className="inline-flex h-8 items-center rounded-pill bg-canvas px-4 text-small font-semibold">
          {rows.length.toLocaleString()} {rows.length === 1 ? 'task' : 'tasks'}
        </span>
        {pager}
      </div>
      <Modal open={creating} title="Create task" onClose={closeCreate}>
        <TaskForm
          assignees={assignees}
          queues={queues}
          defaultQueueId={queueId}
          autoFocus={creating}
          onCreated={closeCreate}
          className="flex flex-wrap items-end gap-2"
        />
      </Modal>
      <Modal
        open={removing !== null}
        title={`Delete “${removing?.title ?? ''}”?`}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button variant="tertiary" disabled={busy} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() =>
                void run(() => api.crm.tasks.remove.mutate({ id: removing!.id }), 'Task deleted.').then(() =>
                  setRemoving(null),
                )
              }
            >
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
      <Modal open={editing !== null} title="Edit task" onClose={() => setEditing(null)}>
        {editing ? (
          <TaskForm
            key={editing.id}
            assignees={assignees}
            queues={queues}
            task={editing}
            autoFocus
            onCreated={() => setEditing(null)}
            className="flex flex-wrap items-end gap-2"
          />
        ) : null}
      </Modal>
    </div>
  )
}
