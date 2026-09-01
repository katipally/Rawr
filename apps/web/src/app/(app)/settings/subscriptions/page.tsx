import { listSubscriptionTypes } from '@rawr/db'
import { contextFrom, readSession } from '~/server/session.ts'
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
      <div className="max-w-2xl">
        <h2 className="text-base font-medium">Subscription types</h2>
        <p className="text-secondary">
          What somebody can opt in or out of. Every contact holds one of three states per type,
          and the third — never specified — is the default and a real answer, not a blank. Nobody
          who has opted out is ever included in a list pushed to a sending tool.
        </p>
      </div>

      <SubscriptionTypes
        rows={types}
        canWrite={session.role === 'admin' || session.role === 'marketing'}
        role={session.role}
      />
    </div>
  )
}

export default SubscriptionsPage
