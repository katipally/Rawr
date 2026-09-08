import { INTEGRATION_KINDS, listIntegrationsForOrg, listSites, PERSONAL_KINDS, type IntegrationKind } from '@rawr/db'
import { Alert, Badge, Breadcrumb, Card, Tabs } from '@rawr/ui'
import Link from 'next/link'
import { LinkButton } from '~/components/link-button.tsx'
import { notFound, redirect } from 'next/navigation'
import { AppLogo } from '~/components/app-logo.tsx'
import { formatDateTime } from '~/components/crm/value.tsx'
import { publicBaseUrl } from '~/lib/env.ts'
import { appPath, appsPath, availableAppsPath, failedJobsPath, importsPath, type AppTab } from '~/lib/links.ts'
import { listEmailAccounts } from '~/server/integrations/apollo.ts'
import { connectPathFor, metaFor } from '~/server/integrations/index.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { AppActions } from '../app-actions.tsx'
import { HEALTH } from '../health.ts'
import { ConnectForm } from './connect-form.tsx'

const TABS: AppTab[] = ['overview', 'settings', 'insights']

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

  const ctx = contextFrom(session)
  const [rows, sites] = await Promise.all([listIntegrationsForOrg(ctx), listSites(ctx)])
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
            {personal ? 'Connect yours' : 'Connect'}
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
          {row.lastErrorAt ? ` (${formatDateTime(row.lastErrorAt.toISOString())})` : ''}
        </Alert>
      ) : null}

      {tab === 'overview' ? (
        <div className="grid gap-4 @3xl:grid-cols-[20rem_1fr]">
          <Card title="App info">
            <dl className="flex flex-col gap-3">
              {personal
                ? detail(
                    'Connected by',
                    row.people === 0 ? 'Nobody yet' : row.people === 1 ? '1 person' : `${row.people.toLocaleString()} people`,
                  )
                : detail('Installed by', row.installedByName ?? (connected ? 'Not by a person' : '--'))}
              {detail('Installed date', row.installedAt ? formatDateTime(row.installedAt.toISOString()) : '--')}
              {detail(
                'App type',
                <>
                  <Badge tone="neutral">{meta.appType}</Badge>
                  <p className="pt-1 text-small text-secondary">
                    {meta.appType === 'Shared'
                      ? 'One connection the whole organisation uses.'
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
                the same for every organisation and there is nothing to grant or revoke per app beyond
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
              {detail('Last succeeded', row.lastOkAt ? formatDateTime(row.lastOkAt.toISOString()) : 'Never yet')}
              {detail(
                'Last failure',
                row.lastErrorAt ? `${formatDateTime(row.lastErrorAt.toISOString())} · ${row.lastError ?? ''}` : 'None recorded',
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
