'use client'

import { Button, DataTable, EmptyState, Field, IconButton, Modal, Select, TextInput, cn, useToast, type Column } from '@rawr/ui'
import { Check, CircleCheck, Pencil, Trash2, UserRound, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { useNavigation } from '~/components/navigation.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { recordPath, tasksPath, type TaskView } from '~/lib/links.ts'
import { pickableUsers, type PickablePerson } from '~/lib/pickable-users.ts'
import { emptyTaskHint } from '~/lib/task-copy.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { closeParamsAndRefresh, useUrlParam } from '~/lib/url-params.ts'
import { useOrigin } from '~/lib/use-origin.ts'
import { TaskForm } from './task-form.tsx'
import { TASK_PRIORITY_LABELS, TASK_TYPE_LABELS, type TaskPriority, type TaskType } from './task-labels.ts'
import type { TaskRow } from './tasks-panel.tsx'
import { useFormat } from '~/components/zone.tsx'

export type TasksTableProps = {
  account: string
  rows: TaskRow[]
  /** Every member, deactivated ones included; a picker offers only what pickableUsers allows. */
  people: PickablePerson[]
  queues: { id: string; name: string }[]
  /** The tab being looked at, which decides what an empty list says. */
  view: TaskView
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

const bulkAction =
  'inline-flex h-[calc(var(--spacing-row)-2px)] shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-body font-semibold transition-all duration-150 ease-out hover:bg-fill disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent'
const bulkLabel = 'sr-only @3xl:not-sr-only'

/** High is the only one worth colouring: medium is the default every task has,
 *  and a table where every row shouts says nothing. */
const PRIORITY_TONE: Record<TaskRow['priority'], string> = {
  low: 'text-secondary',
  medium: '',
  high: 'font-medium text-error',
}

/** HubSpot's tasks index: a table with the done checkbox in the first column,
 *  the record the task hangs on one click away, and the count in the footer.
 *  The "Add task" button on the header links here with ?new=1, so the create
 *  dialog lives once, next to the table it adds to. */
export const TasksTable = ({
  account,
  rows,
  people,
  queues,
  view,
  queueId,
  canWrite,
  emptyTitle,
  openCreate = false,
  filtered = false,
}: TasksTableProps) => {
  const fmt = useFormat()
  const router = useRouter()
  const { navigate } = useNavigation()
  const toast = useToast()
  const origin = useOrigin()
  const query = useSearchParams()
  // Derived from the prop rather than seeded into state from it, the way the list
  // toolbar's create dialog is: state read once at mount stays shut when a
  // client-side navigation re-renders this table with ?new=1 instead of
  // remounting it, and reading the param in an effect opens it only after
  // hydration, which on a cold load is late enough to look broken.
  const creating = openCreate && canWrite
  const [editId, setEditId] = useUrlParam('edit')
  const editing = rows.find((row) => row.id === editId) ?? null
  const setEditing = (row: TaskRow | null) => setEditId(row?.id ?? null)
  const [removing, setRemoving] = useState<TaskRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<'assign' | 'edit' | 'delete' | null>(null)
  const { page, pager } = usePagedRows(rows, 'task')
  const hint = emptyTaskHint({ filtered, view, canWrite })
  // Read against the rows on screen, so a tick on a task a refresh took away
  // does not count or get acted on.
  const ticked = rows.filter((row) => selected.has(row.id))

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

  /** Every ticked task through the same call, side by side. Each one is its own
   *  write with its own checks, so one that fails says so and the rest land. */
  const runBulk = async (fn: (row: TaskRow) => Promise<unknown>, done: string) => {
    setBusy(true)
    const results = await Promise.allSettled(ticked.map(fn))
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed.length > 0) {
      toast('error', `${fmt.number(failed.length)} of ${fmt.number(ticked.length)} could not be changed. ${errorMessage(failed[0]!.reason)}`)
    } else toast('success', done)
    setBulk(null)
    setSelected(new Set())
    setBusy(false)
    router.refresh()
  }

  const columns: Column<TaskRow>[] = [
    {
      key: 'title',
      header: 'Title',
      width: 360,
      render: (row) => {
        const done = row.status === 'done'
        return (
          <span className="flex min-w-0 items-center gap-3">
            {/* HubSpot's complete control: a ring left of the title that fills
                with a tick once the task is done. */}
            <button
              type="button"
              aria-pressed={done}
              aria-label={`Mark “${row.title}” ${done ? 'not done' : 'done'}`}
              disabled={!canWrite || busy}
              onClick={(event) => {
                event.stopPropagation()
                void run(
                  () => api.crm.tasks.setStatus.mutate({ id: row.id, status: done ? 'open' : 'done' }),
                  done ? 'Reopened.' : 'Marked done.',
                )
              }}
              className={cn(
                'group/done grid size-5 shrink-0 place-items-center rounded-pill border transition-all duration-150 ease-out disabled:cursor-not-allowed',
                done ? 'border-accent bg-accent text-inverse' : 'border-line-strong bg-surface text-secondary hover:border-accent hover:text-accent',
              )}
            >
              <Check aria-hidden="true" className={cn('size-3', !done && 'opacity-0 group-hover/done:opacity-100')} />
            </button>
            <span className="flex min-w-0 flex-col py-1">
              {canWrite ? (
                <button
                  type="button"
                  onClick={() => setEditing(row)}
                  className={cn('block truncate text-left font-semibold text-link hover:text-accent hover:underline', done && 'text-secondary line-through')}
                >
                  {row.title}
                </button>
              ) : (
                <span className={cn('block truncate', done && 'text-secondary line-through')}>{row.title}</span>
              )}
              {/* One line of it. A task written by an automation carries the whole
                  reason in its body, and a table row is not where that is read. */}
              {row.body ? <span className="block truncate text-small text-secondary">{row.body}</span> : null}
            </span>
          </span>
        )
      },
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
          <Link href={recordPath(account, row.entityType, row.entityId, { from: origin })} className="truncate" onClick={(event) => event.stopPropagation()}>
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
          <span className={cn(row.status === 'open' && fmt.isPast(row.dueDate) && 'font-medium text-error')}>{fmt.date(row.dueDate)}</span>
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
            title={row.queueName ?? undefined}
            value={row.queueId ?? ''}
            className="truncate"

            disabled={busy}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) =>
              void run(
                () => api.crm.tasks.update.mutate({ id: row.id, queueId: event.target.value || null, expectedUpdatedAt: row.updatedAt }),
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
              // Shown with the row hovered or a button in it focused, and always on
              // a device with no hover to show it with.
              <span className="flex items-center gap-1 opacity-0 focus-within:opacity-100 [@media(hover:none)]:opacity-100 [tr:hover_&]:opacity-100">
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
        {...(canWrite ? { selection: { selected, onChange: setSelected, noun: 'task' } } : {})}
        headerBar={
          ticked.length > 0 ? (
            <div
              role="toolbar"
              aria-label={`Actions for ${ticked.length} selected tasks`}
              className="@container flex h-full min-w-0 animate-drop-in items-center gap-0.5 rounded-hs border border-line bg-surface pl-4 motion-reduce:animate-none"
            >
              <span className="mr-3 min-w-0 shrink truncate font-semibold">
                {fmt.number(ticked.length)} {ticked.length === 1 ? 'task' : 'tasks'} selected
              </span>
              <button
                type="button"
                className={bulkAction}
                aria-label="Mark as completed"
                disabled={busy || ticked.every((row) => row.status === 'done')}
                onClick={() =>
                  void runBulk(
                    (row) => (row.status === 'done' ? Promise.resolve() : api.crm.tasks.setStatus.mutate({ id: row.id, status: 'done' })),
                    'Marked done.',
                  )
                }
              >
                <CircleCheck aria-hidden="true" className="size-4" />
                <span className={bulkLabel}>Mark as completed</span>
              </button>
              <button type="button" className={bulkAction} aria-label="Assign" disabled={busy} onClick={() => setBulk('assign')}>
                <UserRound aria-hidden="true" className="size-4" />
                <span className={bulkLabel}>Assign</span>
              </button>
              <button type="button" className={bulkAction} aria-label="Edit" disabled={busy} onClick={() => setBulk('edit')}>
                <Pencil aria-hidden="true" className="size-4" />
                <span className={bulkLabel}>Edit</span>
              </button>
              <button type="button" className={bulkAction} aria-label="Delete" disabled={busy} onClick={() => setBulk('delete')}>
                <Trash2 aria-hidden="true" className="size-4" />
                <span className={bulkLabel}>Delete</span>
              </button>
              <IconButton
                label="Clear the selection"
                icon={<X aria-hidden="true" className="size-4" />}
                onClick={() => setSelected(new Set())}
                className="mr-1 ml-auto shrink-0 text-body"
              />
            </div>
          ) : null
        }
        empty={
          <div className="flex flex-1 flex-col justify-center">
            <EmptyState
              title={emptyTitle}
              {...(hint ? { description: hint } : {})}
            />
          </div>
        }
      />
      <div className="-mx-3 flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3 pt-2 sm:-mx-6 sm:px-6">
        <span className="inline-flex h-8 items-center rounded-pill bg-canvas px-4 text-small font-semibold">
          {fmt.number(rows.length)} {rows.length === 1 ? 'task' : 'tasks'}
        </span>
        {pager}
      </div>
      {creating ? (
        <TaskForm
          panel={{ title: 'Create Task', onClose: closeCreate, onAnother: () => router.refresh() }}
          account={account}
          assignees={pickableUsers(people)}
          queues={queues}
          defaultQueueId={queueId}
          onSaved={closeCreate}
        />
      ) : null}
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
      {bulk === 'assign' ? (
        <BulkAssign
          count={ticked.length}
          people={people}
          busy={busy}
          onClose={() => setBulk(null)}
          onApply={(assigneeId) =>
            void runBulk(
              (row) => api.crm.tasks.update.mutate({ id: row.id, assigneeId, expectedUpdatedAt: row.updatedAt }),
              'Assigned.',
            )
          }
        />
      ) : null}
      {bulk === 'edit' ? (
        <BulkEdit
          count={ticked.length}
          queues={queues}
          busy={busy}
          onClose={() => setBulk(null)}
          onApply={(change) =>
            void runBulk((row) => api.crm.tasks.update.mutate({ id: row.id, ...change, expectedUpdatedAt: row.updatedAt }), 'Tasks updated.')
          }
        />
      ) : null}
      <Modal
        open={bulk === 'delete'}
        title={`Delete ${fmt.number(ticked.length)} ${ticked.length === 1 ? 'task' : 'tasks'}?`}
        onClose={() => setBulk(null)}
        footer={
          <>
            <Button variant="tertiary" disabled={busy} onClick={() => setBulk(null)}>
              Cancel
            </Button>
            <Button variant="destructive" busy={busy} onClick={() => void runBulk((row) => api.crm.tasks.remove.mutate({ id: row.id }), 'Tasks deleted.')}>
              {ticked.length === 1 ? 'Delete task' : 'Delete tasks'}
            </Button>
          </>
        }
      >
        <p>The records they hang on keep their timelines. The tasks themselves do not come back.</p>
      </Modal>
      {editing ? (
        <TaskForm
          key={editing.id}
          panel={{ title: 'Edit Task', onClose: () => setEditing(null) }}
          account={account}
          assignees={pickableUsers(people, editing.assigneeId)}
          queues={queues}
          task={editing}
          onSaved={() => closeParamsAndRefresh(router, { edit: null })}
        />
      ) : null}
    </div>
  )
}

const BulkAssign = ({
  count,
  people,
  busy,
  onClose,
  onApply,
}: {
  count: number
  people: PickablePerson[]
  busy: boolean
  onClose: () => void
  onApply: (assigneeId: string) => void
}) => {
  // Starts blank: a silent first pick would assign every ticked task to whoever sorts first.
  const [assigneeId, setAssigneeId] = useState('')
  return (
    <Modal
      open
      size="sm"
      title={`Assign ${count} ${count === 1 ? 'task' : 'tasks'}`}
      onClose={onClose}
      onSubmit={() => onApply(assigneeId)}
      footer={
        <>
          <Button variant="tertiary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!assigneeId}>
            Assign
          </Button>
        </>
      }
    >
      <Field id="bulk-assignee" label="Assigned to">
        <Select id="bulk-assignee" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
          <option value="">Choose someone</option>
          {pickableUsers(people).map((person) => (
            <option key={person.id} value={person.id}>
              {person.label}
            </option>
          ))}
        </Select>
      </Field>
    </Modal>
  )
}

type BulkChange =
  | { dueDate: string | null }
  | { queueId: string | null }
  | { priority: TaskPriority }
  | { type: TaskType }

const EDITABLE = [
  { key: 'dueDate', label: 'Due date' },
  { key: 'queueId', label: 'Queue' },
  { key: 'priority', label: 'Priority' },
  { key: 'type', label: 'Task type' },
] as const

/** One property, one value, applied to every ticked task. */
const BulkEdit = ({
  count,
  queues,
  busy,
  onClose,
  onApply,
}: {
  count: number
  queues: { id: string; name: string }[]
  busy: boolean
  onClose: () => void
  onApply: (change: BulkChange) => void
}) => {
  const [property, setProperty] = useState<(typeof EDITABLE)[number]['key']>('dueDate')
  const [value, setValue] = useState('')
  const pick = (next: typeof property) => {
    setProperty(next)
    setValue(next === 'priority' ? 'medium' : next === 'type' ? 'todo' : '')
  }
  const change = (): BulkChange =>
    property === 'dueDate'
      ? { dueDate: value || null }
      : property === 'queueId'
        ? { queueId: value || null }
        : property === 'priority'
          ? { priority: value as TaskPriority }
          : { type: value as TaskType }

  return (
    <Modal
      open
      size="sm"
      title={`Edit ${count} ${count === 1 ? 'task' : 'tasks'}`}
      onClose={onClose}
      onSubmit={() => onApply(change())}
      footer={
        <>
          <Button variant="tertiary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field id="bulk-property" label="Property to update">
          <Select id="bulk-property" value={property} onChange={(event) => pick(event.target.value as typeof property)}>
            {EDITABLE.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="bulk-value" label={EDITABLE.find((option) => option.key === property)!.label}>
          {property === 'dueDate' ? (
            <TextInput id="bulk-value" type="date" value={value} onChange={(event) => setValue(event.target.value)} />
          ) : (
            <Select id="bulk-value" value={value} onChange={(event) => setValue(event.target.value)}>
              {property === 'queueId' ? (
                <>
                  <option value="">No queue</option>
                  {queues.map((queue) => (
                    <option key={queue.id} value={queue.id}>
                      {queue.name}
                    </option>
                  ))}
                </>
              ) : (
                Object.entries(property === 'priority' ? TASK_PRIORITY_LABELS : TASK_TYPE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))
              )}
            </Select>
          )}
        </Field>
      </div>
    </Modal>
  )
}
