import { Alert, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { listUnmatchedEvents, listWebhookEndpoints, webhookEventsFor } from '@rawr/db'
import { appsPath } from '~/lib/links.ts'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { UnmatchedPanel } from './unmatched-panel.tsx'
import { WebhookPanel } from './webhook-panel.tsx'

/** The two halves of F6 §1 that are not a provider: what Rawr sends out to
 *  endpoints an admin registers, and what came in that nobody could be matched
 *  to. Connecting a provider is its own app page under Connected apps. */
const IntegrationsPage = async () => {
  const session = await readSession()
  if (!session) return null

  const ctx = contextFrom(session)
  const [unmatched, hooks, webhookEvents] = await Promise.all([
    listUnmatchedEvents(ctx, 25),
    // Only an admin may read them, and only an admin can open this page.
    sessionIsAdmin(session) ? listWebhookEndpoints(ctx) : Promise.resolve([]),
    sessionIsAdmin(session) ? webhookEventsFor(ctx) : Promise.resolve([]),
  ])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Integrations"
        lead="Webhooks Rawr sends, and inbound events with nobody to attach them to."
        why={
          <p>
            Every provider Rawr talks to is connected from its own page under Connected apps, with
            the credential, the connection test and the webhook URL to paste at the provider. This
            page holds what is left: the endpoints Rawr posts to, and events that arrived for an
            address no contact holds.
          </p>
        }
      />

      <Alert tone="info">
        Connecting Slack, Brevo, Apollo and the rest happens under{' '}
        <Link href={appsPath()} className="font-medium text-link">
          Connected apps
        </Link>
        , where you can also see who connected each one and what it may reach.
      </Alert>

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

      <UnmatchedPanel rows={unmatched.map((row) => ({ ...row, at: row.at.toISOString() }))} />
    </div>
  )
}

export default IntegrationsPage
