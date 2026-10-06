import type { AssociationGroup } from '@rawr/db'
import { Badge, Card, EmptyState } from '@rawr/ui'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { recordPath, threadPath } from '~/lib/links.ts'
import { getFormat } from '~/server/format.ts'
import { EMPTY_VALUE, activityActor, activityLabel } from './value.tsx'

export type OverviewThread = {
  threadId: string
  subject: string | null
  /** Null for a thread whose messages carry no date, which a badly formed import
   *  can produce. */
  lastAt: string | null
  messageCount: number
}

export type Touch = { channel: string; at: string | null } | null

export type RecentActivity = {
  id: string
  type: string
  subject: string | null
  body: string | null
  occurredAt: string
  actorName: string | null
  actorKind: string
  payload?: unknown
}

/** The line under each name in an association table, by the object it lists. */
const DETAIL_HEADING: Record<string, string> = { contact: 'Job title', company: 'Domain', deal: 'Next step' }

/** HubSpot's association tables are short; the rail beside them holds the rest. */
const TABLE_ROWS = 5

export type RecordOverviewProps = {
  account: string
  /** An object key, core or invented. */
  object: string
  threads: OverviewThread[]
  firstTouch: Touch
  lastTouch: Touch
  recordId: string
  recordName: string
  /** Create date, the stage the record is in, and when something last happened. */
  highlights: { label: string; value: ReactNode }[]
  /** Newest first, a handful. */
  recent: RecentActivity[]
  addActivities: ReactNode
  associations: AssociationGroup[]
}

/** The answer to "what is going on with this record" without reading a timeline:
 *  what was last said and where they came from. What is owed and what money is
 *  open live in the rail beside it, which shows the same rows with more on them,
 *  so this tab no longer repeats them. */
export const RecordOverview = async ({
  account,
  object,
  threads,
  firstTouch,
  lastTouch,
  recordId,
  recordName,
  highlights,
  recent,
  addActivities,
  associations,
}: RecordOverviewProps) => {
  const fmt = await getFormat()
  return (
    <div className="flex flex-col gap-3">
      <Card title="Data highlights">
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8.75rem),1fr))] gap-3">
          {highlights.map((item) => (
            <div key={item.label} className="min-w-0">
              <dt className="text-small font-semibold tracking-wide uppercase">{item.label}</dt>
              <dd className="mt-1 min-w-0 break-words">{item.value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="Recent activities" action={addActivities}>
        {recent.length === 0 ? (
          <p className="text-secondary">Nothing has happened here yet.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {recent.map((entry) => {
              const who = activityActor(entry.type, { ...entry, recordName })
              return (
                <li key={entry.id} className="rounded-panel border border-line bg-surface p-4">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold">{activityLabel(entry)}</span>
                    <span className="min-w-0 flex-1 break-words">
                      {who ? `${who} ` : ''}
                      {entry.subject ?? ''}
                    </span>
                    <time dateTime={entry.occurredAt} className="shrink-0 text-small text-secondary">
                      {fmt.dateTime(entry.occurredAt)}
                    </time>
                  </p>
                  {entry.body ? <p className="mt-1 line-clamp-2 break-words whitespace-pre-wrap">{entry.body}</p> : null}
                </li>
              )
            })}
          </ol>
        )}
        <Link href={recordPath(account, object, recordId, { tab: 'activities' })} className="mt-3 inline-block">
          View all activities
        </Link>
      </Card>

      {associations
        .filter((group) => group.total > 0)
        .map((group) => (
          <Card key={group.objectKey} title={`${group.namePlural} (${fmt.number(group.total)})`} flush>
            <div className="overflow-x-auto px-6 pb-6">
              <table className="w-full min-w-[24rem] table-fixed border-collapse">
                <thead>
                  <tr className="text-left text-secondary">
                    <th className="h-row border-b border-line pr-4 font-normal">Name</th>
                    {DETAIL_HEADING[group.objectKey] ? (
                      <th className="h-row border-b border-line pr-4 font-normal">{DETAIL_HEADING[group.objectKey]}</th>
                    ) : null}
                    <th className="h-row border-b border-line font-normal">Create date</th>
                  </tr>
                </thead>
                <tbody>
                  {group.records.slice(0, TABLE_ROWS).map((row) => (
                    <tr key={row.id} className="transition-colors duration-150 ease-out hover:bg-fill-hover">
                      <td className="h-row truncate border-b border-line pr-4">
                        <Link href={recordPath(account, row.objectKey, row.id)} title={row.displayName}>
                          {row.displayName}
                        </Link>
                      </td>
                      {DETAIL_HEADING[group.objectKey] ? (
                        <td className="h-row truncate border-b border-line pr-4" title={row.detail ?? undefined}>
                          {row.detail || EMPTY_VALUE}
                        </td>
                      ) : null}
                      <td className="h-row truncate border-b border-line">
                        {row.createdAt ? fmt.date(row.createdAt) : EMPTY_VALUE}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {group.total > TABLE_ROWS ? (
                <p className="mt-2 text-small text-secondary">
                  {fmt.number(Math.min(TABLE_ROWS, group.records.length))} of {fmt.number(group.total)} shown. The rest are in the{' '}
                  {group.namePlural.toLowerCase()} card beside this one.
                </p>
              ) : null}
            </div>
          </Card>
        ))}
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
                    {thread.lastAt ? ` · last ${fmt.date(thread.lastAt)}` : ''}
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
                      <span className="ml-2 text-secondary">{fmt.date(firstTouch.at)}</span>
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
                      <span className="ml-2 text-secondary">{fmt.date(lastTouch.at)}</span>
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
