import { readTrackingDomain } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import { contextFrom, readSession } from '~/server/session.ts'
import { TrackingPanel } from './tracking-panel.tsx'

/** Where the pixel, the click redirect and the unsubscribe link live. */
const TrackingPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (session.role !== 'admin') {
    return (
      <EmptyState
        title="Only an admin sets the tracking domain"
        description={`Your role (${session.role}) can send sequences but not change where their links point.`}
      />
    )
  }

  const domain = await readTrackingDomain(contextFrom(session))

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-2xl">
        <h2 className="text-base font-medium">Tracking domain</h2>
        <p className="text-secondary">
          Sequence mail carries three links: a one-pixel image that counts opens, a redirect that
          counts clicks, and an unsubscribe link. They are served from here.
        </p>
      </div>

      <TrackingPanel domain={domain} />
    </div>
  )
}

export default TrackingPage
