'use client'

import { Badge, TextInput, cn } from '@rawr/ui'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { FilterChip as Chip, ghostFilter as ghost, type FilterOption as Option } from '~/components/filter-chip.tsx'
import { TASK_TYPE_LABELS, type TaskType } from '~/components/crm/task-labels.ts'
import { tasksPath, type TaskView } from '~/lib/links.ts'
import { typingInto } from '~/lib/typing-into.ts'

export type TaskParams = {
  view: TaskView
  mine?: '1' | undefined
  assignee?: string | undefined
  q?: string | undefined
  queue?: string | undefined
  type?: string | undefined
}

const pill =
  'inline-flex h-pill items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-4 py-2 text-small font-light text-body transition-all duration-150 ease-out hover:bg-fill'

/** HubSpot's tasks toolbar: the search, a Filter pill that shows or hides the
 *  quick filters, and the row of them. Every choice is a link, so a filtered
 *  list is an address like the rest of the index. */
export const TaskFilters = ({
  account,
  params,
  assignees,
  queues,
}: {
  account: string
  params: TaskParams
  assignees: { id: string; label: string }[]
  queues: { id: string; name: string }[]
}) => {
  const [open, setOpen] = useState(true)
  const search = useRef<HTMLInputElement>(null)
  const at = (next: Partial<TaskParams>) => tasksPath(account, { ...params, ...next })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (typingInto(event.target)) return
      event.preventDefault()
      search.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const cleared = { mine: undefined, assignee: undefined, queue: undefined, type: undefined, q: undefined }
  const active = [params.mine || params.assignee, params.type, params.queue].filter(Boolean).length

  const assigneeOptions: Option[] = [
    { key: 'me', label: 'Me', href: at({ mine: params.mine ? undefined : '1', assignee: undefined }), on: Boolean(params.mine) },
    ...assignees.map((person) => ({
      key: person.id,
      label: person.label,
      href: at({ mine: undefined, assignee: params.assignee === person.id ? undefined : person.id }),
      on: params.assignee === person.id,
    })),
  ]
  const typeOptions: Option[] = (Object.keys(TASK_TYPE_LABELS) as TaskType[]).map((key) => ({
    key,
    label: TASK_TYPE_LABELS[key],
    href: at({ type: params.type === key ? undefined : key }),
    on: params.type === key,
  }))
  const queueOptions: Option[] = [
    { key: 'none', label: 'No queue', href: at({ queue: params.queue === 'none' ? undefined : 'none' }), on: params.queue === 'none' },
    ...queues.map((queue) => ({
      key: queue.id,
      label: queue.name,
      href: at({ queue: params.queue === queue.id ? undefined : queue.id }),
      on: params.queue === queue.id,
    })),
  ]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form className="relative w-full min-w-0 @lg:w-[13.375rem]" action={tasksPath(account)}>
          {params.view !== 'all' ? <input type="hidden" name="view" value={params.view} /> : null}
          {params.mine ? <input type="hidden" name="mine" value="1" /> : null}
          {params.assignee ? <input type="hidden" name="assignee" value={params.assignee} /> : null}
          {params.queue ? <input type="hidden" name="queue" value={params.queue} /> : null}
          {params.type ? <input type="hidden" name="type" value={params.type} /> : null}
          <TextInput
            ref={search}
            type="search"
            name="q"
            defaultValue={params.q ?? ''}
            aria-label="Search tasks"
            placeholder="Search ( / )"
            className="h-control min-h-0 rounded-pill border-line-strong bg-surface py-1 pr-10 pl-4 [&::-webkit-search-cancel-button]:appearance-none"
          />
          <button
            type="submit"
            aria-label="Search tasks"
            className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-pill text-body hover:bg-fill"
          >
            <Search aria-hidden="true" className="size-4" />
          </button>
          {params.q ? (
            <Link
              href={at({ q: undefined })}
              aria-label="Clear the search"
              className="absolute top-1/2 right-7 grid size-6 -translate-y-1/2 place-items-center rounded-pill text-body no-underline hover:bg-fill"
            >
              <X aria-hidden="true" className="size-4" />
            </Link>
          ) : null}
        </form>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
          className={cn(pill, (open || active > 0) && 'bg-fill-hover')}
        >
          <SlidersHorizontal aria-hidden="true" className="size-3.5" />
          Filter
          {active > 0 ? <Badge tone="neutral">{active}</Badge> : null}
        </button>
      </div>

      {open ? (
        <div className="flex flex-wrap items-center gap-1">
          <Chip label="Assigned to" options={assigneeOptions} clear={at({ mine: undefined, assignee: undefined })} />
          <span aria-hidden="true" className="mx-1.5 h-5 w-px bg-line" />
          <Chip label="Task type" options={typeOptions} clear={at({ type: undefined })} />
          <Chip label="Queue" options={queueOptions} clear={at({ queue: undefined })} />
          {active > 0 ? (
            <Link href={at(cleared)} className={cn(ghost, 'no-underline')}>
              Clear all
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
