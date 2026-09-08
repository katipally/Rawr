import { listIntegrationsForOrg } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { INTEGRATIONS } from '~/server/integrations/index.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { AppsTabs } from '../tabs.tsx'
import { AvailableGrid } from './available-grid.tsx'

/** What this organisation could connect and has not.
 *
 *  Not a marketplace: it is the fixed set of providers Rawr has a client for, so
 *  there is nothing to install from a third party. The split exists because "what
 *  is connected" and "what could be" are two questions, and one list answering
 *  both is how an unconfigured row reads as broken. */
const AvailableAppsPage = async () => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const rows = await listIntegrationsForOrg(contextFrom(session))
  const stateOf = new Map(rows.map((row) => [row.kind, row.state]))
  const available = INTEGRATIONS.filter((meta) => stateOf.get(meta.kind) === 'not_configured')
  const connectedCount = rows.length - available.length

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Available apps"
        lead={`${available.length} not connected yet`}
        why={
          <p>
            Everything Rawr has a client for. A shared app is connected once by a super admin and
            used by every account here; a personal one is granted by each person for themselves.
          </p>
        }
      />

      <AppsTabs current="available" connectedCount={connectedCount} />

      {available.length === 0 ? (
        <EmptyState title="Everything is connected" description="There is nothing left for this organisation to connect." />
      ) : (
        <AvailableGrid
          apps={available.map((meta) => ({
            kind: meta.kind,
            name: meta.name,
            category: meta.category,
            appType: meta.appType,
            purpose: meta.purpose,
          }))}
        />
      )}
    </div>
  )
}

export default AvailableAppsPage
