import { listEventDefs } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { contextFrom, readSession, sessionCanEdit } from '~/server/session.ts'
import { TrackingTabs } from '../tabs.tsx'
import { EventDefList } from './event-list.tsx'

/** Item 13. The vocabulary the sites are firing.
 *
 *  Nothing here decides what is collected. The collector stores whatever arrives
 *  under whatever name it arrives with, and this is where somebody puts a label
 *  and a property schema on the ones that matter, so a funnel can be built out of
 *  names a reader recognises. */
const TrackingEventsPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (!sessionCanEdit(session, 'marketing')) {
    return (
      <EmptyState
        title="Only marketing describes events"
        description={`Ask somebody with marketing access in ${session.accountName}. Anybody can read the events report; naming what an event means is a marketing change.`}
      />
    )
  }

  const first = await listEventDefs(contextFrom(session), {})

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Events"
        lead="What the tracked sites fire, and what each name means."
        why={
          <p>
            A name shows up here the first time the collector sees it, so a release that starts
            firing something new is visible without anybody registering it first. Describing one is
            what makes it usable: a label a reader recognises, and the properties the site promises
            to send.
          </p>
        }
      />

      <TrackingTabs />

      <EventDefList
        initial={{
          rows: first.rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
          total: first.total,
        }}
      />
    </div>
  )
}

export default TrackingEventsPage
