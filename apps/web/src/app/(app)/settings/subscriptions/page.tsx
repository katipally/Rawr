import { PageHeader } from '@rawr/ui'
import { listSubscriptionTypes } from '@rawr/db'
import { contextFrom, readSession, sessionCanEdit } from '~/server/session.ts'
import { SubscriptionTypes } from './subscription-types.tsx'

/** A2 and D15. The types themselves; the per-contact state lives on the record.
 *  F6 pushes an opt-out outward to Brevo and never the reverse for one that
 *  originated here, so this list is the authority for who may be mailed. */
const SubscriptionsPage = async () => {
  const session = await readSession()
  if (!session) return null

  const types = await listSubscriptionTypes(contextFrom(session))

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Subscription types"
        lead="What somebody can opt in or out of."
        why={
          <p>
            Every contact holds one of three states per type, and the third, never specified, is
            the default and a real answer rather than a blank. Nobody who has opted out is ever
            included in a list pushed to a sending tool.
          </p>
        }
      />

      <SubscriptionTypes
        rows={types}
        canWrite={sessionCanEdit(session, 'marketing')}
        hub="marketing"
      />
    </div>
  )
}

export default SubscriptionsPage
