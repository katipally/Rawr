import { Alert, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { listSites, listUnmatchedEvents, listWebhookEndpoints, webhookEventsFor } from '@rawr/db'
import { devIntegrationsEnabled, publicBaseUrl } from '~/lib/env.ts'
import { appsPath } from '~/lib/links.ts'
import { readIntegrations } from '~/server/integrations/index.ts'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { IntegrationPanel } from './integration-panel.tsx'
import { WebhookPanel } from './webhook-panel.tsx'

/** F6 §1. Every integration, its health, and the provider's own error text.
 *
 *  An integration that fails silently is worse than one that is absent, so nothing
 *  here hides a state: an unconfigured provider is a row, a rejected credential is
 *  red with the reason, and a webhook that has stopped arriving turns amber on its
 *  own rather than looking fine forever. */
type Props = { searchParams: Promise<{ open?: string }> }

const IntegrationsPage = async ({ searchParams }: Props) => {
  const session = await readSession()
  if (!session) return null
  const { open } = await searchParams

  const ctx = contextFrom(session)
  const [rows, unmatched, sites, hooks, webhookEvents] = await Promise.all([
    readIntegrations(ctx),
    listUnmatchedEvents(ctx, 25),
    listSites(ctx),
    // Only an admin may read them, and only an admin can open this page.
    sessionIsAdmin(session) ? listWebhookEndpoints(ctx) : Promise.resolve([]),
    sessionIsAdmin(session) ? webhookEventsFor(ctx) : Promise.resolve([]),
  ])
  // The webhook URL names the account through a tracked site's key; the first
  // active one is the account's public identity for that purpose.
  const siteKey = sites.find((site) => site.isActive)?.siteKey ?? sites[0]?.siteKey ?? null

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Integrations"
        lead="Everything Rawr talks to that is not Rawr."
        why={
          <p>
            Credentials are encrypted with a key held outside this database and are never shown
            again after saving. Every provider has a connection test that calls it for real and
            reports what it said.
          </p>
        }
      />

      <Alert>
        A credential belongs to the organisation and every account in it uses the same one, so
        connecting or disconnecting is an organisation admin&apos;s decision.{' '}
        <Link href={appsPath()} className="font-medium text-link">
          Connected apps
        </Link>{' '}
        lists what is connected, who connected it and what each one may reach.
        {session.isSuperAdmin
          ? ''
          : ` You are not a super admin, so the forms below are read-only.`}
      </Alert>

      {devIntegrationsEnabled ? (
        <Alert tone="warning">
          Development providers are on. Connection tests pass without a key, enrichment returns a
          fixed match, and nothing is sent to Brevo, Apollo, Clay, Slack or Google. Turn
          RAWR_DEV_INTEGRATIONS off to talk to the real services.
        </Alert>
      ) : null}

      <IntegrationPanel
        rows={rows.map((row) => ({
          ...row,
          lastOkAt: row.lastOkAt?.toISOString() ?? null,
          lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
        }))}
        unmatched={unmatched.map((row) => ({ ...row, at: row.at.toISOString() }))}
        webhookBase={publicBaseUrl}
        siteKey={siteKey}
        canWrite={session.isSuperAdmin}
        hub="account"
        openKind={rows.find((row) => row.kind === open)?.kind ?? null}
      />

      <WebhookPanel
        rows={hooks.map((row) => ({
          id: row.id,
          name: row.name,
          url: row.url,
          events: row.events,
          isActive: row.isActive,
          lastOkAt: row.lastOkAt?.toISOString() ?? null,
          lastStatus: row.lastStatus,
          lastError: row.lastError,
          lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
        }))}
        events={webhookEvents}
        canWrite={sessionIsAdmin(session)}
      />
    </div>
  )
}

export default IntegrationsPage
