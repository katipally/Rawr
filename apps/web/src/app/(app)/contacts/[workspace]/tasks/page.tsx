import { listTasks, overdueNextSteps } from '@rawr/db'
import { EmptyState, cn } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { TasksPanel } from '~/components/crm/tasks-panel.tsx'
import { formatDate } from '~/components/crm/value.tsx'
import { recordPath, tasksPath } from '~/lib/links.ts'
import { readLookups } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { canWrite } from '@rawr/db'

/** Trevor's Monday: what is overdue, and what he told himself he would do next.
 *  Both are the same question asked of two different columns. A9. */
const TasksPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ filter?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace } = await params
  const { filter } = await searchParams
  const ctx = contextFrom(session)
  const mine = filter === 'mine'

  const [tasks, overdue, lookups] = await Promise.all([
    listTasks(ctx, {
      ...(mine && ctx.actorId ? { assigneeId: ctx.actorId } : {}),
      ...(filter === 'overdue' ? { overdueOnly: true } : {}),
    }),
    overdueNextSteps(ctx),
    readLookups(ctx),
  ])

  const filters: { key: string; label: string }[] = [
    { key: '', label: 'Everything' },
    { key: 'mine', label: 'Assigned to me' },
    { key: 'overdue', label: 'Overdue only' },
  ]

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-medium">Tasks</h1>

      <nav aria-label="Task filter" className="flex flex-wrap gap-1">
        {filters.map((option) => (
          <Link
            key={option.key || 'all'}
            href={tasksPath(workspace, option.key ? { filter: option.key } : {})}
            aria-current={(filter ?? '') === option.key ? 'true' : undefined}
            className={cn(
              'rounded-hs border px-2 py-1 no-underline',
              (filter ?? '') === option.key
                ? 'border-line-interactive bg-accent-subtle text-link'
                : 'border-line text-secondary',
            )}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      <div className="grid gap-4 lg:grid-cols-2">
        <TasksPanel
          workspace={workspace}
          rows={tasks.map((row) => ({
            id: row.id,
            title: row.title,
            dueDate: row.dueDate,
            status: row.status,
            assigneeName: row.assigneeName,
            entityType: row.entityType,
            entityId: row.entityId,
            entityName: row.entityName,
          }))}
          assignees={lookups.users}
          canWrite={canWrite(session.role, 'task')}
        />

        <section className="rounded-panel border border-line bg-surface">
          <h2 className="border-b border-divider px-3 py-2 font-medium">
            Next step overdue ({overdue.length})
          </h2>
          {overdue.length === 0 ? (
            <EmptyState
              title="Nothing is overdue"
              description="Every open deal's next step date is still ahead of it. A past date is a signal, not an error, so this list is empty when the pipeline is current."
            />
          ) : (
            <ul className="flex flex-col">
              {overdue.map((deal) => (
                <li key={deal.id} className="border-b border-divider px-3 py-2 last:border-0">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <Link href={recordPath(workspace, 'deal', deal.id)} className="min-w-0 break-words font-medium">
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
      </div>
    </div>
  )
}

export default TasksPage
