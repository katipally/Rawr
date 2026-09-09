import { Badge, Card, EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { threadPath } from '~/lib/links.ts'
import { formatDate } from './value.tsx'

export type OverviewThread = {
  threadId: string
  subject: string | null
  /** Null for a thread whose messages carry no date, which a badly formed import
   *  can produce. */
  lastAt: string | null
  messageCount: number
}

export type Touch = { channel: string; at: string | null } | null

export type RecordOverviewProps = {
  account: string
  /** An object key, core or invented. */
  object: string
  threads: OverviewThread[]
  firstTouch: Touch
  lastTouch: Touch
}

/** The answer to "what is going on with this record" without reading a timeline:
 *  what was last said and where they came from. What is owed and what money is
 *  open live in the rail beside it, which shows the same rows with more on them,
 *  so this tab no longer repeats them. */
export const RecordOverview = ({
  account,
  object,
  threads,
  firstTouch,
  lastTouch,
}: RecordOverviewProps) => {
  return (
    <div className="flex flex-col gap-3">
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
                  <Link href={threadPath(account, thread.threadId)} className="break-words font-medium">
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
