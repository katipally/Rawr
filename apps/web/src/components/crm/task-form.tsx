'use client'

import { Button, Select, TextArea, TextInput, useToast } from '@rawr/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { TASK_PRIORITY_LABELS, TASK_TYPE_LABELS, type TaskPriority, type TaskType } from './task-labels.ts'


/** The hour a relative reminder lands on. A reminder at midnight is one nobody
 *  sees before the day it is about is already half gone. */
const REMIND_HOUR = 9

/** Every preset is a number of days before the due date; "custom" is the reader
 *  typing an instant instead. Kept relative because that is how people think
 *  about a reminder, and absolute in the field because that is what actually
 *  gets stored. */
const REMINDER_PRESETS: { key: string; label: string; daysBefore: number | null }[] = [
  { key: 'none', label: 'No reminder', daysBefore: null },
  { key: 'due', label: 'Morning it is due', daysBefore: 0 },
  { key: 'day', label: 'A day before', daysBefore: 1 },
  { key: 'three', label: 'Three days before', daysBefore: 3 },
  { key: 'week', label: 'A week before', daysBefore: 7 },
]

const pad = (value: number): string => String(value).padStart(2, '0')

/** The value a `datetime-local` input wants, in the reader's own clock, which is
 *  also the clock they picked the due date in. */
const localValue = (at: Date): string =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`

const remindFrom = (dueDate: string, daysBefore: number): string => {
  const [year, month, day] = dueDate.split('-').map(Number)
  if (!year || !month || !day) return ''
  const at = new Date(year, month - 1, day, REMIND_HOUR)
  at.setDate(at.getDate() - daysBefore)
  return localValue(at)
}

export type EditableTask = {
  id: string
  title: string
  body: string | null
  type: TaskType
  priority: TaskPriority
  dueDate: string | null
  remindAt: Date | string | null
  queueId: string | null
  assigneeId: string | null
}

export type TaskFormProps = {
  assignees: { id: string; label: string }[]
  queues: { id: string; name: string }[]
  /** Set on a record page, so a new task is filed against that record. */
  entity?: { entityType: string; entityId: string } | undefined
  /** The queue the reader is looking at, so a task added there stays there. */
  defaultQueueId?: string | undefined
  /** Present to edit that task instead of creating one. */
  task?: EditableTask | undefined
  /** Focus the title as soon as the form shows: a dialog, or the record page's
   *  quick-action row asking for a new task. */
  autoFocus?: boolean | undefined
  onCreated?: (() => void) | undefined
  className?: string | undefined
}

/** One form behind the record panel, the tasks index dialog and the edit dialog. */
export const TaskForm = ({
  assignees,
  queues,
  entity,
  defaultQueueId,
  task,
  autoFocus,
  onCreated,
  className,
}: TaskFormProps) => {
  const router = useRouter()
  const toast = useToast()
  const titleField = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(task?.title ?? '')
  const [body, setBody] = useState(task?.body ?? '')
  const [type, setType] = useState<TaskType>(task?.type ?? 'todo')
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'medium')
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '')
  const [remindAt, setRemindAt] = useState(task?.remindAt ? localValue(new Date(task.remindAt)) : '')
  const [queueId, setQueueId] = useState(task?.queueId ?? defaultQueueId ?? '')
  const [assigneeId, setAssigneeId] = useState(task?.assigneeId ?? '')
  const [busy, setBusy] = useState(false)
  const [more, setMore] = useState(
    Boolean(task?.remindAt || task?.queueId || task?.assigneeId || task?.body),
  )

  useEffect(() => {
    if (autoFocus) titleField.current?.focus()
  }, [autoFocus])

  const save = async () => {
    setBusy(true)
    try {
      const fields = {
        title,
        body: body.trim() || null,
        type,
        priority,
        dueDate: dueDate || null,
        remindAt: remindAt ? new Date(remindAt).toISOString() : null,
        queueId: queueId || null,
        assigneeId: assigneeId || null,
      }
      if (task) {
        await api.crm.tasks.update.mutate({ id: task.id, ...fields })
        toast('success', 'Task saved.')
      } else {
        await api.crm.tasks.create.mutate({ ...fields, entity: entity ?? null })
        setTitle('')
        setBody('')
        setDueDate('')
        setRemindAt('')
        toast('success', 'Task created.')
      }
      router.refresh()
      onCreated?.()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
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
      <Select
        aria-label="Task type"
        value={type}
        onChange={(event) => setType(event.target.value as TaskType)}
        className="w-auto min-w-24"
      >
        {(Object.keys(TASK_TYPE_LABELS) as TaskType[]).map((key) => (
          <option key={key} value={key}>
            {TASK_TYPE_LABELS[key]}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Priority"
        value={priority}
        onChange={(event) => setPriority(event.target.value as TaskPriority)}
        className="w-auto min-w-24"
      >
        {(Object.keys(TASK_PRIORITY_LABELS) as TaskPriority[]).map((key) => (
          <option key={key} value={key}>
            {TASK_PRIORITY_LABELS[key]}
          </option>
        ))}
      </Select>
      {/* A native date field shows nothing but a format, so it says what it is.
          The selects beside it read as their own value and need no label. */}
      <label className="flex flex-col gap-0.5">
        <span className="text-small text-secondary">Due date</span>
        <TextInput
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          className="w-auto"
        />
      </label>
      <Button type="submit" variant="primary" busy={busy} disabled={title.trim() === ''}>
        {task ? 'Save task' : 'Add task'}
      </Button>
      <Button
        variant="tertiary"
        aria-expanded={more}
        onClick={() => setMore(!more)}
        icon={more ? <ChevronDown aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}
      >
        {more ? 'Fewer' : 'More'}
      </Button>

      {/* Four controls most tasks never set. Shut by default so the form beside a
          record is three fields tall, and open from the start whenever the task
          being edited already uses one of them. */}
      {more ? (
        <div className="flex w-full flex-wrap items-end gap-2">
          {/* The preset fills the instant; the instant is what is stored, and stays
              editable, so "a day before" and "next Tuesday at four" are the same
              control rather than two. */}
          <label className="flex flex-col gap-0.5">
            <span className="text-small text-secondary">Reminder</span>
            <Select
              value={REMINDER_PRESETS.find((preset) => preset.daysBefore !== null && dueDate && remindFrom(dueDate, preset.daysBefore) === remindAt)?.key ?? (remindAt ? 'custom' : 'none')}
              onChange={(event) => {
                const preset = REMINDER_PRESETS.find((option) => option.key === event.target.value)
                if (!preset) return
                setRemindAt(preset.daysBefore === null || !dueDate ? '' : remindFrom(dueDate, preset.daysBefore))
              }}
              className="w-auto min-w-36"
            >
              {REMINDER_PRESETS.map((preset) => (
                <option key={preset.key} value={preset.key} disabled={preset.daysBefore !== null && !dueDate}>
                  {preset.label}
                </option>
              ))}
              {remindAt ? <option value="custom">Custom</option> : null}
            </Select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-small text-secondary">Remind me at</span>
            <TextInput
              type="datetime-local"
              value={remindAt}
              onChange={(event) => setRemindAt(event.target.value)}
              className="w-auto"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-small text-secondary">Queue</span>
            <Select
              value={queueId}
              onChange={(event) => setQueueId(event.target.value)}
              className="w-auto min-w-32"
            >
              <option value="">No queue</option>
              {queues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-small text-secondary">Assignee</span>
            <Select
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
          </label>
          {/* Full width under the row: automations and sequences already write a
              body, and until now a task that had one showed only its title. */}
          <TextArea
            value={body}
            rows={2}
            aria-label="Details"
            placeholder="Details (optional)"
            onChange={(event) => setBody(event.target.value)}
            className="w-full"
          />
        </div>
      ) : null}
    </form>
  )
}
