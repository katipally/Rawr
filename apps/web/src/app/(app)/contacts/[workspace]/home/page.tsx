import { listTasks, overdueNextSteps, readDashboard, withWorkspaceReads } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatCurrency, formatDate, formatDateTime } from '~/components/crm/value.tsx'
import { bookedPath, objectView, recordPath, submissionsPath, tasksPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** The Monday screen. D10 replaced the spreadsheet ritual with a shared view; this
 *  is that view, opened first. Every number on it is a link to the list that
 *  produced it, so nothing here is a dead end. */

type Tile = { label: string; value: string; href: string; tone?: 'error' | 'warning' }

const Tiles = ({ tiles }: { tiles: Tile[] }) => (
  <ul className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(10rem,1fr))]">
    {tiles.map((tile) => (
      <li key={tile.label}>
        <Link
          href={tile.href}
          className="flex h-full flex-col gap-1 rounded-panel border border-line bg-surface p-3 no-underline hover:border-line-pressed"
        >
          <span className="text-small text-secondary">{tile.label}</span>
          <span
            className={
              tile.tone === 'error'
                ? 'text-lg font-medium text-error'
                : tile.tone === 'warning'
                  ? 'text-lg font-medium text-warning'
                  : 'text-lg font-medium text-body'
            }
          >
            {tile.value}
          </span>
        </Link>
      </li>
    ))}
  </ul>
)

const Panel = ({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) => (
  <section className="flex min-w-0 flex-col rounded-panel border border-line bg-surface">
    <header className="flex items-center justify-between gap-2 border-b border-divider px-3 py-2">
      <h2 className="font-medium">{title}</h2>
      {action}
    </header>
    <div className="min-w-0 p-3">{children}</div>
  </section>
)

const HomePage = async ({ params }: { params: Promise<{ workspace: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')
  const { workspace } = await params
  const ctx = contextFrom(session)

  const [board, overdue, myTasks] = await withWorkspaceReads(ctx, () =>
    Promise.all([
      readDashboard(ctx),
      overdueNextSteps(ctx),
      listTasks(ctx, { status: 'open', assigneeId: session.userId }),
    ]),
  )

  const openCount = board.stages.reduce((sum, stage) => sum + stage.count, 0)
  // Per currency, never across: adding dollars to euros would be a number that
  // means nothing. Most workspaces have one currency and see one figure.
  const byCurrency = new Map<string, { total: number; weighted: number }>()
  for (const stage of board.stages) {
    for (const m of stage.totals) {
      const acc = byCurrency.get(m.currency) ?? { total: 0, weighted: 0 }
      byCurrency.set(m.currency, { total: acc.total + m.total, weighted: acc.weighted + m.weighted })
    }
  }
  const money = (pick: (m: { total: number; weighted: number }) => number) =>
    byCurrency.size === 0
      ? formatCurrency(0)
      : [...byCurrency.entries()].map(([currency, m]) => formatCurrency(pick(m), currency)).join(' · ')
  const pipelines = [...new Map(board.stages.map((s) => [s.pipelineId, s.pipelineName])).entries()]

  const tiles: Tile[] = [
    { label: 'Open deals', value: `${openCount.toLocaleString()} · ${money((m) => m.total)}`, href: objectView(workspace, 'deal', 'all', 'board') },
    { label: 'Weighted pipeline', value: money((m) => m.weighted), href: objectView(workspace, 'deal', 'all', 'board') },
    { label: 'Next step overdue', value: overdue.length.toLocaleString(), href: objectView(workspace, 'deal', 'overdue-next-step', 'board'), ...(overdue.length ? { tone: 'error' as const } : {}) },
    { label: 'My open tasks', value: board.myOverdueTasks ? `${board.myOpenTasks} · ${board.myOverdueTasks} overdue` : String(board.myOpenTasks), href: tasksPath(workspace, { filter: 'mine' }), ...(board.myOverdueTasks ? { tone: 'warning' as const } : {}) },
    { label: 'New contacts, 7 days', value: board.newContacts.toLocaleString(), href: objectView(workspace, 'contact', 'all', 'list', { sort: '-created_at' }) },
    { label: 'Submissions to review', value: board.quarantined.toLocaleString(), href: submissionsPath(workspace, { state: 'quarantined' }), ...(board.quarantined ? { tone: 'warning' as const } : {}) },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium">Home</h1>
        <p className="text-secondary">
          {session.workspaceName}, {formatDate(new Date())}. Every number opens the list behind it.
        </p>
      </div>

      <Tiles tiles={tiles} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Pipeline by stage"
          action={<Link href={objectView(workspace, 'deal', 'all', 'board')}>Open the board</Link>}
        >
          {board.stages.length === 0 ? (
            <EmptyState title="No pipeline yet" description="Add stages under Settings, Pipelines, and deals will land here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-body">
                <thead>
                  <tr className="text-left text-small text-secondary">
                    <th className="py-1 pr-3 font-medium">Stage</th>
                    <th className="py-1 pr-3 text-right font-medium">Deals</th>
                    <th className="py-1 pr-3 text-right font-medium">Total</th>
                    <th className="py-1 text-right font-medium">Weighted</th>
                  </tr>
                </thead>
                {pipelines.map(([pipelineId, pipelineName]) => (
                  <tbody key={pipelineId}>
                    {pipelines.length > 1 ? (
                      <tr>
                        <th colSpan={4} className="pt-2 pb-1 text-left text-small font-medium uppercase text-secondary">
                          {pipelineName}
                        </th>
                      </tr>
                    ) : null}
                    {board.stages
                      .filter((s) => s.pipelineId === pipelineId)
                      .map((stage) => (
                        <tr key={stage.stageId} className="border-t border-divider">
                          <td className="max-w-0 truncate py-1.5 pr-3">
                            <Link href={objectView(workspace, 'deal', 'all', 'board', { pipeline: pipelineId })}>{stage.stageName}</Link>
                            {stage.probability !== null ? <span className="ml-1 text-small text-secondary">{stage.probability}%</span> : null}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{stage.count}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">
                            {stage.totals.length ? stage.totals.map((m) => formatCurrency(m.total, m.currency)).join(' · ') : formatCurrency(0)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {stage.totals.length ? stage.totals.map((m) => formatCurrency(m.weighted, m.currency)).join(' · ') : formatCurrency(0)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Next step overdue"
          action={<Link href={objectView(workspace, 'deal', 'overdue-next-step', 'board')}>All overdue</Link>}
        >
          {overdue.length === 0 ? (
            <p className="text-secondary">Nothing is overdue. Every open deal has a next step in the future, or none set.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-divider">
              {overdue.slice(0, 8).map((deal) => (
                <li key={deal.id} className="flex flex-col gap-0.5 py-2">
                  <div className="flex min-w-0 items-baseline justify-between gap-2">
                    <Link href={recordPath(workspace, 'deal', deal.id)} className="min-w-0 truncate font-medium">
                      {deal.name ?? 'Unnamed deal'}
                    </Link>
                    <span className="shrink-0 text-small text-error">{formatDate(deal.nextStepDate)}</span>
                  </div>
                  <p className="truncate text-small text-secondary">
                    {deal.nextStep ?? 'No next step written'}
                    {deal.ownerName ? ` · ${deal.ownerName}` : ''}
                    {deal.stageName ? ` · ${deal.stageName}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Closing this month" action={<Link href={objectView(workspace, 'deal', 'all', 'list', { sort: 'close_date' })}>All deals</Link>}>
          {board.closingThisMonth.length === 0 ? (
            <p className="text-secondary">No open deal has a close date this month.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-divider">
              {board.closingThisMonth.map((deal) => (
                <li key={deal.id} className="flex min-w-0 items-baseline justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <Link href={recordPath(workspace, 'deal', deal.id)} className="block truncate font-medium">
                      {deal.name ?? 'Unnamed deal'}
                    </Link>
                    <p className="truncate text-small text-secondary">
                      {deal.stageName ?? 'No stage'}
                      {deal.ownerName ? ` · ${deal.ownerName}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular-nums">{deal.amount === null ? '—' : formatCurrency(deal.amount, deal.currency)}</p>
                    <p className="text-small text-secondary">{formatDate(deal.closeDate)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Meetings in the next 7 days" action={<Link href={bookedPath(workspace)}>All booked</Link>}>
          {board.upcoming.length === 0 ? (
            <p className="text-secondary">Nothing booked for the coming week.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-divider">
              {board.upcoming.map((b) => (
                <li key={b.id} className="flex min-w-0 items-baseline justify-between gap-2 py-2">
                  <div className="min-w-0">
                    {b.contactId ? (
                      <Link href={recordPath(workspace, 'contact', b.contactId)} className="block truncate font-medium">
                        {b.attendeeName}
                      </Link>
                    ) : (
                      <p className="truncate font-medium">{b.attendeeName}</p>
                    )}
                    <p className="truncate text-small text-secondary">
                      {b.pageName}
                      {b.hostName ? ` · with ${b.hostName}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-small text-secondary">{formatDateTime(b.startsAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="My tasks" action={<Link href={tasksPath(workspace, { filter: 'mine' })}>All mine</Link>}>
          {myTasks.length === 0 ? (
            <p className="text-secondary">No open tasks are assigned to you.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-divider">
              {myTasks.slice(0, 8).map((t) => (
                <li key={t.id} className="flex min-w-0 items-baseline justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.title}</p>
                    {t.entityType && t.entityId ? (
                      <Link href={recordPath(workspace, t.entityType, t.entityId)} className="block truncate text-small">
                        {t.entityName ?? t.entityType}
                      </Link>
                    ) : null}
                  </div>
                  {t.dueDate ? (
                    <span className={`shrink-0 text-small ${t.dueDate < new Date().toISOString().slice(0, 10) ? 'text-error' : 'text-secondary'}`}>
                      {formatDate(t.dueDate)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}

export default HomePage
