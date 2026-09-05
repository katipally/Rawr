import { Badge, Card, EmptyState } from '@rawr/ui'
import Link from 'next/link'
import type { ObjectKey } from '@rawr/db'
import { recordPath, threadPath } from '~/lib/links.ts'
import { formatDate } from './value.tsx'

export type OverviewTask = {
  id: string
  title: string
  dueDate: string | null
  status: 'open' | 'done'
}

export type OverviewThread = {
  threadId: string
  subject: string | null
  /** Null for a thread whose messages carry no date, which a badly formed import
   *  can produce. */
  lastAt: string | null
  messageCount: number
}

export type OverviewDeal = {
  id: string
  displayName: string
  detail: string | null
}

export type Touch = { channel: string; at: string | null } | null

export type RecordOverviewProps = {
  workspace: string
  object: ObjectKey
  tasks: OverviewTask[]
  threads: OverviewThread[]
  deals: OverviewDeal[]
  firstTouch: Touch
  lastTouch: Touch
}

/** The answer to "what is going on with this record" without reading a timeline:
 *  what is owed, what was last said, what money is open, and where they came
 *  from. HubSpot calls this Overview and puts the timeline behind its own tab. */
export const RecordOverview = ({
  workspace,
  object,
  tasks,
  threads,
  deals,
  firstTouch,
  lastTouch,
}: RecordOverviewProps) => {
  const open = tasks.filter((task) => task.status === 'open')
  const overdue = open.filter((task) => task.dueDate !== null && task.dueDate < today())

  return (
    <div className="flex flex-col gap-3">
      <Card
        title="Open tasks"
        action={
          <Badge tone={overdue.length > 0 ? 'error' : 'neutral'}>
            {overdue.length > 0 ? `${overdue.length} overdue` : open.length}
          </Badge>
        }
      >
        {open.length === 0 ? (
          <p className="text-secondary">Nothing owed on this record.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {open.slice(0, 5).map((task) => (
              <li key={task.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 break-words">{task.title}</span>
                <span
                  className={
                    task.dueDate !== null && task.dueDate < today()
                      ? 'font-medium text-error'
                      : 'text-secondary'
                  }
                >
                  {task.dueDate ? formatDate(task.dueDate) : 'No due date'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {object === 'contact' ? (
        <Card title="Latest email" action={<Badge tone="neutral">{threads.length}</Badge>}>
          {threads.length === 0 ? (
            <p className="text-secondary">
              No mail with this contact yet, or none from a mailbox you can read.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {threads.slice(0, 3).map((thread) => (
                <li key={thread.threadId} className="min-w-0">
                  <Link href={threadPath(workspace, thread.threadId)} className="break-words font-medium">
                    {thread.subject?.trim() || 'No subject'}
                  </Link>
                  <p className="text-small text-secondary">
                    {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}
                    {thread.lastAt ? ` · last ${formatDate(thread.lastAt)}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {object !== 'deal' ? (
        <Card title="Deals" action={<Badge tone="neutral">{deals.length}</Badge>}>
          {deals.length === 0 ? (
            <p className="text-secondary">No deals linked to this record.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {deals.slice(0, 5).map((deal) => (
                <li key={deal.id} className="min-w-0">
                  <Link
                    href={recordPath(workspace, 'deal', deal.id)}
                    title={deal.displayName}
                    className="line-clamp-2 break-words"
                  >
                    {deal.displayName}
                  </Link>
                  {deal.detail ? (
                    <span className="ml-2 text-small text-secondary">{deal.detail}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      <Card title="Where they came from">
        {firstTouch === null && lastTouch === null ? (
          <EmptyState
            title="No source recorded"
            description="This record was created by hand or by an import, so nothing was captured about how it arrived."
          />
        ) : (
          <dl className="grid gap-3 @md:grid-cols-2">
            <div>
              <dt className="text-small text-secondary">First touch</dt>
              <dd>
                {firstTouch ? (
                  <>
                    <Badge tone="info">{firstTouch.channel}</Badge>
                    {firstTouch.at ? (
                      <span className="ml-2 text-secondary">{formatDate(firstTouch.at)}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-secondary">Not recorded</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-small text-secondary">Last touch</dt>
              <dd>
                {lastTouch ? (
                  <>
                    <Badge tone="info">{lastTouch.channel}</Badge>
                    {lastTouch.at ? (
                      <span className="ml-2 text-secondary">{formatDate(lastTouch.at)}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-secondary">Same as first touch</span>
                )}
              </dd>
            </div>
          </dl>
        )}
      </Card>
    </div>
  )
}

/** Local midnight as a plain date, which is what a due date is compared against
 *  everywhere else on the record page. */
const today = (): string => {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}
