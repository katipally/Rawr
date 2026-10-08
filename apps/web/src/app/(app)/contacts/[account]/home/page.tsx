import {
  canView,
  getPrefs,
  listForms,
  listGrants,
  listImportRuns,
  listIntegrations,
  listMembers,
  listPipelines,
  listSites,
  listTasks,
  overdueNextSteps,
  readDashboard,
  recentActivity,
  withAccountReads,
} from '@rawr/db'
import { Alert, EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { activityActor, activityLabel, EMPTY_VALUE } from '~/components/crm/value.tsx'
import { todayIn } from '~/lib/format.ts'
import { noticeFor } from '~/lib/notices.ts'
import {
  accountHome,
  bookedPath,
  calendarsPath,
  encodeFilters,
  formsPath,
  importsPath,
  integrationsPath,
  membersPath,
  objectView,
  pipelinesPath,
  recordPath,
  sitesPath,
  submissionsPath,
  tasksPath,
} from '~/lib/links.ts'
import { contextFrom, readSession, sessionIsAdmin, sessionIsReadOnly, viewerContext } from '~/server/session.ts'
import { getFormat } from '~/server/format.ts'
import { HomeCards } from './home-cards.tsx'

/** The Monday screen. D10 replaced the spreadsheet ritual with a shared view; this
 *  is that view, opened first. Every number on it is a link to the list that
 *  produced it, so nothing here is a dead end. */

type Tile = { label: string; value: string; detail?: string; href: string; tone?: 'error' | 'warning' }

const TILE_TONES = {
  error: 'text-error',
  warning: 'text-warning',
  default: 'text-link',
} as const

/** The numbers, above everything else on the page, in HubSpot's single value
 *  card: what it counts in small capitals, then the figure in large teal. A
 *  multi-currency account puts three parts in one value, so the track is wide
 *  enough to hold them before it wraps. */
const Tiles = ({ tiles }: { tiles: Tile[] }) => (
  <ul className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]">
    {tiles.map((tile) => (
      <li key={tile.label}>
        <Link
          href={tile.href}
          className="flex h-full flex-col gap-1 rounded-panel border border-line bg-surface p-3 no-underline transition-[border-color,box-shadow] duration-150 ease-out hover:border-line-strong hover:shadow-side motion-reduce:transition-none"
        >
          <span className="text-small font-semibold uppercase text-body">{tile.label}</span>
          <span
            className={`max-w-full break-words text-kpi leading-tight font-semibold tabular-nums ${TILE_TONES[tile.tone ?? 'default']}`}
          >
            {tile.value}
          </span>
          {tile.detail ? <span className="break-words text-small text-secondary tabular-nums">{tile.detail}</span> : null}
        </Link>
      </li>
    ))}
  </ul>
)

/** What an admin has left to switch on.
 *
 *  A checklist is loud on day one and clutter by day ten, and it used to be the
 *  same height either way: seven rows above the numbers, every visit, forever.
 *  So it opens itself only while most of it is still undone, and otherwise sits
 *  as one line the reader can open. It disappears entirely when finished. */
const Setup = ({ items }: { items: { done: boolean; label: string; href: string }[] }) => {
  const done = items.filter((item) => item.done).length
  if (done === items.length) return null

  return (
    <details
      open={done * 2 < items.length}
      className="rounded-panel border border-line bg-surface px-6 py-4 shadow-panel"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">Set up Rawr</span>
        <span className="text-small text-secondary tabular-nums">
          {done} of {items.length} done
        </span>
        <span
          aria-hidden="true"
          className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-fill"
        >
          <span
            className="block h-full rounded-full bg-success"
            style={{ width: `${(done / items.length) * 100}%` }}
          />
        </span>
      </summary>
      <ul className="mt-2 flex flex-col divide-y divide-divider border-t border-divider pt-1">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-3 py-1.5">
            <span
              aria-hidden="true"
              className={
                item.done
                  ? 'flex size-5 shrink-0 items-center justify-center rounded-full bg-success text-small text-white'
                  : 'size-5 shrink-0 rounded-full border border-line'
              }
            >
              {item.done ? '✓' : ''}
            </span>
            {item.done ? (
              <span className="text-secondary line-through">{item.label}</span>
            ) : (
              <Link href={item.href}>{item.label}</Link>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

const HomePage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ notice?: string }>
}) => {
  const fmt = await getFormat()
  const session = await readSession()
  if (!session) redirect('/sign-in')
  const [{ account }, { notice }] = await Promise.all([params, searchParams])
  const message = noticeFor(notice)
  const ctx = contextFrom(session)
  const isAdmin = sessionIsAdmin(session)
  const sales = canView(ctx, 'sales')
  const people = canView(ctx, 'contacts')
  const marketing = canView(ctx, 'marketing')

  const [board, overdue, myTasks, recent, members, setup, prefs] = await withAccountReads(ctx, () =>
    Promise.all([
      readDashboard(viewerContext(session)),
      sales ? overdueNextSteps(ctx) : [],
      people ? listTasks(viewerContext(session), { status: 'open', assigneeId: session.userId }) : [],
      recentActivity(ctx, 12),
      listMembers(ctx),
      // What an admin still has to switch on. Read only for them: nobody else can
      // act on it, and six extra queries for a viewer would buy nothing.
      isAdmin
        ? Promise.all([listIntegrations(ctx), listGrants(ctx), marketing ? listForms(ctx) : [], listImportRuns(ctx, { states: ['done'], limit: 1 }), listSites(ctx), listPipelines(ctx)])
        : null,
      getPrefs(ctx),
    ]),
  )
  const savedOrder = Array.isArray(prefs.homeCards) && prefs.homeCards.every((key) => typeof key === 'string') ? (prefs.homeCards as string[]) : []

  const admins = members.filter((m) => m.isSuperAdmin && m.userId !== session.userId)
  const checklist = setup
    ? (() => {
        const [integrations, grants, forms, imports, sites, pipelines] = setup
        const connected = (kind: string) => integrations.some((row) => row.kind === kind && row.state !== 'not_configured')
        return [
          { done: members.length > 1, label: 'Add the team and set their access', href: membersPath() },
          { done: pipelines.length > 0, label: 'Check the deal pipelines and stage probabilities', href: pipelinesPath() },
          { done: imports.total > 0, label: 'Import contacts, companies and deals', href: importsPath(account) },
          { done: connected('slack'), label: 'Connect Slack so form fills reach the team', href: integrationsPath('slack') },
          { done: grants.length > 0, label: 'Connect a calendar so booking pages have a host', href: calendarsPath(account) },
          { done: forms.length > 0, label: 'Build the first form', href: formsPath(account) },
          { done: sites.length > 0, label: 'Register your website as a tracked site', href: sitesPath() },
        ]
      })()
    : []

  const openCount = board.stages.reduce((sum, stage) => sum + stage.count, 0)
  // Per currency, never across: adding dollars to euros would be a number that
  // means nothing. Most accounts have one currency and see one figure.
  const byCurrency = new Map<string, { total: number; weighted: number }>()
  for (const stage of board.stages) {
    for (const m of stage.totals) {
      const acc = byCurrency.get(m.currency) ?? { total: 0, weighted: 0 }
      byCurrency.set(m.currency, { total: acc.total + m.total, weighted: acc.weighted + m.weighted })
    }
  }
  const money = (pick: (m: { total: number; weighted: number }) => number) =>
    byCurrency.size === 0
      ? fmt.money(0)
      : [...byCurrency.entries()].map(([currency, m]) => fmt.money(pick(m), currency)).join(' · ')
  const allPipelines = [...new Map(board.stages.map((s) => [s.pipelineId, s.pipelineName])).entries()]
  // A pipeline nobody has put a deal in is a column of zeroes the length of its
  // stage list, and it pushed the work below it off the screen. Kept when it is
  // the only one, so a new account still sees the shape of the table.
  const withDeals = allPipelines.filter(([id]) =>
    board.stages.some((s) => s.pipelineId === id && s.count > 0),
  )
  const pipelines = withDeals.length > 0 ? withDeals : allPipelines.slice(0, 1)

  const now = new Date()
  // The hour in the viewer's zone, read in a fixed locale so it parses as a number
  // whatever digits the viewer's own locale writes.
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: fmt.zone, hour: 'numeric', hourCycle: 'h23' }).format(now))
  const firstName = session.displayName.trim().split(/\s+/)[0]
  const greeting = `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}${firstName ? `, ${firstName}` : ''}`

  // The same window readDashboard counted in, so the tile opens the rows it counted.
  const newContactsSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const tiles: Tile[] = [
    ...(sales
      ? [
          { label: 'Open deals', value: fmt.number(openCount), detail: money((m) => m.total), href: objectView(account, 'deal', 'all', 'board') },
          { label: 'Weighted pipeline', value: money((m) => m.weighted), href: objectView(account, 'deal', 'all', 'board') },
          { label: 'Next step overdue', value: fmt.number(overdue.length), href: objectView(account, 'deal', 'overdue-next-step', 'board'), ...(overdue.length ? { tone: 'error' as const } : {}) },
        ]
      : []),
    ...(people
      ? [
          { label: 'My open tasks', value: board.myOverdueTasks ? `${board.myOpenTasks} · ${board.myOverdueTasks} overdue` : String(board.myOpenTasks), href: tasksPath(account, { mine: '1' }), ...(board.myOverdueTasks ? { tone: 'warning' as const } : {}) },
          { label: 'New contacts, 7 days', value: fmt.number(board.newContacts), href: objectView(account, 'contact', 'all', 'list', { sort: '-created_at', filters: encodeFilters([{ conjunction: 'and', conditions: [{ field: 'created_at', operator: 'on_or_after', value: newContactsSince }] }]) }) },
        ]
      : []),
    ...(marketing
      ? [{ label: 'Submissions to review', value: fmt.number(board.quarantined), href: submissionsPath(account, { state: 'quarantined' }), ...(board.quarantined ? { tone: 'warning' as const } : {}) }]
      : []),
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="border-b border-line bg-surface px-6 py-4">
        <h1 data-page-name="Home" className="text-xl font-medium break-words">{greeting}</h1>
        <p className="text-secondary">
          {fmt.at(now, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}, {session.accountName}
        </p>
      </div>
      <div className="flex flex-col gap-2.5 px-2 pb-2 sm:px-4 sm:pb-4">

      {message ? <Alert>{message}</Alert> : null}

      {sessionIsReadOnly(session) ? (
        <section className="rounded-panel border border-line-interactive bg-accent-subtle px-6 py-4">
          <p className="font-medium">You are in as a viewer.</p>
          <p className="text-secondary">
            Everything here is readable and nothing is editable yet. That is how every new
            {` @${session.hostedDomain} `}sign-in starts.{' '}
            {admins.length > 0 ? (
              <>
                To edit, ask{' '}
                {admins.map((a, i) => (
                  <span key={a.email}>
                    {i > 0 ? (i === admins.length - 1 ? ' or ' : ', ') : ''}
                    <a href={`mailto:${a.email}?subject=${encodeURIComponent('Rawr role for ' + session.email)}`}>{a.name}</a>
                  </span>
                ))}{' '}
                to raise your role under Settings, Users &amp; Teams.
              </>
            ) : (
              'An admin raises roles under Settings, Users & Teams.'
            )}
          </p>
        </section>
      ) : null}

      <Tiles tiles={tiles} />

      {checklist.length > 0 ? <Setup items={checklist} /> : null}

      <HomeCards
        cards={[
          ...(sales
            ? [
              {
                key: 'pipeline',
                title: 'Pipeline by stage',
                href: objectView(account, 'deal', 'all', 'board'),
                hrefLabel: 'Open the board',
                body: (
                  <>
                    {board.stages.length === 0 ? (
                      <EmptyState title="No pipeline yet" description="Add stages under Settings, Pipelines, and deals will land here." />
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[28rem] text-body">
                          <thead>
                            <tr className="text-left text-small text-secondary">
                              <th className="py-1 pr-3 font-medium">Stage</th>
                              <th className="whitespace-nowrap py-1 pr-3 text-right font-medium">Deals</th>
                              <th className="whitespace-nowrap py-1 pr-3 text-right font-medium">Total</th>
                              <th className="whitespace-nowrap py-1 text-right font-medium">Weighted</th>
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
                                    <td className="w-full max-w-0 truncate py-1.5 pr-3">
                                      {/* The board has no stage address, so the row opens the list
                                          filtered to exactly the deals it counted. */}
                                      <Link
                                        href={objectView(account, 'deal', 'all', 'list', {
                                          filters: encodeFilters([
                                            { conjunction: 'and', conditions: [{ field: 'stage_id', operator: 'is', value: stage.stageId }] },
                                          ]),
                                        })}
                                      >
                                        {stage.stageName}
                                      </Link>
                                      {stage.probability !== null ? <span className="ml-1 text-small text-secondary">{stage.probability}%</span> : null}
                                    </td>
                                    <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">{stage.count}</td>
                                    <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">
                                      {stage.totals.length ? stage.totals.map((m) => fmt.money(m.total, m.currency)).join(' · ') : fmt.money(0)}
                                    </td>
                                    <td className="whitespace-nowrap py-1.5 text-right tabular-nums">
                                      {stage.totals.length ? stage.totals.map((m) => fmt.money(m.weighted, m.currency)).join(' · ') : fmt.money(0)}
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          ))}
                        </table>
                      </div>
                    )}
                  </>
                ),
              },
              ]
            : []),
          ...(sales
            ? [
              {
                key: 'overdue',
                title: 'Next step overdue',
                href: objectView(account, 'deal', 'overdue-next-step', 'board'),
                hrefLabel: 'All overdue',
                body: (
                  <>
                    {overdue.length === 0 ? (
                      <p className="py-6 text-center">Nothing is overdue. Every open deal has a next step in the future, or none set.</p>
                    ) : (
                      <>
                        <ul className="flex flex-col divide-y divide-divider">
                          {overdue.slice(0, 8).map((deal) => (
                            <li key={deal.id} className="flex flex-col gap-0.5 py-2">
                              <div className="flex min-w-0 items-baseline justify-between gap-2">
                                <Link href={recordPath(account, 'deal', deal.id, { from: accountHome(account) })} className="min-w-0 truncate font-medium">
                                  {deal.name ?? 'Unnamed deal'}
                                </Link>
                                <span className="shrink-0 text-small text-error">{fmt.date(deal.nextStepDate)}</span>
                              </div>
                              <p className="truncate text-small text-secondary">
                                {deal.nextStep ?? 'No next step written'}
                                {deal.ownerName ? ` · ${deal.ownerName}` : ''}
                                {deal.stageName ? ` · ${deal.stageName}` : ''}
                              </p>
                            </li>
                          ))}
                        </ul>
                        {overdue.length > 8 ? (
                          <Link href={objectView(account, 'deal', 'overdue-next-step', 'board')} className="block pt-2 text-small">
                            See all {fmt.number(overdue.length)}
                          </Link>
                        ) : null}
                      </>
                    )}
                  </>
                ),
              },
              ]
            : []),
          ...(sales
            ? [
              {
                key: 'closing',
                title: 'Closing this month',
                href: objectView(account, 'deal', 'all', 'list', { sort: 'close_date' }),
                hrefLabel: 'All deals',
                body: (
                  <>
                    {board.closingThisMonth.length === 0 ? (
                      <p className="py-6 text-center">No open deal has a close date this month.</p>
                    ) : (
                      <ul className="flex flex-col divide-y divide-divider">
                        {board.closingThisMonth.map((deal) => (
                          <li key={deal.id} className="flex min-w-0 items-baseline justify-between gap-2 py-2">
                            <div className="min-w-0">
                              <Link href={recordPath(account, 'deal', deal.id, { from: accountHome(account) })} className="block truncate font-medium">
                                {deal.name ?? 'Unnamed deal'}
                              </Link>
                              <p className="truncate text-small text-secondary">
                                {deal.stageName ?? 'No stage'}
                                {deal.ownerName ? ` · ${deal.ownerName}` : ''}
                              </p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="tabular-nums">{deal.amount === null ? EMPTY_VALUE : fmt.money(deal.amount, deal.currency)}</p>
                              <p className="text-small text-secondary">{fmt.date(deal.closeDate)}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ),
              },
              ]
            : []),
          ...(sales
            ? [
              {
                key: 'meetings',
                title: 'Meetings in the next 7 days',
                href: bookedPath(account),
                hrefLabel: 'All booked',
                body: (
                  <>
                    {board.upcoming.length === 0 ? (
                      <p className="py-6 text-center">Nothing booked for the coming week.</p>
                    ) : (
                      <ul className="flex flex-col divide-y divide-divider">
                        {board.upcoming.map((b) => (
                          <li key={b.id} className="flex min-w-0 items-baseline justify-between gap-2 py-2">
                            <div className="min-w-0">
                              {b.contactId ? (
                                <Link href={recordPath(account, 'contact', b.contactId, { from: accountHome(account) })} className="block truncate font-medium">
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
                            <span className="shrink-0 text-small text-secondary">{fmt.dateTime(b.startsAt)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ),
              },
              ]
            : []),
          ...(people
            ? [
              {
                key: 'tasks',
                title: 'My tasks',
                href: tasksPath(account, { mine: '1' }),
                hrefLabel: 'All mine',
                body: (
                  <>
                    {myTasks.length === 0 ? (
                      <p className="py-6 text-center">No open tasks are assigned to you.</p>
                    ) : (
                      <ul className="flex flex-col divide-y divide-divider">
                        {myTasks.slice(0, 8).map((t) => (
                          <li key={t.id} className="flex min-w-0 items-baseline justify-between gap-2 py-2">
                            <div className="min-w-0">
                              <p className="truncate font-medium">{t.title}</p>
                              {t.entityType && t.entityId ? (
                                <Link href={recordPath(account, t.entityType, t.entityId, { from: accountHome(account) })} className="block truncate text-small">
                                  {t.entityName ?? t.entityType}
                                </Link>
                              ) : null}
                            </div>
                            {t.dueDate ? (
                              <span className={`shrink-0 text-small ${t.dueDate < todayIn(session.timezone) ? 'text-error' : 'text-secondary'}`}>
                                {fmt.date(t.dueDate)}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ),
              },
              ]
            : []),
          {
                key: 'activity',
                title: 'Recent activity',
                href: objectView(account, 'contact', 'all', 'list', { sort: '-updated_at' }),
                hrefLabel: 'Recently changed',
                body: (
                  <>
                    {recent.length === 0 ? (
                      <p className="py-6 text-center">Nothing has happened yet. Notes, calls, stage moves and form fills land here as the team works.</p>
                    ) : (
                      <ul className="flex flex-col divide-y divide-divider">
                        {recent.map((entry) => (
                          <li key={entry.id} className="flex flex-col gap-0.5 py-2">
                            <div className="flex min-w-0 items-baseline justify-between gap-2">
                              <p className="min-w-0 truncate">
                                <span className="rounded-hs bg-fill px-1.5 py-0.5 text-small text-secondary">{activityLabel(entry)}</span>{' '}
                                <span className="font-medium">{activityActor(entry.type, { ...entry, recordName: entry.entityName })}</span>{' '}
                                {entry.subject ?? ''}
                              </p>
                              <time dateTime={entry.occurredAt.toISOString()} className="shrink-0 text-small text-secondary">
                                {fmt.dateTime(entry.occurredAt)}
                              </time>
                            </div>
                            <p className="truncate text-small text-secondary">
                              {entry.entityDeleted ? (
                                <span className="italic">{entry.entityName}</span>
                              ) : (
                                <Link href={recordPath(account, entry.entityType, entry.entityId, { from: accountHome(account) })}>{entry.entityName}</Link>
                              )}
                              {entry.body ? ` · ${entry.body}` : ''}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ),
              },
        ]}
        savedOrder={savedOrder}
      />
      </div>
    </div>
  )
}

export default HomePage
