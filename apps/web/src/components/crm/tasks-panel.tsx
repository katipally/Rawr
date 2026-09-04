'use client'

import { Button, EmptyState, Select, TextInput, cn, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDate, isPast } from './value.tsx'

export type TaskRow = {
  id: string
  title: string
  dueDate: string | null
  status: 'open' | 'done'
  assigneeName: string | null
  entityType: ObjectKey | null
  entityId: string | null
  entityName: string | null
}

export type TasksPanelProps = {
  workspace: string
  rows: TaskRow[]
  assignees: { id: string; label: string }[]
  /** Set on a record page, so a new task is filed against that record. */
  entity?: { entityType: ObjectKey; entityId: string }
  canWrite: boolean
  /** Rendered as a boxed panel on a record, and bare on the tasks page. */
  heading?: string
  /** The record page's quick-action row asking for a new task, from the address.
   *  The form is here, so the row asks rather than carrying a second copy. */
  startNew?: boolean | undefined
}

export const TasksPanel = ({
  workspace,
  rows,
  assignees,
  entity,
  canWrite,
  heading = 'Tasks',
  startNew,
}: TasksPanelProps) => {
  const router = useRouter()
  const toast = useToast()
  const titleField = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (startNew) titleField.current?.focus()
  }, [startNew])

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

  const create = () =>
    run(async () => {
      await api.crm.tasks.create.mutate({
        title,
        dueDate: dueDate || null,
        assigneeId: assigneeId || null,
        entity: entity ?? null,
      })
      setTitle('')
      setDueDate('')
    }, 'Task created.')

  const open = rows.filter((row) => row.status === 'open')
  const done = rows.filter((row) => row.status === 'done')

  return (
    <section className="rounded-panel border border-line bg-surface">
      <h3 className="border-b border-divider px-3 py-2 font-medium">
        {heading} ({open.length} open)
      </h3>

      {canWrite ? (
        <form
          className="flex flex-wrap items-end gap-2 border-b border-divider px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <TextInput
            ref={titleField}
            value={title}
            aria-label="Task title"
            placeholder="What needs doing"
            onChange={(event) => setTitle(event.target.value)}
            className="min-w-40 flex-1"
          />
          <TextInput
            type="date"
            value={dueDate}
            aria-label="Due date"
            onChange={(event) => setDueDate(event.target.value)}
            className="w-auto"
          />
          <Select
            aria-label="Assignee"
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
            className="w-auto min-w-32"
          >
            <option value="">Me</option>
            {assignees.map((person) => (
              <option key={person.id} value={person.id}>
                {person.label}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="primary" busy={busy} disabled={title.trim() === ''}>
            Add task
          </Button>
        </form>
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
              className="flex flex-wrap items-center gap-2 border-b border-divider px-3 py-2 last:border-0"
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
                      <Link href={recordPath(workspace, row.entityType, row.entityId)}>
                        {row.entityName ?? 'the linked record'}
                      </Link>
                    </>
                  ) : null}
                </span>
              </span>

              {canWrite ? (
                <Button
                  variant="tertiary"
                  busy={busy}
                  onClick={() => void run(() => api.crm.tasks.remove.mutate({ id: row.id }), 'Task deleted.')}
                >
                  Delete
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
