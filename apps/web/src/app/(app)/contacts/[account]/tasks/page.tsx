import { canWrite, getRegistry, isUuid, listTaskQueues, listTasks, overdueNextSteps, schema, TASK_LIST_CAP } from '@rawr/db'
import { Alert, EmptyState, cn } from '@rawr/ui'
import { CalendarDays, Table2 } from 'lucide-react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { IndexHeader } from '~/components/crm/index-header.tsx'
import type { TaskType } from '~/components/crm/task-labels.ts'
import { TasksTable } from '~/components/crm/tasks-table.tsx'
import { objectView, recordPath, taskQueuesPath, tasksPath, type TaskView } from '~/lib/links.ts'
import { readLookups } from '~/server/crm.ts'
import { contextFrom, readSession, viewerContext } from '~/server/session.ts'
import { TaskFilters } from './task-filters.tsx'
import { getFormat } from '~/server/format.ts'

/** HubSpot's task views, each one an address so it can be linked into. */
const VIEWS: { key: TaskView; label: string; empty: string }[] = [
  { key: 'all', label: 'All tasks', empty: 'No tasks yet' },
  { key: 'today', label: 'Due today', empty: 'Nothing is due today' },
  { key: 'overdue', label: 'Overdue', empty: 'Nothing is overdue' },
  { key: 'upcoming', label: 'Upcoming', empty: 'Nothing is due after today' },
  { key: 'done', label: 'Completed', empty: 'Nothing has been completed yet' },
]

/** Trevor's Monday: what is overdue, and what he told himself he would do next.
 *  Both are the same question asked of two different columns. A9. */
const TasksPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{
    view?: string
    mine?: string
    assignee?: string
    q?: string
    queue?: string
    type?: string
    new?: string
  }>
}) => {
  const fmt = await getFormat()
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const search = await searchParams
  const ctx = contextFrom(session)
  const view = VIEWS.find((option) => option.key === search.view) ?? VIEWS[0]!
  const mine = search.mine === '1'
  const assignee = !mine && isUuid(search.assignee ?? '') ? search.assignee : undefined
  const q = search.q?.trim() ?? ''
  // A hand-edited address must not reach a uuid comparison with something that
  // is not one.
  const asked = search.queue?.trim() ?? ''
  const queue = asked === 'none' || isUuid(asked) ? asked : undefined
  const type = (schema.TASK_TYPES as readonly string[]).includes(search.type ?? '')
    ? (search.type as TaskType)
    : undefined
  const kept = {
    view: view.key,
    ...(mine ? { mine: '1' as const } : {}),
    ...(assignee ? { assignee } : {}),
    ...(q ? { q } : {}),
    ...(type ? { type } : {}),
    ...(queue ? { queue } : {}),
  }
  const at = (next: { view?: TaskView }) => tasksPath(account, { ...kept, ...next })

  const [tasks, queues, overdue, lookups, registry] = await Promise.all([
    listTasks(viewerContext(session), {
      ...(mine && ctx.actorId ? { assigneeId: ctx.actorId } : assignee ? { assigneeId: assignee } : {}),
      ...(view.key === 'overdue' ? { overdueOnly: true } : {}),
      ...(view.key === 'today' || view.key === 'upcoming' ? { due: view.key } : {}),
      ...(view.key === 'done' ? { status: 'done' as const } : {}),
      ...(queue ? { queueId: queue } : {}),
      ...(type ? { type } : {}),
    }),
    listTaskQueues(ctx),
    view.key === 'overdue' ? overdueNextSteps(ctx) : Promise.resolve([]),
    readLookups(ctx),
    getRegistry(ctx),
  ])
  const needle = q.toLowerCase()
  const rows = needle ? tasks.filter((row) => row.title.toLowerCase().includes(needle)) : tasks
  // The table pages and searches over what this read returned, so once the read
  // is full the view is a window rather than the view. Saying so is the honest
  // answer: a queue, a type or "assigned to me" is how somebody gets past it.
  const capped = tasks.length === TASK_LIST_CAP
  const writable = canWrite(contextFrom(session), 'task')

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <IndexHeader
        title="Tasks"
        currentObject="task"
        objects={[
          ...registry.objects.map((other) => ({ key: other.key, label: other.namePlural, href: objectView(account, other.key, 'all') })),
          { key: 'task', label: 'Tasks', href: tasksPath(account) },
        ]}
        add={writable ? [{ label: 'Create task', href: at({}) + (at({}).includes('?') ? '&new=1' : '?new=1') }] : []}
        addLabel="Add tasks"
        more={[{ key: 'queues', label: 'Manage queues', href: taskQueuesPath(account, at({})) }]}
      />

      <nav aria-label="Task views" className="flex flex-wrap items-center gap-1 border-b border-line pb-1">
        {VIEWS.map((option) => {
          const Icon = option.key === 'today' || option.key === 'upcoming' ? CalendarDays : Table2
          const current = option.key === view.key
          return (
            <Link
              key={option.key}
              href={at({ view: option.key })}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'flex h-pill items-center gap-2 rounded-hs px-3 py-px font-normal no-underline transition-all duration-150 ease-out',
                current ? 'bg-fill-hover text-body' : 'bg-surface text-secondary hover:bg-fill-hover hover:text-body',
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{option.label}</span>
            </Link>
          )
        })}
      </nav>

      <TaskFilters
        account={account}
        params={kept}
        assignees={lookups.users}
        queues={queues}
      />

      {capped ? (
        <Alert>
          Showing the first {fmt.number(TASK_LIST_CAP)} tasks of this view. Narrow it by
          queue, type or assignee to see the rest.
        </Alert>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <TasksTable
          account={account}
          rows={rows}
          assignees={lookups.users}
          queues={queues}
          {...(queue && queue !== 'none' ? { queueId: queue } : {})}
          canWrite={writable}
          emptyTitle={q || type || queue || assignee ? 'No tasks match the filter' : view.empty}
          filtered={Boolean(q || type || queue || assignee)}
          openCreate={search.new === '1'}
        />
      </div>

      {view.key === 'overdue' ? (
        <section className="max-h-[40%] shrink-0 overflow-y-auto rounded-panel border border-line bg-surface shadow-panel">
          <h2 className="px-6 pt-6 pb-4 text-base font-semibold">Next step overdue ({overdue.length})</h2>
          {overdue.length === 0 ? (
            <EmptyState
              title="No deal is past its next step"
              description="A past next-step date is a signal, not an error, so this list is empty when the pipeline is current."
            />
          ) : (
            <ul className="flex flex-col px-6 pb-6">
              {overdue.map((deal) => (
                <li key={deal.id} className="border-b border-divider py-2 last:border-0">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <Link href={recordPath(account, 'deal', deal.id)} className="min-w-0 break-words font-medium">
                      {deal.name ?? 'Unnamed deal'}
                    </Link>
                    <time dateTime={deal.nextStepDate} className="shrink-0 font-medium text-error">
                      {fmt.date(deal.nextStepDate)}
                    </time>
                  </p>
                  {deal.nextStep ? <p className="break-words">{deal.nextStep}</p> : null}
                  <p className="text-small text-secondary">
                    {deal.stageName ?? 'No stage'}
                    {deal.ownerName ? ` · ${deal.ownerName}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  )
}

export default TasksPage
