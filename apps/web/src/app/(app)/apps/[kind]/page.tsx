import { INTEGRATION_KINDS, listIntegrationsForAccount, listSites, PERSONAL_KINDS, type IntegrationKind } from '@rawr/db'
import { Alert, Badge, Breadcrumb, Card, Tabs } from '@rawr/ui'
import Link from 'next/link'
import { LinkButton } from '~/components/link-button.tsx'
import { notFound, redirect } from 'next/navigation'
import { AppLogo } from '~/components/app-logo.tsx'
import { formatDateTime } from '~/components/crm/value.tsx'
import { publicBaseUrl } from '~/lib/env.ts'
import { appPath, appsPath, availableAppsPath, failedJobsPath, importsPath, type AppTab } from '~/lib/links.ts'
import { listEmailAccounts, listSequences } from '~/server/integrations/apollo.ts'
import { clayDegraded } from '~/server/integrations/clay.ts'
import { connectPathFor, integrationTraffic, metaFor } from '~/server/integrations/index.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { AppActions } from '../app-actions.tsx'
import { HEALTH } from '../health.ts'
import { ConnectForm } from './connect-form.tsx'

const TABS: AppTab[] = ['overview', 'settings', 'insights']

/** The six files a portal exports, in the order the importer offers them. Named
 *  here rather than left to "pick the HubSpot importer", because the question
 *  somebody has in front of the export screen is which files are worth taking. */
const HUBSPOT_EXPORTS = [
  'Contacts, companies, deals and any custom object, as records.',
  'Notes, calls, emails and meetings, onto the timeline of the record they name.',
  'A property export, which creates the fields those records need.',
  'An association export, which puts the people on the deals.',
  'A list export, which becomes a static segment holding the same people.',
  'A form submission export, which lands against the form it was sent to.',
]

/** One app, framed the way HubSpot frames an installed one: who installed it and
 *  what it may reach on Overview, how it is connected on Settings, and what it
 *  has been doing on Insights.
 *
 *  The permissions list is the part worth having. Every other screen says an
 *  integration is connected; none of them says what "connected" lets it touch,
 *  and that is the question somebody asks before they disconnect it. */
const AppPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>
  searchParams: Promise<{ tab?: string }>
}) => {
  const { kind } = await params
  if (!INTEGRATION_KINDS.includes(kind as IntegrationKind)) notFound()
  const { tab: wanted } = await searchParams
  const tab: AppTab = TABS.find((entry) => entry === wanted) ?? 'overview'

  const session = await readSession()
  if (!session) redirect('/sign-in')

  const zone = session.timezone

  const ctx = contextFrom(session)
  const [rows, sites] = await Promise.all([listIntegrationsForAccount(ctx), listSites(ctx)])
  const row = rows.find((entry) => entry.kind === kind)
  if (!row) notFound()

  const meta = metaFor(row.kind)
  const personal = PERSONAL_KINDS.has(row.kind)
  const connected = row.state !== 'not_configured'
  // Apollo is the one provider whose key can be valid and still be pointed at the
  // wrong workspace: the connection test proves Apollo answered, not that it
  // answered for the mailboxes the sync is meant to read back. Asking it who it
  // sends as turns that into something an admin can check by looking.
  const sendingAs =
    row.kind === 'apollo' && connected ? await listEmailAccounts(ctx).catch(() => null) : null
  // The other half of the same question: a key pointed at the wrong workspace
  // answers with somebody else's sequences, which is visible here and nowhere
  // else, because Rawr never enrolls into one itself.
  const apolloSequences =
    row.kind === 'apollo' && connected ? await listSequences(ctx).catch(() => null) : null
  // Read only for the tab that shows it: two grouped counts is cheap, but not on
  // every visit to Overview.
  const traffic = tab === 'insights' ? await integrationTraffic(ctx, row.kind, row.id) : null
  // Said on every tab of the card, not only when somebody presses Test: on Launch
  // the connection is real and every enrichment through it still refuses.
  const clayLimit = row.kind === 'clay' ? clayDegraded(row.config as { tier?: 'launch' | 'growth' }) : null
  const connectPath = connectPathFor(row.kind, session.accountSlug)
  // The webhook URL names the account through a tracked site's key; the first
  // active one is the account's public identity for that purpose.
  const siteKey = sites.find((site) => site.isActive)?.siteKey ?? sites[0]?.siteKey ?? null

  const detail = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-small text-secondary">{label}</dt>
      <dd>{value}</dd>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      {/* The parent is where this app is actually listed. A Brevo nobody has
          connected is on Available apps, and saying "Connected apps" above it
          both misnames the tab and claims a state it does not have. */}
      <Breadcrumb
        items={[
          connected
            ? { label: 'Connected apps', href: appsPath() }
            : { label: 'Available apps', href: availableAppsPath() },
          { label: meta.name },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-hs border border-line bg-surface">
          <AppLogo kind={row.kind} className="size-8" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="break-words text-xl font-semibold">{meta.name}</h1>
          <p className="text-secondary">{meta.purpose}</p>
        </div>
        <Badge tone={HEALTH[row.state].tone} dot>
          {HEALTH[row.state].label}
        </Badge>
        {connected ? (
          <AppActions
            kind={row.kind}
            name={meta.name}
            personal={personal}
            connectPath={connectPath}
            canManage={session.isSuperAdmin}
          />
        ) : (
          <LinkButton href={connectPath}>
            {/* Gmail and Calendar are consented to per person, from the page that
                first says what Rawr will read. Naming the step beats a button that
                looks like consent and lands somewhere else. */}
            {personal ? 'Set up yours' : 'Connect'}
          </LinkButton>
        )}
      </div>

      <Tabs
        label={`${meta.name} sections`}
        items={TABS.map((entry) => ({
          key: entry,
          label: entry[0]?.toUpperCase() + entry.slice(1),
          href: appPath(row.kind, entry),
          current: entry === tab,
        }))}
      />

      {row.lastError ? (
        <Alert tone="warning">
          {meta.name} last reported: {row.lastError}
          {row.lastErrorAt ? ` (${formatDateTime(row.lastErrorAt.toISOString(), zone)})` : ''}
        </Alert>
      ) : null}

      {clayLimit ? <Alert tone="warning">{clayLimit}</Alert> : null}

      {tab === 'overview' ? (
        <div className="grid gap-4 @3xl:grid-cols-[20rem_1fr]">
          <Card title="App info">
            <dl className="flex flex-col gap-3">
              {personal
                ? detail(
                    'Connected by',
                    row.people === 0 ? 'Nobody yet' : row.people === 1 ? '1 person' : `${row.people.toLocaleString()} people`,
                  )
                : detail('Installed by', row.installedByName ?? (connected ? 'Not by a person' : '—'))}
              {detail('Installed date', row.installedAt ? formatDateTime(row.installedAt.toISOString(), zone) : '—')}
              {detail(
                'App type',
                <>
                  <Badge tone="neutral">{meta.appType}</Badge>
                  <p className="pt-1 text-small text-secondary">
                    {meta.appType === 'Shared'
                      ? 'One connection the whole account uses.'
                      : 'Granted per person, from their own account.'}
                  </p>
                </>,
              )}
              {detail('Category', meta.category)}
              {meta.rows.length > 0
                ? detail(
                    'Used for',
                    <span className="flex flex-wrap gap-1 pt-1">
                      {meta.rows.map((name) => (
                        <Badge key={name}>{name}</Badge>
                      ))}
                    </span>,
                  )
                : null}
            </dl>
          </Card>

          <Card title="App access and permissions">
            <div className="flex flex-col gap-4">
              <p className="text-secondary">
                What {meta.name} may reach through Rawr. Fixed by what the integration does, so it is
                the same for every account and there is nothing to grant or revoke per app beyond
                connecting it.
              </p>
              {meta.permissions.map((group) => (
                <details key={group.group} open className="border-t border-divider pt-3 first:border-t-0 first:pt-0">
                  <summary className="cursor-pointer font-medium">{group.group}</summary>
                  <ul className="flex flex-col gap-1 pt-2 pl-4 text-secondary">
                    {group.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'settings' ? (
        <Card title={personal ? 'How it is connected' : 'Connection'}>
          {personal ? (
            <div className="flex flex-col gap-3">
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-secondary">
                {meta.setup.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <div>
                <LinkButton href={connectPath}>
                  {row.kind === 'gmail' ? 'Open Mailboxes' : 'Open Calendar connections'}
                </LinkButton>
              </div>
            </div>
          ) : row.kind === 'hubspot' ? (
            <div className="flex flex-col gap-3">
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-secondary">
                {meta.setup.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <div>
                <p className="text-small text-secondary">Exports the importer reads:</p>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-secondary">
                  {HUBSPOT_EXPORTS.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div>
                <LinkButton href={importsPath(session.accountSlug)}>
                  Open Import
                </LinkButton>
              </div>
            </div>
          ) : (
            <ConnectForm
              kind={row.kind}
              name={meta.name}
              hasSecret={row.hasSecret}
              secretLabel={meta.secretLabel}
              configFields={meta.configFields}
              setup={meta.setup}
              config={row.config}
              webhookBase={publicBaseUrl}
              siteKey={siteKey}
              canWrite={session.isSuperAdmin}
            />
          )}
        </Card>
      ) : null}

      {tab === 'insights' ? (
        <div className="grid gap-4 @3xl:grid-cols-2">
          <Card title="Health">
            <dl className="flex flex-col gap-3">
              {detail('Status', <Badge tone={HEALTH[row.state].tone} dot>{HEALTH[row.state].label}</Badge>)}
              {detail('Last succeeded', row.lastOkAt ? formatDateTime(row.lastOkAt.toISOString(), zone) : 'Never yet')}
              {detail(
                'Last failure',
                row.lastErrorAt ? `${formatDateTime(row.lastErrorAt.toISOString(), zone)} · ${row.lastError ?? ''}` : 'None recorded',
              )}
              {detail(
                'Failed jobs',
                row.deadLetters === 0 ? (
                  'None waiting'
                ) : (
                  <>
                    {row.deadLetters.toLocaleString()} can be replayed.{' '}
                    <Link href={failedJobsPath()} className="font-medium text-link">
                      Open failed jobs
                    </Link>
                  </>
                ),
              )}
            </dl>
          </Card>
          <Card title="When it is down">
            <p className="text-secondary">{meta.failureMode}</p>
          </Card>
          {traffic ? (
            <Card title="Calls out" action={<Badge>Last 30 days</Badge>}>
              {traffic.outbound.length === 0 ? (
                <p className="text-secondary">
                  Rawr has not called {meta.name} in the last thirty days.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {traffic.outbound.map((op) => (
                    <li key={op.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="min-w-0 break-words">{op.label}</span>
                      <span className="text-small text-secondary tabular-nums">
                        {op.calls.toLocaleString()}
                        {op.lastAt ? ` · ${formatDateTime(op.lastAt.toISOString(), zone)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
          {traffic ? (
            <Card title="Deliveries in" action={<Badge>Last 30 days</Badge>}>
              {traffic.inbound.length === 0 ? (
                <p className="text-secondary">
                  {meta.name} has sent Rawr nothing in the last thirty days.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {traffic.inbound.map((event) => (
                    <li key={event.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="min-w-0 break-words">{event.label}</span>
                      <span className="text-small text-secondary tabular-nums">
                        {event.calls.toLocaleString()}
                        {event.lastAt ? ` · ${formatDateTime(event.lastAt.toISOString(), zone)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {traffic.unmatched > 0 ? (
                <p className="pt-2 text-small text-secondary">
                  {traffic.unmatched.toLocaleString()} matched nobody here and are kept rather than dropped.
                </p>
              ) : null}
            </Card>
          ) : null}
          {traffic && traffic.enriched > 0 ? (
            <Card title="Fields it filled">
              <p className="text-secondary">
                {traffic.enriched.toLocaleString()} value
                {traffic.enriched === 1 ? '' : 's'} on records here came from {meta.name} and no human has
                overwritten them.
              </p>
            </Card>
          ) : null}
          {apolloSequences ? (
            <Card title="Sequences it can see">
              {apolloSequences.length === 0 ? (
                <p className="text-secondary">
                  This key reaches Apollo, but that workspace has no sequences, so the activity sync
                  reads nothing back.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {apolloSequences.map((sequence) => (
                    <li key={sequence.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{sequence.name}</span>
                      <Badge tone={sequence.active ? 'ok' : 'neutral'} dot>
                        {sequence.active ? 'Active' : 'Paused'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
          {sendingAs ? (
            <Card title="Sends as">
              {sendingAs.length === 0 ? (
                <p className="text-secondary">
                  This key reaches Apollo, but no mailbox is connected there, so a sequence has
                  nothing to send from and the sync will read nothing back.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {sendingAs.map((mailbox) => (
                    <li key={mailbox.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{mailbox.email}</span>
                      <Badge tone={mailbox.active ? 'ok' : 'neutral'} dot>
                        {mailbox.active ? 'Active' : 'Paused'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default AppPage
