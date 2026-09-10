import { readTrackingConsentRequired, readTrackingDomain } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { TrackingPanel } from './tracking-panel.tsx'
import { TrackingTabs } from './tabs.tsx'

/** Where the pixel, the click redirect and the unsubscribe link live. */
const TrackingPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (!sessionIsAdmin(session)) {
    return (
      <EmptyState
        title="Only an admin sets the tracking domain"
        description={`You need account access, which you do not have. can send sequences but not change where their links point.`}
      />
    )
  }

  const ctx = contextFrom(session)
  const [domain, consentRequired] = await Promise.all([
    readTrackingDomain(ctx),
    readTrackingConsentRequired(ctx),
  ])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Tracking domain"
        lead="Where the links in sequence mail are served from."
        why={
          <p>
            Sequence mail carries three: a one-pixel image that counts opens, a redirect that counts
            clicks, and an unsubscribe link. A mail written by hand to a contact carries the first
            two, and only when that contact may be measured.
          </p>
        }
      />

      <TrackingTabs />

      <TrackingPanel domain={domain} consentRequired={consentRequired} />
    </div>
  )
}

export default TrackingPage
