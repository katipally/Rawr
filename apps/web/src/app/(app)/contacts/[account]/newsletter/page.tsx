import { canWrite, listSegments, recentActivity } from '@rawr/db'
import { Badge, Card, EmptyState, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatDateTime } from '~/components/crm/value.tsx'
import { CampaignPanel } from './campaign-panel.tsx'
import { NewsletterPanel } from './newsletter-panel.tsx'
import { integrationsPath, recordPath } from '~/lib/links.ts'
import { readIntegrations } from '~/server/integrations/index.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** B5. The newsletter, which Rawr deliberately does not send.
 *
 *  Brevo owns the editor and the send; Rawr owns who is on the list and who asked
 *  to be left off. So this screen is the seam between the two: whether Brevo is
 *  answering, a way to push an audience at it, and what it has reported back. */

const TONE = { connected: 'ok', degraded: 'warn', disconnected: 'error', not_configured: 'neutral' } as const

const NewsletterPage = async ({ params }: { params: Promise<{ account: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const ctx = contextFrom(session)

  const [integrations, segments, events] = await Promise.all([
    readIntegrations(ctx),
    listSegments(ctx, 'contact'),
    recentActivity(ctx, 25, ['marketing_email']),
  ])

  const brevo = integrations.find((row) => row.kind === 'brevo')
  const listId = typeof brevo?.config.listId === 'string' ? brevo.config.listId : ''
  const allowed = canWrite(contextFrom(session), 'segment')

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="Newsletter"
        lead="Designed in Brevo, aimed and measured here."
        why={
          <p>
            Rawr holds the audience and the opt-out: a segment is pushed across as a list, and
            anybody who unsubscribes there is refused here from then on.
          </p>
        }
      />

      <Card
        title="Brevo"
        action={
          brevo ? (
            <Badge tone={TONE[brevo.state]} dot>
              {brevo.state === 'not_configured' ? 'Not configured' : brevo.state}
            </Badge>
          ) : null
        }
      >
        <div className="flex flex-col gap-1">
          <p className="text-secondary">
            {brevo?.lastOkAt
              ? `Last succeeded ${formatDateTime(brevo.lastOkAt)}.`
              : 'Brevo has never answered successfully yet.'}
            {listId ? ` Pushes go to list ${listId}.` : ' No list is configured, so a push has nowhere to land.'}
          </p>
          {brevo?.lastError ? (
            <p role="alert" className="break-words text-small text-error">
              {brevo.lastError}
            </p>
          ) : null}
          <p className="text-small">
            <Link href={integrationsPath('brevo')}>Open Brevo in settings</Link>
          </p>
        </div>
      </Card>

      <Card title="Push an audience across">
        <NewsletterPanel
          segments={segments.map((segment) => ({ id: segment.id, name: segment.name }))}
          defaultListId={listId}
          canWrite={allowed}
          hub="marketing"
        />
      </Card>

      <Card title="Campaigns">
        <CampaignPanel
          segments={segments.map((segment) => ({ id: segment.id, name: segment.name }))}
          defaultListId={listId}
          canWrite={allowed}
          hub="marketing"
        />
      </Card>

      <Card title="What Brevo has reported back" action={<Badge>{String(events.length)}</Badge>}>
        {events.length === 0 ? (
          <EmptyState
            title="Nothing from Brevo yet"
            description="Deliveries, bounces and unsubscribes appear here once Brevo's webhook is pointed at Rawr and a campaign has gone out."
          />
        ) : (
          <ul className="flex flex-col">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-divider py-1.5 last:border-0"
              >
                <span className="min-w-0">
                  {event.entityDeleted ? (
                    <span className="italic">{event.entityName}</span>
                  ) : (
                    <Link href={recordPath(account, event.entityType, event.entityId)}>{event.entityName}</Link>
                  )}{' '}
                  <span className="text-secondary">{event.subject}</span>
                </span>
                <span className="text-small text-secondary">{formatDateTime(event.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

export default NewsletterPage
