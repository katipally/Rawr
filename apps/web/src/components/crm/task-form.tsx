'use client'

import { Button, Select, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

export type TaskFormProps = {
  assignees: { id: string; label: string }[]
  /** Set on a record page, so a new task is filed against that record. */
  entity?: { entityType: string; entityId: string } | undefined
  /** Focus the title as soon as the form shows: a dialog, or the record page's
   *  quick-action row asking for a new task. */
  autoFocus?: boolean | undefined
  onCreated?: (() => void) | undefined
  className?: string | undefined
}

/** One create form behind the record panel and the tasks index dialog. */
export const TaskForm = ({ assignees, entity, autoFocus, onCreated, className }: TaskFormProps) => {
  const router = useRouter()
  const toast = useToast()
  const titleField = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (autoFocus) titleField.current?.focus()
  }, [autoFocus])

  const create = async () => {
    setBusy(true)
    try {
      await api.crm.tasks.create.mutate({
        title,
        dueDate: dueDate || null,
        assigneeId: assigneeId || null,
        entity: entity ?? null,
      })
      setTitle('')
      setDueDate('')
      toast('success', 'Task created.')
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
  )
}
