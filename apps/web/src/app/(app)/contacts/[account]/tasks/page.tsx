import { canWrite, getRegistry, listTasks, overdueNextSteps } from '@rawr/db'
import { EmptyState, cn } from '@rawr/ui'
import { CalendarDays, Search, Table2 } from 'lucide-react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { IndexHeader } from '~/components/crm/index-header.tsx'
import { TasksTable } from '~/components/crm/tasks-table.tsx'
import { formatDate } from '~/components/crm/value.tsx'
import { objectView, recordPath, tasksPath, type TaskView } from '~/lib/links.ts'
import { readLookups } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** HubSpot's task views, each one an address so it can be linked into. */
const VIEWS: { key: TaskView; label: string; empty: string }[] = [
  { key: 'all', label: 'All tasks', empty: 'No tasks yet' },
  { key: 'today', label: 'Due today', empty: 'Nothing is due today' },
  { key: 'overdue', label: 'Overdue', empty: 'Nothing is overdue' },
  { key: 'upcoming', label: 'Upcoming', empty: 'Nothing is due after today' },
  { key: 'done', label: 'Completed', empty: 'Nothing has been completed yet' },
]

const pill =
  'inline-flex h-control items-center gap-1.5 rounded-pill border border-line-strong px-4 text-small font-light text-body no-underline'

/** Trevor's Monday: what is overdue, and what he told himself he would do next.
 *  Both are the same question asked of two different columns. A9. */
const TasksPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ view?: string; mine?: string; q?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const search = await searchParams
  const ctx = contextFrom(session)
  const view = VIEWS.find((option) => option.key === search.view) ?? VIEWS[0]!
  const mine = search.mine === '1'
  const q = search.q?.trim() ?? ''
  const at = (next: { view?: TaskView; mine?: '1'; q?: string }) =>
    tasksPath(account, { view: view.key, ...(mine ? { mine: '1' } : {}), ...(q ? { q } : {}), ...next })

  const [tasks, overdue, lookups, registry] = await Promise.all([
    listTasks(ctx, {
      ...(mine && ctx.actorId ? { assigneeId: ctx.actorId } : {}),
      ...(view.key === 'overdue' ? { overdueOnly: true } : {}),
      ...(view.key === 'today' || view.key === 'upcoming' ? { due: view.key } : {}),
      ...(view.key === 'done' ? { status: 'done' as const } : {}),
    }),
    view.key === 'overdue' ? overdueNextSteps(ctx) : Promise.resolve([]),
    readLookups(ctx),
    getRegistry(ctx),
  ])
  const needle = q.toLowerCase()
  const rows = needle ? tasks.filter((row) => row.title.toLowerCase().includes(needle)) : tasks
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
        more={[]}
      />

      <nav aria-label="Task views" className="flex flex-wrap items-center gap-1 border-b border-line pb-1">
        {VIEWS.map((option) => {
          const active = option.key === view.key
          const Icon = option.key === 'today' || option.key === 'upcoming' ? CalendarDays : Table2
          return (
            <Link
              key={option.key}
              href={at({ view: option.key })}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-control items-center gap-2 rounded-hs px-3 py-1 font-normal no-underline',
                active ? 'bg-fill-hover text-body' : 'text-secondary hover:bg-fill hover:text-body',
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {option.label}
            </Link>
          )
        })}
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <form className="relative w-full min-w-0 sm:w-56" action={tasksPath(account)}>
          {view.key !== 'all' ? <input type="hidden" name="view" value={view.key} /> : null}
          {mine ? <input type="hidden" name="mine" value="1" /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q}
            aria-label="Search tasks"
            placeholder="Search ( / )"
            className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-10 pl-4 text-body placeholder:text-muted"
          />
          <button
            type="submit"
            aria-label="Search tasks"
            className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-pill text-body hover:bg-fill"
          >
            <Search aria-hidden="true" className="size-4" />
          </button>
        </form>
        <Link
          href={mine ? tasksPath(account, { view: view.key, ...(q ? { q } : {}) }) : at({ mine: '1' })}
          aria-pressed={mine}
          className={cn(pill, mine ? 'bg-fill-hover' : 'bg-surface hover:bg-fill')}
        >
          Assigned to me
        </Link>
      </div>

      <TasksTable account={account} rows={rows} assignees={lookups.users} canWrite={writable} emptyTitle={q ? 'No tasks match the search' : view.empty} />

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
                      {formatDate(deal.nextStepDate)}
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
