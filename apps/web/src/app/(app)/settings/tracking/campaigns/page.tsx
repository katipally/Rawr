import { listCampaigns } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { contextFrom, readSession, sessionCanEdit } from '~/server/session.ts'
import { TrackingTabs } from '../tabs.tsx'
import { CampaignList } from './campaign-list.tsx'

/** Item 14. The campaigns spend is keyed against.
 *
 *  A channel is derivable from what arrived and costs nothing to keep. Money is
 *  not in any query string and never will be, so this is the one screen where a
 *  number has to be typed in by a person for the attribution report to be able to
 *  answer "what did a contact from this campaign cost". */
const TrackingCampaignsPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (!sessionCanEdit(session, 'marketing')) {
    return (
      <EmptyState
        title="Only marketing edits campaign spend"
        description={`Ask somebody with marketing access in ${session.accountName}. The attribution report is open to everybody; the money behind it is not.`}
      />
    )
  }

  const first = await listCampaigns(contextFrom(session), {})

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Campaigns"
        lead="One row per campaign, keyed by the utm_campaign value its links carry."
        why={
          <p>
            Every campaign the tracker has already seen is here with no spend against it. Type the
            spend in and the attribution report can divide it by the contacts and deals that
            campaign brought, which is the only number an ad budget can be argued from.
          </p>
        }
      />

      <TrackingTabs />

      <CampaignList
        initial={{
          rows: first.rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
          total: first.total,
        }}
      />
    </div>
  )
}

export default TrackingCampaignsPage
