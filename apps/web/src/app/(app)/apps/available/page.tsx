import { listIntegrationsForOrg } from '@rawr/db'
import { Badge, EmptyState, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { INTEGRATION_ICONS } from '~/components/icons.ts'
import { integrationsPath } from '~/lib/links.ts'
import { metaFor } from '~/server/integrations/index.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { AppsTabs } from '../tabs.tsx'

/** What this organisation could connect and has not.
 *
 *  Not a marketplace: it is the fixed set of providers Rawr has a client for, so
 *  there is nothing to browse, search or install from a third party. The split
 *  exists because "what is connected" and "what could be" are two questions, and
 *  one list answering both is how an unconfigured row reads as broken. */
const AvailableAppsPage = async () => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const rows = await listIntegrationsForOrg(contextFrom(session))
  const connectedCount = rows.filter((row) => row.state !== 'not_configured').length
  const available = rows.filter((row) => row.state === 'not_configured')
  const canConnect = session.isSuperAdmin

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Available apps"
        lead={`${available.length} not connected yet`}
        why={
          <p>
            Everything Rawr has a client for. Connecting one is an organisation decision, so only an
            organisation admin can do it, and the credential is then shared by every account here.
          </p>
        }
      />

      <AppsTabs current="available" connectedCount={connectedCount} />

      {available.length === 0 ? (
        <EmptyState
          title="Everything is connected"
          description="There is nothing left for this organisation to connect."
        />
      ) : (
        <ul className="grid gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {available.map((row) => {
            const meta = metaFor(row.kind)
            const Icon = INTEGRATION_ICONS[row.kind]
            return (
              <li
                key={row.kind}
                className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-4 shadow-panel"
              >
                <div className="flex items-center gap-2">
                  <Icon aria-hidden="true" className="size-5 shrink-0" />
                  <h2 className="min-w-0 flex-1 truncate font-semibold">{meta.name}</h2>
                  <Badge tone="neutral">{meta.category}</Badge>
                </div>
                <p className="flex-1 text-secondary">{meta.purpose}</p>
                {canConnect ? (
                  <Link href={integrationsPath(row.kind)} className="font-medium text-link no-underline hover:underline">
                    Connect
                  </Link>
                ) : (
                  <p className="text-secondary">
                    A super admin connects this. You are not one.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default AvailableAppsPage
